import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { keyedHash } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { interactiveSummary, toWhatsAppNumber, type Interactive, type WhatsAppProvider } from '../lib/whatsapp.js';
import { requirePermission } from './auth.js';

/**
 * Bot de atendimento, etapa 1: menu com regras fixas (docs/10-bot-atendimento-proposta.md).
 * Nao altera nada na loja: so consulta pedido (do proprio telefone), horario e endereco, e passa para atendente.
 */

type Q = Db | typeof pool;
export type BotReply = { kind: 'text'; body: string } | { kind: 'interactive'; i: Interactive };
export type BotState = { step: string | null; context: Record<string, unknown> };
export type BotInput = { text: string | null; replyId: string | null; type: string; name: string | null };
type Day = { open: string; close: string } | null;
export type BotSettings = { audience: 'off' | 'test' | 'all'; mode: 'menu'; test_phones: string[]; hours: Record<string, Day>; texts: Partial<Record<TextKey, string>> };

export const TEXT_KEYS = ['greeting', 'out_of_hours', 'order_prompt', 'order_not_found', 'quote', 'handoff'] as const;
export type TextKey = (typeof TEXT_KEYS)[number];
export const DEFAULT_TEXTS: Record<TextKey, string> = {
  greeting: 'Olá! Aqui é o atendimento da {loja}. Como podemos ajudar?',
  out_of_hours: 'Estamos fora do horário de atendimento agora. Você pode usar as opções abaixo, e um atendente responde quando voltarmos.',
  order_prompt: 'Digite o número do pedido.',
  order_not_found: 'Não encontrei um pedido com esse número para este WhatsApp. Confira o número ou fale com um atendente.',
  quote: 'Você pode montar o pedido direto na loja: {site}. Se preferir, um atendente prepara o orçamento para você.',
  handoff: 'Pronto! Um atendente vai continuar a conversa por aqui.',
};
export const TEXT_LABEL: Record<TextKey, string> = {
  greeting: 'Saudação (com o menu)',
  out_of_hours: 'Aviso fora do horário',
  order_prompt: 'Pedir o número do pedido',
  order_not_found: 'Pedido não encontrado',
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
const STALE_MS = 3_600_000; // mensagem com mais de 1 h nao recebe resposta automatica
const AGENT_IDLE_MS = 24 * 3_600_000; // conversa com atendente parada ha 24 h volta ao bot
const phoneHash = (phone: string) => keyedHash(`wa-optout:${phone}`);

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
  const r = (await db.query('SELECT audience, mode, test_phones, hours, texts FROM bot_settings')).rows[0];
  return { audience: r.audience, mode: r.mode, test_phones: r.test_phones, hours: r.hours, texts: r.texts };
}

type Ctx = { db: Q; phone: string | null; settings: BotSettings; now: Date };

async function render(ctx: Ctx, key: TextKey, name: string | null) {
  const loja = (await ctx.db.query<{ store_name: string | null }>('SELECT store_name FROM store_settings')).rows[0]?.store_name || 'loja';
  const first = String(name ?? '').trim().split(/\s+/)[0] ?? '';
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

async function orderInfo(ctx: Ctx, number: number) {
  const o = (
    await ctx.db.query<{ number: number; status: string; phone: string | null; kind: string | null; ship_name: string | null; carrier: string | null; tracking_code: string | null; tracking_url: string | null }>(
      `SELECT o.number, o.status, o.buyer->>'phone' AS phone, o.shipping_snapshot->>'kind' AS kind, o.shipping_snapshot->>'name' AS ship_name,
              s.carrier, s.tracking_code, s.tracking_url
       FROM orders o LEFT JOIN shipments s ON s.order_id = o.id WHERE o.number = $1`,
      [number],
    )
  ).rows[0];
  // Pedido de outro telefone recebe a mesma resposta de pedido inexistente: nao revela que o numero existe.
  if (!o || !samePhone(toWhatsAppNumber(o.phone), ctx.phone)) return null;
  const status = o.status === 'ready' && o.kind === 'pickup' ? 'pronto para retirada' : (ORDER_STATUS[o.status] ?? o.status);
  const lines = [`Pedido #${o.number}: ${status}.`];
  if (o.ship_name) lines.push(`Entrega: ${o.ship_name}.`);
  if (o.tracking_code) lines.push(`Rastreio${o.carrier ? ` (${o.carrier})` : ''}: ${o.tracking_code}${o.tracking_url ? `\n${o.tracking_url}` : ''}`);
  return lines.join('\n');
}

function choiceOf(input: BotInput, step: string | null) {
  if (input.replyId && ['menu', ...MENU_ROWS.map((r) => r.id)].includes(input.replyId)) return input.replyId;
  const t = norm(input.text ?? '');
  if (['menu', 'inicio', 'voltar', 'opcoes'].includes(t)) return 'menu';
  if (/\batendente\b|\bhumano\b|\bpessoa\b/.test(t)) return 'atendente';
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
    const tries = Number(state.context.tries ?? 0) + 1;
    const info = digits ? await orderInfo(ctx, Number(digits)) : null;
    if (info) return done([{ kind: 'text', body: info }, AFTER()]);
    if (tries >= MAX_ORDER_TRIES) return done([AFTER(await render(ctx, 'order_not_found', input.name))]);
    return done([{ kind: 'text', body: digits ? await render(ctx, 'order_not_found', input.name) : await render(ctx, 'order_prompt', input.name) }], 'await_order', { tries });
  }

  if (state.step === null) return done(await menu(ctx, input.name));
  return done(await menu(ctx, input.name, 'Não entendi. Escolha uma das opções:'));
}

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

async function handleOne(provider: WhatsAppProvider, settings: BotSettings, m: InboundRow, now: Date) {
  const claim = async (outcome: string) => ((await pool.query('INSERT INTO bot_runs (inbound_id, outcome) VALUES ($1, $2) ON CONFLICT DO NOTHING', [m.id, outcome])).rowCount ?? 0) > 0;
  if (now.getTime() - m.sent_at.getTime() > STALE_MS) return claim('stale');
  if ((await pool.query('SELECT 1 FROM whatsapp_optouts WHERE phone_hash = $1', [phoneHash(m.from_phone)])).rows[0]) return claim('opted_out');
  if (settings.audience === 'test' && !settings.test_phones.some((p) => samePhone(p, m.from_phone))) return claim('not_audience');

  const conv = (await pool.query<ConvRow>('SELECT state, step, context, updated_at FROM whatsapp_conversations WHERE phone = $1', [m.from_phone])).rows[0];
  if (conv?.state === 'agent' && now.getTime() - conv.updated_at.getTime() < AGENT_IDLE_MS) return claim('agent');
  if (!(await claim('replied'))) return false;

  const state: BotState = conv?.state === 'bot' ? { step: conv.step, context: conv.context } : { step: null, context: {} };
  const out = await menuBot({ db: pool, phone: m.from_phone, settings, now }, state, { text: m.body, replyId: m.reply_id, type: m.type, name: m.profile_name });
  for (const r of out.replies) await sendReply(provider, m.from_phone, r);
  await pool.query(
    `INSERT INTO whatsapp_conversations (phone, state, step, context, agent_since, updated_at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (phone) DO UPDATE SET state = EXCLUDED.state, step = EXCLUDED.step, context = EXCLUDED.context,
       agent_since = EXCLUDED.agent_since, assigned_to = CASE WHEN EXCLUDED.state = 'agent' THEN whatsapp_conversations.assigned_to END, updated_at = now()`,
    [m.from_phone, out.handoff ? 'agent' : 'bot', out.state.step, JSON.stringify(out.state.context), out.handoff ? now : null],
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
});

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
      settings: { audience: s.audience, mode: s.mode, testPhones: s.test_phones, hours: s.hours, texts: s.texts },
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
      await db.query(`UPDATE bot_settings SET audience = $1, test_phones = $2, hours = $3, texts = $4, updated_by = $5, updated_at = now()`, [
        b.audience,
        b.testPhones,
        JSON.stringify(b.hours),
        JSON.stringify(texts),
        auth.userId,
      ]);
      await audit(db, {
        actorId: auth.userId,
        action: 'whatsapp.bot_settings',
        entity: 'bot_settings',
        before: { audience: before.audience, testPhones: before.test_phones.length, hours: before.hours, texts: Object.keys(before.texts) },
        after: { audience: b.audience, testPhones: b.testPhones.length, hours: b.hours, texts: Object.keys(texts) },
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
    const s = (await pool.query<{ phone: string | null; step: string | null; context: Record<string, unknown> }>('SELECT phone, step, context FROM bot_test_sessions WHERE user_id = $1', [auth.userId])).rows[0];
    const phone = b.phone === undefined ? (s?.phone ?? null) : b.phone;
    const out = await menuBot(
      { db: pool, phone, settings, now: new Date() },
      { step: s?.step ?? null, context: s?.context ?? {} },
      { text: b.text ?? null, replyId: b.replyId ?? null, type: b.replyId ? 'interactive' : 'text', name: null },
    );
    await pool.query(
      `INSERT INTO bot_test_sessions (user_id, phone, step, context, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id) DO UPDATE SET phone = EXCLUDED.phone, step = EXCLUDED.step, context = EXCLUDED.context, updated_at = now()`,
      [auth.userId, phone, out.handoff ? null : out.state.step, JSON.stringify(out.handoff ? {} : out.state.context)],
    );
    return { replies: out.replies, handoff: out.handoff, phone };
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
