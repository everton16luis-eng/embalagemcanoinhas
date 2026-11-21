/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { pool, tx } from '../src/db/pool.js';
import { FakeCarrier, setCarrierProvider } from '../src/lib/carriers.js';
import { FakeProvider } from '../src/lib/payments.js';
import { moveStock } from '../src/lib/stock.js';
import { allocateOrder, appRole, loggedAs, makeApp, ORIGIN, owner, packOrder, productPayload, randomIp, resetCatalog, uid } from './helpers.js';

// SGLog Fase 10a (docs/41-sglog-fase10.md): configuracoes de custo versionadas (informado -> validado), lancamentos de
// custos externos (manual e planilha, sem duplicar, estorno), margem de contribuicao por pedido com natureza e origem
// de cada componente (efetivo, estimado, desconhecido), CMV historico, devolucoes e reembolsos sem dupla contagem,
// embalagem por tipo e por volume, permissoes e conferencia C22-C24.

let app: FastifyInstance;
let boss: Awaited<ReturnType<typeof loggedAs>>; // gerente com MFA: pedidos, expedicao, devolucoes
let own: Awaited<ReturnType<typeof loggedAs>>; // proprietario com MFA: configuracoes e validacao do tributo
let fin: Awaited<ReturnType<typeof loggedAs>>; // financeiro com MFA: lancamentos
let carrierId: string;
let principal: string;
const carrier = new FakeCarrier();

const C = '/api/v1/admin/costs';
const R = '/api/v1/admin/returns';
const RF = '/api/v1/admin/refunds';
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

/** Produto com entrada de estoque. `cost` em centavos por unidade (null: entra sem custo, como um ajuste). */
async function newProduct(cost: string | null = '5', stock = '1000') {
  const res = await boss.post('/api/v1/admin/products', productPayload({ variants: [{ sku: `F10-${uid()}`.toUpperCase(), weightG: 4, lengthMm: 80, widthMm: 80, heightMm: 95, packagings: [{ kind: 'sale', label: 'Pacote com 50', unitCode: 'PCT', baseQty: '50', priceCents: 1000, isDefault: true }] }] }));
  expect(res.statusCode, res.body).toBe(201);
  const v = res.json().product.variants[0];
  await stockIn(v.id, stock, cost);
  return { variantId: v.id as string, pack: v.packagings[0].id as string };
}
async function stockIn(variantId: string, qty: string, cost: string | null) {
  await tx(null, (db) => moveStock(db, null, { variantId, kind: cost === null ? 'adjustment' : 'receipt', onHandDelta: qty, unitCostCents: cost, sourceType: 'manual', reason: 'Entrada do teste', warehouseId: principal }));
}

/** Pedido pago, alocado e despachado (2 pacotes de 50 = 100 un, R$ 20,00 de mercadoria). */
async function shippedOrder(opts: { deliver?: boolean; product?: { variantId: string; pack: string }; packages?: { weightG: number; lengthMm?: number; widthMm?: number; heightMm?: number }[]; ship?: boolean; email?: string } = {}) {
  const p = opts.product ?? (await newProduct());
  const s = shopper();
  await s.post('/api/v1/public/cart/items', { packagingId: p.pack, packs: 2 });
  const cart = (await s.get('/api/v1/public/cart')).json().cart;
  const freight = (await s.get('/api/v1/public/shipping/quote?cep=01310100')).json().options.find((o: any) => o.id === carrierId).priceCents;
  const placed = await s.post('/api/v1/public/checkout', { requestKey: `f10-${uid()}`, buyer: { ...buyer, email: opts.email ?? buyer.email }, shippingOptionId: carrierId, address, paymentMethod: 'pix', expectedTotalCents: cart.subtotalCents + freight });
  expect(placed.statusCode, placed.body).toBe(201);
  const o = placed.json().order as { id: string; token: string };
  expect((await s.post(`/api/v1/public/orders/${o.token}/pay/pix`)).statusCode).toBe(200);
  expect((await s.post(`/api/v1/public/dev-payments/${o.token}/approve-pix`)).statusCode).toBe(200);
  const item = (await owner.query<{ id: string }>('SELECT id FROM order_items WHERE order_id = $1', [o.id])).rows[0]!.id;
  if (opts.ship === false) return { orderId: o.id, shipment: null as string | null, variantId: p.variantId, item, product: p };
  await allocateOrder(boss, o.id);
  await owner.query(`UPDATE orders SET invoice_status = 'not_required' WHERE id = $1`, [o.id]);
  const packed = await packOrder(boss, o.id, opts.packages);
  const d = await boss.post(`${SH}/${packed.id}/dispatch`, { version: packed.version, requestKey: key(), carrier: 'Transportadora X', trackingCode: `TR${uid()}` });
  expect(d.statusCode, d.body).toBe(200);
  if (opts.deliver !== false) {
    const r = await boss.post(`${SH}/${packed.id}/deliver`, { version: d.json().shipment.version, requestKey: key() });
    expect(r.statusCode, r.body).toBe(200);
  }
  return { orderId: o.id, shipment: packed.id as string, variantId: p.variantId, item, product: p };
}

const orderRow = async (id: string) => (await owner.query('SELECT total_cents::int AS total, freight_cents::int AS freight, subtotal_cents::int AS subtotal FROM orders WHERE id = $1', [id])).rows[0];
async function margin(orderId: string, c = boss) {
  const r = await c.get(`${C}/orders/${orderId}/margin`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
const line = (m: any, comp: string) => m.margin.lines.filter((l: any) => l.component === comp);
const sumOf = (m: any, comp: string) => line(m, comp).reduce((s: number, l: any) => s + (l.amountCents ?? 0), 0);

async function inform(b: Record<string, unknown>, c = own) {
  const r = await c.post(`${C}/settings`, { validFrom: '2020-01-01', source: 'Tabela do teste', requestKey: key(), ...b });
  return r;
}
async function setting(b: Record<string, unknown>, validator = own) {
  const r = await inform(b);
  expect(r.statusCode, r.body).toBe(201);
  const s = r.json().setting;
  const v = await validator.post(`${C}/settings/${s.id}/validate`, { version: s.version, validatorName: 'Contador do teste' });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().setting;
}
async function entry(orderId: string, b: Record<string, unknown>, c = fin) {
  return c.post(`${C}/entries`, { orderId, occurredOn: '2026-11-20', requestKey: key(), ...b });
}
const freightPaid = (shipment: string, amountCents: number) => boss.post(`/api/v1/admin/freight/shipments/${shipment}/costs`, { kind: 'manual', amountCents, requestKey: key() });
const reconcileCosts = async () => (await owner.query('SELECT check_code, field FROM cost_reconcile()')).rows;
const stockReconcile = async () => (await owner.query(`SELECT check_code FROM stock_reconcile() WHERE check_code <> 'run'`)).rows;

beforeAll(async () => {
  app = await makeApp(undefined, new FakeProvider(), null, undefined, { carrier });
  setCarrierProvider(carrier);
  await resetCatalog();
  boss = await loggedAs(app, 'manager', { mfa: true });
  own = await loggedAs(app, 'owner', { mfa: true });
  fin = await loggedAs(app, 'finance', { mfa: true });
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

describe('migração 0029 e permissões', () => {
  it('tabelas novas vazias, conferência C22-C23 limpa e nada das fases anteriores mudou', async () => {
    expect(await reconcileCosts()).toEqual([]);
    for (const t of ['cost_settings', 'cost_setting_events', 'order_cost_entries', 'cost_imports']) {
      expect((await owner.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
    }
    // O papel da aplicacao nao apaga nem altera lancamento.
    const priv = (await owner.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'loja_app' AND table_name = 'order_cost_entries' ORDER BY 1`)).rows.map((r) => r.privilege_type);
    expect(priv).toEqual(['INSERT', 'SELECT']);
  });

  it('menor privilégio: logística e comprador sem margem; financeiro lança só com MFA; gerente não altera configuração; tributo só com fiscal.validate', async () => {
    const o = await shippedOrder({ ship: false });
    for (const role of ['logistics', 'buyer', 'sales', 'stock', 'shipping']) {
      const c = await loggedAs(app, role, { mfa: true });
      expect((await c.get(`${C}/orders/${o.orderId}/margin`)).statusCode, role).toBe(403);
      expect((await entry(o.orderId, { kind: 'payment_fee', amountCents: 10 }, c)).statusCode, role).toBe(403);
    }
    // Quem ve pedidos nao ve margem por isso.
    const fiscal = await loggedAs(app, 'fiscal', { mfa: true });
    expect((await fiscal.get(`${C}/orders/${o.orderId}/margin`)).statusCode).toBe(403);
    const finNoMfa = await loggedAs(app, 'finance');
    const r = await entry(o.orderId, { kind: 'payment_fee', amountCents: 10 }, finNoMfa);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('MFA_REQUIRED');
    expect((await finNoMfa.get(`${C}/orders/${o.orderId}/margin`)).statusCode).toBe(200);
    expect((await inform({ kind: 'payment_fee', paymentMethod: 'pix', ratePct: '1' }, boss)).statusCode).toBe(403);
    expect((await inform({ kind: 'payment_fee', paymentMethod: 'pix', ratePct: '1' }, fin)).statusCode).toBe(403);
    // Gerente com costs.settings concedido informa, mas nao valida tributo (so o contador, fiscal.validate).
    const mgr2 = await loggedAs(app, 'manager', { mfa: true });
    await owner.query(`INSERT INTO user_permissions (user_id, permission, granted) VALUES ($1, 'costs.settings', true)`, [mgr2.user.id]);
    const t = await inform({ kind: 'tax_rate', channel: 'sales_desk', ratePct: '4' }, mgr2);
    expect(t.statusCode, t.body).toBe(201);
    const s = t.json().setting;
    const val = await mgr2.post(`${C}/settings/${s.id}/validate`, { version: s.version, validatorName: 'Gerente' });
    expect(val.statusCode).toBe(403);
    expect((await own.post(`${C}/settings/${s.id}/cancel`, { version: s.version, reason: 'Teste de permissão' })).statusCode).toBe(200);
    // Auditoria da alteracao financeira.
    expect((await owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'costs.setting_informed' AND entity_id = $1`, [s.id])).rows[0].n).toBe(1);
  });
});

describe('margem de contribuição por pedido', () => {
  it('parcial: sem regra nem lançamento, os custos ficam desconhecidos, fora do total e listados', async () => {
    const o = await shippedOrder();
    const m = await margin(o.orderId);
    const row = await orderRow(o.orderId);
    expect(m.margin.status).toBe('partial');
    expect(m.margin.missing.sort()).toEqual(['freight_paid', 'packaging', 'payment_fee', 'tax_estimated']);
    // Desconhecido nao vira zero: amount nulo e fora da margem.
    for (const comp of ['freight_paid', 'packaging', 'payment_fee', 'tax_estimated']) {
      expect(line(m, comp).every((l: any) => l.nature === 'unknown' && l.amountCents === null), comp).toBe(true);
    }
    expect(m.margin.revenueCents).toBe(row.total);
    expect(m.margin.cogsCents).toBe(-500);
    expect(m.margin.marginCents).toBe(row.total - 500);
    // CMV rastreavel ate o movimento de venda.
    const cogs = line(m, 'cogs')[0];
    expect(cogs).toMatchObject({ nature: 'effective', amountCents: -500, source: { table: 'stock_movements' } });
    const mv = (await owner.query('SELECT kind, source_id FROM stock_movements WHERE id = $1', [cogs.source.ids[0]])).rows[0];
    expect(mv).toEqual({ kind: 'sale', source_id: o.orderId });
  });

  it('completa: CMV, frete pago, embalagem, taxa e tributo conhecidos; frete cobrado diferente do pago', async () => {
    await setting({ kind: 'packaging', fixedCents: 120 });
    await setting({ kind: 'payment_fee', paymentMethod: 'pix', ratePct: '1.5' });
    await setting({ kind: 'tax_rate', ratePct: '3' });
    const o = await shippedOrder();
    expect((await freightPaid(o.shipment!, 1500)).statusCode).toBe(200);
    const m = await margin(o.orderId);
    const row = await orderRow(o.orderId);
    const fee = Math.round((row.total * 1.5) / 100);
    const tax = Math.round((row.total * 3) / 100);
    expect(m.margin.status).toBe('complete');
    expect(m.margin.missing).toEqual([]);
    expect(sumOf(m, 'freight_charged')).toBe(row.freight);
    expect(sumOf(m, 'freight_paid')).toBe(-1500);
    expect(line(m, 'freight_paid')[0].nature).toBe('effective');
    expect(line(m, 'packaging')[0]).toMatchObject({ nature: 'estimated', amountCents: -120, source: { table: 'cost_settings' } });
    expect(line(m, 'payment_fee')[0]).toMatchObject({ nature: 'estimated', amountCents: -fee });
    expect(line(m, 'tax_estimated')[0]).toMatchObject({ nature: 'estimated', amountCents: -tax });
    expect(m.margin.marginCents).toBe(row.total - 500 - 1500 - 120 - fee - tax);
    expect(m.margin.estimatedCents).toBe(120 + fee + tax);
    expect(m.margin.taxesEstimatedCents).toBe(-tax);
    // A soma das linhas e a margem.
    const total = m.margin.lines.filter((l: any) => ['effective', 'estimated'].includes(l.nature)).reduce((s: number, l: any) => s + l.amountCents, 0);
    expect(total).toBe(m.margin.marginCents);
    // Taxa lancada (efetiva) substitui a estimativa, sem somar as duas.
    expect((await entry(o.orderId, { kind: 'payment_fee', amountCents: 37, externalRef: `MP-${uid()}` })).statusCode).toBe(201);
    const m2 = await margin(o.orderId);
    expect(line(m2, 'payment_fee')).toHaveLength(1);
    expect(line(m2, 'payment_fee')[0]).toMatchObject({ nature: 'effective', amountCents: -37, source: { table: 'order_cost_entries' } });
    // Tributo registrado aparece separado do estimado e o substitui.
    expect((await entry(o.orderId, { kind: 'tax', amountCents: 80 })).statusCode).toBe(201);
    const m3 = await margin(o.orderId);
    expect(line(m3, 'tax_estimated')).toHaveLength(0);
    expect(line(m3, 'tax_recorded')[0]).toMatchObject({ nature: 'effective', amountCents: -80 });
    expect(m3.margin.taxesEstimatedCents).toBe(0);
    expect(await stockReconcile()).toEqual([]);
  });

  it('CMV histórico: custo da baixa não muda com compras depois; média com saldo sem custo é estimada; média zero é desconhecida', async () => {
    const p = await newProduct('5');
    const a = await shippedOrder({ product: p });
    await stockIn(p.variantId, '1000', '15'); // media: (900 x 5 + 1000 x 15) / 1900 = 10,2632
    const b = await shippedOrder({ product: p });
    expect(sumOf(await margin(a.orderId), 'cogs')).toBe(-500);
    const mb = await margin(b.orderId);
    expect(line(mb, 'cogs')[0]).toMatchObject({ nature: 'effective', amountCents: -1026 });
    // Saldo inicial sem custo e depois compra com custo: a media da baixa foi formada com saldo sem custo.
    const q = await newProduct(null, '500');
    await stockIn(q.variantId, '500', '8');
    const c = await shippedOrder({ product: q });
    const mc = await margin(c.orderId);
    expect(line(mc, 'cogs')[0]).toMatchObject({ nature: 'estimated', amountCents: -400 });
    expect(line(mc, 'cogs')[0].detail).toContain('sem custo');
    // So saldo sem custo: media zero na baixa, CMV desconhecido (nunca zero).
    const z = await newProduct(null, '500');
    const d = await shippedOrder({ product: z });
    const md = await margin(d.orderId);
    expect(line(md, 'cogs')[0]).toMatchObject({ nature: 'unknown', amountCents: null });
    expect(md.margin.missing).toContain('cogs');
    expect(md.margin.cogsCents).toBe(0);
    // Pedido ainda nao despachado: custo medio atual, estimado.
    const e = await shippedOrder({ product: p, ship: false });
    const me = await margin(e.orderId);
    expect(line(me, 'cogs_pending')[0]).toMatchObject({ nature: 'estimated', amountCents: -1026 });
    expect(line(me, 'cogs')).toHaveLength(0);
  });

  it('versões: só a validada vale, pela vigência na data do pagamento; sem sobreposição; imutável', async () => {
    // Informada e nao validada: fica fora (o generico de 3% continua valendo).
    const pending = await inform({ kind: 'tax_rate', channel: 'store', ratePct: '9' });
    expect(pending.statusCode).toBe(201);
    const o1 = await shippedOrder();
    expect(line(await margin(o1.orderId), 'tax_estimated')[0].detail).toContain('3%');
    await own.post(`${C}/settings/${pending.json().setting.id}/cancel`, { version: pending.json().setting.version, reason: 'Valor errado' });
    // Duas versoes do canal: 4% ate 2026-01-01 e 6% depois.
    const v1 = await setting({ kind: 'tax_rate', channel: 'store', ratePct: '4', validFrom: '2020-01-01', validTo: '2026-01-01' });
    const v2 = await setting({ kind: 'tax_rate', channel: 'store', ratePct: '6', validFrom: '2026-01-01' });
    const old = await shippedOrder();
    await owner.query(`UPDATE orders SET paid_at = '2025-06-01 15:00-03' WHERE id = $1`, [old.orderId]);
    const recent = await shippedOrder();
    const t = async (id: string) => line(await margin(id), 'tax_estimated')[0];
    const tot = async (id: string) => (await orderRow(id)).total;
    expect((await t(old.orderId)).amountCents).toBe(-Math.round(((await tot(old.orderId)) * 4) / 100));
    expect((await t(old.orderId)).source.ids).toEqual([v1.id]);
    expect((await t(recent.orderId)).amountCents).toBe(-Math.round(((await tot(recent.orderId)) * 6) / 100));
    expect((await t(recent.orderId)).source.ids).toEqual([v2.id]);
    // Sobreposicao da mesma chave: recusada.
    const dup = await inform({ kind: 'tax_rate', channel: 'store', ratePct: '7', validFrom: '2026-06-01' });
    const ds = dup.json().setting;
    const dv = await own.post(`${C}/settings/${ds.id}/validate`, { version: ds.version, validatorName: 'Contador' });
    expect(dv.statusCode).toBe(409);
    expect(dv.json().error.code).toBe('SETTING_OVERLAP');
    // Encerrar a v2 e validar a nova a partir do fim.
    const v2now = (await own.get(`${C}/settings/${v2.id}`)).json().setting;
    const end = await own.post(`${C}/settings/${v2.id}/end`, { version: v2now.version, validTo: '2026-06-01', reason: 'Nova alíquota' });
    expect(end.statusCode, end.body).toBe(200);
    expect((await own.post(`${C}/settings/${ds.id}/validate`, { version: ds.version, validatorName: 'Contador' })).statusCode).toBe(200);
    expect((await t(recent.orderId)).source.ids).toEqual([ds.id]);
    // O banco recusa alterar valor ou apagar.
    await expect(owner.query(`UPDATE cost_settings SET rate_pct = 1 WHERE id = $1`, [v1.id])).rejects.toThrow(/imutavel/);
    await expect(owner.query(`DELETE FROM cost_settings WHERE id = $1`, [v1.id])).rejects.toThrow(/apagada/);
    const hist = (await own.get(`${C}/settings/${v2.id}`)).json().events.map((e: any) => e.action);
    expect(hist).toEqual(['inform', 'validate', 'end']);
    expect(await reconcileCosts()).toEqual([]);
  });

  it('embalagem por tipo (medidas em qualquer ordem) e pelo custo genérico por volume', async () => {
    await setting({ kind: 'packaging', packagingCode: 'CX-30', packagingName: 'Caixa 30x20x10', lengthMm: 300, widthMm: 200, heightMm: 100, fixedCents: 350 });
    const o = await shippedOrder({ packages: [{ weightG: 900, lengthMm: 100, widthMm: 300, heightMm: 200 }, { weightG: 500 }] });
    const lines = line(await margin(o.orderId), 'packaging');
    expect(lines.map((l: any) => l.amountCents).sort((x: number, y: number) => x - y)).toEqual([-350, -120]);
    expect(lines.find((l: any) => l.amountCents === -350).detail).toContain('CX-30');
    // Mesmas medidas em outro tipo: recusado.
    const twin = await inform({ kind: 'packaging', packagingCode: 'CX-B', packagingName: 'Caixa gêmea', lengthMm: 100, widthMm: 200, heightMm: 300, fixedCents: 10 });
    const ts = twin.json().setting;
    const tv = await own.post(`${C}/settings/${ts.id}/validate`, { version: ts.version, validatorName: 'Proprietário' });
    expect(tv.json().error.code).toBe('SETTING_DIMS');
  });
});

describe('lançamentos de custos externos', () => {
  it('sem duplicar: um ativo por tipo, referência única (manual ou planilha), estorno auditável, imutável', async () => {
    const o = await shippedOrder();
    const o2 = await shippedOrder();
    const ref = `MP-${uid()}`;
    const a = await entry(o.orderId, { kind: 'payment_fee', amountCents: 55, externalRef: ref });
    expect(a.statusCode, a.body).toBe(201);
    // Mesma chave: replay, sem duplicar.
    const k = key();
    expect((await entry(o2.orderId, { kind: 'other', amountCents: 10, note: 'Embalagem especial', requestKey: k })).statusCode).toBe(201);
    expect((await entry(o2.orderId, { kind: 'other', amountCents: 10, note: 'Embalagem especial', requestKey: k })).json().replayed).toBe(true);
    // Segundo do mesmo tipo no pedido: recusado.
    expect((await entry(o.orderId, { kind: 'payment_fee', amountCents: 60 })).json().error.code).toBe('COST_ENTRY_EXISTS');
    // Mesma referencia em outro pedido: recusada.
    expect((await entry(o2.orderId, { kind: 'payment_fee', amountCents: 60, externalRef: ref })).json().error.code).toBe('COST_ENTRY_DUPLICATE');
    // Tipo de marketplace em pedido da loja: recusado.
    expect((await entry(o.orderId, { kind: 'marketplace_commission', amountCents: 60 })).json().error.code).toBe('COST_ENTRY_CHANNEL');
    // Concorrencia: dois lancamentos do mesmo tipo ao mesmo tempo, so um entra.
    const o3 = await shippedOrder();
    const both = await Promise.all([entry(o3.orderId, { kind: 'payment_fee', amountCents: 10 }), entry(o3.orderId, { kind: 'payment_fee', amountCents: 11 })]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([201, 409]);

    // Planilha: a taxa ja lancada a mao no pedido e recusada; linha nova entra; tudo ou nada.
    const n = async (id: string) => (await owner.query('SELECT number FROM orders WHERE id = $1', [id])).rows[0].number;
    const csv = `pedido;tipo;valor;data;referencia;observacao\n${await n(o.orderId)};taxa_pagamento;0,70;20/11/2026;IMP-1-${uid()};\n${await n(o2.orderId)};taxa_pagamento;1,25;2026-11-20;IMP-2-${uid()};repasse\n`;
    const prev = await fin.post(`${C}/imports/preview`, { fileName: 'taxas.csv', content: csv });
    expect(prev.statusCode, prev.body).toBe(200);
    expect(prev.json()).toMatchObject({ valid: 1, invalid: 1 });
    expect(prev.json().rows[0].errors[0]).toContain('já tem lançamento ativo');
    const bad = await fin.post(`${C}/imports`, { fileName: 'taxas.csv', content: csv, requestKey: key() });
    expect(bad.statusCode).toBe(422);
    expect((await owner.query(`SELECT count(*)::int AS n FROM order_cost_entries WHERE source = 'import'`)).rows[0].n).toBe(0);
    const good = csv.split('\n').filter((l, i) => i !== 1).join('\n');
    const imp = await fin.post(`${C}/imports`, { fileName: 'taxas.csv', content: good, requestKey: key() });
    expect(imp.statusCode, imp.body).toBe(201);
    expect(imp.json().import).toMatchObject({ rows: 1, totalCents: 125 });
    // Mesmo arquivo de novo: recusado. Lancar a mao depois da importacao: recusado.
    expect((await fin.post(`${C}/imports`, { fileName: 'outra.csv', content: good, requestKey: key() })).json().error.code).toBe('IMPORT_DUPLICATE');
    expect((await entry(o2.orderId, { kind: 'payment_fee', amountCents: 125 })).json().error.code).toBe('COST_ENTRY_EXISTS');
    expect(line(await margin(o2.orderId), 'payment_fee')[0]).toMatchObject({ nature: 'effective', amountCents: -125 });

    // Estorno: valor oposto, com motivo; o pedido volta a aceitar um lancamento; estorno de novo e recusado.
    const id = a.json().entry.id;
    const rev = await fin.post(`${C}/entries/${id}/reverse`, { reason: 'Valor lançado errado', requestKey: key() });
    expect(rev.statusCode, rev.body).toBe(201);
    expect(rev.json().entry).toMatchObject({ amount_cents: '-55', reverses_id: id });
    expect((await fin.post(`${C}/entries/${id}/reverse`, { reason: 'De novo', requestKey: key() })).json().error.code).toBe('COST_ENTRY_REVERSED');
    expect((await fin.post(`${C}/entries/${rev.json().entry.id}/reverse`, { reason: 'Estorno do estorno', requestKey: key() })).json().error.code).toBe('COST_ENTRY_REVERSAL');
    expect((await entry(o.orderId, { kind: 'payment_fee', amountCents: 52, externalRef: ref })).statusCode).toBe(201);
    expect(line(await margin(o.orderId), 'payment_fee')[0].amountCents).toBe(-52);
    await expect(owner.query(`UPDATE order_cost_entries SET amount_cents = 1 WHERE id = $1`, [id])).rejects.toThrow();
    await expect(owner.query(`DELETE FROM order_cost_entries WHERE id = $1`, [id])).rejects.toThrow();
    expect((await owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action IN ('costs.entry_recorded', 'costs.entry_reversed', 'costs.import')`)).rows[0].n).toBeGreaterThanOrEqual(5);
    expect(await reconcileCosts()).toEqual([]);
  });

  it('planilha: cabeçalho, valores e datas inválidos apontados por linha', async () => {
    const prev = await fin.post(`${C}/imports/preview`, { fileName: 'x.csv', content: 'pedido,tipo,valor,data\n999999,taxa,abc,31/02/2026\n' });
    expect(prev.statusCode, prev.body).toBe(200);
    expect(prev.json().rows[0].errors).toEqual(['tipo inválido', 'valor inválido', 'data inválida', 'pedido não encontrado']);
    expect((await fin.post(`${C}/imports/preview`, { fileName: 'x.csv', content: 'a;b\n1;2\n' })).json().error.code).toBe('INVALID_SHEET');
  });
});

describe('devoluções e reembolsos (Fase 9) na margem', () => {
  it('volta ao estoque devolve o CMV; reembolso confirmado entra, solicitado só informa; descarte na quarentena desfaz a devolução do CMV', async () => {
    const o = await shippedOrder();
    const before = await margin(o.orderId);
    const r = (await boss.post(R, { orderId: o.orderId, kind: 'return', reason: 'defect', items: [{ orderItemId: o.item, qty: '60' }], returnMethod: 'store_dropoff', requestKey: key() })).json();
    const v = (await boss.get(`${R}/${r.return.id}`)).json();
    expect((await boss.post(`${R}/${r.return.id}/receive`, { version: v.return.version, requestKey: key() })).statusCode).toBe(200);
    const v2 = (await boss.get(`${R}/${r.return.id}`)).json();
    const ins = await boss.post(`${R}/${r.return.id}/inspect`, { version: v2.return.version, requestKey: key(), lines: [{ itemId: v2.items[0].id, condition: 'good', qty: '50' }, { itemId: v2.items[0].id, condition: 'quarantine', qty: '10' }] });
    expect(ins.statusCode, ins.body).toBe(200);
    const m = await margin(o.orderId);
    // 60 un a 5 centavos (custo da venda) voltam ao estoque.
    expect(sumOf(m, 'return_credit')).toBe(300);
    expect(line(m, 'return_credit').every((l: any) => l.nature === 'effective' && l.source.table === 'return_inspections')).toBe(true);
    // Sem frete de volta (entregue na loja): nada desconhecido novo.
    expect(line(m, 'return_freight')).toHaveLength(0);
    // Quarentena descartada: perda de 10 un.
    const q = (await boss.get(`${R}/quarantine`)).json().items.find((i: any) => i.return_id === r.return.id);
    expect((await boss.post(`${R}/quarantine/${q.inspection_id}/decide`, { decision: 'discard', qty: '10', reason: 'Sem condição de venda', requestKey: key() })).statusCode).toBe(200);
    const m2 = await margin(o.orderId);
    expect(sumOf(m2, 'return_loss')).toBe(-50);
    expect(m2.margin.returnsCents).toBe(250);
    // Reembolso: solicitado fica fora; realizado entra como estimado; confirmado, efetivo. Sem contar duas vezes.
    const rf = (await boss.post(RF, { orderId: o.orderId, returnId: r.return.id, amountCents: 1200, method: 'pix', reason: 'Devolução', requestKey: key() })).json().refund;
    const m3 = await margin(o.orderId);
    expect(line(m3, 'refund')[0]).toMatchObject({ nature: 'info', amountCents: -1200 });
    expect(m3.margin.marginCents).toBe(m2.margin.marginCents);
    const act = async (action: string, extra: Record<string, unknown> = {}) => {
      const ver = (await boss.get(`${RF}/${rf.id}`)).json().refund.version;
      return boss.post(`${RF}/${rf.id}/action`, { action, note: 'Conferido', version: ver, requestKey: key(), ...extra });
    };
    expect((await act('done', { externalRef: `PIX${uid()}` })).statusCode).toBe(200);
    expect(line(await margin(o.orderId), 'refund')[0].nature).toBe('estimated');
    expect((await act('confirm')).statusCode).toBe(200);
    const m4 = await margin(o.orderId);
    expect(line(m4, 'refund')).toHaveLength(1);
    expect(line(m4, 'refund')[0]).toMatchObject({ nature: 'effective', amountCents: -1200 });
    expect(m4.margin.marginCents).toBe(m2.margin.marginCents - 1200);
    // O CMV da venda nao muda (a devolucao entra como linha propria).
    expect(sumOf(m4, 'cogs')).toBe(sumOf(before, 'cogs'));
    expect(await stockReconcile()).toEqual([]);
  });

  it('frete de volta por transportadora sem valor: desconhecido; reposição da troca fica fora da margem', async () => {
    const o = await shippedOrder();
    const r = (await boss.post(R, { orderId: o.orderId, kind: 'exchange', reason: 'defect', items: [{ orderItemId: o.item, qty: '50' }], returnMethod: 'carrier', requestKey: key() })).json();
    const m = await margin(o.orderId);
    expect(line(m, 'return_freight')[0]).toMatchObject({ nature: 'unknown', amountCents: null });
    expect(m.margin.missing).toContain('return_freight');
    const repl = await boss.post(`${R}/${r.return.id}/replacement`, { version: r.return.version, requestKey: key() });
    expect(repl.statusCode, repl.body).toBe(201);
    const rm = await margin(repl.json().replacement.id);
    expect(rm).toMatchObject({ excluded: 'replacement', margin: null });
  });
});

describe('conferência C22-C24', () => {
  it('acusa lançamento duplicado e versão sobreposta gravados por fora; C24 confere a soma das linhas', async () => {
    const ok = await own.get(`${C}/reconcile`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().divergences).toEqual([]);
    expect(ok.json().checkedOrders).toBeGreaterThan(0);
    const o = await shippedOrder();
    expect((await entry(o.orderId, { kind: 'payment_fee', amountCents: 9 })).statusCode).toBe(201);
    // So o dono do banco de testes desliga a trava para simular gravacao por fora.
    await owner.query('ALTER TABLE order_cost_entries DISABLE TRIGGER order_cost_entries_check');
    try {
      await owner.query(`INSERT INTO order_cost_entries (order_id, kind, amount_cents, occurred_on, source, request_key) VALUES ($1, 'payment_fee', 9, current_date, 'manual', $2)`, [o.orderId, key()]);
    } finally {
      await owner.query('ALTER TABLE order_cost_entries ENABLE TRIGGER order_cost_entries_check');
    }
    const s = await setting({ kind: 'marketplace_fee', channel: 'shopee', ratePct: '14', validFrom: '2020-01-01' });
    await owner.query('ALTER TABLE cost_settings DISABLE TRIGGER cost_settings_overlap_check');
    try {
      const r = await inform({ kind: 'marketplace_fee', channel: 'shopee', ratePct: '20', validFrom: '2021-01-01' });
      await owner.query(`UPDATE cost_settings SET status = 'validated', validated_by = $2, validator_name = 'Por fora', validated_at = now() WHERE id = $1`, [r.json().setting.id, own.user.id]);
    } finally {
      await owner.query('ALTER TABLE cost_settings ENABLE TRIGGER cost_settings_overlap_check');
    }
    const div = (await own.get(`${C}/reconcile`)).json().divergences.map((d: any) => `${d.check_code}:${d.field}`).sort();
    expect(div).toEqual(['C22:single', 'C23:overlap']);
    expect(s.status).toBe('validated');
  });
});
