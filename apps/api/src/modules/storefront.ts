import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isProduction } from '../config.js';
import { pool, tx, type Db } from '../db/pool.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { AppError, notFound } from '../lib/errors.js';
import { likePattern, pageQuery } from '../lib/http.js';
import { cartWeight, priceLines, type CartLine } from '../lib/pricing.js';

export const CART_COOKIE = isProduction ? '__Host-loja_cart' : 'loja_cart';
const CART_DAYS = 60;

// ---------------- catalogo ----------------

const DEFAULT_PACK = `(SELECT k.id FROM packagings k JOIN product_variants v2 ON v2.id = k.variant_id
  WHERE v2.product_id = p.id AND v2.active AND k.active AND k.kind = 'sale' ORDER BY v2.position, k.is_default DESC, k.base_qty LIMIT 1)`;

const CARD_SELECT = `p.id, p.name, p.slug, p.created_at, p.summary, p.base_unit, p.availability_mode, p.lead_time_days, c.name AS category_name, c.slug AS category_slug,
  k.id AS packaging_id, k.label AS packaging_label, k.base_qty, k.price_cents, round(k.price_cents / k.base_qty, 4) AS unit_price_cents, v.sku,
  (SELECT json_build_object('minPacks', t.min_packs, 'priceCents', t.price_cents) FROM price_tiers t WHERE t.packaging_id = k.id ORDER BY t.min_packs LIMIT 1) AS first_tier,
  (SELECT count(*)::int FROM product_variants vv WHERE vv.product_id = p.id AND vv.active) AS variant_count,
  (SELECT im.file_key FROM product_images im WHERE im.product_id = p.id ORDER BY im.is_primary DESC, im.position LIMIT 1) AS image_key,
  EXISTS (SELECT 1 FROM product_variants vv LEFT JOIN stock_balances b ON b.variant_id = vv.id JOIN packagings kk ON kk.variant_id = vv.id
          WHERE vv.product_id = p.id AND vv.active AND kk.active AND kk.kind = 'sale' AND coalesce(b.on_hand, 0) - coalesce(b.reserved, 0) >= kk.base_qty) AS in_stock`;

const CARD_FROM = `FROM products p JOIN packagings k ON k.id = ${DEFAULT_PACK} JOIN product_variants v ON v.id = k.variant_id LEFT JOIN categories c ON c.id = p.category_id`;

const listQuery = pageQuery.extend({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(160).optional(),
  sort: z.enum(['relevance', 'name', 'price_asc', 'price_desc', 'unit_asc', 'newest']).default('relevance'),
  stock: z.enum(['all', 'in_stock', 'made_to_order']).default('all'),
});

const SORTS: Record<string, string> = {
  relevance: 'in_stock DESC, p.name',
  name: 'p.name',
  price_asc: 'k.price_cents, p.name',
  price_desc: 'k.price_cents DESC, p.name',
  unit_asc: 'unit_price_cents, p.name',
  newest: 'p.created_at DESC',
};

export async function catalogRoutes(app: FastifyInstance) {
  app.get('/categories', async () => {
    const { rows } = await pool.query(
      `SELECT c.id, c.parent_id, c.name, c.slug, c.description, c.position,
              (SELECT count(*)::int FROM products p WHERE p.category_id = c.id AND p.status = 'active') AS product_count
       FROM categories c WHERE c.active ORDER BY c.position, c.name`,
    );
    return { categories: rows };
  });

  app.get('/products', async (req) => {
    const q = listQuery.parse(req.query);
    const where = ["p.status = 'active'"];
    const params: unknown[] = [];
    let category = null;
    if (q.category) {
      category = (await pool.query('SELECT id, name, slug, description, parent_id FROM categories WHERE slug = $1 AND active', [q.category])).rows[0];
      if (!category) throw notFound();
      params.push(category.id);
      where.push(`p.category_id IN (WITH RECURSIVE t AS (SELECT id FROM categories WHERE id = $${params.length} UNION ALL SELECT c2.id FROM categories c2 JOIN t ON c2.parent_id = t.id WHERE c2.active) SELECT id FROM t)`);
    }
    if (q.q) {
      params.push(likePattern(q.q.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()), q.q);
      const n = params.length;
      where.push(`(p.search_doc LIKE $${n - 1} OR EXISTS (SELECT 1 FROM product_variants sv WHERE sv.product_id = p.id AND sv.active AND (sv.sku ILIKE $${n - 1} OR sv.barcode = $${n})))`);
    }
    if (q.stock === 'made_to_order') where.push(`p.availability_mode = 'made_to_order'`);
    const base = `SELECT ${CARD_SELECT} ${CARD_FROM} WHERE ${where.join(' AND ')}`;
    const stockFilter = q.stock === 'in_stock' ? 'WHERE in_stock' : '';
    const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${base}) x ${stockFilter}`, params)).rows[0]!.n;
    const sort = SORTS[q.sort]!.replace(/\bp\.|\bk\./g, '');
    const { rows } = await pool.query(`SELECT * FROM (${base}) x ${stockFilter} ORDER BY ${sort} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
      ...params,
      q.pageSize,
      (q.page - 1) * q.pageSize,
    ]);
    return { products: rows, total, page: q.page, pageSize: q.pageSize, category };
  });

  app.get('/products/:slug', async (req) => {
    const { slug } = z.object({ slug: z.string().max(160) }).parse(req.params);
    const p = (
      await pool.query(
        `SELECT p.id, p.name, p.slug, p.summary, p.description, p.brand, p.base_unit, u.name AS base_unit_name, p.availability_mode, p.lead_time_days, p.specs, p.category_id
         FROM products p JOIN units u ON u.code = p.base_unit WHERE p.slug = $1 AND p.status = 'active'`,
        [slug],
      )
    ).rows[0];
    if (!p) throw notFound();
    const breadcrumb = (
      await pool.query(
        `WITH RECURSIVE t AS (SELECT id, parent_id, name, slug, 0 AS depth FROM categories WHERE id = $1
           UNION ALL SELECT c.id, c.parent_id, c.name, c.slug, t.depth + 1 FROM categories c JOIN t ON c.id = t.parent_id)
         SELECT name, slug FROM t ORDER BY depth DESC`,
        [p.category_id],
      )
    ).rows;
    const variants = (
      await pool.query(
        `SELECT v.id, v.sku, v.attributes, v.weight_g, v.length_mm, v.width_mm, v.height_mm,
                (coalesce(b.on_hand, 0) - coalesce(b.reserved, 0))::numeric(14,3) AS available
         FROM product_variants v LEFT JOIN stock_balances b ON b.variant_id = v.id WHERE v.product_id = $1 AND v.active ORDER BY v.position`,
        [p.id],
      )
    ).rows;
    const packs = (
      await pool.query(
        `SELECT k.id, k.variant_id, k.label, k.unit_code, k.base_qty, k.price_cents, k.is_default, round(k.price_cents / k.base_qty, 4) AS unit_price_cents,
                coalesce((SELECT json_agg(json_build_object('minPacks', t.min_packs, 'priceCents', t.price_cents) ORDER BY t.min_packs) FROM price_tiers t WHERE t.packaging_id = k.id), '[]') AS tiers
         FROM packagings k JOIN product_variants v ON v.id = k.variant_id WHERE v.product_id = $1 AND v.active AND k.active AND k.kind = 'sale' ORDER BY k.position, k.base_qty`,
        [p.id],
      )
    ).rows;
    const images = (await pool.query('SELECT file_key, width, height, alt, variant_id FROM product_images WHERE product_id = $1 ORDER BY is_primary DESC, position', [p.id])).rows;
    // Disponibilidade sem revelar o saldo exato: quantas embalagens podem sair agora (limitado).
    const out = variants.map(({ available, ...v }) => ({
      ...v,
      packagings: packs
        .filter((k) => k.variant_id === v.id)
        .map(({ variant_id: _, ...k }) => ({ ...k, in_stock: Number(available) >= Number(k.base_qty), max_packs: Math.min(999, Math.max(0, Math.floor(Number(available) / Number(k.base_qty)))) })),
    }));
    return { product: { ...p, breadcrumb, variants: out, images } };
  });
}

// ---------------- carrinho ----------------

type Cart = { id: string; customer_id: string | null };

async function findCart(db: Db | typeof pool, req: FastifyRequest): Promise<Cart | null> {
  const token = req.cookies[CART_COOKIE];
  if (!token || token.length > 100) return null;
  return (await db.query<Cart>(`SELECT id, customer_id FROM carts WHERE token_hash = $1 AND status = 'active'`, [sha256(token)])).rows[0] ?? null;
}

async function ensureCart(db: Db, req: FastifyRequest, reply: FastifyReply): Promise<Cart> {
  const found = await findCart(db, req);
  if (found) return found;
  const token = randomToken();
  const cart = (await db.query<Cart>('INSERT INTO carts (token_hash) VALUES ($1) RETURNING id, customer_id', [sha256(token)])).rows[0]!;
  reply.setCookie(CART_COOKIE, token, { path: '/', httpOnly: true, secure: isProduction, sameSite: 'lax', maxAge: CART_DAYS * 86_400 });
  return cart;
}

export async function cartLines(db: Db | typeof pool, cartId: string) {
  const items = (await db.query<{ packaging_id: string; packs: number }>('SELECT packaging_id, packs FROM cart_items WHERE cart_id = $1 ORDER BY added_at', [cartId])).rows;
  return priceLines(db, items.map((i) => ({ packagingId: i.packaging_id, packs: i.packs })));
}

export function summarize(lines: CartLine[]) {
  const subtotal = lines.filter((l) => l.status !== 'unavailable').reduce((s, l) => s + l.totalCents, 0);
  const listTotal = lines.filter((l) => l.status !== 'unavailable').reduce((s, l) => s + l.listPriceCents * l.packs, 0);
  const weight = cartWeight(lines.filter((l) => l.status !== 'unavailable'));
  return {
    items: lines,
    subtotalCents: subtotal,
    // Economia das faixas de quantidade, ja embutida no subtotal.
    quantitySavingsCents: listTotal - subtotal,
    weightG: weight.grams,
    weightMissing: weight.missing,
    hasMadeToOrder: lines.some((l) => l.madeToOrder),
    blocking: lines.filter((l) => l.status !== 'ok').map((l) => ({ packagingId: l.packagingId, status: l.status, available: l.available })),
  };
}

export async function readCart(db: Db | typeof pool, req: FastifyRequest) {
  const cart = await findCart(db, req);
  if (!cart) return { cart: null, summary: summarize([]) };
  return { cart, summary: summarize(await cartLines(db, cart.id)) };
}

const itemBody = z.strictObject({ packagingId: z.uuid(), packs: z.number().int().min(1).max(100_000) });

export async function cartRoutes(app: FastifyInstance) {
  const limit = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  app.get('/', async (req) => ({ cart: (await readCart(pool, req)).summary }));

  /** Adiciona (soma a quantidade se a embalagem ja estiver no carrinho). */
  app.post('/items', limit, async (req, reply) => {
    const b = itemBody.parse(req.body);
    return tx(null, async (db) => {
      const ok = (await db.query(`SELECT 1 FROM packagings k JOIN product_variants v ON v.id = k.variant_id JOIN products p ON p.id = v.product_id
        WHERE k.id = $1 AND k.kind = 'sale' AND k.active AND v.active AND p.status = 'active'`, [b.packagingId])).rowCount;
      if (!ok) throw new AppError(422, 'NOT_SELLABLE', 'Este produto não está disponível para compra.');
      const cart = await ensureCart(db, req, reply);
      const count = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM cart_items WHERE cart_id = $1', [cart.id])).rows[0]!.n;
      if (count >= 100) throw new AppError(422, 'CART_FULL', 'O carrinho aceita até 100 produtos diferentes.');
      await db.query(
        `INSERT INTO cart_items (cart_id, packaging_id, packs) VALUES ($1, $2, $3)
         ON CONFLICT (cart_id, packaging_id) DO UPDATE SET packs = least(cart_items.packs + EXCLUDED.packs, 100000)`,
        [cart.id, b.packagingId, b.packs],
      );
      await db.query('UPDATE carts SET updated_at = now() WHERE id = $1', [cart.id]);
      return { cart: summarize(await cartLines(db, cart.id)) };
    });
  });

  app.put('/items/:packagingId', limit, async (req) => {
    const { packagingId } = z.object({ packagingId: z.uuid() }).parse(req.params);
    const { packs } = z.strictObject({ packs: z.number().int().min(1).max(100_000) }).parse(req.body);
    return tx(null, async (db) => {
      const cart = await findCart(db, req);
      if (!cart) throw notFound();
      const r = await db.query('UPDATE cart_items SET packs = $3 WHERE cart_id = $1 AND packaging_id = $2', [cart.id, packagingId, packs]);
      if (!r.rowCount) throw notFound();
      return { cart: summarize(await cartLines(db, cart.id)) };
    });
  });

  app.delete('/items/:packagingId', limit, async (req) => {
    const { packagingId } = z.object({ packagingId: z.uuid() }).parse(req.params);
    return tx(null, async (db) => {
      const cart = await findCart(db, req);
      if (!cart) throw notFound();
      await db.query('DELETE FROM cart_items WHERE cart_id = $1 AND packaging_id = $2', [cart.id, packagingId]);
      return { cart: summarize(await cartLines(db, cart.id)) };
    });
  });
}

// ---------------- frete ----------------

export type ShippingQuote = { id: string; name: string; kind: 'pickup' | 'delivery'; description: string | null; priceCents: number; minDays: number; maxDays: number };

const inRanges = (cep: string, ranges: string[]) =>
  ranges.some((r) => {
    const [a, b] = r.split('-');
    return a !== undefined && cep >= a && cep <= (b ?? a);
  });

/** Opcoes de entrega para o CEP e o carrinho. Retirada sempre aparece se estiver ativa. */
export async function quoteShipping(db: Db | typeof pool, cep: string | null, subtotalCents: number, weightG: number, weightMissing: boolean): Promise<ShippingQuote[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    kind: 'pickup' | 'delivery';
    description: string | null;
    cep_ranges: string[];
    base_cents: string;
    per_kg_cents: string;
    free_above_cents: string | null;
    max_weight_g: number | null;
    min_days: number;
    max_days: number;
  }>('SELECT * FROM shipping_options WHERE active ORDER BY position, name');
  return rows.flatMap((o) => {
    if (o.kind === 'delivery') {
      if (!cep || !inRanges(cep, o.cep_ranges)) return [];
      if (o.max_weight_g && weightG > o.max_weight_g) return [];
      // Sem peso cadastrado nao ha como cobrar por quilo: a opcao so aparece se nao depender do peso.
      if (weightMissing && Number(o.per_kg_cents) > 0) return [];
    }
    const free = o.free_above_cents !== null && subtotalCents >= Number(o.free_above_cents);
    const price = o.kind === 'pickup' || free ? (o.kind === 'pickup' ? Number(o.base_cents) : 0) : Number(o.base_cents) + Math.ceil(weightG / 1000) * Number(o.per_kg_cents);
    return [{ id: o.id, name: o.name, kind: o.kind, description: o.description, priceCents: price, minDays: o.min_days, maxDays: o.max_days }];
  });
}

export async function shippingQuoteRoutes(app: FastifyInstance) {
  app.get('/quote', async (req) => {
    const { cep } = z.object({ cep: z.string().transform((v) => v.replace(/\D/g, '')).pipe(z.string().regex(/^\d{8}$/, 'CEP com 8 números.')) }).parse(req.query);
    const { summary } = await readCart(pool, req);
    const options = await quoteShipping(pool, cep, summary.subtotalCents, summary.weightG, summary.weightMissing.length > 0);
    return { cep, options, weightMissing: summary.weightMissing.length > 0 };
  });
}
