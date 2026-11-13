import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { isValidGtin, slugify } from '../lib/br.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation, likePattern, orderBy, pageQuery, sortParam } from '../lib/http.js';
import { requirePermission, type Auth } from './auth.js';

// Quantidade na unidade base: ate 3 casas decimais, enviada como texto para nao passar por float.
const qty = z.string().trim().regex(/^\d{1,11}(\.\d{1,3})?$/, 'Quantidade inválida.').refine((v) => Number(v) > 0, 'A quantidade deve ser maior que zero.');
const gtin = z.string().trim().refine(isValidGtin, 'Código de barras inválido (GTIN-8, 12, 13 ou 14 com dígito verificador).');

const packagingSchema = z.strictObject({
  id: z.uuid().optional(),
  kind: z.enum(['sale', 'purchase']),
  label: z.string().trim().min(1).max(60),
  unitCode: z.string().regex(/^[A-Z0-9]{1,6}$/),
  baseQty: qty,
  priceCents: z.number().int().positive().max(100_000_000).nullable().optional(),
  barcode: gtin.nullable().optional(),
  isDefault: z.boolean().optional(),
  // Preco por embalagem a partir de N embalagens (venda em quantidade).
  tiers: z.array(z.strictObject({ minPacks: z.number().int().min(2).max(100_000), priceCents: z.number().int().positive().max(100_000_000) })).max(6).default([]),
});

const variantSchema = z.strictObject({
  id: z.uuid().optional(),
  sku: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/, 'SKU: 2 a 40 caracteres, letras, números, ponto, hífen ou sublinhado.'),
  barcode: gtin.nullable().optional(),
  attributes: z.record(z.string().trim().min(1).max(30), z.string().trim().min(1).max(60)).refine((a) => Object.keys(a).length <= 5, 'No máximo 5 atributos.').default({}),
  weightG: z.number().int().positive().max(1_000_000).nullable().optional(),
  lengthMm: z.number().int().positive().max(10_000).nullable().optional(),
  widthMm: z.number().int().positive().max(10_000).nullable().optional(),
  heightMm: z.number().int().positive().max(10_000).nullable().optional(),
  packagings: z.array(packagingSchema).min(1).max(12),
});

const productSchema = z.strictObject({
  name: z.string().trim().min(2).max(150),
  slug: z.string().trim().max(160).optional(),
  categoryId: z.uuid().nullable().optional(),
  summary: z.string().trim().max(300).nullable().optional(),
  description: z.string().trim().max(10000).nullable().optional(),
  brand: z.string().trim().max(80).nullable().optional(),
  status: z.enum(['draft', 'active', 'inactive']).default('draft'),
  baseUnit: z.string().regex(/^[A-Z0-9]{1,6}$/),
  turnover: z.enum(['high', 'medium', 'low']).nullable().optional(),
  availabilityMode: z.enum(['stock', 'made_to_order']).default('stock'),
  leadTimeDays: z.number().int().min(1).max(180).nullable().optional(),
  minStock: z.string().regex(/^\d{1,11}(\.\d{1,3})?$/).default('0'),
  specs: z.array(z.strictObject({ label: z.string().trim().min(1).max(60), value: z.string().trim().min(1).max(200) })).max(40).default([]),
  variants: z.array(variantSchema).min(1).max(100),
});
type ProductInput = z.infer<typeof productSchema>;

const hasFraction = (v: string) => /\.\d*[1-9]/.test(v);

/** Regras que o schema sozinho nao cobre: unidades, embalagem padrao, duplicidades dentro do envio. */
async function checkRules(db: Db, p: ProductInput) {
  const units = new Map((await db.query<{ code: string; allows_fraction: boolean }>('SELECT code, allows_fraction FROM units')).rows.map((u) => [u.code, u.allows_fraction]));
  if (!units.has(p.baseUnit)) throw new AppError(422, 'INVALID_UNIT', 'Unidade base inexistente.');
  const fractional = units.get(p.baseUnit)!;
  if (!fractional && hasFraction(p.minStock)) throw new AppError(422, 'FRACTION_NOT_ALLOWED', `A unidade ${p.baseUnit} não aceita quantidade fracionada.`);
  if (p.availabilityMode === 'stock' && p.leadTimeDays) throw new AppError(422, 'LEAD_TIME_STOCK', 'Prazo de encomenda só vale para produto sob encomenda.');

  const skus = new Set<string>();
  const barcodes = new Set<string>();
  for (const v of p.variants) {
    const sku = v.sku.toLowerCase();
    if (skus.has(sku)) throw new AppError(422, 'DUPLICATE_SKU', `SKU repetido: ${v.sku}.`);
    skus.add(sku);
    const sale = v.packagings.filter((k) => k.kind === 'sale');
    if (!sale.length) throw new AppError(422, 'NO_SALE_PACKAGING', `A variação ${v.sku} precisa de ao menos uma embalagem de venda com preço.`);
    for (const kind of ['sale', 'purchase'] as const) {
      const list = v.packagings.filter((k) => k.kind === kind);
      if (list.filter((k) => k.isDefault).length > 1) throw new AppError(422, 'MANY_DEFAULTS', `A variação ${v.sku} tem mais de uma embalagem padrão de ${kind === 'sale' ? 'venda' : 'compra'}.`);
      const qtys = new Set<number>();
      for (const k of list) {
        if (qtys.has(Number(k.baseQty))) throw new AppError(422, 'DUPLICATE_PACKAGING', `A variação ${v.sku} tem duas embalagens de ${kind === 'sale' ? 'venda' : 'compra'} com a mesma quantidade.`);
        qtys.add(Number(k.baseQty));
      }
    }
    for (const k of v.packagings) {
      if (!units.has(k.unitCode)) throw new AppError(422, 'INVALID_UNIT', `Unidade inexistente: ${k.unitCode}.`);
      if (!fractional && hasFraction(k.baseQty)) throw new AppError(422, 'FRACTION_NOT_ALLOWED', `A unidade base ${p.baseUnit} não aceita fração: "${k.label}" precisa conter um número inteiro de unidades.`);
      if (k.kind === 'sale' && !k.priceCents) throw new AppError(422, 'PRICE_REQUIRED', `Informe o preço de "${k.label}" (${v.sku}).`);
      if (k.kind === 'purchase' && k.priceCents) throw new AppError(422, 'PURCHASE_PRICE', 'Embalagem de compra não tem preço de venda; o custo é registrado por fornecedor.');
      if (k.kind === 'purchase' && k.tiers.length) throw new AppError(422, 'PURCHASE_TIERS', 'Faixa de quantidade só vale para embalagem de venda.');
      // Faixas em ordem de quantidade, cada uma mais barata que a anterior e que o preço cheio.
      let last = { min: 1, price: k.priceCents ?? 0 };
      for (const t of [...k.tiers].sort((a, b) => a.minPacks - b.minPacks)) {
        if (t.minPacks === last.min) throw new AppError(422, 'DUPLICATE_TIER', `"${k.label}": duas faixas com a mesma quantidade.`);
        if (t.priceCents >= last.price) throw new AppError(422, 'TIER_NOT_DECREASING', `"${k.label}": o preço da faixa a partir de ${t.minPacks} precisa ser menor que o da faixa anterior.`);
        last = { min: t.minPacks, price: t.priceCents };
      }
    }
    for (const code of [v.barcode, ...v.packagings.map((k) => k.barcode)]) {
      if (!code) continue;
      if (barcodes.has(code)) throw new AppError(422, 'DUPLICATE_BARCODE', `Código de barras repetido: ${code}.`);
      barcodes.add(code);
    }
  }
}

function productError(err: unknown): never {
  if (isUniqueViolation(err, 'products_slug_key')) throw new AppError(409, 'SLUG_IN_USE', 'Já existe um produto com este endereço (slug).');
  if (isUniqueViolation(err, 'product_variants_sku_key')) throw new AppError(409, 'SKU_IN_USE', 'Este SKU já está em uso em outro produto.');
  if (isUniqueViolation(err, 'product_variants_barcode_key') || isUniqueViolation(err, 'packagings_barcode_key')) throw new AppError(409, 'BARCODE_IN_USE', 'Este código de barras já está em uso.');
  if ((err as { code?: string }).code === '23503') throw new AppError(422, 'INVALID_REFERENCE', 'Categoria ou unidade inexistente.');
  throw err;
}

/** Grava variacoes e embalagens. Removidas do envio sao desativadas, nunca apagadas: pedidos e estoque apontam para elas. */
async function saveVariants(db: Db, auth: Auth, productId: string, variants: ProductInput['variants']) {
  const current = (await db.query<{ id: string }>('SELECT id FROM product_variants WHERE product_id = $1', [productId])).rows.map((r) => r.id);
  const currentPack = (
    await db.query<{ id: string; variant_id: string; price_cents: string | null }>(
      'SELECT k.id, k.variant_id, k.price_cents FROM packagings k JOIN product_variants v ON v.id = k.variant_id WHERE v.product_id = $1',
      [productId],
    )
  ).rows;
  const keptVariants = new Set<string>();
  const keptPack = new Set<string>();
  const canPrice = auth.permissions.has('prices.manage') && auth.mfaEnabled;

  // Desativa antes para liberar os indices unicos de quantidade e padrao.
  await db.query('UPDATE packagings SET active = false, is_default = false WHERE variant_id = ANY($1)', [current]);

  for (const [vi, v] of variants.entries()) {
    if (v.id && !current.includes(v.id)) throw new AppError(422, 'INVALID_VARIANT', 'Variação não pertence a este produto.');
    const values = [v.sku, v.barcode ?? null, v.attributes, vi, v.weightG ?? null, v.lengthMm ?? null, v.widthMm ?? null, v.heightMm ?? null];
    const variantId = v.id
      ? (await db.query(`UPDATE product_variants SET sku = $2, barcode = $3, attributes = $4, position = $5, weight_g = $6, length_mm = $7, width_mm = $8, height_mm = $9, active = true, updated_at = now() WHERE id = $1 RETURNING id`, [v.id, ...values])).rows[0].id
      : (await db.query(`INSERT INTO product_variants (product_id, sku, barcode, attributes, position, weight_g, length_mm, width_mm, height_mm) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`, [productId, ...values])).rows[0].id;
    keptVariants.add(variantId);

    for (const kind of ['sale', 'purchase'] as const) {
      const list = v.packagings.filter((k) => k.kind === kind);
      const defaultIndex = Math.max(0, list.findIndex((k) => k.isDefault));
      for (const [ki, k] of list.entries()) {
        const old = k.id ? currentPack.find((p) => p.id === k.id && p.variant_id === variantId) : undefined;
        if (k.id && !old) throw new AppError(422, 'INVALID_PACKAGING', 'Embalagem não pertence a esta variação.');
        const price = k.kind === 'sale' ? String(k.priceCents) : null;
        // Mudanca de preco exige permissao propria; o cadastro inicial do preco acompanha o do produto.
        if (old && old.price_cents !== price && !canPrice) throw new AppError(403, 'PRICE_FORBIDDEN', 'Alterar preço exige a permissão de preços e a verificação em duas etapas.');
        const vals = [k.label, k.unitCode, k.baseQty, price, k.barcode ?? null, ki === defaultIndex, ki];
        const id = old
          ? (await db.query(`UPDATE packagings SET label = $2, unit_code = $3, base_qty = $4, price_cents = $5, barcode = $6, is_default = $7, position = $8, active = true, updated_at = now() WHERE id = $1 RETURNING id`, [old.id, ...vals])).rows[0].id
          : (await db.query(`INSERT INTO packagings (variant_id, kind, label, unit_code, base_qty, price_cents, barcode, is_default, position) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`, [variantId, kind, ...vals])).rows[0].id;
        keptPack.add(id);
        const oldTiers = (await db.query<{ min_packs: number; price_cents: string }>('SELECT min_packs, price_cents FROM price_tiers WHERE packaging_id = $1 ORDER BY min_packs', [id])).rows;
        const sig = (t: { m: number; p: string }[]) => t.map((x) => `${x.m}:${x.p}`).join(',');
        const newTiers = [...k.tiers].sort((a, b) => a.minPacks - b.minPacks);
        if (sig(oldTiers.map((t) => ({ m: t.min_packs, p: String(t.price_cents) }))) !== sig(newTiers.map((t) => ({ m: t.minPacks, p: String(t.priceCents) })))) {
          if ((old || oldTiers.length) && !canPrice) throw new AppError(403, 'PRICE_FORBIDDEN', 'Alterar preço exige a permissão de preços e a verificação em duas etapas.');
          await db.query('DELETE FROM price_tiers WHERE packaging_id = $1', [id]);
          for (const t of newTiers) await db.query('INSERT INTO price_tiers (packaging_id, min_packs, price_cents) VALUES ($1, $2, $3)', [id, t.minPacks, t.priceCents]);
        }
      }
    }
  }
  const dropped = current.filter((id) => !keptVariants.has(id));
  if (dropped.length) await db.query('UPDATE product_variants SET active = false, updated_at = now() WHERE id = ANY($1)', [dropped]);
}

export async function loadProduct(db: Db | typeof pool, id: string) {
  const { rows } = await db.query(
    `SELECT p.id, p.category_id, p.name, p.slug, p.summary, p.description, p.brand, p.status, p.base_unit, p.turnover, p.availability_mode,
            p.lead_time_days, p.min_stock, p.specs, p.version, p.created_at, p.updated_at
     FROM products p WHERE p.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound();
  const variants = (
    await db.query(
      `SELECT id, sku, barcode, attributes, active, position, weight_g, length_mm, width_mm, height_mm FROM product_variants WHERE product_id = $1 ORDER BY active DESC, position`,
      [id],
    )
  ).rows;
  const packagings = (
    await db.query(
      `SELECT k.id, k.variant_id, k.kind, k.label, k.unit_code, k.base_qty, k.price_cents, k.barcode, k.is_default, k.position,
              coalesce((SELECT json_agg(json_build_object('minPacks', t.min_packs, 'priceCents', t.price_cents) ORDER BY t.min_packs) FROM price_tiers t WHERE t.packaging_id = k.id), '[]') AS tiers
       FROM packagings k JOIN product_variants v ON v.id = k.variant_id WHERE v.product_id = $1 AND k.active ORDER BY k.kind DESC, k.position`,
      [id],
    )
  ).rows;
  const images = (await db.query('SELECT id, variant_id, file_key, width, height, alt, position, is_primary FROM product_images WHERE product_id = $1 ORDER BY is_primary DESC, position', [id])).rows;
  const fiscal = (await db.query('SELECT ncm, cest, origin, tax_unit, tax_unit_qty, notes, status, informed_at, validator_name, validated_at FROM product_fiscal WHERE product_id = $1', [id])).rows[0] ?? null;
  return {
    ...rows[0],
    variants: variants.map((v) => ({ ...v, packagings: packagings.filter((k) => k.variant_id === v.id) })),
    images,
    fiscal,
  };
}

export async function productRoutes(app: FastifyInstance) {
  app.get('/units', async (req) => {
    requirePermission(req, 'catalog.view');
    return { units: (await pool.query('SELECT code, name, allows_fraction FROM units ORDER BY name')).rows };
  });

  // Busca por nome, resumo, marca, SKU ou codigo de barras, sem acento.
  app.get('/', async (req) => {
    requirePermission(req, 'catalog.view');
    const q = pageQuery
      .extend({
        q: z.string().trim().max(100).optional(),
        categoryId: z.uuid().optional(),
        status: z.enum(['draft', 'active', 'inactive']).optional(),
        fiscal: z.enum(['pending', 'informed', 'validated']).optional(),
        sort: sortParam,
      })
      .parse(req.query);
    const sort = orderBy(q.sort, { name: 'p.name', updated: 'p.updated_at', price: 'price_cents' }, 'p.updated_at DESC');
    const term = q.q ? likePattern(q.q.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()) : null;
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.slug, p.status, p.base_unit, p.availability_mode, p.updated_at, c.name AS category_name,
              coalesce(f.status, 'pending') AS fiscal_status,
              (SELECT count(*)::int FROM product_variants v WHERE v.product_id = p.id AND v.active) AS variant_count,
              (SELECT v.sku FROM product_variants v WHERE v.product_id = p.id AND v.active ORDER BY v.position LIMIT 1) AS sku,
              (SELECT min(k.price_cents / k.base_qty) FROM packagings k JOIN product_variants v ON v.id = k.variant_id
                WHERE v.product_id = p.id AND v.active AND k.active AND k.kind = 'sale')::bigint AS unit_price_cents,
              (SELECT k.price_cents FROM packagings k JOIN product_variants v ON v.id = k.variant_id
                WHERE v.product_id = p.id AND v.active AND k.active AND k.kind = 'sale' AND k.is_default ORDER BY v.position LIMIT 1) AS price_cents,
              (SELECT i.file_key FROM product_images i WHERE i.product_id = p.id ORDER BY i.is_primary DESC, i.position LIMIT 1) AS image_key,
              count(*) OVER () AS total
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN product_fiscal f ON f.product_id = p.id
       WHERE ($1::text IS NULL OR p.search_doc LIKE $1 OR EXISTS (
               SELECT 1 FROM product_variants v LEFT JOIN packagings k ON k.variant_id = v.id
               WHERE v.product_id = p.id AND (lower(v.sku) LIKE $1 OR v.barcode = $6 OR k.barcode = $6)))
         AND ($2::uuid IS NULL OR p.category_id = $2)
         AND ($3::text IS NULL OR p.status = $3)
         AND ($7::text IS NULL OR coalesce(f.status, 'pending') = $7)
       ORDER BY ${sort} LIMIT $4 OFFSET $5`,
      [term, q.categoryId ?? null, q.status ?? null, q.pageSize, (q.page - 1) * q.pageSize, q.q ?? null, q.fiscal ?? null],
    );
    return { products: rows.map(({ total: _t, ...r }) => r), total: Number(rows[0]?.total ?? 0), page: q.page, pageSize: q.pageSize };
  });

  app.get('/:id', async (req) => {
    requirePermission(req, 'catalog.view');
    const { id } = idParams.parse(req.params);
    const product = await loadProduct(pool, id);
    const history = (
      await pool.query(
        `SELECT h.packaging_id, h.old_price_cents, h.new_price_cents, h.changed_at, u.name AS changed_by
         FROM price_history h JOIN packagings k ON k.id = h.packaging_id JOIN product_variants v ON v.id = k.variant_id LEFT JOIN users u ON u.id = h.changed_by
         WHERE v.product_id = $1 ORDER BY h.changed_at DESC LIMIT 50`,
        [id],
      )
    ).rows;
    return { product, priceHistory: history };
  });

  app.post('/', async (req, reply) => {
    const auth = requirePermission(req, 'catalog.manage');
    const p = productSchema.parse(req.body);
    const slug = slugify(p.slug || p.name);
    try {
      const product = await tx(auth.userId, async (db) => {
        await checkRules(db, p);
        const { rows } = await db.query(
          `INSERT INTO products (name, slug, category_id, summary, description, brand, status, base_unit, turnover, availability_mode, lead_time_days, min_stock, specs)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
          [p.name, slug, p.categoryId ?? null, p.summary ?? null, p.description ?? null, p.brand ?? null, p.status, p.baseUnit, p.turnover ?? null, p.availabilityMode, p.leadTimeDays ?? null, p.minStock, JSON.stringify(p.specs)],
        );
        const id = rows[0].id as string;
        await saveVariants(db, auth, id, p.variants);
        await db.query(`INSERT INTO product_fiscal (product_id) VALUES ($1)`, [id]);
        const saved = await loadProduct(db, id);
        await audit(db, { actorId: auth.userId, action: 'products.created', entity: 'product', entityId: id, after: saved, ip: req.ip });
        return saved;
      });
      return reply.code(201).send({ product });
    } catch (err) {
      productError(err);
    }
  });

  // Substitui o cadastro inteiro. `version` evita que duas pessoas sobrescrevam uma a outra.
  app.put('/:id', async (req) => {
    const auth = requirePermission(req, 'catalog.manage');
    const { id } = idParams.parse(req.params);
    const { version, ...rest } = productSchema.extend({ version: z.number().int().positive() }).parse(req.body);
    const p = rest as ProductInput;
    try {
      return await tx(auth.userId, async (db) => {
        const lock = await db.query<{ version: number }>('SELECT version FROM products WHERE id = $1 FOR UPDATE', [id]);
        if (!lock.rows[0]) throw notFound();
        if (lock.rows[0].version !== version) throw new AppError(409, 'STALE_VERSION', 'Este produto foi alterado por outra pessoa. Recarregue a página para ver a versão atual.');
        await checkRules(db, p);
        const before = await loadProduct(db, id);
        const slug = p.slug ? slugify(p.slug) : before.slug;
        await db.query(
          `UPDATE products SET name = $2, slug = $3, category_id = $4, summary = $5, description = $6, brand = $7, status = $8, base_unit = $9, turnover = $10,
             availability_mode = $11, lead_time_days = $12, min_stock = $13, specs = $14, version = version + 1, updated_at = now() WHERE id = $1`,
          [id, p.name, slug, p.categoryId ?? null, p.summary ?? null, p.description ?? null, p.brand ?? null, p.status, p.baseUnit, p.turnover ?? null, p.availabilityMode, p.leadTimeDays ?? null, p.minStock, JSON.stringify(p.specs)],
        );
        // A unidade base define o estoque inteiro: so muda enquanto nada foi movimentado (Fase 3 reforca com o saldo).
        if (before.base_unit !== p.baseUnit && before.status !== 'draft') throw new AppError(409, 'BASE_UNIT_LOCKED', 'A unidade base só pode mudar enquanto o produto é rascunho.');
        await saveVariants(db, auth, id, p.variants);
        const saved = await loadProduct(db, id);
        await audit(db, { actorId: auth.userId, action: 'products.updated', entity: 'product', entityId: id, before, after: saved, ip: req.ip });
        return { product: saved };
      });
    } catch (err) {
      productError(err);
    }
  });

  // Classificacao fiscal: quem informa e quem valida sao registrados. A validacao cai se algo mudar.
  const fiscalSchema = z.strictObject({
    ncm: z.string().regex(/^\d{8}$/, 'NCM tem 8 dígitos.').nullable(),
    cest: z.string().regex(/^\d{7}$/, 'CEST tem 7 dígitos.').nullable().optional(),
    origin: z.number().int().min(0).max(8).nullable(),
    taxUnit: z.string().regex(/^[A-Z0-9]{1,6}$/).nullable().optional(),
    taxUnitQty: z.string().regex(/^\d{1,10}(\.\d{1,4})?$/).refine((v) => Number(v) > 0).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  });

  app.put('/:id/fiscal', async (req) => {
    const auth = requirePermission(req, 'fiscal.manage');
    const { id } = idParams.parse(req.params);
    const f = fiscalSchema.parse(req.body);
    return tx(auth.userId, async (db) => {
      const before = (await db.query('SELECT * FROM product_fiscal WHERE product_id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw notFound();
      const { rows } = await db.query(
        `UPDATE product_fiscal SET ncm = $2, cest = $3, origin = $4, tax_unit = $5, tax_unit_qty = $6, notes = $7,
           status = CASE WHEN $2::text IS NULL THEN 'pending' WHEN status = 'validated' THEN status ELSE 'informed' END,
           informed_by = $8, informed_at = now()
         WHERE product_id = $1 RETURNING ncm, cest, origin, tax_unit, tax_unit_qty, notes, status, informed_at, validator_name, validated_at`,
        [id, f.ncm, f.cest ?? null, f.origin, f.taxUnit ?? null, f.taxUnitQty ?? null, f.notes ?? null, auth.userId],
      );
      await audit(db, { actorId: auth.userId, action: 'fiscal.product_informed', entity: 'product', entityId: id, before, after: rows[0], ip: req.ip });
      return { fiscal: rows[0] };
    });
  });

  app.post('/:id/fiscal/validate', async (req) => {
    const auth = requirePermission(req, 'fiscal.validate');
    const { id } = idParams.parse(req.params);
    const { validatorName } = z.strictObject({ validatorName: z.string().trim().min(3).max(120) }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const before = (await db.query('SELECT * FROM product_fiscal WHERE product_id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw notFound();
      if (!before.ncm || before.origin === null) throw new AppError(422, 'FISCAL_INCOMPLETE', 'Informe ao menos NCM e origem antes de validar.');
      const { rows } = await db.query(
        `UPDATE product_fiscal SET status = 'validated', validated_by = $2, validator_name = $3, validated_at = now()
         WHERE product_id = $1 RETURNING ncm, cest, origin, tax_unit, tax_unit_qty, notes, status, informed_at, validator_name, validated_at`,
        [id, auth.userId, validatorName],
      );
      await audit(db, { actorId: auth.userId, action: 'fiscal.product_validated', entity: 'product', entityId: id, before, after: rows[0], ip: req.ip });
      return { fiscal: rows[0] };
    });
  });

  app.get('/:id/fiscal/history', async (req) => {
    requirePermission(req, 'fiscal.view');
    const { id } = idParams.parse(req.params);
    const { rows } = await pool.query(
      `SELECT h.snapshot, h.changed_at, u.name AS changed_by FROM product_fiscal_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.product_id = $1 ORDER BY h.id DESC LIMIT 100`,
      [id],
    );
    return { history: rows };
  });
}

export { forbidden };
