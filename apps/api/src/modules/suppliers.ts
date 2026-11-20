// Fornecedores (SGLog Fase 2, docs/18-sglog-fase2.md). Cadastro, situacao, arquivamento logico, ofertas por linha
// com versao, historico de custo, disponibilidade informada pelo fornecedor (NUNCA estoque da loja), comparacao por
// variante e parametros. As rotas antigas continuam com o mesmo contrato (GET lista/detalhe, POST, PUT e a lista de
// precos PUT /:id/offers); a escrita passa a exigir suppliers.manage e toda edicao confere a versao.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { isValidCnpj, isValidCpf, UFS } from '../lib/br.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation, likePattern, pageQuery } from '../lib/http.js';
import { chooseSupplier, type SupplierOfferInput } from '../lib/supplier-choice.js';
import { requireAnyPermission, requirePermission } from './auth.js';

const digits = (v: string) => v.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
const phone = z.string().trim().transform((v) => v.replace(/\D/g, '')).pipe(z.string().regex(/^\d{10,13}$/, 'Telefone com DDD.'));
const whatsapp = z.string().trim().transform((v) => v.replace(/\D/g, '')).pipe(z.string().regex(/^\d{12,13}$/, 'WhatsApp com DDI e DDD, ex.: 5547999990000.'));
const opt = <T extends z.ZodType>(s: T) => s.nullable().optional();
const days = (max: number) => z.number().int().min(0).max(max);
const cents = z.number().int().min(0).max(1_000_000_000);
const packs = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim().replace(',', '.'))
  .pipe(z.string().regex(/^\d{1,9}(\.\d{1,3})?$/, 'Quantidade com até 3 casas decimais.'))
  .refine((v) => Number(v) > 0, 'Quantidade maior que zero.');
const reason = z.string().trim().min(3).max(300);
const version = z.number().int().min(1);
// Codigo do fornecedor: vazio vira nulo; nunca e alterado de outra forma (a NF-e casa pelo codigo exato).
const supplierSku = z
  .string()
  .trim()
  .max(60)
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

const contactSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  role: opt(z.string().trim().max(60)),
  email: opt(z.email().max(254)),
  phone: opt(phone),
  whatsapp: opt(whatsapp),
  isPrimary: z.boolean().default(false),
});

const supplierFields = {
  name: z.string().trim().min(2).max(120),
  legalName: opt(z.string().trim().max(150)),
  document: opt(
    z
      .string()
      .trim()
      .transform(digits)
      .refine((v) => (v.length === 11 ? isValidCpf(v) : isValidCnpj(v)), 'CPF ou CNPJ inválido.'),
  ),
  stateRegistration: opt(z.string().trim().transform((v) => v.replace(/\D/g, '')).pipe(z.string().regex(/^\d{2,14}$/))),
  email: opt(z.email().max(254)),
  phone: opt(phone),
  whatsapp: opt(whatsapp),
  website: opt(z.url().max(200)),
  cep: opt(z.string().trim().transform((v) => v.replace(/\D/g, '')).pipe(z.string().regex(/^\d{8}$/, 'CEP com 8 dígitos.'))),
  street: opt(z.string().trim().max(120)),
  number: opt(z.string().trim().max(20)),
  complement: opt(z.string().trim().max(60)),
  district: opt(z.string().trim().max(60)),
  city: opt(z.string().trim().max(60)),
  uf: opt(z.enum(UFS)),
  paymentTerms: opt(z.string().trim().max(200)),
  leadTimeDays: opt(days(180)),
  prepDays: opt(days(180)),
  deliveryDays: opt(days(180)),
  minOrderCents: opt(cents),
  orderFreightCents: opt(cents),
  orderExtraCents: opt(cents),
  freightTerms: opt(z.string().trim().max(200)),
  returnPolicy: opt(z.string().trim().max(2000)),
  returnDays: opt(days(365)),
  dropshipEnabled: z.boolean().default(false),
  notes: opt(z.string().trim().max(2000)),
  contacts: z
    .array(contactSchema)
    .max(10)
    .default([])
    .refine((c) => c.filter((x) => x.isPrimary).length <= 1, 'Só um contato principal.'),
};
const createSchema = z.strictObject({ ...supplierFields, active: z.boolean().default(true) });
// Edicao: exige a versao lida. `active` (contrato antigo) so alterna entre ativo e inativo; bloquear e arquivar tem
// rotas proprias, com motivo.
const updateSchema = z.strictObject({ ...supplierFields, active: z.boolean().optional(), version });
type SupplierInput = z.infer<typeof createSchema>;

const legacyOfferSchema = z.strictObject({
  packagingId: z.uuid(),
  supplierSku,
  costCents: z.number().int().positive().max(1_000_000_000),
  leadTimeDays: opt(days(180)),
  quotedAt: opt(z.iso.date()),
  active: z.boolean().default(true),
  version: version.optional(),
});

const offerFields = {
  supplierSku,
  costCents: z.number().int().positive().max(1_000_000_000),
  leadTimeDays: opt(days(180)),
  prepDays: opt(days(180)),
  minOrderPacks: opt(packs),
  orderMultiplePacks: opt(packs),
  dropshipAllowed: z.boolean().default(false),
  quotedAt: opt(z.iso.date()),
};
const createOfferSchema = z.strictObject({ packagingId: z.uuid(), ...offerFields, status: z.enum(['active', 'paused']).default('active') });
const patchOfferSchema = z.strictObject({
  supplierSku,
  costCents: offerFields.costCents.optional(),
  leadTimeDays: offerFields.leadTimeDays,
  prepDays: offerFields.prepDays,
  minOrderPacks: offerFields.minOrderPacks,
  orderMultiplePacks: offerFields.orderMultiplePacks,
  dropshipAllowed: z.boolean().optional(),
  quotedAt: offerFields.quotedAt,
  status: z.enum(['active', 'paused']).optional(),
  costReason: opt(z.string().trim().max(300)),
  version,
});

const COLS = `id, name, legal_name, document, state_registration, email, phone, whatsapp, website, cep, street, number, complement, district,
  city, uf, payment_terms, lead_time_days, prep_days, delivery_days, min_order_cents, order_freight_cents, order_extra_cents, freight_terms,
  return_policy, return_days, dropship_enabled, notes, active, status, blocked_reason, blocked_at, blocked_by, archived_at, archived_by,
  archive_reason, version, created_at, updated_at`;

const OFFER_COLS = `t.id, t.supplier_id, t.supplier_name, t.supplier_status, t.packaging_id, t.packaging_label, t.base_qty, t.packaging_active,
  t.variant_id, t.sku, t.variant_active, t.product_id, t.product_name, t.product_status, t.base_unit, t.supplier_sku, t.cost_cents,
  t.unit_cost_cents, t.quoted_at, t.quote_age_days, t.min_order_packs, t.order_multiple_packs, t.status, t.is_primary, t.dropship_allowed,
  t.version, t.prep_days, t.delivery_days, t.lead_days, t.available_qty, t.availability_confirmed_at, t.availability_valid_until,
  t.availability_source, t.availability_expired, sp.lead_time_days, sp.prep_days AS offer_prep_days, sp.active, sp.ended_at, sp.end_reason,
  sp.created_at, sp.updated_at`;

type Settings = { tie_tolerance_pct: string; stale_quote_days: number; availability_warning_days: number; version: number };
export const settings = async (db: Db | typeof pool) => (await db.query<Settings>('SELECT tie_tolerance_pct, stale_quote_days, availability_warning_days, version, updated_at FROM supplier_settings')).rows[0]!;

type OfferRow = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Ofertas de uma ou mais variantes, como a comparacao e o motor de alocacao (Fase 4) leem. */
export async function offerRows(db: Db | typeof pool, variantIds: string[]): Promise<OfferRow[]> {
  if (!variantIds.length) return [];
  return (
    await db.query(
      `SELECT ${OFFER_COLS}, t.supplier_archived_at, t.supplier_blocked_reason, t.min_order_cents, t.order_freight_cents, t.order_extra_cents,
              t.dropship_enabled
       FROM supplier_offer_terms t JOIN supplier_products sp ON sp.id = t.id WHERE t.variant_id = ANY($1::uuid[])
       ORDER BY t.status = 'ended', t.supplier_name, t.base_qty, t.id`,
      [variantIds],
    )
  ).rows;
}

/** Linha da visao para a entrada da escolha de fornecedor (ofertas encerradas ficam de fora). */
export function offerInputs(offers: OfferRow[]): SupplierOfferInput[] {
  return offers
    .filter((o) => o.status !== 'ended')
    .map((o) => ({
      offerId: o.id,
      supplierId: o.supplier_id,
      supplierName: o.supplier_name,
      supplierStatus: o.supplier_status,
      supplierBlockedReason: o.supplier_blocked_reason,
      supplierArchived: o.supplier_archived_at !== null,
      offerStatus: o.status,
      packagingLabel: o.packaging_label,
      packagingActive: o.packaging_active,
      variantActive: o.variant_active,
      costCents: o.cost_cents === null ? null : Number(o.cost_cents),
      baseQty: Number(o.base_qty),
      minOrderPacks: o.min_order_packs === null ? null : Number(o.min_order_packs),
      orderMultiplePacks: o.order_multiple_packs === null ? null : Number(o.order_multiple_packs),
      leadDays: o.lead_days,
      isPrimary: o.is_primary,
      orderFreightCents: o.order_freight_cents === null ? null : Number(o.order_freight_cents),
      orderExtraCents: o.order_extra_cents === null ? null : Number(o.order_extra_cents),
      minOrderCents: o.min_order_cents === null ? null : Number(o.min_order_cents),
      quotedAt: typeof o.quoted_at === 'string' ? o.quoted_at.slice(0, 10) : new Date(o.quoted_at).toISOString().slice(0, 10),
      dropshipEnabled: o.dropship_enabled,
      dropshipAllowed: o.dropship_allowed,
      availableQty: o.available_qty === null ? null : Number(o.available_qty),
      availabilityConfirmedAt: o.availability_confirmed_at ? new Date(o.availability_confirmed_at).toISOString() : null,
      availabilityValidUntil: o.availability_valid_until ? new Date(o.availability_valid_until).toISOString() : null,
    }));
}

const values = (s: Omit<SupplierInput, 'active'>) => [
  s.name,
  s.legalName ?? null,
  s.document ?? null,
  s.stateRegistration ?? null,
  s.email ?? null,
  s.phone ?? null,
  s.whatsapp ?? null,
  s.website ?? null,
  s.cep ?? null,
  s.street ?? null,
  s.number ?? null,
  s.complement ?? null,
  s.district ?? null,
  s.city ?? null,
  s.uf ?? null,
  s.paymentTerms ?? null,
  s.leadTimeDays ?? null,
  s.prepDays ?? null,
  s.deliveryDays ?? null,
  s.minOrderCents ?? null,
  s.orderFreightCents ?? null,
  s.orderExtraCents ?? null,
  s.freightTerms ?? null,
  s.returnPolicy ?? null,
  s.returnDays ?? null,
  s.dropshipEnabled,
  s.notes ?? null,
];
const FIELD_COLS = `name, legal_name, document, state_registration, email, phone, whatsapp, website, cep, street, number, complement, district,
  city, uf, payment_terms, lead_time_days, prep_days, delivery_days, min_order_cents, order_freight_cents, order_extra_cents, freight_terms,
  return_policy, return_days, dropship_enabled, notes`;

const conflict = (current: number) =>
  new AppError(409, 'VERSION_CONFLICT', 'Outra pessoa alterou este registro. Recarregue para ver a versão atual; nada foi gravado.', { currentVersion: current });

function supplierError(err: unknown): never {
  if (isUniqueViolation(err, 'suppliers_document_unique')) throw new AppError(409, 'DOCUMENT_IN_USE', 'Já existe fornecedor com este CPF/CNPJ.');
  if (isUniqueViolation(err, 'supplier_products_supplier_id_packaging_id_key')) throw new AppError(409, 'DUPLICATE_OFFER', 'Este fornecedor já tem oferta para esta embalagem (veja também as encerradas).');
  if (isUniqueViolation(err, 'supplier_products_sku_unique')) throw new AppError(409, 'DUPLICATE_SUPPLIER_SKU', 'Este código já está em outra oferta do mesmo fornecedor.');
  if (isUniqueViolation(err, 'supplier_products_one_primary')) throw new AppError(409, 'PRIMARY_CONFLICT', 'A variante já tem outro fornecedor principal. Recarregue.');
  // Regras dos gatilhos da 0021 (ex.: reativar oferta encerrada pela lista, principal com fornecedor inativo).
  const e = err as { code?: string; message?: string };
  if (e.code === '23514' && e.message && !e.message.includes('violates check constraint')) throw new AppError(409, 'INVALID_STATE', e.message);
  throw err;
}

async function load(db: Db | typeof pool, id: string) {
  const s = (await db.query(`SELECT ${COLS} FROM suppliers WHERE id = $1`, [id])).rows[0];
  if (!s) return null;
  s.contacts = (await db.query('SELECT id, name, role, email, phone, whatsapp, is_primary FROM supplier_contacts WHERE supplier_id = $1 ORDER BY is_primary DESC, name', [id])).rows;
  // Contrato antigo: ofertas convertidas para a unidade base (e assim que fornecedores diferentes ficam comparaveis).
  s.offers = (
    await db.query(
      `SELECT ${OFFER_COLS} FROM supplier_offer_terms t JOIN supplier_products sp ON sp.id = t.id
       WHERE t.supplier_id = $1 ORDER BY t.product_name, t.sku, t.base_qty`,
      [id],
    )
  ).rows;
  return s;
}

/** Linha travada para edicao, com conferencia da versao. */
async function lockSupplier(db: Db, id: string, expected?: number) {
  const row = (await db.query<{ version: number; status: string; archived_at: string | null; name: string }>('SELECT version, status, archived_at, name FROM suppliers WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!row) throw notFound();
  if (expected !== undefined && row.version !== expected) throw conflict(row.version);
  return row;
}

async function lockOffer(db: Db, offerId: string, expected?: number) {
  const row = (
    await db.query<{ id: string; supplier_id: string; variant_id: string; version: number; status: string; is_primary: boolean }>(
      'SELECT id, supplier_id, variant_id, version, status, is_primary FROM supplier_products WHERE id = $1 FOR UPDATE',
      [offerId],
    )
  ).rows[0];
  if (!row) throw notFound();
  if (expected !== undefined && row.version !== expected) throw conflict(row.version);
  return row;
}

const loadOffer = async (db: Db | typeof pool, offerId: string) =>
  (await db.query(`SELECT ${OFFER_COLS} FROM supplier_offer_terms t JOIN supplier_products sp ON sp.id = t.id WHERE t.id = $1`, [offerId])).rows[0] ?? null;

async function saveContacts(db: Db, supplierId: string, contacts: SupplierInput['contacts']) {
  // Contato nao tem historico ligado: substitui a lista; antes e depois ficam na auditoria do fornecedor.
  await db.query('DELETE FROM supplier_contacts WHERE supplier_id = $1', [supplierId]);
  for (const c of contacts) {
    await db.query('INSERT INTO supplier_contacts (supplier_id, name, role, email, phone, whatsapp, is_primary) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      supplierId,
      c.name,
      c.role ?? null,
      c.email ?? null,
      c.phone ?? null,
      c.whatsapp ?? null,
      c.isPrimary,
    ]);
  }
}

const setCostSource = (db: Db, source: 'manual' | 'legacy_list', why?: string | null) =>
  db.query(`SELECT set_config('sglog.cost_source', $1, true), set_config('sglog.cost_reason', $2, true)`, [source, why ?? '']);

// Alertas por fornecedor: cotacao antiga, disponibilidade vencida, sem contato, sem documento.
const ALERTS_SQL = (s: string) => `
  (SELECT count(*)::int FROM supplier_products sp WHERE sp.supplier_id = ${s}.id AND sp.status = 'active'
     AND sp.quoted_at < current_date - (SELECT stale_quote_days FROM supplier_settings)) AS stale_quotes,
  (SELECT count(*)::int FROM (SELECT DISTINCT ON (a.variant_id) a.valid_until FROM supplier_availability a
     WHERE a.supplier_id = ${s}.id AND a.variant_id IN (SELECT variant_id FROM supplier_products WHERE supplier_id = ${s}.id AND status = 'active')
     ORDER BY a.variant_id, a.confirmed_at DESC, a.id DESC) x WHERE x.valid_until < now()) AS expired_availability,
  (${s}.phone IS NULL AND ${s}.whatsapp IS NULL AND ${s}.email IS NULL AND NOT EXISTS (
     SELECT 1 FROM supplier_contacts c WHERE c.supplier_id = ${s}.id AND (c.phone IS NOT NULL OR c.whatsapp IS NOT NULL OR c.email IS NOT NULL))) AS missing_contact,
  (${s}.document IS NULL) AS missing_document`;

export async function supplierRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------------ lista, indicadores e parametros
  app.get('/', async (req) => {
    requireAnyPermission(req, 'suppliers.view', 'purchases.view');
    const q = pageQuery
      .extend({
        q: z.string().trim().max(100).optional(),
        // Contrato antigo: active=true|false|all. Novo: status.
        active: z.enum(['true', 'false', 'all']).optional(),
        status: z.enum(['current', 'active', 'inactive', 'blocked', 'archived', 'all']).optional(),
        uf: z.enum(UFS).optional(),
        alert: z.enum(['stale_price', 'expired_availability', 'missing_contact', 'missing_document']).optional(),
        dropship: z.enum(['true', 'false']).optional(),
        sort: z.enum(['name', 'last_receipt', 'offers']).default('name'),
      })
      .parse(req.query);
    // Sem filtro, como antes: so ativos (a tela de compras depende disso). A tela nova manda `status`.
    const status = q.status ?? (q.active === 'false' ? 'inactive_or_blocked' : q.active === 'all' ? 'all' : 'active');
    const params: unknown[] = [q.q ? likePattern(q.q) : null, status, q.uf ?? null, q.dropship === undefined ? null : q.dropship === 'true', q.alert ?? null];
    const where = `($1::text IS NULL OR s.name ILIKE $1 OR s.legal_name ILIKE $1 OR s.document ILIKE $1)
      AND CASE $2::text
            WHEN 'current' THEN s.archived_at IS NULL
            WHEN 'archived' THEN s.archived_at IS NOT NULL
            WHEN 'inactive_or_blocked' THEN s.status <> 'active' AND s.archived_at IS NULL
            WHEN 'all' THEN true
            ELSE s.status = $2 AND s.archived_at IS NULL END
      AND ($3::text IS NULL OR s.uf = $3) AND ($4::boolean IS NULL OR s.dropship_enabled = $4)
      AND CASE $5::text
            WHEN 'stale_price' THEN a.stale_quotes > 0
            WHEN 'expired_availability' THEN a.expired_availability > 0
            WHEN 'missing_contact' THEN a.missing_contact
            WHEN 'missing_document' THEN a.missing_document
            ELSE true END`;
    const base = `FROM suppliers s CROSS JOIN LATERAL (SELECT ${ALERTS_SQL('s')}) a
      LEFT JOIN LATERAL (SELECT count(*)::int AS offer_count FROM supplier_products sp WHERE sp.supplier_id = s.id AND sp.status = 'active') o ON true
      LEFT JOIN LATERAL (SELECT max(r.received_at) AS last_receipt_at FROM purchase_receipts r JOIN purchase_orders po ON po.id = r.order_id WHERE po.supplier_id = s.id) lr ON true`;
    const order = { name: 's.name, s.id', last_receipt: 'lr.last_receipt_at DESC NULLS LAST, s.name, s.id', offers: 'o.offer_count DESC, s.name, s.id' }[q.sort];
    const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n ${base} WHERE ${where}`, params)).rows[0]!.n;
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.legal_name, s.document, s.city, s.uf, s.lead_time_days, s.prep_days, s.delivery_days, s.active, s.status,
              s.blocked_reason, s.archived_at, s.dropship_enabled, s.whatsapp, s.phone, s.version, o.offer_count, lr.last_receipt_at,
              a.stale_quotes, a.expired_availability, a.missing_contact, a.missing_document
       ${base} WHERE ${where} ORDER BY ${order} LIMIT $6 OFFSET $7`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { items: rows, total, page: q.page, pageSize: q.pageSize };
  });

  app.get('/summary', async (req) => {
    requirePermission(req, 'suppliers.view');
    const { rows } = await pool.query(
      `WITH st AS (SELECT stale_quote_days FROM supplier_settings),
            act AS (SELECT sp.* FROM supplier_products sp JOIN suppliers s ON s.id = sp.supplier_id JOIN product_variants v ON v.id = sp.variant_id
                    WHERE sp.status = 'active' AND s.status = 'active' AND v.active),
            cur AS (SELECT DISTINCT ON (a.supplier_id, a.variant_id) a.valid_until FROM supplier_availability a
                    ORDER BY a.supplier_id, a.variant_id, a.confirmed_at DESC, a.id DESC)
       SELECT (SELECT count(*)::int FROM suppliers WHERE status = 'active' AND archived_at IS NULL) AS active,
              (SELECT count(*)::int FROM suppliers WHERE status = 'inactive' AND archived_at IS NULL) AS inactive,
              (SELECT count(*)::int FROM suppliers WHERE status = 'blocked' AND archived_at IS NULL) AS blocked,
              (SELECT count(*)::int FROM suppliers WHERE archived_at IS NOT NULL) AS archived,
              (SELECT count(*)::int FROM act WHERE quoted_at < current_date - (SELECT stale_quote_days FROM st)) AS stale_quotes,
              (SELECT count(*)::int FROM cur WHERE valid_until < now()) AS expired_availability,
              (SELECT count(*)::int FROM (SELECT variant_id FROM act GROUP BY 1 HAVING NOT bool_or(is_primary)) x) AS variants_without_primary,
              (SELECT count(*)::int FROM (SELECT variant_id FROM act GROUP BY 1 HAVING count(DISTINCT supplier_id) = 1) x) AS single_supplier_variants`,
    );
    return { summary: rows[0], settings: await settings(pool) };
  });

  app.get('/settings', async (req) => {
    requireAnyPermission(req, 'suppliers.view', 'settings.manage');
    return { settings: await settings(pool) };
  });

  app.put('/settings', async (req) => {
    const auth = requirePermission(req, 'settings.manage');
    const b = z
      .strictObject({
        tieTolerancePct: z.number().min(0).max(50).multipleOf(0.01),
        staleQuoteDays: z.number().int().min(1).max(3650),
        availabilityWarningDays: z.number().int().min(0).max(90),
        version,
      })
      .parse(req.body);
    const saved = await tx(auth.userId, async (db) => {
      const before = (await db.query('SELECT tie_tolerance_pct, stale_quote_days, availability_warning_days, version FROM supplier_settings FOR UPDATE')).rows[0];
      if (before.version !== b.version) throw conflict(before.version);
      await db.query(
        `UPDATE supplier_settings SET tie_tolerance_pct = $1, stale_quote_days = $2, availability_warning_days = $3, version = version + 1, updated_by = $4, updated_at = now()`,
        [b.tieTolerancePct, b.staleQuoteDays, b.availabilityWarningDays, auth.userId],
      );
      const after = await settings(db);
      await audit(db, { actorId: auth.userId, action: 'suppliers.settings_updated', entity: 'supplier_settings', before, after, ip: req.ip });
      return after;
    });
    return { settings: saved };
  });

  // ------------------------------------------------------------------ comparacao por variante
  app.get('/variants/:variantId/comparison', async (req) => {
    requirePermission(req, 'suppliers.view');
    const { variantId } = z.object({ variantId: z.uuid() }).parse(req.params);
    const q = z
      .object({
        need: z.coerce.number().positive().max(1e9).optional(),
        maxLeadDays: z.coerce.number().int().min(0).max(365).optional(),
      })
      .parse(req.query);
    const variant = (
      await pool.query(
        `SELECT v.id, v.sku, v.active, p.id AS product_id, p.name AS product_name, p.base_unit, p.min_stock FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1`,
        [variantId],
      )
    ).rows[0];
    if (!variant) throw notFound();
    const cfg = await settings(pool);
    const offers = await offerRows(pool, [variantId]);
    // Sem necessidade informada: uma embalagem da maior oferta ativa (so para comparar custos equivalentes).
    const need = q.need ?? Math.max(1, ...offers.filter((o) => o.status === 'active').map((o) => Number(o.base_qty)));
    const input = offerInputs(offers);
    const choice = chooseSupplier(input, { need, context: 'purchase', maxLeadDays: q.maxLeadDays ?? null, dropshipReleased: false, now: new Date() }, {
      tieTolerancePct: Number(cfg.tie_tolerance_pct),
      staleQuoteDays: cfg.stale_quote_days,
    });
    return { variant, need, offers, choice, settings: cfg };
  });

  // ------------------------------------------------------------------ ofertas por linha
  app.get('/offers/:offerId/price-history', async (req) => {
    requirePermission(req, 'suppliers.view');
    const { offerId } = z.object({ offerId: z.uuid() }).parse(req.params);
    const q = pageQuery.parse(req.query);
    const offer = await loadOffer(pool, offerId);
    if (!offer) throw notFound();
    const total = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM supplier_price_history WHERE supplier_product_id = $1', [offerId])).rows[0]!.n;
    const { rows } = await pool.query(
      `SELECT h.id, h.old_cost_cents, h.new_cost_cents, round(h.new_cost_cents / $2::numeric, 4) AS new_unit_cost_cents, h.quoted_at, h.source, h.reason,
              h.changed_at, u.name AS changed_by_name
       FROM supplier_price_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.supplier_product_id = $1
       ORDER BY h.changed_at DESC, h.id DESC LIMIT $3 OFFSET $4`,
      [offerId, offer.base_qty, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { offer, items: rows, total, page: q.page, pageSize: q.pageSize };
  });

  app.patch('/offers/:offerId', async (req) => {
    const auth = requirePermission(req, 'suppliers.manage');
    const { offerId } = z.object({ offerId: z.uuid() }).parse(req.params);
    const b = patchOfferSchema.parse(req.body);
    try {
      const offer = await tx(auth.userId, async (db) => {
        const cur = await lockOffer(db, offerId, b.version);
        if (cur.status === 'ended') throw new AppError(409, 'OFFER_ENDED', 'Oferta encerrada: reative antes de editar.');
        const before = await loadOffer(db, offerId);
        const sets: string[] = [];
        const vals: unknown[] = [offerId];
        const set = (col: string, v: unknown) => {
          vals.push(v);
          sets.push(`${col} = $${vals.length}`);
        };
        if (b.supplierSku !== undefined) set('supplier_sku', b.supplierSku);
        if (b.leadTimeDays !== undefined) set('lead_time_days', b.leadTimeDays);
        if (b.prepDays !== undefined) set('prep_days', b.prepDays);
        if (b.minOrderPacks !== undefined) set('min_order_packs', b.minOrderPacks);
        if (b.orderMultiplePacks !== undefined) set('order_multiple_packs', b.orderMultiplePacks);
        if (b.dropshipAllowed !== undefined) set('dropship_allowed', b.dropshipAllowed);
        if (b.status !== undefined) set('status', b.status);
        const costChanged = b.costCents !== undefined && b.costCents !== Number(before.cost_cents);
        if (costChanged) {
          set('cost_cents', b.costCents);
          set('quoted_at', b.quotedAt ?? new Date().toISOString().slice(0, 10));
          await setCostSource(db, 'manual', b.costReason);
        } else if (b.quotedAt) set('quoted_at', b.quotedAt);
        if (!sets.length) return before;
        await db.query(`UPDATE supplier_products SET ${sets.join(', ')} WHERE id = $1`, vals);
        const after = await loadOffer(db, offerId);
        await audit(db, {
          actorId: auth.userId,
          action: 'suppliers.offer_updated',
          entity: 'supplier_offer',
          entityId: offerId,
          before,
          after,
          metadata: { supplierId: cur.supplier_id, costChanged, costReason: b.costReason ?? null },
          ip: req.ip,
        });
        return after;
      });
      return { offer };
    } catch (err) {
      supplierError(err);
    }
  });

  app.post('/offers/:offerId/end', async (req) => {
    const auth = requirePermission(req, 'suppliers.manage');
    const { offerId } = z.object({ offerId: z.uuid() }).parse(req.params);
    const b = z.strictObject({ reason, version }).parse(req.body);
    const offer = await tx(auth.userId, async (db) => {
      const cur = await lockOffer(db, offerId, b.version);
      if (cur.status === 'ended') throw new AppError(409, 'OFFER_ENDED', 'A oferta já está encerrada.');
      const before = await loadOffer(db, offerId);
      await db.query(`UPDATE supplier_products SET status = 'ended', ended_at = now(), ended_by = $2, end_reason = $3 WHERE id = $1`, [offerId, auth.userId, b.reason]);
      const after = await loadOffer(db, offerId);
      await audit(db, { actorId: auth.userId, action: 'suppliers.offer_ended', entity: 'supplier_offer', entityId: offerId, before, after, metadata: { supplierId: cur.supplier_id, reason: b.reason }, ip: req.ip });
      return after;
    });
    return { offer };
  });

  /** Reativacao explicita de oferta encerrada (D2-7): exige motivo e fica na auditoria. */
  app.post('/offers/:offerId/reactivate', async (req) => {
    const auth = requirePermission(req, 'suppliers.manage');
    const { offerId } = z.object({ offerId: z.uuid() }).parse(req.params);
    const b = z.strictObject({ reason, version }).parse(req.body);
    const offer = await tx(auth.userId, async (db) => {
      const cur = await lockOffer(db, offerId, b.version);
      if (cur.status !== 'ended') throw new AppError(409, 'OFFER_NOT_ENDED', 'Só oferta encerrada é reativada; para pausada, edite a situação.');
      const before = await loadOffer(db, offerId);
      await db.query(`UPDATE supplier_products SET status = 'active' WHERE id = $1`, [offerId]);
      const after = await loadOffer(db, offerId);
      await audit(db, { actorId: auth.userId, action: 'suppliers.offer_reactivated', entity: 'supplier_offer', entityId: offerId, before, after, metadata: { supplierId: cur.supplier_id, reason: b.reason }, ip: req.ip });
      return after;
    });
    return { offer };
  });

  /** Fornecedor principal da variante: so por acao explicita (D2-9). Troca o anterior na mesma transacao. */
  app.post('/offers/:offerId/primary', async (req) => {
    const auth = requirePermission(req, 'suppliers.manage');
    const { offerId } = z.object({ offerId: z.uuid() }).parse(req.params);
    const b = z.strictObject({ primary: z.boolean().default(true), version }).parse(req.body);
    try {
      const result = await tx(auth.userId, async (db) => {
        const peek = (await db.query<{ variant_id: string }>('SELECT variant_id FROM supplier_products WHERE id = $1', [offerId])).rows[0];
        if (!peek) throw notFound();
        // Trava todas as ofertas da variante, sempre na mesma ordem: duas trocas simultaneas nao se cruzam.
        const all = (await db.query<{ id: string; is_primary: boolean; version: number; supplier_id: string }>('SELECT id, is_primary, version, supplier_id FROM supplier_products WHERE variant_id = $1 ORDER BY id FOR UPDATE', [peek.variant_id])).rows;
        const cur = all.find((o) => o.id === offerId)!;
        if (cur.version !== b.version) throw conflict(cur.version);
        const previous = all.find((o) => o.is_primary && o.id !== offerId) ?? null;
        if (b.primary) {
          if (previous) await db.query('UPDATE supplier_products SET is_primary = false WHERE id = $1', [previous.id]);
          await db.query('UPDATE supplier_products SET is_primary = true WHERE id = $1', [offerId]);
        } else {
          await db.query('UPDATE supplier_products SET is_primary = false WHERE id = $1', [offerId]);
        }
        const after = await loadOffer(db, offerId);
        await audit(db, {
          actorId: auth.userId,
          action: 'suppliers.primary_changed',
          entity: 'supplier_offer',
          entityId: offerId,
          before: { primaryOfferId: all.find((o) => o.is_primary)?.id ?? null },
          after: { primaryOfferId: b.primary ? offerId : null },
          metadata: { supplierId: cur.supplier_id, variantId: peek.variant_id, previousOfferId: previous?.id ?? null },
          ip: req.ip,
        });
        return { offer: after, previousOfferId: previous?.id ?? null };
      });
      return result;
    } catch (err) {
      supplierError(err);
    }
  });

  // ------------------------------------------------------------------ fornecedor
  app.get('/:id', async (req) => {
    requireAnyPermission(req, 'suppliers.view', 'purchases.view');
    const { id } = idParams.parse(req.params);
    const supplier = await load(pool, id);
    if (!supplier) throw notFound();
    supplier.alerts = (await pool.query(`SELECT ${ALERTS_SQL('s')} FROM suppliers s WHERE s.id = $1`, [id])).rows[0];
    supplier.indicators = (
      await pool.query(
        `WITH o AS (SELECT * FROM purchase_orders WHERE supplier_id = $1 AND status <> 'canceled'),
              first_receipt AS (SELECT r.order_id, min(r.received_at) AS at FROM purchase_receipts r JOIN o ON o.id = r.order_id GROUP BY 1)
         SELECT (SELECT coalesce(sum(round(i.packs * i.pack_cost_cents)), 0)::bigint FROM purchase_order_items i JOIN o ON o.id = i.order_id
                   WHERE o.status <> 'draft' AND o.created_at > now() - interval '90 days') AS purchased_90d_cents,
                (SELECT count(*)::int FROM o WHERE status <> 'draft') AS orders,
                (SELECT count(*)::int FROM purchase_receipts r JOIN o ON o.id = r.order_id) AS receipts,
                (SELECT round(avg(extract(epoch FROM f.at - o.sent_at) / 86400)::numeric, 1) FROM first_receipt f JOIN o ON o.id = f.order_id WHERE o.sent_at IS NOT NULL) AS avg_real_lead_days,
                (SELECT round(100.0 * count(*) FILTER (WHERE f.at::date <= o.expected_at) / nullif(count(*) FILTER (WHERE o.expected_at IS NOT NULL), 0), 0)
                   FROM first_receipt f JOIN o ON o.id = f.order_id) AS on_time_pct,
                (SELECT max(created_at) FROM o WHERE status <> 'draft') AS last_purchase_at,
                (SELECT max(at) FROM first_receipt) AS last_delivery_at,
                (SELECT round(avg(100.0 * (sp.cost_cents - h.new_cost_cents) / h.new_cost_cents), 1) FROM supplier_products sp
                   JOIN LATERAL (SELECT new_cost_cents FROM supplier_price_history x WHERE x.supplier_product_id = sp.id AND x.changed_at <= now() - interval '90 days'
                                 ORDER BY x.changed_at DESC, x.id DESC LIMIT 1) h ON true
                   WHERE sp.supplier_id = $1 AND sp.status = 'active') AS cost_change_90d_pct,
                (SELECT count(*)::int FROM supplier_products WHERE supplier_id = $1 AND is_primary) AS primary_items,
                (SELECT count(*)::int FROM supplier_offer_terms t WHERE t.supplier_id = $1 AND t.status = 'active' AND t.unit_cost_cents = (
                   SELECT min(t2.unit_cost_cents) FROM supplier_offer_terms t2 WHERE t2.variant_id = t.variant_id AND t2.status = 'active' AND t2.supplier_status = 'active')) AS cheapest_items`,
        [id],
      )
    ).rows[0];
    return { supplier };
  });

  app.post('/', async (req, reply) => {
    const auth = requirePermission(req, 'suppliers.manage');
    const b = createSchema.parse(req.body);
    try {
      const supplier = await tx(auth.userId, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO suppliers (${FIELD_COLS}, status) VALUES (${values(b)
            .map((_, i) => `$${i + 1}`)
            .join(', ')}, $${values(b).length + 1}) RETURNING id`,
          [...values(b), b.active ? 'active' : 'inactive'],
        );
        const id = rows[0]!.id;
        await saveContacts(db, id, b.contacts);
        const saved = await load(db, id);
        await audit(db, { actorId: auth.userId, action: 'suppliers.created', entity: 'supplier', entityId: id, after: saved, ip: req.ip });
        return saved;
      });
      return reply.code(201).send({ supplier });
    } catch (err) {
      supplierError(err);
    }
  });

  app.put('/:id', async (req) => {
    const auth = requirePermission(req, 'suppliers.manage');
    const { id } = idParams.parse(req.params);
    // Tela antiga (aberta antes da Fase 2) nao manda a versao: em vez de "dados invalidos", diz o que fazer. Nunca grava
    // sem versao (seria sobrescrever as cegas).
    const raw = req.body as Record<string, unknown> | null;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.version === undefined) {
      throw new AppError(428, 'VERSION_REQUIRED', 'Esta tela está desatualizada. Copie o que digitou, recarregue a página (F5) e salve de novo; nada foi gravado.');
    }
    const b = updateSchema.parse(req.body);
    try {
      const supplier = await tx(auth.userId, async (db) => {
        const cur = await lockSupplier(db, id, b.version);
        const before = await load(db, id);
        let status = cur.status;
        if (b.active !== undefined && b.active !== (cur.status === 'active')) {
          if (cur.archived_at || cur.status === 'blocked') throw new AppError(409, 'USE_STATUS_ROUTE', 'Fornecedor bloqueado ou arquivado: use desbloquear ou restaurar.');
          status = b.active ? 'active' : 'inactive';
        }
        const vals = values(b);
        await db.query(
          `UPDATE suppliers SET (${FIELD_COLS}, status) = (${vals.map((_, i) => `$${i + 2}`).join(', ')}, $${vals.length + 2}) WHERE id = $1`,
          [id, ...vals, status],
        );
        await saveContacts(db, id, b.contacts);
        const after = await load(db, id);
        await audit(db, { actorId: auth.userId, action: 'suppliers.updated', entity: 'supplier', entityId: id, before, after, ip: req.ip });
        return after;
      });
      return { supplier };
    } catch (err) {
      supplierError(err);
    }
  });

  /** Situacao: ativo, inativo ou bloqueado (bloquear exige motivo). Avisa pedidos abertos e variantes sem principal. */
  app.post('/:id/status', async (req) => {
    const auth = requirePermission(req, 'suppliers.manage');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ status: z.enum(['active', 'inactive', 'blocked']), reason: reason.optional(), version }).parse(req.body);
    if (b.status === 'blocked' && !b.reason) throw new AppError(422, 'REASON_REQUIRED', 'Informe o motivo do bloqueio.');
    const result = await tx(auth.userId, async (db) => {
      const cur = await lockSupplier(db, id, b.version);
      if (cur.archived_at) throw new AppError(409, 'SUPPLIER_ARCHIVED', 'Fornecedor arquivado: restaure antes de mudar a situação.');
      if (cur.status === b.status && b.status !== 'blocked') throw new AppError(409, 'SAME_STATUS', 'O fornecedor já está nesta situação.');
      const before = await load(db, id);
      const lostPrimary = b.status === 'active' ? [] : (await db.query('SELECT t.variant_id, t.sku, t.product_name FROM supplier_offer_terms t WHERE t.supplier_id = $1 AND t.is_primary ORDER BY t.sku', [id])).rows;
      await db.query(
        `UPDATE suppliers SET status = $2, blocked_reason = CASE WHEN $2 = 'blocked' THEN $3 END, blocked_at = CASE WHEN $2 = 'blocked' THEN now() END,
           blocked_by = CASE WHEN $2 = 'blocked' THEN $4::uuid END WHERE id = $1`,
        [id, b.status, b.reason ?? null, auth.userId],
      );
      const openOrders = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM purchase_orders WHERE supplier_id = $1 AND status IN ('draft', 'sent', 'partial')`, [id])).rows[0]!.n;
      const after = await load(db, id);
      await audit(db, {
        actorId: auth.userId,
        action: 'suppliers.status_changed',
        entity: 'supplier',
        entityId: id,
        before: { status: before.status, blocked_reason: before.blocked_reason },
        after: { status: after.status, blocked_reason: after.blocked_reason },
        metadata: { reason: b.reason ?? null, openOrders, variantsLostPrimary: lostPrimary.map((v: { variant_id: string }) => v.variant_id) },
        ip: req.ip,
      });
      return { supplier: after, openOrders, variantsLostPrimary: lostPrimary };
    });
    return result;
  });

  /** Exclusao logica: so inativo ou bloqueado, com motivo. Nada e apagado. */
  app.post('/:id/archive', async (req) => {
    const auth = requirePermission(req, 'suppliers.manage');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ reason, version }).parse(req.body);
    const supplier = await tx(auth.userId, async (db) => {
      const cur = await lockSupplier(db, id, b.version);
      if (cur.archived_at) throw new AppError(409, 'SUPPLIER_ARCHIVED', 'O fornecedor já está arquivado.');
      if (cur.status === 'active') throw new AppError(422, 'ARCHIVE_ACTIVE', 'Inative ou bloqueie o fornecedor antes de arquivar.');
      await db.query('UPDATE suppliers SET archived_at = now(), archived_by = $2, archive_reason = $3 WHERE id = $1', [id, auth.userId, b.reason]);
      const after = await load(db, id);
      await audit(db, { actorId: auth.userId, action: 'suppliers.archived', entity: 'supplier', entityId: id, after: { archived_at: after.archived_at, archive_reason: b.reason }, ip: req.ip });
      return after;
    });
    return { supplier };
  });

  app.post('/:id/restore', async (req) => {
    const auth = requirePermission(req, 'suppliers.manage');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ version }).parse(req.body);
    const supplier = await tx(auth.userId, async (db) => {
      const cur = await lockSupplier(db, id, b.version);
      if (!cur.archived_at) throw new AppError(409, 'SUPPLIER_NOT_ARCHIVED', 'O fornecedor não está arquivado.');
      // Volta como inativo (ou continua bloqueado): ativar e uma decisao separada.
      await db.query(`UPDATE suppliers SET archived_at = NULL, archived_by = NULL, archive_reason = NULL WHERE id = $1`, [id]);
      const after = await load(db, id);
      await audit(db, { actorId: auth.userId, action: 'suppliers.restored', entity: 'supplier', entityId: id, after: { status: after.status }, ip: req.ip });
      return after;
    });
    return { supplier };
  });

  app.get('/:id/offers', async (req) => {
    requireAnyPermission(req, 'suppliers.view', 'purchases.view');
    const { id } = idParams.parse(req.params);
    const q = z.object({ status: z.enum(['active', 'paused', 'ended', 'current', 'all']).default('current') }).parse(req.query);
    if (!(await pool.query('SELECT 1 FROM suppliers WHERE id = $1', [id])).rowCount) throw notFound();
    const cfg = await settings(pool);
    const { rows } = await pool.query(
      `SELECT ${OFFER_COLS},
              (t.quote_age_days > $3) AS stale_quote,
              (t.availability_valid_until IS NOT NULL AND NOT t.availability_expired AND t.availability_valid_until < now() + make_interval(days => $4)) AS availability_expiring
       FROM supplier_offer_terms t JOIN supplier_products sp ON sp.id = t.id
       WHERE t.supplier_id = $1 AND CASE $2::text WHEN 'all' THEN true WHEN 'current' THEN t.status <> 'ended' ELSE t.status = $2 END
       ORDER BY t.product_name, t.sku, t.base_qty, t.id`,
      [id, q.status, cfg.stale_quote_days, cfg.availability_warning_days],
    );
    return { items: rows, settings: cfg };
  });

  /** Uma oferta nova (a tela usa esta; a lista inteira continua em PUT /:id/offers). */
  app.post('/:id/offers/item', async (req, reply) => {
    const auth = requirePermission(req, 'suppliers.manage');
    const { id } = idParams.parse(req.params);
    const b = createOfferSchema.parse(req.body);
    try {
      const offer = await tx(auth.userId, async (db) => {
        const sup = await lockSupplier(db, id);
        if (sup.archived_at) throw new AppError(409, 'SUPPLIER_ARCHIVED', 'Fornecedor arquivado: restaure antes de incluir ofertas.');
        if (!(await db.query('SELECT 1 FROM packagings WHERE id = $1 AND active', [b.packagingId])).rowCount) {
          throw new AppError(422, 'INVALID_PACKAGING', 'Embalagem inexistente ou inativa.');
        }
        await setCostSource(db, 'manual', null);
        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO supplier_products (supplier_id, packaging_id, supplier_sku, cost_cents, lead_time_days, prep_days, min_order_packs, order_multiple_packs,
             dropship_allowed, quoted_at, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10::date, current_date), $11) RETURNING id`,
          [id, b.packagingId, b.supplierSku ?? null, b.costCents, b.leadTimeDays ?? null, b.prepDays ?? null, b.minOrderPacks ?? null, b.orderMultiplePacks ?? null, b.dropshipAllowed, b.quotedAt ?? null, b.status],
        );
        const after = await loadOffer(db, rows[0]!.id);
        await audit(db, { actorId: auth.userId, action: 'suppliers.offer_created', entity: 'supplier_offer', entityId: rows[0]!.id, after, metadata: { supplierId: id }, ip: req.ip });
        return after;
      });
      return reply.code(201).send({ offer });
    } catch (err) {
      supplierError(err);
    }
  });

  /**
   * Lista de precos (contrato antigo, mantido por compatibilidade; a tela usa as rotas por oferta). E SUBSTITUICAO
   * COMPLETA e explicita: a lista precisa trazer TODAS as ofertas atuais (ativas e pausadas) do fornecedor; para pausar,
   * a linha vem com `active: false`. Lista parcial (ou desatualizada: alguem incluiu oferta depois da leitura) recebe
   * 409 OFFERS_OMITTED e nada e gravado. Nenhuma oferta e pausada por omissao.
   * Encerrada: pode vir como estava (`active: false`, mesmo custo e codigo) e e ignorada, como o cliente antigo envia a
   * lista inteira; qualquer outra mudanca nela e 409 OFFER_ENDED (a reativacao e explicita, D2-7).
   * Toda mudanca de custo entra no historico com origem 'legacy_list'. `version` por linha e opcional; quando vem, e
   * conferida. Fornecedor e ofertas ficam travados (em ordem fixa) ate o fim da transacao.
   */
  app.put('/:id/offers', async (req, reply) => {
    const auth = requirePermission(req, 'suppliers.manage');
    const { id } = idParams.parse(req.params);
    const offers = z.array(legacyOfferSchema).max(500).parse(req.body);
    if (new Set(offers.map((o) => o.packagingId)).size !== offers.length) throw new AppError(409, 'DUPLICATE_OFFER', 'Embalagem repetida na lista do fornecedor.');
    reply.header('Deprecation', 'true');
    try {
      const supplier = await tx(auth.userId, async (db) => {
        const sup = await lockSupplier(db, id);
        if (sup.archived_at) throw new AppError(409, 'SUPPLIER_ARCHIVED', 'Fornecedor arquivado: restaure antes de alterar as ofertas.');
        const before = await load(db, id);
        const existing = new Map(
          (
            await db.query<{ packaging_id: string; status: string; version: number; cost_cents: string; supplier_sku: string | null; label: string; sku: string }>(
              `SELECT sp.packaging_id, sp.status, sp.version, sp.cost_cents, sp.supplier_sku, k.label, v.sku
               FROM supplier_products sp JOIN packagings k ON k.id = sp.packaging_id JOIN product_variants v ON v.id = sp.variant_id
               WHERE sp.supplier_id = $1 ORDER BY sp.id FOR UPDATE OF sp`,
              [id],
            )
          ).rows.map((r) => [r.packaging_id, r]),
        );
        const sent = new Set(offers.map((o) => o.packagingId));
        const omitted = [...existing.values()].filter((r) => r.status !== 'ended' && !sent.has(r.packaging_id));
        if (omitted.length) {
          throw new AppError(
            409,
            'OFFERS_OMITTED',
            'A lista substitui todas as ofertas do fornecedor e veio sem algumas delas (ou está desatualizada). Inclua todas, com active: false para pausar, ou use as rotas por oferta. Nada foi gravado.',
            { omitted: omitted.map((r) => ({ packagingId: r.packaging_id, sku: r.sku, label: r.label, status: r.status })) },
          );
        }
        const skipped = new Set<string>();
        for (const o of offers) {
          const cur = existing.get(o.packagingId);
          if (cur && o.version !== undefined && cur.version !== o.version) throw conflict(cur.version);
          if (cur?.status === 'ended') {
            const unchanged = !o.active && o.costCents === Number(cur.cost_cents) && (o.supplierSku ?? null) === cur.supplier_sku;
            if (!unchanged) throw new AppError(409, 'OFFER_ENDED', 'A lista altera ou reativa uma oferta encerrada: reative-a explicitamente antes.', { packagingId: o.packagingId });
            skipped.add(o.packagingId);
          }
        }
        const ids = offers.filter((o) => !skipped.has(o.packagingId)).map((o) => o.packagingId);
        // Embalagem nova precisa estar ativa; a ja ofertada pode ter sido desativada depois (a oferta continua valendo
        // para o historico, como antes, e a sugestao a ignora).
        const fresh = ids.filter((x) => !existing.has(x));
        const found = (await db.query<{ id: string }>('SELECT id FROM packagings WHERE id = ANY($1) AND active', [fresh])).rows.map((r) => r.id);
        const missing = fresh.filter((x) => !found.includes(x));
        if (missing.length) throw new AppError(422, 'INVALID_PACKAGING', 'Embalagem inexistente ou inativa na lista do fornecedor.', { missing });
        await setCostSource(db, 'legacy_list', null);
        for (const o of offers) {
          if (skipped.has(o.packagingId)) continue;
          await db.query(
            `INSERT INTO supplier_products (supplier_id, packaging_id, supplier_sku, cost_cents, lead_time_days, quoted_at, status)
             VALUES ($1, $2, $3, $4, $5, coalesce($6::date, current_date), $7)
             ON CONFLICT (supplier_id, packaging_id) DO UPDATE SET supplier_sku = EXCLUDED.supplier_sku, cost_cents = EXCLUDED.cost_cents,
               lead_time_days = EXCLUDED.lead_time_days, status = EXCLUDED.status,
               -- Data da cotacao: a informada; sem ela, hoje so quando o custo mudou (salvar a lista sem mexer no
               -- preco nao "renova" uma cotacao antiga).
               quoted_at = CASE WHEN $6::date IS NOT NULL THEN $6::date
                                WHEN supplier_products.cost_cents IS DISTINCT FROM EXCLUDED.cost_cents THEN current_date
                                ELSE supplier_products.quoted_at END`,
            [id, o.packagingId, o.supplierSku ?? null, o.costCents, o.leadTimeDays ?? null, o.quotedAt ?? null, o.active ? 'active' : 'paused'],
          );
        }
        const after = await load(db, id);
        await audit(db, {
          actorId: auth.userId,
          action: 'suppliers.offers_updated',
          entity: 'supplier',
          entityId: id,
          before: before.offers,
          after: after!.offers,
          metadata: { route: 'legacy_full_list', endedKept: [...skipped] },
          ip: req.ip,
        });
        return after;
      });
      return { supplier };
    } catch (err) {
      supplierError(err);
    }
  });

  // ------------------------------------------------------------------ disponibilidade (NAO e estoque da loja)
  app.get('/:id/availability', async (req) => {
    requirePermission(req, 'suppliers.view');
    const { id } = idParams.parse(req.params);
    const q = pageQuery.parse(req.query);
    if (!(await pool.query('SELECT 1 FROM suppliers WHERE id = $1', [id])).rowCount) throw notFound();
    const cfg = await settings(pool);
    const current = (
      await pool.query(
        `SELECT DISTINCT ON (a.variant_id) a.variant_id, v.sku, p.name AS product_name, p.base_unit, a.available_qty, a.confirmed_at, a.valid_until, a.source, a.note,
                (a.valid_until < now()) AS expired, (a.valid_until >= now() AND a.valid_until < now() + make_interval(days => $2)) AS expiring
         FROM supplier_availability a JOIN product_variants v ON v.id = a.variant_id JOIN products p ON p.id = v.product_id
         WHERE a.supplier_id = $1 ORDER BY a.variant_id, a.confirmed_at DESC, a.id DESC`,
        [id, cfg.availability_warning_days],
      )
    ).rows;
    const total = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM supplier_availability WHERE supplier_id = $1', [id])).rows[0]!.n;
    const history = (
      await pool.query(
        `SELECT a.id, a.variant_id, v.sku, a.available_qty, a.confirmed_at, a.valid_until, a.source, a.note, a.created_at, u.name AS created_by_name
         FROM supplier_availability a JOIN product_variants v ON v.id = a.variant_id LEFT JOIN users u ON u.id = a.created_by
         WHERE a.supplier_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT $2 OFFSET $3`,
        [id, q.pageSize, (q.page - 1) * q.pageSize],
      )
    ).rows;
    return { current, history, total, page: q.page, pageSize: q.pageSize };
  });

  app.post('/:id/availability', async (req, reply) => {
    const auth = requirePermission(req, 'suppliers.manage');
    const { id } = idParams.parse(req.params);
    const b = z
      .strictObject({
        variantId: z.uuid(),
        availableQty: z
          .union([z.string(), z.number()])
          .transform((v) => String(v).trim().replace(',', '.'))
          .pipe(z.string().regex(/^\d{1,11}(\.\d{1,3})?$/, 'Quantidade com até 3 casas decimais.')),
        confirmedAt: z.iso.datetime({ offset: true }).optional(),
        validUntil: z.iso.datetime({ offset: true }),
        source: z.enum(['manual', 'whatsapp', 'email', 'phone']).default('manual'),
        note: opt(z.string().trim().max(300)),
      })
      .parse(req.body);
    const confirmedAt = b.confirmedAt ? new Date(b.confirmedAt) : new Date();
    if (confirmedAt.getTime() > Date.now() + 5 * 60_000) throw new AppError(422, 'INVALID_DATE', 'A confirmação não pode estar no futuro.');
    if (new Date(b.validUntil).getTime() <= confirmedAt.getTime()) throw new AppError(422, 'INVALID_DATE', 'A validade precisa ser depois da confirmação.');
    const row = await tx(auth.userId, async (db) => {
      const sup = await lockSupplier(db, id);
      if (sup.archived_at) throw new AppError(409, 'SUPPLIER_ARCHIVED', 'Fornecedor arquivado.');
      if (!(await db.query('SELECT 1 FROM supplier_products WHERE supplier_id = $1 AND variant_id = $2', [id, b.variantId])).rowCount) {
        throw new AppError(422, 'NO_OFFER', 'Cadastre uma oferta deste fornecedor para a variante antes de informar a disponibilidade.');
      }
      const { rows } = await db.query(
        `INSERT INTO supplier_availability (supplier_id, variant_id, available_qty, confirmed_at, valid_until, source, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [id, b.variantId, b.availableQty, confirmedAt.toISOString(), b.validUntil, b.source, b.note ?? null, auth.userId],
      );
      await audit(db, { actorId: auth.userId, action: 'suppliers.availability_reported', entity: 'supplier', entityId: id, after: rows[0], ip: req.ip });
      return rows[0];
    });
    return reply.code(201).send({ availability: row });
  });

  // ------------------------------------------------------------------ linha do tempo
  app.get('/:id/history', async (req) => {
    requirePermission(req, 'suppliers.view');
    const { id } = idParams.parse(req.params);
    const q = pageQuery.parse(req.query);
    if (!(await pool.query('SELECT 1 FROM suppliers WHERE id = $1', [id])).rowCount) throw notFound();
    const union = `
      SELECT 'audit' AS kind, l.created_at AS at, l.action AS what, u.name AS actor, jsonb_build_object('entity', l.entity, 'entityId', l.entity_id, 'metadata', l.metadata) AS details
      FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_id
      WHERE (l.entity = 'supplier' AND l.entity_id = $1::uuid::text)
         OR (l.entity = 'supplier_offer' AND l.entity_id IN (SELECT id::text FROM supplier_products WHERE supplier_id = $1::uuid))
      UNION ALL
      SELECT 'cost', h.changed_at, h.source, u.name, jsonb_build_object('offerId', h.supplier_product_id, 'sku', v.sku, 'old', h.old_cost_cents, 'new', h.new_cost_cents, 'quotedAt', h.quoted_at, 'reason', h.reason)
      FROM supplier_price_history h JOIN product_variants v ON v.id = h.variant_id LEFT JOIN users u ON u.id = h.changed_by WHERE h.supplier_id = $1::uuid
      UNION ALL
      SELECT 'availability', a.created_at, a.source, u.name, jsonb_build_object('sku', v.sku, 'qty', a.available_qty, 'confirmedAt', a.confirmed_at, 'validUntil', a.valid_until, 'note', a.note)
      FROM supplier_availability a JOIN product_variants v ON v.id = a.variant_id LEFT JOIN users u ON u.id = a.created_by WHERE a.supplier_id = $1::uuid`;
    // Acoes que ja aparecem como linha de custo ou disponibilidade nao se repetem.
    const filtered = `SELECT * FROM (${union}) x WHERE NOT (kind = 'audit' AND what = 'suppliers.availability_reported')`;
    const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${filtered}) y`, [id])).rows[0]!.n;
    const { rows } = await pool.query(`${filtered} ORDER BY at DESC, kind LIMIT $2 OFFSET $3`, [id, q.pageSize, (q.page - 1) * q.pageSize]);
    return { items: rows, total, page: q.page, pageSize: q.pageSize };
  });
}
