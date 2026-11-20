import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FakeProvider } from '../src/lib/payments.js';
import { allocatePending } from '../src/modules/logistics.js';
import { appRole, loggedAs, makeApp, ORIGIN, owner, productPayload, randomIp, resetCatalog, uid } from './helpers.js';

// SGLog Fase 4 (docs/23-sglog-fase4.md): alocacao dos pedidos pagos em deposito ou fornecedor, reservas por deposito,
// concorrencia, cancelamentos, encomenda, trava do dropshipping, falta descoberta, permissoes e conciliacao C1-C9.

let app: FastifyInstance;
let fake: FakeProvider;
let boss: Awaited<ReturnType<typeof loggedAs>>; // gerente com MFA
let pickupId: string;
let principal: string;

beforeAll(async () => {
  fake = new FakeProvider();
  app = await makeApp(undefined, fake);
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

const S = '/api/v1/admin/stock';
const L = '/api/v1/admin/logistics';
const key = () => `k-${uid()}-${uid()}`;
const buyer = { kind: 'pf', name: 'Maria Confeiteira', email: 'maria@teste.local', phone: '47999990000', document: '529.982.247-25' };

type Pack = { id: string; kind: string; label: string; base_qty: string };
async function newProduct(stock = '0') {
  const res = await boss.post('/api/v1/admin/products', productPayload());
  expect(res.statusCode, res.body).toBe(201);
  const v = res.json().product.variants[0];
  if (stock !== '0') await move(v.id, 'adjustment', stock);
  const packs = v.packagings as Pack[];
  return { variantId: v.id as string, pack50: packs.find((k) => k.label === 'Pacote com 50')!, purchase: packs.find((k) => k.kind === 'purchase')! };
}
async function move(variantId: string, kind: 'adjustment' | 'loss', qty: string, warehouseId?: string) {
  const r = await boss.post(`${S}/movements`, { variantId, kind, qty, reason: 'Teste da Fase 4', requestKey: key(), ...(warehouseId ? { warehouseId } : {}) });
  expect(r.statusCode, r.body).toBe(201);
}
/** Inventario do padrao que encontra `qty` da variante (fecha a contagem). */
async function countTo(variantId: string, qty: string) {
  const I = '/api/v1/admin/inventory-counts';
  const inv = await boss.post(I, { variantIds: [variantId], warehouseId: principal });
  expect(inv.statusCode, inv.body).toBe(201);
  await boss.put(`${I}/${inv.json().count.id}/items`, [{ variantId, countedQty: qty }]);
  const closed = await boss.post(`${I}/${inv.json().count.id}/close`);
  expect(closed.statusCode, closed.body).toBe(200);
}
async function newWarehouse(priority?: number) {
  const r = await boss.post('/api/v1/admin/warehouses', { code: `G${uid()}`.slice(0, 12).toUpperCase(), name: `Galpão ${uid()}`, ...(priority === undefined ? {} : { allocationPriority: priority }) });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().warehouse.id as string;
}
/** Leva saldo do padrao para outro deposito (envio e recebimento). */
async function transfer(to: string, variantId: string, qty: string) {
  const s = await boss.post('/api/v1/admin/stock-transfers', { fromWarehouseId: principal, toWarehouseId: to, items: [{ variantId, qty }], requestKey: key() });
  expect(s.statusCode, s.body).toBe(201);
  const r = await boss.post(`/api/v1/admin/stock-transfers/${s.json().transfer.id}/receive`, { requestKey: key() });
  expect(r.statusCode, r.body).toBe(200);
}
async function newSupplier() {
  const r = await boss.post('/api/v1/admin/suppliers', { name: `Distribuidora ${uid()}`, leadTimeDays: 5 });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().supplier.id as string;
}
async function newOffer(supplierId: string, packagingId: string, extra: Record<string, unknown> = {}) {
  const r = await boss.post(`/api/v1/admin/suppliers/${supplierId}/offers/item`, { packagingId, costCents: 2000, ...extra });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().offer.id as string;
}

/** Pedido pela loja, pago com cartao no provedor de teste. Itens: [pacote de 50, quantidade de pacotes]. */
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
  (await owner.query('SELECT status, version, logistics_status, logistics_note, logistics_version, allocation_required, paid_at FROM orders WHERE id = $1', [id])).rows[0];
const lv = async (id: string) => (await orderRow(id)).logistics_version as number;
const detail = async (id: string, c = boss) => {
  const r = await c.get(`${L}/orders/${id}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const confirm = (id: string, body: Record<string, unknown>, c = boss) => c.post(`${L}/orders/${id}/allocation`, { requestKey: key(), ...body });
async function confirmRecommended(id: string, c = boss) {
  const d = await detail(id, c);
  const r = await confirm(id, { logisticsVersion: d.order.logistics_version, planKey: d.proposal.recommended.key }, c);
  expect(r.statusCode, r.body).toBe(200);
  return d;
}
const reservations = async (orderId: string) =>
  (
    await owner.query(
      `SELECT variant_id, qty, backorder, warehouse_id, allocation_id, status FROM stock_reservations WHERE source_type = 'order' AND source_id = $1 ORDER BY created_at, id`,
      [orderId],
    )
  ).rows;
const active = async (orderId: string) => (await reservations(orderId)).filter((r) => r.status === 'active');
const loc = async (warehouseId: string, variantId: string) =>
  (await owner.query('SELECT on_hand, reserved FROM stock_location_balances WHERE warehouse_id = $1 AND variant_id = $2', [warehouseId, variantId])).rows[0] ?? { on_hand: '0.000', reserved: '0.000' };
const total = async (variantId: string) => (await owner.query('SELECT on_hand, reserved FROM stock_balances WHERE variant_id = $1', [variantId])).rows[0];
const decisions = async (orderId: string) => (await owner.query('SELECT kind, justification, request_key FROM allocation_decisions WHERE order_id = $1 ORDER BY id', [orderId])).rows;

type Rec = { check_code: string; field: string | null; variant_id: string | null; expected: string; found: string };
async function reconcile() {
  const rows = (await appRole.query<Rec>('SELECT check_code, field, variant_id, expected, found FROM stock_reconcile()')).rows;
  expect(rows.find((r) => r.check_code === 'run')).toBeDefined();
  return rows.filter((r) => r.check_code !== 'run');
}
const pgError = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err as { code?: string; constraint?: string; message: string };
  }
  throw new Error('a operacao deveria ter sido recusada');
};
async function toReady(id: string) {
  let v = (await orderRow(id)).version;
  for (const to of ['preparing', 'ready']) {
    const r = await boss.post(`/api/v1/admin/orders/${id}/status`, { to, version: v });
    expect(r.statusCode, r.body).toBe(200);
    v = r.json().order.version;
  }
  await owner.query(`UPDATE orders SET invoice_status = 'authorized' WHERE id = $1`, [id]);
  return v as number;
}

describe('elegibilidade e compatibilidade', () => {
  it('pagamento só torna o pedido elegível; pedido antigo despacha como antes, o novo só com alocação', async () => {
    const { variantId, pack50 } = await newProduct('500');
    const id = await paidOrder([{ pack: pack50, packs: 2 }]);
    expect(await orderRow(id)).toMatchObject({ status: 'paid', logistics_status: 'awaiting', allocation_required: true, logistics_version: 1 });
    // A reserva do checkout ja esta no padrao, explicita, sem alocacao.
    expect(await active(id)).toMatchObject([{ variant_id: variantId, qty: '100.000', warehouse_id: principal, allocation_id: null, backorder: false }]);

    const v = await toReady(id);
    const blocked = await boss.post(`/api/v1/admin/orders/${id}/dispatch`, { version: v, carrier: 'Próprio' });
    expect(blocked.json().error.code).toBe('ALLOCATION_REQUIRED');

    // Pedido anterior a 0023 (sem exigencia): despacha como antes, sem alocacao.
    const old = await paidOrder([{ pack: pack50, packs: 1 }]);
    await owner.query(`UPDATE orders SET allocation_required = false, logistics_status = NULL WHERE id = $1`, [old]);
    const vOld = await toReady(old);
    const sent = await boss.post(`/api/v1/admin/orders/${old}/dispatch`, { version: vOld, carrier: 'Próprio', volumes: 1 });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(await orderRow(old)).toMatchObject({ status: 'shipped', logistics_status: 'shipped' });
    expect(await reconcile()).toEqual([]);
  });
});

describe('alocação manual e reserva por depósito', () => {
  it('confirma a recomendada no padrão: liga a reserva à alocação sem movimento, despacha e fecha o atendimento', async () => {
    const { variantId, pack50 } = await newProduct('500');
    const id = await paidOrder([{ pack: pack50, packs: 3 }]);
    const movesBefore = (await owner.query('SELECT count(*)::int AS n FROM stock_movements WHERE variant_id = $1', [variantId])).rows[0].n;
    const d = await detail(id);
    expect(d.proposal).toMatchObject({ automatic: true, recommended: { key: `stock:${principal}` } });
    expect(d.proposal.criteria.length).toBeGreaterThan(3);
    const r = await confirm(id, { logisticsVersion: d.order.logistics_version, planKey: d.proposal.recommended.key });
    expect(r.statusCode, r.body).toBe(200);
    expect(await orderRow(id)).toMatchObject({ status: 'paid', logistics_status: 'processing', logistics_version: 2 });
    const res = await active(id);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ qty: '150.000', warehouse_id: principal });
    expect(res[0].allocation_id).not.toBeNull();
    expect((await owner.query('SELECT count(*)::int AS n FROM stock_movements WHERE variant_id = $1', [variantId])).rows[0].n).toBe(movesBefore);
    // Decisao com entrada, saida e escolha.
    const dec = (await owner.query('SELECT kind, engine_version, input, output, chosen FROM allocation_decisions WHERE order_id = $1', [id])).rows;
    expect(dec).toHaveLength(1);
    expect(dec[0]).toMatchObject({ kind: 'manual', engine_version: 'f4.1', chosen: { planKey: `stock:${principal}`, recommended: true } });
    expect(dec[0].input.warehouses.length).toBeGreaterThan(0);
    expect(dec[0].output.warehouses[0]).toMatchObject({ id: principal, coversAll: true });
    expect(await reconcile()).toEqual([]);

    const v = await toReady(id);
    const sent = await boss.post(`/api/v1/admin/orders/${id}/dispatch`, { version: v, carrier: 'Próprio', volumes: 1 });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(await orderRow(id)).toMatchObject({ status: 'shipped', logistics_status: 'shipped' });
    expect((await owner.query(`SELECT status FROM fulfillments WHERE order_id = $1`, [id])).rows).toEqual([{ status: 'done' }]);
    expect((await decisions(id)).map((x) => x.kind)).toEqual(['manual', 'shipped']);
    expect(await total(variantId)).toMatchObject({ on_hand: '350.000', reserved: '0.000' });
    expect(await reconcile()).toEqual([]);
  });

  it('padrão sem saldo e outro depósito com tudo: troca a reserva de depósito na mesma transação; o total não muda', async () => {
    const g = await newWarehouse(10);
    const { variantId, pack50 } = await newProduct('300');
    await transfer(g, variantId, '200');
    // Pedido de 150: padrao tem 100 livres, G tem 200.
    const id = await paidOrder([{ pack: pack50, packs: 3 }]);
    expect(await loc(principal, variantId)).toMatchObject({ on_hand: '100.000', reserved: '150.000' });
    const d = await detail(id);
    expect(d.proposal.recommended.key).toBe(`stock:${g}`);
    expect(d.proposal.warehouses.find((w: { id: string }) => w.id === principal)).toMatchObject({ coversAll: false });
    const totalBefore = await total(variantId);
    const r = await confirm(id, { logisticsVersion: await lv(id), planKey: `stock:${g}` });
    expect(r.statusCode, r.body).toBe(200);
    expect(await total(variantId)).toEqual(totalBefore);
    expect(await loc(principal, variantId)).toMatchObject({ on_hand: '100.000', reserved: '0.000' });
    expect(await loc(g, variantId)).toMatchObject({ on_hand: '200.000', reserved: '150.000' });
    const res = await reservations(id);
    expect(res.map((x) => [x.status, x.warehouse_id === g])).toEqual([
      ['released', false],
      ['active', true],
    ]);
    expect(await reconcile()).toEqual([]);
    // Despacho baixa do deposito da reserva.
    const v = await toReady(id);
    expect((await boss.post(`/api/v1/admin/orders/${id}/dispatch`, { version: v, carrier: 'Próprio' })).statusCode).toBe(200);
    expect(await loc(g, variantId)).toMatchObject({ on_hand: '50.000', reserved: '0.000' });
    expect(await reconcile()).toEqual([]);
  });

  it('troca de origem exige motivo e preserva o histórico; desfazer mantém a reserva e manda para análise', async () => {
    const g = await newWarehouse(20);
    const { variantId, pack50 } = await newProduct('400');
    await transfer(g, variantId, '200');
    const id = await paidOrder([{ pack: pack50, packs: 2 }]);
    await confirmRecommended(id); // padrao
    // Opcao nao recomendada sem motivo: recusa.
    const d = await detail(id);
    expect(d.proposal.alternatives.map((p: { key: string }) => p.key)).toContain(`stock:${g}`);
    const noWhy = await confirm(id, { logisticsVersion: d.order.logistics_version, planKey: `stock:${g}` });
    expect(noWhy.json().error.code).toBe('JUSTIFICATION_REQUIRED');
    const stale = await confirm(id, { logisticsVersion: 0, planKey: `stock:${g}`, justification: 'Cliente retira no galpão' });
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
    const ch = await confirm(id, { logisticsVersion: d.order.logistics_version, planKey: `stock:${g}`, justification: 'Cliente retira no galpão' });
    expect(ch.statusCode, ch.body).toBe(200);
    expect((await owner.query('SELECT status, cancel_reason FROM fulfillments WHERE order_id = $1 ORDER BY created_at', [id])).rows).toEqual([
      { status: 'canceled', cancel_reason: 'Cliente retira no galpão' },
      { status: 'confirmed', cancel_reason: null },
    ]);
    expect(await loc(g, variantId)).toMatchObject({ reserved: '100.000' });
    expect(await reconcile()).toEqual([]);

    // Desfazer: exige motivo; nada volta para outra venda; pedido em analise.
    const now = await orderRow(id);
    const totalBefore = await total(variantId);
    const bad = await boss.post(`${L}/orders/${id}/allocation/cancel`, { logisticsVersion: now.logistics_version, requestKey: key() });
    expect(bad.statusCode).toBe(400);
    const rk = key();
    const und = await boss.post(`${L}/orders/${id}/allocation/cancel`, { logisticsVersion: now.logistics_version, reason: 'Conferir embalagem', requestKey: rk });
    expect(und.statusCode, und.body).toBe(200);
    // Repetir a mesma chamada nao faz nada de novo.
    const again = await boss.post(`${L}/orders/${id}/allocation/cancel`, { logisticsVersion: now.logistics_version, reason: 'Conferir embalagem', requestKey: rk });
    expect(again.json()).toEqual({ replayed: true });
    expect(await total(variantId)).toEqual(totalBefore);
    expect(await active(id)).toMatchObject([{ qty: '100.000', warehouse_id: g, allocation_id: null }]);
    expect(await orderRow(id)).toMatchObject({ logistics_status: 'analysis', logistics_note: 'Alocação desfeita: Conferir embalagem' });
    expect((await decisions(id)).map((x) => x.kind)).toEqual(['manual', 'change', 'detach']);
    // Despacho volta a exigir alocacao.
    const v = await toReady(id);
    expect((await boss.post(`/api/v1/admin/orders/${id}/dispatch`, { version: v })).json().error.code).toBe('ALLOCATION_REQUIRED');
    expect(await reconcile()).toEqual([]);
    // O historico nao pode ser apagado nem alterado, nem pela aplicacao.
    expect((await pgError(appRole.query('DELETE FROM allocation_decisions WHERE order_id = $1', [id]))).code).toBe('42501');
    expect((await pgError(appRole.query(`UPDATE allocation_decisions SET justification = 'x' WHERE order_id = $1`, [id]))).code).toBe('42501');
    expect((await pgError(owner.query(`UPDATE allocation_decisions SET justification = 'x' WHERE order_id = $1`, [id]))).message).toBeTruthy();
  });

  it('um depósito por pedido: itens em depósitos diferentes vão para análise e a divisão manual é recusada', async () => {
    const g = await newWarehouse(30);
    const a = await newProduct('100');
    const b = await newProduct('100');
    await transfer(g, b.variantId, '100'); // padrao: A; G: B
    const id = await paidOrder([
      { pack: a.pack50, packs: 1 },
      { pack: b.pack50, packs: 1 },
    ]);
    const d = await detail(id);
    expect(d.proposal.automatic).toBe(false);
    expect(d.proposal.analysisReason).toContain('Nenhum depósito cobre o pedido inteiro');
    expect(d.proposal.suggestions.join(' ')).toContain('Transferir');
    const [ia, ib] = [d.items.find((i: { variant_id: string }) => i.variant_id === a.variantId), d.items.find((i: { variant_id: string }) => i.variant_id === b.variantId)];
    const split = await confirm(id, {
      logisticsVersion: await lv(id),
      justification: 'Dividir',
      lines: [
        { orderItemId: ia.id, qty: '50', mode: 'stock', warehouseId: principal },
        { orderItemId: ib.id, qty: '50', mode: 'stock', warehouseId: g },
      ],
    });
    expect(split.json().error.code).toBe('ONE_WAREHOUSE');
    const partial = await confirm(id, { logisticsVersion: await lv(id), justification: 'Faltando', lines: [{ orderItemId: ia.id, qty: '50', mode: 'stock', warehouseId: principal }] });
    expect(partial.json().error.code).toBe('ALLOCATION_INCOMPLETE');
    // Tudo no padrao: B nao tem saldo la. Recusa sem mexer em nada.
    const before = await reservations(id);
    const short = await confirm(id, {
      logisticsVersion: await lv(id),
      justification: 'Forçar',
      lines: [
        { orderItemId: ia.id, qty: '50', mode: 'stock', warehouseId: principal },
        { orderItemId: ib.id, qty: '50', mode: 'stock', warehouseId: principal },
      ],
    });
    expect(short.json().error.code).toBe('INSUFFICIENT_STOCK');
    expect(await reservations(id)).toEqual(before);
    expect((await decisions(id)).length).toBe(0);
    expect(await reconcile()).toEqual([]);
  });
});

describe('concorrência e idempotência', () => {
  it('duas confirmações simultâneas: uma vence, a outra recebe conflito; mesma chave não grava duas vezes', async () => {
    const { pack50 } = await newProduct('500');
    const id = await paidOrder([{ pack: pack50, packs: 2 }]);
    const d = await detail(id);
    const body = { logisticsVersion: await lv(id), planKey: d.proposal.recommended.key };
    const rs = await Promise.all([confirm(id, body), confirm(id, body), confirm(id, body)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    expect(rs.filter((r) => r.statusCode === 409).every((r) => r.json().error.code === 'VERSION_CONFLICT')).toBe(true);
    expect(await active(id)).toHaveLength(1);

    const id2 = await paidOrder([{ pack: pack50, packs: 1 }]);
    const d2 = await detail(id2);
    const same = { logisticsVersion: await lv(id2), planKey: d2.proposal.recommended.key, requestKey: key() };
    const rs2 = await Promise.all([boss.post(`${L}/orders/${id2}/allocation`, same), boss.post(`${L}/orders/${id2}/allocation`, same)]);
    expect(rs2.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(rs2.filter((r) => r.json().replayed).length).toBe(1);
    expect((await decisions(id2)).length).toBe(1);
    // Chave de outro pedido nao serve.
    expect((await boss.post(`${L}/orders/${id}/allocation`, same)).json().error.code).toBe('REQUEST_KEY_REUSED');
    expect(await reconcile()).toEqual([]);
  });

  it('pedidos concorrentes pelo mesmo saldo: nunca reservam além do físico do depósito', async () => {
    const g = await newWarehouse(40);
    const { variantId, pack50 } = await newProduct('200');
    await transfer(g, variantId, '100');
    // Dois pedidos de 100 cada: padrao tem 100 e G tem 100. Os dois disputam G depois de o padrao ficar com um.
    const a = await paidOrder([{ pack: pack50, packs: 2 }]);
    const b = await paidOrder([{ pack: pack50, packs: 2 }]);
    const lines = async (id: string) => {
      const d = await detail(id);
      return { logisticsVersion: d.order.logistics_version, justification: 'Galpão', lines: d.items.map((i: { id: string }) => ({ orderItemId: i.id, qty: '100', mode: 'stock', warehouseId: g })) };
    };
    const [la, lb] = [await lines(a), await lines(b)];
    const rs = await Promise.all([confirm(a, la), confirm(b, lb)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(rs.find((r) => r.statusCode === 409)!.json().error.code).toBe('INSUFFICIENT_STOCK');
    expect(await loc(g, variantId)).toMatchObject({ on_hand: '100.000', reserved: '100.000' });
    expect(await total(variantId)).toMatchObject({ on_hand: '200.000', reserved: '200.000' });
    expect(await reconcile()).toEqual([]);
  });
});

describe('encomenda ao fornecedor e dropshipping', () => {
  it('falta no estoque com fornecedor: parte própria e parte por encomenda no padrão; despacha só depois da chegada', async () => {
    const { variantId, pack50, purchase } = await newProduct('60');
    const sup = await newSupplier();
    const offer = await newOffer(sup, purchase.id, { costCents: 1500 });
    // Sob encomenda para o checkout aceitar mais do que o saldo.
    await owner.query(`UPDATE products SET availability_mode = 'made_to_order' WHERE id = (SELECT product_id FROM product_variants WHERE id = $1)`, [variantId]);
    const id = await paidOrder([{ pack: pack50, packs: 3 }]); // 150: 60 proprio + 90 encomenda
    const d = await detail(id);
    expect(d.proposal).toMatchObject({ automatic: false });
    expect(d.proposal.recommended.key).toBe(`order:${principal}:${offer}`);
    expect(d.proposal.recommended.lines.map((l: { mode: string; qty: number }) => [l.mode, l.qty])).toEqual([
      ['stock', 60],
      ['purchase_to_order', 90],
    ]);
    const r = await confirm(id, { logisticsVersion: d.order.logistics_version, planKey: d.proposal.recommended.key });
    expect(r.statusCode, r.body).toBe(200);
    const res = await active(id);
    expect(res.map((x) => [x.qty, x.backorder, x.warehouse_id === principal]).sort((p, q) => Number(p[1]) - Number(q[1]))).toEqual([
      ['60.000', false, true],
      ['90.000', true, true],
    ]);
    const f = (await owner.query('SELECT source_kind, mode, supplier_id FROM fulfillments WHERE order_id = $1 ORDER BY mode', [id])).rows;
    expect(f).toEqual([
      { source_kind: 'supplier', mode: 'purchase_to_order', supplier_id: sup },
      { source_kind: 'own', mode: 'stock', supplier_id: null },
    ]);
    expect(await reconcile()).toEqual([]);
    // Sem a mercadoria: o despacho nao baixa estoque que nao existe.
    const v = await toReady(id);
    const early = await boss.post(`/api/v1/admin/orders/${id}/dispatch`, { version: v, carrier: 'Próprio' });
    expect(early.statusCode).toBe(409);
    expect(await total(variantId)).toMatchObject({ on_hand: '60.000' });
    // Chegou (entrada no padrao): despacha.
    await move(variantId, 'adjustment', '90');
    const sent = await boss.post(`/api/v1/admin/orders/${id}/dispatch`, { version: v, carrier: 'Próprio' });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(await total(variantId)).toMatchObject({ on_hand: '0.000', reserved: '0.000' });
    expect(await reconcile()).toEqual([]);
  });

  it('dropshipping travado no banco e na API; liberar exige quem validou; marketplace só com estoque próprio', async () => {
    const { variantId, pack50, purchase } = await newProduct('0');
    const sup = await newSupplier();
    const offer = await newOffer(sup, purchase.id, { dropshipAllowed: true });
    await owner.query(`UPDATE products SET availability_mode = 'made_to_order' WHERE id = (SELECT product_id FROM product_variants WHERE id = $1)`, [variantId]);
    const id = await paidOrder([{ pack: pack50, packs: 1 }]);
    const d = await detail(id);
    expect(d.dropshipStatus).toBe('blocked');
    expect(d.proposal.suggestions.join(' ')).toContain('Dropshipping indisponível');
    const item = d.items[0].id;
    const drop = await confirm(id, { logisticsVersion: await lv(id), justification: 'Direto', lines: [{ orderItemId: item, qty: '50', mode: 'dropship', offerId: offer }] });
    expect(drop.json().error.code).toBe('DROPSHIP_BLOCKED');
    // Banco recusa mesmo por fora da API.
    const dec = (await owner.query(`INSERT INTO allocation_decisions (order_id, kind) VALUES ($1, 'manual') RETURNING id`, [id])).rows[0].id;
    const err = await pgError(
      owner.query(`INSERT INTO fulfillments (order_id, source_kind, mode, supplier_id, decision_id) VALUES ($1, 'supplier', 'dropship', $2, $3)`, [id, sup, dec]),
    );
    expect(err.constraint ?? err.message).toContain('logistics_dropship_blocked');
    // Liberar: so com settings.manage e o nome de quem validou.
    const s = (await boss.get(`${L}/settings`)).json().settings;
    expect((await boss.put(`${L}/settings/dropship`, { status: 'enabled', version: s.version })).statusCode).toBe(400);
    const lg = await loggedAs(app, 'logistics');
    expect((await lg.put(`${L}/settings/dropship`, { status: 'enabled', fiscalValidatorName: 'Contadora', version: s.version })).statusCode).toBe(403);

    // Marketplace: so estoque proprio, mesmo com oferta de fornecedor.
    const mk = await paidOrder([{ pack: pack50, packs: 1 }]);
    await owner.query(`UPDATE orders SET channel = 'mercadolivre' WHERE id = $1`, [mk]);
    const dm = await detail(mk);
    expect(dm.proposal.recommended).toBeNull();
    expect(dm.proposal.excluded[0].reasons[0]).toContain('marketplace');
    const viaSup = await confirm(mk, { logisticsVersion: await lv(mk), justification: 'Pelo fornecedor', lines: [{ orderItemId: dm.items[0].id, qty: '50', mode: 'purchase_to_order', offerId: offer }] });
    expect(viaSup.json().error.code).toBe('OWN_STOCK_ONLY');
  });
});

describe('cancelamentos', () => {
  it('cancelar pedido alocado libera a reserva uma vez, encerra o atendimento e registra; repetir não libera de novo', async () => {
    const { variantId, pack50 } = await newProduct('300');
    const id = await paidOrder([{ pack: pack50, packs: 2 }]);
    await confirmRecommended(id);
    const v = (await orderRow(id)).version;
    const rs = await Promise.all([
      boss.post(`/api/v1/admin/orders/${id}/cancel`, { reason: 'Cliente desistiu', version: v }),
      boss.post(`/api/v1/admin/orders/${id}/cancel`, { reason: 'Cliente desistiu', version: v }),
    ]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await orderRow(id)).toMatchObject({ status: 'canceled', logistics_status: 'canceled' });
    expect(await active(id)).toEqual([]);
    expect(await total(variantId)).toMatchObject({ on_hand: '300.000', reserved: '0.000' });
    expect((await owner.query(`SELECT status FROM fulfillments WHERE order_id = $1`, [id])).rows).toEqual([{ status: 'canceled' }]);
    expect((await decisions(id)).map((x) => x.kind)).toEqual(['manual', 'order_canceled']);
    // Fora de ordem: desfazer ou confirmar depois do cancelamento nao faz nada.
    const o = await orderRow(id);
    expect((await boss.post(`${L}/orders/${id}/allocation/cancel`, { logisticsVersion: o.logistics_version, reason: 'Tarde', requestKey: key() })).json().error.code).toBe('NOT_ALLOCATED');
    expect((await confirm(id, { logisticsVersion: o.logistics_version, planKey: `stock:${principal}` })).json().error.code).toBe('NOT_ALLOCATABLE');
    // Cancelamento repetido por outra via (ex.: marketplace) depois: a funcao comum nao libera de novo.
    const again = await boss.post(`/api/v1/admin/orders/${id}/cancel`, { reason: 'De novo', version: o.version });
    expect(again.statusCode).toBe(409);
    expect(await total(variantId)).toMatchObject({ reserved: '0.000' });
    expect(await reconcile()).toEqual([]);
  });

  it('cancelar com alocação desfeita ou em análise também libera tudo, sem sobrar reserva', async () => {
    const { variantId, pack50 } = await newProduct('300');
    const id = await paidOrder([{ pack: pack50, packs: 2 }]);
    await confirmRecommended(id);
    const o = await orderRow(id);
    expect((await boss.post(`${L}/orders/${id}/allocation/cancel`, { logisticsVersion: o.logistics_version, reason: 'Rever', requestKey: key() })).statusCode).toBe(200);
    const c = await boss.post(`/api/v1/admin/orders/${id}/cancel`, { reason: 'Cliente desistiu', version: (await orderRow(id)).version });
    expect(c.statusCode, c.body).toBe(200);
    expect(await active(id)).toEqual([]);
    expect(await total(variantId)).toMatchObject({ reserved: '0.000' });
    expect(await reconcile()).toEqual([]);
  });
});

describe('falta descoberta e rotina', () => {
  it('perda que descobre a reserva de pedido alocado: volta para análise com o motivo, sem cancelar nem liberar', async () => {
    const { variantId, pack50 } = await newProduct('100');
    const id = await paidOrder([{ pack: pack50, packs: 2 }]);
    await confirmRecommended(id);
    // Contagem do padrao achou 40 (fechamento e saida que nao e venda): a reserva firme de 100 fica descoberta.
    const I = '/api/v1/admin/inventory-counts';
    const inv = await boss.post(I, { variantIds: [variantId], warehouseId: principal });
    expect(inv.statusCode, inv.body).toBe(201);
    await boss.put(`${I}/${inv.json().count.id}/items`, [{ variantId, countedQty: '40' }]);
    const closed = await boss.post(`${I}/${inv.json().count.id}/close`);
    expect(closed.statusCode, closed.body).toBe(200);
    const o = await orderRow(id);
    expect(o).toMatchObject({ status: 'paid', logistics_status: 'analysis' });
    expect(o.logistics_note).toContain('Falta descoberta');
    expect((await decisions(id)).map((x) => x.kind)).toEqual(['manual', 'shortage']);
    // Nada cancelado nem liberado: a reserva continua do pedido.
    expect(await active(id)).toHaveLength(1);
    expect(await loc(principal, variantId)).toMatchObject({ on_hand: '40.000', reserved: '100.000' });
    expect(await reconcile()).toEqual([]);
  });

  it('depois da falta, a nova alocação (estoque + encomenda) substitui o atendimento anterior', async () => {
    const { variantId, pack50, purchase } = await newProduct('100');
    const sup = await newSupplier();
    const offer = await newOffer(sup, purchase.id, { costCents: 1500 });
    const id = await paidOrder([{ pack: pack50, packs: 2 }]);
    await confirmRecommended(id);
    const I = '/api/v1/admin/inventory-counts';
    const inv = await boss.post(I, { variantIds: [variantId], warehouseId: principal });
    expect(inv.statusCode, inv.body).toBe(201);
    await boss.put(`${I}/${inv.json().count.id}/items`, [{ variantId, countedQty: '60' }]);
    expect((await boss.post(`${I}/${inv.json().count.id}/close`)).statusCode).toBe(200);
    expect(await orderRow(id)).toMatchObject({ logistics_status: 'analysis' });

    const d = await detail(id);
    expect(d.proposal.recommended.key).toBe(`order:${principal}:${offer}`);
    expect(d.proposal.recommended.lines.map((l: { mode: string; qty: number }) => [l.mode, l.qty])).toEqual([
      ['stock', 60],
      ['purchase_to_order', 40],
    ]);
    const body = { logisticsVersion: d.order.logistics_version, planKey: d.proposal.recommended.key, requestKey: key() };
    const r = await confirm(id, body);
    expect(r.statusCode, r.body).toBe(200);
    expect(await orderRow(id)).toMatchObject({ logistics_status: 'processing', logistics_note: null });
    expect((await decisions(id)).map((x) => x.kind)).toEqual(['manual', 'shortage', 'manual']);
    // O atendimento anterior fica encerrado com o motivo; valem os dois novos.
    const f = (await owner.query('SELECT mode, status, cancel_reason FROM fulfillments WHERE order_id = $1 ORDER BY created_at, mode', [id])).rows;
    expect(f).toHaveLength(3);
    expect(f[0]).toMatchObject({ mode: 'stock', status: 'canceled' });
    expect(f[0].cancel_reason).toContain('Falta descoberta');
    expect(f.slice(1).map((x) => [x.mode, x.status]).sort()).toEqual([
      ['purchase_to_order', 'confirmed'],
      ['stock', 'confirmed'],
    ]);
    const act = (await owner.query(`SELECT count(*)::int AS n FROM fulfillment_allocations WHERE order_id = $1 AND status = 'active'`, [id])).rows[0].n;
    expect(act).toBe(2);
    const res = await active(id);
    expect(res.map((x) => [x.qty, x.backorder]).sort((p, q) => Number(p[1]) - Number(q[1]))).toEqual([
      ['60.000', false],
      ['40.000', true],
    ]);
    expect(await loc(principal, variantId)).toMatchObject({ on_hand: '60.000', reserved: '100.000' });
    expect(await reconcile()).toEqual([]);
    // Repetir a mesma confirmacao nao age de novo.
    const again = await confirm(id, body);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true });
    expect((await decisions(id)).length).toBe(3);
    expect((await owner.query('SELECT count(*)::int AS n FROM fulfillments WHERE order_id = $1', [id])).rows[0].n).toBe(3);
    // Situacao comercial e financeira intactas.
    expect(await orderRow(id)).toMatchObject({ status: 'paid' });
    expect((await owner.query('SELECT status FROM payments WHERE order_id = $1', [id])).rows.map((p) => p.status)).toEqual(['approved']);
  });

  it('encomenda em pedido nunca alocado, produto de pronta entrega: estoque + fornecedor confirma', async () => {
    // Isola a encomenda da falta descoberta: o pedido nunca teve atendimento.
    const { variantId, pack50, purchase } = await newProduct('100');
    const sup = await newSupplier();
    const offer = await newOffer(sup, purchase.id, { costCents: 1500 });
    const id = await paidOrder([{ pack: pack50, packs: 2 }]);
    // O fisico cai antes da alocacao (pedido aguardando: nao e falta de pedido alocado).
    await countTo(variantId, '70');
    expect(await orderRow(id)).toMatchObject({ logistics_status: 'awaiting' });
    const d = await detail(id);
    expect(d.proposal.recommended.key).toBe(`order:${principal}:${offer}`);
    const r = await confirm(id, { logisticsVersion: d.order.logistics_version, planKey: d.proposal.recommended.key });
    expect(r.statusCode, r.body).toBe(200);
    expect(await orderRow(id)).toMatchObject({ status: 'paid', logistics_status: 'processing' });
    expect((await active(id)).map((x) => [x.qty, x.backorder]).sort((p, q) => Number(p[1]) - Number(q[1]))).toEqual([
      ['70.000', false],
      ['30.000', true],
    ]);
    expect(await reconcile()).toEqual([]);
  });

  it('falha no meio da realocação desfaz tudo: atendimento, alocação e reservas anteriores ficam como estavam', async () => {
    const { variantId, pack50 } = await newProduct('100');
    const id = await paidOrder([{ pack: pack50, packs: 2 }]);
    await confirmRecommended(id);
    await countTo(variantId, '40');
    expect(await orderRow(id)).toMatchObject({ logistics_status: 'analysis' });
    const snap = async () => ({
      f: (await owner.query('SELECT id, status, cancel_reason FROM fulfillments WHERE order_id = $1 ORDER BY id', [id])).rows,
      a: (await owner.query('SELECT id, status FROM fulfillment_allocations WHERE order_id = $1 ORDER BY id', [id])).rows,
      r: await reservations(id),
      d: await decisions(id),
      o: await orderRow(id),
      l: await loc(principal, variantId),
    });
    const before = await snap();
    // Estoque proprio de 100 com 40 no deposito: encerra o atendimento, depois a reserva falha.
    const d = await detail(id);
    const r = await confirm(id, { logisticsVersion: d.order.logistics_version, justification: 'Forçar falha', lines: [{ orderItemId: d.items[0].id, qty: '100', mode: 'stock', warehouseId: principal }] });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe('INSUFFICIENT_STOCK');
    expect(await snap()).toEqual(before);
    expect(before.f.map((x: { status: string }) => x.status)).toEqual(['confirmed']);
    expect(await reconcile()).toEqual([]);
  });

  it('depois da falta e da reposição, realocar no mesmo depósito reaproveita a reserva sem duplicar', async () => {
    const { variantId, pack50 } = await newProduct('100');
    const id = await paidOrder([{ pack: pack50, packs: 2 }]);
    await confirmRecommended(id);
    const [oldRes] = await active(id);
    await countTo(variantId, '40');
    await move(variantId, 'adjustment', '60');
    const d = await confirmRecommended(id);
    expect(d.proposal.recommended.lines.map((l: { mode: string; qty: number }) => [l.mode, l.qty])).toEqual([['stock', 100]]);
    const now = await active(id);
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ qty: '100.000', backorder: false, warehouse_id: principal });
    expect(now[0].allocation_id).not.toBe(oldRes.allocation_id);
    const live = (await owner.query(`SELECT id FROM fulfillment_allocations WHERE order_id = $1 AND status = 'active'`, [id])).rows;
    expect(live.map((x) => x.id)).toEqual([now[0].allocation_id]);
    expect(await loc(principal, variantId)).toMatchObject({ on_hand: '100.000', reserved: '100.000' });
    expect(await reconcile()).toEqual([]);
  });

  it('rotina: desligada só separa os de análise; ligada confirma o caso simples; erro não mexe no pagamento', async () => {
    const simple = await newProduct('500');
    const none = await newProduct('0');
    await owner.query(`UPDATE products SET availability_mode = 'made_to_order' WHERE id = (SELECT product_id FROM product_variants WHERE id = $1)`, [none.variantId]);
    const a = await paidOrder([{ pack: simple.pack50, packs: 1 }]);
    const b = await paidOrder([{ pack: none.pack50, packs: 1 }]);
    const off = await allocatePending({ auto: false, limit: 100 });
    expect(off.failed).toBe(0);
    expect(await orderRow(a)).toMatchObject({ status: 'paid', logistics_status: 'awaiting' });
    const rb = await orderRow(b);
    expect(rb).toMatchObject({ status: 'paid', logistics_status: 'analysis' });
    expect(rb.logistics_note).toContain('Nenhum depósito cobre');
    expect((await decisions(b)).map((x) => x.kind)).toEqual(['analysis']);
    // Rodar de novo nao repete a decisao (b ja saiu da fila; a so volta depois do intervalo).
    await allocatePending({ auto: false, limit: 100 });
    expect((await decisions(b)).length).toBe(1);
    await owner.query(`UPDATE orders SET logistics_checked_at = NULL WHERE id = $1`, [a]);
    const on = await allocatePending({ auto: true, limit: 100 });
    expect(on.allocated).toBeGreaterThanOrEqual(1);
    expect(await orderRow(a)).toMatchObject({ status: 'paid', logistics_status: 'processing' });
    expect((await decisions(a)).map((x) => x.kind)).toEqual(['auto']);
    // Pagamento intacto.
    expect((await owner.query(`SELECT status FROM payments WHERE order_id = $1`, [a])).rows.map((p) => p.status)).toContain('approved');
    expect(await reconcile()).toEqual([]);
  });
});

describe('permissões (D4-11)', () => {
  it('estoquista e comprador veem; financeiro não; só gerente e logística confirmam; custo só para quem já vê custo', async () => {
    const { pack50, purchase, variantId } = await newProduct('20');
    const sup = await newSupplier();
    await newOffer(sup, purchase.id, { costCents: 1234 });
    await owner.query(`UPDATE products SET availability_mode = 'made_to_order' WHERE id = (SELECT product_id FROM product_variants WHERE id = $1)`, [variantId]);
    const id = await paidOrder([{ pack: pack50, packs: 1 }]);
    const fin = await loggedAs(app, 'finance');
    expect((await fin.get(`${L}/queue`)).statusCode).toBe(403);
    expect((await fin.get(`${L}/orders/${id}`)).statusCode).toBe(403);
    for (const role of ['stock', 'buyer', 'shipping', 'sales']) {
      const c = await loggedAs(app, role);
      expect((await c.get(`${L}/queue`)).statusCode, role).toBe(200);
      expect((await c.post(`${L}/orders/${id}/allocation`, { logisticsVersion: 0, planKey: 'x', requestKey: key() })).statusCode, role).toBe(403);
    }
    const sales = await loggedAs(app, 'sales');
    const hidden = JSON.stringify((await sales.get(`${L}/orders/${id}`)).json());
    expect(hidden).not.toContain('unitCostCents');
    expect(hidden).not.toContain('supplierCostCents');
    const shown = JSON.stringify(await detail(id));
    expect(shown).toContain('supplierCostCents');
    const lg = await loggedAs(app, 'logistics');
    const d = await detail(id, lg);
    expect((await confirm(id, { logisticsVersion: d.order.logistics_version, planKey: d.proposal.recommended.key }, lg)).statusCode).toBe(200);
    const q = (await lg.get(`${L}/queue?status=processing`)).json();
    expect(q.items.some((i: { id: string }) => i.id === id)).toBe(true);
    expect(q.auto).toBe(false);
  });
});
