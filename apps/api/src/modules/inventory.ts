import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation, pageQuery } from '../lib/http.js';
import { assertWhole, moveStock, variantInfo } from '../lib/stock.js';
import { requirePermission } from './auth.js';

const countQty = z.string().trim().regex(/^\d{1,11}(\.\d{1,3})?$/, 'Quantidade inválida.');

async function load(db: Db | typeof pool, id: string, showSystem: boolean) {
  const count = (
    await db.query(
      `SELECT c.id, c.status, c.notes, c.created_at, c.closed_at, u.name AS created_by_name, cu.name AS closed_by_name
       FROM inventory_counts c JOIN users u ON u.id = c.created_by LEFT JOIN users cu ON cu.id = c.closed_by WHERE c.id = $1`,
      [id],
    )
  ).rows[0];
  if (!count) return null;
  // Contagem cega: enquanto aberta, quem conta nao ve o saldo do sistema (so quem administra).
  count.items = (
    await db.query(
      `SELECT i.variant_id, v.sku, p.name AS product_name, v.attributes, p.base_unit, i.counted_qty, i.counted_at, i.system_qty, i.diff_qty,
              CASE WHEN $2 THEN coalesce(b.on_hand, 0)::numeric(14,3) END AS current_on_hand
       FROM inventory_count_items i JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
       LEFT JOIN stock_balances b ON b.variant_id = i.variant_id WHERE i.count_id = $1 ORDER BY p.name, v.sku`,
      [id, showSystem],
    )
  ).rows;
  return count;
}

export async function inventoryRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    requirePermission(req, 'stock.view');
    const q = pageQuery.parse(req.query);
    const total = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM inventory_counts')).rows[0]!.n;
    const { rows } = await pool.query(
      `SELECT c.id, c.status, c.notes, c.created_at, c.closed_at, u.name AS created_by_name,
              (SELECT count(*)::int FROM inventory_count_items i WHERE i.count_id = c.id) AS item_count,
              (SELECT count(*)::int FROM inventory_count_items i WHERE i.count_id = c.id AND i.counted_qty IS NOT NULL) AS counted_count,
              (SELECT count(*)::int FROM inventory_count_items i WHERE i.count_id = c.id AND i.diff_qty <> 0) AS diff_count
       FROM inventory_counts c JOIN users u ON u.id = c.created_by ORDER BY c.created_at DESC LIMIT $1 OFFSET $2`,
      [q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { items: rows, total, page: q.page, pageSize: q.pageSize };
  });

  app.get('/:id', async (req) => {
    const auth = requirePermission(req, 'stock.view');
    const { id } = idParams.parse(req.params);
    const count = await load(pool, id, auth.permissions.has('stock.manage'));
    if (!count) throw notFound();
    return { count };
  });

  /** Abre contagem de todas as variacoes ativas, de uma categoria ou de uma lista. */
  app.post('/', async (req, reply) => {
    const auth = requirePermission(req, 'stock.manage');
    const b = z
      .strictObject({ notes: z.string().trim().max(1000).nullable().optional(), categoryId: z.uuid().optional(), variantIds: z.array(z.uuid()).max(2000).optional() })
      .parse(req.body);
    try {
      const count = await tx(auth.userId, async (db) => {
        const { rows } = await db.query<{ id: string }>('INSERT INTO inventory_counts (notes, created_by) VALUES ($1, $2) RETURNING id', [b.notes ?? null, auth.userId]);
        const id = rows[0]!.id;
        const added = await db.query(
          `INSERT INTO inventory_count_items (count_id, variant_id)
           SELECT $1, v.id FROM product_variants v JOIN products p ON p.id = v.product_id
           WHERE v.active AND p.status <> 'inactive' AND p.availability_mode = 'stock'
             AND ($2::uuid IS NULL OR p.category_id IN (WITH RECURSIVE t AS (SELECT id FROM categories WHERE id = $2 UNION ALL SELECT c.id FROM categories c JOIN t ON c.parent_id = t.id) SELECT id FROM t))
             AND ($3::uuid[] IS NULL OR v.id = ANY($3))`,
          [id, b.categoryId ?? null, b.variantIds ?? null],
        );
        if (!added.rowCount) throw new AppError(422, 'EMPTY_COUNT', 'Nenhum produto em estoque corresponde à seleção.');
        await audit(db, { actorId: auth.userId, action: 'inventory.opened', entity: 'inventory_count', entityId: id, metadata: { items: added.rowCount }, ip: req.ip });
        return load(db, id, true);
      });
      return reply.code(201).send({ count });
    } catch (err) {
      if (isUniqueViolation(err, 'inventory_counts_one_open')) throw new AppError(409, 'COUNT_OPEN', 'Já existe uma contagem aberta. Feche ou cancele antes de abrir outra.');
      throw err;
    }
  });

  // Lancamento das quantidades contadas. Pode ser feito em partes, por varias pessoas.
  app.put('/:id/items', async (req) => {
    const auth = requirePermission(req, 'stock.manage');
    const { id } = idParams.parse(req.params);
    const items = z.array(z.strictObject({ variantId: z.uuid(), countedQty: countQty.nullable() })).min(1).max(2000).parse(req.body);
    await tx(auth.userId, async (db) => {
      const c = (await db.query<{ status: string }>('SELECT status FROM inventory_counts WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!c) throw notFound();
      if (c.status !== 'open') throw new AppError(409, 'COUNT_CLOSED', 'Contagem já encerrada.');
      for (const it of items) {
        if (it.countedQty !== null) assertWhole(await variantInfo(db, it.variantId), it.countedQty);
        const r = await db.query(
          `UPDATE inventory_count_items SET counted_qty = $3, counted_by = CASE WHEN $3::numeric IS NULL THEN NULL ELSE $4::uuid END,
             counted_at = CASE WHEN $3::numeric IS NULL THEN NULL ELSE now() END WHERE count_id = $1 AND variant_id = $2`,
          [id, it.variantId, it.countedQty, auth.userId],
        );
        if (!r.rowCount) throw new AppError(422, 'NOT_IN_COUNT', 'Item fora desta contagem.');
      }
    });
    return { count: await load(pool, id, true) };
  });

  /**
   * Fecha: compara o contado com o saldo fisico do momento e lanca a diferenca como movimento
   * de inventario. Item nao contado fica como esta. Reservas nao mudam: o que esta separado
   * para pedidos deve ser contado junto.
   */
  app.post('/:id/close', async (req) => {
    const auth = requirePermission(req, 'stock.manage');
    const { id } = idParams.parse(req.params);
    return tx(auth.userId, async (db) => {
      const c = (await db.query<{ status: string }>('SELECT status FROM inventory_counts WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!c) throw notFound();
      if (c.status !== 'open') throw new AppError(409, 'COUNT_CLOSED', 'Contagem já encerrada.');
      const items = (
        await db.query<{ variant_id: string; counted_qty: string }>('SELECT variant_id, counted_qty FROM inventory_count_items WHERE count_id = $1 AND counted_qty IS NOT NULL ORDER BY variant_id', [id])
      ).rows;
      if (!items.length) throw new AppError(422, 'NOTHING_COUNTED', 'Nenhum item foi contado.');
      let adjusted = 0;
      for (const it of items) {
        await db.query('INSERT INTO stock_balances (variant_id) VALUES ($1) ON CONFLICT DO NOTHING', [it.variant_id]);
        const { system, diff } = (
          await db.query<{ system: string; diff: string }>('SELECT on_hand::text AS system, ($2::numeric - on_hand)::text AS diff FROM stock_balances WHERE variant_id = $1 FOR UPDATE', [
            it.variant_id,
            it.counted_qty,
          ])
        ).rows[0]!;
        await db.query('UPDATE inventory_count_items SET system_qty = $3, diff_qty = $4 WHERE count_id = $1 AND variant_id = $2', [id, it.variant_id, system, diff]);
        if (Number(diff) !== 0) {
          adjusted++;
          await moveStock(db, auth.userId, { variantId: it.variant_id, kind: 'inventory', onHandDelta: diff, sourceType: 'inventory', sourceId: id, reason: 'Contagem de inventário' });
        }
      }
      await db.query(`UPDATE inventory_counts SET status = 'closed', closed_by = $2, closed_at = now() WHERE id = $1`, [id, auth.userId]);
      await audit(db, { actorId: auth.userId, action: 'inventory.closed', entity: 'inventory_count', entityId: id, metadata: { counted: items.length, adjusted }, ip: req.ip });
      return { count: await load(db, id, true) };
    });
  });

  app.post('/:id/cancel', async (req) => {
    const auth = requirePermission(req, 'stock.manage');
    const { id } = idParams.parse(req.params);
    return tx(auth.userId, async (db) => {
      const r = await db.query(`UPDATE inventory_counts SET status = 'canceled', closed_by = $2, closed_at = now() WHERE id = $1 AND status = 'open'`, [id, auth.userId]);
      if (!r.rowCount) throw new AppError(409, 'COUNT_CLOSED', 'Contagem inexistente ou já encerrada.');
      await audit(db, { actorId: auth.userId, action: 'inventory.canceled', entity: 'inventory_count', entityId: id, ip: req.ip });
      return { count: await load(db, id, true) };
    });
  });
}
