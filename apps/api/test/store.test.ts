/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FakeProvider, MercadoPagoProvider } from '../src/lib/payments.js';
import { unitPrice } from '../src/lib/pricing.js';
import { expireOrders, mulQty } from '../src/modules/orders.js';
import { allocateOrder, appRole, shipOrder, loggedAs, makeApp, ORIGIN, owner, productPayload, randomIp, resetCatalog, uid } from './helpers.js';

let app: FastifyInstance;
let fake: FakeProvider;
let boss: Awaited<ReturnType<typeof loggedAs>>;
let pickupId: string;
let deliveryId: string;

beforeAll(async () => {
  fake = new FakeProvider();
  app = await makeApp(undefined, fake);
  await resetCatalog();
  // Faixa de preco e frete sao permissoes sensiveis: gerente com MFA.
  boss = await loggedAs(app, 'manager', { mfa: true });
  const p = await boss.post('/api/v1/admin/shipping-options', { name: 'Retirada na loja', kind: 'pickup', description: 'Centro, Canoinhas', baseCents: 0, minDays: 0, maxDays: 1 });
  expect(p.statusCode, p.body).toBe(201);
  pickupId = p.json().option.id;
  const d = await boss.post('/api/v1/admin/shipping-options', {
    name: 'Entrega Canoinhas',
    kind: 'delivery',
    cepRanges: ['89460-000-89479-999'],
    baseCents: 1500,
    perKgCents: 0,
    freeAboveCents: 50000,
    minDays: 1,
    maxDays: 2,
  });
  expect(d.statusCode, d.body).toBe(201);
  deliveryId = d.json().option.id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

/** Navegador do cliente: guarda os cookies da loja (carrinho e sessao). */
function shopper() {
  const jar: Record<string, string> = {};
  const ip = randomIp();
  const send = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method, url, remoteAddress: ip, headers: { origin: ORIGIN, ...headers }, cookies: { ...jar }, ...(payload === undefined ? {} : { payload: payload as object }) });
    for (const c of res.cookies) {
      if (c.value) jar[c.name] = c.value;
      else delete jar[c.name];
    }
    return res;
  };
  return { jar, send, get: (u: string) => send('GET', u), post: (u: string, b: unknown = {}) => send('POST', u, b), put: (u: string, b: unknown) => send('PUT', u, b), del: (u: string) => send('DELETE', u) };
}

type Pack = { id: string; kind: string; label: string; base_qty: string };
async function newProduct(overrides: Record<string, unknown> = {}, stock = '0') {
  const payload = productPayload(overrides) as ReturnType<typeof productPayload> & { variants: { packagings: Record<string, unknown>[] }[] };
  const res = await boss.post('/api/v1/admin/products', payload);
  expect(res.statusCode, res.body).toBe(201);
  const p = res.json().product;
  const v = p.variants[0];
  if (stock !== '0') {
    const m = await boss.post('/api/v1/admin/stock/movements', { variantId: v.id, kind: 'adjustment', qty: stock, reason: 'Saldo inicial', requestKey: `k-${uid()}-${uid()}` });
    expect(m.statusCode, m.body).toBe(201);
  }
  const packs = v.packagings as Pack[];
  return { product: p, variantId: v.id as string, unit: packs.find((k) => k.label === 'Unidade')!, pack50: packs.find((k) => k.label === 'Pacote com 50')! };
}
const withTiers = (tiers: { minPacks: number; priceCents: number }[]) => {
  const sku = `CP-${uid()}`.toUpperCase();
  return {
    variants: [
      {
        sku,
        weightG: 4,
        packagings: [
          { kind: 'sale', label: 'Unidade', unitCode: 'UN', baseQty: '1', priceCents: 25 },
          { kind: 'sale', label: 'Pacote com 50', unitCode: 'PCT', baseQty: '50', priceCents: 1000, isDefault: true, tiers },
        ],
      },
    ],
  };
};
const balance = async (variantId: string) => (await boss.get(`/api/v1/admin/stock/variants/${variantId}`)).json().variant;

const buyer = { kind: 'pf', name: 'Maria Confeiteira', email: 'maria@teste.local', phone: '47999990000', document: '529.982.247-25' };
async function checkout(s: ReturnType<typeof shopper>, extra: Record<string, unknown> = {}) {
  const cart = (await s.get('/api/v1/public/cart')).json().cart;
  const body = { requestKey: `pedido-${uid()}`, buyer, shippingOptionId: pickupId, paymentMethod: 'pix', expectedTotalCents: cart.subtotalCents, ...extra };
  return { res: await s.post('/api/v1/public/checkout', body), body };
}

describe('faixas de preço por quantidade', () => {
  it('calcula o preço pela maior faixa alcançada', () => {
    const tiers = [
      { minPacks: 10, priceCents: 900 },
      { minPacks: 50, priceCents: 800 },
    ];
    expect([1, 9, 10, 49, 50, 500].map((n) => unitPrice(1000, tiers, n))).toEqual([1000, 1000, 900, 900, 800, 800]);
    expect(mulQty('50.000', 3)).toBe('150.000');
    expect(mulQty('0.250', 7)).toBe('1.750');
  });

  it('recusa faixa com preço que não diminui', async () => {
    const res = await boss.post('/api/v1/admin/products', productPayload(withTiers([{ minPacks: 10, priceCents: 1000 }])));
    expect(res.statusCode).toBe(422);
  });

  it('gerente sem MFA não altera faixa de preço de produto existente', async () => {
    const noMfa = await loggedAs(app, 'manager');
    const { product: p } = await newProduct(withTiers([{ minPacks: 10, priceCents: 900 }]));
    const body = {
      version: p.version,
      name: p.name,
      baseUnit: p.base_unit,
      status: p.status,
      variants: p.variants.map((v: any) => ({
        id: v.id,
        sku: v.sku,
        packagings: v.packagings.map((k: any) => ({
          id: k.id,
          kind: k.kind,
          label: k.label,
          unitCode: k.unit_code,
          baseQty: k.base_qty,
          priceCents: Number(k.price_cents),
          isDefault: k.is_default,
          tiers: k.tiers.length ? [{ minPacks: 10, priceCents: 850 }] : [],
        })),
      })),
    };
    const res = await noMfa.put(`/api/v1/admin/products/${p.id}`, body);
    expect(res.json().error.code).toBe('PRICE_FORBIDDEN');
    const ok = await boss.put(`/api/v1/admin/products/${p.id}`, body);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('o carrinho aplica a faixa e mostra a próxima', async () => {
    const { pack50 } = await newProduct(withTiers([{ minPacks: 10, priceCents: 900 }, { minPacks: 50, priceCents: 800 }]), '5000');
    const s = shopper();
    let cart = (await s.post('/api/v1/public/cart/items', { packagingId: pack50.id, packs: 4 })).json().cart;
    expect(cart.items[0]).toMatchObject({ unitPriceCents: 1000, totalCents: 4000, nextTier: { minPacks: 10, priceCents: 900 } });
    cart = (await s.post('/api/v1/public/cart/items', { packagingId: pack50.id, packs: 6 })).json().cart;
    expect(cart.items[0]).toMatchObject({ packs: 10, unitPriceCents: 900, totalCents: 9000 });
    expect(cart.quantitySavingsCents).toBe(1000);
    // Peso: 4 g x 50 x 10
    expect(cart.weightG).toBe(2000);
  });
});

describe('vitrine e carrinho', () => {
  it('lista, busca e abre o produto sem revelar custo nem saldo exato', async () => {
    const { product } = await newProduct({}, '120');
    const list = (await app.inject({ method: 'GET', url: `/api/v1/public/catalog/products?q=${encodeURIComponent(product.name.split(' ').pop())}` })).json();
    expect(list.total).toBe(1);
    expect(list.products[0]).toMatchObject({ slug: product.slug, in_stock: true });
    const detail = (await app.inject({ method: 'GET', url: `/api/v1/public/catalog/products/${product.slug}` })).json().product;
    const pack = detail.variants[0].packagings.find((k: Pack) => k.label === 'Pacote com 50');
    expect(pack).toMatchObject({ in_stock: true, max_packs: 2 });
    expect(JSON.stringify(detail)).not.toMatch(/avg_cost|on_hand|purchase/);
  });

  it('produto inativo não aparece e não entra no carrinho', async () => {
    const { product, unit } = await newProduct({ status: 'draft' }, '10');
    expect((await app.inject({ method: 'GET', url: `/api/v1/public/catalog/products/${product.slug}` })).statusCode).toBe(404);
    const res = await shopper().post('/api/v1/public/cart/items', { packagingId: unit.id, packs: 1 });
    expect(res.statusCode).toBe(422);
  });

  it('carrinho exige origem da loja quando há cookie', async () => {
    const { unit } = await newProduct({}, '10');
    const s = shopper();
    await s.post('/api/v1/public/cart/items', { packagingId: unit.id, packs: 1 });
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/public/cart/items/${unit.id}`, cookies: { ...s.jar } });
    expect(res.statusCode).toBe(403);
  });

  it('frete: retirada sempre, entrega só na faixa de CEP, grátis acima do valor', async () => {
    const { pack50 } = await newProduct(withTiers([]), '5000');
    const s = shopper();
    await s.post('/api/v1/public/cart/items', { packagingId: pack50.id, packs: 2 });
    let q = (await s.get('/api/v1/public/shipping/quote?cep=89460-123')).json();
    expect(q.options.map((o: { name: string; priceCents: number }) => [o.name, o.priceCents]).sort().reverse()).toEqual([
      ['Retirada na loja', 0],
      ['Entrega Canoinhas', 1500],
    ]);
    q = (await s.get('/api/v1/public/shipping/quote?cep=01310100')).json();
    expect(q.options.map((o: { name: string }) => o.name)).toEqual(['Retirada na loja']);
    await s.put(`/api/v1/public/cart/items/${pack50.id}`, { packs: 50 });
    q = (await s.get('/api/v1/public/shipping/quote?cep=89460123')).json();
    expect(q.options.find((o: { kind: string }) => o.kind === 'delivery').priceCents).toBe(0);
  });
});

describe('checkout com reserva de estoque', () => {
  it('cria o pedido uma vez só, reserva o estoque e esvazia o carrinho', async () => {
    const { variantId, pack50 } = await newProduct({}, '200');
    const s = shopper();
    await s.post('/api/v1/public/cart/items', { packagingId: pack50.id, packs: 3 });
    const { res, body } = await checkout(s);
    expect(res.statusCode, res.body).toBe(201);
    const { token, number } = res.json().order;
    expect(number).toBeGreaterThanOrEqual(1001);
    const b = await balance(variantId);
    expect([b.on_hand, b.reserved]).toEqual(['200.000', '150.000']);
    expect((await s.get('/api/v1/public/cart')).json().cart.items).toEqual([]);

    // Duplo clique: mesmo pedido, mesmo link, nenhuma reserva a mais.
    const again = await s.post('/api/v1/public/checkout', body);
    expect(again.statusCode).toBe(200);
    expect(again.json().order).toMatchObject({ token, number, id: res.json().order.id });
    expect((await balance(variantId)).reserved).toBe('150.000');

    const order = (await app.inject({ method: 'GET', url: `/api/v1/public/orders/${token}` })).json().order;
    expect(order).toMatchObject({ status: 'pending_payment', total_cents: '3000', items: [{ packs: 3, unit_price_cents: '1000' }] });
    expect(order.buyer.document).toBe('52998224725');
    expect((await app.inject({ method: 'GET', url: `/api/v1/public/orders/${'x'.repeat(43)}` })).statusCode).toBe(404);
  });

  it('bloqueia quando falta estoque e quando o preço mudou', async () => {
    const { pack50, product } = await newProduct({}, '100');
    const s = shopper();
    await s.post('/api/v1/public/cart/items', { packagingId: pack50.id, packs: 3 });
    let r = (await checkout(s)).res;
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('CART_BLOCKED');

    await s.put(`/api/v1/public/cart/items/${pack50.id}`, { packs: 2 });
    r = (await checkout(s, { expectedTotalCents: 1500 })).res;
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'PRICE_CHANGED', details: { totalCents: 2000 } });
    expect(product.id).toBeTruthy();
  });

  it('documento inválido e entrega sem endereço são recusados', async () => {
    const { pack50 } = await newProduct({}, '100');
    const s = shopper();
    await s.post('/api/v1/public/cart/items', { packagingId: pack50.id, packs: 1 });
    let r = (await checkout(s, { buyer: { ...buyer, document: '111.111.111-11' } })).res;
    expect(r.json().error.code).toBe('INVALID_DOCUMENT');
    r = (await checkout(s, { shippingOptionId: deliveryId })).res;
    expect(r.json().error.code).toBe('SHIPPING_UNAVAILABLE');
    const address = { recipient: 'Maria', cep: '89460-100', street: 'Rua Vidal Ramos', number: '100', district: 'Centro', city: 'Canoinhas', uf: 'sc' };
    r = (await checkout(s, { shippingOptionId: deliveryId, address, expectedTotalCents: 2500 })).res;
    expect(r.statusCode, r.body).toBe(201);
  });

  it('produto sob encomenda entra sem saldo e marca o pedido', async () => {
    const { pack50, variantId } = await newProduct({ availabilityMode: 'made_to_order', leadTimeDays: 7 });
    const s = shopper();
    await s.post('/api/v1/public/cart/items', { packagingId: pack50.id, packs: 1 });
    const { res } = await checkout(s);
    expect(res.statusCode, res.body).toBe(201);
    const order = (await boss.get(`/api/v1/admin/orders/${res.json().order.id}`)).json().order;
    expect(order.has_backorder).toBe(true);
    expect(order.reservations[0]).toMatchObject({ backorder: true, qty: '50.000' });
    expect((await balance(variantId)).reserved).toBe('50.000');
  });

  it('sem provedor de pagamento o checkout responde indisponível', async () => {
    const off = await makeApp(undefined, null);
    const res = await off.inject({ method: 'POST', url: '/api/v1/public/checkout', headers: { origin: ORIGIN }, payload: { requestKey: 'x'.repeat(10), buyer, shippingOptionId: pickupId, paymentMethod: 'pix', expectedTotalCents: 1 } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('PAYMENT_UNAVAILABLE');
    await off.close();
  });
});

async function placedOrder(method: 'pix' | 'card', packs = 2) {
  const { pack50, variantId } = await newProduct({}, '500');
  const s = shopper();
  await s.post('/api/v1/public/cart/items', { packagingId: pack50.id, packs });
  const { res } = await checkout(s, { paymentMethod: method });
  expect(res.statusCode, res.body).toBe(201);
  return { s, variantId, ...(res.json().order as { id: string; token: string; number: number }) };
}

describe('pagamento', () => {
  it('Pix: gera uma vez, aviso com assinatura inválida é recusado, aviso válido marca pago', async () => {
    const o = await placedOrder('pix');
    const url = `/api/v1/public/orders/${o.token}`;
    const r1 = await o.s.post(`${url}/pay/pix`);
    expect(r1.statusCode, r1.body).toBe(200);
    const pay = r1.json().order.payments[0];
    expect(pay).toMatchObject({ method: 'pix', status: 'pending', amount_cents: '2000' });
    expect(pay.pix_qr_code).toContain(o.id);
    // Pedir de novo devolve o mesmo Pix.
    const r2 = await o.s.post(`${url}/pay/pix`);
    expect(r2.json().order.payments).toHaveLength(1);

    const providerId = (await owner.query('SELECT provider_payment_id FROM payments WHERE order_id = $1', [o.id])).rows[0].provider_payment_id;
    fake.settle(providerId, 'approved');
    const hook = (sig: string, reqId: string) =>
      app.inject({ method: 'POST', url: `/api/v1/webhooks/mercadopago?data.id=${providerId}&type=payment`, headers: { 'x-signature': sig, 'x-request-id': reqId }, payload: { type: 'payment', action: 'payment.updated', data: { id: providerId } } });
    expect((await hook('forjada', 'r-1')).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url })).json().order.status).toBe('pending_payment');

    const ok = await hook('fake-valid', 'r-2');
    expect(ok.statusCode, ok.body).toBe(200);
    const order = (await app.inject({ method: 'GET', url })).json().order;
    expect(order.status).toBe('paid');
    expect(order.paid_at).toBeTruthy();
    // Mesmo aviso repetido nao processa de novo.
    expect((await hook('fake-valid', 'r-2')).json()).toMatchObject({ duplicate: true });
    // Pago: a reserva continua ate o despacho.
    expect((await balance(o.variantId)).reserved).toBe('100.000');
  });

  it('cartão: recusa, nova tentativa aprova, repetição não cobra de novo', async () => {
    const o = await placedOrder('card');
    const url = `/api/v1/public/orders/${o.token}/pay/card`;
    const card = (token: string, attemptKey = randomUUID()) => ({ attemptKey, token, paymentMethodId: 'master', installments: 1, payer: { email: 'maria@teste.local' } });
    let r = await o.s.post(url, card('reject-123456'));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().order).toMatchObject({ status: 'pending_payment', payments: [{ status: 'rejected' }] });
    expect((await o.s.post(`/api/v1/public/orders/${o.token}/pay/pix`)).json().error.code).toBe('WRONG_METHOD');

    const attempt = card('approve-123456');
    r = await o.s.post(url, attempt);
    expect(r.json().order.status).toBe('paid');
    const calls = fake.calls.length;
    r = await o.s.post(url, attempt);
    expect(r.statusCode).toBe(200);
    expect(fake.calls.length).toBe(calls);
    expect(r.json().order.payments).toHaveLength(2);
    // Nenhum dado de cartao alem dos 4 ultimos digitos.
    const cols = (await owner.query('SELECT * FROM payments WHERE order_id = $1', [o.id])).rows;
    expect(JSON.stringify(cols)).not.toContain('approve-123456');
  });

  it('valor divergente do provedor não aprova o pedido', async () => {
    const o = await placedOrder('pix');
    await o.s.post(`/api/v1/public/orders/${o.token}/pay/pix`);
    const providerId = (await owner.query('SELECT provider_payment_id FROM payments WHERE order_id = $1', [o.id])).rows[0].provider_payment_id;
    const p = fake.payments.get(providerId)!;
    fake.payments.set(providerId, { ...p, status: 'approved', amountCents: 1 });
    await app.inject({ method: 'POST', url: `/api/v1/webhooks/mercadopago?data.id=${providerId}`, headers: { 'x-signature': 'fake-valid', 'x-request-id': `r-${uid()}` }, payload: { type: 'payment' } });
    const order = (await app.inject({ method: 'GET', url: `/api/v1/public/orders/${o.token}` })).json().order;
    expect(order.status).toBe('pending_payment');
    expect(order.payments[0].status).toBe('error');
  });

  it('pedido sem pagamento no prazo é cancelado e devolve o estoque', async () => {
    const o = await placedOrder('pix', 4);
    expect((await balance(o.variantId)).reserved).toBe('200.000');
    await owner.query(`UPDATE orders SET payment_due_at = now() - interval '10 minutes' WHERE id = $1`, [o.id]);
    expect(await expireOrders(fake)).toBeGreaterThanOrEqual(1);
    const order = (await app.inject({ method: 'GET', url: `/api/v1/public/orders/${o.token}` })).json().order;
    expect(order).toMatchObject({ status: 'canceled', cancel_reason: 'Prazo de pagamento vencido' });
    expect((await balance(o.variantId)).reserved).toBe('0.000');
  });

  it('Pix pago no último minuto não é cancelado pela rotina', async () => {
    const o = await placedOrder('pix');
    await o.s.post(`/api/v1/public/orders/${o.token}/pay/pix`);
    const providerId = (await owner.query('SELECT provider_payment_id FROM payments WHERE order_id = $1', [o.id])).rows[0].provider_payment_id;
    fake.settle(providerId, 'approved');
    await owner.query(`UPDATE orders SET payment_due_at = now() - interval '10 minutes' WHERE id = $1`, [o.id]);
    await expireOrders(fake);
    expect((await app.inject({ method: 'GET', url: `/api/v1/public/orders/${o.token}` })).json().order.status).toBe('paid');
  });

  it('assinatura do Mercado Pago confere o texto oficial', () => {
    const secret = 'segredo-de-teste-123456';
    const mp = new MercadoPagoProvider('TEST-access-token-000000', 'TEST-public-key-0000000', secret, null);
    const ts = '1742505638683';
    const sign = (m: string) => createHmac('sha256', secret).update(m).digest('hex');
    const v1 = sign(`id:abc123;request-id:req-9;ts:${ts};`);
    const ok = mp.verifyNotification({ headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': 'req-9' }, query: { 'data.id': 'ABC123' } });
    expect(ok.valid).toBe(true);
    const bad = mp.verifyNotification({ headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': 'req-9' }, query: { 'data.id': 'ABC124' } });
    expect(bad.valid).toBe(false);
    const noSecret = new MercadoPagoProvider('TEST-access-token-000000', 'TEST-public-key-0000000', null, null);
    expect(noSecret.verifyNotification({ headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': 'req-9' }, query: { 'data.id': 'abc123' } }).valid).toBe(false);
  });
});

describe('painel de pedidos e despacho', () => {
  it('separa, exige NF-e autorizada para despachar e baixa o estoque no despacho', async () => {
    const o = await placedOrder('card');
    await o.s.post(`/api/v1/public/orders/${o.token}/pay/card`, { attemptKey: randomUUID(), token: 'approve-1', paymentMethodId: 'visa', installments: 1, payer: { email: 'm@teste.local' } });
    const A = `/api/v1/admin/orders/${o.id}`;
    let order = (await boss.get(A)).json().order;
    expect(order.status).toBe('paid');
    expect((await boss.post(`${A}/status`, { to: 'ready', version: order.version })).json().error.code).toBe('INVALID_TRANSITION');
    order = (await boss.post(`${A}/status`, { to: 'preparing', version: order.version })).json().order;
    expect((await boss.post(`${A}/status`, { to: 'ready', version: order.version - 1 })).json().error.code).toBe('VERSION_CONFLICT');
    order = (await boss.post(`${A}/status`, { to: 'ready', version: order.version })).json().order;

    const blocked = await boss.post(`${A}/dispatch`, { version: order.version, carrier: 'Próprio' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('INVOICE_REQUIRED');
    expect((await balance(o.variantId)).on_hand).toBe('500.000');

    // Fase 5 grava a autorizacao da NF-e; aqui o teste simula.
    await owner.query(`UPDATE orders SET invoice_status = 'authorized' WHERE id = $1`, [o.id]);
    // SGLog Fase 4: com a NF-e autorizada, ainda falta a alocacao.
    const noAlloc = await boss.post(`${A}/dispatch`, { version: order.version, carrier: 'Próprio' });
    expect(noAlloc.json().error.code).toBe('ALLOCATION_REQUIRED');
    await allocateOrder(boss, o.id);
    // SGLog Fase 5 (D5-5): pedido novo sai pela remessa; o despacho antigo recusa e os botoes manuais tambem.
    expect((await boss.post(`${A}/dispatch`, { version: order.version, carrier: 'Próprio' })).json().error.code).toBe('USE_SHIPMENT');
    // Retirada na loja: entregar ao cliente fecha a remessa como entregue de uma vez (planejamento §3.7).
    const sent = await shipOrder(boss, o.id, { carrier: 'Próprio' });
    expect(sent.shipment).toMatchObject({ kind: 'pickup', status: 'delivered', volumes: 1 });
    expect(sent.order).toMatchObject({ status: 'delivered', logistics_status: 'completed' });
    const b = await balance(o.variantId);
    expect([b.on_hand, b.reserved]).toEqual(['400.000', '0.000']);
    expect((await boss.post(`${A}/cancel`, { reason: 'Desistiu', version: sent.order.version })).json().error.code).toBe('INVALID_TRANSITION');
    expect((await boss.post(`${A}/deliver`, { version: sent.order.version })).json().error.code).toBe('INVALID_TRANSITION');
  });

  it('cancelar pedido pago libera a reserva e avisa da devolução', async () => {
    const o = await placedOrder('card');
    await o.s.post(`/api/v1/public/orders/${o.token}/pay/card`, { attemptKey: randomUUID(), token: 'approve-2', paymentMethodId: 'visa', installments: 1, payer: { email: 'm@teste.local' } });
    const order = (await boss.get(`/api/v1/admin/orders/${o.id}`)).json().order;
    const r = await boss.post(`/api/v1/admin/orders/${o.id}/cancel`, { reason: 'Cliente pediu', version: order.version });
    expect(r.json()).toMatchObject({ refundNeeded: true, order: { status: 'canceled' } });
    expect((await balance(o.variantId)).reserved).toBe('0.000');
  });

  it('expedição não cancela pedido e atendente não altera pedidos', async () => {
    const o = await placedOrder('pix');
    const ship = await loggedAs(app, 'shipping');
    expect((await ship.get(`/api/v1/admin/orders/${o.id}`)).statusCode).toBe(200);
    expect((await ship.post(`/api/v1/admin/orders/${o.id}/cancel`, { reason: 'x'.repeat(5), version: 1 })).statusCode).toBe(403);
    const sales = await loggedAs(app, 'sales');
    expect((await sales.post(`/api/v1/admin/orders/${o.id}/dispatch`, { version: 1 })).statusCode).toBe(403);
    expect((await sales.post('/api/v1/admin/shipping-options', {})).statusCode).toBe(403);
  });
});

describe('conta do cliente', () => {
  it('cadastra, entra, guarda endereço e vê os próprios pedidos', async () => {
    const s = shopper();
    const email = `cliente-${uid()}@teste.local`;
    const reg = await s.post('/api/v1/customer/register', { kind: 'pf', name: 'João Padeiro', email, phone: '(47) 99999-1234', password: 'Senha-segura-1' });
    expect(reg.statusCode, reg.body).toBe(201);
    expect((await s.post('/api/v1/customer/addresses', { recipient: 'João', cep: '89460000', street: 'Rua A', number: '1', district: 'Centro', city: 'Canoinhas', uf: 'SC' })).statusCode).toBe(201);
    const me = (await s.get('/api/v1/customer/me')).json();
    expect(me.addresses[0].is_default).toBe(true);
    expect(JSON.stringify(me)).not.toContain('password');

    const { pack50 } = await newProduct({}, '100');
    await s.post('/api/v1/public/cart/items', { packagingId: pack50.id, packs: 1 });
    const { res } = await checkout(s);
    expect(res.statusCode, res.body).toBe(201);
    const mine = (await s.get('/api/v1/customer/orders')).json().orders;
    expect(mine.map((x: { id: string }) => x.id)).toEqual([res.json().order.id]);
    expect((await s.get(`/api/v1/customer/orders/${res.json().order.id}`)).statusCode).toBe(200);

    // Outro cliente nao enxerga o pedido.
    const other = shopper();
    await other.post('/api/v1/customer/register', { kind: 'pf', name: 'Outra Pessoa', email: `outra-${uid()}@teste.local`, phone: '47988887777', password: 'Senha-segura-2' });
    expect((await other.get(`/api/v1/customer/orders/${res.json().order.id}`)).statusCode).toBe(404);

    await s.post('/api/v1/customer/logout');
    expect((await s.get('/api/v1/customer/me')).statusCode).toBe(401);
    expect((await s.post('/api/v1/customer/login', { email, password: 'errada-123456' })).statusCode).toBe(401);
    const login = await s.post('/api/v1/customer/login', { email, password: 'Senha-segura-1' });
    expect(login.statusCode, login.body).toBe(200);
    expect((await s.get('/api/v1/customer/me')).statusCode).toBe(200);
    expect((await s.post('/api/v1/customer/register', { kind: 'pf', name: 'Dup', email, phone: '47988887777', password: 'Senha-segura-3' })).statusCode).toBe(409);
  });

  it('sessão do cliente não abre o painel e o papel do banco não lê a senha do cliente', async () => {
    const s = shopper();
    await s.post('/api/v1/customer/register', { kind: 'pj', name: 'Doces Ltda', email: `pj-${uid()}@teste.local`, phone: '4733334444', document: '11.222.333/0001-81', password: 'Senha-segura-4' });
    expect((await s.get('/api/v1/admin/orders')).statusCode).toBe(401);
    await expect(appRole.query('SELECT password_hash FROM customers LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(appRole.query('UPDATE order_items SET packs = 1')).rejects.toThrow();
    await expect(appRole.query('DELETE FROM orders')).rejects.toThrow(/permission denied/);
  });
});
