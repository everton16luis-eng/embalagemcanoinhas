import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation, likePattern, pageQuery } from '../lib/http.js';
import { activeWarehouse, assertWhole, consumeReservation, qty, releaseReservation, reserve, signedQty, variantInfo } from '../lib/stock.js';
import { adjustStock, holdStock, reverseMovement } from '../lib/stock-ops.js';
import { requireAnyPermission, requirePermission, type Auth } from './auth.js';

const requestKey = z.string().trim().min(8).max(100);
/** Custo e informacao de compra: quem so vende ve saldo, nao custo. */
export const canSeeCost = (auth: Auth) => auth.permissions.has('purchases.view') || auth.permissions.has('finance.view');

const VARIANT_LABEL = `p.name || CASE WHEN v.attributes = '{}'::jsonb THEN '' ELSE ' — ' || (SELECT string_agg(value, ' / ' ORDER BY key) FROM jsonb_each_text(v.attributes)) END`;

const listQuery = pageQuery.extend({
  q: z.string().trim().max(100).optional(),
  categoryId: z.uuid().optional(),
  // below: abaixo do minimo; out: sem disponivel; reserved: com reserva; backorder: reservado alem do fisico
  filter: z.enum(['all', 'below', 'out', 'reserved', 'backorder', 'held']).default('all'),
  // Fase 3: saldos de um deposito. Sem ele, o total (como antes).
  warehouseId: z.uuid().optional(),
});

const manualMovement = z.strictObject({
  variantId: z.uuid(),
  // Entrada sem compra (devolucao), perda, avaria ou ajuste (positivo ou negativo).
  kind: z.enum(['return', 'loss', 'damage', 'adjustment']),
  qty: signedQty,
  reason: z.string().trim().min(3).max(300),
  requestKey,
  // Fase 3: deposito do lancamento. Sem ele, o padrao.
  warehouseId: z.uuid().nullable().optional(),
});

const countQty = z.string().trim().regex(/^\d{1,11}(\.\d{1,3})?$/, 'Quantidade inválida.');

// Fase 3: bloqueio/quarentena, avaria e liberacao num deposito.
const holdBody = z.strictObject({
  variantId: z.uuid(),
  warehouseId: z.uuid().nullable().optional(),
  op: z.enum(['block', 'unblock', 'damage_hold', 'damage_release', 'damage_write_off']),
  qty,
  reason: z.string().trim().min(3).max(300),
  documentRef: z.string().trim().max(60).nullable().optional(),
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
    // Com deposito: saldo daquele deposito e minimo do deposito (localizacao, minimo e maximo por deposito).
    // Sem deposito: saldo total e minimo geral do produto, exatamente como antes da Fase 3.
    let from = 'FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN stock_balances b ON b.variant_id = v.id';
    let minExpr = 'CASE WHEN p.min_stock > 0 THEN p.min_stock END';
    let extra = 'NULL::text AS bin, NULL::numeric AS max_qty';
    if (q.warehouseId) {
      params.push(q.warehouseId);
      const w = `$${params.length}`;
      from = `FROM product_variants v JOIN products p ON p.id = v.product_id
              LEFT JOIN stock_location_balances b ON b.variant_id = v.id AND b.warehouse_id = ${w}
              LEFT JOIN stock_location_settings s ON s.variant_id = v.id AND s.warehouse_id = ${w}`;
      minExpr = 's.min_qty';
      extra = 's.bin, s.max_qty';
    }
    const below = `(${minExpr} IS NOT NULL AND ${avail} < ${minExpr})`;
    if (q.filter === 'below') where.push(below);
    if (q.filter === 'out') where.push(`${avail} <= 0`);
    if (q.filter === 'reserved') where.push('coalesce(b.reserved, 0) > 0');
    if (q.filter === 'backorder') where.push(`${avail} < 0`);
    if (q.filter === 'held') where.push('(coalesce(b.blocked, 0) > 0 OR coalesce(b.damaged, 0) > 0 OR coalesce(b.in_transit, 0) > 0)');
    const sql = `${from} WHERE ${where.join(' AND ')}`;
    const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n ${sql}`, params)).rows[0]!.n;
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const { rows } = await pool.query(
      `SELECT v.id AS variant_id, v.sku, v.attributes, p.id AS product_id, p.name AS product_name, ${VARIANT_LABEL} AS label,
              p.base_unit, p.min_stock, p.availability_mode, p.turnover,
              coalesce(b.on_hand, 0)::numeric(14,3) AS on_hand, coalesce(b.reserved, 0)::numeric(14,3) AS reserved,
              coalesce(b.blocked, 0)::numeric(14,3) AS blocked, coalesce(b.damaged, 0)::numeric(14,3) AS damaged,
              coalesce(b.in_transit, 0)::numeric(14,3) AS in_transit,
              (${avail})::numeric(14,3) AS available, coalesce(sb.avg_cost_cents, 0) AS avg_cost_cents,
              ${below} AS below_min, ${minExpr} AS min_qty, ${extra}
       ${sql.replace(' WHERE ', ' LEFT JOIN stock_balances sb ON sb.variant_id = v.id WHERE ')}
       ORDER BY below_min DESC, p.name, v.position, v.sku LIMIT $${params.length - 1} OFFSET $${params.length}`,
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
                coalesce(b.blocked, 0)::numeric(14,3) AS blocked, coalesce(b.damaged, 0)::numeric(14,3) AS damaged,
                coalesce(b.in_transit, 0)::numeric(14,3) AS in_transit,
                (coalesce(b.on_hand, 0) - coalesce(b.reserved, 0))::numeric(14,3) AS available, coalesce(b.avg_cost_cents, 0) AS avg_cost_cents
         FROM product_variants v JOIN products p ON p.id = v.product_id JOIN units u ON u.code = p.base_unit
         LEFT JOIN stock_balances b ON b.variant_id = v.id WHERE v.id = $1`,
        [id],
      )
    ).rows[0];
    if (!v) throw notFound();
    // Fase 3: um quadro por deposito ativo (e por desativado que ainda tenha linha), com localizacao, minimo e maximo.
    const locations = (
      await pool.query(
        `SELECT w.id AS warehouse_id, w.code, w.name, w.is_default, w.active,
                coalesce(l.on_hand, 0)::numeric(14,3) AS on_hand, coalesce(l.reserved, 0)::numeric(14,3) AS reserved,
                coalesce(l.blocked, 0)::numeric(14,3) AS blocked, coalesce(l.damaged, 0)::numeric(14,3) AS damaged,
                coalesce(l.in_transit, 0)::numeric(14,3) AS in_transit,
                (coalesce(l.on_hand, 0) - coalesce(l.reserved, 0))::numeric(14,3) AS available,
                s.bin, s.min_qty, s.max_qty,
                coalesce((SELECT array_agg(a.alert) FROM stock_location_alerts a WHERE a.warehouse_id = w.id AND a.variant_id = $1), '{}') AS alerts
         FROM warehouses w
         LEFT JOIN stock_location_balances l ON l.warehouse_id = w.id AND l.variant_id = $1
         LEFT JOIN stock_location_settings s ON s.warehouse_id = w.id AND s.variant_id = $1
         WHERE w.active OR l.variant_id IS NOT NULL
         ORDER BY w.is_default DESC, w.name`,
        [id],
      )
    ).rows;
    const movements = (
      await pool.query(
        `SELECT m.id::text, m.kind, m.on_hand_delta, m.reserved_delta, m.on_hand_after, m.reserved_after, m.unit_cost_cents, m.avg_cost_after,
                m.blocked_delta, m.damaged_delta, m.in_transit_delta, m.document_ref, m.reverses_id::text, m.transfer_id,
                m.source_type, m.source_id, m.reason, m.created_at, u.name AS created_by_name,
                coalesce(w.name, dw.name) AS warehouse_name, cw.name AS counter_warehouse_name,
                EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_id = m.id) AS reversed,
                (m.kind IN ('adjustment', 'loss', 'damage', 'return', 'block', 'unblock', 'damage_hold', 'damage_release')
                  AND m.source_type IN ('manual', 'adjustment_request')) AS reversible
         FROM stock_movements m LEFT JOIN users u ON u.id = m.created_by
         LEFT JOIN warehouses w ON w.id = m.warehouse_id
         LEFT JOIN warehouses dw ON dw.is_default AND m.warehouse_id IS NULL
         LEFT JOIN warehouses cw ON cw.id = m.counter_warehouse_id
         WHERE m.variant_id = $1 ORDER BY m.id DESC LIMIT 100`,
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
    return { variant: strip(v), locations, movements: movements.map(strip), reservations, packagings };
  });

  app.post('/movements', async (req, reply) => {
    const peek = manualMovement.safeParse(req.body);
    // D3-2: ajuste, perda e avaria exigem stock.adjust (com MFA); quem so tem stock.manage abre solicitacao.
    // Devolucao de cliente (entrada) continua com stock.manage.
    const auth = requirePermission(req, peek.success && peek.data.kind === 'return' ? 'stock.manage' : 'stock.adjust');
    const b = manualMovement.parse(req.body);
    if (b.kind !== 'adjustment' && b.qty.startsWith('-')) throw new AppError(422, 'INVALID_QTY', 'Informe a quantidade sem sinal; perda e avaria já são saídas.');
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
        const warehouse = await activeWarehouse(db, b.warehouseId);
        const m = await adjustStock(db, auth.userId, { warehouse, variantId: b.variantId, kind: b.kind, qty: b.qty, reason: b.reason, requestKey: b.requestKey, sourceType: 'manual' });
        await audit(db, {
          actorId: auth.userId,
          action: `stock.${b.kind}`,
          entity: 'variant',
          entityId: b.variantId,
          after: { delta: m.on_hand_delta, reason: b.reason, onHandAfter: m.on_hand_after, warehouse: warehouse.code },
          ip: req.ip,
        });
        return m;
      });
      return reply.code(201).send({ movement });
    } catch (err) {
      if (isUniqueViolation(err, 'stock_movements_request_key_key')) return reply.code(200).send({ movement: await replay(), replayed: true });
      throw err;
    }
  });

  // ---- SGLog Fase 3 (docs/20-sglog-fase3.md) ------------------------------------------------------------------

  /** Movimento ja gravado com esta chave (duplo clique): devolve-o em vez de gravar de novo. */
  const replayByKey = async (key: string, variantId: string) => {
    const m = (await pool.query('SELECT id::text, variant_id, kind, on_hand_delta, on_hand_after FROM stock_movements WHERE request_key = $1', [key])).rows[0];
    if (m && m.variant_id !== variantId) throw new AppError(409, 'REQUEST_KEY_REUSED', 'Chave de requisição já usada em outro lançamento.');
    return m;
  };

  // Bloqueio/quarentena, avaria e liberacao num deposito; baixa do avariado exige stock.adjust (com MFA).
  app.post('/holds', async (req, reply) => {
    requireAnyPermission(req, 'stock.manage', 'stock.adjust');
    const b = holdBody.parse(req.body);
    const auth = requirePermission(req, b.op === 'damage_write_off' ? 'stock.adjust' : 'stock.manage');
    const previous = await replayByKey(b.requestKey, b.variantId);
    if (previous) return reply.code(200).send({ movement: previous, replayed: true });
    try {
      const movement = await tx(auth.userId, async (db) => {
        const r = await holdStock(db, auth.userId, b);
        await audit(db, {
          actorId: auth.userId,
          action: `stock.${b.op}`,
          entity: 'variant',
          entityId: b.variantId,
          after: { qty: b.qty, reason: b.reason, warehouse: r.warehouse.code, documentRef: b.documentRef ?? null },
          ip: req.ip,
        });
        return r.movement;
      });
      return reply.code(201).send({ movement });
    } catch (err) {
      if (isUniqueViolation(err, 'stock_movements_request_key_key')) return reply.code(200).send({ movement: await replayByKey(b.requestKey, b.variantId), replayed: true });
      throw err;
    }
  });

  // Estorno auditavel: movimento novo com os deltas opostos; o original fica intacto. Um estorno por movimento.
  app.post('/movements/:id/reverse', async (req, reply) => {
    const auth = requirePermission(req, 'stock.adjust');
    const { id } = z.object({ id: z.string().regex(/^\d{1,18}$/) }).parse(req.params);
    const b = z.strictObject({ reason: z.string().trim().min(3).max(300), requestKey }).parse(req.body);
    const prev = (await pool.query('SELECT id::text, reverses_id::text, kind, on_hand_delta FROM stock_movements WHERE request_key = $1', [b.requestKey])).rows[0];
    if (prev) {
      if (prev.reverses_id !== id) throw new AppError(409, 'REQUEST_KEY_REUSED', 'Chave de requisição já usada em outro lançamento.');
      return reply.code(200).send({ movement: prev, replayed: true });
    }
    const movement = await tx(auth.userId, async (db) => {
      const m = await reverseMovement(db, auth.userId, id, b.reason, b.requestKey);
      await audit(db, { actorId: auth.userId, action: 'stock.reversal', entity: 'variant', entityId: m.variant_id, after: { reverses: id, reason: b.reason, movementId: m.id }, ip: req.ip });
      return m;
    });
    return reply.code(201).send({ movement });
  });

  // Localizacao, minimo e maximo da variante num deposito.
  app.put('/locations/:warehouseId/:variantId', async (req) => {
    const auth = requirePermission(req, 'stock.manage');
    const p = z.object({ warehouseId: z.uuid(), variantId: z.uuid() }).parse(req.params);
    const b = z
      .strictObject({
        bin: z.string().trim().max(40).nullable().optional().transform((v) => (v ? v : null)),
        minQty: countQty.nullable().optional().transform((v) => v ?? null),
        maxQty: countQty.nullable().optional().transform((v) => v ?? null),
      })
      .parse(req.body);
    if (b.minQty !== null && b.maxQty !== null && Number(b.maxQty) < Number(b.minQty)) throw new AppError(422, 'INVALID_RANGE', 'O máximo não pode ser menor que o mínimo.');
    if (b.maxQty !== null && Number(b.maxQty) === 0) throw new AppError(422, 'INVALID_RANGE', 'O máximo precisa ser maior que zero.');
    return tx(auth.userId, async (db) => {
      const wh = await activeWarehouse(db, p.warehouseId);
      const info = await variantInfo(db, p.variantId);
      if (b.minQty) assertWhole(info, b.minQty);
      if (b.maxQty) assertWhole(info, b.maxQty);
      const before = (await db.query('SELECT bin, min_qty, max_qty FROM stock_location_settings WHERE warehouse_id = $1 AND variant_id = $2 FOR UPDATE', [wh.id, p.variantId])).rows[0] ?? null;
      const after = (
        await db.query(
          `INSERT INTO stock_location_settings (warehouse_id, variant_id, bin, min_qty, max_qty, updated_by) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (warehouse_id, variant_id) DO UPDATE SET bin = EXCLUDED.bin, min_qty = EXCLUDED.min_qty, max_qty = EXCLUDED.max_qty,
             updated_by = EXCLUDED.updated_by, updated_at = now()
           RETURNING warehouse_id, variant_id, bin, min_qty, max_qty`,
          [wh.id, p.variantId, b.bin, b.minQty, b.maxQty, auth.userId],
        )
      ).rows[0];
      await audit(db, { actorId: auth.userId, action: 'stock.location_settings', entity: 'variant', entityId: p.variantId, before, after: { ...after, warehouse: wh.code }, ip: req.ip });
      return { settings: after };
    });
  });

  // Alertas de minimo e maximo por deposito (so no painel nesta fase; D3-7).
  app.get('/alerts', async (req) => {
    requirePermission(req, 'stock.view');
    const q = pageQuery.extend({ warehouseId: z.uuid().optional(), alert: z.enum(['below_min', 'above_max']).optional() }).parse(req.query);
    const where = ['true'];
    const params: unknown[] = [];
    if (q.warehouseId) {
      params.push(q.warehouseId);
      where.push(`a.warehouse_id = $${params.length}`);
    }
    if (q.alert) {
      params.push(q.alert);
      where.push(`a.alert = $${params.length}`);
    }
    const sql = `FROM stock_location_alerts a JOIN warehouses w ON w.id = a.warehouse_id JOIN product_variants v ON v.id = a.variant_id
                 JOIN products p ON p.id = v.product_id WHERE ${where.join(' AND ')}`;
    const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n ${sql}`, params)).rows[0]!.n;
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const { rows } = await pool.query(
      `SELECT a.alert, a.warehouse_id, w.name AS warehouse_name, a.variant_id, v.sku, ${VARIANT_LABEL} AS label, p.base_unit,
              a.on_hand, a.reserved, a.in_transit, a.available, a.min_qty, a.max_qty
       ${sql} ORDER BY a.alert, w.name, p.name, v.sku LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: rows, total, page: q.page, pageSize: q.pageSize };
  });

  // Solicitacoes de ajuste (D3-2): pede quem movimenta estoque; aprova quem tem stock.adjust, nunca a propria.
  const REQ_COLS = `r.id, r.number, r.kind, r.qty, r.reason, r.status, r.requested_at, r.decided_at, r.decision_note, r.movement_id::text,
    r.warehouse_id, w.name AS warehouse_name, r.variant_id, v.sku, ${VARIANT_LABEL} AS label, p.base_unit,
    r.requested_by, ru.name AS requested_by_name, du.name AS decided_by_name`;
  const REQ_FROM = `FROM stock_adjustment_requests r JOIN warehouses w ON w.id = r.warehouse_id JOIN product_variants v ON v.id = r.variant_id
    JOIN products p ON p.id = v.product_id JOIN users ru ON ru.id = r.requested_by LEFT JOIN users du ON du.id = r.decided_by`;
  const loadRequest = async (id: string) => (await pool.query(`SELECT ${REQ_COLS} ${REQ_FROM} WHERE r.id = $1`, [id])).rows[0];

  app.get('/adjustment-requests', async (req) => {
    requirePermission(req, 'stock.view');
    const q = pageQuery.extend({ status: z.enum(['pending', 'approved', 'rejected', 'canceled', 'all']).default('pending'), variantId: z.uuid().optional() }).parse(req.query);
    const where = ['true'];
    const params: unknown[] = [];
    if (q.status !== 'all') {
      params.push(q.status);
      where.push(`r.status = $${params.length}`);
    }
    if (q.variantId) {
      params.push(q.variantId);
      where.push(`r.variant_id = $${params.length}`);
    }
    const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM stock_adjustment_requests r WHERE ${where.join(' AND ')}`, params)).rows[0]!.n;
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const { rows } = await pool.query(`SELECT ${REQ_COLS} ${REQ_FROM} WHERE ${where.join(' AND ')} ORDER BY r.requested_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { items: rows, total, page: q.page, pageSize: q.pageSize };
  });

  app.post('/adjustment-requests', async (req, reply) => {
    const auth = requirePermission(req, 'stock.manage');
    const b = z
      .strictObject({ variantId: z.uuid(), warehouseId: z.uuid().nullable().optional(), kind: z.enum(['adjustment', 'loss', 'damage']), qty: signedQty, reason: z.string().trim().min(3).max(300), requestKey })
      .parse(req.body);
    if (b.kind !== 'adjustment' && b.qty.startsWith('-')) throw new AppError(422, 'INVALID_QTY', 'Informe a quantidade sem sinal; perda e avaria já são saídas.');
    const prev = (await pool.query<{ id: string; variant_id: string }>('SELECT id, variant_id FROM stock_adjustment_requests WHERE request_key = $1', [b.requestKey])).rows[0];
    if (prev) {
      if (prev.variant_id !== b.variantId) throw new AppError(409, 'REQUEST_KEY_REUSED', 'Chave de requisição já usada em outra solicitação.');
      return reply.code(200).send({ request: await loadRequest(prev.id), replayed: true });
    }
    const id = await tx(auth.userId, async (db) => {
      const wh = await activeWarehouse(db, b.warehouseId);
      assertWhole(await variantInfo(db, b.variantId), b.qty);
      const r = (
        await db.query<{ id: string; number: number }>(
          `INSERT INTO stock_adjustment_requests (warehouse_id, variant_id, kind, qty, reason, request_key, requested_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, number`,
          [wh.id, b.variantId, b.kind, b.qty, b.reason, b.requestKey, auth.userId],
        )
      ).rows[0]!;
      await audit(db, { actorId: auth.userId, action: 'stock.adjustment_requested', entity: 'stock_adjustment_request', entityId: r.id, after: { number: r.number, kind: b.kind, qty: b.qty, reason: b.reason, warehouse: wh.code }, ip: req.ip });
      return r.id;
    });
    return reply.code(201).send({ request: await loadRequest(id) });
  });

  const decide = (action: 'approve' | 'reject' | 'cancel') => async (req: FastifyRequest) => {
    const auth = action === 'cancel' ? requireAnyPermission(req, 'stock.manage', 'stock.adjust') : requirePermission(req, 'stock.adjust');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ note: z.string().trim().max(300).nullable().optional() }).parse(req.body ?? {});
    if (action === 'reject' && !b.note?.trim()) throw new AppError(422, 'REASON_REQUIRED', 'Informe o motivo da recusa.');
    await tx(auth.userId, async (db) => {
      const r = (
        await db.query<{ id: string; number: number; status: string; kind: 'adjustment' | 'loss' | 'damage'; qty: string; reason: string; requested_by: string; variant_id: string; warehouse_id: string }>(
          'SELECT id, number, status, kind, qty, reason, requested_by, variant_id, warehouse_id FROM stock_adjustment_requests WHERE id = $1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!r) throw notFound();
      if (r.status !== 'pending') throw new AppError(409, 'REQUEST_CLOSED', `A solicitação nº ${r.number} já foi decidida ou cancelada.`);
      if (action === 'cancel') {
        if (r.requested_by !== auth.userId && !auth.permissions.has('stock.adjust')) throw new AppError(403, 'FORBIDDEN', 'Só quem pediu ou um aprovador pode cancelar.');
        await db.query(`UPDATE stock_adjustment_requests SET status = 'canceled', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [id, auth.userId, b.note ?? null]);
      } else {
        if (r.requested_by === auth.userId) throw new AppError(403, 'FOUR_EYES', 'Quem pediu o ajuste não pode decidir a própria solicitação.');
        if (action === 'reject') {
          await db.query(`UPDATE stock_adjustment_requests SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [id, auth.userId, b.note]);
        } else {
          const wh = await activeWarehouse(db, r.warehouse_id);
          const m = await adjustStock(db, auth.userId, { warehouse: wh, variantId: r.variant_id, kind: r.kind, qty: r.qty, reason: `${r.reason.slice(0, 260)} (solicitação nº ${r.number})`, sourceType: 'adjustment_request', sourceId: r.id });
          await db.query(`UPDATE stock_adjustment_requests SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3, movement_id = $4 WHERE id = $1`, [id, auth.userId, b.note ?? null, m.id]);
        }
      }
      await audit(db, { actorId: auth.userId, action: `stock.adjustment_${action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'canceled'}`, entity: 'stock_adjustment_request', entityId: id, metadata: { number: r.number, note: b.note ?? null }, ip: req.ip });
    });
    return { request: await loadRequest(id) };
  };
  app.post('/adjustment-requests/:id/approve', decide('approve'));
  app.post('/adjustment-requests/:id/reject', decide('reject'));
  app.post('/adjustment-requests/:id/cancel', decide('cancel'));

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
