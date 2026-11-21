/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { pool, tx } from '../src/db/pool.js';
import { FakeCarrier, setCarrierProvider } from '../src/lib/carriers.js';
import { FakeProvider } from '../src/lib/payments.js';
import { moveStock } from '../src/lib/stock.js';
import { allocateOrder, appRole, loggedAs, makeApp, ORIGIN, owner, packOrder, productPayload, randomIp, resetCatalog, sendPurchase, uid } from './helpers.js';

// SGLog Fase 10b (docs/41-sglog-fase10.md): painel Gestao e relatorios gerenciais. Totais iguais a soma das margens dos
// pedidos; periodo por pagamento, pedido ou despacho; demonstracao separavel; rateio por produto que fecha com o total;
// frete cobrado x pago; perdas de estoque; fornecedores; indicadores; permissoes; CSV igual ao JSON; volume alto.

let app: FastifyInstance;
let boss: Awaited<ReturnType<typeof loggedAs>>; // gerente com MFA: tudo de consulta
let own: Awaited<ReturnType<typeof loggedAs>>; // proprietario com MFA: configuracoes
let carrierId: string;
let principal: string;
const carrier = new FakeCarrier();

const C = '/api/v1/admin/costs';
const M = '/api/v1/admin/management';
const SH = '/api/v1/admin/shipments';
const PO = '/api/v1/admin/purchase-orders';
const key = () => `k-${uid()}-${uid()}`;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
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

type Prod = { variantId: string; pack: string; purchase: string; productId: string };
async function newProduct(cost = '5', price = 1000): Promise<Prod> {
  const res = await boss.post(
    '/api/v1/admin/products',
    productPayload({
      variants: [
        {
          sku: `G10-${uid()}`.toUpperCase(),
          weightG: 4,
          lengthMm: 80,
          widthMm: 80,
          heightMm: 95,
          packagings: [
            { kind: 'sale', label: 'Pacote com 50', unitCode: 'PCT', baseQty: '50', priceCents: price, isDefault: true },
            { kind: 'purchase', label: 'Pacote do fornecedor com 100', unitCode: 'PCT', baseQty: '100' },
          ],
        },
      ],
    }),
  );
  expect(res.statusCode, res.body).toBe(201);
  const p = res.json().product;
  const v = p.variants[0];
  await tx(null, (db) => moveStock(db, null, { variantId: v.id, kind: 'receipt', onHandDelta: '1000', unitCostCents: cost, sourceType: 'manual', reason: 'Entrada do teste', warehouseId: principal }));
  return { variantId: v.id, pack: v.packagings.find((k: any) => k.kind === 'sale').id, purchase: v.packagings.find((k: any) => k.kind === 'purchase').id, productId: p.id };
}

/** Pedido pago, alocado, despachado e entregue. Cada produto: 2 pacotes de 50 (100 un). */
async function shippedOrder(products: Prod[], opts: { email?: string; ship?: boolean } = {}) {
  const s = shopper();
  for (const p of products) await s.post('/api/v1/public/cart/items', { packagingId: p.pack, packs: 2 });
  const cart = (await s.get('/api/v1/public/cart')).json().cart;
  const freight = (await s.get('/api/v1/public/shipping/quote?cep=01310100')).json().options.find((o: any) => o.id === carrierId).priceCents;
  const placed = await s.post('/api/v1/public/checkout', { requestKey: `g10-${uid()}`, buyer: { ...buyer, email: opts.email ?? buyer.email }, shippingOptionId: carrierId, address, paymentMethod: 'pix', expectedTotalCents: cart.subtotalCents + freight });
  expect(placed.statusCode, placed.body).toBe(201);
  const o = placed.json().order as { id: string; token: string };
  expect((await s.post(`/api/v1/public/orders/${o.token}/pay/pix`)).statusCode).toBe(200);
  expect((await s.post(`/api/v1/public/dev-payments/${o.token}/approve-pix`)).statusCode).toBe(200);
  if (opts.ship === false) return { orderId: o.id, shipment: null as string | null };
  await allocateOrder(boss, o.id);
  await owner.query(`UPDATE orders SET invoice_status = 'not_required' WHERE id = $1`, [o.id]);
  const packed = await packOrder(boss, o.id);
  const d = await boss.post(`${SH}/${packed.id}/dispatch`, { version: packed.version, requestKey: key(), carrier: 'Transportadora X', trackingCode: `TR${uid()}` });
  expect(d.statusCode, d.body).toBe(200);
  const r = await boss.post(`${SH}/${packed.id}/deliver`, { version: d.json().shipment.version, requestKey: key() });
  expect(r.statusCode, r.body).toBe(200);
  return { orderId: o.id, shipment: packed.id as string };
}

async function get(url: string, c = boss) {
  const r = await c.get(url);
  expect(r.statusCode, `${url} ${r.body}`).toBe(200);
  return r.json();
}
const q = (o: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined) as [string, string][]).toString();
const T = () => ({ from: today(), to: today() });
async function allOrders(params: Record<string, string | number | undefined>) {
  const out: any[] = [];
  for (let page = 1; ; page++) {
    const r = await get(`${M}/orders?${q({ ...params, page, pageSize: 100 })}`);
    out.push(...r.items);
    if (page * 100 >= r.total) return out;
  }
}
async function setting(b: Record<string, unknown>) {
  const r = await own.post(`${C}/settings`, { validFrom: '2020-01-01', source: 'Tabela do teste', requestKey: key(), ...b });
  expect(r.statusCode, r.body).toBe(201);
  const s = r.json().setting;
  const v = await own.post(`${C}/settings/${s.id}/validate`, { version: s.version, validatorName: 'Contador do teste' });
  expect(v.statusCode, v.body).toBe(200);
}
/** CSV do painel: separador ;, decimal com virgula, BOM. */
function parseCsv(body: string) {
  const [head, ...rows] = body.replace(/^﻿/, '').trim().split('\r\n').map((l) => l.split(';'));
  return { head: head!, rows: rows.map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i] ?? '']))) };
}
const cents = (v: string) => Math.round(Number(v.replace(',', '.')) * 100);

let a: Prod;
let b: Prod;
let o1: { orderId: string; shipment: string | null };
let o2: { orderId: string; shipment: string | null };
let o3: { orderId: string; shipment: string | null };
let viewer: Awaited<ReturnType<typeof loggedAs>>; // logistica + management.view (sem margem nem custo)

beforeAll(async () => {
  app = await makeApp(undefined, new FakeProvider(), null, undefined, { carrier });
  setCarrierProvider(carrier);
  await resetCatalog();
  boss = await loggedAs(app, 'manager', { mfa: true });
  own = await loggedAs(app, 'owner', { mfa: true });
  viewer = await loggedAs(app, 'logistics');
  await owner.query(`INSERT INTO user_permissions (user_id, permission, granted) VALUES ($1, 'management.view', true)`, [viewer.user.id]);
  (config as any).SHIP_FROM_CEP = '89460000';
  const c = await boss.post('/api/v1/admin/shipping-options', { name: 'Transportadora econômica', kind: 'carrier', carrierService: '3', handlingDays: 1, baseCents: 0, minDays: 0, maxDays: 0 });
  expect(c.statusCode, c.body).toBe(201);
  carrierId = c.json().option.id;
  principal = (await owner.query('SELECT id FROM warehouses WHERE is_default')).rows[0].id;
  a = await newProduct('5', 1000);
  b = await newProduct('8', 3000);
  o1 = await shippedOrder([a, b]); // dois produtos: R$ 20 + R$ 60 de mercadoria
  o2 = await shippedOrder([a], { email: `demo-${uid()}@demo.invalid` }); // demonstracao
  o3 = await shippedOrder([b]);
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

describe('painel Gestão: resumo', () => {
  it('totais iguais à soma das margens dos pedidos; parcial sem custo; demonstração separável; período anterior', async () => {
    const per = await Promise.all([o1, o2, o3].map(async (o) => (await get(`${C}/orders/${o.orderId}/margin`)).margin));
    const s = await get(`${M}/summary?${q(T())}`);
    expect(s.financial).toBe(true);
    expect(s.period).toMatchObject({ from: today(), to: today(), basis: 'paid', basisLabel: 'data do pagamento' });
    expect(s.totals.orders).toBe(3);
    expect(s.totals.demoOrders).toBe(1);
    expect(s.totals.revenueCents).toBe(per.reduce((x, m) => x + m.revenueCents, 0));
    expect(s.totals.cogsCents).toBe(per.reduce((x, m) => x + m.cogsCents, 0));
    expect(s.totals.marginCents).toBe(per.reduce((x, m) => x + m.marginCents, 0));
    // Sem configuracao nem frete pago: todos parciais, cobertura zero, componentes que faltam listados.
    expect(s.totals).toMatchObject({ completeOrders: 0, partialOrders: 3, coveragePct: 0, completeMarginPct: null, revenueCoveragePct: 0 });
    expect(s.missing.map((m: any) => m.component).sort()).toEqual(['freight_paid', 'packaging', 'payment_fee', 'tax_estimated']);
    expect(s.missing.every((m: any) => m.orders === 3)).toBe(true);
    expect(s.incomplete).toHaveLength(3);
    expect(s.byChannel).toEqual([expect.objectContaining({ channel: 'store', label: 'Loja virtual', orders: 3 })]);
    expect(s.byMonth).toEqual([expect.objectContaining({ month: today().slice(0, 7), orders: 3 })]);
    expect(s.previous.totals.orders).toBe(0);
    expect(s.notes.join(' ')).toMatch(/Não é lucro líquido/);
    // Demonstracao: excluir e so ela.
    const ex = await get(`${M}/summary?${q({ ...T(), demo: 'exclude' })}`);
    const only = await get(`${M}/summary?${q({ ...T(), demo: 'only' })}`);
    expect([ex.totals.orders, ex.totals.demoOrders, only.totals.orders, only.totals.demoOrders]).toEqual([2, 0, 1, 1]);
    expect(ex.totals.marginCents + only.totals.marginCents).toBe(s.totals.marginCents);
    // Canal e UF filtram.
    expect((await get(`${M}/summary?${q({ ...T(), channel: 'shopee' })}`)).totals.orders).toBe(0);
    expect((await get(`${M}/summary?${q({ ...T(), uf: 'sp' })}`)).totals.orders).toBe(3);
    // Periodo invalido.
    expect((await boss.get(`${M}/summary?${q({ from: '2026-01-01', to: '2027-03-01' })}`)).json().error.code).toBe('INVALID_PERIOD');
    expect((await boss.get(`${M}/summary?${q({ from: '2026-02-01', to: '2026-01-01' })}`)).json().error.code).toBe('INVALID_PERIOD');
  });

  it('permissões: management.view entra; sem margins.view nada financeiro; atendente e comprador fora', async () => {
    const s = await get(`${M}/summary?${q(T())}`, viewer);
    expect(s.financial).toBe(false);
    expect(s.totals).toEqual({ orders: 3, completeOrders: 0, partialOrders: 3, demoOrders: 1, coveragePct: 0 });
    expect(s.byChannel[0].revenueCents).toBeUndefined();
    expect(s.incomplete[0].revenueCents).toBeUndefined();
    for (const u of ['orders', 'breakdown?dim=product', 'logistics']) expect((await viewer.get(`${M}/${u}`)).statusCode, u).toBe(403);
    // Indicadores operacionais sim, valor do estoque nao (exige costs.view).
    const ind = await get(`${M}/indicators?${q(T())}`, viewer);
    expect(ind.stock).toBeUndefined();
    expect((await get(`${M}/indicators?${q(T())}`)).stock).toBeDefined();
    for (const role of ['sales', 'buyer', 'stock', 'shipping']) {
      const u = await loggedAs(app, role);
      expect((await u.get(`${M}/summary`)).statusCode, role).toBe(403);
      expect((await u.get(`${C}/orders/${o1.orderId}/margin`)).statusCode, role).toBe(403);
    }
    // Financeiro consulta (sem MFA: consulta nao exige).
    expect((await (await loggedAs(app, 'finance')).get(`${M}/summary`)).statusCode).toBe(200);
  });
});

describe('períodos', () => {
  it('pagamento, pedido e despacho mudam o recorte; cada relatório diz a base', async () => {
    const x = await shippedOrder([a]);
    await owner.query(`UPDATE orders SET created_at = '2026-01-10 12:00-03', paid_at = '2026-01-12 12:00-03' WHERE id = $1`, [x.orderId]);
    await owner.query(`UPDATE shipments SET shipped_at = '2026-02-01 12:00-03', delivered_at = '2026-02-03 12:00-03' WHERE order_id = $1`, [x.orderId]);
    const has = async (p: Record<string, string>) => (await allOrders(p)).some((r) => r.id === x.orderId);
    expect(await has({ from: '2026-01-11', to: '2026-01-31', basis: 'paid' })).toBe(true);
    expect(await has({ from: '2026-01-11', to: '2026-01-31', basis: 'order' })).toBe(false);
    expect(await has({ from: '2026-01-01', to: '2026-01-31', basis: 'order' })).toBe(true);
    expect(await has({ from: '2026-01-01', to: '2026-01-31', basis: 'dispatch' })).toBe(false);
    expect(await has({ from: '2026-02-01', to: '2026-02-28', basis: 'dispatch' })).toBe(true);
    const r = await get(`${M}/orders?${q({ from: '2026-02-01', to: '2026-02-28', basis: 'dispatch' })}`);
    expect(r.items.find((i: any) => i.id === x.orderId).date).toBe('2026-02-01');
    expect(r.period.basisLabel).toBe('data do primeiro despacho');
    // Fora do periodo de hoje e no "periodo anterior" de fevereiro (janeiro) pela base pagamento.
    const feb = await get(`${M}/summary?${q({ from: '2026-02-01', to: '2026-02-28' })}`);
    expect(feb.previous.period).toEqual({ from: '2026-01-04', to: '2026-01-31', days: 28 });
    expect(feb.previous.totals.orders).toBe(1);
    // Indicadores: pagamento ate o despacho (20 dias) e despacho ate a entrega (2 dias).
    const ind = await get(`${M}/indicators?${q({ from: '2026-01-01', to: '2026-01-31' })}`);
    expect(ind.period.orders).toBe(1);
    expect(ind.dispatch.avgHours).toBe(480);
    expect(ind.delivery.avgDays).toBe(2);
  });
});

describe('rentabilidade', () => {
  it('lista paginada, completo × parcial, ordenação e CSV igual ao JSON', async () => {
    await setting({ kind: 'packaging', fixedCents: 120 });
    await setting({ kind: 'payment_fee', paymentMethod: 'pix', ratePct: '1.5' });
    await setting({ kind: 'tax_rate', ratePct: '3', base: 'order_total' });
    expect((await boss.post(`/api/v1/admin/freight/shipments/${o1.shipment}/costs`, { kind: 'manual', amountCents: 1500, requestKey: key() })).statusCode).toBeLessThan(300);
    const all = await allOrders(T());
    expect(all).toHaveLength(3);
    expect(all.find((r) => r.id === o1.orderId).status).toBe('complete');
    const complete = await get(`${M}/orders?${q({ ...T(), status: 'complete' })}`);
    expect(complete.items.map((i: any) => i.id)).toEqual([o1.orderId]);
    expect(complete.total).toBe(1);
    const partial = await get(`${M}/orders?${q({ ...T(), status: 'partial', pageSize: 1, page: 2, sort: 'number', dir: 'asc' })}`);
    expect(partial.total).toBe(2);
    expect(partial.items).toHaveLength(1);
    expect(partial.items[0].missing).toEqual(['Frete pago']);
    const byMargin = await get(`${M}/orders?${q({ ...T(), sort: 'margin', dir: 'desc' })}`);
    const margins = byMargin.items.map((i: any) => i.marginCents);
    expect(margins).toEqual([...margins].sort((x: number, y: number) => y - x));
    // Resumo: cobertura 1/3 e margem so dos completos.
    const s = await get(`${M}/summary?${q(T())}`);
    const c1 = all.find((r) => r.id === o1.orderId);
    expect(s.totals.completeOrders).toBe(1);
    expect(s.totals.coveragePct).toBe(33.3);
    expect(s.totals.completeMarginPct).toBe(Math.round((c1.marginCents / c1.revenueCents) * 1000) / 10);
    expect(s.totals.taxesEstimatedCents).toBe(all.reduce((x, r) => x + r.taxesEstimatedCents, 0));
    // CSV.
    const csv = await boss.get(`${M}/orders?${q({ ...T(), format: 'csv' })}`);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/margem-pedidos-/);
    const t = parseCsv(csv.body);
    expect(t.rows).toHaveLength(3);
    expect(t.rows.reduce((x, r) => x + cents(r.margem_contribuicao!), 0)).toBe(s.totals.marginCents);
    expect(t.rows.find((r) => r.situacao === 'completo')!.pedido).toBe(String(c1.number));
    expect(t.rows.filter((r) => r.demonstracao === 'sim')).toHaveLength(1);
  });

  it('por produto, categoria, fornecedor, canal e UF fecha com o total; CMV vai direto ao item', async () => {
    const s = await get(`${M}/summary?${q(T())}`);
    for (const dim of ['channel', 'uf', 'product', 'category', 'supplier']) {
      const r = await get(`${M}/breakdown?${q({ ...T(), dim, pageSize: 100 })}`);
      const sum = (k: string) => r.items.reduce((x: number, i: any) => x + i[k], 0);
      // Rateio arredondado por grupo: diferenca de no maximo 1 centavo por grupo.
      expect(Math.abs(sum('marginCents') - s.totals.marginCents), dim).toBeLessThanOrEqual(r.items.length);
      expect(Math.abs(sum('revenueCents') - s.totals.revenueCents), dim).toBeLessThanOrEqual(r.items.length);
      expect(Math.abs(sum('cogsCents') - s.totals.cogsCents), dim).toBeLessThanOrEqual(r.items.length);
    }
    const prod = await get(`${M}/breakdown?${q({ ...T(), dim: 'product' })}`);
    const pa = prod.items.find((i: any) => i.key === a.productId);
    const pb = prod.items.find((i: any) => i.key === b.productId);
    // A: 2 pedidos (o1, o2), 200 un a R$ 0,05 = R$ 10,00 de CMV; B: 2 pedidos (o1, o3), 200 un a R$ 0,08.
    expect([pa.orders, Number(pa.qty), pa.cogsCents, pb.orders, Number(pb.qty), pb.cogsCents]).toEqual([2, 200, -1000, 2, 200, -1600]);
    // Receita = mercadoria do item + parte do frete cobrado (o1: 1/4 para A, 3/4 para B pela mercadoria R$ 20 x R$ 60).
    const fr = Object.fromEntries((await owner.query<{ id: string; f: number }>('SELECT id, freight_cents::int AS f FROM orders WHERE id = ANY($1)', [[o1.orderId, o2.orderId, o3.orderId]])).rows.map((r) => [r.id, r.f]));
    expect(pa.revenueCents).toBe(Math.round(4000 + fr[o1.orderId]! / 4 + fr[o2.orderId]!));
    expect(pb.revenueCents).toBe(Math.round(12000 + (fr[o1.orderId]! * 3) / 4 + fr[o3.orderId]!));
    // Frete pago do o1 (R$ 15) rateado 1:3 pela receita de mercadoria (R$ 20 x R$ 60).
    const o1lines = (await get(`${C}/orders/${o1.orderId}/margin`)).margin;
    expect(o1lines.logisticsCents).toBe(-1500 - 120);
    const sup = await get(`${M}/breakdown?${q({ ...T(), dim: 'supplier' })}`);
    expect(sup.items).toEqual([expect.objectContaining({ label: 'Sem fornecedor identificado', attribution: 'none', orders: 3 })]);
    expect(sup.notes.join(' ')).toMatch(/fornecedor principal/);
    const csv = parseCsv((await boss.get(`${M}/breakdown?${q({ ...T(), dim: 'product', format: 'csv' })}`)).body);
    expect(csv.rows.reduce((x, r) => x + cents(r.margem_contribuicao!), 0)).toBe(prod.items.reduce((x: number, i: any) => x + i.marginCents, 0));
    expect((await boss.get(`${M}/breakdown?dim=sku`)).statusCode).toBe(400);
  });
});

describe('custos logísticos e indicadores', () => {
  it('frete cobrado × pago por UF só com o pago informado; transportadora; perdas sem as de devolução', async () => {
    const freights = (await owner.query<{ id: string; f: number }>('SELECT id, freight_cents::int AS f FROM orders WHERE id = ANY($1)', [[o1.orderId, o2.orderId, o3.orderId]])).rows;
    const f1 = freights.find((r) => r.id === o1.orderId)!.f;
    await tx(null, async (db) => {
      await moveStock(db, null, { variantId: a.variantId, kind: 'loss', onHandDelta: '-10', sourceType: 'manual', reason: 'Perda do teste', warehouseId: principal });
      await moveStock(db, null, { variantId: a.variantId, kind: 'damage', onHandDelta: '-4', sourceType: 'customer_return', sourceId: 'x', reason: 'Avaria da devolução', warehouseId: principal });
    });
    const r = await get(`${M}/logistics?${q(T())}`);
    const sp = r.byUf.find((u: any) => u.uf === 'SP');
    expect(sp).toMatchObject({ orders: 3, freightChargedCents: freights.reduce((x, f) => x + f.f, 0), freightPaidCents: 1500, ordersFreightKnown: 1, ordersFreightUnknown: 2, balanceKnownCents: f1 - 1500 });
    expect(r.byCarrier).toEqual([expect.objectContaining({ carrier: 'Transportadora X', shipments: 3, withCost: 1, freightPaidCents: 1500 })]);
    const comp = (c: string, n: string) => r.components.find((x: any) => x.component === c && x.nature === n);
    expect(comp('freight_paid', 'effective').cents).toBe(-1500);
    expect(comp('freight_paid', 'unknown')).toMatchObject({ cents: null, orders: 2 });
    expect(comp('packaging', 'estimated').cents).toBe(-360);
    // Perda de 10 un a R$ 0,05; a avaria vinda de devolucao fica fora.
    expect(r.stockLosses.items).toEqual([expect.objectContaining({ kind: 'loss', movements: 1, cents: 50, unknownMovements: 0 })]);
    expect(r.stockLosses.basis).toBe('data do movimento');
    const csv = parseCsv((await boss.get(`${M}/logistics?${q({ ...T(), format: 'csv' })}`)).body);
    expect(csv.rows.some((x) => x.secao === 'perda de estoque (data do movimento)' && cents(x.valor!) === 50)).toBe(true);
    // Indicadores do dia.
    const ind = await get(`${M}/indicators?${q(T())}`);
    expect(ind.period).toMatchObject({ orders: 3, dispatched: 3, delivered: 3 });
    expect(ind.rates).toMatchObject({ occurrencePct: 0, returnPct: 0, refundPct: 0 });
    expect(ind.stock.valueCents).toBeGreaterThan(0);
    // Baixas de venda de hoje (data do movimento): o1, o2, o3 e o pedido do teste de periodos (pago em janeiro).
    expect(ind.stock.cogsPeriodCents).toBe(1000 + 1600 + 500);
  });

  it('fornecedores: prazo, diferença de nota, variação de custo e demonstração', async () => {
    const p = await newProduct();
    const s = await boss.post('/api/v1/admin/suppliers', { name: `Distribuidora ${uid()}`, leadTimeDays: 5 });
    expect(s.statusCode, s.body).toBe(201);
    const sup = s.json().supplier.id as string;
    expect((await boss.post(`/api/v1/admin/suppliers/${sup}/offers/item`, { packagingId: p.purchase, costCents: 2000 })).statusCode).toBe(201);
    const po = async (packCostCents: number) => {
      const r = await boss.post(PO, { supplierId: sup, items: [{ packagingId: p.purchase, packs: '1', packCostCents }] });
      expect(r.statusCode, r.body).toBe(201);
      const sent = await sendPurchase(app, boss, r.json().order.id);
      expect(sent.statusCode, sent.body).toBe(200);
      return sent.json().order;
    };
    const first = await po(2000);
    await owner.query(`UPDATE purchase_orders SET expected_at = current_date + 5 WHERE id = $1`, [first.id]);
    const r1 = await boss.post(`${PO}/${first.id}/receipts`, { requestKey: key(), items: [{ itemId: first.items[0].id, packs: '1', invoicedPackCostCents: 2100, priceJustification: 'Reajuste do fornecedor' }] });
    expect(r1.statusCode, r1.body).toBe(201);
    const second = await po(2400);
    await owner.query(`UPDATE purchase_orders SET expected_at = current_date - 3 WHERE id = $1`, [second.id]);
    const r2 = await boss.post(`${PO}/${second.id}/receipts`, { requestKey: key(), items: [{ itemId: second.items[0].id, packs: '1' }] });
    expect(r2.statusCode, r2.body).toBe(201);
    const costs = (await owner.query<{ u: string }>(`SELECT ri.unit_cost_cents::text AS u FROM purchase_receipt_items ri JOIN purchase_receipts pr ON pr.id = ri.receipt_id WHERE pr.order_id = ANY($1) ORDER BY pr.received_at`, [[first.id, second.id]])).rows.map((x) => Number(x.u));
    const r = await get(`${M}/suppliers?${q(T())}`);
    const row = r.items.find((i: any) => i.id === sup);
    expect(row).toMatchObject({ receipts: 2, onTime: 1, late: 1, withoutPromise: 0, onTimePct: 50, issues: 1, invoiceDiffCents: 100, orderedCents: 4400, supplierReturns: 0, demo: false });
    expect(row.costChangePct).toBe(Math.round(((costs[1]! - costs[0]!) / costs[0]!) * 1000) / 10);
    expect(r.period.basisLabel).toBe('data do recebimento');
    await owner.query(`UPDATE suppliers SET name = name || ' (demonstração)' WHERE id = $1`, [sup]);
    expect((await get(`${M}/suppliers?${q({ ...T(), demo: 'exclude' })}`)).items.some((i: any) => i.id === sup)).toBe(false);
    expect((await get(`${M}/suppliers?${q({ ...T(), demo: 'only' })}`)).items.map((i: any) => i.id)).toEqual([sup]);
    const csv = parseCsv((await boss.get(`${M}/suppliers?${q({ ...T(), format: 'csv' })}`)).body);
    expect(csv.rows.find((x) => x.fornecedor!.includes('(demonstração)'))!.demonstracao).toBe('sim');
    // Comprador ve fornecedores (purchases.view), mas so com management.view.
    expect((await (await loggedAs(app, 'buyer')).get(`${M}/suppliers`)).statusCode).toBe(403);
  });
});

describe('volume alto', () => {
  it('10 mil pedidos: resumo, lista paginada e rateio por produto rápidos, sem carregar pedidos na memória', async () => {
    const tLoad = Date.now();
    const v = (await owner.query('SELECT v.id, k.id AS pack FROM product_variants v JOIN packagings k ON k.variant_id = v.id AND k.kind = $2 WHERE v.id = $1', [a.variantId, 'sale'])).rows[0];
    await owner.query(
      `WITH o AS (
         INSERT INTO orders (public_token_hash, request_key, buyer, shipping_snapshot, payment_method, subtotal_cents, total_cents, payment_due_at, status, paid_at, created_at, ship_to, channel, freight_cents)
         SELECT md5('perf' || g), 'perf-request-' || lpad(g::text, 8, '0'),
                jsonb_build_object('email', CASE WHEN g % 2 = 0 THEN 'p' || g || '@demo.invalid' ELSE 'p' || g || '@teste.local' END, 'name', 'Cliente'),
                '{}'::jsonb, 'pix', 1000, 1000, now(), 'delivered', ts, ts, '{"uf": "SC"}', CASE WHEN g % 3 = 0 THEN 'sales_desk' ELSE 'store' END, 0
         FROM generate_series(1, 10000) g, LATERAL (SELECT '2025-03-01 12:00-03'::timestamptz + (g % 28) * interval '1 day' AS ts) t
         RETURNING id)
       INSERT INTO order_items (order_id, variant_id, packaging_id, sku, product_name, packaging_label, base_qty_per_pack, packs, list_price_cents, unit_price_cents, total_cents)
       SELECT o.id, $1, $2, 'PERF', 'Produto', 'Pacote com 50', 50, 1, 1000, 1000, 1000 FROM o`,
      [v.id, v.pack],
    );
    const P = { from: '2025-03-01', to: '2025-03-31' };
    console.log(`volume 10k: carga ${Date.now() - tLoad} ms`);
    let t0 = Date.now();
    const s = await get(`${M}/summary?${q(P)}`);
    const tSummary = Date.now() - t0;
    console.log(`volume 10k: resumo ${tSummary} ms`);
    expect(s.totals.orders).toBe(10000);
    expect(s.totals.demoOrders).toBe(5000);
    expect(s.totals.revenueCents).toBe(10000 * 1000);
    // Sem baixa no estoque: CMV estimado pelo custo medio atual.
    expect(s.missing.find((m: any) => m.component === 'freight_paid').orders).toBe(10000);
    expect(s.byChannel.map((c: any) => c.orders).sort()).toEqual([3333, 6667]);
    t0 = Date.now();
    const page = await get(`${M}/orders?${q({ ...P, page: 50, pageSize: 100, sort: 'margin' })}`);
    const tPage = Date.now() - t0;
    console.log(`volume 10k: pagina ${tPage} ms`);
    expect(page.items).toHaveLength(100);
    expect(page.total).toBe(10000);
    t0 = Date.now();
    const prod = await get(`${M}/breakdown?${q({ ...P, dim: 'product' })}`);
    const tProd = Date.now() - t0;
    expect(prod.items[0].orders).toBe(10000);
    expect(prod.items[0].revenueCents).toBe(10000 * 1000);
    t0 = Date.now();
    await get(`${M}/logistics?${q(P)}`);
    await get(`${M}/indicators?${q(P)}`);
    const tRest = Date.now() - t0;
    console.log(`volume 10k: resumo ${tSummary} ms, pagina ${tPage} ms, produto ${tProd} ms, logistica+indicadores ${tRest} ms`);
    expect(tSummary).toBeLessThan(8000);
    expect(tPage).toBeLessThan(8000);
    expect(tProd).toBeLessThan(8000);
    // CSV limitado e conferencia C24 continua limpa.
    const csv = await boss.get(`${M}/orders?${q({ ...P, format: 'csv' })}`);
    expect(parseCsv(csv.body).rows).toHaveLength(10000);
    const rec = await get(`${C}/reconcile`);
    expect(rec.divergences).toEqual([]);
  }, 120_000);
});
