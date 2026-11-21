// SGLog Fase 9b: registro de reembolsos (D9-5, docs/38-sglog-fase9.md).
//
// - SO registro do que foi feito fora do sistema (Mercado Pago, banco, caixa, marketplace). Nada e estornado,
//   cobrado ou devolvido por aqui; a mercadoria recebida nao conclui reembolso nenhum.
// - Permissao propria (refunds.record) com verificacao em duas etapas, conferida no servidor.
// - Solicitado -> realizado (com referencia externa) -> confirmado (conferido no extrato ou no provedor);
//   solicitado|realizado -> cancelado. A mesma operacao (meio + referencia) nao entra duas vezes; a soma dos
//   reembolsos do pedido nao passa do total (gatilho no banco, com o pedido travado, contando os concorrentes).
// - Pedido de marketplace: so o meio 'marketplace' (registro do que a plataforma fez).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation, pageQuery } from '../lib/http.js';
import { requireAnyPermission, requirePermission } from './auth.js';
import { addInternalEvent } from './orders.js';

const key = z.string().min(8).max(100);
export const REFUND_METHODS = ['mercadopago', 'pix', 'bank_transfer', 'cash', 'card_reversal', 'marketplace', 'other'] as const;
const MARKETPLACES = ['mercadolivre', 'shopee'];
const COLS = `r.id, r.number, r.order_id, o.number AS order_number, o.channel, o.total_cents AS order_total_cents, r.return_id, cr.number AS return_number,
  r.occurrence_id, r.amount_cents, r.method, r.external_ref, r.status, r.reason, r.created_at, r.done_at, r.confirmed_at, r.canceled_at, r.cancel_reason,
  r.version, ru.name AS requested_by_name, du.name AS done_by_name, cu.name AS confirmed_by_name`;
const FROM = `refund_records r JOIN orders o ON o.id = r.order_id LEFT JOIN customer_returns cr ON cr.id = r.return_id
  LEFT JOIN users ru ON ru.id = r.requested_by LEFT JOIN users du ON du.id = r.done_by LEFT JOIN users cu ON cu.id = r.confirmed_by`;

export async function refundView(db: Db | typeof pool, id: string) {
  const refund = (await db.query(`SELECT ${COLS} FROM ${FROM} WHERE r.id = $1`, [id])).rows[0];
  if (!refund) throw notFound();
  const events = (
    await db.query(`SELECT e.id, e.action, e.from_status, e.to_status, e.note, e.created_at, u.name AS actor_name FROM refund_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.refund_id = $1 ORDER BY e.id`, [id])
  ).rows;
  return { refund, events };
}

/** Resumo do pedido: total, reembolsado (nao cancelado), saldo elegivel e os registros. */
export async function orderRefunds(db: Db | typeof pool, orderId: string) {
  const order = (await db.query<{ total_cents: string; channel: string }>('SELECT total_cents, channel FROM orders WHERE id = $1', [orderId])).rows[0];
  if (!order) throw notFound();
  const items = (await db.query(`SELECT ${COLS} FROM ${FROM} WHERE r.order_id = $1 ORDER BY r.number`, [orderId])).rows;
  const sum = (st: string[]) => items.filter((i) => st.includes(i.status)).reduce((t, i) => t + Number(i.amount_cents), 0);
  const registered = sum(['requested', 'done', 'confirmed']);
  const payments = (await db.query(`SELECT id, status, amount_cents, method, provider, updated_at FROM payments WHERE order_id = $1 ORDER BY created_at`, [orderId])).rows;
  return {
    totalCents: Number(order.total_cents),
    requestedCents: sum(['requested']),
    doneCents: sum(['done']),
    confirmedCents: sum(['confirmed']),
    eligibleCents: Math.max(0, Number(order.total_cents) - registered),
    marketplace: MARKETPLACES.includes(order.channel),
    providerRefunded: payments.some((p) => p.status === 'refunded'),
    payments,
    items,
  };
}

function constraintError(err: unknown): never {
  const c = (err as { constraint?: string }).constraint;
  if (c === 'refund_records_total') throw new AppError(409, 'REFUND_EXCEEDS_TOTAL', 'A soma dos reembolsos passaria do total do pedido (contando os já registrados).');
  if (c === 'refund_records_method') throw new AppError(422, 'REFUND_METHOD', 'Pedido de marketplace registra só o meio "marketplace"; pedido da loja não usa esse meio.');
  if (isUniqueViolation(err, 'refund_records_operation')) throw new AppError(409, 'REFUND_DUPLICATE', 'Esta operação financeira (meio e referência) já está registrada em outro reembolso.');
  throw err;
}

export async function refundRoutes(app: FastifyInstance) {
  const read = ['refunds.record', 'returns.manage', 'orders.view'] as const;

  app.get('/', async (req) => {
    requireAnyPermission(req, ...read);
    const q = pageQuery
      .extend({ status: z.enum(['requested', 'done', 'confirmed', 'canceled', 'open', 'all']).default('open'), order: z.coerce.number().int().positive().optional() })
      .parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status === 'open') where.push(`r.status IN ('requested', 'done')`);
    else if (q.status !== 'all') where.push(`r.status = $${params.push(q.status)}`);
    if (q.order) where.push(`o.number = $${params.push(q.order)}`);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((await pool.query(`SELECT count(*) AS n FROM ${FROM} ${w}`, params)).rows[0].n);
    const items = (await pool.query(`SELECT ${COLS} FROM ${FROM} ${w} ORDER BY r.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, q.pageSize, (q.page - 1) * q.pageSize])).rows;
    const sums = (
      await pool.query(
        `SELECT count(*) FILTER (WHERE status = 'requested')::int AS requested, count(*) FILTER (WHERE status = 'done')::int AS done,
                coalesce(sum(amount_cents) FILTER (WHERE status = 'requested'), 0)::bigint AS requested_cents,
                coalesce(sum(amount_cents) FILTER (WHERE status = 'done'), 0)::bigint AS done_cents
         FROM refund_records`,
      )
    ).rows[0];
    return { items, total, page: q.page, pageSize: q.pageSize, counts: sums };
  });

  app.get('/orders/:id', async (req) => {
    requireAnyPermission(req, ...read);
    const { id } = idParams.parse(req.params);
    return orderRefunds(pool, id);
  });

  app.get('/:id', async (req) => {
    requireAnyPermission(req, ...read);
    const { id } = idParams.parse(req.params);
    return refundView(pool, id);
  });

  app.post('/', async (req, reply) => {
    const auth = requirePermission(req, 'refunds.record');
    const b = z
      .strictObject({
        orderId: z.uuid(),
        returnId: z.uuid().optional().nullable(),
        occurrenceId: z.uuid().optional().nullable(),
        amountCents: z.number().int().positive().max(1_000_000_000),
        method: z.enum(REFUND_METHODS),
        externalRef: z.string().trim().min(1).max(120).optional().nullable(),
        status: z.enum(['requested', 'done']).default('requested'),
        reason: z.string().trim().min(3).max(500),
        requestKey: key,
      })
      .parse(req.body);
    const prior = (await pool.query<{ id: string }>('SELECT id FROM refund_records WHERE request_key = $1', [b.requestKey])).rows[0];
    if (prior) return { replayed: true, ...(await refundView(pool, prior.id)) };
    if (b.status === 'done' && !b.externalRef) throw new AppError(422, 'EXTERNAL_REF_REQUIRED', 'Reembolso realizado precisa da referência externa (comprovante, identificador da operação).');
    let id: string;
    try {
      id = await tx(auth.userId, async (db) => {
        const order = (await db.query<{ id: string; status: string; channel: string; total_cents: string }>('SELECT id, status, channel, total_cents FROM orders WHERE id = $1 FOR UPDATE', [b.orderId])).rows[0];
        if (!order) throw notFound();
        if (order.status === 'pending_payment') throw new AppError(409, 'ORDER_NOT_PAID', 'Pedido sem pagamento não tem o que reembolsar.');
        if (b.returnId && !(await db.query('SELECT 1 FROM customer_returns WHERE id = $1 AND order_id = $2', [b.returnId, b.orderId])).rows[0]) {
          throw new AppError(422, 'RETURN_NOT_IN_ORDER', 'A devolução não é deste pedido.');
        }
        if (b.occurrenceId && !(await db.query('SELECT 1 FROM logistic_occurrences WHERE id = $1 AND order_id = $2', [b.occurrenceId, b.orderId])).rows[0]) {
          throw new AppError(422, 'OCCURRENCE_NOT_IN_ORDER', 'A ocorrência não é deste pedido.');
        }
        if (MARKETPLACES.includes(order.channel) !== (b.method === 'marketplace')) constraintError({ constraint: 'refund_records_method' });
        const r = (
          await db.query<{ id: string; number: number }>(
            `INSERT INTO refund_records (order_id, return_id, occurrence_id, amount_cents, method, external_ref, status, reason, requested_by, done_at, done_by, request_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $7 = 'done' THEN now() END, CASE WHEN $7 = 'done' THEN $9::uuid END, $10) RETURNING id, number`,
            [b.orderId, b.returnId ?? null, b.occurrenceId ?? null, b.amountCents, b.method, b.externalRef || null, b.status, b.reason, auth.userId, b.requestKey],
          )
        ).rows[0]!;
        await db.query(`INSERT INTO refund_events (refund_id, action, to_status, note, actor_id) VALUES ($1, 'request', $2, $3, $4)`, [r.id, b.status, b.reason, auth.userId]);
        const amount = (b.amountCents / 100).toFixed(2).replace('.', ',');
        await addInternalEvent(db, b.orderId, order.status, `Reembolso nº ${r.number} registrado (${b.status === 'done' ? 'realizado' : 'solicitado'}): R$ ${amount}.`, auth.userId);
        if (b.returnId) {
          await db.query(`INSERT INTO return_events (return_id, action, note, actor_id) VALUES ($1, 'refund', $2, $3)`, [b.returnId, `Reembolso nº ${r.number} registrado: R$ ${amount}.`, auth.userId]);
        }
        await audit(db, { actorId: auth.userId, action: 'refund.record', entity: 'refund', entityId: r.id, after: { ...b, requestKey: undefined }, ip: auth.ip });
        return r.id;
      });
    } catch (err) {
      if (isUniqueViolation(err, 'refund_records_request_key_key')) {
        const again = (await pool.query<{ id: string }>('SELECT id FROM refund_records WHERE request_key = $1', [b.requestKey])).rows[0];
        if (again) return { replayed: true, ...(await refundView(pool, again.id)) };
      }
      constraintError(err);
    }
    reply.code(201);
    return { replayed: false, ...(await refundView(pool, id)) };
  });

  app.post('/:id/action', async (req) => {
    const auth = requirePermission(req, 'refunds.record');
    const { id } = idParams.parse(req.params);
    const b = z
      .strictObject({
        action: z.enum(['done', 'confirm', 'cancel', 'note']),
        externalRef: z.string().trim().min(1).max(120).optional().nullable(),
        note: z.string().trim().min(3).max(500),
        version: z.number().int(),
        requestKey: key,
      })
      .parse(req.body);
    if ((await pool.query('SELECT 1 FROM refund_events WHERE request_key = $1', [b.requestKey])).rows[0]) return { replayed: true, ...(await refundView(pool, id)) };
    try {
      await tx(auth.userId, async (db) => {
        const head = (await db.query<{ order_id: string }>('SELECT order_id FROM refund_records WHERE id = $1', [id])).rows[0];
        if (!head) throw notFound();
        const order = (await db.query<{ status: string }>('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [head.order_id])).rows[0]!;
        const r = (await db.query<{ id: string; number: number; status: string; version: number; external_ref: string | null }>('SELECT id, number, status, version, external_ref FROM refund_records WHERE id = $1 FOR UPDATE', [id])).rows[0]!;
        if (r.version !== b.version) throw new AppError(409, 'VERSION_CONFLICT', 'O reembolso foi alterado por outra pessoa. Recarregue a página.');
        let to = r.status;
        let set = '';
        const params: unknown[] = [id];
        switch (b.action) {
          case 'done':
            if (r.status !== 'requested') throw new AppError(409, 'INVALID_TRANSITION', 'Só o reembolso solicitado passa para realizado.');
            if (!b.externalRef && !r.external_ref) throw new AppError(422, 'EXTERNAL_REF_REQUIRED', 'Informe a referência externa da operação (comprovante, identificador).');
            to = 'done';
            set = `, external_ref = coalesce($${params.push(b.externalRef || null)}, external_ref), done_at = now(), done_by = $${params.push(auth.userId)}`;
            break;
          case 'confirm':
            if (r.status !== 'done') throw new AppError(409, 'INVALID_TRANSITION', 'Só o reembolso realizado pode ser confirmado (conferido no extrato ou no provedor).');
            to = 'confirmed';
            set = `, confirmed_at = now(), confirmed_by = $${params.push(auth.userId)}`;
            break;
          case 'cancel':
            if (!['requested', 'done'].includes(r.status)) throw new AppError(409, 'INVALID_TRANSITION', 'Reembolso confirmado ou já cancelado não pode ser cancelado.');
            to = 'canceled';
            set = `, canceled_at = now(), canceled_by = $${params.push(auth.userId)}, cancel_reason = left($${params.push(b.note)}, 300)`;
            break;
          case 'note':
            break;
        }
        await db.query(`UPDATE refund_records SET status = $${params.push(to)}${set}, version = version + 1, updated_at = now() WHERE id = $1`, params);
        await db.query(`INSERT INTO refund_events (refund_id, action, from_status, to_status, note, request_key, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
          id,
          b.action,
          r.status,
          to,
          b.externalRef ? `${b.note} (referência ${b.externalRef})` : b.note,
          b.requestKey,
          auth.userId,
        ]);
        if (to !== r.status) await addInternalEvent(db, head.order_id, order.status, `Reembolso nº ${r.number}: ${to === 'done' ? 'realizado' : to === 'confirmed' ? 'confirmado' : 'cancelado'}.`, auth.userId);
        await audit(db, { actorId: auth.userId, action: `refund.${b.action}`, entity: 'refund', entityId: id, before: { status: r.status }, after: { status: to, externalRef: b.externalRef ?? undefined }, ip: auth.ip });
      });
    } catch (err) {
      if (isUniqueViolation(err, 'refund_events_request_key_key')) return { replayed: true, ...(await refundView(pool, id)) };
      constraintError(err);
    }
    return { replayed: false, ...(await refundView(pool, id)) };
  });
}
