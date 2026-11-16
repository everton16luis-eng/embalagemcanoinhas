// SGLog Fase 2: gestao de fornecedores (docs/18-sglog-fase2.md). Banco de testes com a 0021 aplicada.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { conference } from '../src/modules/purchase-invoices.js';
import { appRole, loggedAs, makeApp, owner, productPayload, resetCatalog, uid } from './helpers.js';

let app: FastifyInstance;
let boss: Awaited<ReturnType<typeof loggedAs>>;
beforeAll(async () => {
  app = await makeApp();
  await resetCatalog();
  boss = await loggedAs(app, 'manager');
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

const SUP = '/api/v1/admin/suppliers';
const PO = '/api/v1/admin/purchase-orders';
const OFF = `${SUP}/offers`;
const key = () => `req-${uid()}-${uid()}`;
const hour = 3_600_000;

type Pack = { id: string; kind: string; label: string; base_qty: string };
async function newProduct() {
  const res = await boss.post('/api/v1/admin/products', productPayload());
  expect(res.statusCode, res.body).toBe(201);
  const v = res.json().product.variants[0];
  const packs = v.packagings as Pack[];
  return { productId: res.json().product.id as string, variantId: v.id as string, purchase: packs.find((k) => k.kind === 'purchase')!, packs };
}
async function newSupplier(extra: Record<string, unknown> = {}) {
  const res = await boss.post(SUP, { name: `Distribuidora ${uid()}`, leadTimeDays: 5, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().supplier as { id: string; version: number; status: string };
}
async function newOffer(supplierId: string, packagingId: string, extra: Record<string, unknown> = {}) {
  const res = await boss.post(`${SUP}/${supplierId}/offers/item`, { packagingId, costCents: 2000, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().offer as { id: string; version: number; variant_id: string; status: string; is_primary: boolean };
}
const offerRow = async (id: string) => (await owner.query('SELECT * FROM supplier_products WHERE id = $1', [id])).rows[0];
const supplierRow = async (id: string) => (await owner.query('SELECT * FROM suppliers WHERE id = $1', [id])).rows[0];
const historyOf = async (offerId: string) => (await owner.query('SELECT * FROM supplier_price_history WHERE supplier_product_id = $1 ORDER BY id', [offerId])).rows;
const grant = (userId: string, permission: string, granted: boolean) =>
  owner.query('INSERT INTO user_permissions (user_id, permission, granted) VALUES ($1, $2, $3) ON CONFLICT (user_id, permission) DO UPDATE SET granted = EXCLUDED.granted', [userId, permission, granted]);
const stockHash = async () =>
  (
    await owner.query(`SELECT (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM stock_balances x) AS b,
                              (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM stock_location_balances x) AS l,
                              (SELECT count(*) FROM stock_movements) AS m`)
  ).rows[0];

describe('permissões (no servidor, por papel e individuais)', () => {
  it('matriz: ver e editar por papel; sem sessão 401', async () => {
    const s = await newSupplier();
    const { purchase, variantId } = await newProduct();
    const o = await newOffer(s.id, purchase.id);
    const reads = [SUP, `${SUP}/${s.id}`, `${SUP}/${s.id}/offers`];
    const viewOnly = [`${SUP}/summary`, `${SUP}/${s.id}/history`, `${SUP}/${s.id}/availability`, `${SUP}/variants/${variantId}/comparison`, `${OFF}/${o.id}/price-history`];
    const cases: [string, boolean, boolean][] = [
      ['manager', true, true],
      ['buyer', true, true],
      ['stock', true, false],
      ['logistics', true, false],
      ['finance', true, false],
      ['sales', false, false],
      ['fiscal', false, false],
      ['shipping', false, false],
    ];
    for (const [role, canView, canManage] of cases) {
      const c = await loggedAs(app, role);
      for (const url of [...reads, ...viewOnly]) expect((await c.get(url)).statusCode, `${role} GET ${url}`).toBe(canView ? 200 : 403);
      const patch = await c.patch(`${OFF}/${o.id}`, { leadTimeDays: 4, version: (await offerRow(o.id)).version });
      expect(patch.statusCode, `${role} PATCH`).toBe(canManage ? 200 : 403);
      expect((await c.post(SUP, { name: `X ${uid()}` })).statusCode, `${role} POST`).toBe(canManage ? 201 : 403);
    }
    const anon = await import('./helpers.js').then((h) => h.client(app));
    expect((await anon.get(SUP)).statusCode).toBe(401);
  });

  it('compatibilidade: quem só tem purchases.view continua lendo lista, detalhe e ofertas', async () => {
    const s = await newSupplier();
    const st = await loggedAs(app, 'stock');
    await grant(st.user.id, 'suppliers.view', false);
    expect((await st.get(SUP)).statusCode).toBe(200);
    expect((await st.get(`${SUP}/${s.id}`)).statusCode).toBe(200);
    expect((await st.get(`${SUP}/${s.id}/offers`)).statusCode).toBe(200);
    // Comparacao, historico e indicadores exigem suppliers.view.
    expect((await st.get(`${SUP}/summary`)).statusCode).toBe(403);
    expect((await st.get(`${SUP}/${s.id}/history`)).statusCode).toBe(403);
  });

  it('concessão individual dá ao estoquista a edição; revogação tira do comprador', async () => {
    const s = await newSupplier();
    const { purchase } = await newProduct();
    const o = await newOffer(s.id, purchase.id);
    const st = await loggedAs(app, 'stock');
    expect((await st.patch(`${OFF}/${o.id}`, { costCents: 2100, version: o.version })).statusCode).toBe(403);
    await grant(st.user.id, 'suppliers.manage', true);
    expect((await st.patch(`${OFF}/${o.id}`, { costCents: 2100, version: o.version })).statusCode).toBe(200);
    const bu = await loggedAs(app, 'buyer');
    await grant(bu.user.id, 'suppliers.manage', false);
    expect((await bu.post(SUP, { name: `Y ${uid()}` })).statusCode).toBe(403);
    // Compras continuam com o comprador.
    expect((await bu.get(PO)).statusCode).toBe(200);
  });

  it('parâmetros: só settings.manage (com verificação em duas etapas) altera', async () => {
    const cfg = (await boss.get(`${SUP}/settings`)).json().settings;
    expect([Number(cfg.tie_tolerance_pct), cfg.stale_quote_days, cfg.availability_warning_days]).toEqual([3, 90, 3]);
    expect((await boss.put(`${SUP}/settings`, { tieTolerancePct: 5, staleQuoteDays: 60, availabilityWarningDays: 2, version: cfg.version })).json().error?.code).toBe('MFA_REQUIRED');
    const bu = await loggedAs(app, 'buyer');
    expect((await bu.put(`${SUP}/settings`, { tieTolerancePct: 5, staleQuoteDays: 60, availabilityWarningDays: 2, version: cfg.version })).statusCode).toBe(403);
    const own = await loggedAs(app, 'owner', { mfa: true });
    const ok = await own.put(`${SUP}/settings`, { tieTolerancePct: 5, staleQuoteDays: 60, availabilityWarningDays: 2, version: cfg.version });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await own.put(`${SUP}/settings`, { tieTolerancePct: 4, staleQuoteDays: 60, availabilityWarningDays: 2, version: cfg.version })).json().error?.code).toBe('VERSION_CONFLICT');
    const back = await own.put(`${SUP}/settings`, { tieTolerancePct: 3, staleQuoteDays: 90, availabilityWarningDays: 3, version: ok.json().settings.version });
    expect(back.statusCode).toBe(200);
  });
});

describe('histórico de custo (imutável)', () => {
  it('mudança de custo gera exatamente uma linha com antes, depois, autor, origem e justificativa; custo igual não gera', async () => {
    const s = await newSupplier();
    const { purchase, variantId } = await newProduct();
    const o = await newOffer(s.id, purchase.id, { costCents: 2000, quotedAt: '2026-10-01' });
    let h = await historyOf(o.id);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ old_cost_cents: null, new_cost_cents: '2000', source: 'manual', supplier_id: s.id, variant_id: variantId, changed_by: boss.user.id });
    const p = await boss.patch(`${OFF}/${o.id}`, { costCents: 2300, costReason: 'Reajuste da tabela de novembro', version: o.version });
    expect(p.statusCode, p.body).toBe(200);
    h = await historyOf(o.id);
    expect(h).toHaveLength(2);
    expect(h[1]).toMatchObject({ old_cost_cents: '2000', new_cost_cents: '2300', source: 'manual', reason: 'Reajuste da tabela de novembro', changed_by: boss.user.id });
    // Custo igual, ou so outro campo: nenhuma linha nova.
    await boss.patch(`${OFF}/${o.id}`, { costCents: 2300, version: p.json().offer.version });
    await boss.patch(`${OFF}/${o.id}`, { leadTimeDays: 3, version: (await offerRow(o.id)).version });
    expect(await historyOf(o.id)).toHaveLength(2);
    // Rota legada tambem grava, com origem propria.
    expect((await boss.put(`${SUP}/${s.id}/offers`, [{ packagingId: purchase.id, costCents: 2500 }])).statusCode).toBe(200);
    h = await historyOf(o.id);
    expect(h).toHaveLength(3);
    expect(h[2]).toMatchObject({ old_cost_cents: '2300', new_cost_cents: '2500', source: 'legacy_list' });
    const api = (await boss.get(`${OFF}/${o.id}/price-history`)).json();
    expect(api.items.map((i: { new_cost_cents: string }) => i.new_cost_cents)).toEqual(['2500', '2300', '2000']);
  });

  it('ninguém reescreve o histórico: aplicação sem permissão, dono recusado pelo gatilho', async () => {
    const s = await newSupplier();
    const { purchase, variantId } = await newProduct();
    const o = await newOffer(s.id, purchase.id);
    const id = (await historyOf(o.id))[0].id;
    await expect(appRole.query(`INSERT INTO supplier_price_history (supplier_product_id, supplier_id, variant_id, new_cost_cents, quoted_at, source) VALUES ($1, $2, $3, 1, current_date, 'manual')`, [o.id, s.id, variantId])).rejects.toMatchObject({ code: '42501' });
    await expect(appRole.query('UPDATE supplier_price_history SET new_cost_cents = 1 WHERE id = $1', [id])).rejects.toMatchObject({ code: '42501' });
    await expect(appRole.query('DELETE FROM supplier_price_history WHERE id = $1', [id])).rejects.toMatchObject({ code: '42501' });
    await expect(owner.query('UPDATE supplier_price_history SET new_cost_cents = 1 WHERE id = $1', [id])).rejects.toMatchObject({ code: '23001' });
    await expect(owner.query('DELETE FROM supplier_price_history WHERE id = $1', [id])).rejects.toMatchObject({ code: '23001' });
    await expect(owner.query('TRUNCATE supplier_price_history')).rejects.toThrow();
    await expect(appRole.query('UPDATE supplier_availability SET available_qty = 1')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('concorrência entre usuários', () => {
  it('duas edições da mesma oferta com a mesma versão: uma grava, a outra recebe 409 e o histórico tem uma linha', async () => {
    const s = await newSupplier();
    const { purchase } = await newProduct();
    const o = await newOffer(s.id, purchase.id);
    const other = await loggedAs(app, 'buyer');
    const [a, b] = await Promise.all([
      boss.patch(`${OFF}/${o.id}`, { costCents: 2100, version: o.version }),
      other.patch(`${OFF}/${o.id}`, { costCents: 2200, version: o.version }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error).toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: o.version + 1 } });
    expect(await historyOf(o.id)).toHaveLength(2);
  });

  it('duas trocas simultâneas de principal na mesma variante terminam com exatamente um', async () => {
    const { purchase, variantId } = await newProduct();
    const o1 = await newOffer((await newSupplier()).id, purchase.id);
    const o2 = await newOffer((await newSupplier()).id, purchase.id);
    const other = await loggedAs(app, 'buyer');
    const res = await Promise.all([boss.post(`${OFF}/${o1.id}/primary`, { version: o1.version }), other.post(`${OFF}/${o2.id}/primary`, { version: o2.version })]);
    expect(res.every((r) => r.statusCode === 200), res.map((r) => r.body).join()).toBe(true);
    const primaries = (await owner.query('SELECT id FROM supplier_products WHERE variant_id = $1 AND is_primary', [variantId])).rows;
    expect(primaries).toHaveLength(1);
    // A segunda troca informa qual era o anterior.
    expect(res.some((r) => r.json().previousOfferId !== null)).toBe(true);
  });

  it('edição do cadastro com versão velha: 409 sem gravar nada, nem os contatos', async () => {
    const s = await newSupplier({ contacts: [{ name: 'Joana', phone: '4733334444', isPrimary: true }] });
    const ok = await boss.put(`${SUP}/${s.id}`, { name: 'Nome novo', contacts: [{ name: 'Joana', phone: '4733334444' }], version: s.version });
    expect(ok.statusCode, ok.body).toBe(200);
    const stale = await boss.put(`${SUP}/${s.id}`, { name: 'Sobrescreveria', contacts: [], version: s.version });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error?.code).toBe('VERSION_CONFLICT');
    const now = (await boss.get(`${SUP}/${s.id}`)).json().supplier;
    expect(now.name).toBe('Nome novo');
    expect(now.contacts).toHaveLength(1);
    // Sem versao: recusado (nunca sobrescreve as cegas).
    expect((await boss.put(`${SUP}/${s.id}`, { name: 'Sem versão' })).statusCode).toBe(400);
  });
});

describe('exclusão lógica e reativação', () => {
  it('a aplicação não apaga fornecedor nem oferta; o dono esbarra nas ligações', async () => {
    const s = await newSupplier();
    const { purchase } = await newProduct();
    const o = await newOffer(s.id, purchase.id);
    await expect(appRole.query('DELETE FROM supplier_products WHERE id = $1', [o.id])).rejects.toMatchObject({ code: '42501' });
    await expect(appRole.query('DELETE FROM suppliers WHERE id = $1', [s.id])).rejects.toMatchObject({ code: '42501' });
    await expect(owner.query('DELETE FROM suppliers WHERE id = $1', [s.id])).rejects.toMatchObject({ code: expect.stringMatching(/^23(001|503)$/) });
    await expect(owner.query('DELETE FROM supplier_products WHERE id = $1', [o.id])).rejects.toMatchObject({ code: expect.stringMatching(/^23(001|503)$/) });
  });

  it('arquivar exige inativo ou bloqueado e motivo, preserva tudo; restaurar volta inativo', async () => {
    const s = await newSupplier();
    const { purchase } = await newProduct();
    const o = await newOffer(s.id, purchase.id);
    const po = await boss.post(PO, { supplierId: s.id, items: [{ packagingId: purchase.id, packs: '1' }] });
    expect(po.statusCode, po.body).toBe(201);
    expect((await boss.post(`${SUP}/${s.id}/archive`, { reason: 'Encerrou atividades', version: s.version })).json().error?.code).toBe('ARCHIVE_ACTIVE');
    const inact = await boss.post(`${SUP}/${s.id}/status`, { status: 'inactive', version: s.version });
    expect(inact.statusCode, inact.body).toBe(200);
    expect(inact.json().openOrders).toBe(1);
    expect((await boss.post(`${SUP}/${s.id}/archive`, { reason: 'x', version: inact.json().supplier.version })).statusCode).toBe(400);
    const arch = await boss.post(`${SUP}/${s.id}/archive`, { reason: 'Encerrou atividades', version: inact.json().supplier.version });
    expect(arch.statusCode, arch.body).toBe(200);
    expect((await boss.get(`${SUP}?status=current`)).json().items.some((i: { id: string }) => i.id === s.id)).toBe(false);
    expect((await boss.get(`${SUP}?status=archived`)).json().items.some((i: { id: string }) => i.id === s.id)).toBe(true);
    expect(await offerRow(o.id)).toBeDefined();
    expect((await historyOf(o.id)).length).toBe(1);
    expect((await boss.get(`${PO}/${po.json().order.id}`)).statusCode).toBe(200);
    // Arquivado nao vira ativo pela edicao.
    expect((await boss.put(`${SUP}/${s.id}`, { name: 'Volta', active: true, version: arch.json().supplier.version })).json().error?.code).toBe('USE_STATUS_ROUTE');
    const rest = await boss.post(`${SUP}/${s.id}/restore`, { version: arch.json().supplier.version });
    expect(rest.json().supplier).toMatchObject({ status: 'inactive', archived_at: null });
  });

  it('encerrar oferta: sai de tudo; a lista antiga não a reativa; reativar é explícito e auditado', async () => {
    const s = await newSupplier();
    const { purchase, variantId } = await newProduct();
    const o = await newOffer(s.id, purchase.id);
    expect((await boss.post(`${OFF}/${o.id}/end`, { reason: 'x', version: o.version })).statusCode).toBe(400);
    const ended = await boss.post(`${OFF}/${o.id}/end`, { reason: 'Fornecedor parou de vender', version: o.version });
    expect(ended.json().offer).toMatchObject({ status: 'ended', active: false });
    expect((await boss.patch(`${OFF}/${o.id}`, { costCents: 10, version: ended.json().offer.version })).json().error?.code).toBe('OFFER_ENDED');
    expect((await boss.put(`${SUP}/${s.id}/offers`, [{ packagingId: purchase.id, costCents: 2000 }])).json().error?.code).toBe('OFFER_ENDED');
    // Nem o codigo antigo (active = true) reativa: o gatilho recusa.
    await expect(owner.query('UPDATE supplier_products SET active = true WHERE id = $1', [o.id])).rejects.toThrow(/reativacao explicita/);
    const cmp = (await boss.get(`${SUP}/variants/${variantId}/comparison`)).json();
    expect(cmp.choice.recommended).toBeNull();
    expect((await boss.post(`${OFF}/${o.id}/reactivate`, { version: ended.json().offer.version })).statusCode).toBe(400);
    const re = await boss.post(`${OFF}/${o.id}/reactivate`, { reason: 'Voltou a vender', version: ended.json().offer.version });
    expect(re.json().offer).toMatchObject({ status: 'active', active: true, ended_at: null });
    const log = (await owner.query(`SELECT metadata FROM audit_logs WHERE action = 'suppliers.offer_reactivated' AND entity_id = $1`, [o.id])).rows;
    expect(log).toHaveLength(1);
    expect(log[0].metadata.reason).toBe('Voltou a vender');
  });

  it('active e status sincronizados nos dois sentidos (código antigo e seed)', async () => {
    const s = await newSupplier();
    await owner.query('UPDATE suppliers SET active = false WHERE id = $1', [s.id]);
    expect(await supplierRow(s.id)).toMatchObject({ status: 'inactive', active: false });
    await owner.query(`UPDATE suppliers SET status = 'active' WHERE id = $1`, [s.id]);
    expect(await supplierRow(s.id)).toMatchObject({ status: 'active', active: true });
    const ins = (await owner.query(`INSERT INTO suppliers (name, active) VALUES ('Seed inativo', false) RETURNING status, active`)).rows[0];
    expect(ins).toEqual({ status: 'inactive', active: false });
    const { purchase } = await newProduct();
    const o = await newOffer(s.id, purchase.id);
    await owner.query('UPDATE supplier_products SET active = false WHERE id = $1', [o.id]);
    expect(await offerRow(o.id)).toMatchObject({ status: 'paused', active: false });
    await owner.query('UPDATE supplier_products SET active = true WHERE id = $1', [o.id]);
    expect(await offerRow(o.id)).toMatchObject({ status: 'active', active: true });
  });
});

describe('fornecedor bloqueado', () => {
  it('bloquear exige motivo; bloqueado não recebe pedido novo nem envia rascunho; o enviado continua recebível; perde o principal', async () => {
    const s = await newSupplier();
    const { purchase, variantId } = await newProduct();
    const o = await newOffer(s.id, purchase.id);
    await boss.post(`${OFF}/${o.id}/primary`, { version: o.version });
    const draft = (await boss.post(PO, { supplierId: s.id, items: [{ packagingId: purchase.id, packs: '1' }] })).json().order;
    const sent = (await boss.post(PO, { supplierId: s.id, items: [{ packagingId: purchase.id, packs: '1' }] })).json().order;
    expect((await boss.post(`${PO}/${sent.id}/send`)).statusCode).toBe(200);

    expect((await boss.post(`${SUP}/${s.id}/status`, { status: 'blocked', version: s.version })).json().error?.code).toBe('REASON_REQUIRED');
    const bl = await boss.post(`${SUP}/${s.id}/status`, { status: 'blocked', reason: 'Atraso recorrente', version: s.version });
    expect(bl.statusCode, bl.body).toBe(200);
    expect(bl.json().supplier).toMatchObject({ status: 'blocked', active: false, blocked_reason: 'Atraso recorrente' });
    expect(bl.json().variantsLostPrimary.map((v: { variant_id: string }) => v.variant_id)).toEqual([variantId]);
    expect(bl.json().openOrders).toBe(2);
    expect((await offerRow(o.id)).is_primary).toBe(false);

    expect((await boss.post(PO, { supplierId: s.id, items: [{ packagingId: purchase.id, packs: '1' }] })).json().error?.code).toBe('SUPPLIER_BLOCKED');
    expect((await boss.post(`${PO}/${draft.id}/send`)).json().error?.code).toBe('SUPPLIER_BLOCKED');
    const rec = await boss.post(`${PO}/${sent.id}/receipts`, { requestKey: key(), items: [{ itemId: sent.items[0].id, packs: '1' }] });
    expect(rec.statusCode, rec.body).toBe(201);

    const cmp = (await boss.get(`${SUP}/variants/${variantId}/comparison`)).json();
    expect(cmp.choice.excluded[0].reasons).toContain('fornecedor bloqueado: Atraso recorrente');
    // Desbloquear nao devolve o principal sozinho (D2-9).
    const un = await boss.post(`${SUP}/${s.id}/status`, { status: 'active', version: bl.json().supplier.version });
    expect(un.json().supplier).toMatchObject({ status: 'active', blocked_reason: null });
    expect((await offerRow(o.id)).is_primary).toBe(false);
  });

  it('principal só com fornecedor e oferta ativos; pausar tira a marca', async () => {
    const s = await newSupplier({ active: false });
    const { purchase } = await newProduct();
    const o = await newOffer(s.id, purchase.id);
    expect((await boss.post(`${OFF}/${o.id}/primary`, { version: o.version })).json().error?.code).toBe('INVALID_STATE');
    const s2 = await newSupplier();
    const o2 = await newOffer(s2.id, purchase.id);
    const p = await boss.post(`${OFF}/${o2.id}/primary`, { version: o2.version });
    expect(p.json().offer.is_primary).toBe(true);
    const paused = await boss.patch(`${OFF}/${o2.id}`, { status: 'paused', version: p.json().offer.version });
    expect(paused.json().offer).toMatchObject({ status: 'paused', is_primary: false });
  });
});

describe('códigos do fornecedor e NF-e de compra', () => {
  it('embalagem repetida e código repetido no mesmo fornecedor: 409; em outro fornecedor o código pode repetir', async () => {
    const s = await newSupplier();
    const a = await newProduct();
    const b = await newProduct();
    await newOffer(s.id, a.purchase.id, { supplierSku: 'COD-1' });
    expect((await boss.post(`${SUP}/${s.id}/offers/item`, { packagingId: a.purchase.id, costCents: 100 })).json().error?.code).toBe('DUPLICATE_OFFER');
    expect((await boss.post(`${SUP}/${s.id}/offers/item`, { packagingId: b.purchase.id, costCents: 100, supplierSku: 'COD-1' })).json().error?.code).toBe('DUPLICATE_SUPPLIER_SKU');
    expect((await boss.put(`${SUP}/${s.id}/offers`, [{ packagingId: b.purchase.id, costCents: 100 }, { packagingId: b.purchase.id, costCents: 200 }])).json().error?.code).toBe('DUPLICATE_OFFER');
    expect((await boss.put(`${SUP}/${s.id}/offers`, [{ packagingId: a.purchase.id, costCents: 100, supplierSku: 'X' }, { packagingId: b.purchase.id, costCents: 200, supplierSku: 'X' }])).json().error?.code).toBe('DUPLICATE_SUPPLIER_SKU');
    await newOffer((await newSupplier()).id, b.purchase.id, { supplierSku: 'COD-1' });
    // Vazio vira nulo; espaco nas pontas sai (o banco recusa codigo vazio ou com espaco).
    const blank = await newOffer(s.id, b.purchase.id, { supplierSku: '   ' });
    expect((await offerRow(blank.id)).supplier_sku).toBeNull();
    await expect(owner.query(`UPDATE supplier_products SET supplier_sku = ' X' WHERE id = $1`, [blank.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('a conferência da NF-e de compra casa pelo código exato do fornecedor, sem ambiguidade', async () => {
    const doc = '11222333000181';
    const s = await newSupplier({ document: doc });
    const { purchase } = await newProduct();
    await newOffer(s.id, purchase.id, { supplierSku: 'NF-ABC' });
    const inv = { supplier_id: null, supplier_document: doc, protocol_status: '100', items: [{ code: 'NF-ABC', qty: '1' }, { code: 'nf-abc', qty: '1' }] };
    const r = await conference(pool, inv);
    expect(r.supplier?.id).toBe(s.id);
    expect(r.items[0]!.match).toMatchObject({ packagingId: purchase.id, by: 'supplier_sku' });
    expect(r.items[1]!.match).toBeNull();
  });
});

describe('integridade produto–variante–embalagem', () => {
  it('a variante da oferta é sempre a da embalagem; fornecedor e embalagem não mudam', async () => {
    const s = await newSupplier();
    const a = await newProduct();
    const b = await newProduct();
    const row = (await owner.query('INSERT INTO supplier_products (supplier_id, packaging_id, cost_cents, variant_id) VALUES ($1, $2, 100, $3) RETURNING variant_id', [s.id, a.purchase.id, b.variantId])).rows[0];
    expect(row.variant_id).toBe(a.variantId);
    const o = (await owner.query('SELECT id FROM supplier_products WHERE supplier_id = $1', [s.id])).rows[0];
    await expect(owner.query('UPDATE supplier_products SET packaging_id = $2 WHERE id = $1', [o.id, b.purchase.id])).rejects.toThrow(/nao mudam/);
    await expect(owner.query('UPDATE supplier_products SET variant_id = $2 WHERE id = $1 RETURNING variant_id', [o.id, b.variantId])).resolves.toMatchObject({ rows: [{ variant_id: a.variantId }] });
  });

  it('embalagem ou variante desativada tira a oferta da sugestão sem apagar', async () => {
    const s = await newSupplier();
    const { purchase, variantId } = await newProduct();
    const o = await newOffer(s.id, purchase.id);
    await owner.query('UPDATE packagings SET active = false WHERE id = $1', [purchase.id]);
    const cmp = (await boss.get(`${SUP}/variants/${variantId}/comparison`)).json();
    expect(cmp.choice.excluded[0].reasons).toContain('embalagem de compra desativada no catálogo');
    expect(await offerRow(o.id)).toBeDefined();
    await owner.query('UPDATE packagings SET active = true WHERE id = $1', [purchase.id]);
  });
});

describe('disponibilidade do fornecedor (não é estoque da loja)', () => {
  it('vencida aparece como vencida e não vale como zero; nova confirmação passa a valer; histórico só cresce', async () => {
    const s = await newSupplier();
    const { purchase, variantId } = await newProduct();
    const o = await newOffer(s.id, purchase.id);
    const now = Date.now();
    const bad = await boss.post(`${SUP}/${s.id}/availability`, { variantId, availableQty: '500', confirmedAt: new Date(now - hour).toISOString(), validUntil: new Date(now - 2 * hour).toISOString() });
    expect(bad.json().error?.code).toBe('INVALID_DATE');
    expect((await boss.post(`${SUP}/${s.id}/availability`, { variantId, availableQty: '1', validUntil: new Date(now + hour).toISOString(), confirmedAt: new Date(now + 2 * hour).toISOString() })).json().error?.code).toBe('INVALID_DATE');
    const other = await newProduct();
    expect((await boss.post(`${SUP}/${s.id}/availability`, { variantId: other.variantId, availableQty: '1', validUntil: new Date(now + hour).toISOString() })).json().error?.code).toBe('NO_OFFER');

    const old = await boss.post(`${SUP}/${s.id}/availability`, { variantId, availableQty: '0', confirmedAt: new Date(now - 48 * hour).toISOString(), validUntil: new Date(now - 24 * hour).toISOString(), source: 'whatsapp' });
    expect(old.statusCode, old.body).toBe(201);
    let cur = (await boss.get(`${SUP}/${s.id}/availability`)).json();
    expect(cur.current[0]).toMatchObject({ expired: true, available_qty: '0.000' });
    let cmp = (await boss.get(`${SUP}/variants/${variantId}/comparison?need=100`)).json();
    // Compra para estoque: vencida nao exclui e e tratada como sem informacao.
    expect(cmp.choice.recommended.offerId).toBe(o.id);
    expect(cmp.choice.recommended.availability).toBe('expired');

    await boss.post(`${SUP}/${s.id}/availability`, { variantId, availableQty: '3000', validUntil: new Date(now + 24 * hour).toISOString(), note: 'Confirmado pelo representante' });
    cur = (await boss.get(`${SUP}/${s.id}/availability`)).json();
    expect(cur.current[0]).toMatchObject({ expired: false, available_qty: '3000.000' });
    expect(cur.total).toBe(2);
    cmp = (await boss.get(`${SUP}/variants/${variantId}/comparison?need=100`)).json();
    expect(cmp.choice.recommended.availability).toBe('current');
    const hist = (await boss.get(`${SUP}/${s.id}/history`)).json();
    expect(hist.items.filter((i: { kind: string }) => i.kind === 'availability')).toHaveLength(2);
    expect(hist.items.some((i: { kind: string }) => i.kind === 'cost')).toBe(true);
  });

  it('informar disponibilidade não mexe em saldo, saldo por depósito, livro nem conferência', async () => {
    const s = await newSupplier();
    const { purchase, variantId } = await newProduct();
    await newOffer(s.id, purchase.id);
    await boss.post('/api/v1/admin/stock/movements', { variantId, kind: 'adjustment', qty: '10', reason: 'Teste', requestKey: key() });
    const before = await stockHash();
    const shown = (await boss.get(`/api/v1/admin/stock/variants/${variantId}`)).json().variant;
    for (const q of ['99999', '0', '5']) {
      expect((await boss.post(`${SUP}/${s.id}/availability`, { variantId, availableQty: q, validUntil: new Date(Date.now() + hour).toISOString() })).statusCode).toBe(201);
    }
    expect(await stockHash()).toEqual(before);
    expect((await boss.get(`/api/v1/admin/stock/variants/${variantId}`)).json().variant).toEqual(shown);
    const recon = (await appRole.query('SELECT check_code FROM stock_reconcile()')).rows.filter((r) => r.check_code !== 'run');
    expect(recon).toEqual([]);
    // Nenhum gatilho ou dependencia liga a disponibilidade ao estoque.
    const deps = (
      await owner.query(`SELECT DISTINCT c.relname FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid JOIN pg_class v ON v.oid = r.ev_class JOIN pg_class c ON c.oid = d.refobjid
                         WHERE v.relname = 'supplier_offer_terms' AND c.relname LIKE 'stock%'`)
    ).rows;
    expect(deps).toEqual([]);
    const trg = (await owner.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'supplier_availability'::regclass AND NOT tgisinternal ORDER BY 1`)).rows.map((r) => r.tgname);
    expect(trg).toEqual(['supplier_availability_immutable', 'supplier_availability_no_truncate']);
  });
});

describe('compra abaixo do mínimo ou fora do múltiplo', () => {
  it('avisa com 422 e a lista; com justificativa grava no item e na auditoria', async () => {
    const s = await newSupplier();
    const { purchase } = await newProduct();
    await newOffer(s.id, purchase.id, { minOrderPacks: '5', orderMultiplePacks: '5' });
    const low = await boss.post(PO, { supplierId: s.id, items: [{ packagingId: purchase.id, packs: '3' }] });
    expect(low.statusCode).toBe(422);
    expect(low.json().error).toMatchObject({ code: 'BELOW_MINIMUM', details: { items: [{ packagingId: purchase.id, minOrderPacks: '5.000', orderMultiplePacks: '5.000' }] } });
    expect((await boss.post(PO, { supplierId: s.id, items: [{ packagingId: purchase.id, packs: '7' }] })).json().error?.code).toBe('BELOW_MINIMUM');
    const ok = await boss.post(PO, { supplierId: s.id, items: [{ packagingId: purchase.id, packs: '10' }] });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().order.items[0]).toMatchObject({ min_order_packs: '5.000', order_multiple_packs: '5.000', min_exception_reason: null });
    const just = await boss.post(PO, { supplierId: s.id, items: [{ packagingId: purchase.id, packs: '3', minExceptionReason: 'Fornecedor aceitou fracionar nesta compra' }] });
    expect(just.statusCode, just.body).toBe(201);
    expect(just.json().order.items[0].min_exception_reason).toBe('Fornecedor aceitou fracionar nesta compra');
    const log = (await owner.query(`SELECT metadata FROM audit_logs WHERE action = 'purchases.min_exception' AND entity_id = $1`, [just.json().order.id])).rows;
    expect(log[0].metadata.items[0].reason).toBe('Fornecedor aceitou fracionar nesta compra');
  });
});

describe('lista, indicadores e comparação', () => {
  it('lista antiga sem filtro traz só ativos; filtros novos por situação, alerta e UF; resumo', async () => {
    const active = await newSupplier({ uf: 'SC' });
    const inactive = await newSupplier({ active: false, uf: 'PR' });
    const ids = (r: { json: () => { items: { id: string }[] } }) => r.json().items.map((i) => i.id);
    expect(ids(await boss.get(`${SUP}?pageSize=100`))).toContain(active.id);
    expect(ids(await boss.get(`${SUP}?pageSize=100`))).not.toContain(inactive.id);
    expect(ids(await boss.get(`${SUP}?active=false&pageSize=100`))).toContain(inactive.id);
    expect(ids(await boss.get(`${SUP}?status=current&uf=PR&pageSize=100`))).toEqual([inactive.id]);
    expect(ids(await boss.get(`${SUP}?status=current&alert=missing_document&pageSize=100`))).toContain(active.id);
    const { purchase } = await newProduct();
    const o = await newOffer(active.id, purchase.id, { quotedAt: '2026-01-10' });
    expect(ids(await boss.get(`${SUP}?alert=stale_price&pageSize=100`))).toContain(active.id);
    const sum = (await boss.get(`${SUP}/summary`)).json().summary;
    expect(sum.stale_quotes).toBeGreaterThanOrEqual(1);
    expect(sum.variants_without_primary).toBeGreaterThanOrEqual(1);
    const det = (await boss.get(`${SUP}/${active.id}`)).json().supplier;
    expect(det.alerts.stale_quotes).toBe(1);
    expect(det.indicators).toMatchObject({ orders: 0, primary_items: 0 });
    expect(det.offers[0]).toMatchObject({ id: o.id, unit_cost_cents: '20.0000' });
    const offers = (await boss.get(`${SUP}/${active.id}/offers`)).json().items;
    expect(offers[0].stale_quote).toBe(true);
  });

  it('comparação explica a escolha com frete desconhecido e empate técnico pelo principal', async () => {
    const { purchase, variantId } = await newProduct();
    const cheap = await newSupplier({ orderFreightCents: 0, orderExtraCents: 0 });
    const prim = await newSupplier({ orderFreightCents: 0, orderExtraCents: 0 });
    const unknown = await newSupplier();
    await newOffer(cheap.id, purchase.id, { costCents: 1000 });
    const op = await newOffer(prim.id, purchase.id, { costCents: 1020 });
    await newOffer(unknown.id, purchase.id, { costCents: 500 });
    await boss.post(`${OFF}/${op.id}/primary`, { version: op.version });
    const cmp = (await boss.get(`${SUP}/variants/${variantId}/comparison?need=1000`)).json();
    expect(cmp.choice.recommended.offerId).toBe(op.id);
    expect(cmp.choice.recommended.reasons[0]).toMatch(/empate técnico.*principal/);
    const last = cmp.choice.options[2];
    expect(last.supplierId).toBe(unknown.id);
    expect(last.costComplete).toBe(false);
    expect(last.reasons[0]).toMatch(/incompleto/);
  });
});
