import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FakeProvider } from '../src/lib/payments.js';
import { appRole, ensureCompany, loggedAs, makeApp, ORIGIN, owner, productPayload, randomIp, resetCatalog, sendPurchase, uid } from './helpers.js';

// SGLog Fase 6 (docs/29-sglog-fase6.md): compras com aprovacao e pagamento informado, recebimento no destino com
// recusa, divergencias e preco, vinculo encomenda x compra, conversao da encomenda (fila, vinculo, reprocessamento,
// antecipacao), concorrencia, idempotencia, recuperacao de falhas, permissoes, MFA e conciliacao C12-C13.

let app: FastifyInstance;
let boss: Awaited<ReturnType<typeof loggedAs>>; // gerente com MFA: cria e recebe
let approver: Awaited<ReturnType<typeof loggedAs>>; // outro gerente com MFA: aprova
let pickupId: string;
let principal: string;

beforeAll(async () => {
  app = await makeApp(undefined, new FakeProvider());
  await resetCatalog();
  boss = await loggedAs(app, 'manager', { mfa: true });
  approver = await loggedAs(app, 'manager', { mfa: true });
  const p = await boss.post('/api/v1/admin/shipping-options', { name: 'Retirada na loja', kind: 'pickup', description: 'Centro', baseCents: 0, minDays: 0, maxDays: 1 });
  expect(p.statusCode, p.body).toBe(201);
  pickupId = p.json().option.id;
  principal = (await owner.query('SELECT id FROM warehouses WHERE is_default')).rows[0].id;
  await ensureCompany();
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

const PO = '/api/v1/admin/purchase-orders';
const L = '/api/v1/admin/logistics';
const BO = '/api/v1/admin/backorders';
const SH = '/api/v1/admin/shipments';
const key = () => `k-${uid()}-${uid()}`;
const buyer = { kind: 'pf', name: 'Maria Confeiteira', email: 'maria@teste.local', phone: '47999990000', document: '529.982.247-25' };

type Pack = { id: string; kind: string; label: string; base_qty: string };
type Client = typeof boss;

async function newProduct(opts: { madeToOrder?: boolean } = {}) {
  const res = await boss.post('/api/v1/admin/products', productPayload());
  expect(res.statusCode, res.body).toBe(201);
  const v = res.json().product.variants[0];
  const packs = v.packagings as Pack[];
  if (opts.madeToOrder) await owner.query(`UPDATE products SET availability_mode = 'made_to_order' WHERE id = (SELECT product_id FROM product_variants WHERE id = $1)`, [v.id]);
  return { variantId: v.id as string, pack50: packs.find((k) => k.label === 'Pacote com 50')!, purchase: packs.find((k) => k.kind === 'purchase')! };
}
async function newSupplier(purchasePackId?: string, costCents = 2000) {
  const s = await boss.post('/api/v1/admin/suppliers', { name: `Distribuidora ${uid()}`, leadTimeDays: 5 });
  expect(s.statusCode, s.body).toBe(201);
  const id = s.json().supplier.id as string;
  if (purchasePackId) expect((await boss.post(`/api/v1/admin/suppliers/${id}/offers/item`, { packagingId: purchasePackId, costCents })).statusCode).toBe(201);
  return id;
}
async function newWarehouse() {
  // Fase 7: o pedido ao fornecedor exige o endereco de entrega do deposito de destino.
  const r = await boss.post('/api/v1/admin/warehouses', {
    code: `G${uid()}`.slice(0, 12).toUpperCase(),
    name: `Galpão ${uid()}`,
    cep: '89460000',
    street: 'Rua do Galpão',
    number: '10',
    district: 'Industrial',
    city: 'Canoinhas',
    uf: 'SC',
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().warehouse.id as string;
}
async function createPO(supplierId: string, items: Record<string, unknown>[], extra: Record<string, unknown> = {}, c: Client = boss) {
  const r = await c.post(PO, { supplierId, items, ...extra });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().order;
}
async function sentPO(supplierId: string, items: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  const o = await createPO(supplierId, items, extra);
  const s = await sendPurchase(app, boss, o.id);
  expect(s.statusCode, s.body).toBe(200);
  return s.json().order;
}
const receive = (id: string, items: Record<string, unknown>[], extra: Record<string, unknown> = {}, c: Client = boss) =>
  c.post(`${PO}/${id}/receipts`, { requestKey: key(), items, ...extra });

async function paidOrder(pack: Pack, packs: number) {
  const jar: Record<string, string> = {};
  const ip = randomIp();
  const send = async (method: 'GET' | 'POST', url: string, payload?: object) => {
    const res = await app.inject({ method, url, remoteAddress: ip, headers: { origin: ORIGIN }, cookies: { ...jar }, ...(payload ? { payload } : {}) });
    for (const c of res.cookies) if (c.value) jar[c.name] = c.value;
    return res;
  };
  expect((await send('POST', '/api/v1/public/cart/items', { packagingId: pack.id, packs })).statusCode).toBeLessThan(300);
  const cart = (await send('GET', '/api/v1/public/cart')).json().cart;
  const placed = await send('POST', '/api/v1/public/checkout', { requestKey: `pedido-${uid()}`, buyer, shippingOptionId: pickupId, paymentMethod: 'card', expectedTotalCents: cart.subtotalCents });
  expect(placed.statusCode, placed.body).toBe(201);
  const o = placed.json().order as { id: string; token: string };
  const paid = await send('POST', `/api/v1/public/orders/${o.token}/pay/card`, { attemptKey: randomUUID(), token: 'approve-1', paymentMethodId: 'visa', installments: 1, payer: { email: 'm@teste.local' } });
  expect(paid.statusCode, paid.body).toBe(200);
  return o.id;
}
/** Pedido pago de produto sob encomenda, alocado como "comprar para atender": reserva de encomenda no padrao. */
async function backorder(pack: Pack, packs: number) {
  const id = await paidOrder(pack, packs);
  const d = (await boss.get(`${L}/orders/${id}`)).json();
  const r = await boss.post(`${L}/orders/${id}/allocation`, { requestKey: key(), logisticsVersion: d.order.logistics_version, planKey: d.proposal.recommended.key });
  expect(r.statusCode, r.body).toBe(200);
  const res = await reservations(id);
  expect(res.every((x) => x.backorder)).toBe(true);
  return id;
}
const reservations = async (orderId: string) =>
  (
    await owner.query<{ id: string; qty: string; backorder: boolean; allocation_id: string | null; warehouse_id: string | null }>(
      `SELECT id, qty, backorder, allocation_id, warehouse_id FROM stock_reservations WHERE source_type = 'order' AND source_id = $1 AND status = 'active' ORDER BY created_at, id`,
      [orderId],
    )
  ).rows;
const conversions = async (orderId: string) => (await owner.query('SELECT rule, qty, receipt_id, justification FROM reservation_conversions WHERE order_id = $1', [orderId])).rows;
const location = async (variantId: string, wh = principal) =>
  (await owner.query('SELECT on_hand, blocked, damaged FROM stock_location_balances WHERE variant_id = $1 AND warehouse_id = $2', [variantId, wh])).rows[0];
const balance = async (variantId: string) => (await owner.query('SELECT on_hand, reserved, blocked, damaged, avg_cost_cents FROM stock_balances WHERE variant_id = $1', [variantId])).rows[0];
type Rec = { check_code: string; field: string | null; expected: string; found: string };
async function reconcile() {
  const rows = (await appRole.query<Rec>('SELECT check_code, field, expected, found FROM stock_reconcile()')).rows;
  return rows.filter((r) => r.check_code !== 'run');
}
const setSettings = (approvalMinCents: number, priceTolerancePct: number) => boss.put(`${PO}/settings`, { approvalMinCents, priceTolerancePct });

describe('aprovação e pagamento informado (D6-3, D6-4, D6-5)', () => {
  it('limite 0: toda compra passa por aprovação; quem cria não aprova; outro gerente com MFA aprova; só aprovada é enviada', async () => {
    const { purchase } = await newProduct();
    const sup = await newSupplier(purchase.id);
    const o = await createPO(sup, [{ packagingId: purchase.id, packs: '2' }]);
    expect(o).toMatchObject({ status: 'draft', purpose: 'replenishment', warehouse_id: principal });
    expect((await boss.post(`${PO}/${o.id}/send`)).json().error.code).toBe('APPROVAL_REQUIRED');
    const sub = await boss.post(`${PO}/${o.id}/submit`);
    expect(sub.statusCode, sub.body).toBe(200);
    expect(sub.json().order.status).toBe('pending_approval');
    expect((await boss.post(`${PO}/${o.id}/send`)).json().error.code).toBe('APPROVAL_REQUIRED');
    // Quem criou nao aprova (nem com justificativa, por nao ser o proprietario).
    expect((await boss.post(`${PO}/${o.id}/approve`, { note: 'Urgente' })).json().error.code).toBe('SELF_APPROVAL');
    // Sem MFA, a permissao de aprovar nao vale.
    const noMfa = await loggedAs(app, 'manager');
    expect((await noMfa.post(`${PO}/${o.id}/approve`, {})).json().error.code).toBe('MFA_REQUIRED');
    // Comprador nao aprova.
    expect((await (await loggedAs(app, 'buyer')).post(`${PO}/${o.id}/approve`, {})).statusCode).toBe(403);
    const ap = await approver.post(`${PO}/${o.id}/approve`, {});
    expect(ap.statusCode, ap.body).toBe(200);
    expect(ap.json().order).toMatchObject({ status: 'approved', approval_self: false });
    expect(ap.json().order.approved_by).toBe(approver.user.id);
    const sent = await boss.post(`${PO}/${o.id}/send`);
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json().order.events.map((e: { kind: string }) => e.kind)).toEqual(['submitted', 'approved', 'sent']);
  });

  it('proprietário aprova a própria compra só com justificativa, marcada e auditada; devolver exige motivo', async () => {
    const { purchase } = await newProduct();
    const sup = await newSupplier(purchase.id);
    const own = await loggedAs(app, 'owner', { mfa: true });
    const o = await createPO(sup, [{ packagingId: purchase.id, packs: '1' }], {}, own);
    expect((await own.post(`${PO}/${o.id}/submit`)).statusCode).toBe(200);
    expect((await own.post(`${PO}/${o.id}/approve`, {})).json().error.code).toBe('JUSTIFICATION_REQUIRED');
    const ok = await own.post(`${PO}/${o.id}/approve`, { note: 'Fornecedor único, compra urgente' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().order).toMatchObject({ status: 'approved', approval_self: true, approval_note: 'Fornecedor único, compra urgente' });
    const aud = (await owner.query(`SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY id`, [o.id])).rows.map((r) => r.action);
    expect(aud).toContain('purchases.approved_self');

    const o2 = await createPO(sup, [{ packagingId: purchase.id, packs: '1' }]);
    await boss.post(`${PO}/${o2.id}/submit`);
    expect((await approver.post(`${PO}/${o2.id}/reject-approval`, {})).statusCode).toBe(400);
    const back = await approver.post(`${PO}/${o2.id}/reject-approval`, { reason: 'Quantidade errada' });
    expect(back.json().order.status).toBe('draft');
    expect(back.json().order.events.at(-1)).toMatchObject({ kind: 'approval_rejected', note: 'Quantidade errada' });
  });

  it('editar compra aprovada volta para rascunho; enviada só muda previsão e observação', async () => {
    const { purchase } = await newProduct();
    const sup = await newSupplier(purchase.id);
    const o = await createPO(sup, [{ packagingId: purchase.id, packs: '1' }]);
    await boss.post(`${PO}/${o.id}/submit`);
    const ap = (await approver.post(`${PO}/${o.id}/approve`, {})).json().order;
    const ed = await boss.put(`${PO}/${o.id}`, { supplierId: sup, items: [{ packagingId: purchase.id, packs: '5' }], version: ap.version });
    expect(ed.statusCode, ed.body).toBe(200);
    expect(ed.json().order).toMatchObject({ status: 'draft', approved_at: null, approved_by: null });
    expect(ed.json().order.items[0].id).toBe(o.items[0].id); // item atualizado, nao recriado
    expect(ed.json().order.events.at(-1).kind).toBe('back_to_draft');
    const s = (await sendPurchase(app, boss, o.id)).json().order;
    expect((await boss.put(`${PO}/${o.id}`, { supplierId: sup, items: [{ packagingId: purchase.id, packs: '9' }], version: s.version })).json().error.code).toBe('ORDER_LOCKED');
    const n = await boss.put(`${PO}/${o.id}`, { supplierId: sup, notes: 'Chega na terça', expectedAt: '2027-01-05', items: [{ packagingId: purchase.id, packs: '5' }], version: s.version });
    expect(n.statusCode, n.body).toBe(200);
    expect(n.json().order).toMatchObject({ status: 'sent', notes: 'Chega na terça', expected_at: '2027-01-05' });
  });

  it('abaixo do limite configurado aprova sozinho; o limite exige settings.manage com MFA', async () => {
    const { purchase } = await newProduct();
    const sup = await newSupplier(purchase.id);
    expect((await (await loggedAs(app, 'manager')).put(`${PO}/settings`, { approvalMinCents: 1, priceTolerancePct: 0 })).json().error.code).toBe('MFA_REQUIRED');
    expect((await setSettings(100_000, 0)).statusCode).toBe(200);
    const o = await createPO(sup, [{ packagingId: purchase.id, packs: '1' }]); // R$ 20,00
    const sub = (await boss.post(`${PO}/${o.id}/submit`)).json().order;
    expect(sub).toMatchObject({ status: 'approved', approved_by: null, approval_note: 'Abaixo do limite de aprovação' });
    expect((await boss.post(`${PO}/${o.id}/send`)).statusCode).toBe(200);
    const big = await createPO(sup, [{ packagingId: purchase.id, packs: '60' }]); // R$ 1.200,00
    expect((await boss.post(`${PO}/${big.id}/submit`)).json().order.status).toBe('pending_approval');
    expect((await setSettings(0, 0)).statusCode).toBe(200);
  });

  it('financeiro informa pagamento sem aprovar; é registro, não confirmação do provedor', async () => {
    const { purchase } = await newProduct();
    const sup = await newSupplier(purchase.id);
    const o = await createPO(sup, [{ packagingId: purchase.id, packs: '1' }]);
    await boss.post(`${PO}/${o.id}/submit`);
    const fin = await loggedAs(app, 'finance');
    expect((await fin.post(`${PO}/${o.id}/approve`, {})).statusCode).toBe(403);
    expect((await fin.post(`${PO}/${o.id}/payment`, { paidOn: '2026-11-20', amountCents: 2000 })).json().error.code).toBe('INVALID_STATUS');
    await approver.post(`${PO}/${o.id}/approve`, {});
    const pay = await fin.post(`${PO}/${o.id}/payment`, { paidOn: '2026-11-20', amountCents: 2000, reference: 'PIX 123' });
    expect(pay.statusCode, pay.body).toBe(200);
    expect(pay.json().order).toMatchObject({ status: 'approved', payment_informed_on: '2026-11-20', payment_informed_ref: 'PIX 123' });
    expect(pay.json().order.events.at(-1)).toMatchObject({ kind: 'payment_informed', data: { confirmedByProvider: false } });
    // Pagamento informado nao toca em pagamentos de clientes nem muda o status da compra.
    expect((await owner.query(`SELECT count(*)::int AS n FROM payments WHERE order_id::text = $1`, [o.id])).rows[0].n).toBe(0);
    expect((await fin.post(`${PO}/${o.id}/receipts`, { requestKey: key(), items: [] })).statusCode).toBe(403);
    expect((await boss.post(`${PO}/${o.id}/payment`, { paidOn: '2026-11-20', amountCents: 2000 })).statusCode).toBe(200); // gerente tambem
    expect((await (await loggedAs(app, 'buyer')).post(`${PO}/${o.id}/payment`, { paidOn: '2026-11-20', amountCents: 1 })).statusCode).toBe(403);
  });
});

describe('recebimento no destino, recusa, divergências e preço (D6-6, D6-7, D6-12)', () => {
  it('total e parcial; estoquista e logística recebem, comprador não; excedente recusado', async () => {
    const { variantId, purchase } = await newProduct();
    const sup = await newSupplier(purchase.id);
    const o = await sentPO(sup, [{ packagingId: purchase.id, packs: '3' }]);
    const item = o.items[0].id;
    expect((await receive(o.id, [{ itemId: item, packs: '1' }], {}, await loggedAs(app, 'buyer'))).statusCode).toBe(403);
    const r1 = await receive(o.id, [{ itemId: item, packs: '1' }], {}, await loggedAs(app, 'stock'));
    expect(r1.statusCode, r1.body).toBe(201);
    expect(r1.json().order.status).toBe('partial');
    const r2 = await receive(o.id, [{ itemId: item, packs: '2' }], {}, await loggedAs(app, 'logistics'));
    expect(r2.statusCode, r2.body).toBe(201);
    expect(r2.json().order.status).toBe('received');
    expect((await location(variantId)).on_hand).toBe('300.000');
    const o2 = await sentPO(sup, [{ packagingId: purchase.id, packs: '1' }]);
    expect((await receive(o2.id, [{ itemId: o2.items[0].id, packs: '2' }])).json().error.code).toBe('OVER_RECEIPT');
    expect(await reconcile()).toEqual([]);
  });

  it('recebe só no destino: outro depósito é recusado pela API e pelo banco', async () => {
    const { variantId, purchase } = await newProduct();
    const sup = await newSupplier(purchase.id);
    const other = await newWarehouse();
    const o = await sentPO(sup, [{ packagingId: purchase.id, packs: '1' }], { warehouseId: other });
    expect(o.warehouse_id).toBe(other);
    expect((await receive(o.id, [{ itemId: o.items[0].id, packs: '1' }], { warehouseId: principal })).json().error.code).toBe('WRONG_WAREHOUSE');
    // Caminho antigo (sem deposito): o banco usa o destino; depósito diferente o banco recusa.
    await expect(
      appRole.query('INSERT INTO purchase_receipts (order_id, request_key, received_by, warehouse_id) VALUES ($1, $2, $3, $4)', [o.id, key(), boss.user.id, principal]),
    ).rejects.toThrow(/destino/);
    const ok = await receive(o.id, [{ itemId: o.items[0].id, packs: '1' }]);
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await location(variantId, other)).on_hand).toBe('100.000');
    expect(await location(variantId)).toBeUndefined();
    expect(await reconcile()).toEqual([]);
  });

  it('recusado por qualidade vai para avariado ou bloqueado, nunca para o disponível; recebido x aceito separados', async () => {
    const { variantId, purchase } = await newProduct();
    const sup = await newSupplier(purchase.id);
    const o = await sentPO(sup, [{ packagingId: purchase.id, packs: '4' }]);
    const item = o.items[0].id;
    expect((await receive(o.id, [{ itemId: item, packs: '2', rejectedPacks: '1' }])).json().error.code).toBe('REJECT_DETAILS_REQUIRED');
    expect((await receive(o.id, [{ itemId: item, packs: '1', rejectedPacks: '2', rejectedDestination: 'damaged', rejectedReason: 'Amassado' }])).json().error.code).toBe('REJECT_OVER');
    const r = await receive(o.id, [{ itemId: item, packs: '2', rejectedPacks: '1', rejectedDestination: 'damaged', rejectedReason: 'Caixa molhada' }]);
    expect(r.statusCode, r.body).toBe(201);
    expect(await location(variantId)).toMatchObject({ on_hand: '100.000', damaged: '100.000', blocked: '0.000' });
    const r2 = await receive(o.id, [{ itemId: item, packs: '2', rejectedPacks: '1', rejectedDestination: 'blocked', rejectedReason: 'Aguardando laudo' }]);
    expect(r2.statusCode, r2.body).toBe(201);
    expect(await location(variantId)).toMatchObject({ on_hand: '200.000', damaged: '100.000', blocked: '100.000' });
    const it = r2.json().order.items[0];
    expect([it.received_packs, it.rejected_packs]).toEqual(['4.000', '2.000']);
    expect(r2.json().order.status).toBe('received'); // D6-7: recusado conta como entregue
    expect(r2.json().order.issues.map((x: { kind: string; destination: string }) => [x.kind, x.destination])).toEqual([
      ['quality', 'damaged'],
      ['quality', 'blocked'],
    ]);
    // Custo medio igual para o aceito e o recusado (o recusado fica no estoque, fora do disponivel).
    expect((await balance(variantId)).avg_cost_cents).toBe('20.0000');
    await expect(owner.query('UPDATE purchase_receipt_issues SET note = $1', ['x'])).rejects.toThrow();
    expect(await reconcile()).toEqual([]);
  });

  it('preço da nota: tolerância configurável; acima exige justificativa, registra divergência e o custo médio usa o real', async () => {
    const { variantId, purchase } = await newProduct();
    const sup = await newSupplier(purchase.id, 2000);
    const o = await sentPO(sup, [{ packagingId: purchase.id, packs: '2' }]);
    const item = o.items[0].id;
    const no = await receive(o.id, [{ itemId: item, packs: '1', invoicedPackCostCents: 2100 }]);
    expect(no.json().error).toMatchObject({ code: 'PRICE_JUSTIFICATION_REQUIRED' });
    expect((await balance(variantId))?.on_hand ?? '0.000').toBe('0.000');
    const yes = await receive(o.id, [{ itemId: item, packs: '1', invoicedPackCostCents: 2100, priceJustification: 'Reajuste do fornecedor' }]);
    expect(yes.statusCode, yes.body).toBe(201);
    expect(yes.json().order.issues[0]).toMatchObject({ kind: 'price', expected: '2000.0000', found: '2100.0000', note: 'Reajuste do fornecedor' });
    expect((await balance(variantId)).avg_cost_cents).toBe('21.0000');
    // Tolerancia de 10%: 5% de diferenca passa sem divergencia.
    expect((await setSettings(0, 10)).statusCode).toBe(200);
    const within = await receive(o.id, [{ itemId: item, packs: '1', invoicedPackCostCents: 2100 }]);
    expect(within.statusCode, within.body).toBe(201);
    expect(within.json().order.issues).toHaveLength(1);
    expect((await setSettings(0, 0)).statusCode).toBe(200);
  });

  it('falta e item errado ficam registrados, sem entrada; o histórico é imutável', async () => {
    const { variantId, purchase } = await newProduct();
    const sup = await newSupplier(purchase.id);
    const o = await sentPO(sup, [{ packagingId: purchase.id, packs: '3' }]);
    const item = o.items[0].id;
    const r = await receive(o.id, [{ itemId: item, packs: '2' }], {
      invoiceRef: 'NF 55',
      issues: [
        { itemId: item, kind: 'quantity', expected: 3, found: 2, note: 'Nota diz 3, chegaram 2' },
        { itemId: item, kind: 'wrong_item', note: 'Veio uma caixa de tampa, devolvida' },
      ],
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().order.issues.map((x: { kind: string }) => x.kind)).toEqual(['quantity', 'wrong_item']);
    expect((await location(variantId)).on_hand).toBe('200.000');
    await expect(owner.query('DELETE FROM purchase_receipt_issues')).rejects.toThrow();
    expect(await reconcile()).toEqual([]);
  });

  it('falha no meio do recebimento não deixa nada pela metade; repetir a chave não duplica', async () => {
    const a = await newProduct();
    const b = await newProduct();
    const sup = await newSupplier(a.purchase.id);
    expect((await boss.post(`/api/v1/admin/suppliers/${sup}/offers/item`, { packagingId: b.purchase.id, costCents: 1000 })).statusCode).toBe(201);
    const o = await sentPO(sup, [
      { packagingId: a.purchase.id, packs: '1' },
      { packagingId: b.purchase.id, packs: '1' },
    ]);
    const [ia, ib] = [o.items.find((x: { variant_id: string }) => x.variant_id === a.variantId).id, o.items.find((x: { variant_id: string }) => x.variant_id === b.variantId).id];
    const bad = await receive(o.id, [
      { itemId: ia, packs: '1' },
      { itemId: ib, packs: '5' },
    ]);
    expect(bad.json().error.code).toBe('OVER_RECEIPT');
    expect(await balance(a.variantId)).toBeUndefined();
    expect((await owner.query('SELECT count(*)::int AS n FROM purchase_receipts WHERE order_id = $1', [o.id])).rows[0].n).toBe(0);
    expect((await owner.query('SELECT received_packs FROM purchase_order_items WHERE id = $1', [ia])).rows[0].received_packs).toBe('0.000');
    const k = key();
    const body = { requestKey: k, items: [{ itemId: ia, packs: '1' }] };
    const [x, y] = await Promise.all([boss.post(`${PO}/${o.id}/receipts`, body), boss.post(`${PO}/${o.id}/receipts`, body)]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 201]);
    expect((await location(a.variantId)).on_hand).toBe('100.000');
    expect(await reconcile()).toEqual([]);
  });
});

describe('conversão das encomendas (D6-2, D6-9, D6-11)', () => {
  it('pela data de pagamento: a primeira paga converte; a seguinte aguarda; no recebimento seguinte converte', async () => {
    const { variantId, pack50, purchase } = await newProduct({ madeToOrder: true });
    const sup = await newSupplier(purchase.id);
    const first = await backorder(pack50, 2); // 100
    const second = await backorder(pack50, 2); // 100
    const o = await sentPO(sup, [{ packagingId: purchase.id, packs: '2' }], { purpose: 'fulfillment' });
    const r = await receive(o.id, [{ itemId: o.items[0].id, packs: '1' }]);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().conversions[0]).toMatchObject({ converted: [{ orderId: first, rule: 'queue', qty: '100.000' }], stoppedAt: { qty: '100.000', free: '0.000' } });
    expect((await reservations(first)).map((x) => x.backorder)).toEqual([false]);
    expect((await reservations(second)).map((x) => x.backorder)).toEqual([true]);
    // A reserva total nao muda com a conversao (a vitrine nao ve diferenca).
    expect((await balance(variantId)).reserved).toBe('200.000');
    const r2 = await receive(o.id, [{ itemId: o.items[0].id, packs: '1' }]);
    expect(r2.json().conversions[0].converted.map((c: { orderId: string }) => c.orderId)).toEqual([second]);
    expect(await conversions(second)).toMatchObject([{ rule: 'queue', qty: '100.000' }]);
    // Conversao nao despacha nem muda o pedido do cliente: segue a remessa da Fase 5.
    expect((await owner.query('SELECT status FROM orders WHERE id = $1', [first])).rows[0].status).toBe('paid');
    expect(await reconcile()).toEqual([]);
  });

  it('a encomenda vinculada à compra tem prioridade, sem exclusividade; vínculo respeita produto, depósito e tetos', async () => {
    const { pack50, purchase } = await newProduct({ madeToOrder: true });
    const other = await newProduct({ madeToOrder: true });
    const sup = await newSupplier(purchase.id);
    const first = await backorder(pack50, 2);
    const linked = await backorder(pack50, 2);
    const o = await sentPO(sup, [{ packagingId: purchase.id, packs: '1' }], { purpose: 'fulfillment' });
    const cands = (await boss.get(`${PO}/${o.id}/link-candidates`)).json().items;
    expect(cands.map((c: { order_id: string }) => c.order_id)).toEqual([first, linked]);
    const allocation = cands.find((c: { order_id: string }) => c.order_id === linked).allocation_id;
    const ln = await boss.post(`${PO}/${o.id}/links`, { itemId: o.items[0].id, allocationId: allocation });
    expect(ln.statusCode, ln.body).toBe(201);
    expect(ln.json().order.links[0]).toMatchObject({ order_id: linked, base_qty: '100.000', status: 'active', reservation_state: 'awaiting' });
    expect((await boss.post(`${PO}/${o.id}/links`, { itemId: o.items[0].id, allocationId: allocation })).json().error.code).toBe('ALREADY_LINKED');
    const firstAlloc = cands.find((c: { order_id: string }) => c.order_id === first).allocation_id;
    expect((await boss.post(`${PO}/${o.id}/links`, { itemId: o.items[0].id, allocationId: firstAlloc })).json().error.code).toBe('LINK_OVER_ITEM');
    // Produto diferente: recusado.
    await newSupplier(other.purchase.id);
    const wrong = await backorder(other.pack50, 1);
    const wrongAlloc = (await reservations(wrong))[0]!.allocation_id;
    expect((await boss.post(`${PO}/${o.id}/links`, { itemId: o.items[0].id, allocationId: wrongAlloc, baseQty: '1' })).json().error.code).toBe('LINK_MISMATCH');
    // Item com vinculo nao sai do pedido; a quantidade nao fica abaixo do vinculado.
    expect((await boss.put(`${PO}/${o.id}`, { supplierId: sup, items: [{ packagingId: other.purchase.id, packs: '1', packCostCents: 10 }] })).json().error.code).toBe('ORDER_LOCKED');
    const draft = await createPO(sup, [{ packagingId: purchase.id, packs: '2' }]);
    expect((await boss.post(`${PO}/${draft.id}/links`, { itemId: draft.items[0].id, allocationId: firstAlloc, baseQty: '50' })).statusCode).toBe(201);
    expect((await boss.put(`${PO}/${draft.id}`, { supplierId: sup, items: [{ packagingId: other.purchase.id, packs: '1', packCostCents: 10 }] })).json().error.code).toBe('ITEM_LINKED');
    expect((await boss.put(`${PO}/${draft.id}`, { supplierId: sup, items: [{ packagingId: purchase.id, packs: '0.25' }] })).json().error.code).toBe('LINKS_EXCEED');
    expect((await boss.post(`${PO}/${draft.id}/cancel`, { reason: 'Rascunho de teste' })).json().order.links[0].status).toBe('canceled');
    const r = await receive(o.id, [{ itemId: o.items[0].id, packs: '1' }]);
    expect(r.json().conversions[0].converted).toMatchObject([{ orderId: linked, rule: 'linked' }]);
    expect((await reservations(first))[0]!.backorder).toBe(true);
    expect(await reconcile()).toEqual([]);
  });

  it('para na primeira que não cabe inteira (sem parcial); antecipar exige permissão, MFA, justificativa e mercadoria', async () => {
    const { pack50, purchase } = await newProduct({ madeToOrder: true });
    const sup = await newSupplier(purchase.id);
    const big = await backorder(pack50, 4); // 200
    const small = await backorder(pack50, 2); // 100
    const o = await sentPO(sup, [{ packagingId: purchase.id, packs: '1' }]);
    const r = await receive(o.id, [{ itemId: o.items[0].id, packs: '1' }]);
    expect(r.json().conversions[0]).toMatchObject({ converted: [], stoppedAt: { qty: '200.000', free: '100.000' } });
    expect((await reservations(big))[0]!.backorder).toBe(true);
    expect((await reservations(small))[0]!.backorder).toBe(true);
    const target = (await reservations(small))[0]!.id;
    const q = (await boss.get(BO)).json().groups.find((g: { queue: { orderId: string }[] }) => g.queue.some((e) => e.orderId === small));
    expect(q.queue.map((e: { orderId: string; position: number }) => [e.orderId, e.position])).toEqual([
      [big, 1],
      [small, 2],
    ]);
    expect(q.free).toBe('100.000');
    const body = { reservationId: target, justification: 'Cliente retira hoje; a outra aguarda o restante', requestKey: key() };
    expect((await (await loggedAs(app, 'stock')).post(`${BO}/advance`, body)).statusCode).toBe(403);
    const lgNoMfa = await loggedAs(app, 'logistics');
    expect((await lgNoMfa.post(`${BO}/advance`, body)).json().error.code).toBe('MFA_REQUIRED');
    const lg = await loggedAs(app, 'logistics', { mfa: true });
    expect((await lg.post(`${BO}/advance`, { ...body, justification: 'curta' })).statusCode).toBe(400);
    const bigRes = (await reservations(big))[0]!.id;
    expect((await lg.post(`${BO}/advance`, { ...body, reservationId: bigRes, requestKey: key() })).json().error.code).toBe('AWAITING_GOODS');
    const adv = await lg.post(`${BO}/advance`, body);
    expect(adv.statusCode, adv.body).toBe(200);
    expect(adv.json()).toMatchObject({ replayed: false, position: 2 });
    expect((await lg.post(`${BO}/advance`, body)).json().replayed).toBe(true);
    expect(await conversions(small)).toMatchObject([{ rule: 'manual', justification: body.justification, receipt_id: null }]);
    await expect(owner.query('UPDATE reservation_conversions SET justification = $1', ['outra'])).rejects.toThrow();
    // Tentar converter de novo a mesma reserva (outra chave): nao e mais encomenda.
    expect((await lg.post(`${BO}/advance`, { ...body, requestKey: key() })).json().error.code).toBe('NOT_BACKORDER');
    expect(await reconcile()).toEqual([]);
  });

  it('dois recebimentos ao mesmo tempo não convertem a mesma encomenda duas vezes', async () => {
    const { variantId, pack50, purchase } = await newProduct({ madeToOrder: true });
    const sup = await newSupplier(purchase.id);
    const orders = [await backorder(pack50, 2), await backorder(pack50, 2), await backorder(pack50, 2)];
    const p1 = await sentPO(sup, [{ packagingId: purchase.id, packs: '1' }]);
    const p2 = await sentPO(sup, [{ packagingId: purchase.id, packs: '1' }]);
    const [a, b] = await Promise.all([receive(p1.id, [{ itemId: p1.items[0].id, packs: '1' }]), receive(p2.id, [{ itemId: p2.items[0].id, packs: '1' }])]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    const conv = (await owner.query('SELECT reservation_id, order_id FROM reservation_conversions WHERE variant_id = $1 ORDER BY id', [variantId])).rows;
    expect(conv.map((c) => c.order_id)).toEqual(orders.slice(0, 2));
    expect(new Set(conv.map((c) => c.reservation_id)).size).toBe(2);
    expect((await reservations(orders[2]!))[0]!.backorder).toBe(true);
    expect(await reconcile()).toEqual([]);
  });

  it('mercadoria em outro depósito não atende a encomenda do padrão; bloqueado e avariado não convertem', async () => {
    const { variantId, pack50, purchase } = await newProduct({ madeToOrder: true });
    const sup = await newSupplier(purchase.id);
    const other = await newWarehouse();
    const id = await backorder(pack50, 2);
    const elsewhere = await sentPO(sup, [{ packagingId: purchase.id, packs: '1' }], { warehouseId: other });
    const r = await receive(elsewhere.id, [{ itemId: elsewhere.items[0].id, packs: '1' }]);
    expect(r.json().conversions[0].converted).toEqual([]);
    expect((await reservations(id))[0]!.backorder).toBe(true);
    const here = await sentPO(sup, [{ packagingId: purchase.id, packs: '2' }]);
    const rej = await receive(here.id, [{ itemId: here.items[0].id, packs: '2', rejectedPacks: '2', rejectedDestination: 'blocked', rejectedReason: 'Quarentena' }]);
    expect(rej.statusCode, rej.body).toBe(201);
    expect(rej.json().conversions[0]).toMatchObject({ converted: [], stoppedAt: { free: '0.000' } });
    expect(await location(variantId)).toMatchObject({ on_hand: '0.000', blocked: '200.000' });
    expect((await reservations(id))[0]!.backorder).toBe(true);
    expect(await reconcile()).toEqual([]);
  });

  it('a encomenda convertida separa sem depender da liberação calculada', async () => {
    const { pack50, purchase } = await newProduct({ madeToOrder: true });
    const sup = await newSupplier(purchase.id);
    const id = await backorder(pack50, 2);
    const o = await sentPO(sup, [{ packagingId: purchase.id, packs: '1' }]);
    await receive(o.id, [{ itemId: o.items[0].id, packs: '1' }]);
    const sh = (await owner.query(`SELECT id, version FROM shipments WHERE order_id = $1 AND status = 'pending'`, [id])).rows[0];
    const st = await boss.post(`${SH}/${sh.id}/start`, { requestKey: key(), version: sh.version });
    expect(st.statusCode, st.body).toBe(200);
    expect(st.json().shipment.items[0].backorder).toBe(false);
    const pick = await boss.post(`${SH}/${sh.id}/pick`, { requestKey: key(), itemId: st.json().shipment.items[0].id, qty: '100' });
    expect(pick.statusCode, pick.body).toBe(200);
    expect(await reconcile()).toEqual([]);
  });
});

describe('compra encerrada com falta e encomendas antigas (D6-8, D6-10)', () => {
  it('encerrar com falta cancela os vínculos não atendidos e devolve a pendência, sem cancelar o pedido', async () => {
    const { pack50, purchase } = await newProduct({ madeToOrder: true });
    const sup = await newSupplier(purchase.id);
    const a = await backorder(pack50, 2);
    const b = await backorder(pack50, 2);
    const o = await sentPO(sup, [{ packagingId: purchase.id, packs: '2' }], { purpose: 'fulfillment' });
    const cands = (await boss.get(`${PO}/${o.id}/link-candidates`)).json().items;
    for (const c of cands) expect((await boss.post(`${PO}/${o.id}/links`, { itemId: o.items[0].id, allocationId: c.allocation_id })).statusCode).toBe(201);
    await receive(o.id, [{ itemId: o.items[0].id, packs: '1' }]);
    const close = await boss.post(`${PO}/${o.id}/close`, { reason: 'Fornecedor sem estoque' });
    expect(close.statusCode, close.body).toBe(200);
    expect(close.json().pendingOrders.map((p: { order_id: string }) => p.order_id)).toEqual([b]);
    expect(close.json().order.links.every((l: { status: string }) => l.status === 'canceled')).toBe(true);
    expect(close.json().order.events.at(-1)).toMatchObject({ kind: 'closed_short', note: 'Fornecedor sem estoque' });
    expect((await owner.query('SELECT status FROM orders WHERE id = $1', [b])).rows[0].status).toBe('paid');
    expect((await reservations(b))[0]!.backorder).toBe(true);
    expect((await reservations(a))[0]!.backorder).toBe(false);
    // Pendencia visivel no pedido do cliente (vinculo desfeito, ainda aguardando) e a conversao no outro.
    const db = (await boss.get(`${L}/orders/${b}`)).json();
    expect(db.purchaseLinks).toMatchObject([{ status: 'canceled', awaiting: true, cancel_reason: 'Compra encerrada', purchase_number: o.number }]);
    expect((await boss.get(`${L}/orders/${a}`)).json().conversions).toMatchObject([{ rule: 'linked', purchase_number: o.number }]);
    expect(await reconcile()).toEqual([]);
  });

  it('encomenda antiga não converte sozinha; o reprocessamento mostra a prévia, converte pela fila e não repete', async () => {
    const { variantId, pack50, purchase } = await newProduct({ madeToOrder: true });
    await newSupplier(purchase.id);
    const id = await backorder(pack50, 2);
    // Mercadoria que chegou por ajuste (ou existia antes da Fase 6): nada converte sozinho.
    const adj = await boss.post('/api/v1/admin/stock/movements', { variantId, kind: 'adjustment', qty: '100', reason: 'Entrada antiga', requestKey: key() });
    expect(adj.statusCode, adj.body).toBe(201);
    expect((await reservations(id))[0]!.backorder).toBe(true);
    expect((await (await loggedAs(app, 'stock')).post(`${BO}/reprocess`, { requestKey: key() })).statusCode).toBe(403);
    const prev = await boss.post(`${BO}/reprocess`, { variantId, requestKey: key() });
    expect(prev.statusCode, prev.body).toBe(200);
    expect(prev.json()).toMatchObject({ preview: true });
    expect(prev.json().results[0].converted.map((c: { orderId: string }) => c.orderId)).toEqual([id]);
    expect((await reservations(id))[0]!.backorder).toBe(true); // previa nao muda nada
    const k = key();
    const ap = await boss.post(`${BO}/reprocess`, { variantId, apply: true, requestKey: k });
    expect(ap.json().results[0].converted).toHaveLength(1);
    expect(await conversions(id)).toMatchObject([{ rule: 'reprocess', receipt_id: null }]);
    expect((await boss.post(`${BO}/reprocess`, { variantId, apply: true, requestKey: k })).json()).toMatchObject({ replayed: true });
    expect(await reconcile()).toEqual([]);
  });

  it('desfazer a alocação cancela o vínculo; a conciliação aponta C12 e C13', async () => {
    const { variantId, pack50, purchase } = await newProduct({ madeToOrder: true });
    const sup = await newSupplier(purchase.id);
    const id = await backorder(pack50, 2);
    const o = await sentPO(sup, [{ packagingId: purchase.id, packs: '2' }]);
    const c = (await boss.get(`${PO}/${o.id}/link-candidates`)).json().items[0];
    expect((await boss.post(`${PO}/${o.id}/links`, { itemId: o.items[0].id, allocationId: c.allocation_id })).statusCode).toBe(201);
    const d = (await boss.get(`${L}/orders/${id}`)).json();
    const undo = await boss.post(`${L}/orders/${id}/allocation/cancel`, { logisticsVersion: d.order.logistics_version, reason: 'Troca de origem', requestKey: key() });
    expect(undo.statusCode, undo.body).toBe(200);
    expect((await boss.get(`${PO}/${o.id}`)).json().order.links[0]).toMatchObject({ status: 'canceled' });
    // C12: item da compra mexido por fora.
    await receive(o.id, [{ itemId: o.items[0].id, packs: '1' }]);
    await owner.query('UPDATE purchase_order_items SET received_packs = received_packs + 1 WHERE id = $1', [o.items[0].id]);
    expect((await reconcile()).map((r) => `${r.check_code}:${r.field}`)).toEqual(['C12:received']);
    await owner.query('UPDATE purchase_order_items SET received_packs = received_packs - 1 WHERE id = $1', [o.items[0].id]);
    // C13: reserva convertida voltou a ser encomenda por fora.
    const id2 = await backorder(pack50, 1);
    await boss.post(`${BO}/reprocess`, { variantId, apply: true, requestKey: key() });
    const conv = (await owner.query('SELECT reservation_id FROM reservation_conversions WHERE variant_id = $1 ORDER BY id DESC LIMIT 1', [variantId])).rows[0];
    expect(conv).toBeTruthy();
    await owner.query('UPDATE stock_reservations SET backorder = true WHERE id = $1', [conv.reservation_id]);
    expect((await reconcile()).map((r) => `${r.check_code}:${r.field}`)).toEqual(['C13:converted']);
    await owner.query('UPDATE stock_reservations SET backorder = false WHERE id = $1', [conv.reservation_id]);
    expect(await reconcile()).toEqual([]);
    expect(id2).toBeTruthy();
  });
});
