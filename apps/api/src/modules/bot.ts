import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { decrypt, encrypt, keyedHash } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import type { AiContent, AiProvider } from '../lib/gemini.js';
import { TypebotSessionGone, type TbTurn, type TypebotProvider } from '../lib/typebot.js';
import { interactiveSummary, toWhatsAppNumber, type Interactive, type WhatsAppProvider } from '../lib/whatsapp.js';
import { requirePermission } from './auth.js';
import { aiTurn, clearAiCooldown, historyFor, SAFE_REPLY, securitySummary } from './bot-ai.js';

/**
 * Bot de atendimento (docs/10-bot-atendimento-proposta.md): etapa 1, menu com regras fixas; etapa 2, IA (Gemini)
 * no texto livre, com o menu como reserva; etapa 3, fluxo do Typebot do proprio servidor (docs/11).
 * Nao altera nada na loja: so consulta pedido (do proprio telefone), horario e endereco, e passa para atendente.
 */

type Q = Db | typeof pool;
export type BotReply = { kind: 'text'; body: string } | { kind: 'interactive'; i: Interactive };
export type BotState = { step: string | null; context: Record<string, unknown> };
/** document: CPF/CNPJ digitado, quando a mensagem guardada esta com o texto oculto. */
export type BotInput = { text: string | null; replyId: string | null; type: string; name: string | null; document?: string | null };
type Day = { open: string; close: string } | null;
export type BotMode = 'menu' | 'ai' | 'menu_ai' | 'typebot';
export type BotSettings = {
  audience: 'off' | 'test' | 'all';
  mode: BotMode;
  test_phones: string[];
  hours: Record<string, Day>;
  texts: Partial<Record<TextKey, string>>;
  ai_plan: 'free' | 'paid';
  ai_monthly_limit_usd: number;
  ai_daily_per_phone: number;
  typebot_public_id: string | null;
};

export const TEXT_KEYS = ['greeting', 'out_of_hours', 'order_prompt', 'order_not_found', 'document_prompt', 'order_not_verified', 'verify_locked', 'quote', 'handoff'] as const;
export type TextKey = (typeof TEXT_KEYS)[number];
export const DEFAULT_TEXTS: Record<TextKey, string> = {
  greeting: 'Olá! Aqui é o atendimento da {loja}. Como podemos ajudar?',
  out_of_hours: 'Estamos fora do horário de atendimento agora. Você pode usar as opções abaixo, e um atendente responde quando voltarmos.',
  order_prompt: 'Digite o número do pedido.',
  order_not_found: 'Não entendi o número do pedido. Confira e tente de novo pelo menu, ou fale com um atendente.',
  document_prompt: 'Para confirmar que o pedido é seu, digite o CPF ou CNPJ usado na compra (só os números).',
  order_not_verified: 'Não consegui confirmar esse pedido com os dados informados. Confira e tente de novo pelo menu, ou fale com um atendente.',
  verify_locked: 'Por segurança, a consulta deste pedido foi bloqueada por algumas horas depois de várias tentativas. Um atendente pode ajudar.',
  quote: 'Você pode montar o pedido direto na loja: {site}. Se preferir, um atendente prepara o orçamento para você.',
  handoff: 'Pronto! Um atendente vai continuar a conversa por aqui.',
};
export const TEXT_LABEL: Record<TextKey, string> = {
  greeting: 'Saudação (com o menu)',
  out_of_hours: 'Aviso fora do horário',
  order_prompt: 'Pedir o número do pedido',
  order_not_found: 'Número do pedido não entendido',
  document_prompt: 'Pedir o CPF/CNPJ (pedido de outro telefone)',
  order_not_verified: 'CPF/CNPJ não confere',
  verify_locked: 'Consulta bloqueada por tentativas',
  quote: 'Orçamento',
  handoff: 'Passagem para atendente',
};

const MENU_ROWS = [
  { id: 'pedido', title: 'Acompanhar pedido', description: 'Situação, entrega e rastreio' },
  { id: 'orcamento', title: 'Pedir orçamento' },
  { id: 'horario', title: 'Horário e endereço' },
  { id: 'atendente', title: 'Falar com atendente' },
];
const AFTER = (extra?: string): BotReply => ({
  kind: 'interactive',
  i: {
    type: 'button',
    body: extra ?? 'Posso ajudar em mais alguma coisa?',
    buttons: [
      { id: 'menu', title: 'Voltar ao menu' },
      { id: 'atendente', title: 'Falar com atendente' },
    ],
  },
});
const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const ORDER_STATUS: Record<string, string> = {
  pending_payment: 'aguardando pagamento',
  paid: 'pagamento confirmado',
  preparing: 'em separação',
  ready: 'pronto',
  shipped: 'despachado',
  delivered: 'entregue',
  canceled: 'cancelado',
};
const MAX_ORDER_TRIES = 3;
const MAX_VERIFY_FAILS_PHONE = 3;
const MAX_VERIFY_FAILS_ORDER = 5;
const STALE_MS = 3_600_000; // mensagem com mais de 1 h nao recebe resposta automatica
const AGENT_IDLE_MS = 24 * 3_600_000; // conversa com atendente parada ha 24 h volta ao bot

const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

/** Mesmo numero, aceitando o 9 a mais ou a menos dos celulares brasileiros (o WhatsApp as vezes manda sem). */
export function samePhone(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  if (a === b) return true;
  const drop9 = (p: string) => (/^55\d{2}9\d{8}$/.test(p) ? p.slice(0, 4) + p.slice(5) : p);
  return drop9(a) === drop9(b);
}

/** Horario de Brasilia: dia da semana e "HH:MM". */
function brNow(now: Date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, time: `${get('hour')}:${get('minute')}` };
}

/** Sem horario cadastrado: considera aberto (nao avisa nada). */
export function isOpen(hours: Record<string, Day>, now: Date) {
  if (!Object.keys(hours).length) return true;
  const { day, time } = brNow(now);
  const h = hours[String(day)];
  return Boolean(h && time >= h.open && time < h.close);
}

/** "Segunda a Sexta: 08:00 às 18:00", juntando dias seguidos com o mesmo horario. */
export function hoursText(hours: Record<string, Day>) {
  if (!Object.keys(hours).length) return null;
  const order = [1, 2, 3, 4, 5, 6, 0];
  const label = (d: Day) => (d ? `${d.open} às ${d.close}` : 'fechado');
  const lines: string[] = [];
  let start = order[0]!;
  for (let k = 1; k <= order.length; k++) {
    const prev = order[k - 1]!;
    const cur = order[k];
    if (cur !== undefined && label(hours[String(cur)] ?? null) === label(hours[String(prev)] ?? null)) continue;
    const span = start === prev ? WEEKDAYS[start] : `${WEEKDAYS[start]} a ${WEEKDAYS[prev]}`;
    lines.push(`${span}: ${label(hours[String(prev)] ?? null)}`);
    if (cur !== undefined) start = cur;
  }
  return lines.join('\n');
}

export async function loadSettings(db: Q): Promise<BotSettings> {
  const cols = 'audience, mode, test_phones, hours, texts, ai_plan, ai_monthly_limit_usd, ai_daily_per_phone, typebot_public_id';
  // Linha unica. Se faltar (banco esvaziado por fora), volta com os padroes da migration: bot desligado, so menu.
  const r =
    (await db.query(`SELECT ${cols} FROM bot_settings`)).rows[0] ??
    (await db.query(`INSERT INTO bot_settings DEFAULT VALUES ON CONFLICT (id) DO UPDATE SET id = true RETURNING ${cols}`)).rows[0];
  return {
    audience: r.audience,
    mode: r.mode,
    test_phones: r.test_phones,
    hours: r.hours,
    texts: r.texts,
    ai_plan: r.ai_plan,
    ai_monthly_limit_usd: Number(r.ai_monthly_limit_usd),
    ai_daily_per_phone: r.ai_daily_per_phone,
    typebot_public_id: r.typebot_public_id,
  };
}

/** who: quem conversa, para limitar tentativas (o telefone; no chat de teste, o usuario do painel). */
type Ctx = {
  db: Q;
  phone: string | null;
  who: string;
  settings: BotSettings;
  now: Date;
  /** IA habilitada para o modo de atendimento configurado. */
  aiAllowed?: boolean;
  channel?: 'whatsapp' | 'teste';
  inboundId?: string | null;
  history?: AiContent[];
};

const storeName = async (ctx: Ctx) => (await ctx.db.query<{ store_name: string | null }>('SELECT store_name FROM store_settings')).rows[0]?.store_name || 'loja';

const firstName = (name: string | null) => String(name ?? '').trim().split(/\s+/)[0] ?? '';

async function render(ctx: Ctx, key: TextKey, name: string | null) {
  const loja = await storeName(ctx);
  const first = firstName(name);
  const vars: Record<string, string> = { loja, nome: first, site: config.APP_ORIGIN };
  return (ctx.settings.texts[key] || DEFAULT_TEXTS[key]).replace(/\{(loja|nome|site)\}/g, (_, v: string) => vars[v] ?? '');
}

async function menu(ctx: Ctx, name: string | null, intro?: string): Promise<BotReply[]> {
  const parts = [intro, await render(ctx, 'greeting', name)];
  if (!isOpen(ctx.settings.hours, ctx.now)) parts.push(await render(ctx, 'out_of_hours', name));
  return [{ kind: 'interactive', i: { type: 'list', body: parts.filter(Boolean).join('\n\n'), button: 'Ver opções', rows: MENU_ROWS } }];
}

async function storeInfo(ctx: Ctx) {
  const c = (
    await ctx.db.query<{ street: string | null; number: string | null; complement: string | null; district: string | null; city: string | null; uf: string | null; cep: string | null }>(
      'SELECT street, number, complement, district, city, uf, cep FROM company_profiles ORDER BY version DESC LIMIT 1',
    )
  ).rows[0];
  const lines: string[] = [];
  const hours = hoursText(ctx.settings.hours);
  if (hours) lines.push(`Horário de atendimento:\n${hours}`);
  if (c?.street && c.city) {
    const cep = c.cep ? ` - CEP ${c.cep.slice(0, 5)}-${c.cep.slice(5)}` : '';
    lines.push(`Endereço:\n${c.street}, ${c.number ?? 's/n'}${c.complement ? `, ${c.complement}` : ''}${c.district ? ` - ${c.district}` : ''}\n${c.city}/${c.uf ?? ''}${cep}`);
  }
  return lines.length ? lines.join('\n\n') : 'Um atendente pode passar o horário e o endereço para você.';
}

type OrderRow = { number: number; status: string; phone: string | null; document: string | null; kind: string | null; ship_name: string | null; carrier: string | null; tracking_code: string | null; tracking_url: string | null };

async function findOrder(ctx: Ctx, number: number) {
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return (
    (
      await ctx.db.query<OrderRow>(
        `SELECT o.number, o.status, o.buyer->>'phone' AS phone, o.buyer->>'document' AS document, o.shipping_snapshot->>'kind' AS kind,
                o.shipping_snapshot->>'name' AS ship_name, s.carrier, s.tracking_code, s.tracking_url
         FROM orders o LEFT JOIN shipments s ON s.order_id = o.id WHERE o.number = $1`,
        [number],
      )
    ).rows[0] ?? null
  );
}

const verifyKey = (ctx: Ctx) => keyedHash(`bot-verify:${ctx.who}`);

/** Tentativas erradas de confirmar com documento: 3 por telefone ou 5 por pedido em 24 h bloqueiam a consulta. */
async function verifyLocked(ctx: Ctx, number: number) {
  const r = (
    await ctx.db.query<{ by_phone: number; by_order: number }>(
      `SELECT count(*) FILTER (WHERE phone_hash = $1)::int AS by_phone, count(*) FILTER (WHERE order_number = $2)::int AS by_order
       FROM bot_verify_failures WHERE created_at > now() - interval '24 hours' AND (phone_hash = $1 OR order_number = $2)`,
      [verifyKey(ctx), number],
    )
  ).rows[0]!;
  return r.by_phone >= MAX_VERIFY_FAILS_PHONE || r.by_order >= MAX_VERIFY_FAILS_ORDER;
}

function orderText(o: OrderRow) {
  const status = o.status === 'ready' && o.kind === 'pickup' ? 'pronto para retirada' : (ORDER_STATUS[o.status] ?? o.status);
  const lines = [`Pedido #${o.number}: ${status}.`];
  if (o.ship_name) lines.push(`Entrega: ${o.ship_name}.`);
  if (o.tracking_code) lines.push(`Rastreio${o.carrier ? ` (${o.carrier})` : ''}: ${o.tracking_code}${o.tracking_url ? `\n${o.tracking_url}` : ''}`);
  return lines.join('\n');
}

const onlyDigits = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');

function choiceOf(input: BotInput, step: string | null) {
  if (input.replyId && ['menu', ...MENU_ROWS.map((r) => r.id)].includes(input.replyId)) return input.replyId;
  const t = norm(input.text ?? '');
  if (['menu', 'inicio', 'voltar', 'opcoes'].includes(t)) return 'menu';
  // Pedido explicito de atendimento humano. "pessoa" sozinha nao vale: "1 copo por pessoa" e conversa de venda.
  if (/\batendente\b|\bhumano\b|\b(falar|conversar) com (uma |alguma )?pessoa\b|\bpessoa de verdade\b/.test(t)) return 'atendente';
  // No menu, o cliente pode digitar o numero da opcao em vez de tocar na lista.
  if (step === 'menu' && /^[1-4]$/.test(t)) return MENU_ROWS[Number(t) - 1]!.id;
  return null;
}

/** Uma rodada do bot de menu: respostas e o novo estado. handoff = passar para atendente. */
export async function menuBot(ctx: Ctx, state: BotState, input: BotInput): Promise<{ replies: BotReply[]; state: BotState; handoff: boolean }> {
  const choice = choiceOf(input, state.step);
  const done = (replies: BotReply[], step: string | null = 'menu', context: Record<string, unknown> = {}) => ({ replies, state: { step, context }, handoff: false });

  switch (choice) {
    case 'menu':
      return done(await menu(ctx, input.name));
    case 'pedido':
      return done([{ kind: 'text', body: await render(ctx, 'order_prompt', input.name) }], 'await_order', { tries: 0 });
    case 'orcamento':
      return done([AFTER(await render(ctx, 'quote', input.name))]);
    case 'horario':
      return done([AFTER(await storeInfo(ctx))]);
    case 'atendente': {
      let body = await render(ctx, 'handoff', input.name);
      if (!isOpen(ctx.settings.hours, ctx.now)) {
        const h = hoursText(ctx.settings.hours);
        body += `\n\nEstamos fora do horário agora: respondemos assim que voltarmos.${h ? `\n${h}` : ''}`;
      }
      return { replies: [{ kind: 'text', body }], state: { step: null, context: {} }, handoff: true };
    }
  }

  if (state.step === 'await_order') {
    const digits = (input.text ?? '').match(/\d{1,9}/)?.[0];
    if (!digits) {
      const tries = Number(state.context.tries ?? 0) + 1;
      if (tries >= MAX_ORDER_TRIES) return done([AFTER(await render(ctx, 'order_not_found', input.name))]);
      return done([{ kind: 'text', body: await render(ctx, 'order_prompt', input.name) }], 'await_order', { tries });
    }
    const number = Number(digits);
    const o = await findOrder(ctx, number);
    if (o && samePhone(toWhatsAppNumber(o.phone), ctx.phone)) return done([{ kind: 'text', body: orderText(o) }, AFTER()]);
    // Outro telefone ou pedido inexistente: os dois pedem o documento, para nao revelar se o numero existe.
    if (await verifyLocked(ctx, number)) return done([AFTER(await render(ctx, 'verify_locked', input.name))]);
    return done([{ kind: 'text', body: await render(ctx, 'document_prompt', input.name) }], 'await_document', { order: number });
  }

  if (state.step === 'await_document') {
    const number = Number(state.context.order);
    const typed = onlyDigits(input.document ?? input.text);
    if (await verifyLocked(ctx, number)) return done([AFTER(await render(ctx, 'verify_locked', input.name))]);
    const o = await findOrder(ctx, number);
    if (o && (typed.length === 11 || typed.length === 14) && onlyDigits(o.document) === typed) return done([{ kind: 'text', body: orderText(o) }, AFTER()]);
    await ctx.db.query('INSERT INTO bot_verify_failures (phone_hash, order_number) VALUES ($1, $2)', [verifyKey(ctx), Number.isSafeInteger(number) ? number : null]);
    return done([AFTER(await render(ctx, 'order_not_verified', input.name))]);
  }

  // Sem conversa em andamento (ou a da IA, quando ela nao responde mais): o menu de sempre, sem "Não entendi".
  if (state.step === null || state.step === AI_STEP) return done(await menu(ctx, input.name));
  return done(await menu(ctx, input.name, 'Não entendi. Escolha uma das opções:'));
}

// ---------------- IA ----------------

let aiProvider: AiProvider | null = null;
export const setAiProvider = (p: AiProvider | null) => void (aiProvider = p);

/** guarded: a protecao barrou a mensagem (ela nao entra no historico do chat de teste). */
/** route: caminho que respondeu (gravado em bot_runs, sem texto e sem telefone) para investigar conversas. */
type Out = { replies: BotReply[]; state: BotState; handoff: boolean; ai?: boolean; guarded?: boolean; route?: string };

/**
 * Passo da conversa com a IA. Enquanto ele vale, a mensagem do cliente continua a conversa: numero curto ("3") nao
 * e opcao do menu, e uma falha da IA nao mostra o menu. So comandos explicitos (menu, atendente) saem dele.
 */
const AI_STEP = 'ai';
const AI_RETRY_TEXT =
  'Desculpe, tive uma instabilidade aqui e não consegui responder agora. Pode me mandar de novo daqui a pouquinho? Se preferir, digite *atendente* que eu chamo alguém da equipe.';
const AI_BURST_TEXT = 'Recebi várias mensagens seguidas. Me dá um minutinho e me mande de novo, por favor.';

/**
 * Quem responde: menu ou IA. Botoes, opcoes digitadas e os passos de pedido/documento ficam sempre com o menu.
 * Modo ai: a IA responde o texto livre. Modo menu_ai: o menu abre a conversa e a IA entra no lugar do "Nao entendi".
 * IA fora do ar ou limite do mes: o menu responde. Limite diario de quem conversa: passa para atendente.
 */
export async function respond(ctx: Ctx, state: BotState, input: BotInput): Promise<Out> {
  const mode = ctx.settings.mode;
  if (mode === 'typebot') {
    if (!typebotProvider || !ctx.settings.typebot_public_id) return menuBot(ctx, state, input);
    // Atendente digitado, botoes do menu da loja e os passos de pedido/CPF ficam com a loja.
    const ours = choiceOf(input, state.step) !== null || state.step === 'await_order' || state.step === 'await_document' || (input.replyId !== null && !input.replyId.startsWith('tb:'));
    return ours ? menuBot(ctx, state, input) : typebotBot(ctx, state, input);
  }
  const freeText = !input.replyId && Boolean(input.text?.trim()) && choiceOf(input, state.step) === null && state.step !== 'await_order' && state.step !== 'await_document';
  const useAi = aiProvider && ctx.aiAllowed && freeText && (mode === 'ai' || (mode === 'menu_ai' && state.step !== null));
  if (!useAi) return { ...(await menuBot(ctx, state, input)), route: choiceOf(input, state.step) ? `menu:${choiceOf(input, state.step)}` : 'menu' };
  const inAi = state.step === AI_STEP;
  const menuChoice = async (replyId: string, route: string) => ({ ...(await menuBot(ctx, state, { ...input, text: null, replyId })), route });
  // Falha da IA no meio da conversa: resposta natural e o cliente continua; na segunda seguida, atendente.
  const aiFailed = async (route: string): Promise<Out> => {
    if (!inAi) return { ...(await menuBot(ctx, state, input)), route };
    const fails = Number(state.context.aiFails ?? 0) + 1;
    if (fails >= 2) return menuChoice('atendente', `${route}:atendente`);
    return { replies: [{ kind: 'text', body: AI_RETRY_TEXT }], state: { step: AI_STEP, context: { aiFails: fails } }, handoff: false, route };
  };
  const r = await aiTurn(
    {
      db: ctx.db,
      ai: aiProvider!,
      phone: ctx.phone,
      who: ctx.who,
      channel: ctx.channel ?? 'whatsapp',
      inboundId: ctx.inboundId ?? null,
      storeName: await storeName(ctx),
      storeInfo: () => storeInfo(ctx),
      orderText: async (n) => {
        const o = await findOrder(ctx, n);
        return o ? { ownerPhone: toWhatsAppNumber(o.phone), text: orderText(o), urls: o.tracking_url ? [o.tracking_url] : [] } : null;
      },
      sameOwner: (p) => samePhone(p, ctx.phone),
      limits: { monthlyUsd: ctx.settings.ai_monthly_limit_usd, dailyPerWho: ctx.settings.ai_daily_per_phone },
      history: ctx.history ?? [],
    },
    input.text!,
  );
  switch (r.kind) {
    case 'reply':
      // Recomendacao com links, preco ou pergunta: a conversa segue com a IA (nada de menu na proxima mensagem).
      return { replies: [{ kind: 'text', body: r.text }], state: { step: AI_STEP, context: {} }, handoff: false, ai: true, route: 'ia' };
    case 'handoff':
      return menuChoice('atendente', 'ia:atendente');
    case 'verify':
      // Pedido de outro telefone: o menu pede o CPF/CNPJ, e o documento nao passa pela IA.
      return r.order
        ? { ...(await menuBot(ctx, { step: 'await_order', context: { tries: 0 } }, { ...input, replyId: null, text: String(r.order) })), route: 'ia:verificar' }
        : menuChoice('pedido', 'ia:pedido');
    case 'limit':
      if (r.reason === 'daily') return menuChoice('atendente', 'limite_dia:atendente');
      // Verba do mes acabou no meio da conversa: um atendente continua, com o historico.
      if (r.reason === 'monthly') return inAi ? menuChoice('atendente', 'limite_mes:atendente') : { ...(await menuBot(ctx, state, input)), route: 'limite_mes' };
      if (r.reason === 'burst' && inAi) return { replies: [{ kind: 'text', body: AI_BURST_TEXT }], state, handoff: false, route: 'limite_rajada' };
      return { ...(await menuBot(ctx, state, input)), route: `limite_${r.reason}` };
    case 'refused':
      // Barrado pela protecao: resposta padrao da loja, sem detalhe tecnico, com os botoes de sempre.
      return { replies: [AFTER(SAFE_REPLY)], state: { step: 'menu', context: {} }, handoff: false, guarded: true, route: `barrado_${r.reason}` };
    default:
      return aiFailed('ia_falha');
  }
}

// ---------------- Typebot ----------------

let typebotProvider: TypebotProvider | null = null;
export const setTypebotProvider = (p: TypebotProvider | null) => void (typebotProvider = p);

/** Valores de botao no fluxo que chamam a loja (docs/11 §9): horario e orcamento usam os textos do painel. */
const TB_RESERVED = ['atendente', 'pedido', 'menu', 'orcamento', 'horario'];
/** Sessao parada ha mais de 12 h recomeca o fluxo. */
const TB_STALE_MS = 12 * 3_600_000;
type TbItems = Record<string, { content: string; value: string | null }>;
type TbContext = { session?: string; items?: TbItems; at?: string };

/** Textos do fluxo em mensagens; as opcoes viram botoes (ate 3 curtas) ou lista (ate 10). */
function tbReplies(turn: TbTurn): BotReply[] {
  const replies: BotReply[] = turn.texts.map((t) => ({ kind: 'text', body: t.slice(0, 4096) }));
  const items = (turn.choices ?? []).slice(0, 10);
  if (items.length) {
    const last = replies.at(-1);
    const body = last?.kind === 'text' ? (replies.pop() as { body: string }).body : 'Escolha uma opção:';
    replies.push(
      items.length <= 3 && items.every((c) => c.content.length <= 20)
        ? { kind: 'interactive', i: { type: 'button', body, buttons: items.map((c) => ({ id: `tb:${c.id}`, title: c.content })) } }
        : {
            kind: 'interactive',
            i: { type: 'list', body, button: 'Ver opções', rows: items.map((c) => ({ id: `tb:${c.id}`, title: c.content, ...(c.content.length > 24 ? { description: c.content } : {}) })) },
          },
    );
  }
  return replies.length ? replies : [AFTER()];
}

async function typebotBot(ctx: Ctx, state: BotState, input: BotInput): Promise<Out> {
  const tb = typebotProvider!;
  const publicId = ctx.settings.typebot_public_id!;
  const c: TbContext = state.step === 'typebot' ? (state.context as TbContext) : {};
  const items = c.items ?? {};
  let text = input.text?.trim() ?? '';
  // Opcao tocada (ou digitada igual): valor reservado chama a loja; senao vai o texto da opcao, que o Typebot confere.
  const picked = input.replyId?.startsWith('tb:') ? items[input.replyId.slice(3)] : Object.values(items).find((i) => norm(i.content) === norm(text));
  if (picked?.value && TB_RESERVED.includes(picked.value)) return menuBot(ctx, state, { ...input, text: null, replyId: picked.value });
  if (picked) text = picked.content;
  if (!text) text = `[${input.type}]`;

  const fresh = !c.session || !c.at || ctx.now.getTime() - Date.parse(c.at) > TB_STALE_MS;
  const name = firstName(input.name);
  const variables: Record<string, string> = name ? { nome: name } : {};
  let turn: TbTurn;
  try {
    if (fresh) turn = await tb.start(publicId, variables);
    else {
      try {
        turn = await tb.continue(c.session!, text.slice(0, 1000));
      } catch (err) {
        if (!(err instanceof TypebotSessionGone)) throw err;
        turn = await tb.start(publicId, variables);
      }
    }
  } catch {
    // Typebot fora do ar: o menu da loja responde.
    return menuBot(ctx, { step: null, context: {} }, input);
  }
  const next: TbItems = Object.fromEntries((turn.choices ?? []).slice(0, 10).map((i) => [i.id, { content: i.content, value: i.value }]));
  return {
    replies: tbReplies(turn),
    state: turn.ended ? { step: null, context: {} } : { step: 'typebot', context: { session: turn.sessionId, items: next, at: ctx.now.toISOString() } },
    handoff: false,
  };
}

const isAiMode = (m: BotMode) => m === 'ai' || m === 'menu_ai';

// ---------------- processamento das mensagens recebidas ----------------

type InboundRow = { id: string; from_phone: string; profile_name: string | null; type: string; body: string | null; reply_id: string | null; sent_at: Date };
type ConvRow = { state: 'bot' | 'agent' | 'closed'; step: string | null; context: Record<string, unknown>; updated_at: Date };

let current: Promise<{ handled: number }> | null = null;
let again = false;

async function sendReply(provider: WhatsAppProvider, to: string, r: BotReply) {
  const body = r.kind === 'text' ? r.body : interactiveSummary(r.i);
  let wamid: string | null = null;
  let error: string | null = null;
  try {
    wamid = (r.kind === 'text' ? await provider.sendText(to, r.body) : await provider.sendInteractive(to, r.i)).wamid;
  } catch (err) {
    error = (err as Error).message.slice(0, 500);
  }
  await pool.query(
    `INSERT INTO whatsapp_messages (kind, to_phone, body, payload, status, wamid, error, attempts, source) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'bot')`,
    [r.kind, to, body, r.kind === 'interactive' ? JSON.stringify(r.i) : null, wamid ? 'sent' : 'failed', wamid, error],
  );
  return Boolean(wamid);
}

/** Documento guardado pelo webhook para esta mensagem: le e apaga. */
async function takeDocument(inboundId: string) {
  const r = (await pool.query<{ document_enc: string }>('DELETE FROM bot_pending_documents WHERE inbound_id = $1 RETURNING document_enc', [inboundId])).rows[0];
  return r ? decrypt(r.document_enc) : null;
}

async function handleOne(provider: WhatsAppProvider, settings: BotSettings, m: InboundRow, now: Date) {
  const claim = async (outcome: string) => ((await pool.query('INSERT INTO bot_runs (inbound_id, outcome) VALUES ($1, $2) ON CONFLICT DO NOTHING', [m.id, outcome])).rowCount ?? 0) > 0;
  if (now.getTime() - m.sent_at.getTime() > STALE_MS) return claim('stale');
  if ((await pool.query(
    `SELECT 1 FROM whatsapp_inbound i JOIN bot_runs r ON r.inbound_id = i.id
     WHERE i.from_phone = $1 AND i.id > $2 AND r.outcome = 'closed_by_customer' LIMIT 1`,
    [m.from_phone, m.id],
  )).rowCount) return claim('superseded');
  if (settings.audience === 'test' && !settings.test_phones.some((p) => samePhone(p, m.from_phone))) return claim('not_audience');

  const conv = (await pool.query<ConvRow>('SELECT state, step, context, updated_at FROM whatsapp_conversations WHERE phone = $1', [m.from_phone])).rows[0];
  if (conv?.state === 'agent' && now.getTime() - conv.updated_at.getTime() < AGENT_IDLE_MS) return claim('agent');
  if (!(await claim('replied'))) return false;

  const state: BotState = conv?.state === 'bot' ? { step: conv.step, context: conv.context } : { step: null, context: {} };
  const aiAllowed = isAiMode(settings.mode);
  const history = aiAllowed && aiProvider ? await historyFor(pool, m.from_phone, m.id) : [];
  const out = await respond({ db: pool, phone: m.from_phone, who: m.from_phone, settings, now, aiAllowed, history, channel: 'whatsapp', inboundId: m.id }, state, {
    text: m.body,
    replyId: m.reply_id,
    type: m.type,
    name: m.profile_name,
    document: await takeDocument(m.id),
  });
  for (const r of out.replies) await sendReply(provider, m.from_phone, r);
  await pool.query('UPDATE bot_runs SET route = $2 WHERE inbound_id = $1', [m.id, (out.route ?? (out.handoff ? 'atendente' : 'menu')).slice(0, 40)]);
  await pool.query(
    `INSERT INTO whatsapp_conversations (phone, state, step, context, agent_since, updated_at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (phone) DO UPDATE SET state = EXCLUDED.state, step = EXCLUDED.step, context = EXCLUDED.context,
       agent_since = EXCLUDED.agent_since, assigned_to = CASE WHEN EXCLUDED.state = 'agent' THEN whatsapp_conversations.assigned_to END, updated_at = now()
     WHERE whatsapp_conversations.state <> 'closed' OR whatsapp_conversations.updated_at <= (SELECT received_at FROM whatsapp_inbound WHERE id = $6)`,
    [m.from_phone, out.handoff ? 'agent' : 'bot', out.state.step, JSON.stringify(out.state.context), out.handoff ? now : null, m.id],
  );
  return true;
}

/**
 * Responde as mensagens recebidas que ainda nao passaram pelo bot. Chamada logo depois do webhook e na rotina de
 * 60 s. Uma execucao por vez neste processo; bot_runs garante uma resposta por mensagem.
 */
export function botTick(provider: WhatsAppProvider | null, now = () => new Date()): Promise<{ handled: number }> {
  if (!provider) return Promise.resolve({ handled: 0 });
  // Ja rodando: pede mais uma volta e espera a mesma execucao terminar.
  if (current) {
    again = true;
    return current;
  }
  current = runBot(provider, now).finally(() => {
    current = null;
  });
  return current;
}

async function runBot(provider: WhatsAppProvider, now: () => Date) {
  let handled = 0;
  do {
    again = false;
    // Documento que ficou para tras (mensagem nao respondida): nao fica guardado.
    await pool.query(`DELETE FROM bot_pending_documents WHERE created_at < now() - interval '2 hours'`);
    // LGPD: eventos de seguranca ficam 90 dias.
    await pool.query(`DELETE FROM bot_security_events WHERE created_at < now() - interval '90 days'`);
    const settings = await loadSettings(pool);
    // Desligado: marca como vistas, para nao responder atrasado quando o bot for ligado.
    if (settings.audience === 'off') {
      await pool.query(
        `INSERT INTO bot_runs (inbound_id, outcome) SELECT i.id, 'off' FROM whatsapp_inbound i
         WHERE i.received_at > now() - interval '2 hours' AND NOT EXISTS (SELECT 1 FROM bot_runs r WHERE r.inbound_id = i.id) ON CONFLICT DO NOTHING`,
      );
      break;
    }
    const { rows } = await pool.query<InboundRow>(
      `SELECT i.id, i.from_phone, i.profile_name, i.type, i.body, i.reply_id, i.sent_at FROM whatsapp_inbound i
       WHERE i.received_at > now() - interval '2 hours' AND NOT EXISTS (SELECT 1 FROM bot_runs r WHERE r.inbound_id = i.id)
       ORDER BY i.id LIMIT 50`,
    );
    for (const m of rows) if (await handleOne(provider, settings, m, now())) handled++;
    if (rows.length === 50) again = true;
  } while (again);
  return { handled };
}

// ---------------- painel ----------------

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário como 08:00.');
const day = z
  .strictObject({ open: time, close: time })
  .nullable()
  .refine((d) => !d || d.open < d.close, 'O fechamento precisa ser depois da abertura.');
const settingsBody = z.strictObject({
  audience: z.enum(['off', 'test', 'all']),
  testPhones: z.array(z.string().regex(/^55\d{10,11}$/, 'Número de teste como 5547999998888 (55 + DDD + número).')).max(20),
  hours: z.partialRecord(z.enum(['0', '1', '2', '3', '4', '5', '6']), day),
  texts: z.partialRecord(z.enum(TEXT_KEYS), z.string().trim().max(1000)),
  // Campos da IA (etapa 2). Ausentes = ficam como estao.
  mode: z.enum(['menu', 'ai', 'menu_ai', 'typebot']).optional(),
  typebotPublicId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,100}$/, 'ID público do fluxo: só letras, números, - e _.')
    .nullable()
    .optional(),
  aiPlan: z.enum(['free', 'paid']).optional(),
  aiMonthlyLimitUsd: z.number().min(0).max(1000).multipleOf(0.01).optional(),
  aiDailyPerPhone: z.number().int().min(1).max(200).optional(),
});

/** Gasto estimado da IA no mes (horario de Brasilia). */
async function aiMonth(db: Q) {
  const r = (
    await db.query<{ usd: string; calls: number; failed: number }>(
      `SELECT coalesce(sum(cost_usd), 0) AS usd, count(*)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS failed FROM ai_calls
       WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`,
    )
  ).rows[0]!;
  return { usd: Number(r.usd), calls: r.calls, failed: r.failed };
}

const testBody = z.strictObject({
  text: z.string().trim().max(1000).optional(),
  replyId: z.string().max(256).optional(),
  phone: z.string().regex(/^\d{10,15}$/).nullable().optional(),
});

export async function botAdminRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    requirePermission(req, 'sales_desk.use');
    const s = await loadSettings(pool);
    return {
      settings: {
        audience: s.audience,
        mode: s.mode,
        testPhones: s.test_phones,
        hours: s.hours,
        texts: s.texts,
        aiPlan: s.ai_plan,
        aiMonthlyLimitUsd: s.ai_monthly_limit_usd,
        aiDailyPerPhone: s.ai_daily_per_phone,
        typebotPublicId: s.typebot_public_id,
      },
      typebot: { configured: Boolean(typebotProvider), simulated: typebotProvider?.fake ?? false },
      ai: { configured: Boolean(aiProvider), simulated: aiProvider?.fake ?? false, model: aiProvider?.model ?? null, month: await aiMonth(pool) },
      defaults: DEFAULT_TEXTS,
      labels: TEXT_LABEL,
      variables: ['loja', 'nome', 'site'],
      open: isOpen(s.hours, new Date()),
      hoursText: hoursText(s.hours),
    };
  });

  app.put('/', async (req) => {
    const auth = requirePermission(req, 'bot.manage');
    const b = settingsBody.parse(req.body);
    const texts = Object.fromEntries(Object.entries(b.texts).filter(([, v]) => v)); // vazio = volta ao padrao
    return tx(auth.userId, async (db) => {
      const before = await loadSettings(db);
      const mode = b.mode ?? before.mode;
      const aiPlan = b.aiPlan ?? before.ai_plan;
      const aiMonthly = b.aiMonthlyLimitUsd ?? before.ai_monthly_limit_usd;
      const aiDaily = b.aiDailyPerPhone ?? before.ai_daily_per_phone;
      const typebotId = b.typebotPublicId === undefined ? before.typebot_public_id : b.typebotPublicId || null;
      if (mode === 'typebot' && !typebotId) throw new AppError(400, 'VALIDATION', 'Informe o ID público do fluxo do Typebot.');
      await db.query(
        `UPDATE bot_settings SET audience = $1, test_phones = $2, hours = $3, texts = $4, mode = $5, ai_plan = $6, ai_monthly_limit_usd = $7,
           ai_daily_per_phone = $8, typebot_public_id = $9, updated_by = $10, updated_at = now()`,
        [b.audience, b.testPhones, JSON.stringify(b.hours), JSON.stringify(texts), mode, aiPlan, aiMonthly, aiDaily, typebotId, auth.userId],
      );
      await audit(db, {
        actorId: auth.userId,
        action: 'whatsapp.bot_settings',
        entity: 'bot_settings',
        before: {
          audience: before.audience,
          testPhones: before.test_phones.length,
          hours: before.hours,
          texts: Object.keys(before.texts),
          mode: before.mode,
          aiPlan: before.ai_plan,
          aiMonthlyLimitUsd: before.ai_monthly_limit_usd,
          aiDailyPerPhone: before.ai_daily_per_phone,
          typebotPublicId: before.typebot_public_id,
        },
        after: { audience: b.audience, testPhones: b.testPhones.length, hours: b.hours, texts: Object.keys(texts), mode, aiPlan, aiMonthlyLimitUsd: aiMonthly, aiDailyPerPhone: aiDaily, typebotPublicId: typebotId },
        ip: auth.ip,
      });
      return { ok: true };
    });
  });

  /** Chat de teste: roda o bot sem WhatsApp. O telefone simulado decide quais pedidos aparecem. */
  app.post('/test', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const auth = requirePermission(req, 'bot.manage');
    const b = testBody.parse(req.body);
    const settings = await loadSettings(pool);
    const s = (
      await pool.query<{ phone: string | null; step: string | null; context: Record<string, unknown>; history: AiContent[] }>(
        'SELECT phone, step, context, history FROM bot_test_sessions WHERE user_id = $1',
        [auth.userId],
      )
    ).rows[0];
    const phone = b.phone === undefined ? (s?.phone ?? null) : b.phone;
    const history = s?.history ?? [];
    // O chat de teste sempre pode usar a IA (o modo menu continua so menu).
    const out = await respond(
      { db: pool, phone, who: `teste:${auth.userId}`, settings, now: new Date(), aiAllowed: isAiMode(settings.mode), history, channel: 'teste' },
      { step: s?.step ?? null, context: s?.context ?? {} },
      { text: b.text ?? null, replyId: b.replyId ?? null, type: b.replyId ? 'interactive' : 'text', name: null },
    );
    const said = b.text?.trim();
    const next: AiContent[] = out.handoff
      ? []
      : [
          ...history,
          ...(said && !out.guarded ? [{ role: 'user' as const, parts: [{ text: said }] }] : []),
          ...out.replies.map((r) => ({ role: 'model' as const, parts: [{ text: r.kind === 'text' ? r.body : interactiveSummary(r.i) }] })),
        ].slice(-12);
    await pool.query(
      `INSERT INTO bot_test_sessions (user_id, phone, step, context, history, updated_at) VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (user_id) DO UPDATE SET phone = EXCLUDED.phone, step = EXCLUDED.step, context = EXCLUDED.context, history = EXCLUDED.history, updated_at = now()`,
      [auth.userId, phone, out.handoff ? null : out.state.step, JSON.stringify(out.handoff ? {} : out.state.context), JSON.stringify(next)],
    );
    return { replies: out.replies, handoff: out.handoff, ai: Boolean(out.ai), phone };
  });

  /** Eventos de seguranca da IA (7 dias): sem texto das mensagens e sem telefone. */
  app.get('/security', async (req) => {
    requirePermission(req, 'bot.manage');
    return securitySummary(pool);
  });

  app.post('/security/unblock', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const auth = requirePermission(req, 'bot.manage');
    const { phone } = z.strictObject({ phone: z.string().trim().regex(/^\+?\d{10,15}$/) }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const hash = await clearAiCooldown(db, phone.replace(/^\+/, ''));
      if (hash) {
        await audit(db, {
          actorId: auth.userId,
          action: 'whatsapp.bot_cooldown_cleared',
          entity: 'bot_security_events',
          after: { whoHash: hash },
          ip: auth.ip,
        });
      }
      return { cleared: hash !== null };
    });
  });

  app.delete('/test', async (req) => {
    const auth = requirePermission(req, 'bot.manage');
    await pool.query('DELETE FROM bot_test_sessions WHERE user_id = $1', [auth.userId]);
    return { ok: true };
  });
}

/** Atendente assume a conversa: o bot para de responder este numero. */
export async function takeConversation(db: Db, phone: string, userId: string) {
  await db.query(
    `INSERT INTO whatsapp_conversations (phone, state, assigned_to, agent_since, updated_at) VALUES ($1, 'agent', $2, now(), now())
     ON CONFLICT (phone) DO UPDATE SET state = 'agent', assigned_to = $2, agent_since = coalesce(whatsapp_conversations.agent_since, now()), step = NULL, context = '{}', updated_at = now()`,
    [phone, userId],
  );
}

/** Devolve ao bot: a proxima mensagem do cliente recebe o menu. */
export async function releaseConversation(db: Db, phone: string) {
  const r = await db.query(`UPDATE whatsapp_conversations SET state = 'closed', assigned_to = NULL, agent_since = NULL, step = NULL, context = '{}', updated_at = now() WHERE phone = $1`, [phone]);
  if (!r.rowCount) throw new AppError(404, 'NOT_FOUND', 'Conversa não encontrada.');
}

/** O bot esta esperando o CPF/CNPJ deste numero? (o webhook consulta antes de gravar a mensagem) */
export async function awaitingDocument(phone: string) {
  const c = (await pool.query<{ step: string | null; state: string }>('SELECT step, state FROM whatsapp_conversations WHERE phone = $1', [phone])).rows[0];
  return c?.state === 'bot' && c.step === 'await_document';
}

/** Texto gravado no lugar do documento: a caixa de entrada e o historico nunca mostram o CPF/CNPJ. */
export const HIDDEN_DOCUMENT = 'Documento informado (oculto pelo sistema)';

/** Guarda o documento cifrado so ate o bot conferir (takeDocument apaga). */
export async function keepDocument(inboundId: string, text: string) {
  const digits = text.replace(/\D/g, '').slice(0, 20);
  if (digits) await pool.query('INSERT INTO bot_pending_documents (inbound_id, document_enc) VALUES ($1, $2) ON CONFLICT DO NOTHING', [inboundId, encrypt(digits)]);
}
