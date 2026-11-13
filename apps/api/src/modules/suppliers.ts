import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { isValidCnpj, isValidCpf, UFS } from '../lib/br.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation, likePattern, pageQuery } from '../lib/http.js';
import { requirePermission } from './auth.js';

const digits = (v: string) => v.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
const phone = z.string().trim().transform((v) => v.replace(/\D/g, '')).pipe(z.string().regex(/^\d{10,13}$/, 'Telefone com DDD.'));
const opt = <T extends z.ZodType>(s: T) => s.nullable().optional();

const contactSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  role: opt(z.string().trim().max(60)),
  email: opt(z.email().max(254)),
  phone: opt(phone),
});

const supplierSchema = z.strictObject({
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
  whatsapp: opt(z.string().trim().transform((v) => v.replace(/\D/g, '')).pipe(z.string().regex(/^\d{12,13}$/, 'WhatsApp com DDI e DDD, ex.: 5547999990000.'))),
  website: opt(z.url().max(200)),
  city: opt(z.string().trim().max(60)),
  uf: opt(z.enum(UFS)),
  paymentTerms: opt(z.string().trim().max(200)),
  leadTimeDays: opt(z.number().int().min(0).max(180)),
  minOrderCents: opt(z.number().int().min(0).max(1_000_000_000)),
  freightTerms: opt(z.string().trim().max(200)),
  notes: opt(z.string().trim().max(2000)),
  active: z.boolean().default(true),
  contacts: z.array(contactSchema).max(10).default([]),
});
type SupplierInput = z.infer<typeof supplierSchema>;

const offerSchema = z.strictObject({
  packagingId: z.uuid(),
  supplierSku: opt(z.string().trim().max(60)),
  costCents: z.number().int().positive().max(1_000_000_000),
  leadTimeDays: opt(z.number().int().min(0).max(180)),
  quotedAt: opt(z.iso.date()),
  active: z.boolean().default(true),
});

const COLS = `id, name, legal_name, document, state_registration, email, phone, whatsapp, website, city, uf, payment_terms, lead_time_days,
  min_order_cents, freight_terms, notes, active, created_at, updated_at`;

const values = (s: SupplierInput) => [
  s.name,
  s.legalName ?? null,
  s.document ?? null,
  s.stateRegistration ?? null,
  s.email ?? null,
  s.phone ?? null,
  s.whatsapp ?? null,
  s.website ?? null,
  s.city ?? null,
  s.uf ?? null,
  s.paymentTerms ?? null,
  s.leadTimeDays ?? null,
  s.minOrderCents ?? null,
  s.freightTerms ?? null,
  s.notes ?? null,
  s.active,
];

function supplierError(err: unknown): never {
  if (isUniqueViolation(err, 'suppliers_document_unique')) throw new AppError(409, 'DOCUMENT_IN_USE', 'Já existe fornecedor com este CPF/CNPJ.');
  if (isUniqueViolation(err, 'supplier_products_supplier_id_packaging_id_key')) throw new AppError(409, 'DUPLICATE_OFFER', 'Embalagem repetida na lista do fornecedor.');
  throw err;
}

async function load(db: Db | typeof pool, id: string) {
  const s = (await db.query(`SELECT ${COLS} FROM suppliers WHERE id = $1`, [id])).rows[0];
  if (!s) return null;
  s.contacts = (await db.query('SELECT id, name, role, email, phone FROM supplier_contacts WHERE supplier_id = $1 ORDER BY name', [id])).rows;
  // Oferta convertida para a unidade base: e assim que fornecedores diferentes ficam comparaveis.
  s.offers = (
    await db.query(
      `SELECT sp.id, sp.packaging_id, sp.supplier_sku, sp.cost_cents, sp.lead_time_days, sp.quoted_at, sp.active,
              k.label AS packaging_label, k.base_qty, v.id AS variant_id, v.sku, p.name AS product_name, p.base_unit,
              round(sp.cost_cents / k.base_qty, 4) AS unit_cost_cents
       FROM supplier_products sp JOIN packagings k ON k.id = sp.packaging_id JOIN product_variants v ON v.id = k.variant_id JOIN products p ON p.id = v.product_id
       WHERE sp.supplier_id = $1 ORDER BY p.name, v.sku, k.base_qty`,
      [id],
    )
  ).rows;
  return s;
}

async function saveContacts(db: Db, supplierId: string, contacts: SupplierInput['contacts']) {
  await db.query('DELETE FROM supplier_contacts WHERE supplier_id = $1', [supplierId]);
  for (const c of contacts) {
    await db.query('INSERT INTO supplier_contacts (supplier_id, name, role, email, phone) VALUES ($1, $2, $3, $4, $5)', [supplierId, c.name, c.role ?? null, c.email ?? null, c.phone ?? null]);
  }
}

export async function supplierRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    requirePermission(req, 'purchases.view');
    const q = pageQuery.extend({ q: z.string().trim().max(100).optional(), active: z.enum(['true', 'false', 'all']).default('true') }).parse(req.query);
    const params: unknown[] = [q.q ? likePattern(q.q) : null, q.active === 'all' ? null : q.active === 'true'];
    const where = `($1::text IS NULL OR name ILIKE $1 OR legal_name ILIKE $1 OR document ILIKE $1) AND ($2::boolean IS NULL OR active = $2)`;
    const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM suppliers WHERE ${where}`, params)).rows[0]!.n;
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.document, s.city, s.uf, s.lead_time_days, s.active, s.whatsapp, s.phone,
              (SELECT count(*)::int FROM supplier_products sp WHERE sp.supplier_id = s.id AND sp.active) AS offer_count,
              (SELECT max(r.received_at) FROM purchase_receipts r JOIN purchase_orders o ON o.id = r.order_id WHERE o.supplier_id = s.id) AS last_receipt_at
       FROM suppliers s WHERE ${where} ORDER BY s.name LIMIT $3 OFFSET $4`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { items: rows, total, page: q.page, pageSize: q.pageSize };
  });

  app.get('/:id', async (req) => {
    requirePermission(req, 'purchases.view');
    const { id } = idParams.parse(req.params);
    const supplier = await load(pool, id);
    if (!supplier) throw notFound();
    return { supplier };
  });

  app.post('/', async (req, reply) => {
    const auth = requirePermission(req, 'purchases.manage');
    const b = supplierSchema.parse(req.body);
    try {
      const supplier = await tx(auth.userId, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO suppliers (name, legal_name, document, state_registration, email, phone, whatsapp, website, city, uf, payment_terms, lead_time_days,
             min_order_cents, freight_terms, notes, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
          values(b),
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
    const auth = requirePermission(req, 'purchases.manage');
    const { id } = idParams.parse(req.params);
    const b = supplierSchema.parse(req.body);
    try {
      const supplier = await tx(auth.userId, async (db) => {
        const before = await load(db, id);
        if (!before) throw notFound();
        await db.query(
          `UPDATE suppliers SET name = $2, legal_name = $3, document = $4, state_registration = $5, email = $6, phone = $7, whatsapp = $8, website = $9,
             city = $10, uf = $11, payment_terms = $12, lead_time_days = $13, min_order_cents = $14, freight_terms = $15, notes = $16, active = $17, updated_at = now()
           WHERE id = $1`,
          [id, ...values(b)],
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

  /** Lista de precos do fornecedor. Substitui a lista inteira; embalagem fora do envio fica inativa. */
  app.put('/:id/offers', async (req) => {
    const auth = requirePermission(req, 'purchases.manage');
    const { id } = idParams.parse(req.params);
    const offers = z.array(offerSchema).max(500).parse(req.body);
    try {
      const supplier = await tx(auth.userId, async (db) => {
        const before = await load(db, id);
        if (!before) throw notFound();
        const ids = offers.map((o) => o.packagingId);
        const found = (await db.query<{ id: string }>('SELECT id FROM packagings WHERE id = ANY($1) AND active', [ids])).rows.map((r) => r.id);
        const missing = ids.filter((x) => !found.includes(x));
        if (missing.length) throw new AppError(422, 'INVALID_PACKAGING', 'Embalagem inexistente ou inativa na lista do fornecedor.', { missing });
        await db.query('UPDATE supplier_products SET active = false, updated_at = now() WHERE supplier_id = $1 AND NOT (packaging_id = ANY($2))', [id, ids]);
        for (const o of offers) {
          await db.query(
            `INSERT INTO supplier_products (supplier_id, packaging_id, supplier_sku, cost_cents, lead_time_days, quoted_at, active)
             VALUES ($1, $2, $3, $4, $5, coalesce($6::date, current_date), $7)
             ON CONFLICT (supplier_id, packaging_id) DO UPDATE SET supplier_sku = EXCLUDED.supplier_sku, cost_cents = EXCLUDED.cost_cents,
               lead_time_days = EXCLUDED.lead_time_days, quoted_at = EXCLUDED.quoted_at, active = EXCLUDED.active, updated_at = now()`,
            [id, o.packagingId, o.supplierSku ?? null, o.costCents, o.leadTimeDays ?? null, o.quotedAt ?? null, o.active],
          );
        }
        const after = await load(db, id);
        await audit(db, { actorId: auth.userId, action: 'suppliers.offers_updated', entity: 'supplier', entityId: id, before: before.offers, after: after!.offers, ip: req.ip });
        return after;
      });
      return { supplier };
    } catch (err) {
      supplierError(err);
    }
  });
}
