/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { AiUnavailable, FakeAi, GeminiProvider, type AiPart } from '../src/lib/gemini.js';
import { FakeProvider } from '../src/lib/payments.js';
import { FakeWhatsApp } from '../src/lib/whatsapp.js';
import { searchWords, tidy } from '../src/modules/bot-ai.js';
import { botTick } from '../src/modules/bot.js';
import { appRole, loggedAs, makeApp, ORIGIN, owner, productPayload, randomIp, resetCatalog, uid } from './helpers.js';

/** Etapa 2 do bot: IA (Gemini) com o simulador. Nenhum teste chama a API real. */

let app: FastifyInstance;
let boss: Awaited<ReturnType<typeof loggedAs>>;
const wa = new FakeWhatsApp();
const ai = new FakeAi();
let pickupId: string;
let product: { name: string; slug: string };

const OWNER_PHONE = '5547999990000';
const OTHER_PHONE = '5547988887777';
const CPF = '52998224725';

const signed = (body: unknown) => {
  const raw = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', FakeWhatsApp.SECRET).update(raw).digest('hex')}` },
    payload: raw,
  });
};
const say = (from: string, text: string) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: '1' },
            contacts: [{ wa_id: from, profile: { name: 'Maria' } }],
            messages: [{ from, id: `wamid.${uid()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
          },
        },
      ],
    },
  ],
});
async function send(from: string, text: string) {
  expect((await signed(say(from, text))).statusCode).toBe(200);
  await botTick(wa);
}
const lastBot = async (phone: string) =>
  (await owner.query(`SELECT kind, body FROM whatsapp_messages WHERE source = 'bot' AND to_phone = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [phone])).rows[0];
async function setBot(settings: Record<string, unknown>) {
  const r = await boss.put('/api/v1/admin/whatsapp/bot', { audience: 'all', testPhones: [], hours: {}, texts: {}, ...settings });
  expect(r.statusCode, r.body).toBe(200);
}
const call = (name: string, args: Record<string, unknown>) => ({ parts: [{ functionCall: { name, args }, thoughtSignature: `sig-${name}` }] as AiPart[], inputTokens: 1000, outputTokens: 50 });
const say_ = (text: string) => ({ parts: [{ text }] as AiPart[], inputTokens: 1200, outputTokens: 40 });
/** Todo o texto mandado ao Google em todas as chamadas. */
const sentToAi = () => JSON.stringify(ai.requests);

async function order() {
  const res0 = await boss.post(
    '/api/v1/admin/products',
    productPayload({ variants: [{ sku: `IA-${uid()}`.toUpperCase(), packagings: [{ kind: 'sale', label: 'Pacote com 50', unitCode: 'PCT', baseQty: '50', priceCents: 1000, isDefault: true }] }] }),
  );
  expect(res0.statusCode, res0.body).toBe(201);
  const v = res0.json().product.variants[0];
  await boss.post('/api/v1/admin/stock/movements', { variantId: v.id, kind: 'adjustment', qty: '1000', reason: 'Saldo inicial', requestKey: `k-${uid()}-${uid()}` });
  const jar: Record<string, string> = {};
  const ip = randomIp();
  const req = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, remoteAddress: ip, headers: { origin: ORIGIN }, cookies: { ...jar }, ...(payload === undefined ? {} : { payload: payload as object }) });
    for (const c of r.cookies) if (c.value) jar[c.name] = c.value;
    return r;
  };
  await req('POST', '/api/v1/public/cart/items', { packagingId: v.packagings[0].id, packs: 1 });
  const cart = (await req('GET', '/api/v1/public/cart')).json().cart;
  const buyer = { kind: 'pf', name: 'Maria Confeiteira', email: 'maria@teste.local', phone: '(47) 99999-0000', document: '529.982.247-25' };
  const res = await req('POST', '/api/v1/public/checkout', { requestKey: `ia-${uid()}`, buyer, shippingOptionId: pickupId, paymentMethod: 'pix', expectedTotalCents: cart.subtotalCents });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().order as { id: string; number: number };
}

beforeAll(async () => {
  app = await makeApp(undefined, new FakeProvider(), null, undefined, { whatsapp: wa, ai });
  await resetCatalog();
  boss = await loggedAs(app, 'owner', { mfa: true });
  await owner.query(`UPDATE store_settings SET store_name = 'Loja Teste'`);
  pickupId = (await boss.post('/api/v1/admin/shipping-options', { name: 'Retirada na loja', kind: 'pickup', baseCents: 0, minDays: 0, maxDays: 1 })).json().option.id;
  const p = await boss.post(
    '/api/v1/admin/products',
    productPayload({
      name: 'Forminha papel número 5 marrom',
      variants: [{ sku: `FM-${uid()}`.toUpperCase(), packagings: [{ kind: 'sale', label: 'Pacote com 100', unitCode: 'PCT', baseQty: '100', priceCents: 1290, isDefault: true }] }],
    }),
  );
  expect(p.statusCode, p.body).toBe(201);
  product = p.json().product;
});
beforeEach(async () => {
  await owner.query('TRUNCATE ai_calls, bot_security_events, bot_runs, bot_pending_documents, bot_verify_failures, bot_test_sessions, whatsapp_conversations, whatsapp_optouts, whatsapp_inbound, whatsapp_messages');
  await owner.query(`UPDATE bot_settings SET audience = 'off', mode = 'menu', ai_plan = 'free', ai_monthly_limit_usd = 10, ai_daily_per_phone = 20, test_phones = '{}', hours = '{}', texts = '{}'`);
  ai.requests = [];
  ai.script = [];
  ai.failNext = false;
});
afterAll(async () => {
  await owner.query(`UPDATE bot_settings SET audience = 'off', mode = 'menu', ai_plan = 'free', test_phones = '{}'`);
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

describe('adaptador do Gemini', () => {
  it('monta a chamada da documentação e soma o raciocínio na saída', async () => {
    const seen: any[] = [];
    const g = new GeminiProvider('chave-de-teste-com-vinte-caracteres', 'gemini-3.5-flash-lite', async (url, init) => {
      seen.push({ url, init });
      return {
        status: 200,
        text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Oi!' }] } }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 30, thoughtsTokenCount: 12 } }),
      };
    });
    const r = await g.generate({ system: 'regras', contents: [{ role: 'user', parts: [{ text: 'oi' }] }], functions: [{ name: 'f', description: 'd', parameters: { type: 'object', properties: {} } }], maxOutputTokens: 400 });
    expect(seen[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    expect(seen[0].init.headers['x-goog-api-key']).toBe('chave-de-teste-com-vinte-caracteres');
    const body = JSON.parse(seen[0].init.body);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'regras' }] });
    expect(body.tools[0].functionDeclarations[0].name).toBe('f');
    expect(body.generationConfig).toEqual({ maxOutputTokens: 400, candidateCount: 1, thinkingConfig: { thinkingLevel: 'minimal' } });
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    expect(body.safetySettings.map((s: any) => s.category)).toContain('HARM_CATEGORY_JAILBREAK');
    expect(r).toEqual({ parts: [{ text: 'Oi!' }], inputTokens: 900, outputTokens: 42, finishReason: null, blockReason: null });

    const bad = new GeminiProvider('chave-de-teste-com-vinte-caracteres', 'x-1', async () => ({ status: 400, text: async () => JSON.stringify({ error: { message: 'thought signature ausente' } }) }));
    await expect(bad.generate({ system: '', contents: [], functions: [], maxOutputTokens: 10 })).rejects.toBeInstanceOf(AiUnavailable);
  });

  it('histórico em turnos alternados, começando pelo cliente', () => {
    expect(
      tidy([
        { role: 'model', parts: [{ text: 'menu' }] },
        { role: 'user', parts: [{ text: 'a' }] },
        { role: 'user', parts: [{ text: 'b' }] },
        { role: 'model', parts: [{ text: 'c' }] },
      ]),
    ).toEqual([
      { role: 'user', parts: [{ text: 'a' }, { text: 'b' }] },
      { role: 'model', parts: [{ text: 'c' }] },
    ]);
  });
});

describe('IA no WhatsApp', () => {
  it('modo menu nunca chama a IA', async () => {
    await setBot({ testPhones: [OTHER_PHONE] });
    await send(OTHER_PHONE, 'vocês têm forminha?');
    expect(ai.requests).toHaveLength(0);
    expect((await lastBot(OTHER_PHONE)).kind).toBe('interactive');
  });

  it('plano gratuito: só os números de teste falam com a IA', async () => {
    await setBot({ mode: 'ai', testPhones: [OTHER_PHONE] });
    await send('5547911112222', 'vocês têm forminha?');
    expect(ai.requests).toHaveLength(0);
    expect((await lastBot('5547911112222')).kind).toBe('interactive');

    ai.script = [say_('Temos sim! Veja na loja.')];
    await send(OTHER_PHONE, 'vocês têm forminha?');
    expect((await lastBot(OTHER_PHONE)).body).toBe('Temos sim! Veja na loja.');
    const calls = (await owner.query('SELECT who_hash, model, input_tokens, output_tokens, cost_usd, ok FROM ai_calls')).rows;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: 'simulado', input_tokens: 1200, output_tokens: 40, ok: true });
    // 1200 x 0,30 + 40 x 2,50 por milhão
    expect(Number(calls[0].cost_usd)).toBeCloseTo(0.00046, 6);
    expect(calls[0].who_hash).not.toContain(OTHER_PHONE);

    // Plano pago: qualquer número.
    await setBot({ mode: 'ai', aiPlan: 'paid' });
    ai.script = [say_('Olá!')];
    await send('5547933334444', 'boa tarde, tudo bem?');
    expect((await lastBot('5547933334444')).body).toBe('Olá!');
  });

  it('busca de produto: só dados reais da loja, e a assinatura volta igual', async () => {
    await setBot({ mode: 'ai', testPhones: [OTHER_PHONE] });
    ai.script = [call('buscar_produtos', { termo: 'forminha número 5' })];
    await send(OTHER_PHONE, 'quanto custa a forminha número 5?');
    expect(ai.requests).toHaveLength(2);
    const second = ai.requests[1]!.contents;
    // Parte do modelo devolvida exatamente como veio (com a thoughtSignature).
    expect(second.at(-2)).toEqual({ role: 'model', parts: [{ functionCall: { name: 'buscar_produtos', args: { termo: 'forminha número 5' } }, thoughtSignature: 'sig-buscar_produtos' }] });
    const answer = (second.at(-1)!.parts[0] as any).functionResponse;
    expect(answer.name).toBe('buscar_produtos');
    expect(answer.response.produtos).toEqual([
      expect.objectContaining({ nome: product.name, link: `${ORIGIN}/p/${product.slug}`, embalagens: [{ embalagem: 'Pacote com 100', preco: 'R$ 12,90', precos_por_quantidade: [] }] }),
    ]);
    expect((await lastBot(OTHER_PHONE)).body).toContain('Resposta simulada com os dados');
  });

  it('busca pela necessidade: palavras soltas, plural, descrição, especificações e saldo real', async () => {
    expect(searchWords('Preciso de caixas para 100 bombons e papéis')).toEqual(['caixa', '100', 'bombom', 'papel']);
    expect(searchWords('Qual cabe 100?')).toEqual(['100']);
    const cat = (await boss.post('/api/v1/admin/categories', { name: `Caixas para doces ${uid()}` })).json().category;
    const mk = async (body: Record<string, unknown>) => {
      const r = await boss.post('/api/v1/admin/products', productPayload({ variants: [{ sku: `CX-${uid()}`.toUpperCase(), packagings: [{ kind: 'sale', label: 'Unidade', unitCode: 'UN', baseQty: '1', priceCents: 450, isDefault: true }] }], ...body }));
      expect(r.statusCode, r.body).toBe(201);
      return r.json().product;
    };
    const divisoria = await mk({
      name: `Caixa kraft com divisórias ${uid()}`,
      categoryId: cat.id,
      description: 'Ideal para brigadeiros e docinhos de festa.',
      specs: [
        { label: 'Medidas internas', value: '20 x 20 x 4 cm' },
        { label: 'Capacidade', value: '25 doces nº 4' },
      ],
    });
    await boss.post('/api/v1/admin/stock/movements', { variantId: divisoria.variants[0].id, kind: 'adjustment', qty: '10', reason: 'Saldo inicial', requestKey: `k-${uid()}-${uid()}` });
    await mk({ name: `Caixa para bolo 2 kg ${uid()}` });
    await setBot({ mode: 'ai', testPhones: [OTHER_PHONE] });
    ai.script = [call('buscar_produtos', { termo: 'caixa para 100 doces' })];
    await send(OTHER_PHONE, 'preciso entregar 100 doces de 15 g, qual caixa cabe?');
    const found = (ai.requests[1]!.contents.at(-1)!.parts[0] as any).functionResponse.response.produtos;
    // A que fala de doces (categoria, descricao, especificacao) vem antes da que so tem "caixa" no nome.
    expect(found[0]).toMatchObject({
      nome: divisoria.name,
      categoria: cat.name,
      especificacoes: ['Medidas internas: 20 x 20 x 4 cm', 'Capacidade: 25 doces nº 4'],
      disponibilidade: 'em estoque',
    });
    expect(found.find((x: any) => x.nome.startsWith('Caixa para bolo'))).toMatchObject({ disponibilidade: 'sem saldo no momento' });
  });

  it('pedido do próprio telefone: a IA recebe a situação; de outro telefone: o menu pede o CPF fora da IA', async () => {
    const o = await order();
    await setBot({ mode: 'ai', testPhones: [OWNER_PHONE, OTHER_PHONE] });
    await send(OWNER_PHONE, `como está o pedido ${o.number}?`);
    const resp = (ai.requests[1]!.contents.at(-1)!.parts[0] as any).functionResponse;
    expect(resp.response.pedido).toContain(`Pedido #${o.number}: aguardando pagamento.`);

    ai.requests = [];
    await send(OTHER_PHONE, `e o pedido ${o.number}?`);
    expect(ai.requests).toHaveLength(1); // so a chamada que pediu a funcao
    expect((await lastBot(OTHER_PHONE)).body).toContain('CPF ou CNPJ');
    await send(OTHER_PHONE, CPF);
    const all = (await owner.query(`SELECT body FROM whatsapp_messages WHERE source = 'bot' AND to_phone = $1`, [OTHER_PHONE])).rows.map((r) => r.body);
    expect(all.some((b) => b.startsWith(`Pedido #${o.number}`))).toBe(true);
    expect(ai.requests).toHaveLength(1);
    expect(sentToAi()).not.toContain(CPF);
    // O documento nunca fica no historico.
    expect((await owner.query('SELECT 1 FROM whatsapp_inbound WHERE body LIKE $1', [`%${CPF}%`])).rows).toHaveLength(0);
  });

  it('a IA passa para atendente e o bot para de responder', async () => {
    await setBot({ mode: 'ai', testPhones: [OTHER_PHONE] });
    ai.script = [call('transferir_atendente', { motivo: 'reclamação' })];
    await send(OTHER_PHONE, 'chegou tudo amassado');
    expect((await owner.query('SELECT state FROM whatsapp_conversations WHERE phone = $1', [OTHER_PHONE])).rows[0].state).toBe('agent');
    expect((await lastBot(OTHER_PHONE)).body).toContain('atendente');
    await send(OTHER_PHONE, 'oi?');
    expect(ai.requests).toHaveLength(1);
  });

  it('IA fora do ar: o menu responde e a falha fica registrada', async () => {
    await setBot({ mode: 'ai', testPhones: [OTHER_PHONE] });
    ai.failNext = true;
    await send(OTHER_PHONE, 'bom dia');
    expect((await lastBot(OTHER_PHONE)).kind).toBe('interactive');
    expect((await owner.query('SELECT ok, error FROM ai_calls')).rows).toEqual([{ ok: false, error: 'fora do ar (simulado)' }]);
  });

  it('limite do mês volta ao menu; limite diário passa para atendente', async () => {
    await setBot({ mode: 'ai', testPhones: [OTHER_PHONE], aiMonthlyLimitUsd: 0 });
    await send(OTHER_PHONE, 'bom dia');
    expect(ai.requests).toHaveLength(0);
    expect((await lastBot(OTHER_PHONE)).kind).toBe('interactive');

    await setBot({ mode: 'ai', testPhones: [OTHER_PHONE], aiMonthlyLimitUsd: 10, aiDailyPerPhone: 1 });
    ai.script = [say_('Bom dia!')];
    await send(OTHER_PHONE, 'tudo certo?');
    expect((await lastBot(OTHER_PHONE)).body).toBe('Bom dia!');
    await send(OTHER_PHONE, 'mais uma pergunta');
    expect(ai.requests).toHaveLength(1);
    expect((await owner.query('SELECT state FROM whatsapp_conversations WHERE phone = $1', [OTHER_PHONE])).rows[0].state).toBe('agent');
  });

  it('menu_ai: o menu abre a conversa e a IA entra no lugar do "Não entendi", com o histórico', async () => {
    await setBot({ mode: 'menu_ai', testPhones: [OTHER_PHONE] });
    await send(OTHER_PHONE, 'oi');
    expect(ai.requests).toHaveLength(0);
    ai.script = [say_('Trabalhamos com forminhas, sim.')];
    await send(OTHER_PHONE, 'vocês vendem forminha?');
    expect((await lastBot(OTHER_PHONE)).body).toBe('Trabalhamos com forminhas, sim.');
    const contents = ai.requests[0]!.contents;
    // Historico: o "oi" do cliente e o menu do bot, depois a pergunta atual.
    expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'oi' }] });
    expect(contents[1]!.role).toBe('model');
    expect(contents.at(-1)).toEqual({ role: 'user', parts: [{ text: 'vocês vendem forminha?' }] });
    expect(ai.requests[0]!.system).toContain('Nunca invente produto, preço');
  });
});

describe('painel', () => {
  it('configuração da IA: validação, auditoria e gasto do mês', async () => {
    expect((await boss.put('/api/v1/admin/whatsapp/bot', { audience: 'test', testPhones: [], hours: {}, texts: {}, mode: 'robo' })).statusCode).toBe(400);
    expect((await boss.put('/api/v1/admin/whatsapp/bot', { audience: 'test', testPhones: [], hours: {}, texts: {}, aiDailyPerPhone: 0 })).statusCode).toBe(400);
    await setBot({ audience: 'test', mode: 'menu_ai', aiPlan: 'paid', aiMonthlyLimitUsd: 5.5, aiDailyPerPhone: 30 });
    const a = (await owner.query(`SELECT before, after FROM audit_logs WHERE action = 'whatsapp.bot_settings' ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(a.before).toMatchObject({ mode: 'menu', aiPlan: 'free' });
    expect(a.after).toMatchObject({ mode: 'menu_ai', aiPlan: 'paid', aiMonthlyLimitUsd: 5.5, aiDailyPerPhone: 30 });

    await owner.query(`INSERT INTO ai_calls (who_hash, model, input_tokens, output_tokens, cost_usd, ok) VALUES ('x', 'simulado', 1000, 100, 0.00055, true)`);
    const g = (await boss.get('/api/v1/admin/whatsapp/bot')).json();
    expect(g.settings).toMatchObject({ mode: 'menu_ai', aiPlan: 'paid', aiMonthlyLimitUsd: 5.5, aiDailyPerPhone: 30 });
    expect(g.ai).toEqual({ configured: true, simulated: true, model: 'simulado', month: { usd: 0.00055, calls: 1, failed: 0 } });

    // Sem os campos da IA, ficam como estavam (painel antigo).
    await boss.put('/api/v1/admin/whatsapp/bot', { audience: 'test', testPhones: [], hours: {}, texts: {} });
    expect((await boss.get('/api/v1/admin/whatsapp/bot')).json().settings.mode).toBe('menu_ai');
  });

  it('chat de teste usa a IA e guarda o histórico da conversa', async () => {
    await setBot({ audience: 'off', mode: 'ai' });
    ai.script = [say_('Olá, posso ajudar!')];
    const r1 = (await boss.post('/api/v1/admin/whatsapp/bot/test', { text: 'boa tarde' })).json();
    expect(r1).toMatchObject({ ai: true, replies: [{ kind: 'text', body: 'Olá, posso ajudar!' }] });
    ai.script = [say_('Claro.')];
    await boss.post('/api/v1/admin/whatsapp/bot/test', { text: 'e amanhã?' });
    expect(ai.requests[1]!.contents).toEqual([
      { role: 'user', parts: [{ text: 'boa tarde' }] },
      { role: 'model', parts: [{ text: 'Olá, posso ajudar!' }] },
      { role: 'user', parts: [{ text: 'e amanhã?' }] },
    ]);
    // Recomecar apaga o historico.
    await boss.del('/api/v1/admin/whatsapp/bot/test');
    ai.script = [say_('Oi.')];
    await boss.post('/api/v1/admin/whatsapp/bot/test', { text: 'oi de novo' });
    expect(ai.requests[2]!.contents).toHaveLength(1);
  });
});
