/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { FakeCarrier, setCarrierProvider } from '../src/lib/carriers.js';
import { FakeProvider } from '../src/lib/payments.js';
import { allocateOrder, appRole, loggedAs, makeApp, ORIGIN, owner, packOrder, productPayload, randomIp, resetCatalog, uid } from './helpers.js';

// SGLog Fase 9a (docs/38-sglog-fase9.md): ocorrencias, devolucao total e parcial, recebimento e conferencia,
// quarentena, avaria e baixa, estorno, teto do entregue e do despachado (concorrencia), pedido antigo sem itens de
// remessa, custo historico, recusa pelo rastreio, conclusao segurada, permissoes e historicos imutaveis.

let app: FastifyInstance;
let boss: Awaited<ReturnType<typeof loggedAs>>; // gerente com MFA
let carrierId: string;
let principal: string;
const carrier = new FakeCarrier();

const R = '/api/v1/admin/returns';
const OC = '/api/v1/admin/occurrences';
const SH = '/api/v1/admin/shipments';
const key = () => `k-${uid()}-${uid()}`;
const buyer = { kind: 'pf', name: 'Maria Confeiteira', email: 'maria@teste.local', phone: '(47) 99999-0000', document: '529.982.247-25' };
const address = { recipient: 'Maria Confeiteira', cep: '01310-100', street: 'Avenida Paulista', number: '1000', district: 'Bela Vista', city: 'São Paulo', uf: 'SP' };

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

async function newProduct(stock = '1000') {
  const res = await boss.post('/api/v1/admin/products', productPayload({ variants: [{ sku: `F9-${uid()}`.toUpperCase(), weightG: 4, lengthMm: 80, widthMm: 80, heightMm: 95, packagings: [{ kind: 'sale', label: 'Pacote com 50', unitCode: 'PCT', baseQty: '50', priceCents: 1000, isDefault: true }] }] }));
  expect(res.statusCode, res.body).toBe(201);
  const v = res.json().product.variants[0];
  await boss.post('/api/v1/admin/stock/movements', { variantId: v.id, kind: 'adjustment', qty: stock, reason: 'Saldo inicial', requestKey: key() });
  return { variantId: v.id as string, pack: v.packagings[0].id as string };
}

/** Pedido pago, alocado e despachado (2 pacotes de 50 = 100 un). `deliver` marca entregue. */
async function shippedOrder(opts: { deliver?: boolean; product?: { variantId: string; pack: string }; packs?: number; invoice?: 'authorized' | 'not_required' } = {}) {
  const p = opts.product ?? (await newProduct());
  const s = shopper();
  await s.post('/api/v1/public/cart/items', { packagingId: p.pack, packs: opts.packs ?? 2 });
  const cart = (await s.get('/api/v1/public/cart')).json().cart;
  const freight = (await s.get('/api/v1/public/shipping/quote?cep=01310100')).json().options.find((o: any) => o.id === carrierId).priceCents;
  const placed = await s.post('/api/v1/public/checkout', { requestKey: `f9-${uid()}`, buyer, shippingOptionId: carrierId, address, paymentMethod: 'pix', expectedTotalCents: cart.subtotalCents + freight });
  expect(placed.statusCode, placed.body).toBe(201);
  const o = placed.json().order as { id: string; token: string };
  expect((await s.post(`/api/v1/public/orders/${o.token}/pay/pix`)).statusCode).toBe(200);
  expect((await s.post(`/api/v1/public/dev-payments/${o.token}/approve-pix`)).statusCode).toBe(200);
  await allocateOrder(boss, o.id);
  await owner.query(`UPDATE orders SET invoice_status = $2 WHERE id = $1`, [o.id, opts.invoice ?? 'not_required']);
  const packed = await packOrder(boss, o.id);
  const d = await boss.post(`${SH}/${packed.id}/dispatch`, { version: packed.version, requestKey: key(), carrier: 'Transportadora X', trackingCode: `TR${uid()}` });
  expect(d.statusCode, d.body).toBe(200);
  if (opts.deliver !== false) {
    const sh = d.json().shipment;
    const r = await boss.post(`${SH}/${packed.id}/deliver`, { version: sh.version, requestKey: key() });
    expect(r.statusCode, r.body).toBe(200);
  }
  const item = (await owner.query<{ id: string }>('SELECT id FROM order_items WHERE order_id = $1', [o.id])).rows[0]!.id;
  return { orderId: o.id, shipment: packed.id as string, variantId: p.variantId, item, product: p };
}

const balance = async (variantId: string, wh = principal) =>
  (await owner.query(`SELECT on_hand::text, reserved::text, blocked::text, damaged::text FROM stock_location_balances WHERE warehouse_id = $1 AND variant_id = $2`, [wh, variantId])).rows[0];
const total = async (variantId: string) => (await owner.query('SELECT on_hand::text, blocked::text, damaged::text, avg_cost_cents::text FROM stock_balances WHERE variant_id = $1', [variantId])).rows[0];
const movements = async (variantId: string) => (await owner.query('SELECT count(*)::int AS n FROM stock_movements WHERE variant_id = $1', [variantId])).rows[0].n as number;
const reconcile = async () => (await owner.query(`SELECT check_code, field, expected::text, found::text FROM stock_reconcile() WHERE check_code <> 'run'`)).rows;

async function createReturn(orderId: string, items: { orderItemId: string; qty: string }[], extra: Record<string, unknown> = {}, c = boss) {
  return c.post(R, { orderId, kind: 'return', reason: 'defect', items, returnMethod: 'carrier', requestKey: key(), ...extra });
}
async function okReturn(orderId: string, items: { orderItemId: string; qty: string }[], extra: Record<string, unknown> = {}) {
  const r = await createReturn(orderId, items, extra);
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
const getReturn = async (id: string) => {
  const r = await boss.get(`${R}/${id}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
async function receive(id: string, c = boss) {
  const v = await getReturn(id);
  const r = await c.post(`${R}/${id}/receive`, { version: v.return.version, requestKey: key() });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
async function inspect(id: string, lines: { condition: string; qty: string; reason?: string }[], c = boss) {
  const v = await getReturn(id);
  const itemId = v.items[0].id;
  return c.post(`${R}/${id}/inspect`, { version: v.return.version, requestKey: key(), lines: lines.map((l) => ({ itemId, ...l })) });
}

beforeAll(async () => {
  app = await makeApp(undefined, new FakeProvider(), null, undefined, { carrier });
  setCarrierProvider(carrier);
  await resetCatalog();
  boss = await loggedAs(app, 'manager', { mfa: true });
  (config as any).SHIP_FROM_CEP = '89460000';
  const c = await boss.post('/api/v1/admin/shipping-options', { name: 'Transportadora econômica', kind: 'carrier', carrierService: '3', handlingDays: 1, baseCents: 0, minDays: 0, maxDays: 0 });
  expect(c.statusCode, c.body).toBe(201);
  carrierId = c.json().option.id;
  principal = (await owner.query('SELECT id FROM warehouses WHERE is_default')).rows[0].id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

describe('devolução: autorizar, receber e conferir', () => {
  it('autorizar e receber não movimentam estoque; o teto é o entregue, contando as anteriores', async () => {
    const o = await shippedOrder();
    const before = await movements(o.variantId);
    const bal = await balance(o.variantId);
    const r = await okReturn(o.orderId, [{ orderItemId: o.item, qty: '60' }]);
    expect(r.return).toMatchObject({ status: 'authorized', kind: 'return', fiscal_required: false });
    expect(r.items[0]).toMatchObject({ qty: '60.000', pending: '60.000' });
    await receive(r.return.id);
    expect(await movements(o.variantId)).toBe(before);
    expect(await balance(o.variantId)).toEqual(bal);
    // 100 entregues, 60 em devolucao: 41 passa.
    const over = await createReturn(o.orderId, [{ orderItemId: o.item, qty: '41' }]);
    expect(over.statusCode).toBe(409);
    expect(over.json().error.code).toBe('RETURN_QTY_EXCEEDED');
    expect(over.json().error.details).toMatchObject({ available: '40.000', requested: '41' });
    expect((await createReturn(o.orderId, [{ orderItemId: o.item, qty: '40' }])).statusCode).toBe(201);
    // Contexto do pedido: o que ainda pode voltar.
    const ctx = (await boss.get(`${R}/orders/${o.orderId}`)).json();
    expect(ctx.items[0]).toMatchObject({ dispatched: '100.000', delivered: '100.000', returned: '100.000', returnable: '0.000' });
    expect(ctx.deadlines.map((d: any) => d.kind)).toEqual(['regret', 'defect', 'defect_nondurable']);
    expect(ctx.deadlines.every((d: any) => d.passed === false)).toBe(true);
  });

  it('devolução parcial: boa, quarentena, avariada, descartada e faltando, cada uma no seu saldo', async () => {
    const o = await shippedOrder();
    const b0 = await balance(o.variantId);
    const r = await okReturn(o.orderId, [{ orderItemId: o.item, qty: '21' }]);
    // Conferir antes de receber: recusado.
    const early = await inspect(r.return.id, [{ condition: 'good', qty: '1' }]);
    expect(early.statusCode).toBe(409);
    await receive(r.return.id);
    // Avaria sem motivo: recusada.
    expect((await inspect(r.return.id, [{ condition: 'damaged', qty: '3' }])).json().error.code).toBe('REASON_REQUIRED');
    const first = await inspect(r.return.id, [
      { condition: 'good', qty: '10' },
      { condition: 'quarantine', qty: '5' },
    ]);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().return.status).toBe('received');
    const second = await inspect(r.return.id, [
      { condition: 'damaged', qty: '3', reason: 'Caixa amassada' },
      { condition: 'discarded', qty: '2', reason: 'Contaminado' },
      { condition: 'missing', qty: '1' },
    ]);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().return.status).toBe('inspected');
    const b1 = await balance(o.variantId);
    expect(Number(b1.on_hand) - Number(b0.on_hand)).toBe(10);
    expect(Number(b1.blocked) - Number(b0.blocked)).toBe(5);
    expect(Number(b1.damaged) - Number(b0.damaged)).toBe(3);
    // Mais do que o autorizado: recusado (o gatilho tambem confere).
    const v = await getReturn(r.return.id);
    expect(v.items[0].pending).toBe('0.000');
    expect(v.items[0].inspected).toEqual({ good: '10.000', quarantine: '5.000', damaged: '3.000', discarded: '2.000', missing: '1.000' });
    expect(await reconcile()).toEqual([]);
    // Movimentos da devolucao: entradas e saidas para os saldos certos, com a origem.
    const mv = (await owner.query(`SELECT kind, on_hand_delta::text, blocked_delta::text, damaged_delta::text FROM stock_movements WHERE source_type = 'customer_return' AND variant_id = $1 ORDER BY id`, [o.variantId])).rows;
    expect(mv.map((m) => m.kind)).toEqual(['return', 'return', 'block', 'return', 'damage_hold', 'return', 'damage']);

    // Quarentena: liberar 2, avariar 1, baixar 1; sobra 1.
    const q = (await boss.get(`${R}/quarantine`)).json().items.find((i: any) => i.return_id === r.return.id);
    expect(q.open_qty).toBe('5.000');
    const decide = (decision: string, qty: string, c = boss) => c.post(`${R}/quarantine/${q.inspection_id}/decide`, { decision, qty, reason: 'Inspeção da quarentena', requestKey: key() });
    expect((await decide('release', '2')).statusCode).toBe(200);
    expect((await decide('damaged', '1')).statusCode).toBe(200);
    expect((await decide('discard', '1')).statusCode).toBe(200);
    const over = await decide('release', '2');
    expect(over.statusCode).toBe(409);
    expect(over.json().error.code).toBe('QUARANTINE_QTY_EXCEEDED');
    const b2 = await balance(o.variantId);
    expect(Number(b2.on_hand) - Number(b0.on_hand)).toBe(12);
    expect(Number(b2.blocked) - Number(b0.blocked)).toBe(1);
    expect(Number(b2.damaged) - Number(b0.damaged)).toBe(4);
    expect(await reconcile()).toEqual([]);
    // Encerrar: sem NF-e autorizada nao ha pendencia fiscal.
    const done = await boss.post(`${R}/${r.return.id}/complete`, { version: (await getReturn(r.return.id)).return.version, requestKey: key() });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().return.status).toBe('completed');
  });

  it('devolução total: tudo volta ao disponível; NF-e autorizada segura o encerramento', async () => {
    const o = await shippedOrder({ invoice: 'authorized' });
    const b0 = await balance(o.variantId);
    const r = await okReturn(o.orderId, [{ orderItemId: o.item, qty: '100' }], { reason: 'regret' });
    expect(r.return.fiscal_required).toBe(true);
    await receive(r.return.id);
    expect((await inspect(r.return.id, [{ condition: 'good', qty: '100' }])).statusCode).toBe(200);
    expect(Number((await balance(o.variantId)).on_hand) - Number(b0.on_hand)).toBe(100);
    const v = await getReturn(r.return.id);
    const done = await boss.post(`${R}/${r.return.id}/complete`, { version: v.return.version, requestKey: key() });
    expect(done.statusCode).toBe(409);
    expect(done.json().error.code).toBe('FISCAL_PENDING');
    // A nota de venda nao muda.
    expect((await owner.query('SELECT invoice_status FROM orders WHERE id = $1', [o.orderId])).rows[0].invoice_status).toBe('authorized');
  });

  it('estorno da conferência: movimentos de estorno, linha nova, quarentena decidida não estorna', async () => {
    const o = await shippedOrder();
    const b0 = await balance(o.variantId);
    const r = await okReturn(o.orderId, [{ orderItemId: o.item, qty: '8' }]);
    await receive(r.return.id);
    expect((await inspect(r.return.id, [{ condition: 'good', qty: '5' }, { condition: 'quarantine', qty: '3' }])).statusCode).toBe(200);
    const v = await getReturn(r.return.id);
    const good = v.inspections.find((i: any) => i.condition === 'good');
    const quar = v.inspections.find((i: any) => i.condition === 'quarantine');
    const rev = await boss.post(`${R}/${r.return.id}/inspections/${good.id}/reverse`, { reason: 'Conferido no item errado', requestKey: key() });
    expect(rev.statusCode, rev.body).toBe(200);
    expect(rev.json().return.status).toBe('received');
    expect(Number((await balance(o.variantId)).on_hand) - Number(b0.on_hand)).toBe(0);
    const twice = await boss.post(`${R}/${r.return.id}/inspections/${good.id}/reverse`, { reason: 'De novo', requestKey: key() });
    expect(twice.json().error.code).toBe('ALREADY_REVERSED');
    expect((await boss.post(`${R}/quarantine/${quar.id}/decide`, { decision: 'release', qty: '1', reason: 'Inspecionado', requestKey: key() })).statusCode).toBe(200);
    const decided = await boss.post(`${R}/${r.return.id}/inspections/${quar.id}/reverse`, { reason: 'Engano', requestKey: key() });
    expect(decided.json().error.code).toBe('QUARANTINE_DECIDED');
    // Depois do estorno, o item pode ser conferido de novo.
    expect((await inspect(r.return.id, [{ condition: 'good', qty: '5' }])).json().return.status).toBe('inspected');
    expect(await reconcile()).toEqual([]);
  });

  it('cancelar antes do recebimento libera a quantidade; depois de recebida, não cancela', async () => {
    const o = await shippedOrder();
    const r = await okReturn(o.orderId, [{ orderItemId: o.item, qty: '100' }]);
    const v = await getReturn(r.return.id);
    expect((await boss.post(`${R}/${r.return.id}/cancel`, { reason: 'Cliente desistiu', version: v.return.version, requestKey: key() })).statusCode).toBe(200);
    const again = await okReturn(o.orderId, [{ orderItemId: o.item, qty: '100' }]);
    await receive(again.return.id);
    const v2 = await getReturn(again.return.id);
    const no = await boss.post(`${R}/${again.return.id}/cancel`, { reason: 'Tarde demais', version: v2.return.version, requestKey: key() });
    expect(no.statusCode).toBe(409);
  });

  it('logística reversa manual: em trânsito de volta com rastreio e custo do frete de volta', async () => {
    const o = await shippedOrder();
    const r = await okReturn(o.orderId, [{ orderItemId: o.item, qty: '5' }], { returnMethod: 'carrier', reverseCode: 'AUT123' });
    const t = await boss.post(`${R}/${r.return.id}/transit`, { carrier: 'Correios', trackingCode: 'QB123BR', returnFreightCents: 2300, version: r.return.version, requestKey: key() });
    expect(t.statusCode, t.body).toBe(200);
    expect(t.json().return).toMatchObject({ status: 'in_transit', carrier: 'Correios', tracking_code: 'QB123BR', reverse_code: 'AUT123', return_freight_cents: 2300 });
  });
});

describe('devolução: concorrência, repetição e pedido antigo', () => {
  it('duas devoluções simultâneas do mesmo item: só uma passa e o total não passa do entregue', async () => {
    const o = await shippedOrder();
    const res = await Promise.all([createReturn(o.orderId, [{ orderItemId: o.item, qty: '70' }]), createReturn(o.orderId, [{ orderItemId: o.item, qty: '70' }])]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const sum = (await owner.query(`SELECT sum(i.qty)::text AS q FROM customer_return_items i JOIN customer_returns r ON r.id = i.return_id WHERE r.order_id = $1 AND r.status <> 'canceled'`, [o.orderId])).rows[0].q;
    expect(sum).toBe('70.000');
  });

  it('repetir com a mesma chave devolve o mesmo registro e não duplica movimento', async () => {
    const o = await shippedOrder();
    const k = key();
    const a = await createReturn(o.orderId, [{ orderItemId: o.item, qty: '4' }], { requestKey: k });
    const b = await createReturn(o.orderId, [{ orderItemId: o.item, qty: '4' }], { requestKey: k });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ replayed: true, return: { id: a.json().return.id } });
    await receive(a.json().return.id);
    const v = await getReturn(a.json().return.id);
    const body = { version: v.return.version, requestKey: key(), lines: [{ itemId: v.items[0].id, condition: 'good', qty: '4' }] };
    const before = await movements(o.variantId);
    const [x, y] = await Promise.all([boss.post(`${R}/${v.return.id}/inspect`, body), boss.post(`${R}/${v.return.id}/inspect`, body)]);
    expect([x.statusCode, y.statusCode]).toEqual([200, 200]);
    expect([x.json().replayed, y.json().replayed].sort()).toEqual([false, true]);
    expect(await movements(o.variantId)).toBe(before + 1);
  });

  it('pedido antigo sem itens de remessa: o teto vem do item do pedido e a conferência funciona', async () => {
    const p = await newProduct();
    const o = await shippedOrder({ product: p });
    // Despacho anterior: a remessa vira 'legacy' (como as criadas pela 0024 para os pedidos antigos).
    await owner.query(`UPDATE shipments SET kind = 'legacy' WHERE order_id = $1`, [o.orderId]);
    const ctx = (await boss.get(`${R}/orders/${o.orderId}`)).json();
    expect(ctx.items[0]).toMatchObject({ dispatched: '100.000', delivered: '100.000' });
    const r = await okReturn(o.orderId, [{ orderItemId: o.item, qty: '10' }]);
    const sid = (await owner.query('SELECT shipment_item_id FROM customer_return_items WHERE return_id = $1', [r.return.id])).rows[0].shipment_item_id;
    expect(sid).toBeNull();
    await receive(r.return.id);
    expect((await inspect(r.return.id, [{ condition: 'good', qty: '10' }])).statusCode).toBe(200);
    expect(await reconcile()).toEqual([]);
    // Sem remessa nenhuma (pedido muito antigo): entregue pelo pedido.
    const legacyOrder = (await owner.query('SELECT id FROM orders WHERE id = $1', [o.orderId])).rows[0].id;
    expect(legacyOrder).toBe(o.orderId);
  });

  it('marketplace: troca é da plataforma; a devolução física é registrada', async () => {
    const o = await shippedOrder();
    await owner.query(`UPDATE orders SET channel = 'shopee' WHERE id = $1`, [o.orderId]);
    const ex = await createReturn(o.orderId, [{ orderItemId: o.item, qty: '1' }], { kind: 'exchange' });
    expect(ex.json().error.code).toBe('MARKETPLACE_EXCHANGE');
    expect((await createReturn(o.orderId, [{ orderItemId: o.item, qty: '1' }])).statusCode).toBe(201);
  });
});

describe('custo da mercadoria devolvida (D9-3)', () => {
  it('volta pelo custo da venda; o descarte e o custo desconhecido não mexem na média', async () => {
    const p = await newProduct('300');
    await owner.query('UPDATE stock_balances SET avg_cost_cents = 100 WHERE variant_id = $1', [p.variantId]);
    const a = await shippedOrder({ product: p }); // saiu a 1,00
    await owner.query('UPDATE stock_balances SET avg_cost_cents = 300 WHERE variant_id = $1', [p.variantId]);
    const b = await shippedOrder({ product: p }); // saiu a 3,00
    const t0 = await total(p.variantId);
    expect(Number(t0.avg_cost_cents)).toBe(300);
    const ra = await okReturn(a.orderId, [{ orderItemId: a.item, qty: '10' }]);
    const rb = await okReturn(b.orderId, [{ orderItemId: b.item, qty: '10' }]);
    expect(ra.items[0].unit_cost_cents).toBe('100.0000');
    expect(rb.items[0].unit_cost_cents).toBe('300.0000');
    await receive(ra.return.id);
    await receive(rb.return.id);
    // Descarte de A: entra e sai pelo medio atual; a media nao muda, a perda guarda o custo historico.
    expect((await inspect(ra.return.id, [{ condition: 'discarded', qty: '2', reason: 'Inutilizável' }])).statusCode).toBe(200);
    expect(Number((await total(p.variantId)).avg_cost_cents)).toBe(300);
    const disc = (await getReturn(ra.return.id)).inspections[0];
    expect(disc).toMatchObject({ condition: 'discarded', unit_cost_cents: '100.0000', cost_source: 'current_avg' });
    // 8 boas de A a 1,00: media ponderada sobre o total (disponivel + bloqueado + avariado).
    const q = Number(t0.on_hand) + Number(t0.blocked) + Number(t0.damaged);
    expect((await inspect(ra.return.id, [{ condition: 'good', qty: '8' }])).statusCode).toBe(200);
    const expected = Math.round(((q * 300 + 8 * 100) / (q + 8)) * 10000) / 10000;
    expect(Number((await total(p.variantId)).avg_cost_cents)).toBeCloseTo(expected, 3);
    // B volta a 3,00: a media nao sobe nem desce alem do ponderado.
    const t1 = await total(p.variantId);
    const q1 = Number(t1.on_hand) + Number(t1.blocked) + Number(t1.damaged);
    expect((await inspect(rb.return.id, [{ condition: 'quarantine', qty: '10' }])).statusCode).toBe(200);
    const exp2 = Math.round(((q1 * Number(t1.avg_cost_cents) + 10 * 300) / (q1 + 10)) * 10000) / 10000;
    expect(Number((await total(p.variantId)).avg_cost_cents)).toBeCloseTo(exp2, 3);
    // Venda sem custo (estoque que entrou sem custo, media 0): entra pelo medio atual, sem mexer nele.
    const z = await newProduct('300');
    const c = await shippedOrder({ product: z });
    await owner.query('UPDATE stock_balances SET avg_cost_cents = 500 WHERE variant_id = $1', [z.variantId]);
    const rc = await okReturn(c.orderId, [{ orderItemId: c.item, qty: '5' }]);
    expect(rc.items[0].unit_cost_cents).toBeNull();
    await receive(rc.return.id);
    expect((await inspect(rc.return.id, [{ condition: 'good', qty: '5' }])).statusCode).toBe(200);
    expect(Number((await total(z.variantId)).avg_cost_cents)).toBe(500);
    expect((await getReturn(rc.return.id)).inspections[0].cost_source).toBe('current_avg');
  });
});

describe('ocorrências', () => {
  it('rastreio: falha na entrega e devolução abrem uma ocorrência cada, sem estoque; repetido não duplica', async () => {
    const o = await shippedOrder({ deliver: false });
    const before = await movements(o.variantId);
    const track = (status: string) => boss.post(`/api/v1/admin/freight/shipments/${o.shipment}/tracking`, { status, requestKey: key() });
    expect((await track('delivery_failed')).statusCode).toBe(200);
    expect((await track('delivery_failed')).statusCode).toBe(200);
    expect((await track('delivery_failed')).statusCode).toBe(200);
    const occ = (await owner.query(`SELECT id, kind, source, status FROM logistic_occurrences WHERE order_id = $1`, [o.orderId])).rows;
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({ kind: 'delivery_failed', source: 'tracking', status: 'open' });
    const ev = (await owner.query('SELECT action FROM occurrence_events WHERE occurrence_id = $1 ORDER BY id', [occ[0].id])).rows.map((r) => r.action);
    expect(ev).toEqual(['open', 'tracking', 'tracking']);
    expect((await track('returned')).statusCode).toBe(200);
    expect((await owner.query(`SELECT kind FROM logistic_occurrences WHERE order_id = $1 ORDER BY number`, [o.orderId])).rows.map((r) => r.kind)).toEqual(['delivery_failed', 'refused']);
    expect(await movements(o.variantId)).toBe(before);
    // A recusa volta pela devolucao: despachado e nao entregue.
    const occRefused = (await owner.query(`SELECT id FROM logistic_occurrences WHERE order_id = $1 AND kind = 'refused'`, [o.orderId])).rows[0].id;
    expect((await createReturn(o.orderId, [{ orderItemId: o.item, qty: '1' }])).json().error.code).toBe('RETURN_QTY_EXCEEDED'); // nao entregue
    const r = await okReturn(o.orderId, [{ orderItemId: o.item, qty: '100' }], { kind: 'refusal', reason: 'refused', occurrenceId: occRefused, shipmentId: o.shipment });
    await receive(r.return.id);
    expect((await inspect(r.return.id, [{ condition: 'good', qty: '100' }])).statusCode).toBe(200);
    expect(await movements(o.variantId)).toBe(before + 1);
    expect(await reconcile()).toEqual([]);
  });

  it('ocorrência aberta segura a conclusão; resolver exige responsável; resolvida, o pedido conclui', async () => {
    const o = await shippedOrder({ deliver: false });
    const open = await boss.post(OC, { orderId: o.orderId, kind: 'damaged', description: 'Cliente relatou caixa amassada', requestKey: key() });
    expect(open.statusCode, open.body).toBe(201);
    const occ = open.json().occurrence;
    const sh = (await boss.get(`${SH}/${o.shipment}`)).json().shipment;
    expect((await boss.post(`${SH}/${o.shipment}/deliver`, { version: sh.version, requestKey: key() })).statusCode).toBe(200);
    const ord = (await owner.query('SELECT status, logistics_status FROM orders WHERE id = $1', [o.orderId])).rows[0];
    expect(ord).toEqual({ status: 'delivered', logistics_status: 'on_hold' });
    const act = (action: string, extra: Record<string, unknown> = {}, version = occ.version) => boss.post(`${OC}/${occ.id}/action`, { action, note: 'Tratado com o cliente', version, requestKey: key(), ...extra });
    const noResp = await act('resolve');
    expect(noResp.json().error.code).toBe('RESPONSIBILITY_REQUIRED');
    const stale = await act('start', {}, occ.version - 1);
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
    const ok = await act('resolve', { responsibility: 'carrier' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().occurrence).toMatchObject({ status: 'resolved', responsibility: 'carrier' });
    expect((await owner.query('SELECT logistics_status FROM orders WHERE id = $1', [o.orderId])).rows[0].logistics_status).toBe('completed');
    // Ocorrencia nova em pedido ja concluido nao reabre a conclusao.
    expect((await boss.post(OC, { orderId: o.orderId, kind: 'late', description: 'Reclamação depois', requestKey: key() })).statusCode).toBe(201);
    expect((await owner.query('SELECT logistics_status FROM orders WHERE id = $1', [o.orderId])).rows[0].logistics_status).toBe('completed');
    // Reabrir pede motivo e volta a andamento.
    const re = await act('reopen', {}, ok.json().occurrence.version);
    expect(re.json().occurrence.status).toBe('in_progress');
  });
});

describe('permissões e históricos', () => {
  it('expedição recebe e confere, mas não autoriza nem decide a quarentena; sem permissão: 403', async () => {
    const ship = await loggedAs(app, 'shipping');
    const sales = await loggedAs(app, 'sales');
    const buyerRole = await loggedAs(app, 'buyer');
    const o = await shippedOrder();
    expect((await createReturn(o.orderId, [{ orderItemId: o.item, qty: '1' }], {}, ship)).statusCode).toBe(403);
    const r = await okReturn(o.orderId, [{ orderItemId: o.item, qty: '3' }]);
    await receive(r.return.id, ship);
    expect((await inspect(r.return.id, [{ condition: 'quarantine', qty: '3' }], ship)).statusCode).toBe(200);
    const q = (await getReturn(r.return.id)).inspections[0];
    expect((await ship.post(`${R}/quarantine/${q.id}/decide`, { decision: 'release', qty: '1', reason: 'Liberar', requestKey: key() })).statusCode).toBe(403);
    expect((await ship.post(`${R}/${r.return.id}/inspections/${q.id}/reverse`, { reason: 'Estornar', requestKey: key() })).statusCode).toBe(403);
    // Atendimento abre ocorrencia, mas nao autoriza devolucao.
    expect((await sales.post(OC, { orderId: o.orderId, kind: 'wrong_item', description: 'Veio o tamanho errado', requestKey: key() })).statusCode).toBe(201);
    expect((await createReturn(o.orderId, [{ orderItemId: o.item, qty: '1' }], {}, sales)).statusCode).toBe(403);
    // Comprador: ve (logistics.view), mas nao grava nada da Fase 9a.
    for (const [m, u, body] of [
      ['POST', R, {}],
      ['POST', `${R}/${r.return.id}/receive`, {}],
      ['POST', `${R}/${r.return.id}/inspect`, {}],
      ['POST', `${R}/${r.return.id}/complete`, {}],
      ['POST', OC, {}],
      ['PUT', `${R}/settings`, {}],
    ] as const) {
      const res = m === 'PUT' ? await buyerRole.put(u, body) : await buyerRole.post(u, body);
      expect(res.statusCode, `${m} ${u}`).toBe(403);
    }
  });

  it('a aplicação não altera nem apaga conferência, decisão, itens e históricos (imutáveis)', async () => {
    const o = await shippedOrder();
    const r = await okReturn(o.orderId, [{ orderItemId: o.item, qty: '2' }]);
    await receive(r.return.id);
    await inspect(r.return.id, [{ condition: 'quarantine', qty: '2' }]);
    const q = (await getReturn(r.return.id)).inspections[0];
    await boss.post(`${R}/quarantine/${q.id}/decide`, { decision: 'release', qty: '1', reason: 'Liberar', requestKey: key() });
    await boss.post(OC, { orderId: o.orderId, kind: 'other', description: 'Teste de histórico', requestKey: key() });
    for (const sql of [
      'UPDATE return_inspections SET qty = 1',
      'DELETE FROM return_inspections',
      'UPDATE quarantine_decisions SET qty = 2',
      'DELETE FROM quarantine_decisions',
      'UPDATE customer_return_items SET qty = 1',
      'DELETE FROM customer_return_items',
      "UPDATE return_events SET note = 'x'",
      'DELETE FROM return_events',
      "UPDATE occurrence_events SET note = 'x'",
      'DELETE FROM occurrence_events',
      'DELETE FROM customer_returns',
      'DELETE FROM logistic_occurrences',
    ]) {
      await expect(appRole.query(sql), sql).rejects.toThrow();
    }
  });

  it('política da loja: só referência, configurável com MFA; prazo vencido não recusa', async () => {
    const pol = (await boss.get(`${R}/settings`)).json().policy;
    expect(pol).toMatchObject({ regretDays: 7, defectDays: 90, defectNondurableDays: 30, warrantyDays: null });
    const put = await boss.put(`${R}/settings`, { regretDays: 0, defectDays: 0, defectNondurableDays: 0, warrantyDays: 365, policyText: 'Trocas com nota.', version: pol.version });
    expect(put.statusCode, put.body).toBe(200);
    const o = await shippedOrder();
    const ctx = (await boss.get(`${R}/orders/${o.orderId}`)).json();
    expect(ctx.deadlines.find((d: any) => d.kind === 'regret').days).toBe(0);
    // Prazo de referencia vencido: so informa.
    expect((await createReturn(o.orderId, [{ orderItemId: o.item, qty: '1' }], { reason: 'regret' })).statusCode).toBe(201);
    const noMfa = await loggedAs(app, 'manager');
    expect((await noMfa.put(`${R}/settings`, { regretDays: 7, defectDays: 90, defectNondurableDays: 30, warrantyDays: null, policyText: null, version: put.json().policy.version })).json().error.code).toBe('MFA_REQUIRED');
  });
});
