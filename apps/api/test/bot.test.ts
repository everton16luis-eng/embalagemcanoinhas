/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FakeProvider } from '../src/lib/payments.js';
import { CloudApiProvider, FakeWhatsApp, interactivePayload, type Fetcher } from '../src/lib/whatsapp.js';
import { botTick, hoursText, isOpen, samePhone } from '../src/modules/bot.js';
import { appRole, loggedAs, makeApp, ORIGIN, owner, productPayload, randomIp, resetCatalog, uid } from './helpers.js';

let app: FastifyInstance;
let boss: Awaited<ReturnType<typeof loggedAs>>;
const wa = new FakeWhatsApp();
let pickupId: string;

// Telefone do pedido: (47) 99999-0000 -> 5547999990000. O WhatsApp as vezes manda sem o 9.
const OWNER_PHONE = '554799990000';
const OTHER_PHONE = '5547988887777';

const signed = (body: unknown) => {
  const raw = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', FakeWhatsApp.SECRET).update(raw).digest('hex')}` },
    payload: raw,
  });
};
const wrap = (from: string, message: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '1' }, contacts: [{ wa_id: from, profile: { name: 'Maria Confeiteira' } }], messages: [{ from, ...message }] } }] }],
});
const now = () => String(Math.floor(Date.now() / 1000));
const say = (from: string, text: string, id = `wamid.${uid()}`, ts = now()) => wrap(from, { id, timestamp: ts, type: 'text', text: { body: text } });
const tap = (from: string, kind: 'button_reply' | 'list_reply', replyId: string, title: string) =>
  wrap(from, { id: `wamid.${uid()}`, timestamp: now(), type: 'interactive', interactive: { type: kind, [kind]: { id: replyId, title } } });

/** Manda a mensagem e espera o bot terminar de responder. */
async function send(body: unknown) {
  expect((await signed(body)).statusCode).toBe(200);
  await botTick(wa);
}
const botMessages = async (phone: string) =>
  (await owner.query(`SELECT kind, body, payload, status FROM whatsapp_messages WHERE source = 'bot' AND to_phone = $1 ORDER BY created_at, id`, [phone])).rows;
const lastBot = async (phone: string) => (await botMessages(phone)).at(-1);

async function setBot(settings: Record<string, unknown>) {
  const r = await boss.put('/api/v1/admin/whatsapp/bot', { audience: 'all', testPhones: [], hours: {}, texts: {}, ...settings });
  expect(r.statusCode, r.body).toBe(200);
}

async function order() {
  const res0 = await boss.post(
    '/api/v1/admin/products',
    productPayload({ variants: [{ sku: `BOT-${uid()}`.toUpperCase(), packagings: [{ kind: 'sale', label: 'Pacote com 50', unitCode: 'PCT', baseQty: '50', priceCents: 1000, isDefault: true }] }] }),
  );
  expect(res0.statusCode, res0.body).toBe(201);
  const v = res0.json().product.variants[0];
  await boss.post('/api/v1/admin/stock/movements', { variantId: v.id, kind: 'adjustment', qty: '1000', reason: 'Saldo inicial', requestKey: `k-${uid()}-${uid()}` });
  const jar: Record<string, string> = {};
  const ip = randomIp();
  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, remoteAddress: ip, headers: { origin: ORIGIN }, cookies: { ...jar }, ...(payload === undefined ? {} : { payload: payload as object }) });
    for (const c of r.cookies) if (c.value) jar[c.name] = c.value;
    return r;
  };
  await call('POST', '/api/v1/public/cart/items', { packagingId: v.packagings[0].id, packs: 1 });
  const cart = (await call('GET', '/api/v1/public/cart')).json().cart;
  const buyer = { kind: 'pf', name: 'Maria Confeiteira', email: 'maria@teste.local', phone: '(47) 99999-0000', document: '529.982.247-25' };
  const res = await call('POST', '/api/v1/public/checkout', { requestKey: `bot-${uid()}`, buyer, shippingOptionId: pickupId, paymentMethod: 'pix', expectedTotalCents: cart.subtotalCents });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().order as { id: string; number: number };
}

beforeAll(async () => {
  app = await makeApp(undefined, new FakeProvider(), null, undefined, { whatsapp: wa });
  await resetCatalog();
  boss = await loggedAs(app, 'owner', { mfa: true });
  await owner.query(`UPDATE store_settings SET store_name = 'Loja Teste'`);
  pickupId = (await boss.post('/api/v1/admin/shipping-options', { name: 'Retirada na loja', kind: 'pickup', baseCents: 0, minDays: 0, maxDays: 1 })).json().option.id;
});
beforeEach(async () => {
  await owner.query('TRUNCATE bot_runs, bot_test_sessions, whatsapp_conversations, whatsapp_optouts, whatsapp_inbound, whatsapp_messages');
  await owner.query(`UPDATE bot_settings SET audience = 'off', test_phones = '{}', hours = '{}', texts = '{}'`);
});
afterAll(async () => {
  await owner.query(`UPDATE bot_settings SET audience = 'off', test_phones = '{}', hours = '{}', texts = '{}'`);
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

describe('peças do bot', () => {
  it('mensagem interativa respeita os limites da Meta', () => {
    const b = interactivePayload({ type: 'button', body: 'x', buttons: [{ id: 'a', title: 'Um título bem maior que vinte' }] }) as any;
    expect(b.action.buttons[0]).toEqual({ type: 'reply', reply: { id: 'a', title: 'Um título bem maior…' } });
    expect(b.action.buttons[0].reply.title.length).toBe(20);
    expect(() => interactivePayload({ type: 'button', body: 'x', buttons: [1, 2, 3, 4].map((n) => ({ id: `${n}`, title: `${n}` })) })).toThrow();
    const l = interactivePayload({ type: 'list', body: 'x', button: 'Ver opções', rows: [{ id: 'r', title: 'Linha', description: 'd'.repeat(100) }] }) as any;
    expect(l.action.sections[0].rows[0].description.length).toBe(72);
    expect(() => interactivePayload({ type: 'list', body: 'x', button: 'b', rows: [] })).toThrow();
  });

  it('horário de Brasília, dias agrupados e telefone com ou sem o 9', () => {
    const week = { open: '08:00', close: '18:00' };
    const hours = { '1': week, '2': week, '3': week, '4': week, '5': week, '6': { open: '08:00', close: '12:00' }, '0': null };
    expect(hoursText(hours)).toBe('Segunda a Sexta: 08:00 às 18:00\nSábado: 08:00 às 12:00\nDomingo: fechado');
    expect(isOpen(hours, new Date('2026-11-16T13:00:00Z'))).toBe(true); // segunda 10:00 em Brasília
    expect(isOpen(hours, new Date('2026-11-16T22:00:00Z'))).toBe(false); // segunda 19:00
    expect(isOpen(hours, new Date('2026-11-15T13:00:00Z'))).toBe(false); // domingo
    expect(isOpen({}, new Date())).toBe(true);
    expect(samePhone('5547999990000', '554799990000')).toBe(true);
    expect(samePhone('5547999990000', '5547999990001')).toBe(false);
    expect(samePhone(null, '5547999990000')).toBe(false);
  });

  it('Cloud API: corpo da mensagem interativa', async () => {
    const calls: { url: string; body: any }[] = [];
    const fetcher: Fetcher = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body!) });
      return { status: 200, text: async () => JSON.stringify({ messages: [{ id: 'wamid.I1' }] }) };
    };
    const p = new CloudApiProvider({ phoneNumberId: '123456', accessToken: 'x'.repeat(30), appSecret: 'y'.repeat(20), verifyToken: 'z'.repeat(20), version: 'v27.0' }, fetcher);
    expect(await p.sendInteractive('5547999990000', { type: 'button', body: 'Oi', buttons: [{ id: 'menu', title: 'Menu' }] })).toEqual({ wamid: 'wamid.I1' });
    expect(calls[0]!.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5547999990000',
      type: 'interactive',
      interactive: { type: 'button', body: { text: 'Oi' }, action: { buttons: [{ type: 'reply', reply: { id: 'menu', title: 'Menu' } }] } },
    });
  });
});

describe('bot de menu no WhatsApp', () => {
  it('desligado não responde, nem depois de ligado; em teste, só os números de teste', async () => {
    await send(say(OTHER_PHONE, 'oi'));
    expect(await botMessages(OTHER_PHONE)).toHaveLength(0);

    await setBot({ audience: 'test', testPhones: ['5547999990000'] });
    await botTick(wa);
    expect(await botMessages(OTHER_PHONE)).toHaveLength(0);
    await send(say(OTHER_PHONE, 'oi de novo'));
    expect(await botMessages(OTHER_PHONE)).toHaveLength(0);
    await send(say(OWNER_PHONE, 'oi')); // número de teste com o 9, mensagem sem o 9
    const m = await lastBot(OWNER_PHONE);
    expect(m.kind).toBe('interactive');
    expect(m.payload.type).toBe('list');
    expect(m.payload.body).toContain('Loja Teste');
    expect(m.payload.rows.map((r: any) => r.id)).toEqual(['pedido', 'orcamento', 'horario', 'atendente']);
  });

  it('consulta só o pedido do próprio telefone, sem revelar pedidos de outros', async () => {
    const o = await order();
    await setBot({});
    await send(tap(OWNER_PHONE, 'list_reply', 'pedido', 'Acompanhar pedido'));
    expect((await lastBot(OWNER_PHONE)).body).toBe('Digite o número do pedido.');
    await send(say(OWNER_PHONE, `é o ${o.number}`));
    const msgs = await botMessages(OWNER_PHONE);
    expect(msgs.at(-2).body).toBe(`Pedido #${o.number}: aguardando pagamento.\nEntrega: Retirada na loja.`);
    expect(msgs.at(-1).payload.buttons.map((b: any) => b.id)).toEqual(['menu', 'atendente']);

    // Outro número com o mesmo pedido: mesma resposta de pedido inexistente.
    await send(say(OTHER_PHONE, '1'));
    await send(say(OTHER_PHONE, '1')); // "1" no menu = Acompanhar pedido
    await send(say(OTHER_PHONE, String(o.number)));
    const other = await lastBot(OTHER_PHONE);
    expect(other.body).toBe('Não encontrei um pedido com esse número para este WhatsApp. Confira o número ou fale com um atendente.');
    await send(say(OTHER_PHONE, '999999'));
    expect((await lastBot(OTHER_PHONE)).body).toBe(other.body);
    expect(JSON.stringify(await botMessages(OTHER_PHONE))).not.toContain('aguardando pagamento');
  });

  it('atendente: o bot fica em silêncio até a conversa ser devolvida', async () => {
    await setBot({ hours: { '0': null, '1': null, '2': null, '3': null, '4': null, '5': null, '6': null } }); // sempre fechado
    await send(say(OTHER_PHONE, 'olá'));
    expect((await lastBot(OTHER_PHONE)).payload.body).toContain('fora do horário');
    await send(tap(OTHER_PHONE, 'list_reply', 'atendente', 'Falar com atendente'));
    expect((await lastBot(OTHER_PHONE)).body).toContain('Um atendente vai continuar a conversa por aqui.');
    expect((await owner.query('SELECT state FROM whatsapp_conversations WHERE phone = $1', [OTHER_PHONE])).rows[0].state).toBe('agent');
    const before = (await botMessages(OTHER_PHONE)).length;
    await send(say(OTHER_PHONE, 'alguém aí?'));
    expect(await botMessages(OTHER_PHONE)).toHaveLength(before);
    const list = (await boss.get('/api/v1/admin/whatsapp/conversations')).json().conversations;
    expect(list.find((c: any) => c.phone === OTHER_PHONE).state).toBe('agent');

    expect((await boss.post('/api/v1/admin/whatsapp/conversations/release', { phone: OTHER_PHONE })).statusCode).toBe(200);
    await send(say(OTHER_PHONE, 'oi'));
    expect((await lastBot(OTHER_PHONE)).payload.type).toBe('list');
  });

  it('resposta do atendente assume a conversa', async () => {
    await setBot({});
    await send(say(OTHER_PHONE, 'oi'));
    expect((await boss.post('/api/v1/admin/whatsapp/conversations/reply', { phone: OTHER_PHONE, text: 'Olá, sou a Ana!' })).statusCode).toBe(200);
    const before = (await botMessages(OTHER_PHONE)).length;
    await send(say(OTHER_PHONE, 'Oi Ana'));
    expect(await botMessages(OTHER_PHONE)).toHaveLength(before);
    const view = (await boss.post('/api/v1/admin/whatsapp/conversations/view', { phone: OTHER_PHONE })).json();
    expect(view.state).toBe('agent');
    expect(view.messages.filter((m: any) => m.source === 'agent')).toHaveLength(1);
  });

  it('não responde duas vezes, nem a quem pediu SAIR, nem mensagem antiga', async () => {
    await setBot({});
    const dup = say(OTHER_PHONE, 'oi', 'wamid.DUP1');
    await send(dup);
    await send(dup);
    expect(await botMessages(OTHER_PHONE)).toHaveLength(1);

    await send(say(OTHER_PHONE, 'sair'));
    await send(say(OTHER_PHONE, 'menu'));
    expect(await botMessages(OTHER_PHONE)).toHaveLength(1);

    const old = '5547977776666';
    await send(say(old, 'oi', `wamid.${uid()}`, String(Math.floor(Date.now() / 1000) - 3 * 3600)));
    expect(await botMessages(old)).toHaveLength(0);
    const outcomes = (await owner.query('SELECT outcome, count(*)::int AS n FROM bot_runs GROUP BY outcome')).rows;
    expect(outcomes).toEqual(expect.arrayContaining([{ outcome: 'opted_out', n: 2 }, { outcome: 'replied', n: 1 }]));
  });

  it('texto alterado no painel substitui o padrão; não entendeu volta ao menu', async () => {
    await setBot({ texts: { greeting: 'Bem-vindo à {loja}, {nome}!' } });
    await send(say(OTHER_PHONE, 'oi'));
    expect((await lastBot(OTHER_PHONE)).payload.body).toBe('Bem-vindo à Loja Teste, Maria!');
    await send(say(OTHER_PHONE, 'qual o preço do copo?'));
    expect((await lastBot(OTHER_PHONE)).payload.body).toMatch(/^Não entendi\. Escolha uma das opções:/);
    await send(say(OTHER_PHONE, '3'));
    // Endereço vem do cadastro da empresa (outros testes podem ter cadastrado); sem cadastro, oferece o atendente.
    const info = await lastBot(OTHER_PHONE);
    expect(info.payload.type).toBe('button');
    expect(info.payload.body).toMatch(/^Endereço:|^Um atendente pode passar o horário e o endereço para você\.$/);
  });
});

describe('painel do bot', () => {
  it('configuração exige bot.manage com verificação em duas etapas e valida o horário', async () => {
    const manager = await loggedAs(app, 'manager', { mfa: true });
    expect((await manager.get('/api/v1/admin/whatsapp/bot')).statusCode).toBe(200);
    expect((await manager.put('/api/v1/admin/whatsapp/bot', { audience: 'all', testPhones: [], hours: {}, texts: {} })).statusCode).toBe(403);
    const r = await boss.put('/api/v1/admin/whatsapp/bot', { audience: 'all', testPhones: [], hours: { '1': { open: '18:00', close: '08:00' } }, texts: {} });
    expect(r.statusCode).toBe(400);
    expect((await boss.put('/api/v1/admin/whatsapp/bot', { audience: 'test', testPhones: ['47999990000'], hours: {}, texts: {} })).statusCode).toBe(400);
    await setBot({ texts: { quote: '  ' } }); // vazio volta ao padrão
    expect((await boss.get('/api/v1/admin/whatsapp/bot')).json().settings.texts).toEqual({});
    const logs = (await owner.query(`SELECT after FROM audit_logs WHERE action = 'whatsapp.bot_settings' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(logs.after.audience).toBe('all');
  });

  it('chat de teste roda o bot sem enviar nada pelo WhatsApp', async () => {
    const o = await order();
    const sentBefore = wa.sent.length;
    const botBefore = (await owner.query(`SELECT count(*)::int AS n FROM whatsapp_messages WHERE source = 'bot'`)).rows[0].n;
    let r = (await boss.post('/api/v1/admin/whatsapp/bot/test', { text: 'oi' })).json();
    expect(r.replies[0].i.type).toBe('list');
    r = (await boss.post('/api/v1/admin/whatsapp/bot/test', { replyId: 'pedido' })).json();
    expect(r.replies[0].body).toBe('Digite o número do pedido.');
    r = (await boss.post('/api/v1/admin/whatsapp/bot/test', { text: String(o.number) })).json();
    expect(r.replies[0].body).toContain('Não encontrei'); // sem telefone simulado
    r = (await boss.post('/api/v1/admin/whatsapp/bot/test', { text: String(o.number), phone: '5547999990000' })).json();
    expect(r.replies[0].body).toContain(`Pedido #${o.number}`);
    expect(r.phone).toBe('5547999990000');
    expect((await boss.del('/api/v1/admin/whatsapp/bot/test')).statusCode).toBe(200);
    expect(wa.sent.length).toBe(sentBefore);
    expect((await owner.query(`SELECT count(*)::int AS n FROM whatsapp_messages WHERE source = 'bot'`)).rows[0].n).toBe(botBefore);
  });
});
