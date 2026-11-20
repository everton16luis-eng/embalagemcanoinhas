// SGLog Fase 2: regressao da reposicao (D2-6, docs/18-sglog-fase2.md). A Fase 2 nao mexe em stock-reports.ts; o que
// poderia mudar o resultado e o banco (status/active sincronizados, pausa, bloqueio, arquivo, encerramento, campos
// novos). Este teste compara a rota com uma COPIA CONGELADA do calculo anterior (b5ff9f2), que le so as colunas
// antigas (sp.active, s.active, cost_cents, lead_time_days), e confere que os dados novos da Fase 2 nao alteram nada.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { appRole, loggedAs, makeApp, sendPurchase, owner, productPayload, resetCatalog, uid } from './helpers.js';

let app: FastifyInstance;
let boss: Awaited<ReturnType<typeof loggedAs>>;
beforeAll(async () => {
  app = await makeApp();
  await resetCatalog();
  // Ajuste de estoque exige MFA desde a Fase 3 (D3-2).
  boss = await loggedAs(app, 'manager', { mfa: true });
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

const S = '/api/v1/admin/stock';
const SUP = '/api/v1/admin/suppliers';
const OFF = `${SUP}/offers`;
const PO = '/api/v1/admin/purchase-orders';
const PARAMS = { days: 90, coverDays: 30, maxCoverDays: 90 };
const key = () => `req-${uid()}-${uid()}`;

// ------------------------------------------------------------------ copia congelada do calculo anterior (b5ff9f2)
const DEFAULT_LEAD_DAYS = 7;
const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
async function legacyReplenishment(variantIds: string[], params = PARAMS) {
  const rows = (
    await owner.query(
      `SELECT v.id AS variant_id, v.sku, p.name AS product_name, p.base_unit, u.allows_fraction, p.min_stock, p.lead_time_days AS product_lead,
              coalesce(b.on_hand, 0) AS on_hand, coalesce(b.reserved, 0) AS reserved, coalesce(b.avg_cost_cents, 0) AS avg_cost_cents,
              coalesce((SELECT sum((i.packs - i.received_packs) * i.base_qty_per_pack) FROM purchase_order_items i JOIN purchase_orders o ON o.id = i.order_id
                        WHERE i.variant_id = v.id AND o.status IN ('sent', 'partial')), 0) AS inbound,
              coalesce((SELECT -sum(m.on_hand_delta) FROM stock_movements m WHERE m.variant_id = v.id AND m.kind IN ('sale', 'return')
                        AND m.created_at >= now() - make_interval(days => $1)), 0) AS sold
       FROM product_variants v JOIN products p ON p.id = v.product_id JOIN units u ON u.code = p.base_unit LEFT JOIN stock_balances b ON b.variant_id = v.id
       WHERE v.active AND p.status = 'active' AND v.id = ANY($2)`,
      [params.days, variantIds],
    )
  ).rows;
  const offers = (
    await owner.query(
      `SELECT k.variant_id, s.id AS supplier_id, s.name AS supplier_name, k.id AS packaging_id, k.label, k.base_qty, sp.cost_cents,
              coalesce(sp.lead_time_days, s.lead_time_days) AS lead_time_days
       FROM supplier_products sp JOIN suppliers s ON s.id = sp.supplier_id JOIN packagings k ON k.id = sp.packaging_id
       WHERE sp.active AND s.active AND k.active`,
    )
  ).rows;
  const byVariant = new Map<string, typeof offers>();
  for (const o of offers) byVariant.set(o.variant_id, [...(byVariant.get(o.variant_id) ?? []), o]);
  const items = [];
  for (const r of rows) {
    const sold = Math.max(0, Number(r.sold));
    const daily = sold / params.days;
    const available = Number(r.on_hand) - Number(r.reserved);
    const inbound = Number(r.inbound);
    const min = Number(r.min_stock);
    const variantOffers = byVariant.get(r.variant_id) ?? [];
    const leads = variantOffers.map((o) => o.lead_time_days).filter((d): d is number => d !== null);
    const lead = leads.length ? Math.min(...leads) : (r.product_lead ?? DEFAULT_LEAD_DAYS);
    let need = daily * (lead + params.coverDays) + min - (available + inbound);
    if (!r.allows_fraction) need = Math.ceil(need);
    need = Math.max(0, round(need));
    const belowMin = min > 0 && available < min;
    const options = variantOffers
      .map((o) => {
        const base = Number(o.base_qty);
        const packs = Math.max(1, Math.ceil(need / base));
        const buyQty = round(packs * base);
        const unitCost = Number(o.cost_cents) / base;
        const coverage = daily > 0 ? Math.floor((available + inbound + buyQty) / daily) : null;
        return {
          supplierId: o.supplier_id,
          supplierName: o.supplier_name,
          packagingId: o.packaging_id,
          label: o.label,
          baseQtyPerPack: o.base_qty,
          packs,
          buyQty,
          unitCostCents: round(unitCost, 4),
          totalCents: packs * Number(o.cost_cents),
          leadTimeDays: o.lead_time_days,
          coverageDays: coverage,
          excess: coverage === null ? buyQty > Math.max(need, min) * 2 : coverage > params.maxCoverDays,
          recommended: false,
        };
      })
      .sort((a, b) => a.unitCostCents - b.unitCostCents || a.totalCents - b.totalCents);
    const pick = options.find((o) => !o.excess) ?? [...options].sort((a, b) => a.totalCents - b.totalCents)[0];
    if (pick) pick.recommended = true;
    items.push({
      variantId: r.variant_id,
      sku: r.sku,
      productName: r.product_name,
      baseUnit: r.base_unit,
      onHand: r.on_hand,
      reserved: r.reserved,
      available: round(available),
      inbound: round(inbound),
      minStock: r.min_stock,
      soldInPeriod: round(sold),
      dailyAvg: round(daily, 3),
      coverageDays: daily > 0 ? Math.floor(Math.max(0, available) / daily) : null,
      leadTimeDays: lead,
      need,
      belowMin,
      options,
    });
  }
  items.sort((a, b) => Number(b.belowMin) - Number(a.belowMin) || (a.coverageDays ?? 1e9) - (b.coverageDays ?? 1e9) || a.productName.localeCompare(b.productName, 'pt-BR'));
  return JSON.parse(JSON.stringify(items));
}

// ------------------------------------------------------------------ cenario
type Pack = { id: string; kind: string; label: string; base_qty: string };
async function newProduct(name: string) {
  const res = await boss.post('/api/v1/admin/products', productPayload({ name: `${name} ${uid()}` }));
  expect(res.statusCode, res.body).toBe(201);
  const v = res.json().product.variants[0];
  const packs = v.packagings as Pack[];
  return { variantId: v.id as string, p100: packs.find((k) => k.kind === 'purchase')!, p50: packs.find((k) => k.label === 'Pacote com 50')! };
}
async function newSupplier(name: string, leadTimeDays: number) {
  const res = await boss.post(SUP, { name: `${name} ${uid()}`, leadTimeDays });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().supplier as { id: string; version: number; name: string };
}
async function offer(supplierId: string, packagingId: string, costCents: number, extra: Record<string, unknown> = {}) {
  const res = await boss.post(`${SUP}/${supplierId}/offers/item`, { packagingId, costCents, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().offer as { id: string; version: number };
}
/** Saldo 100 e 95 vendidas no periodo (giro de ~1,056/dia), como o teste de reposicao existente. */
async function stockAndSales(variantId: string) {
  await boss.post(`${S}/movements`, { variantId, kind: 'adjustment', qty: '100', reason: 'Saldo de implantação', requestKey: key() });
  const r = await boss.post(`${S}/reservations`, { variantId, qty: '95', sourceId: `venda-${uid()}` });
  expect(r.statusCode, r.body).toBe(201);
  await boss.post(`${S}/reservations/${r.json().reservation.id}/consume`);
}
const supplierVersion = async (id: string) => (await owner.query<{ version: number }>('SELECT version FROM suppliers WHERE id = $1', [id])).rows[0]!.version;
const offerVersion = async (id: string) => (await owner.query<{ version: number }>('SELECT version FROM supplier_products WHERE id = $1', [id])).rows[0]!.version;

describe('reposição: equivalência com o comportamento anterior à Fase 2', () => {
  it('seleção, custo por unidade, cobertura máxima, quantidade sugerida, inativo, pausada e pedidos existentes', async () => {
    const A = await newProduct('Copo reposicao A');
    const B = await newProduct('Copo reposicao B');
    const s1 = await newSupplier('Atacado Um', 7);
    const s2 = await newSupplier('Atacado Dois', 3);
    const s3 = await newSupplier('Atacado Inativo', 1);
    // A: pacote de 100 a R$ 0,20/un (S1), 50 a R$ 0,22/un (S1), 100 a R$ 0,23/un (S2); S3 e o mais barato, mas inativo.
    const s1a100 = await offer(s1.id, A.p100.id, 2000);
    const s1a50 = await offer(s1.id, A.p50.id, 1100);
    const s2a100 = await offer(s2.id, A.p100.id, 2300);
    await offer(s3.id, A.p100.id, 1500);
    expect((await boss.post(`${SUP}/${s3.id}/status`, { status: 'inactive', version: await supplierVersion(s3.id) })).statusCode).toBe(200);
    // B: so S1, com minimo de 5 pacotes (campo da Fase 2, que a reposicao nao le).
    await offer(s1.id, B.p100.id, 2000, { minOrderPacks: '5' });
    await stockAndSales(A.variantId);
    await stockAndSales(B.variantId);
    // Pedidos existentes de B: enviado (entra como "a caminho", mesmo abaixo do minimo com justificativa) e rascunho (nao entra).
    const sent = await boss.post(PO, { supplierId: s1.id, items: [{ packagingId: B.p100.id, packs: '1', minExceptionReason: 'Reposição de teste' }] });
    expect(sent.statusCode, sent.body).toBe(201);
    expect((await sendPurchase(app, boss, sent.json().order.id)).statusCode).toBe(200);
    expect((await boss.post(PO, { supplierId: s1.id, items: [{ packagingId: B.p100.id, packs: '2', minExceptionReason: 'Rascunho de teste' }] })).statusCode).toBe(201);

    const ids = [A.variantId, B.variantId];
    const current = async () => {
      const res = await boss.get(`/api/v1/admin/stock-reports/replenishment?days=${PARAMS.days}&coverDays=${PARAMS.coverDays}&maxCoverDays=${PARAMS.maxCoverDays}&all=true`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json().items.filter((i: { variantId: string }) => ids.includes(i.variantId));
    };
    const same = async () => {
      const now = await current();
      expect(now).toEqual(await legacyReplenishment(ids));
      return now;
    };
    const itemOf = (items: any[], variantId: string) => items.find((i) => i.variantId === variantId);

    // 1. Resultado conhecido (valores calculados pela regra anterior).
    const base = await same();
    const a = itemOf(base, A.variantId);
    // Menor prazo entre as ofertas ativas: 3 dias (S2). (3 + 30) x 95/90 - 5 disponiveis = 29,83 → 30.
    expect([a.leadTimeDays, a.need, a.available, a.inbound]).toEqual([3, 30, 5, 0]);
    expect(a.options.map((o: any) => [o.supplierId, o.label, o.unitCostCents, o.packs, o.coverageDays, o.excess, o.recommended])).toEqual([
      [s1.id, A.p100.label, 20, 1, 99, true, false],
      [s1.id, 'Pacote com 50', 22, 1, 52, false, true],
      [s2.id, A.p100.label, 23, 1, 99, true, false],
    ]);
    const b = itemOf(base, B.variantId);
    // B: 100 a caminho (pedido enviado); o rascunho nao conta; nada a comprar e a unica opcao passa da cobertura.
    expect([b.leadTimeDays, b.need, b.inbound]).toEqual([7, 0, 100]);
    expect(b.options.map((o: any) => [o.packs, o.coverageDays, o.excess, o.recommended])).toEqual([[1, 194, true, true]]);

    // 2. Dados que so a Fase 2 tem nao mudam nada: minimo/multiplo, dropship, preparacao, principal, disponibilidade
    //    do fornecedor (nao e estoque), prazos de preparo e transporte do fornecedor, parametros da comparacao.
    expect((await boss.patch(`${OFF}/${s1a50.id}`, { minOrderPacks: '5', orderMultiplePacks: '5', dropshipAllowed: true, prepDays: 10, version: await offerVersion(s1a50.id) })).statusCode).toBe(200);
    expect((await boss.post(`${OFF}/${s2a100.id}/primary`, { version: await offerVersion(s2a100.id) })).statusCode).toBe(200);
    const until = new Date(Date.now() + 86_400_000).toISOString();
    expect((await boss.post(`${SUP}/${s1.id}/availability`, { variantId: A.variantId, availableQty: '0', validUntil: until, source: 'whatsapp' })).statusCode).toBe(201);
    const put = await boss.put(`${SUP}/${s1.id}`, { name: s1.name, leadTimeDays: 7, prepDays: 20, deliveryDays: 20, cep: '89460000', city: 'Canoinhas', uf: 'SC', dropshipEnabled: true, version: await supplierVersion(s1.id) });
    expect(put.statusCode, put.body).toBe(200);
    await owner.query('UPDATE supplier_settings SET tie_tolerance_pct = 10, stale_quote_days = 1');
    expect(await same()).toEqual(base);

    // 3. Oferta pausada sai, como a inativa saia; voltar a ativa devolve o mesmo resultado.
    expect((await boss.patch(`${OFF}/${s1a50.id}`, { status: 'paused', version: await offerVersion(s1a50.id) })).statusCode).toBe(200);
    const paused = itemOf(await same(), A.variantId);
    expect(paused.options.map((o: any) => o.label)).toEqual([A.p100.label, A.p100.label]);
    // Todas passam da cobertura: fica a de menor desembolso (S1, R$ 20,00).
    expect(paused.options.find((o: any) => o.recommended).supplierId).toBe(s1.id);
    expect((await boss.patch(`${OFF}/${s1a50.id}`, { status: 'active', version: await offerVersion(s1a50.id) })).statusCode).toBe(200);
    expect(await same()).toEqual(base);

    // 4. Fornecedor bloqueado sai, como o inativo; desbloquear devolve o mesmo resultado.
    expect((await boss.post(`${SUP}/${s1.id}/status`, { status: 'blocked', reason: 'Atraso recorrente', version: await supplierVersion(s1.id) })).statusCode).toBe(200);
    const blocked = await same();
    expect(itemOf(blocked, A.variantId).options.map((o: any) => o.supplierId)).toEqual([s2.id]);
    expect(itemOf(blocked, B.variantId).options).toEqual([]);
    // O pedido enviado ao bloqueado continua "a caminho".
    expect(itemOf(blocked, B.variantId).inbound).toBe(100);
    expect((await boss.post(`${SUP}/${s1.id}/status`, { status: 'active', version: await supplierVersion(s1.id) })).statusCode).toBe(200);
    expect(await same()).toEqual(base);

    // 5. Oferta encerrada sai (e o prazo passa a ser o de S1: 7 dias → 35); reativar devolve o mesmo resultado.
    expect((await boss.post(`${OFF}/${s2a100.id}/end`, { reason: 'Saiu de linha', version: await offerVersion(s2a100.id) })).statusCode).toBe(200);
    const ended = itemOf(await same(), A.variantId);
    expect([ended.leadTimeDays, ended.need, ended.options.length]).toEqual([7, 35, 2]);
    expect((await boss.post(`${OFF}/${s2a100.id}/reactivate`, { reason: 'Voltou', version: await offerVersion(s2a100.id) })).statusCode).toBe(200);
    expect(await same()).toEqual(base);

    // 6. Arquivar o inativo nao muda nada; o custo novo entra pela regra de sempre (menor custo por unidade).
    expect((await boss.post(`${SUP}/${s3.id}/archive`, { reason: 'Sem uso', version: await supplierVersion(s3.id) })).statusCode).toBe(200);
    expect(await same()).toEqual(base);
    expect((await boss.patch(`${OFF}/${s1a100.id}`, { costCents: 2400, costReason: 'Reajuste', version: await offerVersion(s1a100.id) })).statusCode).toBe(200);
    const repriced = itemOf(await same(), A.variantId);
    expect(repriced.options.map((o: any) => o.unitCostCents)).toEqual([22, 23, 24]);
    expect(itemOf(await same(), B.variantId)).toEqual(itemOf(base, B.variantId));
  });
});
