/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { FakeCarrier, MelhorEnvioProvider, type Fetcher } from '../src/lib/carriers.js';
import { FakeProvider } from '../src/lib/payments.js';
import { CloudApiProvider, FakeWhatsApp, toWhatsAppNumber } from '../src/lib/whatsapp.js';
import { whatsappTick } from '../src/modules/whatsapp.js';
import { allocateOrder, appRole, shipOrder, loggedAs, makeApp, ORIGIN, owner, productPayload, randomIp, resetCatalog, uid } from './helpers.js';

let app: FastifyInstance;
let boss: Awaited<ReturnType<typeof loggedAs>>;
const wa = new FakeWhatsApp();
const carrier = new FakeCarrier();
let pickupId: string;
let carrierId: string;

function shopper() {
  const jar: Record<string, string> = {};
  const ip = randomIp();
  const send = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, remoteAddress: ip, headers: { origin: ORIGIN }, cookies: { ...jar }, ...(payload === undefined ? {} : { payload: payload as object }) });
    for (const c of res.cookies) {
      if (c.value) jar[c.name] = c.value;
      else delete jar[c.name];
    }
    return res;
  };
  return { get: (u: string) => send('GET', u), post: (u: string, b: unknown = {}) => send('POST', u, b) };
}

async function newProduct(stock: string, dims = true) {
  const sku = `F8-${uid()}`.toUpperCase();
  const res = await boss.post(
    '/api/v1/admin/products',
    productPayload({
      variants: [
        {
          sku,
          weightG: 4,
          ...(dims ? { lengthMm: 80, widthMm: 80, heightMm: 95 } : {}),
          packagings: [
            { kind: 'sale', label: 'Unidade', unitCode: 'UN', baseQty: '1', priceCents: 25 },
            { kind: 'sale', label: 'Pacote com 50', unitCode: 'PCT', baseQty: '50', priceCents: 1000, isDefault: true },
          ],
        },
      ],
    }),
  );
  expect(res.statusCode, res.body).toBe(201);
  const v = res.json().product.variants[0];
  await boss.post('/api/v1/admin/stock/movements', { variantId: v.id, kind: 'adjustment', qty: stock, reason: 'Saldo inicial', requestKey: `k-${uid()}-${uid()}` });
  return { variantId: v.id as string, pack50: (v.packagings as any[]).find((k) => k.label === 'Pacote com 50').id as string };
}

const buyer = { kind: 'pf', name: 'Maria Confeiteira', email: 'maria@teste.local', phone: '(47) 99999-0000', document: '529.982.247-25' };
const address = { recipient: 'Maria Confeiteira', cep: '01310-100', street: 'Avenida Paulista', number: '1000', district: 'Bela Vista', city: 'São Paulo', uf: 'SP' };

async function order(extra: Record<string, unknown> = {}, packs = 1) {
  const p = await newProduct('1000');
  const s = shopper();
  await s.post('/api/v1/public/cart/items', { packagingId: p.pack50, packs });
  const cart = (await s.get('/api/v1/public/cart')).json().cart;
  const res = await s.post('/api/v1/public/checkout', { requestKey: `p8-${uid()}`, buyer, shippingOptionId: pickupId, paymentMethod: 'pix', expectedTotalCents: cart.subtotalCents, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return { s, ...p, ...(res.json().order as { id: string; token: string; number: number }) };
}

async function pay(o: { s: ReturnType<typeof shopper>; token: string }) {
  expect((await o.s.post(`/api/v1/public/orders/${o.token}/pay/pix`)).statusCode).toBe(200);
  const r = await o.s.post(`/api/v1/public/dev-payments/${o.token}/approve-pix`);
  expect(r.statusCode, r.body).toBe(200);
}

const signed = (body: unknown) => {
  const raw = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', FakeWhatsApp.SECRET).update(raw).digest('hex')}` },
    payload: raw,
  });
};
const inbound = (from: string, id: string, text: string, ts = Math.floor(Date.now() / 1000)) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '1' }, contacts: [{ wa_id: from, profile: { name: 'Maria' } }], messages: [{ from, id, timestamp: String(ts), type: 'text', text: { body: text } }] } }] }],
});
const status = (id: string, s: string) => ({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { statuses: [{ id, status: s, timestamp: '1', recipient_id: '5547999990000', errors: [] }] } }] }] });

beforeAll(async () => {
  app = await makeApp(undefined, new FakeProvider(), null, undefined, { whatsapp: wa, carrier });
  await resetCatalog();
  boss = await loggedAs(app, 'manager', { mfa: true });
  await owner.query(`UPDATE store_settings SET store_name = 'Loja Teste'`);
  (config as any).SHIP_FROM_CEP = '89460000';
  pickupId = (await boss.post('/api/v1/admin/shipping-options', { name: 'Retirada na loja', kind: 'pickup', baseCents: 0, minDays: 0, maxDays: 1 })).json().option.id;
  const c = await boss.post('/api/v1/admin/shipping-options', { name: 'Transportadora econômica', kind: 'carrier', carrierService: '3', handlingDays: 1, baseCents: 200, minDays: 0, maxDays: 0 });
  expect(c.statusCode, c.body).toBe(201);
  carrierId = c.json().option.id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

describe('WhatsApp: avisos do pedido', () => {
  it('só com opt-in e modelo configurado; um aviso por evento; despacho leva o rastreio', async () => {
    // Sem modelo configurado: nada entra na fila.
    const o0 = await order({ whatsappOptin: true });
    await pay(o0);
    expect((await owner.query('SELECT count(*)::int AS n FROM whatsapp_messages')).rows[0].n).toBe(0);

    for (const [event, name] of [['order_paid', 'pedido_pago'], ['order_ready', 'pedido_pronto'], ['order_shipped', 'pedido_enviado']]) {
      const r = await boss.put(`/api/v1/admin/whatsapp/templates/${event}`, { name, language: 'pt_BR' });
      expect(r.statusCode, r.body).toBe(200);
    }
    // Sem opt-in: nada.
    const noOptin = await order();
    await pay(noOptin);
    expect((await owner.query('SELECT count(*)::int AS n FROM whatsapp_messages WHERE order_id = $1', [noOptin.id])).rows[0].n).toBe(0);

    const o = await order({ whatsappOptin: true });
    const row = (await owner.query('SELECT whatsapp_optin_at, whatsapp_optin_text FROM orders WHERE id = $1', [o.id])).rows[0];
    expect(row.whatsapp_optin_text).toBe('Quero receber atualizações deste pedido pelo WhatsApp da Loja Teste. Para parar as notificações, responda PARAR NOTIFICAÇÕES.');
    await pay(o);
    await whatsappTick(wa);
    expect(wa.sent.at(-1)).toMatchObject({ kind: 'template', to: '5547999990000', name: 'pedido_pago', language: 'pt_BR', params: { nome: 'Maria', pedido: String(o.number) } });

    // Separar -> pronto (retirada) -> despachar.
    await owner.query(`UPDATE orders SET invoice_status = 'not_required' WHERE id = $1`, [o.id]);
    let v = (await boss.get(`/api/v1/admin/orders/${o.id}`)).json().order.version;
    for (const to of ['preparing', 'ready']) {
      const r = await boss.post(`/api/v1/admin/orders/${o.id}/status`, { to, version: v });
      expect(r.statusCode, r.body).toBe(200);
      v = r.json().order.version;
    }
    await allocateOrder(boss, o.id);
    // SGLog Fase 5: pedido novo sai pela remessa (separar, conferir, embalar, despachar).
    await shipOrder(boss, o.id, { carrier: 'Correios', trackingCode: 'AB123456789BR' });
    // Retirada: entregar ao cliente nao manda "despachado" (o aviso foi o de pronto). O aviso de despacho por
    // remessa, com o rastreio, esta em sglog-fase5.test.ts.
    await whatsappTick(wa);
    const msgs = (await owner.query('SELECT event, status, params FROM whatsapp_messages WHERE order_id = $1 ORDER BY created_at', [o.id])).rows;
    expect(msgs.map((m) => m.event)).toEqual(['order_paid', 'order_ready']);
    expect(msgs.every((m) => m.status === 'sent')).toBe(true);
  });

  it('recusa definitiva marca falha; falha temporária tenta de novo', async () => {
    const o = await order({ whatsappOptin: true });
    wa.failNext = 'transient';
    await pay(o);
    await whatsappTick(wa);
    let m = (await owner.query('SELECT status, error, attempts FROM whatsapp_messages WHERE order_id = $1', [o.id])).rows[0];
    expect(m).toMatchObject({ status: 'queued', attempts: 1 });
    expect(m.error).toMatch(/fora do ar/);
    await owner.query(`UPDATE whatsapp_messages SET next_attempt_at = now() WHERE order_id = $1`, [o.id]);
    wa.failNext = 'reject';
    await whatsappTick(wa);
    m = (await owner.query('SELECT status, error FROM whatsapp_messages WHERE order_id = $1', [o.id])).rows[0];
    expect(m.status).toBe('failed');
  });
});

describe('WhatsApp: webhook e caixa de entrada', () => {
  it('verificação do webhook confere o token', async () => {
    const ok = await app.inject({ method: 'GET', url: `/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${FakeWhatsApp.VERIFY}&hub.challenge=12345` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('12345');
    expect((await app.inject({ method: 'GET', url: '/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1' })).statusCode).toBe(403);
  });

  it('assinatura inválida é recusada; mensagem repetida entra uma vez; situação só avança', async () => {
    const forged = await app.inject({ method: 'POST', url: '/api/v1/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' }, payload: JSON.stringify(inbound('5547988887777', 'wamid.X1', 'oi')) });
    expect(forged.statusCode).toBe(401);
    expect((await owner.query(`SELECT count(*)::int AS n FROM whatsapp_inbound WHERE wamid = 'wamid.X1'`)).rows[0].n).toBe(0);

    for (let i = 0; i < 2; i++) expect((await signed(inbound('5547988887777', 'wamid.X1', 'Tem copo de 300 ml?'))).statusCode).toBe(200);
    expect((await owner.query(`SELECT count(*)::int AS n FROM whatsapp_inbound WHERE wamid = 'wamid.X1'`)).rows[0].n).toBe(1);

    const sent = (await owner.query(`SELECT wamid FROM whatsapp_messages WHERE status = 'sent' AND wamid IS NOT NULL LIMIT 1`)).rows[0].wamid;
    await signed(status(sent, 'read'));
    await signed(status(sent, 'delivered')); // chega atrasado
    expect((await owner.query('SELECT status FROM whatsapp_messages WHERE wamid = $1', [sent])).rows[0].status).toBe('read');
  });

  it('SAIR encerra a conversa e o opt-out de notificações não impede atendimento', async () => {
    const phone = '5547977776666';
    let r = await boss.post('/api/v1/admin/whatsapp/conversations/reply', { phone, text: 'Olá' });
    expect(r.json().error.code).toBe('WINDOW_CLOSED');
    // Mensagem de 25 h atras nao abre a janela.
    await signed(inbound(phone, `wamid.${uid()}`, 'oi', Math.floor(Date.now() / 1000) - 25 * 3600));
    expect((await boss.post('/api/v1/admin/whatsapp/conversations/reply', { phone, text: 'Olá' })).json().error.code).toBe('WINDOW_CLOSED');
    await signed(inbound(phone, `wamid.${uid()}`, 'Bom dia, vocês têm forminha?'));
    r = await boss.post('/api/v1/admin/whatsapp/conversations/reply', { phone, text: 'Temos sim!' });
    expect(r.statusCode, r.body).toBe(200);
    expect(wa.sent.at(-1)).toMatchObject({ kind: 'text', to: phone, body: 'Temos sim!' });
    const conv = (await boss.post('/api/v1/admin/whatsapp/conversations/view', { phone })).json();
    expect(conv.windowOpenUntil).toBeTruthy();
    expect(conv.messages.map((m: any) => m.dir)).toEqual(['in', 'in', 'out']);
    expect((await boss.get('/api/v1/admin/whatsapp/conversations')).json().conversations.some((c: any) => c.phone === phone && c.window_open)).toBe(true);

    await signed(inbound(phone, `wamid.${uid()}`, 'Sair'));
    const closed = (await boss.post('/api/v1/admin/whatsapp/conversations/view', { phone })).json();
    expect(closed).toMatchObject({ state: 'closed', optedOut: false });
    await signed(inbound(phone, `wamid.${uid()}`, 'PARAR NOTIFICAÇÕES'));
    expect((await boss.post('/api/v1/admin/whatsapp/conversations/reply', { phone, text: 'Ok' })).statusCode).toBe(200);
    expect((await owner.query('SELECT count(*)::int AS n FROM whatsapp_optouts')).rows[0].n).toBe(1);
    // O numero nao fica em claro na lista de bloqueio.
    expect(JSON.stringify((await owner.query('SELECT * FROM whatsapp_optouts')).rows)).not.toContain(phone);
  });

  it('modelo só com settings.manage; caixa de entrada com sales_desk.use', async () => {
    const seller = await loggedAs(app, 'sales');
    expect((await seller.get('/api/v1/admin/whatsapp/conversations')).statusCode).toBe(200);
    expect((await seller.put('/api/v1/admin/whatsapp/templates/order_paid', { name: 'x' })).statusCode).toBe(403);
    const stock = await loggedAs(app, 'stock');
    expect((await stock.get('/api/v1/admin/whatsapp/conversations')).statusCode).toBe(403);
    expect((await boss.put('/api/v1/admin/whatsapp/templates/order_paid', { name: 'Nome Inválido' })).statusCode).toBe(400);
  });
});

describe('transportadora', () => {
  it('cota com CEP, guarda a cotação e o checkout cobra o preço visto', async () => {
    const p = await newProduct('1000');
    const s = shopper();
    await s.post('/api/v1/public/cart/items', { packagingId: p.pack50, packs: 2 });
    const before = carrier.calls;
    const q = (await s.get('/api/v1/public/shipping/quote?cep=01310100')).json();
    const opt = q.options.find((o: any) => o.id === carrierId);
    // 100 copos x 4 g = 0,4 kg -> 1500 + 300 + 250, mais 200 de manuseio; prazo 2 + 3 + 1 dia de separacao.
    expect(opt).toMatchObject({ kind: 'delivery', priceCents: 2250, minDays: 6, maxDays: 6, carrier: { service: '3', company: 'Transportadora simulada' } });
    await s.get('/api/v1/public/shipping/quote?cep=01310100');
    expect(carrier.calls).toBe(before + 1); // segunda consulta veio do cache

    const cart = (await s.get('/api/v1/public/cart')).json().cart;
    const r = await s.post('/api/v1/public/checkout', { requestKey: `p8-${uid()}`, buyer, shippingOptionId: carrierId, address, paymentMethod: 'pix', expectedTotalCents: cart.subtotalCents + 2250 });
    expect(r.statusCode, r.body).toBe(201);
    const o = (await owner.query('SELECT freight_cents, shipping_snapshot, ship_to FROM orders WHERE id = $1', [r.json().order.id])).rows[0];
    expect(o.freight_cents).toBe('2250');
    expect(o.shipping_snapshot.carrier).toMatchObject({ service: '3' });
    expect(o.ship_to).toMatchObject({ cep: '01310100' });
    expect(carrier.calls).toBe(before + 1);
  });

  it('sem medidas ou com o provedor fora do ar, só as formas próprias aparecem', async () => {
    const p = await newProduct('1000', false);
    const s = shopper();
    await s.post('/api/v1/public/cart/items', { packagingId: p.pack50, packs: 1 });
    expect((await s.get('/api/v1/public/shipping/quote?cep=01310100')).json().options.map((o: any) => o.id)).toEqual([pickupId]);
    const p2 = await newProduct('1000');
    const s2 = shopper();
    await s2.post('/api/v1/public/cart/items', { packagingId: p2.pack50, packs: 3 });
    carrier.down = true;
    expect((await s2.get('/api/v1/public/shipping/quote?cep=88010000')).json().options.map((o: any) => o.id)).toEqual([pickupId]);
    carrier.down = false;
  });

  it('cadastro: transportadora exige código do serviço', async () => {
    const r = await boss.post('/api/v1/admin/shipping-options', { name: 'Sem código', kind: 'carrier', baseCents: 0, minDays: 0, maxDays: 0 });
    expect(r.statusCode).toBe(400);
    const list = (await boss.get('/api/v1/admin/shipping-options')).json();
    expect(list.carrier).toMatchObject({ configured: true, fake: true });
  });
});

describe('relatórios de vendas', () => {
  it('resume por período, canal e forma de pagamento, com curva ABC e margem', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const s = (await boss.get(`/api/v1/admin/sales-reports/summary?from=${today}&to=${today}`)).json();
    const paid = (await owner.query(`SELECT count(*)::int AS n, sum(total_cents)::int AS t FROM orders WHERE status IN ('paid','preparing','ready','shipped','delivered')`)).rows[0];
    expect(s.totals).toMatchObject({ orders: paid.n, totalCents: paid.t });
    expect(s.series).toHaveLength(1);
    expect(s.byChannel[0]).toMatchObject({ key: 'store' });
    expect(s.byPaymentMethod[0]).toMatchObject({ key: 'pix' });
    const p = (await boss.get(`/api/v1/admin/sales-reports/products?from=${today}&to=${today}`)).json();
    expect(p.totals.revenueCents).toBe(p.products.reduce((a: number, x: any) => a + x.revenueCents, 0));
    expect(p.products[0].abc).toBe('A');
    expect(p.abc.reduce((a: number, c: any) => a + c.products, 0)).toBe(p.products.length);
    // Sem custo de compra lancado, a margem e marcada como estimativa incompleta.
    expect(p.totals.costMissing).toBe(true);
  });

  it('valida o período e a permissão', async () => {
    expect((await boss.get('/api/v1/admin/sales-reports/summary?from=2026-12-01&to=2026-01-01')).json().error.code).toBe('INVALID_PERIOD');
    expect((await boss.get('/api/v1/admin/sales-reports/summary?from=2020-01-01&to=2026-01-01')).json().error.code).toBe('INVALID_PERIOD');
    const seller = await loggedAs(app, 'sales');
    expect((await seller.get('/api/v1/admin/sales-reports/summary')).statusCode).toBe(403);
  });
});

describe('adaptadores reais com respostas gravadas', () => {
  it('Cloud API: corpo do modelo com parâmetros nomeados; assinatura com segredo do app', async () => {
    const calls: any[] = [];
    const fetcher: Fetcher = async (url, init) => {
      calls.push({ url, ...init });
      return { status: 200, text: async () => JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ wa_id: '5547999990000' }], messages: [{ id: 'wamid.ABC' }] }) };
    };
    const p = new CloudApiProvider({ phoneNumberId: '106540352242922', accessToken: 'token-de-teste-123456789', appSecret: 'segredo-do-app-teste', verifyToken: 'verificar-teste-123', version: 'v27.0' }, fetcher);
    expect(await p.sendTemplate({ to: '5547999990000', name: 'pedido_pago', language: 'pt_BR', params: { nome: 'Maria', pedido: '1001' } })).toEqual({ wamid: 'wamid.ABC' });
    expect(calls[0].url).toBe('https://graph.facebook.com/v27.0/106540352242922/messages');
    expect(calls[0].headers.authorization).toBe('Bearer token-de-teste-123456789');
    expect(JSON.parse(calls[0].body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5547999990000',
      type: 'template',
      template: {
        name: 'pedido_pago',
        language: { code: 'pt_BR' },
        components: [{ type: 'body', parameters: [{ type: 'text', parameter_name: 'nome', text: 'Maria' }, { type: 'text', parameter_name: 'pedido', text: '1001' }] }],
      },
    });
    const raw = '{"object":"whatsapp_business_account"}';
    expect(p.verifySignature(raw, `sha256=${createHmac('sha256', 'segredo-do-app-teste').update(raw).digest('hex')}`)).toBe(true);
    expect(p.verifySignature(`${raw} `, `sha256=${createHmac('sha256', 'segredo-do-app-teste').update(raw).digest('hex')}`)).toBe(false);
    expect(toWhatsAppNumber('(47) 99999-0000')).toBe('5547999990000');
    expect(toWhatsAppNumber('123')).toBeNull();
  });

  it('Melhor Envio: corpo da cotação, User-Agent obrigatório e preço da conta (custom_price)', async () => {
    const calls: any[] = [];
    const fetcher: Fetcher = async (url, init) => {
      calls.push({ url, ...init });
      return {
        status: 200,
        text: async () =>
          JSON.stringify([
            { id: 1, name: 'PAC', price: '25.00', custom_price: '23.40', delivery_time: 6, custom_delivery_time: 7, company: { name: 'Correios' } },
            { id: 2, name: 'SEDEX', error: 'Serviço indisponível para o trecho.' },
          ]),
      };
    };
    const me = new MelhorEnvioProvider({ token: 'token-de-teste-123456789', userAgent: 'Loja (tecnico@exemplo.test)', sandbox: true }, fetcher);
    const q = await me.quote({ fromCep: '89460000', toCep: '01310100', services: ['1', '2'], items: [{ id: 'v1', widthCm: 8, heightCm: 10, lengthCm: 8, weightKg: 0.004, insuranceCents: 20, quantity: 100 }] });
    expect(q).toEqual([{ service: '1', name: 'PAC', company: 'Correios', priceCents: 2340, days: 7 }]);
    expect(calls[0].url).toBe('https://sandbox.melhorenvio.com.br/api/v2/me/shipment/calculate');
    expect(calls[0].headers['user-agent']).toBe('Loja (tecnico@exemplo.test)');
    expect(JSON.parse(calls[0].body)).toEqual({
      from: { postal_code: '89460000' },
      to: { postal_code: '01310100' },
      products: [{ id: 'v1', width: 8, height: 10, length: 8, weight: 0.004, insurance_value: 0.2, quantity: 100 }],
      services: '1,2',
    });
  });
});
