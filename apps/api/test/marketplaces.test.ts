/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FakeMarketplace, MercadoLivreAdapter, ShopeeAdapter, type Fetcher, type MarketOrder } from '../src/lib/marketplaces.js';
import { marketplaceTick } from '../src/modules/marketplaces.js';
import { appRole, client, loggedAs, makeApp, owner, productPayload, resetCatalog, uid } from './helpers.js';

let app: FastifyInstance;
let boss: Awaited<ReturnType<typeof loggedAs>>;
const ml = new FakeMarketplace('mercadolivre', 'http://localhost/painel/marketplaces/retorno/mercadolivre');
const shopee = new FakeMarketplace('shopee', 'http://localhost/painel/marketplaces/retorno/shopee');
let mlAccount: string;
let shopeeAccount: string;

async function newProduct(stock: string, extra: Record<string, unknown> = {}) {
  const sku = `MKT-${uid()}`.toUpperCase();
  const res = await boss.post(
    '/api/v1/admin/products',
    productPayload({
      ...extra,
      variants: [
        {
          sku,
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
  if (stock !== '0') {
    const m = await boss.post('/api/v1/admin/stock/movements', { variantId: v.id, kind: 'adjustment', qty: stock, reason: 'Saldo inicial', requestKey: `k-${uid()}-${uid()}` });
    expect(m.statusCode, m.body).toBe(201);
  }
  const packs = v.packagings as { id: string; label: string }[];
  return { variantId: v.id as string, pack50: packs.find((k) => k.label === 'Pacote com 50')!.id, unit: packs.find((k) => k.label === 'Unidade')!.id };
}

async function connect(channel: 'mercadolivre' | 'shopee') {
  const r = await boss.post('/api/v1/admin/marketplaces/connect', { channel });
  expect(r.statusCode, r.body).toBe(200);
  const u = new URL(r.json().url);
  const body = { channel, code: u.searchParams.get('code'), state: u.searchParams.get('state'), shopId: u.searchParams.get('shop_id') ?? undefined };
  const c = await boss.post('/api/v1/admin/marketplaces/callback', body);
  expect(c.statusCode, c.body).toBe(200);
  return { account: c.json().account, body };
}

const sale = (id: string, items: MarketOrder['items'], status: MarketOrder['status'] = 'paid', rawStatus = status === 'paid' ? 'paid' : status): MarketOrder => ({
  externalId: id,
  status,
  rawStatus,
  totalCents: items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0),
  items,
});
const item = (itemId: string, quantity: number, unitPriceCents: number, variationId = '') => ({ itemId, variationId, sku: null, title: 'Copo 200 ml', quantity, unitPriceCents });
const notifyMl = (orderId: string) =>
  app.inject({ method: 'POST', url: '/api/v1/webhooks/marketplaces/mercadolivre', payload: { resource: `/orders/${orderId}`, user_id: 700001, topic: 'orders_v2', application_id: 1, attempts: 1 } });
const saleRow = async (externalId: string) => (await owner.query('SELECT * FROM marketplace_orders WHERE external_order_id = $1', [externalId])).rows[0];
const reserved = async (variantId: string) => Number((await owner.query(`SELECT coalesce(sum(qty), 0) AS q FROM stock_reservations WHERE variant_id = $1 AND status = 'active'`, [variantId])).rows[0].q);
const link = (accountId: string, externalItemId: string, packagingId: string, extra: Record<string, unknown> = {}) =>
  boss.post('/api/v1/admin/marketplaces/listings', { accountId, externalItemId, packagingId, ...extra });

beforeAll(async () => {
  app = await makeApp(undefined, null, null, { mercadolivre: ml, shopee });
  await resetCatalog();
  boss = await loggedAs(app, 'manager', { mfa: true });
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

describe('conexão da conta', () => {
  it('autoriza com state de uso único e guarda os tokens cifrados', async () => {
    const { account, body } = await connect('mercadolivre');
    mlAccount = account.id;
    expect(account).toMatchObject({ channel: 'mercadolivre', external_id: '700001', status: 'active' });
    expect(JSON.stringify(account)).not.toContain('fake-access');
    const row = (await owner.query('SELECT access_token_enc, refresh_token_enc FROM marketplace_accounts WHERE id = $1', [mlAccount])).rows[0];
    expect(row.access_token_enc).not.toContain('fake-access');
    expect(row.refresh_token_enc).not.toContain('fake-refresh');
    // O mesmo retorno de novo nao troca o codigo outra vez.
    expect((await boss.post('/api/v1/admin/marketplaces/callback', body)).json().error.code).toBe('INVALID_STATE');
    // State de outra pessoa nao serve.
    const other = await loggedAs(app, 'owner', { mfa: true });
    const start = new URL((await other.post('/api/v1/admin/marketplaces/connect', { channel: 'shopee' })).json().url);
    const r = await boss.post('/api/v1/admin/marketplaces/callback', { channel: 'shopee', code: start.searchParams.get('code'), state: start.searchParams.get('state'), shopId: '900001' });
    expect(r.json().error.code).toBe('INVALID_STATE');

    shopeeAccount = (await connect('shopee')).account.id;
    const list = (await boss.get('/api/v1/admin/marketplaces')).json();
    expect(list.accounts).toHaveLength(2);
    expect(JSON.stringify(list)).not.toMatch(/token_enc|fake-access|fake-refresh/);
    expect(list.channels.every((c: any) => c.configured && c.fake)).toBe(true);
  });

  it('só quem tem marketplaces.manage (com MFA) acessa', async () => {
    const seller = await loggedAs(app, 'sales');
    expect((await seller.get('/api/v1/admin/marketplaces')).statusCode).toBe(403);
    expect((await client(app).get('/api/v1/admin/marketplaces')).statusCode).toBe(401);
    const noMfa = await loggedAs(app, 'manager');
    expect((await noMfa.post('/api/v1/admin/marketplaces/connect', { channel: 'mercadolivre' })).statusCode).toBe(403);
  });

  it('renova o token antes de vencer e pede nova autorização quando a plataforma recusa', async () => {
    await owner.query(`UPDATE marketplace_accounts SET access_expires_at = now() - interval '1 minute' WHERE id = $1`, [mlAccount]);
    const before = ml.refreshes;
    await marketplaceTick(app.marketplaces);
    expect(ml.refreshes).toBe(before + 1);
    expect((await owner.query('SELECT access_expires_at > now() AS ok FROM marketplace_accounts WHERE id = $1', [mlAccount])).rows[0].ok).toBe(true);

    // Shopee recusa o refresh: conta fica aguardando nova autorizacao e sem tokens.
    await owner.query(`UPDATE marketplace_accounts SET access_expires_at = now() - interval '1 minute' WHERE id = $1`, [shopeeAccount]);
    shopee.failNext = 'auth';
    await marketplaceTick(app.marketplaces);
    const s = (await owner.query('SELECT status, access_token_enc, last_error FROM marketplace_accounts WHERE id = $1', [shopeeAccount])).rows[0];
    expect(s).toMatchObject({ status: 'reauth_required', access_token_enc: null });
    expect(s.last_error).toMatch(/Autorize/);
    // Conectar de novo reativa a mesma conta (mesmo shop_id).
    const again = await connect('shopee');
    expect(again.account).toMatchObject({ id: shopeeAccount, status: 'active' });
  });
});

describe('vendas', () => {
  it('importa venda paga como pedido pago com reserva, sem duplicar com aviso repetido', async () => {
    const p = await newProduct('1000');
    expect((await link(mlAccount, 'MLB1001', p.pack50)).statusCode).toBe(201);
    ml.orders.set('2000001', sale('2000001', [item('MLB1001', 3, 1250)]));
    for (let i = 0; i < 2; i++) expect((await notifyMl('2000001')).statusCode).toBe(200);
    await marketplaceTick(app.marketplaces);
    await notifyMl('2000001');
    await marketplaceTick(app.marketplaces);

    const row = await saleRow('2000001');
    expect(row).toMatchObject({ state: 'imported', external_status: 'paid' });
    const orders = (await owner.query(`SELECT * FROM orders WHERE request_key LIKE 'mkt:mercadolivre:%'`)).rows;
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ id: row.order_id, channel: 'mercadolivre', status: 'paid', payment_method: 'marketplace', total_cents: '3750', freight_cents: '0' });
    expect(orders[0].paid_at).toBeTruthy();
    expect(orders[0].buyer).toMatchObject({ marketplace: 'mercadolivre', marketplaceOrderId: '2000001' });
    expect(await reserved(p.variantId)).toBe(150);
    // Saldo enviado ao anuncio ja desconta a venda: (1000 - 150) / 50 = 17.
    expect(ml.pushes.filter((x) => x.itemId === 'MLB1001').at(-1)).toMatchObject({ qty: 17 });
    // Sem mudanca de saldo, a rotina nao reenvia.
    const n = ml.pushes.length;
    await marketplaceTick(app.marketplaces);
    expect(ml.pushes.length).toBe(n);
    // O pedido aparece no painel de pedidos com o canal.
    const view = (await boss.get(`/api/v1/admin/orders/${row.order_id}`)).json().order;
    expect(view.items[0]).toMatchObject({ packs: 3, unit_price_cents: '1250' });
    expect(view.events.at(-1).note).toMatch(/Venda importada do Mercado Livre/);
  });

  it('venda com anúncio sem vínculo fica com erro e entra quando o anúncio é vinculado', async () => {
    const p = await newProduct('500');
    ml.orders.set('2000002', sale('2000002', [item('MLB2002', 2, 1100)]));
    await notifyMl('2000002');
    await marketplaceTick(app.marketplaces);
    let row = await saleRow('2000002');
    expect(row.state).toBe('error');
    expect(row.last_error).toMatch(/MLB2002.*sem vínculo/);
    expect(row.order_id).toBeNull();
    expect((await link(mlAccount, 'MLB2002', p.pack50)).statusCode).toBe(201);
    await marketplaceTick(app.marketplaces);
    row = await saleRow('2000002');
    expect(row.state).toBe('imported');
    expect(await reserved(p.variantId)).toBe(100);
  });

  it('sem estoque suficiente não importa e explica o motivo', async () => {
    const p = await newProduct('60');
    await link(mlAccount, 'MLB3003', p.pack50);
    ml.orders.set('2000003', sale('2000003', [item('MLB3003', 2, 1000)]));
    await notifyMl('2000003');
    await marketplaceTick(app.marketplaces);
    const row = await saleRow('2000003');
    expect(row.state).toBe('error');
    expect(row.last_error).toMatch(/Estoque insuficiente/);
    expect(await reserved(p.variantId)).toBe(0);
  });

  it('espera o pagamento e cancela o pedido quando a venda é cancelada lá', async () => {
    const p = await newProduct('1000');
    await link(mlAccount, 'MLB4004', p.pack50);
    ml.orders.set('2000004', sale('2000004', [item('MLB4004', 1, 1000)], 'pending', 'payment_required'));
    await notifyMl('2000004');
    await marketplaceTick(app.marketplaces);
    expect(await saleRow('2000004')).toMatchObject({ state: 'waiting', order_id: null });

    ml.orders.set('2000004', sale('2000004', [item('MLB4004', 1, 1000)]));
    await notifyMl('2000004');
    await marketplaceTick(app.marketplaces);
    const imported = await saleRow('2000004');
    expect(imported.state).toBe('imported');
    expect(await reserved(p.variantId)).toBe(50);

    ml.orders.set('2000004', sale('2000004', [item('MLB4004', 1, 1000)], 'canceled', 'cancelled'));
    await notifyMl('2000004');
    await marketplaceTick(app.marketplaces);
    expect((await saleRow('2000004')).state).toBe('canceled');
    const o = (await owner.query('SELECT status, cancel_reason FROM orders WHERE id = $1', [imported.order_id])).rows[0];
    expect(o).toMatchObject({ status: 'canceled', cancel_reason: 'Venda cancelada no Mercado Livre' });
    expect(await reserved(p.variantId)).toBe(0);
    // Aviso depois do cancelamento nao reabre nada.
    await notifyMl('2000004');
    await marketplaceTick(app.marketplaces);
    expect((await saleRow('2000004')).state).toBe('canceled');
  });

  it('busca manual pelo número e erro de comunicação ficam registrados', async () => {
    const p = await newProduct('1000');
    await link(shopeeAccount, '55501', p.unit);
    shopee.orders.set('241113ABCDEF', sale('241113ABCDEF', [item('55501', 4, 30)], 'paid', 'READY_TO_SHIP'));
    shopee.failNext = 'error';
    let r = await boss.post('/api/v1/admin/marketplaces/orders', { accountId: shopeeAccount, externalOrderId: '241113ABCDEF' });
    expect(r.json()).toMatchObject({ state: 'error' });
    expect(r.json().order.last_error).toMatch(/fora do ar/);
    r = await boss.post(`/api/v1/admin/marketplaces/orders/${r.json().id}/retry`);
    expect(r.json().state).toBe('imported');
    const o = (await owner.query('SELECT channel, total_cents FROM orders WHERE id = $1', [r.json().order.order_id])).rows[0];
    expect(o).toMatchObject({ channel: 'shopee', total_cents: '120' });
    const list = (await boss.get('/api/v1/admin/marketplaces/orders?state=imported')).json().orders;
    expect(list.some((x: any) => x.external_order_id === '241113ABCDEF' && x.order_number)).toBe(true);
  });

  it('pedido de marketplace não entra na emissão automática da loja', async () => {
    const { rows } = await owner.query(`SELECT count(*)::int AS n FROM orders WHERE channel IN ('mercadolivre', 'shopee') AND invoice_status = 'pending'`);
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('o papel da aplicação não apaga vendas nem avisos', async () => {
    await expect(appRole.query('DELETE FROM marketplace_orders')).rejects.toThrow();
    await expect(appRole.query('DELETE FROM marketplace_notifications')).rejects.toThrow();
    await expect(appRole.query('DELETE FROM marketplace_accounts')).rejects.toThrow();
  });
});

describe('anúncios', () => {
  it('anúncio do ML com variação fica sem envio automático de saldo', async () => {
    const p = await newProduct('100');
    const r = await link(mlAccount, 'MLB5005', p.pack50, { externalVariationId: '17400001', syncStock: true });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().syncStock).toBe(false);
    expect((await link(mlAccount, 'MLB5005', p.pack50, { externalVariationId: '17400001' })).json().error.code).toBe('LISTING_EXISTS');
    const patch = await boss.patch(`/api/v1/admin/marketplaces/listings/${r.json().id}`, { syncStock: true });
    expect(patch.json().error.code).toBe('SYNC_NOT_SUPPORTED');
    // Shopee aceita modelo (variacao).
    const s = await link(shopeeAccount, '66601', p.unit, { externalVariationId: '9001' });
    expect(s.json().syncStock).toBe(true);
    await boss.post('/api/v1/admin/marketplaces/push-stock', {});
    expect(shopee.pushes.find((x) => x.itemId === '66601')).toMatchObject({ variationId: '9001', qty: 100 });
  });

  it('só embalagem de venda ativa pode ser vinculada', async () => {
    const r = await link(mlAccount, 'MLB6006', '00000000-0000-4000-8000-000000000000');
    expect(r.json().error.code).toBe('PACKAGING_INVALID');
  });
});

describe('avisos', () => {
  it('aviso do ML de outra conta ou de outro tópico só fica registrado', async () => {
    const before = (await owner.query('SELECT count(*)::int AS n FROM marketplace_orders')).rows[0].n;
    await app.inject({ method: 'POST', url: '/api/v1/webhooks/marketplaces/mercadolivre', payload: { resource: '/orders/999', user_id: 123, topic: 'orders_v2' } });
    await app.inject({ method: 'POST', url: '/api/v1/webhooks/marketplaces/mercadolivre', payload: { resource: '/items/MLB1', user_id: 700001, topic: 'items' } });
    await app.inject({ method: 'POST', url: '/api/v1/webhooks/marketplaces/mercadolivre', payload: 'nao e json', headers: { 'content-type': 'text/plain' } });
    expect((await owner.query('SELECT count(*)::int AS n FROM marketplace_orders')).rows[0].n).toBe(before);
    const notes = (await boss.get('/api/v1/admin/marketplaces/notifications')).json().notifications;
    expect(notes.length).toBeGreaterThanOrEqual(3);
  });

  it('push da Shopee sem assinatura válida é recusado', async () => {
    const real = new ShopeeAdapter({ partnerId: '1000001', partnerKey: 'chave-de-teste-shopee-0123456789', redirectUri: 'https://x.test/r', apiHost: 'https://api.test', authHost: 'https://auth.test' });
    const strict = await makeApp(undefined, null, null, { mercadolivre: null, shopee: real });
    const r = await strict.inject({ method: 'POST', url: '/api/v1/webhooks/marketplaces/shopee', payload: { shop_id: 900001, code: 3, data: { ordersn: 'X1' } }, headers: { authorization: 'abc' } });
    expect(r.statusCode).toBe(401);
    expect((await owner.query(`SELECT verified FROM marketplace_notifications WHERE channel = 'shopee' ORDER BY id DESC LIMIT 1`)).rows[0].verified).toBe(false);
    await strict.close();
  });

  it('push da Shopee (simulado) agenda a consulta do pedido', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/webhooks/marketplaces/shopee', payload: { shop_id: 900001, code: 3, timestamp: 1, data: { ordersn: '241113ZZZ', status: 'READY_TO_SHIP' } } });
    expect(r.statusCode).toBe(204);
    expect(r.body).toBe('');
    expect((await saleRow('241113ZZZ')).state).toBe('pending');
  });
});

// ---------------- adaptadores reais com respostas gravadas (sem rede) ----------------

function recorder(responses: Record<string, unknown>) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, ...init });
    const key = Object.keys(responses).find((k) => url.includes(k));
    const body = key ? responses[key] : { error: 'not_found' };
    return { status: key ? 200 : 404, text: async () => JSON.stringify(body) };
  };
  return { calls, fetcher };
}

describe('adaptador Mercado Livre', () => {
  it('monta a autorização com PKCE e troca o código mandando o verificador', async () => {
    const { calls, fetcher } = recorder({ '/oauth/token': { access_token: 'APP_USR-a', refresh_token: 'TG-r', expires_in: 21600, user_id: 123456 } });
    const a = new MercadoLivreAdapter({ clientId: '1234', clientSecret: 'segredo-de-teste-123456', redirectUri: 'https://loja.test/painel/marketplaces/retorno/mercadolivre' }, fetcher);
    const url = new URL(a.authorizeUrl('estado', 'desafio'));
    expect(url.origin + url.pathname).toBe('https://auth.mercadolivre.com.br/authorization');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'code', client_id: '1234', state: 'estado', code_challenge: 'desafio', code_challenge_method: 'S256' });
    const t = await a.exchangeCode({ code: 'TG-code', codeVerifier: 'verificador' });
    expect(t).toMatchObject({ externalId: '123456', accessToken: 'APP_USR-a', refreshToken: 'TG-r' });
    expect(calls[0]!.url).toBe('https://api.mercadolibre.com/oauth/token');
    const form = new URLSearchParams(calls[0]!.body);
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: 'authorization_code', code: 'TG-code', code_verifier: 'verificador', client_id: '1234' });
  });

  it('lê o pedido e envia o saldo com PUT no anúncio', async () => {
    const { calls, fetcher } = recorder({
      '/orders/2000003': {
        id: 2000003,
        status: 'paid',
        total_amount: 37.5,
        order_items: [{ item: { id: 'MLB1', variation_id: null, seller_sku: 'CP-1', title: 'Copo' }, quantity: 3, unit_price: 12.5 }],
      },
      '/items/MLB1': { id: 'MLB1' },
    });
    const a = new MercadoLivreAdapter({ clientId: '1', clientSecret: 'segredo-de-teste-123456', redirectUri: 'https://x.test' }, fetcher);
    const o = await a.getOrder({ externalId: '1', accessToken: 'tok' }, '2000003');
    expect(o).toMatchObject({ status: 'paid', totalCents: 3750, items: [{ itemId: 'MLB1', variationId: '', sku: 'CP-1', quantity: 3, unitPriceCents: 1250 }] });
    expect(calls[0]!.headers.authorization).toBe('Bearer tok');
    await a.pushStock({ externalId: '1', accessToken: 'tok' }, { itemId: 'MLB1', variationId: '' }, 17);
    expect(calls[1]).toMatchObject({ method: 'PUT', url: 'https://api.mercadolibre.com/items/MLB1', body: JSON.stringify({ available_quantity: 17 }) });
    await expect(a.pushStock({ externalId: '1', accessToken: 'tok' }, { itemId: 'MLB1', variationId: '99' }, 1)).rejects.toThrow(/variacao/);
  });
});

describe('adaptador Shopee', () => {
  const key = 'chave-de-teste-shopee-0123456789';
  const now = () => 1_731_500_000_000;

  it('assina as chamadas da loja e lê o pedido', async () => {
    const { calls, fetcher } = recorder({
      '/api/v2/order/get_order_detail': {
        error: '',
        response: {
          order_list: [
            { order_sn: '241113ABC', order_status: 'READY_TO_SHIP', total_amount: 1.2, item_list: [{ item_id: 555, item_name: 'Copo', model_id: 0, model_sku: '', item_sku: 'CP', model_quantity_purchased: 4, model_discounted_price: 0.3 }] },
          ],
        },
      },
      '/api/v2/product/update_stock': { error: '', response: { failure_list: [], success_list: [{ model_id: 9001, stock: 3 }] } },
    });
    const a = new ShopeeAdapter({ partnerId: '1000001', partnerKey: key, redirectUri: 'https://x.test', apiHost: 'https://partner.shopeemobile.com', authHost: 'https://open.shopee.com.br' }, fetcher, now);
    const o = await a.getOrder({ externalId: '900001', accessToken: 'tokshop' }, '241113ABC');
    expect(o).toMatchObject({ status: 'paid', rawStatus: 'READY_TO_SHIP', totalCents: 120, items: [{ itemId: '555', variationId: '', sku: 'CP', quantity: 4, unitPriceCents: 30 }] });
    const u = new URL(calls[0]!.url);
    const ts = Math.floor(now() / 1000);
    const expected = createHmac('sha256', key).update(`1000001/api/v2/order/get_order_detail${ts}tokshop900001`).digest('hex');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ partner_id: '1000001', timestamp: String(ts), sign: expected, access_token: 'tokshop', shop_id: '900001', order_sn_list: '241113ABC' });
    await a.pushStock({ externalId: '900001', accessToken: 'tokshop' }, { itemId: '555', variationId: '9001' }, 3);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ item_id: 555, stock_list: [{ model_id: 9001, seller_stock: [{ stock: 3 }] }] });
  });

  it('troca o código com assinatura pública e confere o push', async () => {
    const { calls, fetcher } = recorder({ '/api/v2/auth/token/get': { error: '', access_token: 'acc', refresh_token: 'ref', expire_in: 14400 } });
    const a = new ShopeeAdapter({ partnerId: '1000001', partnerKey: key, redirectUri: 'https://x.test/r', apiHost: 'https://partner.shopeemobile.com', authHost: 'https://open.shopee.com.br' }, fetcher, now);
    expect(new URL(a.authorizeUrl('st')).searchParams.get('auth_type')).toBe('seller');
    const t = await a.exchangeCode({ code: 'abc', shopId: '900001' });
    expect(t).toMatchObject({ externalId: '900001', accessToken: 'acc', refreshToken: 'ref' });
    const ts = Math.floor(now() / 1000);
    expect(new URL(calls[0]!.url).searchParams.get('sign')).toBe(createHmac('sha256', key).update(`1000001/api/v2/auth/token/get${ts}`).digest('hex'));
    expect(JSON.parse(calls[0]!.body!)).toEqual({ code: 'abc', partner_id: 1000001, shop_id: 900001 });
    const raw = '{"shop_id":900001,"code":3,"data":{"ordersn":"X"}}';
    const sig = createHmac('sha256', key).update(`https://api.loja.test/hook|${raw}`).digest('hex');
    expect(a.verifyPush('https://api.loja.test/hook', raw, sig)).toBe(true);
    expect(a.verifyPush('https://api.loja.test/hook', `${raw} `, sig)).toBe(false);
    expect(a.verifyPush('https://api.loja.test/hook', raw, undefined)).toBe(false);
  });

  it('PKCE: desafio é o SHA-256 do verificador em base64url', async () => {
    const { pkce } = await import('../src/lib/marketplaces.js');
    const p = pkce();
    expect(p.challenge).toBe(createHash('sha256').update(p.verifier).digest('base64url'));
  });
});

describe('busca de embalagens para vincular', () => {
  it('acha embalagem de venda por SKU e trata curinga como texto', async () => {
    const p = await newProduct('100');
    const sku = (await owner.query('SELECT v.sku FROM product_variants v WHERE v.id = $1', [p.variantId])).rows[0].sku;
    const r = (await boss.get(`/api/v1/admin/marketplaces/packagings?q=${sku}`)).json().packagings;
    expect(r.map((x: any) => x.id).sort()).toEqual([p.pack50, p.unit].sort());
    expect(r.find((x: any) => x.id === p.pack50).packs_available).toBe(2);
    expect((await boss.get('/api/v1/admin/marketplaces/packagings?q=%25')).json().packagings).toEqual([]);
  });
});
