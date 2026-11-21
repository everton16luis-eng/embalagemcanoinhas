// SGLog Fase 9a: ocorrencias logisticas (docs/38-sglog-fase9.md §2).
//
// - Ocorrencia = registro do problema (avaria, extravio, atraso, recusa, item errado, arrependimento, defeito, troca,
//   reembolso, falha na entrega). Tipo e responsavel; sem responsavel definido nao se resolve (R9-1).
// - Transicoes: open -> in_progress -> resolved; open|in_progress -> canceled; resolved -> in_progress (reabrir, com
//   motivo). Tudo com versao (409 em conflito) e chave de requisicao (repetir devolve a ocorrencia sem agir de novo).
// - Aberta e segurando a conclusao: o pedido entregue fica 'on_hold' (gatilho orders_occurrence_hold); resolvida ou
//   cancelada a ultima, o pedido conclui.
// - Abrir uma ocorrencia nunca movimenta estoque, nunca registra reembolso e nunca toca a NF-e.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation, pageQuery } from '../lib/http.js';
import { OCCURRENCE_KINDS, RESPONSIBILITIES, releaseHold } from '../lib/returns.js';
import { requireAnyPermission, requirePermission } from './auth.js';
import { addInternalEvent } from './orders.js';

const key = z.string().min(8).max(100);
const OCC_COLS = `o.id, o.number, o.order_id, ord.number AS order_number, o.shipment_id, s.seq AS shipment_seq, o.order_item_id, oi.sku AS item_sku,
  oi.product_name AS item_name, o.kind, o.responsibility, o.status, o.source, o.blocks_completion, o.description, o.resolution, o.due_at,
  o.resolved_at, o.canceled_reason, o.created_at, o.updated_at, o.version, cu.name AS created_by_name, ru.name AS resolved_by_name`;
const OCC_FROM = `logistic_occurrences o JOIN orders ord ON ord.id = o.order_id LEFT JOIN shipments s ON s.id = o.shipment_id
  LEFT JOIN order_items oi ON oi.id = o.order_item_id LEFT JOIN users cu ON cu.id = o.created_by LEFT JOIN users ru ON ru.id = o.resolved_by`;

export async function occurrenceView(db: Db | typeof pool, id: string) {
  const occurrence = (await db.query(`SELECT ${OCC_COLS} FROM ${OCC_FROM} WHERE o.id = $1`, [id])).rows[0];
  if (!occurrence) throw notFound();
  const events = (
    await db.query(
      `SELECT e.id, e.action, e.from_status, e.to_status, e.note, e.created_at, u.name AS actor_name
       FROM occurrence_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.occurrence_id = $1 ORDER BY e.id`,
      [id],
    )
  ).rows;
  const returns = (await db.query(`SELECT id, number, kind, status, created_at FROM customer_returns WHERE occurrence_id = $1 ORDER BY number`, [id])).rows;
  return { occurrence, events, returns };
}

export async function orderOccurrences(db: Db | typeof pool, orderId: string) {
  return (await db.query(`SELECT ${OCC_COLS} FROM ${OCC_FROM} WHERE o.order_id = $1 ORDER BY o.number`, [orderId])).rows;
}

async function lockOccurrence(db: Db, id: string) {
  const head = (await db.query<{ order_id: string }>('SELECT order_id FROM logistic_occurrences WHERE id = $1', [id])).rows[0];
  if (!head) throw notFound();
  // Pedido antes da ocorrencia: mesma ordem da devolucao e do gatilho de conclusao.
  await db.query('SELECT 1 FROM orders WHERE id = $1 FOR UPDATE', [head.order_id]);
  return (
    await db.query<{ id: string; order_id: string; status: string; responsibility: string; version: number; blocks_completion: boolean }>(
      'SELECT id, order_id, status, responsibility, version, blocks_completion FROM logistic_occurrences WHERE id = $1 FOR UPDATE',
      [id],
    )
  ).rows[0]!;
}

const createSchema = z.strictObject({
  orderId: z.uuid(),
  shipmentId: z.uuid().optional().nullable(),
  orderItemId: z.uuid().optional().nullable(),
  kind: z.enum(OCCURRENCE_KINDS),
  responsibility: z.enum(RESPONSIBILITIES).default('undetermined'),
  description: z.string().trim().min(3).max(1000),
  blocksCompletion: z.boolean().default(true),
  dueAt: z.iso.datetime({ offset: true }).optional().nullable(),
  requestKey: key,
});

/** Abre ocorrencia (painel). Chamar dentro de tx, com o pedido travado. */
export async function openOccurrence(db: Db, actorId: string, b: z.infer<typeof createSchema>) {
  const order = (await db.query<{ id: string; number: number; status: string }>('SELECT id, number, status FROM orders WHERE id = $1 FOR UPDATE', [b.orderId])).rows[0];
  if (!order) throw notFound();
  if (order.status === 'pending_payment') throw new AppError(409, 'ORDER_NOT_PAID', 'O pedido ainda não foi pago: não há entrega a acompanhar.');
  if (b.shipmentId && !(await db.query('SELECT 1 FROM shipments WHERE id = $1 AND order_id = $2', [b.shipmentId, b.orderId])).rows[0]) {
    throw new AppError(422, 'SHIPMENT_NOT_IN_ORDER', 'A remessa não é deste pedido.');
  }
  if (b.orderItemId && !(await db.query('SELECT 1 FROM order_items WHERE id = $1 AND order_id = $2', [b.orderItemId, b.orderId])).rows[0]) {
    throw new AppError(422, 'ITEM_NOT_IN_ORDER', 'O item não é deste pedido.');
  }
  const o = (
    await db.query<{ id: string; number: number }>(
      `INSERT INTO logistic_occurrences (order_id, shipment_id, order_item_id, kind, responsibility, description, blocks_completion, due_at, created_by, request_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, number`,
      [b.orderId, b.shipmentId ?? null, b.orderItemId ?? null, b.kind, b.responsibility, b.description, b.blocksCompletion, b.dueAt ?? null, actorId, b.requestKey],
    )
  ).rows[0]!;
  await db.query(`INSERT INTO occurrence_events (occurrence_id, action, to_status, note, actor_id) VALUES ($1, 'open', 'open', $2, $3)`, [o.id, b.description, actorId]);
  await addInternalEvent(db, b.orderId, order.status, `Ocorrência nº ${o.number} aberta.`, actorId);
  return o;
}

export async function occurrenceRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    requireAnyPermission(req, 'occurrences.manage', 'returns.manage', 'logistics.view', 'orders.view');
    const q = pageQuery
      .extend({
        status: z.enum(['open', 'resolved', 'canceled', 'all']).default('open'),
        kind: z.enum(OCCURRENCE_KINDS).optional(),
        order: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status === 'open') where.push(`o.status IN ('open', 'in_progress')`);
    else if (q.status !== 'all') where.push(`o.status = $${params.push(q.status)}`);
    if (q.kind) where.push(`o.kind = $${params.push(q.kind)}`);
    if (q.order) where.push(`ord.number = $${params.push(q.order)}`);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((await pool.query(`SELECT count(*) AS n FROM ${OCC_FROM} ${w}`, params)).rows[0].n);
    const items = (
      await pool.query(`SELECT ${OCC_COLS}, (o.due_at < now() AND o.status IN ('open', 'in_progress')) AS overdue FROM ${OCC_FROM} ${w} ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
        ...params,
        q.pageSize,
        (q.page - 1) * q.pageSize,
      ])
    ).rows;
    const counts = (
      await pool.query<{ open: number; overdue: number; tracking: number }>(
        `SELECT count(*) FILTER (WHERE status IN ('open', 'in_progress'))::int AS open,
                count(*) FILTER (WHERE status IN ('open', 'in_progress') AND due_at < now())::int AS overdue,
                count(*) FILTER (WHERE status IN ('open', 'in_progress') AND source = 'tracking')::int AS tracking
         FROM logistic_occurrences`,
      )
    ).rows[0];
    return { items, total, page: q.page, pageSize: q.pageSize, counts };
  });

  app.get('/:id', async (req) => {
    requireAnyPermission(req, 'occurrences.manage', 'returns.manage', 'logistics.view', 'orders.view');
    const { id } = idParams.parse(req.params);
    return occurrenceView(pool, id);
  });

  app.post('/', async (req, reply) => {
    const auth = requirePermission(req, 'occurrences.manage');
    const b = createSchema.parse(req.body);
    const prior = (await pool.query<{ id: string }>('SELECT id FROM logistic_occurrences WHERE request_key = $1', [b.requestKey])).rows[0];
    if (prior) return { replayed: true, ...(await occurrenceView(pool, prior.id)) };
    let id: string;
    try {
      id = await tx(auth.userId, async (db) => {
        const o = await openOccurrence(db, auth.userId, b);
        await audit(db, { actorId: auth.userId, action: 'occurrence.open', entity: 'occurrence', entityId: o.id, after: { ...b, requestKey: undefined }, ip: auth.ip });
        return o.id;
      });
    } catch (err) {
      const again = isUniqueViolation(err, 'logistic_occurrences_request_key_key') && (await pool.query<{ id: string }>('SELECT id FROM logistic_occurrences WHERE request_key = $1', [b.requestKey])).rows[0];
      if (again) return { replayed: true, ...(await occurrenceView(pool, again.id)) };
      throw err;
    }
    reply.code(201);
    return { replayed: false, ...(await occurrenceView(pool, id)) };
  });

  app.post('/:id/action', async (req) => {
    const auth = requirePermission(req, 'occurrences.manage');
    const { id } = idParams.parse(req.params);
    const b = z
      .strictObject({
        action: z.enum(['start', 'resolve', 'cancel', 'reopen', 'note', 'responsibility']),
        note: z.string().trim().min(3).max(1000),
        responsibility: z.enum(RESPONSIBILITIES).optional(),
        version: z.number().int(),
        requestKey: key,
      })
      .parse(req.body);
    if ((await pool.query('SELECT 1 FROM occurrence_events WHERE request_key = $1', [b.requestKey])).rows[0]) return { replayed: true, ...(await occurrenceView(pool, id)) };
    try {
      await tx(auth.userId, async (db) => {
        const o = await lockOccurrence(db, id);
        if (o.version !== b.version) throw new AppError(409, 'VERSION_CONFLICT', 'A ocorrência foi alterada por outra pessoa. Recarregue a página.');
        const open = o.status === 'open' || o.status === 'in_progress';
        let to = o.status;
        const resp = b.responsibility ?? o.responsibility;
        switch (b.action) {
          case 'start':
            if (o.status !== 'open') throw new AppError(409, 'INVALID_TRANSITION', 'Só a ocorrência aberta passa para em andamento.');
            to = 'in_progress';
            break;
          case 'resolve':
            if (!open) throw new AppError(409, 'INVALID_TRANSITION', 'A ocorrência já foi encerrada.');
            if (resp === 'undetermined') throw new AppError(422, 'RESPONSIBILITY_REQUIRED', 'Defina o responsável antes de resolver a ocorrência.');
            to = 'resolved';
            break;
          case 'cancel':
            if (!open) throw new AppError(409, 'INVALID_TRANSITION', 'A ocorrência já foi encerrada.');
            to = 'canceled';
            break;
          case 'reopen':
            if (o.status !== 'resolved') throw new AppError(409, 'INVALID_TRANSITION', 'Só a ocorrência resolvida pode ser reaberta.');
            to = 'in_progress';
            break;
          case 'responsibility':
            if (!b.responsibility) throw new AppError(422, 'RESPONSIBILITY_REQUIRED', 'Informe o responsável.');
            if (!open) throw new AppError(409, 'INVALID_TRANSITION', 'A ocorrência já foi encerrada.');
            break;
          case 'note':
            break;
        }
        await db.query(
          `UPDATE logistic_occurrences SET status = $2, responsibility = $3,
             resolution = CASE WHEN $2 = 'resolved' THEN $4 WHEN $5 THEN NULL ELSE resolution END,
             resolved_at = CASE WHEN $2 = 'resolved' THEN now() WHEN $5 THEN NULL ELSE resolved_at END,
             resolved_by = CASE WHEN $2 = 'resolved' THEN $6::uuid WHEN $5 THEN NULL ELSE resolved_by END,
             canceled_reason = CASE WHEN $2 = 'canceled' THEN left($4, 300) ELSE canceled_reason END,
             version = version + 1, updated_at = now() WHERE id = $1`,
          [id, to, resp, b.note, b.action === 'reopen', auth.userId],
        );
        const note = b.action === 'responsibility' ? `Responsável: ${resp}. ${b.note}` : b.note;
        await db.query(`INSERT INTO occurrence_events (occurrence_id, action, from_status, to_status, note, request_key, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
          id,
          b.action,
          o.status,
          to,
          note,
          b.requestKey,
          auth.userId,
        ]);
        // Encerrada a ultima que segurava a conclusao: o pedido entregue conclui.
        if (to === 'resolved' || to === 'canceled') await releaseHold(db, o.order_id);
        await audit(db, { actorId: auth.userId, action: `occurrence.${b.action}`, entity: 'occurrence', entityId: id, before: { status: o.status, responsibility: o.responsibility }, after: { status: to, responsibility: resp }, ip: auth.ip });
      });
    } catch (err) {
      if (isUniqueViolation(err, 'occurrence_events_request_key_key')) return { replayed: true, ...(await occurrenceView(pool, id)) };
      throw err;
    }
    return { replayed: false, ...(await occurrenceView(pool, id)) };
  });
}
