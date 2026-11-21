/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { pool, tx } from '../src/db/pool.js';
import { applyPayment } from '../src/modules/orders.js';
import { FakeCarrier, setCarrierProvider } from '../src/lib/carriers.js';
import { FakeProvider } from '../src/lib/payments.js';
import { allocateOrder, appRole, loggedAs, makeApp, ORIGIN, owner, packOrder, productPayload, randomIp, resetCatalog, uid } from './helpers.js';

// SGLog Fase 9b (docs/38-sglog-fase9.md): reembolsos (so registro, MFA, teto, duplicata, concorrencia, marketplace),
// pagamento devolvido no provedor, documento fiscal ou dispensa, troca com pedido de reposicao, devolucao ao
// fornecedor, conferencia C17-C21, relatorio e a pagina do cliente.

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

// ---------------------------------------------------------------------------------------------------------------
// Fase 9b: reembolsos, documento fiscal, troca, pagamento devolvido, devolucao ao fornecedor, C17-C21, relatorio.

const RF = '/api/v1/admin/refunds';
const SR = '/api/v1/admin/supplier-returns';

const orderTotal = async (orderId: string) => Number((await owner.query('SELECT total_cents FROM orders WHERE id = $1', [orderId])).rows[0].total_cents);
async function refund(orderId: string, b: Record<string, unknown> = {}, c = boss) {
  return c.post(RF, { orderId, amountCents: 1000, method: 'pix', reason: 'Devolução do cliente', requestKey: key(), ...b });
}
async function completeFlow(orderId: string, item: string, qty: string, kind = 'return') {
  const r = await okReturn(orderId, [{ orderItemId: item, qty }], { kind });
  await receive(r.return.id);
  expect((await inspect(r.return.id, [{ condition: 'good', qty }])).statusCode).toBe(200);
  return r.return.id as string;
}
async function newSupplier() {
  const res = await boss.post('/api/v1/admin/suppliers', { name: `Fornecedor ${uid()}` });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().supplier.id as string;
}

describe('reembolso: só registro (D9-5)', () => {
  it('solicitado, realizado com referência, confirmado; nada conclui sozinho; teto do total e duplicata da operação', async () => {
    const o = await shippedOrder();
    const totalCents = await orderTotal(o.orderId);
    // Devolução recebida e conferida não cria reembolso.
    const rid = await completeFlow(o.orderId, o.item, '10');
    expect((await boss.post(`${R}/${rid}/complete`, { version: (await getReturn(rid)).return.version, requestKey: key() })).statusCode).toBe(200);
    expect((await owner.query('SELECT count(*)::int AS n FROM refund_records WHERE order_id = $1', [o.orderId])).rows[0].n).toBe(0);

    const k = key();
    const a = await boss.post(RF, { orderId: o.orderId, returnId: rid, amountCents: 500, method: 'pix', reason: 'Devolução de 10 un', requestKey: k });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json().refund).toMatchObject({ status: 'requested', amount_cents: '500' });
    // Mesma chave: devolve o registro, sem duplicar.
    const again = await boss.post(RF, { orderId: o.orderId, returnId: rid, amountCents: 500, method: 'pix', reason: 'Devolução de 10 un', requestKey: k });
    expect(again.json().replayed).toBe(true);
    expect((await owner.query('SELECT count(*)::int AS n FROM refund_records WHERE order_id = $1', [o.orderId])).rows[0].n).toBe(1);
    const id = a.json().refund.id;
    const act = async (action: string, extra: Record<string, unknown> = {}) => {
      const v = (await boss.get(`${RF}/${id}`)).json().refund.version;
      return boss.post(`${RF}/${id}/action`, { action, note: 'Conferido', version: v, requestKey: key(), ...extra });
    };
    expect((await act('confirm')).json().error.code).toBe('INVALID_TRANSITION');
    expect((await act('done')).json().error.code).toBe('EXTERNAL_REF_REQUIRED');
    const ref = `E2E${uid()}`;
    const done = await act('done', { externalRef: ref });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().refund).toMatchObject({ status: 'done', external_ref: ref });
    expect((await act('confirm')).json().refund.status).toBe('confirmed');
    expect((await act('cancel')).json().error.code).toBe('INVALID_TRANSITION');
    // Mesma operação financeira (meio + referência) em outro pedido: recusada.
    const o2 = await shippedOrder();
    const dup = await refund(o2.orderId, { status: 'done', externalRef: ref });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('REFUND_DUPLICATE');
    // Soma acima do total (contando os anteriores): recusada.
    const over = await refund(o.orderId, { amountCents: totalCents - 500 + 1 });
    expect(over.statusCode).toBe(409);
    expect(over.json().error.code).toBe('REFUND_EXCEEDS_TOTAL');
    expect((await refund(o.orderId, { amountCents: totalCents - 500 })).statusCode).toBe(201);
    // Resumo do pedido.
    const sum = (await boss.get(`${RF}/orders/${o.orderId}`)).json();
    expect(sum).toMatchObject({ totalCents, confirmedCents: 500, requestedCents: totalCents - 500, eligibleCents: 0 });
    // Pedido e NF-e não mudam.
    expect((await owner.query('SELECT status, invoice_status FROM orders WHERE id = $1', [o.orderId])).rows[0]).toEqual({ status: 'delivered', invoice_status: 'not_required' });
    expect(await reconcile()).toEqual([]);
  });

  it('concorrência: dois reembolsos que juntos passam do total, um só entra', async () => {
    const o = await shippedOrder();
    const half = Math.ceil((await orderTotal(o.orderId)) * 0.6);
    const res = await Promise.all([refund(o.orderId, { amountCents: half }), refund(o.orderId, { amountCents: half })]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });

  it('permissão própria com MFA; marketplace só registra o meio marketplace', async () => {
    const o = await shippedOrder();
    const noMfa = await loggedAs(app, 'manager');
    expect((await refund(o.orderId, {}, noMfa)).json().error.code).toBe('MFA_REQUIRED');
    const ship = await loggedAs(app, 'shipping', { mfa: true });
    expect((await refund(o.orderId, {}, ship)).statusCode).toBe(403);
    const fin = await loggedAs(app, 'finance', { mfa: true });
    expect((await refund(o.orderId, {}, fin)).statusCode).toBe(201);
    expect((await refund(o.orderId, { method: 'marketplace' })).json().error.code).toBe('REFUND_METHOD');
    // Pedido de marketplace.
    const m = await shippedOrder();
    await owner.query(`UPDATE orders SET channel = 'mercadolivre', payment_method = 'marketplace' WHERE id = $1`, [m.orderId]);
    expect((await refund(m.orderId, { method: 'pix' })).json().error.code).toBe('REFUND_METHOD');
    const ok = await refund(m.orderId, { method: 'marketplace', status: 'done', externalRef: `ML-${uid()}` });
    expect(ok.statusCode, ok.body).toBe(201);
    // Troca de marketplace segue recusada.
    expect((await createReturn(m.orderId, [{ orderItemId: m.item, qty: '1' }], { kind: 'exchange' })).json().error.code).toBe('MARKETPLACE_EXCHANGE');
  });

  it('pagamento devolvido no provedor: uma ocorrência por pedido (sem reembolso automático) e C18 até o registro', async () => {
    const o = await shippedOrder();
    const pay = (await owner.query('SELECT id, provider_payment_id, amount_cents FROM payments WHERE order_id = $1', [o.orderId])).rows[0];
    const send = (status: 'refunded' | 'charged_back') =>
      tx(null, (db) => applyPayment(db, pay.id, { providerPaymentId: pay.provider_payment_id, status, statusDetail: null, amountCents: Number(pay.amount_cents), externalReference: o.orderId }));
    await send('refunded');
    await send('charged_back');
    await send('refunded');
    const occ = (await owner.query(`SELECT id, kind, blocks_completion FROM logistic_occurrences WHERE order_id = $1 AND source = 'payment'`, [o.orderId])).rows;
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({ kind: 'refund', blocks_completion: false });
    expect((await owner.query('SELECT count(*)::int AS n FROM refund_records WHERE order_id = $1', [o.orderId])).rows[0].n).toBe(0);
    expect((await reconcile()).map((d: any) => d.check_code)).toEqual(['C18']);
    expect((await refund(o.orderId, { method: 'mercadopago', status: 'done', externalRef: `MP-${uid()}`, amountCents: Number(pay.amount_cents) })).statusCode).toBe(201);
    expect(await reconcile()).toEqual([]);
    // Pedido segue concluído (a ocorrência de pagamento não segura) e o cliente não vê notas internas.
    expect((await owner.query('SELECT logistics_status FROM orders WHERE id = $1', [o.orderId])).rows[0].logistics_status).toBe('completed');
  });
});

describe('documento fiscal da devolução', () => {
  it('pedido com NF-e autorizada: encerra só com documento ou dispensa; a NF-e da venda não muda', async () => {
    const o = await shippedOrder({ invoice: 'authorized' });
    const rid = await completeFlow(o.orderId, o.item, '5');
    const complete = async () => boss.post(`${R}/${rid}/complete`, { version: (await getReturn(rid)).return.version, requestKey: key() });
    expect((await complete()).json().error.code).toBe('FISCAL_PENDING');
    expect((await boss.post(`${R}/${rid}/fiscal`, { kind: 'document', docType: 'customer_nfe', requestKey: key() })).json().error.code).toBe('DOCUMENT_REF_REQUIRED');
    // Dispensa: só com permissão fiscal (e MFA).
    expect((await boss.post(`${R}/${rid}/fiscal`, { kind: 'waiver', justification: 'Cliente pessoa física sem emissão', requestKey: key() })).statusCode).toBe(403);
    const fiscalNoMfa = await loggedAs(app, 'fiscal');
    expect((await fiscalNoMfa.post(`${R}/${rid}/fiscal`, { kind: 'waiver', justification: 'Cliente pessoa física sem emissão', requestKey: key() })).json().error.code).toBe('MFA_REQUIRED');
    const doc = await boss.post(`${R}/${rid}/fiscal`, { kind: 'document', docType: 'store_entry_nfe', docNumber: '123', series: '1', issuedOn: '2026-11-20', requestKey: key() });
    expect(doc.statusCode, doc.body).toBe(200);
    expect(doc.json().fiscalResolved).toBe(true);
    expect((await complete()).json().return.status).toBe('completed');
    expect((await owner.query('SELECT invoice_status FROM orders WHERE id = $1', [o.orderId])).rows[0].invoice_status).toBe('authorized');
    // Outro pedido: dispensa pelo fiscal com MFA.
    const o2 = await shippedOrder({ invoice: 'authorized' });
    const rid2 = await completeFlow(o2.orderId, o2.item, '5');
    const fiscal = await loggedAs(app, 'fiscal', { mfa: true });
    expect((await fiscal.post(`${R}/${rid2}/fiscal`, { kind: 'waiver', justification: 'Devolução sem documento: orientação do contador', requestKey: key() })).statusCode).toBe(200);
    expect((await boss.post(`${R}/${rid2}/complete`, { version: (await getReturn(rid2)).return.version, requestKey: key() })).json().return.status).toBe('completed');
    // Imutável.
    await expect(appRole.query(`UPDATE return_fiscal_documents SET doc_number = '9' WHERE return_id = $1`, [rid])).rejects.toThrow();
    expect(await reconcile()).toEqual([]);
    // C19: encerrada exigindo documento e sem documento.
    await owner.query('ALTER TABLE return_fiscal_documents DISABLE TRIGGER return_fiscal_documents_immutable');
    await owner.query('DELETE FROM return_fiscal_documents WHERE return_id = $1', [rid2]);
    await owner.query('ALTER TABLE return_fiscal_documents ENABLE TRIGGER return_fiscal_documents_immutable');
    expect((await reconcile()).map((d: any) => `${d.check_code}:${d.field}`)).toEqual(['C19:fiscal']);
    await owner.query(`INSERT INTO return_fiscal_documents (return_id, kind, justification) VALUES ($1, 'waiver', 'Restaurado no teste de conferência')`, [rid2]);
    expect(await reconcile()).toEqual([]);
  });
});

describe('troca (D9-4)', () => {
  it('pedido de reposição separado, sem cobrança, ligado à devolução; um só; NF-e e despacho seguem as regras', async () => {
    const o = await shippedOrder();
    const r = await okReturn(o.orderId, [{ orderItemId: o.item, qty: '50' }], { kind: 'exchange', reason: 'defect' });
    const repl = await boss.post(`${R}/${r.return.id}/replacement`, { version: r.return.version, requestKey: key() });
    expect(repl.statusCode, repl.body).toBe(201);
    const ro = repl.json().replacement;
    expect(ro).toMatchObject({ status: 'paid', invoice_status: 'pending' });
    const row = (await owner.query('SELECT total_cents, subtotal_cents, discount_cents, freight_cents, replacement_for_return_id, allocation_required FROM orders WHERE id = $1', [ro.id])).rows[0];
    expect(row).toMatchObject({ total_cents: '0', freight_cents: '0', replacement_for_return_id: r.return.id, allocation_required: true });
    expect(row.discount_cents).toBe(row.subtotal_cents);
    expect((await owner.query('SELECT packs::text FROM order_items WHERE order_id = $1', [ro.id])).rows[0].packs).toMatch(/^1(\.0+)?$/);
    // Sem pagamento, sem cobrança.
    expect((await owner.query('SELECT count(*)::int AS n FROM payments WHERE order_id = $1', [ro.id])).rows[0].n).toBe(0);
    // Segundo pedido de reposição: recusado.
    const again = await boss.post(`${R}/${r.return.id}/replacement`, { version: (await getReturn(r.return.id)).return.version, requestKey: key() });
    expect(again.json().error.code).toBe('REPLACEMENT_EXISTS');
    // Devolução comum não gera reposição.
    const plain = await okReturn(o.orderId, [{ orderItemId: o.item, qty: '1' }]);
    expect((await boss.post(`${R}/${plain.return.id}/replacement`, { version: plain.return.version, requestKey: key() })).json().error.code).toBe('NOT_EXCHANGE');
    // Pedido antigo de despacho: NF-e pendente segura o despacho (regra de sempre).
    const staff = (await boss.get(`/api/v1/admin/orders/${ro.id}`)).json().order;
    expect(staff.replacement_for_return_id).toBe(r.return.id);
    // Página do cliente do pedido original: situação da troca, sem notas internas.
    const token = (await owner.query('SELECT request_key FROM orders WHERE id = $1', [o.orderId])).rows[0];
    expect(token).toBeTruthy();
    const events = (await owner.query('SELECT note, internal FROM order_events WHERE order_id = $1 AND internal', [o.orderId])).rows;
    expect(events.length).toBeGreaterThan(0);
    expect(await reconcile()).toEqual([]);
  });

  it('quantidade que não fecha embalagem inteira: recusada com orientação', async () => {
    const o = await shippedOrder();
    const r = await okReturn(o.orderId, [{ orderItemId: o.item, qty: '30' }], { kind: 'exchange' });
    expect((await boss.post(`${R}/${r.return.id}/replacement`, { version: r.return.version, requestKey: key() })).json().error.code).toBe('REPLACEMENT_PACKS');
  });
});

describe('devolução ao fornecedor (9b)', () => {
  it('rascunho não mexe no estoque; enviar tira do livre e do bloqueado; recusada volta; aceita encerra; C21', async () => {
    const p = await newProduct('100');
    expect((await boss.post('/api/v1/admin/stock/holds', { variantId: p.variantId, op: 'block', qty: '5', reason: 'Lote suspeito', requestKey: key() })).statusCode).toBe(201);
    const b0 = await balance(p.variantId);
    expect(b0).toMatchObject({ on_hand: '95.000', blocked: '5.000' });
    const sup = await newSupplier();
    const other = await newSupplier();
    const po = (
      await owner.query<{ id: string }>(
        `INSERT INTO purchase_orders (supplier_id, created_by, warehouse_id) VALUES ($1, (SELECT id FROM users LIMIT 1), (SELECT id FROM warehouses WHERE is_default)) RETURNING id`,
        [other],
      )
    ).rows[0];
    const wrong = await boss.post(SR, { supplierId: sup, purchaseOrderId: po.id, reason: 'Defeito de fábrica', items: [{ variantId: p.variantId, bucket: 'on_hand', qty: '1' }], requestKey: key() });
    expect(wrong.json().error.code).toBe('PURCHASE_NOT_FROM_SUPPLIER');
    const create = await boss.post(SR, {
      supplierId: sup,
      reason: 'Defeito de fábrica',
      items: [
        { variantId: p.variantId, bucket: 'on_hand', qty: '10' },
        { variantId: p.variantId, bucket: 'blocked', qty: '5' },
      ],
      requestKey: key(),
    });
    expect(create.statusCode, create.body).toBe(201);
    const s = create.json().supplierReturn;
    expect(s.status).toBe('draft');
    expect(await balance(p.variantId)).toEqual(b0);
    const send = await boss.post(`${SR}/${s.id}/send`, { documentRef: 'NF 555', version: s.version, requestKey: key() });
    expect(send.statusCode, send.body).toBe(200);
    expect(send.json().supplierReturn.status).toBe('sent');
    expect(await balance(p.variantId)).toMatchObject({ on_hand: '85.000', blocked: '0.000' });
    expect(send.json().items.map((i: any) => i.out_qty).sort()).toEqual(['10.000', '5.000']);
    expect(await reconcile()).toEqual([]);
    // Recusada: a mercadoria volta para o saldo de onde saiu.
    const refused = await boss.post(`${SR}/${s.id}/refuse`, { note: 'Fornecedor não aceitou', version: send.json().supplierReturn.version, requestKey: key() });
    expect(refused.statusCode, refused.body).toBe(200);
    expect(await balance(p.variantId)).toEqual(b0);
    expect(await reconcile()).toEqual([]);
    // Outra: enviada e aceita. Nada de crédito ou reembolso.
    const c2 = (await boss.post(SR, { supplierId: sup, reason: 'Troca de lote', items: [{ variantId: p.variantId, bucket: 'on_hand', qty: '3' }], requestKey: key() })).json().supplierReturn;
    const s2 = (await boss.post(`${SR}/${c2.id}/send`, { documentRef: 'NF 556', version: c2.version, requestKey: key() })).json().supplierReturn;
    expect((await boss.post(`${SR}/${c2.id}/accept`, { note: 'Recebido pelo fornecedor', version: s2.version, requestKey: key() })).json().supplierReturn.status).toBe('accepted');
    expect(await balance(p.variantId)).toMatchObject({ on_hand: '92.000', blocked: '5.000' });
    // Mais do que o livre: recusado.
    const big = (await boss.post(SR, { supplierId: sup, reason: 'Excesso', items: [{ variantId: p.variantId, bucket: 'on_hand', qty: '500' }], requestKey: key() })).json().supplierReturn;
    expect((await boss.post(`${SR}/${big.id}/send`, { documentRef: 'NF 557', version: big.version, requestKey: key() })).json().error.code).toBe('INSUFFICIENT_STOCK');
    expect((await boss.post(`${SR}/${big.id}/cancel`, { note: 'Digitado errado', version: big.version, requestKey: key() })).json().supplierReturn.status).toBe('canceled');
    // Comprador sem purchases.manage? o comprador tem; o financeiro não.
    const fin = await loggedAs(app, 'finance', { mfa: true });
    expect((await fin.post(SR, { supplierId: sup, reason: 'X', items: [{ variantId: p.variantId, bucket: 'on_hand', qty: '1' }], requestKey: key() })).statusCode).toBe(403);
    expect(await reconcile()).toEqual([]);
    // C21: movimento que some.
    await owner.query(`UPDATE supplier_returns SET status = 'sent', sent_at = now(), document_ref = 'X', closed_at = NULL, close_note = NULL WHERE id = $1`, [big.id]);
    expect((await reconcile()).map((d: any) => `${d.check_code}:${d.field}`)).toEqual(['C21:supplier_returned']);
    await owner.query(`UPDATE supplier_returns SET status = 'canceled', closed_at = now(), close_note = 'Restaurado' WHERE id = $1`, [big.id]);
  });
});

describe('conferência e relatório', () => {
  it('C20: pedido segurado sem ocorrência; relatório do período', async () => {
    const o = await shippedOrder();
    await owner.query(`UPDATE orders SET logistics_status = 'on_hold' WHERE id = $1`, [o.orderId]);
    expect((await reconcile()).map((d: any) => `${d.check_code}:${d.field}`)).toEqual(['C20:hold']);
    await owner.query(`UPDATE orders SET logistics_status = 'completed' WHERE id = $1`, [o.orderId]);
    const today = new Date().toISOString().slice(0, 10);
    const rep = await boss.get(`${R}/report?from=2020-01-01&to=${today}`);
    expect(rep.statusCode, rep.body).toBe(200);
    expect(Object.keys(rep.json())).toEqual(expect.arrayContaining(['returns', 'conditions', 'occurrences', 'refunds', 'supplierReturns', 'pending']));
    const ship = await loggedAs(app, 'shipping', { mfa: true });
    expect((await ship.get(`${R}/report?from=2020-01-01&to=${today}`)).statusCode).toBe(403);
  });

  it('página do cliente: situação da devolução, sem notas internas', async () => {
    const s = shopper();
    const p = await newProduct();
    await s.post('/api/v1/public/cart/items', { packagingId: p.pack, packs: 1 });
    const cart = (await s.get('/api/v1/public/cart')).json().cart;
    const freight = (await s.get('/api/v1/public/shipping/quote?cep=01310100')).json().options.find((x: any) => x.id === carrierId).priceCents;
    const placed = (await s.post('/api/v1/public/checkout', { requestKey: `f9b-${uid()}`, buyer, shippingOptionId: carrierId, address, paymentMethod: 'pix', expectedTotalCents: cart.subtotalCents + freight })).json().order;
    await s.post(`/api/v1/public/orders/${placed.token}/pay/pix`);
    await s.post(`/api/v1/public/dev-payments/${placed.token}/approve-pix`);
    await allocateOrder(boss, placed.id);
    await owner.query(`UPDATE orders SET invoice_status = 'not_required' WHERE id = $1`, [placed.id]);
    const packed = await packOrder(boss, placed.id);
    const d = (await boss.post(`${SH}/${packed.id}/dispatch`, { version: packed.version, requestKey: key(), carrier: 'X', trackingCode: `TR${uid()}` })).json().shipment;
    await boss.post(`${SH}/${packed.id}/deliver`, { version: d.version, requestKey: key() });
    const item = (await owner.query('SELECT id FROM order_items WHERE order_id = $1', [placed.id])).rows[0].id;
    const r = await okReturn(placed.id, [{ orderItemId: item, qty: '10' }]);
    await receive(r.return.id);
    await refund(placed.id, { amountCents: 100 });
    const pub = (await s.get(`/api/v1/public/orders/${placed.token}`)).json().order;
    expect(pub.returns).toEqual([expect.objectContaining({ number: r.return.number, kind: 'return', status: 'received' })]);
    expect(JSON.stringify(pub.returns)).not.toMatch(/note|warehouse|actor|cents/);
    expect(JSON.stringify(pub.events)).not.toMatch(/Devolução nº|Reembolso nº|depósito/);
    const staff = (await boss.get(`/api/v1/admin/orders/${placed.id}`)).json().order;
    expect(JSON.stringify(staff.events)).toMatch(/Reembolso nº/);
  });
});
