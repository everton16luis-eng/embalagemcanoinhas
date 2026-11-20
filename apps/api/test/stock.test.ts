import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, tx } from '../src/db/pool.js';
import { expireReservations } from '../src/lib/stock.js';
import { appRole, loggedAs, makeApp, sendPurchase, owner, productPayload, resetCatalog, uid } from './helpers.js';

let app: FastifyInstance;
let boss: Awaited<ReturnType<typeof loggedAs>>;
beforeAll(async () => {
  app = await makeApp();
  await resetCatalog();
  // Gerente: estoque, compras e relatorios. Sem MFA basta, nada aqui e permissao sensivel.
  boss = await loggedAs(app, 'manager', { mfa: true });
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

const S = '/api/v1/admin/stock';
const PO = '/api/v1/admin/purchase-orders';
const SUP = '/api/v1/admin/suppliers';
const key = () => `req-${uid()}-${uid()}`;

type Pack = { id: string; kind: string; label: string; base_qty: string };
async function newProduct(overrides: Record<string, unknown> = {}) {
  const res = await boss.post('/api/v1/admin/products', productPayload(overrides));
  expect(res.statusCode, res.body).toBe(201);
  const p = res.json().product;
  const v = p.variants[0];
  const packs = v.packagings as Pack[];
  return { product: p, variantId: v.id as string, purchase: packs.find((k) => k.kind === 'purchase')!, packs };
}
async function newSupplier(name = `Distribuidora ${uid()}`, extra: Record<string, unknown> = {}) {
  const res = await boss.post(SUP, { name, leadTimeDays: 5, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().supplier.id as string;
}
const balance = async (variantId: string) => (await boss.get(`${S}/variants/${variantId}`)).json().variant;

/** Pedido enviado ao fornecedor, pronto para receber. */
async function sentOrder(supplierId: string, items: unknown[], extra: Record<string, unknown> = {}) {
  const res = await boss.post(PO, { supplierId, items, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  const order = res.json().order;
  expect((await sendPurchase(app, boss, order.id)).statusCode).toBe(200);
  return order;
}

describe('compra, custo e venda fracionada', () => {
  it('compra 1 pacote de 100, vende 5 unidades e restam 95, com frete no custo', async () => {
    const { variantId, purchase } = await newProduct();
    const supplierId = await newSupplier();
    expect((await boss.put(`${SUP}/${supplierId}/offers`, [{ packagingId: purchase.id, costCents: 2000, supplierSku: 'F-100' }])).statusCode).toBe(200);
    // Sem custo no item: vem da lista do fornecedor.
    const order = await sentOrder(supplierId, [{ packagingId: purchase.id, packs: '1' }], { freightCents: 500 });
    expect(order.items[0].pack_cost_cents).toBe('2000');

    const rec = await boss.post(`${PO}/${order.id}/receipts`, { requestKey: key(), invoiceRef: 'NF 123', items: [{ itemId: order.items[0].id, packs: '1' }] });
    expect(rec.statusCode, rec.body).toBe(201);
    expect(rec.json().order.status).toBe('received');
    let b = await balance(variantId);
    expect(b.on_hand).toBe('100.000');
    // (20,00 do pacote + 5,00 de frete) / 100 unidades = 25 centavos por unidade
    expect(b.avg_cost_cents).toBe('25.0000');

    const r = await boss.post(`${S}/reservations`, { variantId, qty: '5', sourceId: 'balcao-1' });
    expect(r.statusCode, r.body).toBe(201);
    b = await balance(variantId);
    expect([b.on_hand, b.reserved, b.available]).toEqual(['100.000', '5.000', '95.000']);

    expect((await boss.post(`${S}/reservations/${r.json().reservation.id}/consume`)).statusCode).toBe(200);
    // Repetir a baixa nao baixa de novo.
    expect((await boss.post(`${S}/reservations/${r.json().reservation.id}/consume`)).statusCode).toBe(200);
    b = await balance(variantId);
    expect([b.on_hand, b.reserved, b.available]).toEqual(['95.000', '0.000', '95.000']);

    const kinds = (await boss.get(`${S}/variants/${variantId}`)).json().movements.map((m: { kind: string }) => m.kind);
    expect(kinds).toEqual(['sale', 'reserve', 'receipt']);
  });

  it('vende fração em quilo e recusa fração em unidade', async () => {
    const kg = await newProduct({
      baseUnit: 'KG',
      variants: [
        {
          sku: `ACU-${uid()}`.toUpperCase(),
          packagings: [
            { kind: 'sale', label: '250 g', unitCode: 'G', baseQty: '0.25', priceCents: 450 },
            { kind: 'purchase', label: 'Fardo 5 kg', unitCode: 'FD', baseQty: '5' },
          ],
        },
      ],
    });
    const supplierId = await newSupplier();
    const order = await sentOrder(supplierId, [{ packagingId: kg.purchase.id, packs: '1', packCostCents: 3000 }]);
    await boss.post(`${PO}/${order.id}/receipts`, { requestKey: key(), items: [{ itemId: order.items[0].id, packs: '1' }] });
    const r = await boss.post(`${S}/reservations`, { variantId: kg.variantId, qty: '0.250', sourceId: 'balcao-2' });
    await boss.post(`${S}/reservations/${r.json().reservation.id}/consume`);
    expect((await balance(kg.variantId)).on_hand).toBe('4.750');

    const un = await newProduct();
    const bad = await boss.post(`${S}/reservations`, { variantId: un.variantId, qty: '0.5', sourceId: 'x' });
    expect(bad.json().error.code).toBe('FRACTION_NOT_ALLOWED');
  });

  it('rateia frete pelo valor, recebe em partes, recalcula o custo médio e não recebe em dobro', async () => {
    const a = await newProduct();
    const c = await newProduct();
    const supplierId = await newSupplier();
    // Mercadoria: 2 x 10,00 + 1 x 20,00 = 40,00. Frete 4,00 = 10% sobre cada item.
    const order = await sentOrder(
      supplierId,
      [
        { packagingId: a.purchase.id, packs: '2', packCostCents: 1000 },
        { packagingId: c.purchase.id, packs: '1', packCostCents: 2000 },
      ],
      { freightCents: 400 },
    );
    const itemA = order.items.find((i: { variant_id: string }) => i.variant_id === a.variantId);
    const itemC = order.items.find((i: { variant_id: string }) => i.variant_id === c.variantId);

    const k1 = key();
    const first = await boss.post(`${PO}/${order.id}/receipts`, { requestKey: k1, items: [{ itemId: itemA.id, packs: '1' }] });
    expect(first.json().order.status).toBe('partial');
    // (10,00 + 1,00 de frete) / 100 = 11 centavos
    expect((await balance(a.variantId)).avg_cost_cents).toBe('11.0000');
    const replay = await boss.post(`${PO}/${order.id}/receipts`, { requestKey: k1, items: [{ itemId: itemA.id, packs: '1' }] });
    expect(replay.json().replayed).toBe(true);
    expect((await balance(a.variantId)).on_hand).toBe('100.000');

    // Pedido com recebimento nao muda mais (o custo ja entrou no estoque).
    expect((await boss.put(`${PO}/${order.id}`, { supplierId, items: [{ packagingId: a.purchase.id, packs: '1', packCostCents: 1 }] })).json().error.code).toBe('ORDER_LOCKED');
    expect((await boss.post(`${PO}/${order.id}/receipts`, { requestKey: key(), items: [{ itemId: itemA.id, packs: '2' }] })).json().error.code).toBe('OVER_RECEIPT');

    // Segunda entrada mais cara de A: medio ponderado. Ajuste sem custo nao mexe no medio.
    const order2 = await sentOrder(supplierId, [{ packagingId: a.purchase.id, packs: '1', packCostCents: 1700 }]);
    await boss.post(`${PO}/${order2.id}/receipts`, { requestKey: key(), items: [{ itemId: order2.items[0].id, packs: '1' }] });
    // (100 x 11 + 100 x 17) / 200 = 14
    expect((await balance(a.variantId)).avg_cost_cents).toBe('14.0000');

    const done = await boss.post(`${PO}/${order.id}/receipts`, {
      requestKey: key(),
      items: [
        { itemId: itemA.id, packs: '1' },
        { itemId: itemC.id, packs: '1' },
      ],
    });
    expect(done.json().order.status).toBe('received');
    expect((await balance(c.variantId)).avg_cost_cents).toBe('22.0000');
    const extras = await owner.query(
      'SELECT sum(ri.allocated_extra_cents)::numeric(12,2)::text AS total FROM purchase_receipt_items ri JOIN purchase_receipts r ON r.id = ri.receipt_id WHERE r.order_id = $1',
      [order.id],
    );
    // O frete inteiro entrou no custo, uma vez.
    expect(extras.rows[0].total).toBe('400.00');
  });

  it('compara fornecedores pelo custo por unidade base', async () => {
    const p = await newProduct();
    const pack50 = p.packs.find((k) => k.label === 'Pacote com 50')!;
    const s1 = await newSupplier();
    await boss.put(`${SUP}/${s1}/offers`, [{ packagingId: p.purchase.id, costCents: 1800 }]);
    const sup = (await boss.get(`${SUP}/${s1}`)).json().supplier;
    expect(sup.offers[0].unit_cost_cents).toBe('18.0000');
    // A lista substitui tudo: omitir a oferta atual e recusado (Fase 2); para desativar, ela vem com active: false.
    expect((await boss.put(`${SUP}/${s1}/offers`, [{ packagingId: pack50.id, costCents: 1000 }])).json().error?.code).toBe('OFFERS_OMITTED');
    await boss.put(`${SUP}/${s1}/offers`, [
      { packagingId: p.purchase.id, costCents: 1800, active: false },
      { packagingId: pack50.id, costCents: 1000 },
    ]);
    const after = (await boss.get(`${SUP}/${s1}`)).json().supplier.offers;
    // A oferta desativada fica inativa, nao some.
    expect(after.map((o: { active: boolean; unit_cost_cents: string }) => [o.unit_cost_cents, o.active]).sort()).toEqual([
      ['18.0000', false],
      ['20.0000', true],
    ]);
  });
});

describe('reservas e saldo', () => {
  it('duas pessoas não reservam a mesma unidade', async () => {
    const { variantId } = await newProduct();
    await boss.post(`${S}/movements`, { variantId, kind: 'adjustment', qty: '50', reason: 'Saldo de implantação', requestKey: key() });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => boss.post(`${S}/reservations`, { variantId, qty: '10', sourceId: `pedido-${i}` })));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(5);
    expect(results.filter((r) => r.statusCode === 409).every((r) => r.json().error.code === 'INSUFFICIENT_STOCK')).toBe(true);
    const b = await balance(variantId);
    expect([b.reserved, b.available]).toEqual(['50.000', '0.000']);
  });

  it('sob encomenda reserva além do físico e só baixa quando a mercadoria chega', async () => {
    const { variantId } = await newProduct({ availabilityMode: 'made_to_order', leadTimeDays: 10 });
    const r = await boss.post(`${S}/reservations`, { variantId, qty: '30', sourceId: 'encomenda-1' });
    expect(r.json().reservation.backorder).toBe(true);
    expect((await balance(variantId)).available).toBe('-30.000');
    expect((await boss.post(`${S}/reservations/${r.json().reservation.id}/consume`)).json().error.code).toBe('INSUFFICIENT_STOCK');
    expect((await boss.get(`${S}?filter=backorder`)).json().items.some((i: { variant_id: string }) => i.variant_id === variantId)).toBe(true);
  });

  it('reserva vencida volta ao disponível', async () => {
    const { variantId } = await newProduct();
    await boss.post(`${S}/movements`, { variantId, kind: 'adjustment', qty: '10', reason: 'Saldo de implantação', requestKey: key() });
    const r = (await boss.post(`${S}/reservations`, { variantId, qty: '4', sourceId: 'carrinho-1', expiresInHours: 1 })).json().reservation;
    await owner.query(`UPDATE stock_reservations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [r.id]);
    expect(await tx(null, (db) => expireReservations(db))).toBeGreaterThanOrEqual(1);
    const b = await balance(variantId);
    expect([b.reserved, b.available]).toEqual(['0.000', '10.000']);
    expect((await owner.query('SELECT status FROM stock_reservations WHERE id = $1', [r.id])).rows[0].status).toBe('expired');
  });

  it('perda exige motivo, não deixa saldo negativo e não é lançada duas vezes', async () => {
    const { variantId } = await newProduct();
    await boss.post(`${S}/movements`, { variantId, kind: 'adjustment', qty: '10', reason: 'Saldo de implantação', requestKey: key() });
    expect((await boss.post(`${S}/movements`, { variantId, kind: 'loss', qty: '2', requestKey: key() })).statusCode).toBe(400);
    const tooMuch = await boss.post(`${S}/movements`, { variantId, kind: 'damage', qty: '11', reason: 'Caixa molhada', requestKey: key() });
    expect(tooMuch.json().error.code).toBe('INSUFFICIENT_STOCK');
    const k = key();
    expect((await boss.post(`${S}/movements`, { variantId, kind: 'loss', qty: '2', reason: 'Quebra', requestKey: k })).statusCode).toBe(201);
    expect((await boss.post(`${S}/movements`, { variantId, kind: 'loss', qty: '2', reason: 'Quebra', requestKey: k })).json().replayed).toBe(true);
    expect((await balance(variantId)).on_hand).toBe('8.000');
  });

  it('movimentos e recebimentos não são alterados nem apagados pelo papel da aplicação', async () => {
    await expect(appRole.query(`UPDATE stock_movements SET on_hand_delta = 1000`)).rejects.toThrow();
    await expect(appRole.query('DELETE FROM stock_movements')).rejects.toThrow();
    await expect(appRole.query('DELETE FROM purchase_receipts')).rejects.toThrow();
    await expect(appRole.query('UPDATE purchase_receipt_items SET unit_cost_cents = 0')).rejects.toThrow();
  });

  it('quem só vende vê saldo, mas não custo', async () => {
    const sales = await loggedAs(app, 'sales');
    const items = (await sales.get(S)).json().items;
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].avg_cost_cents).toBeUndefined();
    expect((await boss.get(S)).json().items[0].avg_cost_cents).toBeDefined();
  });
});

describe('inventário', () => {
  it('contagem cega lança a diferença e só uma fica aberta', async () => {
    const { variantId } = await newProduct();
    await boss.post(`${S}/movements`, { variantId, kind: 'adjustment', qty: '20', reason: 'Saldo de implantação', requestKey: key() });
    const I = '/api/v1/admin/inventory-counts';
    const open = await boss.post(I, { variantIds: [variantId] });
    expect(open.statusCode, open.body).toBe(201);
    const id = open.json().count.id;
    expect((await boss.post(I, {})).json().error.code).toBe('COUNT_OPEN');
    expect((await boss.put(`${I}/${id}/items`, [{ variantId, countedQty: '17' }])).statusCode).toBe(200);
    const closed = (await boss.post(`${I}/${id}/close`)).json().count;
    expect(closed.status).toBe('closed');
    expect(closed.items[0]).toMatchObject({ system_qty: '20.000', diff_qty: '-3.000' });
    expect((await balance(variantId)).on_hand).toBe('17.000');
    const last = (await boss.get(`${S}/variants/${variantId}`)).json().movements[0];
    expect([last.kind, last.on_hand_delta]).toEqual(['inventory', '-3.000']);
  });
});

describe('reposição', () => {
  it('sugere a compra pelo giro e evita o pacote que prende capital', async () => {
    const p = await newProduct();
    const pack50 = p.packs.find((k) => k.label === 'Pacote com 50')!;
    const supplierId = await newSupplier(`Atacado ${uid()}`, { leadTimeDays: 7 });
    // Pacote de 100 sai a 20 centavos a unidade; o de 50, a 22.
    await boss.put(`${SUP}/${supplierId}/offers`, [
      { packagingId: p.purchase.id, costCents: 2000 },
      { packagingId: pack50.id, costCents: 1100 },
    ]);
    await boss.post(`${S}/movements`, { variantId: p.variantId, kind: 'adjustment', qty: '100', reason: 'Saldo de implantação', requestKey: key() });
    const r = await boss.post(`${S}/reservations`, { variantId: p.variantId, qty: '95', sourceId: 'atacado-1' });
    await boss.post(`${S}/reservations/${r.json().reservation.id}/consume`);

    const res = await boss.get('/api/v1/admin/stock-reports/replenishment?days=90&coverDays=30&maxCoverDays=90');
    expect(res.statusCode, res.body).toBe(200);
    const item = res.json().items.find((i: { variantId: string }) => i.variantId === p.variantId);
    // 95 vendidas em 90 dias ≈ 1,056/dia; (7 de prazo + 30 de cobertura) x 1,056 - 5 disponiveis = 34,06 → 35
    expect(item.need).toBe(35);
    const [cheap, small] = item.options;
    expect(cheap.label).toBe('Pacote do fornecedor com 100');
    // 105 unidades duram ~99 dias: passa da cobertura maxima
    expect(cheap.excess).toBe(true);
    expect(small).toMatchObject({ label: 'Pacote com 50', packs: 1, recommended: true, excess: false });

    const summary = (await boss.get('/api/v1/admin/stock-reports/summary')).json();
    expect(summary.topSold.some((t: { variant_id: string }) => t.variant_id === p.variantId)).toBe(true);
    expect(Number(summary.purchases.receipts)).toBeGreaterThan(0);
  });
});
