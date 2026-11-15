// Importacao de produtos por planilha (docs/14-importacao-produtos.md).
// Envio -> analise (nada e criado) -> revisao na previa -> confirmacao em lotes -> relatorio.
// Cada lote roda numa transacao: se algo inesperado acontecer no meio, o lote inteiro volta e as linhas
// continuam na fila; um produto nunca fica pela metade. Linhas recusadas pelo banco (SKU ou EAN que
// alguem cadastrou depois da analise) voltam ao savepoint da propria linha e entram no relatorio.
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { slugify } from '../lib/br.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation, pageQuery } from '../lib/http.js';
import {
  analyzeRows,
  buildReport,
  buildTemplate,
  COLUMN_BY_KEY,
  COLUMNS,
  MAX_FILE_BYTES,
  norm,
  readProductSheet,
  sanitizeText,
  type AnalysisContext,
  type CategoryDecision,
  type FieldKey,
  type RowData,
} from '../lib/product-import.js';
import { allocateSku, skuBase, takenWithBase } from '../lib/sku.js';
import { moveStock } from '../lib/stock.js';
import { requirePermission, type Auth } from './auth.js';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const uploadLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => req.cookies.loja_sid ?? req.ip } } };

/** Pontos de teste: simulam queda no meio de um lote. Nunca usados fora dos testes. */
export const importHooks: { beforeRow?: (rowNumber: number) => void | Promise<void> } = {};

/** Importar exige a permissao propria (com MFA) e a de cadastrar produtos. */
function requireImport(req: FastifyRequest): Auth {
  const auth = requirePermission(req, 'catalog.import');
  if (!auth.permissions.has('catalog.manage')) throw forbidden();
  return auth;
}

type Queryable = Db | typeof pool;

async function loadContext(db: Queryable, decisions: Record<string, CategoryDecision>): Promise<AnalysisContext> {
  // Em sequencia: dentro da transacao todas usam a mesma conexao.
  const units = await db.query<{ code: string; name: string; allows_fraction: boolean }>('SELECT code, name, allows_fraction FROM units');
  const categories = await db.query<{ id: string; parent_id: string | null; name: string }>('SELECT id, parent_id, name FROM categories');
  const skus = await db.query<{ sku: string; product_id: string; name: string }>('SELECT upper(v.sku::text) AS sku, p.id AS product_id, p.name FROM product_variants v JOIN products p ON p.id = v.product_id');
  const barcodes = await db.query<{ barcode: string; product_id: string; name: string; sku: string }>(
    `SELECT v.barcode, p.id AS product_id, p.name, v.sku::text AS sku FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.barcode IS NOT NULL
     UNION ALL
     SELECT k.barcode, p.id, p.name, v.sku::text FROM packagings k JOIN product_variants v ON v.id = k.variant_id JOIN products p ON p.id = v.product_id WHERE k.barcode IS NOT NULL`,
  );
  const products = await db.query<{ id: string; name: string; sku: string | null }>(
    `SELECT p.id, p.name, (SELECT v.sku::text FROM product_variants v WHERE v.product_id = p.id ORDER BY v.position LIMIT 1) AS sku FROM products p`,
  );
  return {
    units: new Map(units.rows.map((u) => [u.code, { name: u.name, allowsFraction: u.allows_fraction }])),
    categories: categories.rows,
    decisions,
    existingSkus: new Map(skus.rows.map((r) => [r.sku, { productId: r.product_id, name: r.name }])),
    existingBarcodes: new Map(barcodes.rows.map((r) => [r.barcode, { productId: r.product_id, name: r.name, sku: r.sku }])),
    existingProducts: products.rows,
  };
}

type ImportRow = {
  id: string;
  file_name: string;
  status: 'analyzed' | 'importing' | 'done' | 'canceled';
  category_decisions: Record<string, CategoryDecision>;
  created_by: string;
};

/** Refaz a analise da planilha inteira com o catalogo atual e grava o resultado de cada linha. */
async function reanalyze(db: Db, imp: Pick<ImportRow, 'id' | 'category_decisions'>) {
  const { rows } = await db.query<{ row_number: number; raw: Record<string, string>; formula_fields: string[]; decision: 'approve' | 'skip' | null }>(
    'SELECT row_number, raw, formula_fields, decision FROM product_import_rows WHERE import_id = $1 ORDER BY row_number',
    [imp.id],
  );
  const ctx = await loadContext(db, imp.category_decisions);
  const result = analyzeRows(
    rows.map((r) => ({ rowNumber: r.row_number, raw: r.raw, formulaFields: r.formula_fields as FieldKey[], decision: r.decision })),
    ctx,
  );
  await db.query(
    `UPDATE product_import_rows r SET data = x.data, status = x.status, issues = x.issues, matches = x.matches, category_key = x.category_key, sku = x.sku, sku_generated = x.sku_generated
     FROM jsonb_to_recordset($2::jsonb) AS x(row_number int, data jsonb, status text, issues jsonb, matches jsonb, category_key text, sku text, sku_generated boolean)
     WHERE r.import_id = $1 AND r.row_number = x.row_number`,
    [
      imp.id,
      JSON.stringify(result.rows.map((r) => ({ row_number: r.rowNumber, data: r.data, status: r.status, issues: r.issues, matches: r.matches, category_key: r.categoryKey, sku: r.sku, sku_generated: r.skuGenerated }))),
    ],
  );
  await db.query('UPDATE product_imports SET totals = $2, pending_categories = $3, updated_at = now() WHERE id = $1', [imp.id, JSON.stringify(result.totals), JSON.stringify(result.pendingCategories)]);
  return result;
}

const fileNameOf = (name: string) => sanitizeText(name.split(/[\\/]/).pop() ?? '').slice(0, 200) || 'planilha.xlsx';

async function readUpload(req: FastifyRequest) {
  const file = await req.file({ limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
  if (!file) throw new AppError(422, 'NO_FILE', 'Envie a planilha .xlsx.');
  const tooLarge = () => new AppError(413, 'FILE_TOO_LARGE', 'A planilha deve ter no máximo 5 MB.');
  const buf = await file.toBuffer().catch(() => {
    throw tooLarge();
  });
  if (file.file.truncated) throw tooLarge();
  const fileName = fileNameOf(file.filename);
  // A extensao e so o primeiro filtro; o conteudo e conferido pela assinatura ZIP/OOXML em readProductSheet.
  if (!/\.xlsx$/i.test(fileName)) throw new AppError(422, 'INVALID_EXTENSION', 'Envie um arquivo .xlsx (Excel). Arquivos .xls, .xlsm, .csv e outros não são aceitos.');
  if (!buf.length) throw new AppError(422, 'NO_FILE', 'O arquivo está vazio.');
  return { buf, fileName };
}

const importCols = `i.id, i.file_name, i.file_bytes, i.status, i.category_decisions, i.warnings, i.totals, i.pending_categories, i.created_at, i.confirmed_at, i.finished_at,
  u.name AS created_by_name, cu.name AS confirmed_by_name,
  (SELECT json_build_object(
     'imported', count(*) FILTER (WHERE r.result = 'imported'),
     'skipped', count(*) FILTER (WHERE r.result = 'skipped'),
     'failed', count(*) FILTER (WHERE r.result = 'failed'),
     'pending', count(*) FILTER (WHERE r.result = 'pending'),
     'withoutImage', count(*) FILTER (WHERE r.result = 'imported' AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = r.product_id)))
   FROM product_import_rows r WHERE r.import_id = i.id) AS results`;

async function loadImport(db: Queryable, id: string) {
  const { rows } = await db.query(`SELECT ${importCols} FROM product_imports i JOIN users u ON u.id = i.created_by LEFT JOIN users cu ON cu.id = i.confirmed_by WHERE i.id = $1`, [id]);
  if (!rows[0]) throw notFound();
  return rows[0];
}

async function lockImport(db: Db, id: string): Promise<ImportRow> {
  try {
    const { rows } = await db.query<ImportRow>('SELECT id, file_name, status, category_decisions, created_by FROM product_imports WHERE id = $1 FOR UPDATE NOWAIT', [id]);
    if (!rows[0]) throw notFound();
    return rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === '55P03') throw new AppError(409, 'IMPORT_BUSY', 'Esta importação está sendo processada em outra janela. Aguarde.');
    throw err;
  }
}

const editable = (imp: ImportRow) => {
  if (imp.status !== 'analyzed') throw new AppError(409, 'IMPORT_LOCKED', 'Esta importação já foi confirmada ou descartada e não pode mais ser alterada.');
};

const ROW_FILTERS: Record<string, string> = {
  all: 'true',
  new: `r.status = 'new'`,
  existing: `r.status = 'existing'`,
  duplicate: `(r.status = 'duplicate' OR (r.decision IS NOT NULL AND r.matches @> '[{"kind":"name"}]'))`,
  error: `r.status IN ('error', 'incomplete')`,
  review: `r.status IN ('duplicate', 'category') AND r.decision IS NULL`,
  imported: `r.result = 'imported'`,
  skipped: `r.result = 'skipped'`,
  failed: `r.result = 'failed'`,
};

// ---------------------------------------------------------------------------------------------
// Confirmacao

/** Cria as categorias que o administrador autorizou, sem duplicar por acento, maiusculas ou espacos. */
async function createAuthorizedCategories(db: Db, auth: Auth, imp: ImportRow, ip: string) {
  const { rows } = await db.query<{ data: RowData }>(`SELECT DISTINCT ON (category_key) data FROM product_import_rows WHERE import_id = $1 AND status = 'new' AND (data->>'categoryCreate')::boolean ORDER BY category_key, row_number`, [imp.id]);
  const created: string[] = [];
  const ensure = async (name: string, parentId: string | null): Promise<string> => {
    const same = await db.query<{ id: string }>(
      `SELECT id FROM categories WHERE coalesce(parent_id, '00000000-0000-0000-0000-000000000000') = coalesce($1::uuid, '00000000-0000-0000-0000-000000000000')
         AND regexp_replace(search_text(name), '\\s+', ' ', 'g') = $2 LIMIT 1`,
      [parentId, norm(name)],
    );
    if (same.rows[0]) return same.rows[0].id;
    let slug = slugify(name) || 'categoria';
    if (parentId && (await db.query('SELECT 1 FROM categories WHERE slug = $1', [slug])).rowCount) {
      const parent = (await db.query<{ slug: string }>('SELECT slug FROM categories WHERE id = $1', [parentId])).rows[0];
      if (parent) slug = `${parent.slug}-${slug}`.slice(0, 86).replace(/-+$/, '');
    }
    const base = slug;
    for (let i = 2; (await db.query('SELECT 1 FROM categories WHERE slug = $1', [slug])).rowCount; i++) slug = `${base.slice(0, 86)}-${i}`;
    const { rows: ins } = await db.query('INSERT INTO categories (name, slug, parent_id) VALUES ($1, $2, $3) RETURNING id, parent_id, name, slug', [name, slug, parentId]);
    await audit(db, { actorId: auth.userId, action: 'categories.created', entity: 'category', entityId: ins[0].id, after: ins[0], metadata: { importId: imp.id }, ip });
    created.push(name);
    return ins[0].id as string;
  };
  for (const { data } of rows) {
    const [root, sub] = data.categoryPath;
    const rootId = await ensure(root!, null);
    if (sub) await ensure(sub, rootId);
  }
  return created;
}

function skipReason(r: { status: string; decision: string | null; issues: { level: string; message: string }[]; matches: { message: string }[] }) {
  if (r.status === 'existing') return r.matches[0]?.message ?? 'Produto já cadastrado.';
  if (r.status === 'duplicate') return r.decision === 'skip' ? `Ignorado na conferência: ${r.matches[0]?.message ?? 'possível duplicado'}` : `Possível duplicado sem aprovação: ${r.matches[0]?.message ?? ''}`.trim();
  if (r.status === 'category') return 'Categoria inexistente sem decisão (escolher existente ou autorizar criar).';
  return r.issues.filter((i) => i.level !== 'warning').map((i) => i.message).join(' ') || 'Linha com erro.';
}

type Outcome = { ok: true; productId: string; sku: string; note: string } | { ok: false; reason: string };

/** Cadastra um produto da planilha. Erros esperados voltam como recusa da linha; os outros derrubam o lote. */
async function importRow(db: Db, auth: Auth, imp: ImportRow, row: { row_number: number; data: RowData; sku: string; sku_generated: boolean }, ip: string): Promise<Outcome> {
  const d = row.data;
  if (!d.categoryId) return { ok: false, reason: 'Categoria não definida.' };
  let slug = slugify(d.name) || 'produto';
  if ((await db.query('SELECT 1 FROM products WHERE slug = $1', [slug])).rowCount) slug = slugify(`${d.name} ${row.sku}`).slice(0, 160).replace(/-+$/, '');
  for (let i = 2; (await db.query('SELECT 1 FROM products WHERE slug = $1', [slug])).rowCount; i++) slug = `${slugify(`${d.name} ${row.sku}`).slice(0, 150)}-${i}`;

  const { rows: prod } = await db.query(
    `INSERT INTO products (name, slug, category_id, description, brand, status, base_unit, availability_mode, min_stock, specs)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'stock', $8, $9) RETURNING id`,
    [d.name, slug, d.categoryId, d.description, d.brand, d.status, d.unit, d.minStock, JSON.stringify(d.specs)],
  );
  const productId = prod[0].id as string;

  // SKU gerado: se alguem pegou o previsto (outra importacao, outra janela), tenta o proximo sufixo livre.
  let sku = row.sku;
  let variantId: string | null = null;
  for (let attempt = 0; attempt < 25 && !variantId; attempt++) {
    await db.query('SAVEPOINT import_sku');
    try {
      const { rows } = await db.query(
        `INSERT INTO product_variants (product_id, sku, barcode, weight_g, length_mm, width_mm, height_mm) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [productId, sku, d.ean, d.weightG, d.lengthMm, d.widthMm, d.heightMm],
      );
      variantId = rows[0].id as string;
      await db.query('RELEASE SAVEPOINT import_sku');
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT import_sku');
      if (isUniqueViolation(err, 'product_variants_barcode_key')) return { ok: false, reason: `EAN ${d.ean} já cadastrado em outro produto.` };
      if (!isUniqueViolation(err, 'product_variants_sku_key')) throw err;
      if (!row.sku_generated) return { ok: false, reason: `SKU ${sku} já cadastrado em outro produto.` };
      const base = skuBase(d.name);
      sku = allocateSku(base, await takenWithBase(db, base));
    }
  }
  if (!variantId) return { ok: false, reason: 'Não foi possível reservar um SKU livre. Tente de novo.' };

  await db.query(`INSERT INTO packagings (variant_id, kind, label, unit_code, base_qty, price_cents, is_default, position) VALUES ($1, 'sale', $2, $3, 1, $4, true, 0)`, [variantId, d.packLabel, d.unit, d.priceCents]);
  await db.query('INSERT INTO product_fiscal (product_id) VALUES ($1)', [productId]);

  const notes: string[] = [];
  if (row.sku_generated) notes.push(sku === row.sku ? `SKU gerado: ${sku}.` : `SKU gerado: ${sku} (o previsto ${row.sku} foi usado por outro cadastro).`);
  if (d.stockQty) {
    if (auth.permissions.has('stock.manage')) {
      await moveStock(db, auth.userId, {
        variantId,
        kind: 'adjustment',
        onHandDelta: d.stockQty,
        unitCostCents: d.costCents === null ? null : String(d.costCents),
        sourceType: 'manual',
        sourceId: imp.id,
        reason: `Estoque inicial da importação de planilha (linha ${row.row_number}).`,
        requestKey: `import-${imp.id}-${row.row_number}`,
      });
      notes.push(`Estoque inicial: ${d.stockQty.replace('.', ',')} ${d.unit}.`);
    } else notes.push('Estoque não lançado: sua conta não tem a permissão de movimentar estoque.');
  }
  notes.push('Sem imagem.');
  await audit(db, { actorId: auth.userId, action: 'products.imported', entity: 'product', entityId: productId, after: { name: d.name, sku, status: d.status }, metadata: { importId: imp.id, row: row.row_number }, ip });
  return { ok: true, productId, sku, note: notes.join(' ') };
}

// ---------------------------------------------------------------------------------------------

const valuesSchema = z.partialRecord(
  z.enum(COLUMNS.map((c) => c.key) as [FieldKey, ...FieldKey[]]),
  z.string().max(10_001),
);

const decisionSchema = z.union([z.strictObject({ action: z.literal('map'), categoryId: z.uuid() }), z.strictObject({ action: z.literal('create') })]);

export async function productImportRoutes(app: FastifyInstance) {
  app.get('/template.xlsx', async (req, reply) => {
    requireImport(req);
    const [categories, units] = await Promise.all([
      pool.query('SELECT id, parent_id, name FROM categories WHERE active ORDER BY name'),
      pool.query('SELECT code, name, allows_fraction FROM units ORDER BY name'),
    ]);
    const buf = await buildTemplate({ categories: categories.rows, units: units.rows });
    return reply.type(XLSX_TYPE).header('Content-Disposition', 'attachment; filename="modelo-importacao-produtos.xlsx"').send(buf);
  });

  // Referencia para a tela de instrucoes: colunas, unidades e categorias atuais.
  app.get('/guide', async (req) => {
    requireImport(req);
    const [categories, units] = await Promise.all([
      pool.query('SELECT id, parent_id, name, active FROM categories ORDER BY position, name'),
      pool.query('SELECT code, name, allows_fraction FROM units ORDER BY name'),
    ]);
    return {
      columns: COLUMNS.map((c) => ({ key: c.key, header: c.header, required: c.required, format: c.format, example: c.example })),
      units: units.rows,
      categories: categories.rows,
      limits: { maxBytes: MAX_FILE_BYTES, maxRows: 2000 },
    };
  });

  app.get('/', async (req) => {
    requireImport(req);
    const q = pageQuery.parse(req.query);
    const { rows } = await pool.query(
      `SELECT ${importCols}, count(*) OVER () AS total FROM product_imports i JOIN users u ON u.id = i.created_by LEFT JOIN users cu ON cu.id = i.confirmed_by
       ORDER BY i.created_at DESC LIMIT $1 OFFSET $2`,
      [q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { imports: rows.map(({ total: _t, category_decisions: _d, pending_categories: _p, ...r }) => r), total: Number(rows[0]?.total ?? 0), page: q.page, pageSize: q.pageSize };
  });

  // Envio e analise. Nada e criado no catalogo.
  app.post('/', uploadLimit, async (req, reply) => {
    const auth = requireImport(req);
    const { buf, fileName } = await readUpload(req);
    const parsed = await readProductSheet(buf);
    const sha = createHash('sha256').update(buf).digest('hex');
    const warnings = [...parsed.warnings];
    const previous = (
      await pool.query<{ created_at: Date; imported: number }>(
        `SELECT i.created_at, (SELECT count(*)::int FROM product_import_rows r WHERE r.import_id = i.id AND r.result = 'imported') AS imported
         FROM product_imports i WHERE i.file_sha256 = $1 AND i.status IN ('importing', 'done') ORDER BY i.created_at DESC LIMIT 1`,
        [sha],
      )
    ).rows[0];
    if (previous) {
      warnings.unshift(
        `Este mesmo arquivo já foi importado em ${previous.created_at.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (${previous.imported} produto(s) cadastrado(s)). Os produtos que já existem não serão cadastrados de novo.`,
      );
    }
    const id = await tx(auth.userId, async (db) => {
      const { rows } = await db.query<{ id: string }>(`INSERT INTO product_imports (file_name, file_sha256, file_bytes, warnings, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
        fileName,
        sha,
        buf.length,
        JSON.stringify(warnings),
        auth.userId,
      ]);
      const importId = rows[0]!.id;
      await db.query(
        `INSERT INTO product_import_rows (import_id, row_number, raw, formula_fields, status)
         SELECT $1, x.row_number, x.raw, x.formula_fields, 'new' FROM jsonb_to_recordset($2::jsonb) AS x(row_number int, raw jsonb, formula_fields text[])`,
        [importId, JSON.stringify(parsed.rows.map((r) => ({ row_number: r.rowNumber, raw: r.raw, formula_fields: r.formulaFields })))],
      );
      const result = await reanalyze(db, { id: importId, category_decisions: {} });
      await audit(db, { actorId: auth.userId, action: 'product_imports.analyzed', entity: 'product_import', entityId: importId, metadata: { fileName, sha256: sha, bytes: buf.length, totals: result.totals }, ip: req.ip });
      return importId;
    });
    return reply.code(201).send({ import: await loadImport(pool, id) });
  });

  app.get('/:id', async (req) => {
    requireImport(req);
    const { id } = idParams.parse(req.params);
    const q = pageQuery.extend({ pageSize: z.coerce.number().int().min(1).max(200).default(50), filter: z.enum(Object.keys(ROW_FILTERS) as [string, ...string[]]).default('all') }).parse(req.query);
    const imp = await loadImport(pool, id);
    const { rows } = await pool.query(
      `SELECT r.row_number, r.raw, r.formula_fields, r.data, r.status, r.issues, r.matches, r.category_key, r.decision, r.sku, r.sku_generated, r.result, r.result_reason, r.product_id,
              (r.product_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = r.product_id)) AS without_image,
              count(*) OVER () AS total
       FROM product_import_rows r WHERE r.import_id = $1 AND ${ROW_FILTERS[q.filter]} ORDER BY r.row_number LIMIT $2 OFFSET $3`,
      [id, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { import: imp, rows: rows.map(({ total: _t, ...r }) => r), total: Number(rows[0]?.total ?? 0), page: q.page, pageSize: q.pageSize, filter: q.filter };
  });

  // Correcao simples na propria tela e decisao sobre possivel duplicado.
  app.patch('/:id/rows/:row', async (req) => {
    const auth = requireImport(req);
    const { id, row } = z.object({ id: z.uuid(), row: z.coerce.number().int().min(2).max(100_000) }).parse(req.params);
    const body = z.strictObject({ values: valuesSchema.optional(), decision: z.enum(['approve', 'skip']).nullable().optional() }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const imp = await lockImport(db, id);
      editable(imp);
      const cur = (await db.query<{ raw: Record<string, string>; formula_fields: string[] }>('SELECT raw, formula_fields FROM product_import_rows WHERE import_id = $1 AND row_number = $2', [id, row])).rows[0];
      if (!cur) throw notFound();
      const raw = { ...cur.raw };
      let formula = cur.formula_fields;
      for (const [key, value] of Object.entries(body.values ?? {}) as [FieldKey, string][]) {
        const col = COLUMN_BY_KEY.get(key)!;
        const text = sanitizeText(value, col.multiline);
        if (/^[=+@]/.test(text)) throw new AppError(422, 'FORMULA_NOT_ALLOWED', `${col.header}: o valor não pode começar com =, + ou @.`);
        if (text) raw[key] = text;
        else delete raw[key];
        formula = formula.filter((f) => f !== key);
      }
      await db.query(`UPDATE product_import_rows SET raw = $3, formula_fields = $4, decision = CASE WHEN $5::boolean THEN $6 ELSE decision END WHERE import_id = $1 AND row_number = $2`, [
        id,
        row,
        JSON.stringify(raw),
        formula,
        body.decision !== undefined,
        body.decision ?? null,
      ]);
      const result = await reanalyze(db, imp);
      if (body.values) await audit(db, { actorId: auth.userId, action: 'product_imports.row_edited', entity: 'product_import', entityId: id, before: cur.raw, after: raw, metadata: { row }, ip: req.ip });
      const updated = (await db.query('SELECT row_number, raw, formula_fields, data, status, issues, matches, category_key, decision, sku, sku_generated, result, result_reason FROM product_import_rows WHERE import_id = $1 AND row_number = $2', [id, row])).rows[0];
      return { row: updated, totals: result.totals, pendingCategories: result.pendingCategories };
    });
  });

  // Categorias inexistentes: escolher uma existente ou autorizar criar. null remove a decisao.
  app.put('/:id/categories', async (req) => {
    const auth = requireImport(req);
    const { id } = idParams.parse(req.params);
    const { decisions } = z.strictObject({ decisions: z.record(z.string().min(1).max(200), decisionSchema.nullable()) }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const imp = await lockImport(db, id);
      editable(imp);
      const next = { ...imp.category_decisions };
      for (const [key, d] of Object.entries(decisions)) {
        if (d === null) delete next[key];
        else {
          if (d.action === 'map' && !(await db.query('SELECT 1 FROM categories WHERE id = $1', [d.categoryId])).rowCount) throw new AppError(422, 'INVALID_CATEGORY', 'Categoria escolhida não existe.');
          next[key] = d;
        }
      }
      await db.query('UPDATE product_imports SET category_decisions = $2 WHERE id = $1', [id, JSON.stringify(next)]);
      const result = await reanalyze(db, { id, category_decisions: next });
      return { totals: result.totals, pendingCategories: result.pendingCategories, decisions: next };
    });
  });

  app.post('/:id/cancel', async (req) => {
    const auth = requireImport(req);
    const { id } = idParams.parse(req.params);
    await tx(auth.userId, async (db) => {
      const imp = await lockImport(db, id);
      editable(imp);
      await db.query(`UPDATE product_imports SET status = 'canceled', updated_at = now() WHERE id = $1`, [id]);
      await audit(db, { actorId: auth.userId, action: 'product_imports.canceled', entity: 'product_import', entityId: id, ip: req.ip });
    });
    return { import: await loadImport(pool, id) };
  });

  // Confirmacao: a primeira chamada congela a fila; cada chamada processa um lote. A tela repete ate terminar.
  app.post('/:id/process', async (req) => {
    const auth = requireImport(req);
    const { id } = idParams.parse(req.params);
    const { batchSize } = z.strictObject({ batchSize: z.number().int().min(1).max(200).default(100) }).parse(req.body ?? {});
    const progress = await tx(auth.userId, async (db) => {
      const imp = await lockImport(db, id);
      if (imp.status === 'canceled') throw new AppError(409, 'IMPORT_CANCELED', 'Esta importação foi descartada.');
      if (imp.status === 'analyzed') {
        // O catalogo pode ter mudado desde a analise: confere de novo antes de congelar a fila.
        const created = await createAuthorizedCategories(db, auth, imp, req.ip);
        await reanalyze(db, imp);
        const { rows } = await db.query('SELECT row_number, status, decision, issues, matches FROM product_import_rows WHERE import_id = $1', [id]);
        const skipped = rows.filter((r) => r.status !== 'new');
        await db.query(`UPDATE product_import_rows SET result = 'pending' WHERE import_id = $1 AND status = 'new'`, [id]);
        await db.query(
          `UPDATE product_import_rows r SET result = 'skipped', result_reason = x.reason, processed_at = now()
           FROM jsonb_to_recordset($2::jsonb) AS x(row_number int, reason text) WHERE r.import_id = $1 AND r.row_number = x.row_number`,
          [id, JSON.stringify(skipped.map((r) => ({ row_number: r.row_number, reason: skipReason(r).slice(0, 300) })))],
        );
        await db.query(`UPDATE product_imports SET status = 'importing', confirmed_by = $2, confirmed_at = now(), updated_at = now() WHERE id = $1`, [id, auth.userId]);
        await audit(db, { actorId: auth.userId, action: 'product_imports.confirmed', entity: 'product_import', entityId: id, metadata: { queued: rows.length - skipped.length, skipped: skipped.length, categoriesCreated: created }, ip: req.ip });
        imp.status = 'importing';
      }
      if (imp.status === 'importing') {
        const { rows } = await db.query<{ row_number: number; data: RowData; sku: string; sku_generated: boolean }>(
          `SELECT row_number, data, sku, sku_generated FROM product_import_rows WHERE import_id = $1 AND result = 'pending' ORDER BY row_number LIMIT $2`,
          [id, batchSize],
        );
        for (const row of rows) {
          await importHooks.beforeRow?.(row.row_number);
          await db.query('SAVEPOINT import_row');
          const out = await importRow(db, auth, imp, row, req.ip);
          if (out.ok) {
            await db.query('RELEASE SAVEPOINT import_row');
            await db.query(`UPDATE product_import_rows SET result = 'imported', product_id = $3, sku = $4, result_reason = $5, processed_at = now() WHERE import_id = $1 AND row_number = $2`, [id, row.row_number, out.productId, out.sku, out.note.slice(0, 300)]);
          } else {
            await db.query('ROLLBACK TO SAVEPOINT import_row');
            await db.query(`UPDATE product_import_rows SET result = 'failed', result_reason = $3, processed_at = now() WHERE import_id = $1 AND row_number = $2`, [id, row.row_number, out.reason.slice(0, 300)]);
          }
        }
        const left = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM product_import_rows WHERE import_id = $1 AND result = 'pending'`, [id])).rows[0]!.n;
        if (!left) {
          await db.query(`UPDATE product_imports SET status = 'done', finished_at = now(), updated_at = now() WHERE id = $1`, [id]);
          const res = (await loadImport(db, id)).results;
          await audit(db, { actorId: auth.userId, action: 'product_imports.finished', entity: 'product_import', entityId: id, metadata: res, ip: req.ip });
        }
      }
      return loadImport(db, id);
    });
    const r = progress.results as Record<string, number>;
    const total = Number(progress.totals.rows ?? 0);
    return { import: progress, progress: { total, processed: total - Number(r.pending ?? 0), done: progress.status === 'done' } };
  });

  app.get('/:id/report.xlsx', async (req, reply) => {
    requireImport(req);
    const { id } = idParams.parse(req.params);
    const imp = await loadImport(pool, id);
    const { rows } = await pool.query(
      `SELECT r.row_number, coalesce(r.data->>'name', r.raw->>'name') AS name, r.sku, coalesce(r.data->>'ean', r.raw->>'ean') AS ean,
              coalesce(c.name, concat_ws(' > ', r.raw->>'category', r.raw->>'subcategory')) AS category, r.status, r.result,
              coalesce(r.result_reason, (SELECT string_agg(i->>'message', ' ') FROM jsonb_array_elements(r.issues || r.matches) i)) AS reason,
              r.product_id, EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = r.product_id) AS has_image
       FROM product_import_rows r LEFT JOIN products p ON p.id = r.product_id LEFT JOIN categories c ON c.id = p.category_id
       WHERE r.import_id = $1 ORDER BY r.row_number`,
      [id],
    );
    const statusLabel: Record<string, string> = { analyzed: 'Analisada, aguardando confirmação', importing: 'Em andamento', done: 'Concluída', canceled: 'Descartada' };
    const res = imp.results as Record<string, number>;
    const t = imp.totals as Record<string, number>;
    const buf = await buildReport(
      {
        fileName: imp.file_name,
        createdAt: new Date(imp.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
        userName: imp.created_by_name,
        status: statusLabel[imp.status] ?? imp.status,
        totals: {
          'Linhas lidas': t.rows ?? 0,
          Novos: t.new ?? 0,
          'Já existentes': t.existing ?? 0,
          'Possíveis duplicados': t.duplicate ?? 0,
          'Com erro': t.error ?? 0,
          Incompletos: t.incomplete ?? 0,
          'Categoria pendente': t.category ?? 0,
          Cadastrados: res.imported ?? 0,
          Ignorados: res.skipped ?? 0,
          'Não cadastrados (erro na gravação)': res.failed ?? 0,
          'Cadastrados sem imagem': res.withoutImage ?? 0,
        },
      },
      rows,
    );
    const day = new Date(imp.created_at).toISOString().slice(0, 10);
    return reply.type(XLSX_TYPE).header('Content-Disposition', `attachment; filename="relatorio-importacao-${day}.xlsx"`).send(buf);
  });

  // Imagens em lote: a tela manda os SKUs tirados dos nomes dos arquivos e recebe para qual produto vai cada um.
  // So localiza; o envio usa a rota de imagens de sempre. Produto que ja tem foto nao recebe (nada e trocado).
  app.post('/image-targets', async (req) => {
    requireImport(req);
    const { skus } = z.strictObject({ skus: z.array(z.string().trim().min(2).max(40)).min(1).max(500) }).parse(req.body);
    const { rows } = await pool.query(
      `SELECT v.sku::text AS sku, p.id AS product_id, p.name, (SELECT count(*)::int FROM product_images i WHERE i.product_id = p.id) AS image_count
       FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.sku = ANY($1::citext[])`,
      [[...new Set(skus.map((s) => s.toUpperCase()))]],
    );
    return { targets: rows };
  });
}
