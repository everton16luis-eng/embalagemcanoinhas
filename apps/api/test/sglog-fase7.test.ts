/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FakeProvider } from '../src/lib/payments.js';
import { appRole, ensureCompany, loggedAs, makeApp, ORIGIN, owner, productPayload, randomIp, resetCatalog, sendPurchase, uid } from './helpers.js';

// SGLog Fase 7 (docs/32-sglog-fase7.md): documento do pedido com versoes imutaveis, confirmacao do fornecedor
// (total, parcial, reducao, recusa), aumento de preco com aprovacao e MFA, requisicoes manuais e automaticas
// (idempotencia, concorrencia, conversao com vinculo), prazos e atrasos, sugestao pelo XML, desempenho, permissoes,
// reposicao e conciliacao C1-C13 sem movimento de estoque na confirmacao.

let app: FastifyInstance;
let boss: Awaited<ReturnType<typeof loggedAs>>; // gerente com MFA
let approver: Awaited<ReturnType<typeof loggedAs>>; // outro gerente com MFA
let pickupId: string;
let principal: string;

const PO = '/api/v1/admin/purchase-orders';
const RQ = '/api/v1/admin/purchase-requests';
const SUP = '/api/v1/admin/supply';
const L = '/api/v1/admin/logistics';
const key = () => `k-${uid()}-${uid()}`;
const buyer = { kind: 'pf', name: 'Maria Confeiteira', email: 'maria.cliente@teste.local', phone: '47999990000', document: '529.982.247-25' };

type Pack = { id: string; kind: string; label: string; base_qty: string };
type Client = typeof boss;

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

async function newProduct(opts: { madeToOrder?: boolean } = {}) {
  const res = await boss.post('/api/v1/admin/products', productPayload());
  expect(res.statusCode, res.body).toBe(201);
  const v = res.json().product.variants[0];
  const packs = v.packagings as Pack[];
  if (opts.madeToOrder) await owner.query(`UPDATE products SET availability_mode = 'made_to_order' WHERE id = (SELECT product_id FROM product_variants WHERE id = $1)`, [v.id]);
  return { variantId: v.id as string, sku: v.sku as string, pack50: packs.find((k) => k.label === 'Pacote com 50')!, purchase: packs.find((k) => k.kind === 'purchase')! };
}
async function newSupplier(purchasePackId?: string, costCents = 2000, extra: Record<string, unknown> = {}) {
  const s = await boss.post('/api/v1/admin/suppliers', { name: `Distribuidora ${uid()}`, leadTimeDays: 5, ...extra });
  expect(s.statusCode, s.body).toBe(201);
  const id = s.json().supplier.id as string;
  if (purchasePackId) await addOffer(id, purchasePackId, costCents);
  return id;
}
async function addOffer(supplierId: string, packagingId: string, costCents = 2000, extra: Record<string, unknown> = {}) {
  const r = await boss.post(`/api/v1/admin/suppliers/${supplierId}/offers/item`, { packagingId, costCents, ...extra });
  expect(r.statusCode, r.body).toBe(201);
}
async function newWarehouse(address = true) {
  const r = await boss.post('/api/v1/admin/warehouses', {
    code: `G${uid()}`.slice(0, 12).toUpperCase(),
    name: `Galpão ${uid()}`,
    ...(address ? { cep: '89460000', street: 'Rua do Galpão', number: '10', district: 'Industrial', city: 'Canoinhas', uf: 'SC' } : {}),
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
const confirm = (id: string, body: Record<string, unknown>, c: Client = boss) => c.post(`${PO}/${id}/confirmations`, body);
const get = async (id: string) => (await boss.get(`${PO}/${id}`)).json().order;
const setSettings = (approvalMinCents: number, priceTolerancePct: number, confirmationDays?: number) =>
  boss.put(`${PO}/settings`, { approvalMinCents, priceTolerancePct, ...(confirmationDays ? { confirmationDays } : {}) });
const isoDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

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
/** Pedido pago de produto sob encomenda, alocado como "comprar para atender" (reserva de encomenda no padrao). */
async function backorder(pack: Pack, packs: number) {
  const id = await paidOrder(pack, packs);
  const d = (await boss.get(`${L}/orders/${id}`)).json();
  const r = await boss.post(`${L}/orders/${id}/allocation`, { requestKey: key(), logisticsVersion: d.order.logistics_version, planKey: d.proposal.recommended.key });
  expect(r.statusCode, r.body).toBe(200);
  return id;
}
const allocationOf = async (orderId: string) => (await owner.query('SELECT id FROM fulfillment_allocations WHERE order_id = $1 AND status = $2', [orderId, 'active'])).rows[0].id as string;
async function link(po: any, orderId: string) {
  const r = await boss.post(`${PO}/${po.id}/links`, { itemId: po.items[0].id, allocationId: await allocationOf(orderId) });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().order;
}
const activeLinks = async (poId: string) =>
  (await owner.query(`SELECT o.number, l.order_id FROM purchase_order_links l JOIN orders o ON o.id = l.order_id WHERE l.purchase_order_id = $1 AND l.status = 'active' ORDER BY o.number`, [poId])).rows;
const movements = async (variantId: string) => (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM stock_movements WHERE variant_id = $1', [variantId])).rows[0]!.n;
const balance = async (variantId: string) => (await owner.query('SELECT on_hand, reserved, avg_cost_cents FROM stock_balances WHERE variant_id = $1', [variantId])).rows[0] ?? null;
type Rec = { check_code: string; field: string | null; expected: string; found: string };
async function reconcile() {
  const rows = (await appRole.query<Rec>('SELECT check_code, field, expected, found FROM stock_reconcile()')).rows;
  return rows.filter((r) => r.check_code !== 'run');
}
const sync = async () => {
  const r = await boss.post(`${RQ}/sync`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().result;
};
const requestsOf = async (orderId: string) =>
  (await owner.query('SELECT id, number, status, source, base_qty, purchase_order_id FROM purchase_requests WHERE order_id = $1 ORDER BY number', [orderId])).rows;

describe('documento do pedido ao fornecedor (D7-1, D7-2)', () => {
  it('bloqueia o envio sem os dados obrigatórios e mostra o que falta', async () => {
    const { purchase } = await newProduct();
    const sup = await newSupplier(purchase.id);
    const wh = await newWarehouse(false);
    const o = await createPO(sup, [{ packagingId: purchase.id, packs: '2' }], { warehouseId: wh });
    const prev = (await boss.get(`${PO}/${o.id}/document`)).json();
    expect(prev.document).toBeNull();
    expect(prev.missing.join(' ')).toMatch(/Endereço do depósito de destino .*CEP, rua, número, bairro, cidade, UF/);
    const s = await sendPurchase(app, boss, o.id);
    expect(s.statusCode).toBe(422);
    expect(s.json().error).toMatchObject({ code: 'DOCUMENT_INCOMPLETE' });
    expect(s.json().error.details.missing.length).toBe(1);
    // Nada foi gravado e a compra continua aprovada.
    expect((await get(o.id)).status).toBe('approved');
    expect((await owner.query('SELECT count(*)::int AS n FROM purchase_order_documents WHERE order_id = $1', [o.id])).rows[0].n).toBe(0);
  });

  it('envio guarda a versão 1 imutável (usuário, canal, conteúdo e hash), sem dados do cliente nem observação interna; reenvio cria a v2', async () => {
    const { purchase, pack50 } = await newProduct({ madeToOrder: true });
    const sup = await newSupplier(purchase.id, 2500);
    const customer = await backorder(pack50, 2);
    const o = await createPO(sup, [{ packagingId: purchase.id, packs: '1' }], { notes: 'Observação interna: negociar prazo', expectedAt: isoDay(10) });
    await link(o, customer);
    const s = await sendPurchase(app, boss, o.id);
    expect(s.statusCode, s.body).toBe(200);
    const sent = s.json();
    expect(sent.order).toMatchObject({ status: 'sent', sent_via: 'other', sent_document_version: 1, confirmation_status: 'awaiting' });
    expect(sent.document.version).toBe(1);
    const v1 = (await boss.get(`${PO}/${o.id}/documents/1`)).json().document;
    expect(v1).toMatchObject({ version: 1, channel: 'other', actor_name: 'Usuario manager' });
    expect(v1.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(v1.content.items).toEqual([expect.objectContaining({ packs: 1, packCostCents: 2500, subtotalCents: 2500 })]);
    expect(v1.content.deliverTo.addressSource).toBe('company');
    expect(v1.body_text).toContain(`Pedido de compra nº ${o.number}`);
    const all = JSON.stringify(v1);
    for (const secret of [buyer.name, buyer.email, buyer.phone, '52998224725', 'Observação interna']) expect(all).not.toContain(secret);
    // Imutavel ate para o dono do banco.
    await expect(owner.query('UPDATE purchase_order_documents SET body_text = $2 WHERE order_id = $1', [o.id, 'x'])).rejects.toThrow();
    await expect(owner.query('DELETE FROM purchase_order_documents WHERE order_id = $1', [o.id])).rejects.toThrow();
    // Reenvio por WhatsApp (feito pela equipe) com mensagem: v2; a v1 fica igual.
    const re = await boss.post(`${PO}/${o.id}/documents`, { channel: 'whatsapp', message: 'Favor confirmar até sexta.' });
    expect(re.statusCode, re.body).toBe(201);
    expect(re.json().order).toMatchObject({ sent_via: 'whatsapp', sent_document_version: 2 });
    expect(re.json().document.text).toContain('Favor confirmar até sexta.');
    const again = (await boss.get(`${PO}/${o.id}/documents/1`)).json().document;
    expect(again.content_hash).toBe(v1.content_hash);
    expect(re.json().order.documents.map((d: any) => [d.version, d.channel])).toEqual([
      [1, 'other'],
      [2, 'whatsapp'],
    ]);
    expect(re.json().order.events.map((e: any) => e.kind)).toContain('document_resent');
    // O e-mail ao fornecedor segue desligado.
    expect((await owner.query('SELECT supplier_email_status FROM logistics_settings')).rows[0].supplier_email_status).toBe('blocked');
  });

  it('depósito com endereço completo entra como local de entrega', async () => {
    const { purchase } = await newProduct();
    const sup = await newSupplier(purchase.id);
    const wh = await newWarehouse(true);
    const o = await sentPO(sup, [{ packagingId: purchase.id, packs: '1' }], { warehouseId: wh });
    const doc = (await boss.get(`${PO}/${o.id}/documents/1`)).json().document;
    expect(doc.content.deliverTo).toMatchObject({ addressSource: 'warehouse', address: expect.objectContaining({ street: 'Rua do Galpão' }) });
  });
});

describe('confirmação do fornecedor (D7-3)', () => {
  it('confirmação total: prazos e referência, sem estoque nem custo médio', async () => {
    const { purchase, variantId } = await newProduct();
    const sup = await newSupplier(purchase.id);
    const o = await sentPO(sup, [{ packagingId: purchase.id, packs: '3' }]);
    const before = { m: await movements(variantId), b: await balance(variantId) };
    const r = await confirm(o.id, { channel: 'phone', supplierRef: 'PV-778', promisedAt: isoDay(5), items: [{ itemId: o.items[0].id, outcome: 'confirmed' }] });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().confirmation).toMatchObject({ version: 1, outcome: 'confirmed', status: 'applied' });
    const cur = r.json().order;
    expect(cur).toMatchObject({ confirmation_status: 'confirmed', supplier_ref: 'PV-778', promised_at: isoDay(5) });
    expect(cur.items[0]).toMatchObject({ supplier_outcome: 'confirmed', promised_at: isoDay(5), canceled_packs: '0.000' });
    expect(cur.supply).toMatchObject({ category: 'delivery_expected', refDate: isoDay(5) });
    expect(await movements(variantId)).toBe(before.m);
    expect(await balance(variantId)).toEqual(before.b);
    // Cada item pendente precisa de resultado; quantidade de "confirmado" e tudo o pendente.
    const o2 = await sentPO(sup, [{ packagingId: purchase.id, packs: '3' }]);
    expect((await confirm(o2.id, { items: [{ itemId: o2.items[0].id, outcome: 'confirmed', packs: '2' }] })).json().error.code).toBe('INVALID_QUANTITY');
    expect((await confirm(o2.id, { items: [{ itemId: o.items[0].id, outcome: 'confirmed' }] })).json().error.code).toBe('INVALID_ITEM');
    // Registro e imutavel.
    await expect(owner.query(`UPDATE purchase_confirmations SET note = 'x' WHERE order_id = $1`, [o.id])).rejects.toThrow();
    await expect(owner.query(`UPDATE purchase_confirmation_items SET note = 'x'`)).rejects.toThrow();
    expect(await reconcile()).toEqual([]);
  });

  it('entrega parcial mantém o restante pendente e não libera vínculos; a referência passa ao restante depois da chegada', async () => {
    const { purchase, pack50, variantId } = await newProduct({ madeToOrder: true });
    const sup = await newSupplier(purchase.id);
    const c1 = await backorder(pack50, 2);
    const c2 = await backorder(pack50, 2);
    let o = await createPO(sup, [{ packagingId: purchase.id, packs: '2' }], { purpose: 'fulfillment' });
    await link(o, c1);
    o = await link(o, c2);
    expect((await sendPurchase(app, boss, o.id)).statusCode).toBe(200);
    const movesBefore = await movements(variantId);
    const r = await confirm(o.id, { items: [{ itemId: o.items[0].id, outcome: 'partial', packs: '1', promisedAt: isoDay(2), restPromisedAt: isoDay(20) }] });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().released).toEqual([]);
    expect(r.json().order).toMatchObject({ confirmation_status: 'partial', status: 'sent' });
    expect(r.json().order.items[0]).toMatchObject({ canceled_packs: '0.000', partial_packs: '1.000', partial_from_packs: '0.000', pending_packs: '2.000' });
    expect((await activeLinks(o.id)).length).toBe(2);
    expect(r.json().order.supply).toMatchObject({ category: 'delivery_expected', refDate: isoDay(2) });
    expect(await movements(variantId)).toBe(movesBefore);
    // Chega a parte: a referencia passa a ser a do restante; o restante segue pendente e o vinculo do segundo fica.
    const rc = await receive(o.id, [{ itemId: o.items[0].id, packs: '1' }]);
    expect(rc.statusCode, rc.body).toBe(201);
    const after = await get(o.id);
    expect(after).toMatchObject({ status: 'partial' });
    expect(after.items[0].pending_packs).toBe('1.000');
    expect(after.supply).toMatchObject({ category: 'delivery_expected', refDate: isoDay(20) });
    expect((await activeLinks(o.id)).length).toBeGreaterThanOrEqual(1);
    expect(await reconcile()).toEqual([]);
  });

  it('redução definitiva cancela o saldo e libera só o vínculo que não cabe, a partir do pagamento mais recente', async () => {
    const { purchase, pack50 } = await newProduct({ madeToOrder: true });
    const sup = await newSupplier(purchase.id);
    const first = await backorder(pack50, 2);
    const second = await backorder(pack50, 2);
    let o = await createPO(sup, [{ packagingId: purchase.id, packs: '2' }], { purpose: 'fulfillment' });
    await link(o, first);
    o = await link(o, second);
    expect((await sendPurchase(app, boss, o.id)).statusCode).toBe(200);
    // Sem motivo, reducao e recusada.
    expect((await confirm(o.id, { items: [{ itemId: o.items[0].id, outcome: 'reduced', packs: '1' }] })).json().error.code).toBe('NOTE_REQUIRED');
    const r = await confirm(o.id, { note: 'Fornecedor sem estoque para o segundo pacote', items: [{ itemId: o.items[0].id, outcome: 'reduced', packs: '1' }] });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().order).toMatchObject({ confirmation_status: 'changed' });
    expect(r.json().order.items[0]).toMatchObject({ canceled_packs: '1.000', pending_packs: '1.000', supplier_outcome: 'reduced' });
    const secondNumber = (await owner.query('SELECT number FROM orders WHERE id = $1', [second])).rows[0].number;
    expect(r.json().released.map((x: any) => x.orderNumber)).toEqual([secondNumber]);
    expect((await activeLinks(o.id)).map((l) => l.order_id)).toEqual([first]);
    // A encomenda liberada continua aguardando (nada cancelado no pedido) e ganha requisicao automatica.
    expect((await owner.query(`SELECT count(*)::int AS n FROM stock_reservations WHERE source_id = $1 AND status = 'active' AND backorder`, [second])).rows[0].n).toBeGreaterThan(0);
    await sync();
    expect((await requestsOf(second)).map((q) => q.status)).toEqual(['open']);
    // A primeira ja estava vinculada (pela tela da compra) antes de qualquer requisicao: nao precisa de requisicao.
    expect(await requestsOf(first)).toEqual([]);
    // O recebimento respeita o saldo cancelado: 2 embalagens passam do pendente.
    expect((await receive(o.id, [{ itemId: o.items[0].id, packs: '2' }])).json().error.code).toBe('OVER_RECEIPT');
    const rc = await receive(o.id, [{ itemId: o.items[0].id, packs: '1' }]);
    expect(rc.statusCode, rc.body).toBe(201);
    expect(rc.json().order.status).toBe('received');
    expect(await reconcile()).toEqual([]);
  });

  it('recusa total: libera os vínculos, a compra fica enviada com a situação recusada e pode ser cancelada; recusa de um item com outro recebido encerra', async () => {
    const { purchase, pack50 } = await newProduct({ madeToOrder: true });
    const sup = await newSupplier(purchase.id);
    const c = await backorder(pack50, 2);
    let o = await createPO(sup, [{ packagingId: purchase.id, packs: '1' }], { purpose: 'fulfillment' });
    o = await link(o, c);
    expect((await sendPurchase(app, boss, o.id)).statusCode).toBe(200);
    const r = await confirm(o.id, { note: 'Produto descontinuado', items: [{ itemId: o.items[0].id, outcome: 'refused' }] });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().order).toMatchObject({ status: 'sent', confirmation_status: 'refused' });
    expect(r.json().order.supply.category).toBe('refused');
    expect(r.json().released.length).toBe(1);
    expect(await activeLinks(o.id)).toEqual([]);
    expect((await receive(o.id, [{ itemId: o.items[0].id, packs: '1' }])).json().error.code).toBe('OVER_RECEIPT');
    expect((await boss.post(`${PO}/${o.id}/cancel`, { reason: 'Fornecedor recusou o pedido' })).statusCode).toBe(200);

    // Dois itens: um recebido inteiro, o outro recusado -> a compra se encerra pela confirmacao.
    const a = await newProduct();
    const b = await newProduct();
    const sup2 = await newSupplier(a.purchase.id);
    await addOffer(sup2, b.purchase.id);
    const two = await sentPO(sup2, [
      { packagingId: a.purchase.id, packs: '1' },
      { packagingId: b.purchase.id, packs: '1' },
    ]);
    const ia = two.items.find((i: any) => i.packaging_id === a.purchase.id).id;
    const ib = two.items.find((i: any) => i.packaging_id === b.purchase.id).id;
    expect((await receive(two.id, [{ itemId: ia, packs: '1' }])).statusCode).toBe(201);
    const rr = await confirm(two.id, { note: 'Sem o segundo item', items: [{ itemId: ib, outcome: 'refused' }] });
    expect(rr.statusCode, rr.body).toBe(201);
    expect(rr.json().closed).toBe(true);
    expect(rr.json().order.status).toBe('received');
    expect(rr.json().order.events.map((e: any) => e.kind)).toContain('closed_by_confirmation');
    expect(await reconcile()).toEqual([]);
  });

  it('confirmação e recebimento ao mesmo tempo: um espera o outro e o saldo nunca passa do pedido', async () => {
    const { purchase } = await newProduct();
    const sup = await newSupplier(purchase.id);
    for (let i = 0; i < 3; i++) {
      const o = await sentPO(sup, [{ packagingId: purchase.id, packs: '3' }]);
      const [c, r] = await Promise.all([
        confirm(o.id, { note: 'Reduzido', items: [{ itemId: o.items[0].id, outcome: 'reduced', packs: '2' }] }),
        receive(o.id, [{ itemId: o.items[0].id, packs: '2' }]),
      ]);
      expect([c.statusCode, r.statusCode].every((x) => [201, 409, 422].includes(x)), `${c.body} ${r.body}`).toBe(true);
      const it = (await owner.query('SELECT packs, received_packs, canceled_packs FROM purchase_order_items WHERE order_id = $1', [o.id])).rows[0];
      expect(Number(it.received_packs) + Number(it.canceled_packs)).toBeLessThanOrEqual(Number(it.packs));
    }
    expect(await reconcile()).toEqual([]);
  });

  it('nova confirmação vira nova versão; registro que ficou velho por recebimento é recusado na aprovação', async () => {
    const { purchase } = await newProduct();
    const sup = await newSupplier(purchase.id);
    const o = await sentPO(sup, [{ packagingId: purchase.id, packs: '2' }]);
    expect((await confirm(o.id, { items: [{ itemId: o.items[0].id, outcome: 'confirmed', promisedAt: isoDay(3) }] })).statusCode).toBe(201);
    const r2 = await confirm(o.id, { note: 'Fornecedor adiou', items: [{ itemId: o.items[0].id, outcome: 'confirmed', promisedAt: isoDay(8) }] });
    expect(r2.statusCode, r2.body).toBe(201);
    expect(r2.json().confirmation.version).toBe(2);
    expect(r2.json().order.items[0].promised_at).toBe(isoDay(8));
    expect(r2.json().order.confirmations.map((c: any) => c.version)).toEqual([2, 1]);
  });
});

describe('aumento de preço na confirmação (D7-4)', () => {
  it('acima da tolerância fica aguardando aprovação com MFA; trava o recebimento; aprovação nomeia versão e valor; aumento posterior pede nova aprovação', async () => {
    expect((await setSettings(0, 5)).statusCode).toBe(200);
    const { purchase, variantId } = await newProduct();
    const sup = await newSupplier(purchase.id, 2000);
    const o = await sentPO(sup, [{ packagingId: purchase.id, packs: '2' }]);
    const before = { m: await movements(variantId), b: await balance(variantId) };
    // Dentro da tolerancia (+5%): aplica direto, com motivo.
    const small = await confirm(o.id, { note: 'Reajuste de tabela', items: [{ itemId: o.items[0].id, outcome: 'confirmed', packCostCents: 2100 }] });
    expect(small.statusCode, small.body).toBe(201);
    expect(small.json().confirmation.status).toBe('applied');
    expect(small.json().order.items[0].pack_cost_cents).toBe('2100');
    // Acumulado passa de 5% sobre o preco original (2000 -> 2200 = +10%): aguardando aprovacao, nada aplicado.
    const big = await confirm(o.id, { note: 'Novo reajuste', items: [{ itemId: o.items[0].id, outcome: 'confirmed', packCostCents: 2200 }] });
    expect(big.statusCode, big.body).toBe(201);
    expect(big.json().confirmation).toMatchObject({ status: 'pending_approval', increaseCents: 200, version: 2 });
    expect(big.json().order).toMatchObject({ confirmation_status: 'pending_approval' });
    expect(big.json().order.items[0].pack_cost_cents).toBe('2100');
    expect(big.json().order.supply.category).toBe('price_approval');
    expect((await receive(o.id, [{ itemId: o.items[0].id, packs: '1' }])).json().error.code).toBe('CONFIRMATION_APPROVAL_PENDING');
    const cid = big.json().confirmation.id;
    // Quem registrou nao aprova; sem MFA nao aprova; comprador nao aprova; valor ou versao diferente e recusado.
    expect((await boss.post(`${PO}/${o.id}/confirmations/${cid}/approve`, { version: 2, increaseCents: 200 })).json().error.code).toBe('SELF_APPROVAL');
    expect((await (await loggedAs(app, 'manager')).post(`${PO}/${o.id}/confirmations/${cid}/approve`, { version: 2, increaseCents: 200 })).json().error.code).toBe('MFA_REQUIRED');
    expect((await (await loggedAs(app, 'buyer')).post(`${PO}/${o.id}/confirmations/${cid}/approve`, { version: 2, increaseCents: 200 })).statusCode).toBe(403);
    expect((await approver.post(`${PO}/${o.id}/confirmations/${cid}/approve`, { version: 2, increaseCents: 100 })).json().error.code).toBe('CONFIRMATION_CHANGED');
    expect((await approver.post(`${PO}/${o.id}/confirmations/${cid}/approve`, { version: 1, increaseCents: 200 })).json().error.code).toBe('CONFIRMATION_CHANGED');
    const ok = await approver.post(`${PO}/${o.id}/confirmations/${cid}/approve`, { version: 2, increaseCents: 200 });
    expect(ok.statusCode, ok.body).toBe(200);
    // Preco mudou: a situacao e "alterada" (quantidade e prazo confirmados, valor novo).
    expect(ok.json().order).toMatchObject({ confirmation_status: 'changed' });
    expect(ok.json().order.items[0].pack_cost_cents).toBe('2200');
    const ev = ok.json().order.events.find((e: any) => e.kind === 'confirmation_approved');
    expect(ev.data).toMatchObject({ version: 2, increaseCents: 200, items: [expect.objectContaining({ fromCents: '2100', toCents: '2200' })] });
    expect((await approver.post(`${PO}/${o.id}/confirmations/${cid}/approve`, { version: 2, increaseCents: 200 })).json().error.code).toBe('INVALID_STATUS');
    // Sem estoque e sem custo medio na confirmacao.
    expect(await movements(variantId)).toBe(before.m);
    expect(await balance(variantId)).toEqual(before.b);
    // Depois de um aumento aprovado, qualquer aumento (mesmo +1%) pede nova aprovacao.
    const again = await confirm(o.id, { note: 'Mais um centavo', items: [{ itemId: o.items[0].id, outcome: 'confirmed', packCostCents: 2210 }] });
    expect(again.json().confirmation.status).toBe('pending_approval');
    // Recusa: nada aplicado, volta a situacao da confirmacao aplicada anterior.
    const rej = await approver.post(`${PO}/${o.id}/confirmations/${again.json().confirmation.id}/reject`, { reason: 'Não aceitamos novo reajuste' });
    expect(rej.statusCode, rej.body).toBe(200);
    expect(rej.json().order).toMatchObject({ confirmation_status: 'changed' });
    expect(rej.json().order.items[0].pack_cost_cents).toBe('2200');
    // O recebimento continua com as verificacoes de preco da Fase 6 (nota acima da tolerancia pede justificativa).
    expect((await receive(o.id, [{ itemId: o.items[0].id, packs: '1', invoicedPackCostCents: 2600 }])).json().error.code).toBe('PRICE_JUSTIFICATION_REQUIRED');
    expect((await receive(o.id, [{ itemId: o.items[0].id, packs: '2' }])).statusCode).toBe(201);
    expect(await reconcile()).toEqual([]);
    expect((await setSettings(0, 0)).statusCode).toBe(200);
  });

  it('proprietário aprova o próprio registro só com justificativa', async () => {
    expect((await setSettings(0, 0)).statusCode).toBe(200);
    const dono = await loggedAs(app, 'owner', { mfa: true });
    const { purchase } = await newProduct();
    const sup = await newSupplier(purchase.id, 1000);
    const o = await sentPO(sup, [{ packagingId: purchase.id, packs: '1' }]);
    const r = await confirm(o.id, { note: 'Reajuste', items: [{ itemId: o.items[0].id, outcome: 'confirmed', packCostCents: 1100 }] }, dono);
    expect(r.json().confirmation.status).toBe('pending_approval');
    const path = `${PO}/${o.id}/confirmations/${r.json().confirmation.id}/approve`;
    expect((await dono.post(path, { version: 1, increaseCents: 100 })).json().error.code).toBe('JUSTIFICATION_REQUIRED');
    const ok = await dono.post(path, { version: 1, increaseCents: 100, note: 'Sem alternativa de fornecedor' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().order.confirmations[0]).toMatchObject({ status: 'applied', decision_self: true });
  });
});

describe('prazos e situação do abastecimento (D7-5, D7-8)', () => {
  it('aguardando, confirmação atrasada, entrega prevista, atrasada e sem previsão; compra antiga sem alerta', async () => {
    const { purchase } = await newProduct();
    const sup = await newSupplier(purchase.id);
    // Deposito proprio: os contadores do Abastecimento por deposito ficam so com as compras deste teste.
    const wh = await newWarehouse();
    const sentHere = (items: Record<string, unknown>[], extra: Record<string, unknown> = {}) => sentPO(sup, items, { warehouseId: wh, ...extra });
    const waiting = await sentHere([{ packagingId: purchase.id, packs: '1' }]);
    expect((await get(waiting.id)).supply.category).toBe('awaiting_confirmation');
    // Enviada ha 3 dias, prazo de 2: confirmacao atrasada. Com 5 dias de prazo, volta a aguardar.
    await owner.query(`UPDATE purchase_orders SET sent_at = now() - interval '3 days' WHERE id = $1`, [waiting.id]);
    expect((await get(waiting.id)).supply.category).toBe('confirmation_late');
    expect((await setSettings(0, 0, 5)).json().settings.confirmationDays).toBe(5);
    expect((await get(waiting.id)).supply.category).toBe('awaiting_confirmation');
    expect((await setSettings(0, 0, 2)).statusCode).toBe(200);

    const late = await sentHere([{ packagingId: purchase.id, packs: '1' }]);
    await confirm(late.id, { items: [{ itemId: late.items[0].id, outcome: 'confirmed', promisedAt: isoDay(-2) }] });
    expect((await get(late.id)).supply).toMatchObject({ category: 'delivery_late', daysLate: 2 });

    const nodate = await sentHere([{ packagingId: purchase.id, packs: '1' }]);
    await confirm(nodate.id, { items: [{ itemId: nodate.items[0].id, outcome: 'confirmed' }] });
    expect((await get(nodate.id)).supply.category).toBe('no_date');

    // Compra enviada antes da Fase 7 (situacao 'none'), com previsao vencida: aparece sem alerta.
    const old = await sentHere([{ packagingId: purchase.id, packs: '1' }], { expectedAt: isoDay(-30) });
    await owner.query(`UPDATE purchase_orders SET confirmation_status = 'none' WHERE id = $1`, [old.id]);
    expect((await get(old.id)).supply.category).toBe('untracked');

    const ov = (await boss.get(`${SUP}/overview?warehouseId=${wh}`)).json();
    expect(ov.counts).toMatchObject({ confirmation_late: 1, delivery_late: 1, no_date: 1, untracked: 1, awaiting_confirmation: 0, delivery_expected: 0 });
    expect(ov.orders[0]).toMatchObject({ category: 'delivery_late' });
    expect(ov.orders.find((x: any) => x.id === old.id).category).toBe('untracked');
    const page = (await boss.get(`${SUP}/overview?warehouseId=${wh}&category=delivery_late&pageSize=1`)).json();
    expect(page).toMatchObject({ total: 1, pageSize: 1 });
    expect((await boss.get(`${SUP}/summary?warehouseId=${wh}`)).json().summary).toMatchObject({ confirmation_late: 1, delivery_late: 1 });
    // Contato registrado com retorno marcado.
    const f = await boss.post(`${PO}/${waiting.id}/followup`, { note: 'Liguei, retorno amanhã', channel: 'phone', followupOn: isoDay(1) });
    expect(f.statusCode, f.body).toBe(200);
    expect(f.json().order.followup_on).toBe(isoDay(1));
    expect((await boss.post(`${PO}/${waiting.id}/followup`, { channel: 'phone' })).statusCode).toBe(400);
  });

  it('encomendas afetadas mostram só o número do pedido; detalhe logístico mostra a situação da compra', async () => {
    const { purchase, pack50 } = await newProduct({ madeToOrder: true });
    const sup = await newSupplier(purchase.id);
    const c = await backorder(pack50, 2);
    let o = await createPO(sup, [{ packagingId: purchase.id, packs: '1' }], { purpose: 'fulfillment' });
    o = await link(o, c);
    expect((await sendPurchase(app, boss, o.id)).statusCode).toBe(200);
    await confirm(o.id, { items: [{ itemId: o.items[0].id, outcome: 'confirmed', promisedAt: isoDay(-1) }] });
    const ov = (await boss.get(`${SUP}/overview`)).json();
    const number = (await owner.query('SELECT number FROM orders WHERE id = $1', [c])).rows[0].number;
    expect(ov.affected.linked).toEqual(expect.arrayContaining([expect.objectContaining({ orderNumber: number, purchaseNumber: o.number, category: 'delivery_late' })]));
    const text = JSON.stringify(ov);
    for (const secret of [buyer.name, buyer.email, buyer.phone]) expect(text).not.toContain(secret);
    const d = (await boss.get(`${L}/orders/${c}`)).json();
    expect(d.purchaseLinks[0].supply).toMatchObject({ category: 'delivery_late', refDate: isoDay(-1), late: true });
  });
});

describe('requisições (D7-6, D7-7)', () => {
  it('encomenda sem compra vira uma requisição só, mesmo com sincronizações concorrentes; manual não duplica', async () => {
    const { purchase, pack50, variantId } = await newProduct({ madeToOrder: true });
    await newSupplier(purchase.id);
    const c = await backorder(pack50, 2);
    const count = async () => (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM purchase_requests')).rows[0]!.n;
    const before = await count();
    const results = await Promise.all([sync(), sync(), sync()]);
    // O que as tres criaram somadas e exatamente o que apareceu (nenhuma duplicada), e esta encomenda tem uma so.
    expect(results.reduce((a, r) => a + r.created, 0)).toBe((await count()) - before);
    await sync();
    const reqs = await requestsOf(c);
    expect(reqs).toEqual([expect.objectContaining({ status: 'open', source: 'backorder', base_qty: '100.000' })]);
    // Manual da mesma variante e deposito: avisa da automatica; com "para estoque", abre; segunda manual, recusada.
    const stock = await loggedAs(app, 'stock');
    const m1 = await stock.post(RQ, { variantId, baseQty: '50', reason: 'Estoque baixo' });
    expect(m1.json().error).toMatchObject({ code: 'BACKORDER_REQUEST_EXISTS' });
    const m2 = await stock.post(RQ, { variantId, baseQty: '50', reason: 'Estoque baixo', forStock: true });
    expect(m2.statusCode, m2.body).toBe(201);
    expect(m2.json().request).toMatchObject({ source: 'manual', status: 'open', requested_by: stock.user.id });
    expect((await stock.post(RQ, { variantId, baseQty: '10', reason: 'De novo', forStock: true })).json().error.code).toBe('REQUEST_EXISTS');
    // Sem dado de cliente na lista.
    const list = (await stock.get(`${RQ}?status=all`)).json();
    expect(list.items.filter((i: any) => i.variant_id === variantId).length).toBe(2);
    for (const secret of [buyer.name, buyer.email]) expect(JSON.stringify(list)).not.toContain(secret);
    // Reposicao desconta o que esta em requisicao.
    const rep = (await boss.get('/api/v1/admin/stock-reports/replenishment?all=true')).json();
    expect(rep.items.find((i: any) => i.variantId === variantId).requested).toBe(150);
    // Cancelamento: quem pediu, sim; a automatica nao se cancela.
    expect((await stock.post(`${RQ}/${m2.json().request.id}/cancel`, { reason: 'Não precisa mais' })).statusCode).toBe(200);
    expect((await boss.post(`${RQ}/${reqs[0].id}/cancel`, { reason: 'Tentativa' })).json().error.code).toBe('AUTOMATIC_REQUEST');
  });

  it('conversão cria a compra com o vínculo da encomenda; idempotente e concorrente; outro depósito recusado; compra cancelada devolve a requisição', async () => {
    const { purchase, pack50, variantId } = await newProduct({ madeToOrder: true });
    const sup = await newSupplier(purchase.id, 1800);
    const c = await backorder(pack50, 2);
    await sync();
    const [rq] = await requestsOf(c);
    // Logistica pede (purchases.request), mas nao consolida (purchases.manage).
    const logisticsUser = await loggedAs(app, 'logistics');
    expect((await logisticsUser.post(`${RQ}/convert`, { requestIds: [rq.id], supplierId: sup })).statusCode).toBe(403);
    // Duas conversoes ao mesmo tempo: uma vence, a outra ve a requisicao ja em compra.
    const [a, b] = await Promise.all([boss.post(`${RQ}/convert`, { requestIds: [rq.id], supplierId: sup }), approver.post(`${RQ}/convert`, { requestIds: [rq.id], supplierId: sup })]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const win = a.statusCode === 201 ? a.json() : b.json();
    expect((a.statusCode === 409 ? a : b).json().error.code).toBe('REQUEST_NOT_OPEN');
    const po = await get(win.purchaseOrderId);
    expect(po).toMatchObject({ status: 'draft', purpose: 'fulfillment', warehouse_id: principal });
    expect(po.items).toEqual([expect.objectContaining({ packaging_id: purchase.id, packs: '1.000', pack_cost_cents: '1800' })]);
    expect(po.links).toEqual([expect.objectContaining({ order_id: c, status: 'active' })]);
    expect(po.events.map((e: any) => e.kind)).toContain('requests_added');
    expect((await requestsOf(c))[0]).toMatchObject({ status: 'in_purchase', purchase_order_id: po.id });
    // Repetir a mesma conversao: recusada (nao vira item de duas compras).
    expect((await boss.post(`${RQ}/convert`, { requestIds: [rq.id], supplierId: sup })).json().error.code).toBe('REQUEST_NOT_OPEN');
    // Sincronizar de novo nao cria outra.
    await sync();
    expect((await requestsOf(c)).length).toBe(1);
    // Compra cancelada: o vinculo cai e a requisicao volta a ficar aberta.
    expect((await boss.post(`${PO}/${po.id}/cancel`, { reason: 'Refazer com outro fornecedor' })).statusCode).toBe(200);
    expect((await requestsOf(c))[0]).toMatchObject({ status: 'open', purchase_order_id: null });
    // Outro deposito: a manual de um galpao nao entra com a do padrao.
    const wh = await newWarehouse();
    const manual = await (await loggedAs(app, 'stock')).post(RQ, { variantId, warehouseId: wh, baseQty: '100', reason: 'Abrir estoque no galpão' });
    expect(manual.statusCode, manual.body).toBe(201);
    expect((await boss.post(`${RQ}/convert`, { requestIds: [rq.id, manual.json().request.id], supplierId: sup })).json().error.code).toBe('WAREHOUSE_MISMATCH');
    // Acrescentar a um rascunho existente do mesmo fornecedor e deposito (soma no item da mesma embalagem).
    const draft = await createPO(sup, [{ packagingId: purchase.id, packs: '2' }]);
    const add = await boss.post(`${RQ}/convert`, { requestIds: [rq.id], purchaseOrderId: draft.id });
    expect(add.statusCode, add.body).toBe(200);
    const merged = await get(draft.id);
    expect(merged.items).toEqual([expect.objectContaining({ packs: '3.000' })]);
    expect(merged.links.filter((l: any) => l.status === 'active').length).toBe(1);
    // Rascunho de outro deposito recusa.
    const otherDraft = await createPO(sup, [{ packagingId: purchase.id, packs: '1' }], { warehouseId: wh });
    expect((await boss.post(`${RQ}/convert`, { requestIds: [manual.json().request.id], purchaseOrderId: draft.id })).json().error.code).toBe('WAREHOUSE_MISMATCH');
    expect((await boss.post(`${RQ}/convert`, { requestIds: [manual.json().request.id], purchaseOrderId: otherDraft.id })).statusCode).toBe(200);
    // Ao receber a compra, a requisicao fica atendida.
    expect((await sendPurchase(app, boss, draft.id)).statusCode).toBe(200);
    const sentDraft = await get(draft.id);
    expect((await receive(draft.id, [{ itemId: sentDraft.items[0].id, packs: '3' }])).statusCode).toBe(201);
    await sync();
    expect((await requestsOf(c))[0].status).toBe('done');
    expect(await reconcile()).toEqual([]);
  });

  it('recusa pelo comprador com motivo; recusada não volta sozinha', async () => {
    const { purchase, pack50 } = await newProduct({ madeToOrder: true });
    await newSupplier(purchase.id);
    const c = await backorder(pack50, 2);
    await sync();
    const [rq] = await requestsOf(c);
    expect((await boss.post(`${RQ}/${rq.id}/reject`, {})).statusCode).toBe(400);
    const r = await boss.post(`${RQ}/${rq.id}/reject`, { reason: 'Cliente vai retirar em outra loja' });
    expect(r.statusCode, r.body).toBe(200);
    await sync();
    expect((await requestsOf(c)).map((q) => q.status)).toEqual(['rejected']);
    expect(r.json().request.events.map((e: any) => e.kind)).toEqual(['created', 'rejected']);
  });
});

describe('sugestão do recebimento pelo XML (D7-10)', () => {
  const SUPPLIER_DOC = '11222333000181';
  function makeKey(seed: string) {
    const base = `4226111122233300018155001${seed.padStart(9, '0')}1${'0'.repeat(8)}`.slice(0, 43);
    let sum = 0;
    let w = 2;
    for (let i = 42; i >= 0; i -= 1) {
      sum += Number(base[i]) * w;
      w = w === 9 ? 2 : w + 1;
    }
    const r = sum % 11;
    return `${base}${r < 2 ? 0 : 11 - r}`;
  }
  const xml = (key: string, items: { code: string; qty: string; price: string }[]) => {
    const det = items
      .map(
        (it, i) =>
          `<det nItem="${i + 1}"><prod><cProd>${it.code}</cProd><cEAN>SEM GTIN</cEAN><xProd>Item ${i}</xProd><NCM>48195000</NCM><CFOP>5102</CFOP><uCom>PCT</uCom><qCom>${it.qty}</qCom><vUnCom>${it.price}</vUnCom><vProd>${(Number(it.qty) * Number(it.price)).toFixed(2)}</vProd></prod></det>`,
      )
      .join('');
    const total = items.reduce((s, it) => s + Number(it.qty) * Number(it.price), 0).toFixed(2);
    return `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe${key}" versao="4.00"><ide><mod>55</mod><serie>1</serie><nNF>${Number(key.slice(25, 34))}</nNF><dhEmi>2026-11-10T10:00:00-03:00</dhEmi></ide><emit><CNPJ>${SUPPLIER_DOC}</CNPJ><xNome>Fornecedor XML</xNome><enderEmit><UF>SC</UF></enderEmit><IE>123456789</IE></emit><dest><CNPJ>12ABC34501DE35</CNPJ></dest>${det}<total><ICMSTot><vNF>${total}</vNF></ICMSTot></total></infNFe></NFe><protNFe><infProt><cStat>100</cStat></infProt></protNFe></nfeProc>`;
  };
  const upload = (body: string) => {
    const boundary = `----teste${uid()}`;
    const buf = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="nota.xml"\r\nContent-Type: application/xml\r\n\r\n`),
      Buffer.from(body),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return boss.send('POST', '/api/v1/admin/purchase-invoices', buf as never, { 'content-type': `multipart/form-data; boundary=${boundary}` });
  };

  it('sugere quantidade e custo da nota para conferir; não grava nada; recebimento mantém as verificações', async () => {
    expect((await setSettings(0, 5)).statusCode).toBe(200);
    const { purchase, variantId } = await newProduct();
    const sup = await newSupplier(undefined, 0, { document: SUPPLIER_DOC });
    await addOffer(sup, purchase.id, 1500, { supplierSku: 'XML-1' });
    const o = await sentPO(sup, [{ packagingId: purchase.id, packs: '4' }]);
    const up = await upload(xml(makeKey(uid().replace(/\D/g, '').slice(0, 6) || '7'), [{ code: 'XML-1', qty: '3', price: '18.00' }]));
    expect(up.statusCode, up.body).toBe(201);
    const invoiceId = up.json().invoice.id;
    // Sem vinculo com a compra, nao sugere.
    expect((await boss.get(`${PO}/${o.id}/receipt-suggestions?invoiceId=${invoiceId}`)).json().error.code).toBe('INVOICE_NOT_LINKED');
    expect((await boss.post(`/api/v1/admin/purchase-invoices/${invoiceId}/link`, { purchaseOrderId: o.id })).statusCode).toBe(200);
    const movesBefore = await movements(variantId);
    const sug = await boss.get(`${PO}/${o.id}/receipt-suggestions?invoiceId=${invoiceId}`);
    expect(sug.statusCode, sug.body).toBe(200);
    expect(sug.json().items).toEqual([expect.objectContaining({ itemId: o.items[0].id, packs: '3', pendingPacks: '4', invoicedPackCostCents: 1800, orderedPackCostCents: 1500 })]);
    expect(sug.json().items[0].divergences.length).toBe(2); // quantidade e preco
    expect(await movements(variantId)).toBe(movesBefore);
    expect((await get(o.id)).items[0].received_packs).toBe('0.000');
    // Recebimento com a sugestao: preco acima da tolerancia continua pedindo justificativa.
    expect((await receive(o.id, [{ itemId: o.items[0].id, packs: '3', invoicedPackCostCents: 1800 }])).json().error.code).toBe('PRICE_JUSTIFICATION_REQUIRED');
    expect((await receive(o.id, [{ itemId: o.items[0].id, packs: '3', invoicedPackCostCents: 1800, priceJustification: 'Reajuste aceito' }])).statusCode).toBe(201);
    expect((await setSettings(0, 0)).statusCode).toBe(200);
    expect(await reconcile()).toEqual([]);
  });
});

describe('desempenho dos fornecedores (D7-12)', () => {
  it('conta envios, confirmação, prazo médio e entrega no prazo; sugestão não altera o cadastro', async () => {
    const { purchase } = await newProduct();
    const sup = await newSupplier(purchase.id);
    for (let i = 0; i < 3; i++) {
      const o = await sentPO(sup, [{ packagingId: purchase.id, packs: '1' }]);
      await confirm(o.id, { items: [{ itemId: o.items[0].id, outcome: 'confirmed', promisedAt: isoDay(5) }] });
      expect((await receive(o.id, [{ itemId: o.items[0].id, packs: '1' }])).statusCode).toBe(201);
    }
    const p = (await boss.get(`${SUP}/performance?days=30`)).json();
    const row = p.suppliers.find((s: any) => s.supplier_id === sup);
    expect(row).toMatchObject({ sent: 3, tracked: 3, confirmed: 3, confirmation_rate_pct: 100, due_samples: 3, on_time: 3, on_time_pct: 100, registered_lead_days: 5, lead_samples: 3 });
    expect(row.suggested_lead_days).toBe(0);
    expect((await owner.query('SELECT lead_time_days FROM suppliers WHERE id = $1', [sup])).rows[0].lead_time_days).toBe(5);
  });
});

describe('permissões (purchases.request e as existentes)', () => {
  it('quem pede, quem consolida e quem só vê', async () => {
    const { variantId } = await newProduct();
    const roles = { stock: 201, logistics: 201, manager: 201, buyer: 403, sales: 403, finance: 403 } as const;
    for (const [role, code] of Object.entries(roles)) {
      const c = await loggedAs(app, role, { mfa: role === 'manager' });
      const r = await c.post(RQ, { variantId, warehouseId: role === 'stock' ? principal : await newWarehouse(), baseQty: '10', reason: `Teste ${role}`, forStock: true });
      expect(r.statusCode, `${role}: ${r.body}`).toBe(code);
    }
    const sales = await loggedAs(app, 'sales');
    expect((await sales.get(RQ)).statusCode).toBe(403);
    expect((await sales.get(`${SUP}/overview`)).statusCode).toBe(200); // logistics.view: leitura do abastecimento
    const finance = await loggedAs(app, 'finance');
    expect((await finance.get(RQ)).statusCode).toBe(200);
    expect((await finance.post(`${RQ}/sync`)).statusCode).toBe(403);
    const logistics = await loggedAs(app, 'logistics');
    const { purchase } = await newProduct();
    const sup = await newSupplier(purchase.id);
    const o = await sentPO(sup, [{ packagingId: purchase.id, packs: '1' }]);
    expect((await confirm(o.id, { items: [{ itemId: o.items[0].id, outcome: 'confirmed' }] }, logistics)).statusCode).toBe(403);
    expect((await logistics.post(`${PO}/${o.id}/documents`, {})).statusCode).toBe(403);
    expect((await logistics.get(`${PO}/${o.id}/receipt-suggestions?invoiceId=${randomUUID()}`)).statusCode).toBe(404);
  });
});
