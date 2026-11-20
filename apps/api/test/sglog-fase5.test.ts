import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, tx } from '../src/db/pool.js';
import { releaseOrderReservations } from '../src/modules/orders.js';
import { FakeProvider } from '../src/lib/payments.js';
import { appRole, loggedAs, makeApp, ORIGIN, owner, packOrder, productPayload, randomIp, resetCatalog, uid } from './helpers.js';

// SGLog Fase 5 (docs/26-sglog-fase5.md): remessas, separacao, conferencia, embalagem e despacho. Concorrencia,
// idempotencia, falta, cancelamento, pedidos antigos, remessas multiplas travadas, permissoes e conciliacao C1-C11.

let app: FastifyInstance;
let boss: Awaited<ReturnType<typeof loggedAs>>; // gerente com MFA
let pickupId: string;
let principal: string;

beforeAll(async () => {
  app = await makeApp(undefined, new FakeProvider());
  await resetCatalog();
  boss = await loggedAs(app, 'manager', { mfa: true });
  const p = await boss.post('/api/v1/admin/shipping-options', { name: 'Retirada na loja', kind: 'pickup', description: 'Centro', baseCents: 0, minDays: 0, maxDays: 1 });
  expect(p.statusCode, p.body).toBe(201);
  pickupId = p.json().option.id;
  principal = (await owner.query('SELECT id FROM warehouses WHERE is_default')).rows[0].id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

const L = '/api/v1/admin/logistics';
const SH = '/api/v1/admin/shipments';
const key = () => `k-${uid()}-${uid()}`;
const buyer = { kind: 'pf', name: 'Maria Confeiteira', email: 'maria@teste.local', phone: '47999990000', document: '529.982.247-25' };

type Pack = { id: string; kind: string; label: string; base_qty: string };
async function newProduct(stock = '0') {
  const res = await boss.post('/api/v1/admin/products', productPayload());
  expect(res.statusCode, res.body).toBe(201);
  const v = res.json().product.variants[0];
  if (stock !== '0') await move(v.id, 'adjustment', stock);
  const packs = v.packagings as Pack[];
  return { variantId: v.id as string, sku: v.sku as string, pack50: packs.find((k) => k.label === 'Pacote com 50')!, purchase: packs.find((k) => k.kind === 'purchase')! };
}
async function move(variantId: string, kind: 'adjustment' | 'loss', qty: string) {
  const r = await boss.post('/api/v1/admin/stock/movements', { variantId, kind, qty, reason: 'Teste da Fase 5', requestKey: key() });
  expect(r.statusCode, r.body).toBe(201);
}
async function paidOrder(items: { pack: Pack; packs: number }[]) {
  const jar: Record<string, string> = {};
  const ip = randomIp();
  const send = async (method: 'GET' | 'POST', url: string, payload?: object) => {
    const res = await app.inject({ method, url, remoteAddress: ip, headers: { origin: ORIGIN }, cookies: { ...jar }, ...(payload ? { payload } : {}) });
    for (const c of res.cookies) if (c.value) jar[c.name] = c.value;
    return res;
  };
  for (const it of items) expect((await send('POST', '/api/v1/public/cart/items', { packagingId: it.pack.id, packs: it.packs })).statusCode).toBeLessThan(300);
  const cart = (await send('GET', '/api/v1/public/cart')).json().cart;
  const placed = await send('POST', '/api/v1/public/checkout', { requestKey: `pedido-${uid()}`, buyer, shippingOptionId: pickupId, paymentMethod: 'card', expectedTotalCents: cart.subtotalCents });
  expect(placed.statusCode, placed.body).toBe(201);
  const o = placed.json().order as { id: string; token: string };
  const paid = await send('POST', `/api/v1/public/orders/${o.token}/pay/card`, { attemptKey: randomUUID(), token: 'approve-1', paymentMethodId: 'visa', installments: 1, payer: { email: 'm@teste.local' } });
  expect(paid.statusCode, paid.body).toBe(200);
  return o.id;
}
const orderRow = async (id: string) =>
  (await owner.query('SELECT status, version, logistics_status, logistics_note, logistics_version, allocation_required FROM orders WHERE id = $1', [id])).rows[0];
async function allocate(id: string, c = boss, extra: Record<string, unknown> = {}) {
  const d = (await c.get(`${L}/orders/${id}`)).json();
  const r = await c.post(`${L}/orders/${id}/allocation`, { requestKey: key(), logisticsVersion: d.order.logistics_version, planKey: d.proposal.recommended.key, ...extra });
  return r;
}
async function allocated(id: string) {
  const r = await allocate(id);
  expect(r.statusCode, r.body).toBe(200);
  return shipmentOf(id);
}
const shipments = async (orderId: string) => (await owner.query('SELECT id, seq, kind, status, version FROM shipments WHERE order_id = $1 ORDER BY seq', [orderId])).rows;
async function shipmentOf(orderId: string) {
  const open = (await shipments(orderId)).filter((s) => !['canceled', 'shipped', 'delivered'].includes(s.status));
  expect(open, 'uma remessa aberta').toHaveLength(1);
  return view(open[0].id);
}
const view = async (id: string, c = boss) => {
  const r = await c.get(`${SH}/${id}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().shipment;
};
const post = (c: typeof boss, id: string, path: string, body: Record<string, unknown> = {}) => c.post(`${SH}/${id}${path}`, { requestKey: key(), ...body });
async function ok(c: typeof boss, id: string, path: string, body: Record<string, unknown> = {}) {
  const r = await post(c, id, path, body);
  expect(r.statusCode, `${path}: ${r.body}`).toBe(200);
  return r.json().shipment;
}
const total = async (variantId: string) => (await owner.query('SELECT on_hand, reserved FROM stock_balances WHERE variant_id = $1', [variantId])).rows[0];
const movements = async (variantId: string) => (await owner.query('SELECT count(*)::int AS n FROM stock_movements WHERE variant_id = $1', [variantId])).rows[0].n as number;
const checks = async (shipmentId: string) => (await owner.query('SELECT kind, qty, result, sku_read, note FROM shipment_checks WHERE shipment_id = $1 ORDER BY id', [shipmentId])).rows;
type Rec = { check_code: string; field: string | null; expected: string; found: string };
async function reconcile() {
  const rows = (await appRole.query<Rec>('SELECT check_code, field, expected, found FROM stock_reconcile()')).rows;
  return rows.filter((r) => r.check_code !== 'run');
}
const authorize = (id: string) => owner.query(`UPDATE orders SET invoice_status = 'authorized' WHERE id = $1`, [id]);
const settingsVersion = async () => (await owner.query('SELECT version FROM logistics_settings')).rows[0].version as number;
const pgError = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err as { code?: string; constraint?: string; message: string };
  }
  throw new Error('a operacao deveria ter sido recusada');
};

describe('criação e separação', () => {
  it('confirmar a alocação cria uma remessa pendente; separar não mexe no estoque nem na reserva', async () => {
    const prod = await newProduct('500');
    const id = await paidOrder([{ pack: prod.pack50, packs: 2 }]);
    const s = await allocated(id);
    expect(s).toMatchObject({ seq: 1, kind: 'pickup', status: 'pending', warehouse_id: principal });
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ sku: prod.sku, base_qty: '100.000', picked_qty: '0.000', backorder: false });
    const ov = (await boss.get(`/api/v1/admin/orders/${id}`)).json().order;
    expect(ov.shipments.map((x: { status: string }) => x.status)).toEqual(['pending']);
    expect(ov.shipment).toBeNull();

    const before = { t: await total(prod.variantId), m: await movements(prod.variantId) };
    let cur = await ok(boss, s.id, '/start', { version: s.version });
    expect(cur.status).toBe('picking');
    expect((await orderRow(id)).status).toBe('preparing');
    // Separar acima do previsto: recusa e fica no historico.
    const over = await post(boss, s.id, '/pick', { itemId: s.items[0].id, qty: '101' });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe('OVER_EXPECTED');
    // Repetir a mesma chave conta uma vez.
    const k = key();
    for (let i = 0; i < 2; i++) expect((await boss.post(`${SH}/${s.id}/pick`, { itemId: s.items[0].id, qty: '40', requestKey: k })).statusCode).toBe(200);
    cur = await view(s.id);
    expect(cur.items[0].picked_qty).toBe('40.000');
    // Separacoes simultaneas: nunca passam do previsto.
    const rs = await Promise.all(Array.from({ length: 5 }, () => post(boss, s.id, '/pick', { itemId: s.items[0].id, qty: '20' })));
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(3);
    cur = await view(s.id);
    expect(cur.items[0].picked_qty).toBe('100.000');
    expect({ t: await total(prod.variantId), m: await movements(prod.variantId) }).toEqual(before);
    expect((await checks(s.id)).filter((c) => c.kind === 'rejected').length).toBeGreaterThanOrEqual(3);
    // Devolver ao lugar exige motivo e vira novo registro.
    expect((await post(boss, s.id, '/unpick', { itemId: s.items[0].id, qty: '10' })).statusCode).toBe(400);
    cur = await ok(boss, s.id, '/unpick', { itemId: s.items[0].id, qty: '10', note: 'Embalagem amassada' });
    expect(cur.items[0].picked_qty).toBe('90.000');
    const incomplete = await post(boss, s.id, '/finish-picking', { version: cur.version });
    expect(incomplete.json().error.code).toBe('PICKING_INCOMPLETE');
    expect(await reconcile()).toEqual([]);
    // O historico nao muda nem some.
    expect((await pgError(appRole.query('DELETE FROM shipment_checks WHERE shipment_id = $1', [s.id]))).code).toBe('42501');
    expect((await pgError(appRole.query(`UPDATE shipment_checks SET qty = 0 WHERE shipment_id = $1`, [s.id]))).code).toBe('42501');
    expect((await pgError(owner.query(`UPDATE shipment_checks SET qty = 0 WHERE shipment_id = $1`, [s.id]))).message).toBeTruthy();
    expect((await pgError(owner.query(`DELETE FROM shipment_events WHERE shipment_id = $1`, [s.id]))).message).toBeTruthy();
  });

  it('o teto por alocação está no banco: duas remessas não usam a mesma quantidade', async () => {
    const prod = await newProduct('500');
    const id = await paidOrder([{ pack: prod.pack50, packs: 1 }]);
    const s = await allocated(id);
    const it = (await owner.query('SELECT allocation_id, order_item_id, variant_id FROM shipment_items WHERE shipment_id = $1', [s.id])).rows[0];
    const other = (await owner.query(`INSERT INTO shipments (order_id, seq, kind, status, warehouse_id) VALUES ($1, 2, 'pickup', 'pending', $2) RETURNING id`, [id, principal])).rows[0].id;
    const e = await pgError(
      appRole.query('INSERT INTO shipment_items (shipment_id, allocation_id, order_item_id, variant_id, base_qty) VALUES ($1, $2, $3, $4, 1)', [other, it.allocation_id, it.order_item_id, it.variant_id]),
    );
    expect(e.constraint).toBe('shipment_items_over');
    await owner.query(`UPDATE shipments SET status = 'canceled', canceled_at = now(), cancel_reason = 'teste' WHERE id = $1`, [other]);
  });
});

describe('conferência, embalagem e despacho', () => {
  it('confere por SKU, recusa SKU de fora e quantidade acima, corrige por novo registro; despacho baixa só a remessa, uma vez', async () => {
    const prod = await newProduct('500');
    const id = await paidOrder([{ pack: prod.pack50, packs: 3 }]);
    let s = await allocated(id);
    s = await ok(boss, s.id, '/start', { version: s.version });
    s = await ok(boss, s.id, '/pick', { itemId: s.items[0].id, qty: '150' });
    s = await ok(boss, s.id, '/finish-picking', { version: s.version });
    expect(s.status).toBe('checking');
    const wrong = await post(boss, s.id, '/check', { sku: 'NAO-EXISTE', qty: '1' });
    expect(wrong.json().error.code).toBe('WRONG_SKU');
    const above = await post(boss, s.id, '/check', { sku: prod.sku.toLowerCase(), qty: '151' });
    expect(above.json().error.code).toBe('OVER_EXPECTED');
    s = await ok(boss, s.id, '/check', { sku: prod.sku.toLowerCase(), qty: '100' });
    // Engano: conferiu 100 e eram 90. Desfaz 10 com motivo, sem apagar o registro anterior.
    s = await ok(boss, s.id, '/check-undo', { itemId: s.items[0].id, qty: '10', note: 'Contei dois pacotes a mais' });
    expect(s.items[0].checked_qty).toBe('90.000');
    const early = await post(boss, s.id, '/pack', { version: s.version, packages: [{ weightG: 2000 }] });
    expect(early.json().error.code).toBe('CHECK_INCOMPLETE');
    s = await ok(boss, s.id, '/check', { sku: prod.sku, qty: '60' });
    expect((await checks(s.id)).map((c) => `${c.kind}:${c.result}:${Number(c.qty)}`)).toEqual([
      'pick:ok:150',
      'rejected:wrong_sku:1',
      'rejected:over:151',
      'check:ok:100',
      'check_undo:corrected:10',
      'check:ok:60',
    ]);
    s = await ok(boss, s.id, '/pack', { version: s.version, packages: [{ weightG: 2000, lengthMm: 300, widthMm: 200, heightMm: 100 }, { weightG: 500 }] });
    expect(s).toMatchObject({ status: 'packed', volumes: 2, weight_g: 2500 });
    expect((await orderRow(id)).status).toBe('ready');
    expect(await reconcile()).toEqual([]);

    // Entrega com transportadora (o teste usa a retirada; troca o tipo da remessa).
    await owner.query(`UPDATE shipments SET kind = 'delivery' WHERE id = $1`, [s.id]);
    const noInvoice = await post(boss, s.id, '/dispatch', { version: s.version, carrier: 'Correios' });
    expect(noInvoice.json().error.code).toBe('INVOICE_REQUIRED');
    expect(await total(prod.variantId)).toMatchObject({ on_hand: '500.000', reserved: '150.000' });
    await authorize(id);
    // Dois despachos simultaneos com chaves diferentes: um passa, o outro recusa (versao/situacao).
    const [ka, kb] = [key(), key()];
    const [a, b] = await Promise.all([
      boss.post(`${SH}/${s.id}/dispatch`, { version: s.version, carrier: 'Correios', trackingCode: 'AA111BR', requestKey: ka }),
      boss.post(`${SH}/${s.id}/dispatch`, { version: s.version, carrier: 'Correios', trackingCode: 'AA111BR', requestKey: kb }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    // Qualquer um dos dois pode ganhar a corrida: a chave que repete e a de quem passou.
    const [won, lost] = a.statusCode === 200 ? [ka, kb] : [kb, ka];
    // Repetir com a mesma chave devolve a remessa sem baixar de novo.
    const again = await boss.post(`${SH}/${s.id}/dispatch`, { version: s.version, carrier: 'Correios', requestKey: won });
    expect(again.statusCode).toBe(200);
    // A chave recusada nao despachou nada; repetir continua recusando, sem baixar.
    expect((await boss.post(`${SH}/${s.id}/dispatch`, { version: s.version, carrier: 'Correios', requestKey: lost })).statusCode).toBe(409);
    expect(await total(prod.variantId)).toMatchObject({ on_hand: '350.000', reserved: '0.000' });
    const sale = (await owner.query(`SELECT on_hand_delta, document_ref FROM stock_movements WHERE variant_id = $1 AND kind = 'sale'`, [prod.variantId])).rows;
    expect(sale).toEqual([{ on_hand_delta: '-150.000', document_ref: s.id }]);
    expect(await orderRow(id)).toMatchObject({ status: 'shipped', logistics_status: 'shipped' });
    expect((await owner.query('SELECT status FROM fulfillments WHERE order_id = $1', [id])).rows).toEqual([{ status: 'done' }]);
    expect(await reconcile()).toEqual([]);
    // Entrega pela remessa; o botao antigo recusa.
    const ov = (await boss.get(`/api/v1/admin/orders/${id}`)).json().order;
    expect((await boss.post(`/api/v1/admin/orders/${id}/deliver`, { version: ov.version })).json().error.code).toBe('SHIPMENT_DRIVEN');
    const shipped = await view(s.id);
    await ok(boss, s.id, '/deliver', { version: shipped.version });
    expect(await orderRow(id)).toMatchObject({ status: 'delivered', logistics_status: 'completed' });
    expect(await reconcile()).toEqual([]);
  });

  it('conferente diferente do separador, quando ligado', async () => {
    const prod = await newProduct('500');
    const id = await paidOrder([{ pack: prod.pack50, packs: 1 }]);
    let s = await allocated(id);
    s = await ok(boss, s.id, '/start', { version: s.version });
    s = await ok(boss, s.id, '/pick', { itemId: s.items[0].id, qty: '50' });
    s = await ok(boss, s.id, '/finish-picking', { version: s.version });
    const on = await boss.put(`${SH}/settings/distinct-checker`, { enabled: true, version: await settingsVersion() });
    expect(on.statusCode, on.body).toBe(200);
    expect((await post(boss, s.id, '/check', { sku: prod.sku, qty: '50' })).json().error.code).toBe('DISTINCT_CHECKER');
    const st = await loggedAs(app, 'stock');
    await ok(st, s.id, '/check', { sku: prod.sku, qty: '50' });
    await boss.put(`${SH}/settings/distinct-checker`, { enabled: false, version: await settingsVersion() });
  });
});

describe('falta, troca de origem e cancelamento', () => {
  it('falta na separação manda para análise sem movimento; com mercadoria separada a troca é recusada', async () => {
    const prod = await newProduct('500');
    const id = await paidOrder([{ pack: prod.pack50, packs: 2 }]);
    let s = await allocated(id);
    s = await ok(boss, s.id, '/start', { version: s.version });
    // Com a separacao iniciada, trocar ou desfazer a alocacao e recusado.
    const row = await orderRow(id);
    const undo = await boss.post(`${L}/orders/${id}/allocation/cancel`, { logisticsVersion: row.logistics_version, reason: 'Teste', requestKey: key() });
    expect(undo.json().error.code).toBe('SHIPMENT_IN_PROGRESS');
    s = await ok(boss, s.id, '/pick', { itemId: s.items[0].id, qty: '70' });
    const m = await movements(prod.variantId);
    s = await ok(boss, s.id, '/shortage', { itemId: s.items[0].id, found: '70', note: 'Prateleira com 70' });
    expect(s.status).toBe('pending');
    const o = await orderRow(id);
    expect(o.logistics_status).toBe('analysis');
    expect(o.logistics_note).toContain('Falta na separação');
    expect(await movements(prod.variantId)).toBe(m);
    expect((await owner.query(`SELECT kind FROM allocation_decisions WHERE order_id = $1 ORDER BY id`, [id])).rows.map((r) => r.kind)).toEqual(['manual', 'shortage']);
    // Nova alocacao recusada enquanto ha mercadoria separada (nao libera reserva de mercadoria fisicamente separada).
    expect((await allocate(id)).json().error.code).toBe('SHIPMENT_IN_PROGRESS');
    s = await ok(boss, s.id, '/unpick', { itemId: s.items[0].id, qty: '70', note: 'Volta para a prateleira' });
    const re = await allocate(id);
    expect(re.statusCode, re.body).toBe(200);
    expect((await shipments(id)).map((x) => `${x.seq}:${x.status}`)).toEqual(['1:canceled', '2:pending']);
    expect(await reconcile()).toEqual([]);
  });

  it('cancelar o pedido: recusa com mercadoria separada; depois cancela as remessas e libera as reservas', async () => {
    const prod = await newProduct('500');
    const id = await paidOrder([{ pack: prod.pack50, packs: 1 }]);
    let s = await allocated(id);
    s = await ok(boss, s.id, '/start', { version: s.version });
    s = await ok(boss, s.id, '/pick', { itemId: s.items[0].id, qty: '50' });
    let v = (await orderRow(id)).version;
    expect((await boss.post(`/api/v1/admin/orders/${id}/cancel`, { reason: 'Desistiu', version: v })).json().error.code).toBe('GOODS_PICKED');
    // Cancelar a remessa tambem pede devolver ao lugar antes.
    expect((await post(boss, s.id, '/cancel', { version: s.version, reason: 'Teste' })).json().error.code).toBe('GOODS_PICKED');
    await ok(boss, s.id, '/unpick', { itemId: s.items[0].id, qty: '50', note: 'Cliente desistiu' });
    v = (await orderRow(id)).version;
    const c = await boss.post(`/api/v1/admin/orders/${id}/cancel`, { reason: 'Desistiu', version: v });
    expect(c.statusCode, c.body).toBe(200);
    expect((await shipments(id)).map((x) => x.status)).toEqual(['canceled']);
    expect(await total(prod.variantId)).toMatchObject({ on_hand: '500.000', reserved: '0.000' });
    expect(await reconcile()).toEqual([]);
  });

  it('cancelamento vindo de fora (marketplace) com mercadoria separada: cancela e registra a devolução ao lugar', async () => {
    const prod = await newProduct('500');
    const id = await paidOrder([{ pack: prod.pack50, packs: 1 }]);
    let s = await allocated(id);
    s = await ok(boss, s.id, '/start', { version: s.version });
    s = await ok(boss, s.id, '/pick', { itemId: s.items[0].id, qty: '30' });
    // Mesmo caminho do cancelamento do marketplace: cancela e devolve as reservas, na transacao da aplicacao.
    await tx(boss.user.id, async (db) => {
      await db.query(`UPDATE orders SET status = 'canceled', canceled_at = now(), cancel_reason = 'Venda cancelada no marketplace' WHERE id = $1`, [id]);
      await releaseOrderReservations(db, null, id);
    });
    expect((await shipments(id)).map((x) => x.status)).toEqual(['canceled']);
    expect((await checks(s.id)).at(-1)).toMatchObject({ kind: 'unpick', note: 'Pedido cancelado: devolver a mercadoria ao lugar' });
    expect(await reconcile()).toEqual([]);
  });
});

describe('remessas múltiplas (travadas por padrão)', () => {
  it('dividir e criar outra remessa são recusados até a validação fiscal; liberado, despacha em partes', async () => {
    const prod = await newProduct('500');
    const id = await paidOrder([{ pack: prod.pack50, packs: 4 }]);
    let s = await allocated(id);
    const split = await post(boss, s.id, '/split', { version: s.version, items: [{ itemId: s.items[0].id, qty: '80' }] });
    expect(split.json().error.code).toBe('MULTI_SHIPMENT_BLOCKED');
    const more = await boss.post(`${SH}/orders/${id}`, { logisticsVersion: (await orderRow(id)).logistics_version, requestKey: key() });
    expect(more.json().error.code).toBe('MULTI_SHIPMENT_BLOCKED');
    // Liberar exige quem validou; sem MFA nao libera.
    expect((await boss.put(`${SH}/settings/multi-shipment`, { status: 'enabled', version: await settingsVersion() })).statusCode).toBe(400);
    const st = await loggedAs(app, 'stock');
    expect((await st.put(`${SH}/settings/multi-shipment`, { status: 'enabled', fiscalValidatorName: 'Contador', version: await settingsVersion() })).statusCode).toBe(403);
    const en = await boss.put(`${SH}/settings/multi-shipment`, { status: 'enabled', fiscalValidatorName: 'Contador Fulano', version: await settingsVersion() });
    expect(en.statusCode, en.body).toBe(200);

    s = await ok(boss, s.id, '/split', { version: s.version, items: [{ itemId: s.items[0].id, qty: '80' }] });
    const [first, second] = await shipments(id);
    expect([first.seq, second.seq, second.status]).toEqual([1, 2, 'pending']);
    await owner.query(`UPDATE shipments SET kind = 'delivery' WHERE order_id = $1`, [id]);
    await authorize(id);
    // WhatsApp: modelo e opt-in para conferir um aviso por remessa.
    await owner.query(`INSERT INTO whatsapp_templates (event, name, language, updated_by) VALUES ('order_shipped', 'pedido_enviado', 'pt_BR', $1) ON CONFLICT (event) DO NOTHING`, [boss.user.id]);
    await owner.query(`UPDATE orders SET whatsapp_optin_at = now() WHERE id = $1`, [id]);

    let p1 = await packOrder(boss, id);
    expect(p1.id).toBe(first.id);
    expect((await ok(boss, first.id, '/dispatch', { version: p1.version, carrier: 'Correios', trackingCode: 'PARTE1BR' })).status).toBe('shipped');
    expect(await total(prod.variantId)).toMatchObject({ on_hand: '380.000', reserved: '80.000' });
    expect(await orderRow(id)).toMatchObject({ status: 'shipped', logistics_status: 'partially_shipped' });
    expect((await owner.query('SELECT status FROM fulfillments WHERE order_id = $1', [id])).rows).toEqual([{ status: 'confirmed' }]);
    expect(await reconcile()).toEqual([]);

    p1 = await packOrder(boss, id);
    expect(p1.id).toBe(second.id);
    await ok(boss, second.id, '/dispatch', { version: p1.version, carrier: 'Correios', trackingCode: 'PARTE2BR' });
    expect(await total(prod.variantId)).toMatchObject({ on_hand: '300.000', reserved: '0.000' });
    expect(await orderRow(id)).toMatchObject({ status: 'shipped', logistics_status: 'shipped' });
    expect((await owner.query('SELECT status FROM fulfillments WHERE order_id = $1', [id])).rows).toEqual([{ status: 'done' }]);
    const msgs = (await owner.query(`SELECT shipment_id, params->>'rastreio' AS rastreio FROM whatsapp_messages WHERE order_id = $1 AND event = 'order_shipped' ORDER BY created_at`, [id])).rows;
    expect(msgs).toEqual([
      { shipment_id: first.id, rastreio: 'PARTE1BR' },
      { shipment_id: second.id, rastreio: 'PARTE2BR' },
    ]);
    // Cancelar o restante depois do despacho continua recusado (D5-11).
    expect((await boss.post(`/api/v1/admin/orders/${id}/cancel`, { reason: 'x y z', version: (await orderRow(id)).version })).json().error.code).toBe('INVALID_TRANSITION');
    let v1 = await view(first.id);
    await ok(boss, first.id, '/deliver', { version: v1.version });
    expect((await orderRow(id)).logistics_status).toBe('partially_delivered');
    v1 = await view(second.id);
    await ok(boss, second.id, '/deliver', { version: v1.version });
    expect(await orderRow(id)).toMatchObject({ status: 'delivered', logistics_status: 'completed' });
    expect(await reconcile()).toEqual([]);
    await boss.put(`${SH}/settings/multi-shipment`, { status: 'blocked', version: await settingsVersion() });
  });
});

describe('encomenda por ordem de pagamento (regra provisória D5-10)', () => {
  it('a mercadoria que chegou vai para a encomenda paga primeiro; a outra aguarda', async () => {
    const prod = await newProduct('0');
    const sup = (await boss.post('/api/v1/admin/suppliers', { name: `Distribuidora ${uid()}`, leadTimeDays: 5 })).json().supplier.id;
    expect((await boss.post(`/api/v1/admin/suppliers/${sup}/offers/item`, { packagingId: prod.purchase.id, costCents: 1500 })).statusCode).toBe(201);
    await owner.query(`UPDATE products SET availability_mode = 'made_to_order' WHERE id = (SELECT product_id FROM product_variants WHERE id = $1)`, [prod.variantId]);
    const first = await paidOrder([{ pack: prod.pack50, packs: 1 }]);
    const second = await paidOrder([{ pack: prod.pack50, packs: 1 }]);
    const s1 = await allocated(first);
    const s2 = await allocated(second);
    expect(s1.items[0].backorder).toBe(true);
    await move(prod.variantId, 'adjustment', '50'); // chegou so para uma
    const a1 = await ok(boss, s1.id, '/start', { version: s1.version });
    const a2 = await ok(boss, s2.id, '/start', { version: s2.version });
    const late = await post(boss, s2.id, '/pick', { itemId: a2.items[0].id, qty: '50' });
    expect(late.json().error.code).toBe('AWAITING_GOODS');
    await ok(boss, s1.id, '/pick', { itemId: a1.items[0].id, qty: '50' });
    // Chegou o resto: a segunda separa.
    await move(prod.variantId, 'adjustment', '50');
    await ok(boss, s2.id, '/pick', { itemId: a2.items[0].id, qty: '50' });
    expect(await reconcile()).toEqual([]);
  });
});

describe('pedido antigo e permissões', () => {
  it('pedido antigo continua com botões e despacho antigos; a remessa pendente é cancelada', async () => {
    const prod = await newProduct('500');
    const id = await paidOrder([{ pack: prod.pack50, packs: 1 }]);
    await allocated(id);
    await owner.query('UPDATE orders SET allocation_required = false WHERE id = $1', [id]);
    let v = (await orderRow(id)).version;
    for (const to of ['preparing', 'ready']) {
      const r = await boss.post(`/api/v1/admin/orders/${id}/status`, { to, version: v });
      expect(r.statusCode, r.body).toBe(200);
      v = r.json().order.version;
    }
    await authorize(id);
    const d = await boss.post(`/api/v1/admin/orders/${id}/dispatch`, { version: v, carrier: 'Próprio' });
    expect(d.statusCode, d.body).toBe(200);
    expect((await shipments(id)).map((x) => `${x.seq}:${x.kind}:${x.status}`)).toEqual(['1:pickup:canceled', '2:legacy:shipped']);
    expect(await total(prod.variantId)).toMatchObject({ on_hand: '450.000', reserved: '0.000' });
    const del = await boss.post(`/api/v1/admin/orders/${id}/deliver`, { version: d.json().order.version });
    expect(del.statusCode, del.body).toBe(200);
    expect((await shipments(id)).at(-1)).toMatchObject({ status: 'delivered' });
    expect(await reconcile()).toEqual([]);
  });

  it('estoquista separa e confere, mas não despacha nem cancela; vendas só vê; financeiro não vê', async () => {
    const prod = await newProduct('500');
    const id = await paidOrder([{ pack: prod.pack50, packs: 1 }]);
    let s = await allocated(id);
    const st = await loggedAs(app, 'stock');
    const sales = await loggedAs(app, 'sales');
    const fin = await loggedAs(app, 'finance');
    const ship = await loggedAs(app, 'shipping');
    expect((await post(sales, s.id, '/start', { version: s.version })).statusCode).toBe(403);
    expect((await post(st, s.id, '/cancel', { version: s.version, reason: 'Teste' })).statusCode).toBe(403);
    expect((await post(ship, s.id, '/cancel', { version: s.version, reason: 'Teste' })).statusCode).toBe(403);
    s = await ok(st, s.id, '/start', { version: s.version });
    s = await ok(st, s.id, '/pick', { itemId: s.items[0].id, qty: '50' });
    s = await ok(st, s.id, '/finish-picking', { version: s.version });
    s = await ok(st, s.id, '/check', { sku: prod.sku, qty: '50' });
    s = await ok(st, s.id, '/pack', { version: s.version, packages: [{ weightG: 900 }] });
    await authorize(id);
    // D5-8: despachar, entregar, liberar e dividir exigem permissao especifica, inclusive pelas rotas antigas do pedido.
    expect((await post(st, s.id, '/dispatch', { version: s.version })).statusCode).toBe(403);
    expect((await post(st, s.id, '/release', { version: s.version })).statusCode).toBe(403);
    expect((await post(st, s.id, '/split', { version: s.version, items: [{ itemId: s.items[0].id, qty: '10' }] })).statusCode).toBe(403);
    const ov = (await boss.get(`/api/v1/admin/orders/${id}`)).json().order;
    expect((await st.post(`/api/v1/admin/orders/${id}/dispatch`, { version: ov.version, carrier: 'X' })).statusCode).toBe(403);
    expect((await st.post(`/api/v1/admin/orders/${id}/deliver`, { version: ov.version })).statusCode).toBe(403);
    expect((await st.post(`/api/v1/admin/orders/${id}/status`, { version: ov.version, status: 'shipped' })).statusCode).toBe(403);
    // Retirada: o despacho e a entrega no balcao (vai direto a entregue). A permissao e checada antes da situacao.
    expect((await post(st, s.id, '/deliver', { version: s.version })).statusCode).toBe(403);
    s = await ok(ship, s.id, '/dispatch', { version: s.version });
    expect(s.status).toBe('delivered');
    expect((await post(st, s.id, '/deliver', { version: s.version })).statusCode).toBe(403);
    expect((await fin.get(`${SH}`)).statusCode).toBe(403);
    expect((await sales.get(`${SH}`)).statusCode).toBe(200);
    expect((await st.get(`${SH}`)).statusCode).toBe(200);
    expect(await reconcile()).toEqual([]);
  });
});

describe('conciliação C10 e C11', () => {
  it('acusa separado fora do histórico (C11) e baixa diferente da remessa (C10)', async () => {
    const prod = await newProduct('500');
    const id = await paidOrder([{ pack: prod.pack50, packs: 1 }]);
    let s = await allocated(id);
    s = await ok(boss, s.id, '/start', { version: s.version });
    s = await ok(boss, s.id, '/pick', { itemId: s.items[0].id, qty: '20' });
    expect(await reconcile()).toEqual([]);
    // Separado mexido por fora do historico.
    await owner.query('UPDATE shipment_items SET picked_qty = picked_qty + 5 WHERE id = $1', [s.items[0].id]);
    expect((await reconcile()).map((d) => `${d.check_code}:${d.field}:${Number(d.expected)}:${Number(d.found)}`)).toEqual(['C11:picked:20:25']);
    await owner.query('UPDATE shipment_items SET picked_qty = picked_qty - 5 WHERE id = $1', [s.items[0].id]);

    s = await ok(boss, s.id, '/pick', { itemId: s.items[0].id, qty: '30' });
    s = await ok(boss, s.id, '/finish-picking', { version: s.version });
    s = await ok(boss, s.id, '/check', { sku: prod.sku, qty: '50' });
    s = await ok(boss, s.id, '/pack', { version: s.version, packages: [{ weightG: 900 }] });
    await owner.query(`UPDATE shipments SET kind = 'delivery' WHERE id = $1`, [s.id]);
    await authorize(id);
    await ok(boss, s.id, '/dispatch', { version: s.version, carrier: 'Correios' });
    expect(await reconcile()).toEqual([]);
    // Item despachado diferente da baixa registrada com o documento da remessa.
    await owner.query('ALTER TABLE shipment_items DISABLE TRIGGER shipment_items_check');
    await owner.query('UPDATE shipment_items SET base_qty = 49, checked_qty = 49, picked_qty = 49 WHERE id = $1', [s.items[0].id]);
    const divs = (await reconcile()).map((d) => d.check_code);
    expect(divs).toContain('C10');
    await owner.query('UPDATE shipment_items SET base_qty = 50, picked_qty = 50, checked_qty = 50 WHERE id = $1', [s.items[0].id]);
    await owner.query('ALTER TABLE shipment_items ENABLE TRIGGER shipment_items_check');
    expect(await reconcile()).toEqual([]);
  });
});
