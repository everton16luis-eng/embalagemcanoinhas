import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation, likePattern, pageQuery } from '../lib/http.js';
import { assertWhole, consumeReservation, moveStock, neg, qty, releaseReservation, reserve, signedQty, variantInfo } from '../lib/stock.js';
import { requirePermission, type Auth } from './auth.js';

const requestKey = z.string().trim().min(8).max(100);
/** Custo e informacao de compra: quem so vende ve saldo, nao custo. */
export const canSeeCost = (auth: Auth) => auth.permissions.has('purchases.view') || auth.permissions.has('finance.view');

const VARIANT_LABEL = `p.name || CASE WHEN v.attributes = '{}'::jsonb THEN '' ELSE ' — ' || (SELECT string_agg(value, ' / ' ORDER BY key) FROM jsonb_each_text(v.attributes)) END`;

const listQuery = pageQuery.extend({
  q: z.string().trim().max(100).optional(),
  categoryId: z.uuid().optional(),
  // below: abaixo do minimo; out: sem disponivel; reserved: com reserva; backorder: reservado alem do fisico
  filter: z.enum(['all', 'below', 'out', 'reserved', 'backorder']).default('all'),
});

const manualMovement = z.strictObject({
  variantId: z.uuid(),
  // Entrada sem compra (devolucao), perda, avaria ou ajuste (positivo ou negativo).
  kind: z.enum(['return', 'loss', 'damage', 'adjustment']),
  qty: signedQty,
  reason: z.string().trim().min(3).max(300),
  requestKey,
});

const reservationBody = z.strictObject({
  variantId: z.uuid(),
  qty,
  sourceType: z.enum(['manual', 'quote']).default('manual'),
  sourceId: z.string().trim().min(1).max(60),
  expiresInHours: z.number().int().min(1).max(24 * 30).nullable().optional(),
});

export async function stockRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    const auth = requirePermission(req, 'stock.view');
    const q = listQuery.parse(req.query);
    const where = ['v.active', "p.status <> 'inactive'"];
    const params: unknown[] = [];
    if (q.q) {
      params.push(likePattern(q.q));
      where.push(`(p.search_doc LIKE search_text($${params.length}) OR v.sku ILIKE $${params.length} OR v.barcode = $${params.length + 1})`);
      params.push(q.q);
    }
    if (q.categoryId) {
      params.push(q.categoryId);
      where.push(`p.category_id IN (WITH RECURSIVE t AS (SELECT id FROM categories WHERE id = $${params.length} UNION ALL SELECT c.id FROM categories c JOIN t ON c.parent_id = t.id) SELECT id FROM t)`);
    }
    const avail = 'coalesce(b.on_hand, 0) - coalesce(b.reserved, 0)';
    if (q.filter === 'below') where.push(`p.min_stock > 0 AND ${avail} < p.min_stock`);
    if (q.filter === 'out') where.push(`${avail} <= 0`);
    if (q.filter === 'reserved') where.push('coalesce(b.reserved, 0) > 0');
    if (q.filter === 'backorder') where.push(`${avail} < 0`);
    const sql = `FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN stock_balances b ON b.variant_id = v.id WHERE ${where.join(' AND ')}`;
    const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n ${sql}`, params)).rows[0]!.n;
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const { rows } = await pool.query(
      `SELECT v.id AS variant_id, v.sku, v.attributes, p.id AS product_id, p.name AS product_name, ${VARIANT_LABEL} AS label,
              p.base_unit, p.min_stock, p.availability_mode, p.turnover,
              coalesce(b.on_hand, 0)::numeric(14,3) AS on_hand, coalesce(b.reserved, 0)::numeric(14,3) AS reserved,
              (${avail})::numeric(14,3) AS available, coalesce(b.avg_cost_cents, 0) AS avg_cost_cents,
              (p.min_stock > 0 AND ${avail} < p.min_stock) AS below_min
       ${sql} ORDER BY below_min DESC, p.name, v.position, v.sku LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const seeCost = canSeeCost(auth);
    return { items: rows.map((r) => (seeCost ? r : { ...r, avg_cost_cents: undefined })), total, page: q.page, pageSize: q.pageSize };
  });

  // Busca de embalagens para montar pedido de compra e lista de fornecedor.
  app.get('/packagings', async (req) => {
    requirePermission(req, 'stock.view');
    const { q } = z.object({ q: z.string().trim().min(1).max(100) }).parse(req.query);
    const { rows } = await pool.query(
      `SELECT k.id, k.kind, k.label, k.unit_code, k.base_qty, v.id AS variant_id, v.sku, ${VARIANT_LABEL} AS product_name, p.base_unit
       FROM packagings k JOIN product_variants v ON v.id = k.variant_id JOIN products p ON p.id = v.product_id
       WHERE k.active AND v.active AND p.status <> 'inactive'
         AND (p.search_doc LIKE search_text($1) OR v.sku ILIKE $1 OR v.barcode = $2 OR k.barcode = $2)
       ORDER BY p.name, v.sku, k.kind DESC, k.base_qty LIMIT 30`,
      [likePattern(q), q],
    );
    return { items: rows };
  });

  app.get('/variants/:id', async (req) => {
    const auth = requirePermission(req, 'stock.view');
    const { id } = idParams.parse(req.params);
    const v = (
      await pool.query(
        `SELECT v.id AS variant_id, v.sku, ${VARIANT_LABEL} AS label, p.id AS product_id, p.base_unit, p.min_stock, p.availability_mode, u.allows_fraction,
                coalesce(b.on_hand, 0)::numeric(14,3) AS on_hand, coalesce(b.reserved, 0)::numeric(14,3) AS reserved,
                (coalesce(b.on_hand, 0) - coalesce(b.reserved, 0))::numeric(14,3) AS available, coalesce(b.avg_cost_cents, 0) AS avg_cost_cents
         FROM product_variants v JOIN products p ON p.id = v.product_id JOIN units u ON u.code = p.base_unit
         LEFT JOIN stock_balances b ON b.variant_id = v.id WHERE v.id = $1`,
        [id],
      )
    ).rows[0];
    if (!v) throw notFound();
    const movements = (
      await pool.query(
        `SELECT m.id::text, m.kind, m.on_hand_delta, m.reserved_delta, m.on_hand_after, m.reserved_after, m.unit_cost_cents, m.avg_cost_after,
                m.source_type, m.source_id, m.reason, m.created_at, u.name AS created_by_name
         FROM stock_movements m LEFT JOIN users u ON u.id = m.created_by WHERE m.variant_id = $1 ORDER BY m.id DESC LIMIT 100`,
        [id],
      )
    ).rows;
    const reservations = (
      await pool.query(
        `SELECT id, qty, backorder, source_type, source_id, expires_at, created_at FROM stock_reservations WHERE variant_id = $1 AND status = 'active' ORDER BY created_at`,
        [id],
      )
    ).rows;
    const packagings = (
      await pool.query(`SELECT id, kind, label, unit_code, base_qty FROM packagings WHERE variant_id = $1 AND active ORDER BY kind, base_qty`, [id])
    ).rows;
    const seeCost = canSeeCost(auth);
    const strip = <T extends Record<string, unknown>>(r: T) => (seeCost ? r : { ...r, unit_cost_cents: undefined, avg_cost_cents: undefined, avg_cost_after: undefined });
    return { variant: strip(v), movements: movements.map(strip), reservations, packagings };
  });

  app.post('/movements', async (req, reply) => {
    const auth = requirePermission(req, 'stock.manage');
    const b = manualMovement.parse(req.body);
    if (b.kind !== 'adjustment' && b.qty.startsWith('-')) throw new AppError(422, 'INVALID_QTY', 'Informe a quantidade sem sinal; perda e avaria já são saídas.');
    // Perda e avaria sempre saem; devolucao sempre entra; ajuste segue o sinal.
    const delta = b.kind === 'loss' || b.kind === 'damage' ? neg(b.qty) : b.qty;
    const replay = async () => {
      const m = (await pool.query('SELECT id::text, variant_id, kind, on_hand_delta, on_hand_after FROM stock_movements WHERE request_key = $1', [b.requestKey])).rows[0];
      if (m && m.variant_id !== b.variantId) throw new AppError(409, 'REQUEST_KEY_REUSED', 'Chave de requisição já usada em outro lançamento.');
      return m;
    };
    const previous = await replay();
    if (previous) return reply.code(200).send({ movement: previous, replayed: true });
    try {
      const movement = await tx(auth.userId, async (db) => {
        const info = await variantInfo(db, b.variantId);
        assertWhole(info, b.qty);
        const m = await moveStock(db, auth.userId, { variantId: b.variantId, kind: b.kind, onHandDelta: delta, sourceType: 'manual', reason: b.reason, requestKey: b.requestKey });
        await audit(db, { actorId: auth.userId, action: `stock.${b.kind}`, entity: 'variant', entityId: b.variantId, after: { delta, reason: b.reason, onHandAfter: m.on_hand_after }, ip: req.ip });
        return m;
      });
      return reply.code(201).send({ movement });
    } catch (err) {
      if (isUniqueViolation(err, 'stock_movements_request_key_key')) return reply.code(200).send({ movement: await replay(), replayed: true });
      throw err;
    }
  });

  app.post('/reservations', async (req, reply) => {
    const auth = requirePermission(req, 'stock.manage');
    const b = reservationBody.parse(req.body);
    const expiresAt = b.expiresInHours ? new Date(Date.now() + b.expiresInHours * 3_600_000) : null;
    const reservation = await tx(auth.userId, async (db) => {
      const r = await reserve(db, auth.userId, { variantId: b.variantId, qty: b.qty, sourceType: b.sourceType, sourceId: b.sourceId, expiresAt });
      await audit(db, { actorId: auth.userId, action: 'stock.reserved', entity: 'reservation', entityId: r.id, after: r, ip: req.ip });
      return r;
    });
    return reply.code(201).send({ reservation });
  });

  app.post('/reservations/:id/release', async (req) => {
    const auth = requirePermission(req, 'stock.manage');
    const { id } = idParams.parse(req.params);
    return tx(auth.userId, async (db) => {
      const r = await releaseReservation(db, auth.userId, id);
      if (r.changed) await audit(db, { actorId: auth.userId, action: 'stock.reservation_released', entity: 'reservation', entityId: id, ip: req.ip });
      return { reservation: r.reservation };
    });
  });

  // Baixa manual de uma reserva (retirada no balcao, orcamento entregue). Pedidos da loja baixam pelo fluxo do pedido.
  app.post('/reservations/:id/consume', async (req) => {
    const auth = requirePermission(req, 'stock.manage');
    const { id } = idParams.parse(req.params);
    return tx(auth.userId, async (db) => {
      const r = await consumeReservation(db, auth.userId, id, { sourceType: 'manual', sourceId: id });
      if (r.changed) await audit(db, { actorId: auth.userId, action: 'stock.reservation_consumed', entity: 'reservation', entityId: id, ip: req.ip });
      return { reservation: r.reservation };
    });
  });
}
