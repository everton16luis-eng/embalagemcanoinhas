// SGLog Fase 3: transferencias entre depositos em duas etapas (docs/20-sglog-fase3.md §1.2).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation, pageQuery } from '../lib/http.js';
import { qty } from '../lib/stock.js';
import { cancelTransfer, sendTransfer, settleTransfer, type TransferItemInput } from '../lib/stock-ops.js';
import { requirePermission } from './auth.js';

const requestKey = z.string().trim().min(8).max(100);
const reason = z.string().trim().min(3).max(300);
const items = z.array(z.strictObject({ variantId: z.uuid(), qty })).min(1).max(200);

const sendBody = z.strictObject({
  fromWarehouseId: z.uuid(),
  toWarehouseId: z.uuid(),
  items,
  notes: z.string().trim().max(1000).nullable().optional(),
  documentRef: z.string().trim().max(60).nullable().optional(),
  // Operacao interna: envia e recebe na mesma hora, com os dois eventos no historico.
  receiveNow: z.boolean().default(false),
  requestKey,
});
const receiveBody = z.strictObject({ items: items.optional(), requestKey });
const settleBody = z.strictObject({ items, reason, requestKey });
const cancelBody = z.strictObject({ reason, requestKey });

const listQuery = pageQuery.extend({
  status: z.enum(['open', 'all', 'in_transit', 'partial', 'received', 'closed_divergent', 'canceled']).default('open'),
  warehouseId: z.uuid().optional(),
});

const VARIANT_LABEL = `p.name || CASE WHEN v.attributes = '{}'::jsonb THEN '' ELSE ' — ' || (SELECT string_agg(value, ' / ' ORDER BY key) FROM jsonb_each_text(v.attributes)) END`;

async function load(id: string) {
  const t = (
    await pool.query(
      `SELECT t.id, t.number, t.status, t.notes, t.document_ref, t.created_at, t.closed_at, t.from_warehouse_id, t.to_warehouse_id,
              f.name AS from_name, d.name AS to_name, u.name AS created_by_name
       FROM stock_transfers t JOIN warehouses f ON f.id = t.from_warehouse_id JOIN warehouses d ON d.id = t.to_warehouse_id
       JOIN users u ON u.id = t.created_by WHERE t.id = $1`,
      [id],
    )
  ).rows[0];
  if (!t) return null;
  t.items = (
    await pool.query(
      `SELECT i.variant_id, v.sku, ${VARIANT_LABEL} AS label, p.base_unit, i.qty_sent, i.qty_received, i.qty_lost, i.qty_returned,
              (i.qty_sent - i.qty_received - i.qty_lost - i.qty_returned)::numeric(14,3) AS qty_pending
       FROM stock_transfer_items i JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
       WHERE i.transfer_id = $1 ORDER BY p.name, v.sku`,
      [id],
    )
  ).rows;
  t.events = (
    await pool.query(
      `SELECT e.id::text, e.kind, e.items, e.reason, e.created_at, u.name AS created_by_name
       FROM stock_transfer_events e JOIN users u ON u.id = e.created_by WHERE e.transfer_id = $1 ORDER BY e.id`,
      [id],
    )
  ).rows;
  return t;
}

/** Repeticao do mesmo pedido (duplo clique, rede): devolve o resultado ja gravado em vez de gravar de novo. */
async function replayEvent(id: string, key: string) {
  const e = (await pool.query<{ transfer_id: string }>('SELECT transfer_id FROM stock_transfer_events WHERE request_key = $1', [key])).rows[0];
  if (!e) return null;
  if (e.transfer_id !== id) throw new AppError(409, 'REQUEST_KEY_REUSED', 'Chave de requisição já usada em outra transferência.');
  return { transfer: await load(id), replayed: true };
}

export async function transferRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    requirePermission(req, 'stock.view');
    const q = listQuery.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status === 'open') where.push(`t.status IN ('in_transit', 'partial')`);
    else if (q.status !== 'all') {
      params.push(q.status);
      where.push(`t.status = $${params.length}`);
    }
    if (q.warehouseId) {
      params.push(q.warehouseId);
      where.push(`(t.from_warehouse_id = $${params.length} OR t.to_warehouse_id = $${params.length})`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM stock_transfers t ${w}`, params)).rows[0]!.n;
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const { rows } = await pool.query(
      `SELECT t.id, t.number, t.status, t.created_at, t.closed_at, f.name AS from_name, d.name AS to_name, u.name AS created_by_name,
              (SELECT count(*)::int FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS item_count,
              (SELECT coalesce(sum(i.qty_sent - i.qty_received - i.qty_lost - i.qty_returned), 0)::numeric(14,3) FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS qty_pending
       FROM stock_transfers t JOIN warehouses f ON f.id = t.from_warehouse_id JOIN warehouses d ON d.id = t.to_warehouse_id JOIN users u ON u.id = t.created_by
       ${w} ORDER BY t.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: rows, total, page: q.page, pageSize: q.pageSize };
  });

  app.get('/:id', async (req) => {
    requirePermission(req, 'stock.view');
    const { id } = idParams.parse(req.params);
    const transfer = await load(id);
    if (!transfer) throw notFound();
    return { transfer };
  });

  app.post('/', async (req, reply) => {
    const auth = requirePermission(req, 'stock.transfer');
    const b = sendBody.parse(req.body);
    const previous = (await pool.query<{ id: string }>('SELECT id FROM stock_transfers WHERE request_key = $1', [b.requestKey])).rows[0];
    if (previous) return reply.code(200).send({ transfer: await load(previous.id), replayed: true });
    try {
      const sent = await tx(auth.userId, async (db) => {
        const r = await sendTransfer(db, auth.userId, b);
        await audit(db, {
          actorId: auth.userId,
          action: b.receiveNow ? 'stock.transfer_sent_received' : 'stock.transfer_sent',
          entity: 'stock_transfer',
          entityId: r.id,
          after: { number: r.number, from: r.from.code, to: r.to.code, items: b.items, documentRef: b.documentRef ?? null },
          ip: req.ip,
        });
        return r;
      });
      return reply.code(201).send({ transfer: await load(sent.id) });
    } catch (err) {
      if (isUniqueViolation(err, 'stock_transfers_request_key_key')) {
        const again = (await pool.query<{ id: string }>('SELECT id FROM stock_transfers WHERE request_key = $1', [b.requestKey])).rows[0]!;
        return reply.code(200).send({ transfer: await load(again.id), replayed: true });
      }
      throw err;
    }
  });

  const settle = (kind: 'receive' | 'loss' | 'return') => async (req: FastifyRequest) => {
    const auth = requirePermission(req, kind === 'loss' ? 'stock.adjust' : 'stock.transfer');
    const { id } = idParams.parse(req.params);
    const b = kind === 'receive' ? { ...receiveBody.parse(req.body), reason: null } : settleBody.parse(req.body);
    const replay = await replayEvent(id, b.requestKey);
    if (replay) return replay;
    try {
      await tx(auth.userId, async (db) => {
        // Recebimento sem itens: tudo o que esta pendente.
        const list: TransferItemInput[] =
          b.items ??
          (
            await db.query<{ variantId: string; qty: string }>(
              `SELECT variant_id AS "variantId", (qty_sent - qty_received - qty_lost - qty_returned)::text AS qty FROM stock_transfer_items
               WHERE transfer_id = $1 AND qty_sent - qty_received - qty_lost - qty_returned > 0`,
              [id],
            )
          ).rows;
        if (!list.length) throw new AppError(409, 'NOTHING_PENDING', 'Nada pendente nesta transferência.');
        const t = await settleTransfer(db, auth.userId, id, kind, list, b.reason, b.requestKey);
        await audit(db, { actorId: auth.userId, action: `stock.transfer_${kind === 'receive' ? 'received' : kind === 'loss' ? 'lost' : 'returned'}`, entity: 'stock_transfer', entityId: id, after: { number: t.number, items: list, reason: b.reason }, ip: req.ip });
      });
    } catch (err) {
      if (isUniqueViolation(err, 'stock_transfer_events_request_key_key')) {
        const again = await replayEvent(id, b.requestKey);
        if (again) return again;
      }
      throw err;
    }
    return { transfer: await load(id) };
  };
  app.post('/:id/receive', settle('receive'));
  app.post('/:id/return', settle('return'));
  app.post('/:id/loss', settle('loss'));

  app.post('/:id/cancel', async (req) => {
    const auth = requirePermission(req, 'stock.adjust');
    const { id } = idParams.parse(req.params);
    const b = cancelBody.parse(req.body);
    const replay = await replayEvent(id, b.requestKey);
    if (replay) return replay;
    await tx(auth.userId, async (db) => {
      const t = await cancelTransfer(db, auth.userId, id, b.reason, b.requestKey);
      await audit(db, { actorId: auth.userId, action: 'stock.transfer_canceled', entity: 'stock_transfer', entityId: id, after: { number: t.number, reason: b.reason }, ip: req.ip });
    });
    return { transfer: await load(id) };
  });
}
