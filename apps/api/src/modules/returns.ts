// SGLog Fase 9: devolucoes do cliente, logistica reversa manual, conferencia e quarentena (docs/38-sglog-fase9.md).
//
// - Autorizar a devolucao NAO movimenta estoque. A quantidade por item nunca passa do despachado (recusa) nem do
//   entregue (devolucao e troca), contando as devolucoes anteriores e as concorrentes (gatilho com o pedido travado).
// - Receber registra a chegada fisica no deposito, ainda sem estoque. So a conferencia movimenta, no deposito que
//   recebeu e na mesma transacao: boa = entrada; quarentena = entrada + bloqueio; avariada = entrada + avaria;
//   descartada = entrada + baixa; faltando = so registro. Nada em quarentena ou avariado fica disponivel para venda.
// - Custo (D9-3): a entrada volta pelo custo com que a mercadoria saiu (custo medio gravado na venda), recalculando a
//   media como uma entrada normal; sem custo de venda conhecido, entra pelo medio atual sem mexer nele. O descarte
//   entra e sai pelo medio atual (a media nao muda) e guarda o custo historico como perda.
// - Conferencia e decisao da quarentena sao imutaveis; o estorno e uma linha nova com movimentos de estorno.
// - O aviso do transportador nunca chega aqui: abre ocorrencia (lib/returns.ts) e para.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation, pageQuery } from '../lib/http.js';
import { saleUnitCost } from '../lib/returns.js';
import { activeWarehouse, assertFree, assertWhole, lockVariants, moveStock, neg, qty as qtySchema, variantInfo, type Movement } from '../lib/stock.js';
import { requireAnyPermission, requirePermission, type Auth } from './auth.js';
import { orderOccurrences } from './occurrences.js';
import { addEvent } from './orders.js';

const key = z.string().min(8).max(100);
const milli = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 1000);
const q3 = (m: number) => (m / 1000).toFixed(3);
export const RETURN_REASONS = ['regret', 'defect', 'damaged', 'wrong_item', 'refused', 'not_delivered', 'warranty', 'other'] as const;
const MARKETPLACES = ['mercadolivre', 'shopee'];
const STOCK_CONDITIONS = ['good', 'quarantine', 'damaged', 'discarded'] as const;

type ReturnRow = {
  id: string;
  number: number;
  order_id: string;
  kind: 'return' | 'refusal' | 'exchange';
  status: string;
  warehouse_id: string | null;
  fiscal_required: boolean;
  version: number;
};
type ItemRow = { id: string; order_item_id: string; variant_id: string; qty: string; unit_cost_cents: string | null; sku: string };

// ---------------------------------------------------------------------------------------------------------------
// Leitura

/** Data de entrega do pedido (para os prazos de referencia): remessas novas entregues ou o evento do pedido. */
async function deliveredAt(db: Db | typeof pool, orderId: string): Promise<string | null> {
  const r = (
    await db.query<{ at: string | null }>(
      `SELECT coalesce((SELECT max(delivered_at) FROM shipments WHERE order_id = $1 AND kind <> 'legacy' AND status = 'delivered'),
                       (SELECT max(created_at) FROM order_events WHERE order_id = $1 AND status = 'delivered')) AS at`,
      [orderId],
    )
  ).rows[0];
  return r?.at ?? null;
}

export async function returnPolicy(db: Db | typeof pool) {
  return (
    await db.query<{ regretDays: number | null; defectDays: number | null; defectNondurableDays: number | null; warrantyDays: number | null; policyText: string | null; version: number }>(
      `SELECT return_regret_days AS "regretDays", return_defect_days AS "defectDays", return_defect_nondurable_days AS "defectNondurableDays",
              return_warranty_days AS "warrantyDays", return_policy_text AS "policyText", version FROM logistics_settings`,
    )
  ).rows[0]!;
}

/** Prazos de referencia (D9-10): so informam. Nada e recusado por prazo vencido. */
export function deadlines(policy: Awaited<ReturnType<typeof returnPolicy>>, delivered: string | null) {
  if (!delivered) return [];
  const base = new Date(delivered).getTime();
  const item = (kind: string, label: string, days: number | null) => {
    if (days === null || days === undefined) return null;
    const until = new Date(base + days * 86_400_000);
    return { kind, label, days, until: until.toISOString(), passed: until.getTime() < Date.now() };
  };
  return [
    item('regret', 'Arrependimento (compra fora da loja física)', policy.regretDays),
    item('defect', 'Defeito em produto durável', policy.defectDays),
    item('defect_nondurable', 'Defeito em produto não durável', policy.defectNondurableDays),
    item('warranty', 'Garantia da loja', policy.warrantyDays),
  ].filter(Boolean);
}

const RET_COLS = `r.id, r.number, r.order_id, o.number AS order_number, o.channel, o.invoice_status, r.occurrence_id, oc.number AS occurrence_number,
  r.shipment_id, sh.seq AS shipment_seq, r.kind, r.reason, r.status, r.return_method, r.carrier, r.tracking_code, r.reverse_code, r.return_freight_cents,
  r.warehouse_id, w.name AS warehouse_name, r.fiscal_required, r.requested_at, r.delivered_at, r.notes, r.received_at, r.inspected_at, r.completed_at,
  r.canceled_at, r.cancel_reason, r.created_at, r.updated_at, r.version, cu.name AS created_by_name`;
const RET_FROM = `customer_returns r JOIN orders o ON o.id = r.order_id LEFT JOIN logistic_occurrences oc ON oc.id = r.occurrence_id
  LEFT JOIN shipments sh ON sh.id = r.shipment_id LEFT JOIN warehouses w ON w.id = r.warehouse_id LEFT JOIN users cu ON cu.id = r.created_by`;

/** Conferido por item e condicao, liquido dos estornos. */
async function inspectedByItem(db: Db | typeof pool, returnId: string) {
  const rows = (
    await db.query<{ return_item_id: string; condition: string; qty: string }>(
      `SELECT return_item_id, condition, sum(CASE WHEN reverses_id IS NULL THEN qty ELSE -qty END)::text AS qty
       FROM return_inspections WHERE return_id = $1 GROUP BY return_item_id, condition`,
      [returnId],
    )
  ).rows;
  const map = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const m = map.get(r.return_item_id) ?? {};
    m[r.condition] = milli(r.qty);
    map.set(r.return_item_id, m);
  }
  return map;
}

export async function returnView(db: Db | typeof pool, id: string) {
  const ret = (await db.query(`SELECT ${RET_COLS} FROM ${RET_FROM} WHERE r.id = $1`, [id])).rows[0];
  if (!ret) throw notFound();
  const items = (
    await db.query(
      `SELECT i.id, i.order_item_id, i.variant_id, i.qty, i.unit_cost_cents, oi.sku, oi.product_name, oi.packaging_label, p.base_unit, u.allows_fraction
       FROM customer_return_items i JOIN order_items oi ON oi.id = i.order_item_id JOIN product_variants v ON v.id = i.variant_id
       JOIN products p ON p.id = v.product_id JOIN units u ON u.code = p.base_unit WHERE i.return_id = $1 ORDER BY oi.sku`,
      [id],
    )
  ).rows;
  const done = await inspectedByItem(db, id);
  for (const it of items) {
    const m = done.get(it.id) ?? {};
    const total = Object.values(m).reduce((s, v) => s + v, 0);
    it.inspected = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, q3(v)]));
    it.pending = q3(milli(it.qty) - total);
  }
  const inspections = (
    await db.query(
      `SELECT i.id, i.return_item_id, ri.variant_id, oi.sku, i.condition, i.qty, i.warehouse_id, i.unit_cost_cents, i.cost_source, i.reverses_id, i.reason,
              i.created_at, u.name AS actor_name, EXISTS (SELECT 1 FROM return_inspections x WHERE x.reverses_id = i.id) AS reversed,
              coalesce((SELECT sum(d.qty) FROM quarantine_decisions d WHERE d.inspection_id = i.id), 0)::text AS decided,
              coalesce((SELECT json_agg(json_build_object('decision', d.decision, 'qty', d.qty, 'reason', d.reason, 'createdAt', d.created_at, 'actorName', du.name) ORDER BY d.id)
                          FROM quarantine_decisions d LEFT JOIN users du ON du.id = d.actor_id WHERE d.inspection_id = i.id), '[]') AS decisions
       FROM return_inspections i JOIN customer_return_items ri ON ri.id = i.return_item_id JOIN order_items oi ON oi.id = ri.order_item_id
       LEFT JOIN users u ON u.id = i.actor_id WHERE i.return_id = $1 ORDER BY i.id`,
      [id],
    )
  ).rows;
  const events = (
    await db.query(
      `SELECT e.id, e.action, e.from_status, e.to_status, e.note, e.created_at, u.name AS actor_name FROM return_events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.return_id = $1 ORDER BY e.id`,
      [id],
    )
  ).rows;
  const policy = await returnPolicy(db);
  return { return: ret, items, inspections, events, deadlines: deadlines(policy, ret.delivered_at) };
}

/** Itens do pedido com o que pode voltar: despachado, entregue, ja em devolucao. */
async function returnableItems(db: Db | typeof pool, orderId: string) {
  return (
    await db.query<{
      id: string;
      variant_id: string;
      sku: string;
      product_name: string;
      packaging_label: string;
      base_unit: string;
      ordered: string;
      dispatched: string;
      delivered: string;
      returned: string;
      returned_after_delivery: string;
    }>(
      `SELECT oi.id, oi.variant_id, oi.sku, oi.product_name, oi.packaging_label, p.base_unit, (oi.packs * oi.base_qty_per_pack)::text AS ordered,
              order_item_out_qty(oi.id, false)::text AS dispatched, order_item_out_qty(oi.id, true)::text AS delivered,
              coalesce((SELECT sum(i.qty) FROM customer_return_items i JOIN customer_returns r ON r.id = i.return_id WHERE i.order_item_id = oi.id AND r.status <> 'canceled'), 0)::text AS returned,
              coalesce((SELECT sum(i.qty) FROM customer_return_items i JOIN customer_returns r ON r.id = i.return_id
                         WHERE i.order_item_id = oi.id AND r.status <> 'canceled' AND r.kind <> 'refusal'), 0)::text AS returned_after_delivery
       FROM order_items oi JOIN product_variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id
       WHERE oi.order_id = $1 ORDER BY oi.sku`,
      [orderId],
    )
  ).rows.map((r) => {
    const free = milli(r.dispatched) - milli(r.returned);
    const freeDelivered = Math.min(milli(r.delivered) - milli(r.returned_after_delivery), free);
    return { ...r, refusable: q3(Math.max(0, free)), returnable: q3(Math.max(0, freeDelivered)) };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Acoes

async function lockReturn(db: Db, id: string) {
  const head = (await db.query<{ order_id: string }>('SELECT order_id FROM customer_returns WHERE id = $1', [id])).rows[0];
  if (!head) throw notFound();
  const order = (await db.query<{ id: string; number: number; status: string }>('SELECT id, number, status FROM orders WHERE id = $1 FOR UPDATE', [head.order_id])).rows[0]!;
  const r = (
    await db.query<ReturnRow>('SELECT id, number, order_id, kind, status, warehouse_id, fiscal_required, version FROM customer_returns WHERE id = $1 FOR UPDATE', [id])
  ).rows[0]!;
  return { order, r };
}

async function returnEvent(db: Db, e: { returnId: string; action: string; from: string | null; to: string | null; note?: string | null; requestKey?: string | null; actorId: string | null }) {
  await db.query(`INSERT INTO return_events (return_id, action, from_status, to_status, note, request_key, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    e.returnId,
    e.action,
    e.from,
    e.to,
    e.note ?? null,
    e.requestKey ?? null,
    e.actorId,
  ]);
}

type Ctx = { db: Db; order: { id: string; number: number; status: string }; r: ReturnRow; auth: Auth };

/** Acao na devolucao: pedido e devolucao travados; repetir com a mesma chave devolve a devolucao sem agir de novo. */
async function act(auth: Auth, id: string, requestKey: string, fn: (c: Ctx) => Promise<void>) {
  const replay = async (db: Db | typeof pool) => (await db.query<{ return_id: string }>('SELECT return_id FROM return_events WHERE request_key = $1', [requestKey])).rows[0];
  const prior = await replay(pool);
  if (prior) {
    if (prior.return_id !== id) throw new AppError(409, 'REQUEST_KEY_REUSED', 'Chave de requisição já usada em outra devolução.');
    return { replayed: true, ...(await returnView(pool, id)) };
  }
  try {
    const again = await tx(auth.userId, async (db) => {
      const { order, r } = await lockReturn(db, id);
      if (await replay(db)) return true;
      await fn({ db, order, r, auth });
      return false;
    });
    return { replayed: again, ...(await returnView(pool, id)) };
  } catch (err) {
    if (isUniqueViolation(err, 'return_events_request_key_key') && (await replay(pool))) return { replayed: true, ...(await returnView(pool, id)) };
    throw err;
  }
}

function assertVersion(r: ReturnRow, version: number) {
  if (r.version !== version) throw new AppError(409, 'VERSION_CONFLICT', 'A devolução foi alterada por outra pessoa. Recarregue a página.');
}

async function setStatus(db: Db, r: ReturnRow, to: string, extra = '', params: unknown[] = []) {
  await db.query(`UPDATE customer_returns SET status = $2${extra}, version = version + 1, updated_at = now() WHERE id = $1`, [r.id, to, ...params]);
}

const docRef = (r: { number: number }) => `Devolução nº ${r.number}`;

/** Movimentos de uma linha da conferencia, na ordem. */
function stockPlan(condition: (typeof STOCK_CONDITIONS)[number], base: Omit<Movement, 'kind'>, q: string, cost: string | null, reason: string | null): Movement[] {
  const entry: Movement = { ...base, kind: 'return', onHandDelta: q, unitCostCents: condition === 'discarded' ? null : cost };
  // Entrada e bloqueio na mesma transacao: o saldo liquido nao muda, entao nao procura falta (como a recusa da Fase 6).
  const hold = { ...base, reason: reason ?? 'Conferência da devolução', skipShortageCheck: true };
  switch (condition) {
    case 'good':
      return [entry];
    case 'quarantine':
      return [entry, { ...hold, kind: 'block', onHandDelta: neg(q), blockedDelta: q }];
    case 'damaged':
      return [entry, { ...hold, kind: 'damage_hold', onHandDelta: neg(q), damagedDelta: q }];
    case 'discarded':
      return [entry, { ...hold, kind: 'damage', onHandDelta: neg(q) }];
  }
}

function constraintError(err: unknown): never {
  const c = (err as { constraint?: string }).constraint;
  if (c === 'customer_return_items_dispatched') throw new AppError(409, 'RETURN_QTY_EXCEEDED', 'A devolução passa da quantidade despachada deste item (contando as devoluções anteriores).');
  if (c === 'customer_return_items_delivered') throw new AppError(409, 'RETURN_QTY_EXCEEDED', 'A devolução passa da quantidade entregue deste item (contando as devoluções anteriores).');
  if (c === 'return_inspections_qty') throw new AppError(409, 'INSPECTION_QTY_EXCEEDED', 'A conferência passa da quantidade autorizada.');
  if (c === 'quarantine_decisions_qty') throw new AppError(409, 'QUARANTINE_QTY_EXCEEDED', 'A decisão passa do que está em quarentena.');
  if (c === 'quarantine_decisions_target' || c === 'return_inspections_reversal_target') throw new AppError(409, 'INVALID_TRANSITION', 'Esta linha da conferência não aceita a operação.');
  throw err;
}

const createSchema = z.strictObject({
  orderId: z.uuid(),
  kind: z.enum(['return', 'refusal', 'exchange']),
  reason: z.enum(RETURN_REASONS),
  occurrenceId: z.uuid().optional().nullable(),
  shipmentId: z.uuid().optional().nullable(),
  items: z.array(z.strictObject({ orderItemId: z.uuid(), qty: qtySchema })).min(1).max(100),
  returnMethod: z.enum(['carrier', 'store_dropoff', 'pickup']),
  carrier: z.string().trim().max(80).optional().nullable(),
  trackingCode: z.string().trim().max(60).optional().nullable(),
  reverseCode: z.string().trim().max(60).optional().nullable(),
  returnFreightCents: z.number().int().min(0).max(10_000_000).optional().nullable(),
  requestedAt: z.iso.datetime({ offset: true }).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  requestKey: key,
});

export async function returnRoutes(app: FastifyInstance) {
  const view = ['returns.manage', 'returns.receive', 'occurrences.manage', 'logistics.view', 'orders.view'] as const;

  app.get('/settings', async (req) => {
    requireAnyPermission(req, ...view);
    return { policy: await returnPolicy(pool) };
  });

  app.put('/settings', async (req) => {
    const auth = requirePermission(req, 'settings.manage');
    const days = z.number().int().min(0).max(3650).nullable();
    const b = z
      .strictObject({ regretDays: days, defectDays: days, defectNondurableDays: days, warrantyDays: days, policyText: z.string().trim().max(2000).nullable(), version: z.number().int() })
      .parse(req.body);
    await tx(auth.userId, async (db) => {
      const before = (await db.query('SELECT version FROM logistics_settings FOR UPDATE')).rows[0];
      if (before.version !== b.version) throw new AppError(409, 'VERSION_CONFLICT', 'As regras foram alteradas por outra pessoa. Recarregue a página.');
      const old = await returnPolicy(db);
      await db.query(
        `UPDATE logistics_settings SET return_regret_days = $1, return_defect_days = $2, return_defect_nondurable_days = $3, return_warranty_days = $4,
           return_policy_text = $5, version = version + 1, updated_at = now()`,
        [b.regretDays, b.defectDays, b.defectNondurableDays, b.warrantyDays, b.policyText || null],
      );
      await audit(db, { actorId: auth.userId, action: 'returns.policy', entity: 'logistics_settings', before: old, after: { ...b, version: undefined }, ip: auth.ip });
    });
    return { policy: await returnPolicy(pool) };
  });

  app.get('/', async (req) => {
    requireAnyPermission(req, ...view);
    const q = pageQuery
      .extend({
        status: z.enum(['open', 'authorized', 'in_transit', 'received', 'inspected', 'completed', 'canceled', 'all']).default('open'),
        kind: z.enum(['return', 'refusal', 'exchange']).optional(),
        order: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status === 'open') where.push(`r.status NOT IN ('completed', 'canceled')`);
    else if (q.status !== 'all') where.push(`r.status = $${params.push(q.status)}`);
    if (q.kind) where.push(`r.kind = $${params.push(q.kind)}`);
    if (q.order) where.push(`o.number = $${params.push(q.order)}`);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((await pool.query(`SELECT count(*) AS n FROM ${RET_FROM} ${w}`, params)).rows[0].n);
    const items = (
      await pool.query(
        `SELECT ${RET_COLS}, (SELECT count(*)::int FROM customer_return_items i WHERE i.return_id = r.id) AS item_count
         FROM ${RET_FROM} ${w} ORDER BY r.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, q.pageSize, (q.page - 1) * q.pageSize],
      )
    ).rows;
    const counts = (
      await pool.query(
        `SELECT count(*) FILTER (WHERE status IN ('authorized', 'in_transit'))::int AS awaiting,
                count(*) FILTER (WHERE status = 'received')::int AS to_inspect,
                count(*) FILTER (WHERE status = 'inspected')::int AS to_complete,
                (SELECT count(*)::int FROM return_inspections i WHERE i.condition = 'quarantine' AND i.reverses_id IS NULL
                   AND NOT EXISTS (SELECT 1 FROM return_inspections x WHERE x.reverses_id = i.id)
                   AND i.qty > coalesce((SELECT sum(d.qty) FROM quarantine_decisions d WHERE d.inspection_id = i.id), 0)) AS quarantine
         FROM customer_returns`,
      )
    ).rows[0];
    return { items, total, page: q.page, pageSize: q.pageSize, counts };
  });

  app.get('/quarantine', async (req) => {
    requireAnyPermission(req, 'returns.manage', 'returns.receive', 'stock.view');
    const items = (
      await pool.query(
        `SELECT i.id AS inspection_id, r.id AS return_id, r.number AS return_number, o.number AS order_number, oi.sku, oi.product_name, p.base_unit,
                w.name AS warehouse_name, i.qty, coalesce((SELECT sum(d.qty) FROM quarantine_decisions d WHERE d.inspection_id = i.id), 0)::text AS decided,
                (i.qty - coalesce((SELECT sum(d.qty) FROM quarantine_decisions d WHERE d.inspection_id = i.id), 0))::text AS open_qty, i.reason, i.created_at,
                floor(extract(epoch FROM now() - i.created_at) / 86400)::int AS age_days
         FROM return_inspections i JOIN customer_returns r ON r.id = i.return_id JOIN orders o ON o.id = r.order_id
         JOIN customer_return_items ri ON ri.id = i.return_item_id JOIN order_items oi ON oi.id = ri.order_item_id
         JOIN product_variants v ON v.id = ri.variant_id JOIN products p ON p.id = v.product_id JOIN warehouses w ON w.id = i.warehouse_id
         WHERE i.condition = 'quarantine' AND i.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM return_inspections x WHERE x.reverses_id = i.id)
           AND i.qty > coalesce((SELECT sum(d.qty) FROM quarantine_decisions d WHERE d.inspection_id = i.id), 0)
         ORDER BY i.created_at`,
      )
    ).rows;
    return { items };
  });

  app.get('/orders/:id', async (req) => {
    requireAnyPermission(req, ...view);
    const { id } = idParams.parse(req.params);
    const order = (await pool.query('SELECT id, number, status, channel, invoice_status, logistics_status, total_cents FROM orders WHERE id = $1', [id])).rows[0];
    if (!order) throw notFound();
    const returns = (await pool.query(`SELECT ${RET_COLS} FROM ${RET_FROM} WHERE r.order_id = $1 ORDER BY r.number`, [id])).rows;
    const shipments = (await pool.query(`SELECT id, seq, kind, status FROM shipments WHERE order_id = $1 AND status <> 'canceled' ORDER BY seq`, [id])).rows;
    const policy = await returnPolicy(pool);
    const delivered = await deliveredAt(pool, id);
    return {
      order,
      items: await returnableItems(pool, id),
      returns,
      shipments,
      occurrences: await orderOccurrences(pool, id),
      policy,
      deliveredAt: delivered,
      deadlines: deadlines(policy, delivered),
      marketplace: MARKETPLACES.includes(order.channel),
    };
  });

  app.get('/:id', async (req) => {
    requireAnyPermission(req, ...view);
    const { id } = idParams.parse(req.params);
    return returnView(pool, id);
  });

  // Autorizar: so registro e reserva da quantidade na devolucao. Nenhum movimento de estoque.
  app.post('/', async (req, reply) => {
    const auth = requirePermission(req, 'returns.manage');
    const b = createSchema.parse(req.body);
    const replay = async () => (await pool.query<{ id: string }>('SELECT id FROM customer_returns WHERE request_key = $1', [b.requestKey])).rows[0];
    const prior = await replay();
    if (prior) return { replayed: true, ...(await returnView(pool, prior.id)) };
    if (new Set(b.items.map((i) => i.orderItemId)).size !== b.items.length) throw new AppError(422, 'DUPLICATE_ITEM', 'O mesmo item aparece duas vezes na devolução.');
    let id: string;
    try {
      id = await tx(auth.userId, async (db) => {
        const order = (
          await db.query<{ id: string; number: number; status: string; channel: string; invoice_status: string }>(
            'SELECT id, number, status, channel, invoice_status FROM orders WHERE id = $1 FOR UPDATE',
            [b.orderId],
          )
        ).rows[0];
        if (!order) throw notFound();
        if (!['shipped', 'delivered'].includes(order.status)) throw new AppError(409, 'ORDER_NOT_SHIPPED', 'Só pedido despachado ou entregue tem mercadoria para voltar.');
        if (b.kind === 'exchange' && MARKETPLACES.includes(order.channel)) {
          throw new AppError(409, 'MARKETPLACE_EXCHANGE', 'Troca de pedido de marketplace é conduzida pela plataforma. Registre só a devolução física.');
        }
        if (b.occurrenceId && !(await db.query('SELECT 1 FROM logistic_occurrences WHERE id = $1 AND order_id = $2', [b.occurrenceId, b.orderId])).rows[0]) {
          throw new AppError(422, 'OCCURRENCE_NOT_IN_ORDER', 'A ocorrência não é deste pedido.');
        }
        if (b.shipmentId && !(await db.query(`SELECT 1 FROM shipments WHERE id = $1 AND order_id = $2 AND status <> 'canceled'`, [b.shipmentId, b.orderId])).rows[0]) {
          throw new AppError(422, 'SHIPMENT_NOT_IN_ORDER', 'A remessa não é deste pedido.');
        }
        const avail = new Map((await returnableItems(db, b.orderId)).map((i) => [i.id, i]));
        for (const it of b.items) {
          const a = avail.get(it.orderItemId);
          if (!a) throw new AppError(422, 'ITEM_NOT_IN_ORDER', 'Item que não é deste pedido.');
          assertWhole(await variantInfo(db, a.variant_id), it.qty);
          const cap = milli(b.kind === 'refusal' ? a.refusable : a.returnable);
          if (milli(it.qty) > cap) {
            throw new AppError(
              409,
              'RETURN_QTY_EXCEEDED',
              `${a.sku}: ${b.kind === 'refusal' ? 'despachado' : 'entregue'} e ainda sem devolução ${Number(q3(cap))} ${a.base_unit}; pedido ${Number(it.qty)}.`,
              { sku: a.sku, available: q3(cap), requested: it.qty },
            );
          }
        }
        const r = (
          await db.query<{ id: string; number: number }>(
            `INSERT INTO customer_returns (order_id, occurrence_id, shipment_id, kind, reason, return_method, carrier, tracking_code, reverse_code, return_freight_cents,
                                           fiscal_required, requested_at, delivered_at, notes, created_by, request_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, coalesce($12::timestamptz, now()), $13, $14, $15, $16) RETURNING id, number`,
            [
              b.orderId,
              b.occurrenceId ?? null,
              b.shipmentId ?? null,
              b.kind,
              b.reason,
              b.returnMethod,
              b.carrier || null,
              b.trackingCode || null,
              b.reverseCode || null,
              b.returnFreightCents ?? null,
              order.invoice_status === 'authorized',
              b.requestedAt ?? null,
              await deliveredAt(db, b.orderId),
              b.notes || null,
              auth.userId,
              b.requestKey,
            ],
          )
        ).rows[0]!;
        for (const it of b.items) {
          const a = avail.get(it.orderItemId)!;
          const si = (
            await db.query<{ id: string }>(
              `SELECT si.id FROM shipment_items si JOIN shipments s ON s.id = si.shipment_id
               WHERE si.order_item_id = $1 AND si.status = 'active' AND s.kind <> 'legacy' AND s.status <> 'canceled' AND ($2::uuid IS NULL OR s.id = $2)
               ORDER BY s.seq LIMIT 1`,
              [it.orderItemId, b.shipmentId ?? null],
            )
          ).rows[0];
          await db.query(`INSERT INTO customer_return_items (return_id, order_item_id, shipment_item_id, variant_id, qty, unit_cost_cents) VALUES ($1, $2, $3, $4, $5, $6)`, [
            r.id,
            it.orderItemId,
            si?.id ?? null,
            a.variant_id,
            it.qty,
            await saleUnitCost(db, b.orderId, a.variant_id),
          ]);
        }
        await returnEvent(db, { returnId: r.id, action: 'authorize', from: null, to: 'authorized', note: b.notes || null, actorId: auth.userId });
        if (b.occurrenceId) {
          await db.query(`INSERT INTO occurrence_events (occurrence_id, action, note, actor_id) VALUES ($1, 'return', $2, $3)`, [b.occurrenceId, `${docRef(r)} autorizada.`, auth.userId]);
        }
        await addEvent(db, b.orderId, order.status, `${docRef(r)} autorizada (${b.kind === 'refusal' ? 'recusa' : b.kind === 'exchange' ? 'troca' : 'devolução'}).`, auth.userId);
        await audit(db, { actorId: auth.userId, action: 'return.authorize', entity: 'customer_return', entityId: r.id, after: { ...b, requestKey: undefined }, ip: auth.ip });
        return r.id;
      });
    } catch (err) {
      const again = isUniqueViolation(err, 'customer_returns_request_key_key') && (await replay());
      if (again) return { replayed: true, ...(await returnView(pool, again.id)) };
      constraintError(err);
    }
    reply.code(201);
    return { replayed: false, ...(await returnView(pool, id)) };
  });

  // Logistica reversa manual: como e por onde volta. Nada de etiqueta comprada pelo sistema.
  app.post('/:id/transit', async (req) => {
    const auth = requireAnyPermission(req, 'returns.manage', 'returns.receive');
    const { id } = idParams.parse(req.params);
    const b = z
      .strictObject({
        carrier: z.string().trim().max(80).optional().nullable(),
        trackingCode: z.string().trim().max(60).optional().nullable(),
        reverseCode: z.string().trim().max(60).optional().nullable(),
        returnFreightCents: z.number().int().min(0).max(10_000_000).optional().nullable(),
        version: z.number().int(),
        requestKey: key,
      })
      .parse(req.body);
    return act(auth, id, b.requestKey, async (c) => {
      assertVersion(c.r, b.version);
      if (c.r.status !== 'authorized') throw new AppError(409, 'INVALID_TRANSITION', 'Só a devolução autorizada passa para em trânsito de volta.');
      await setStatus(c.db, c.r, 'in_transit', ', carrier = coalesce($3, carrier), tracking_code = coalesce($4, tracking_code), reverse_code = coalesce($5, reverse_code), return_freight_cents = coalesce($6, return_freight_cents)', [
        b.carrier || null,
        b.trackingCode || null,
        b.reverseCode || null,
        b.returnFreightCents ?? null,
      ]);
      await returnEvent(c.db, { returnId: c.r.id, action: 'transit', from: c.r.status, to: 'in_transit', note: b.trackingCode ? `Rastreio ${b.trackingCode}` : null, requestKey: b.requestKey, actorId: auth.userId });
      await audit(c.db, { actorId: auth.userId, action: 'return.transit', entity: 'customer_return', entityId: c.r.id, after: { ...b, requestKey: undefined }, ip: auth.ip });
    });
  });

  // Chegada fisica no deposito. Ainda sem estoque: so a conferencia movimenta.
  app.post('/:id/receive', async (req) => {
    const auth = requirePermission(req, 'returns.receive');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ warehouseId: z.uuid().optional().nullable(), note: z.string().trim().max(500).optional().nullable(), version: z.number().int(), requestKey: key }).parse(req.body);
    return act(auth, id, b.requestKey, async (c) => {
      assertVersion(c.r, b.version);
      if (!['authorized', 'in_transit'].includes(c.r.status)) throw new AppError(409, 'INVALID_TRANSITION', 'Esta devolução já foi recebida ou encerrada.');
      const wh = await activeWarehouse(c.db, b.warehouseId);
      await setStatus(c.db, c.r, 'received', ', warehouse_id = $3, received_at = now(), received_by = $4', [wh.id, auth.userId]);
      await returnEvent(c.db, { returnId: c.r.id, action: 'receive', from: c.r.status, to: 'received', note: [`Recebida no depósito ${wh.name}`, b.note].filter(Boolean).join('. '), requestKey: b.requestKey, actorId: auth.userId });
      await addEvent(c.db, c.order.id, c.order.status, `${docRef(c.r)} recebida no depósito ${wh.name} (aguarda conferência).`, auth.userId);
      await audit(c.db, { actorId: auth.userId, action: 'return.receive', entity: 'customer_return', entityId: c.r.id, after: { warehouseId: wh.id }, ip: auth.ip });
    });
  });

  // Conferencia: unico passo que movimenta estoque.
  app.post('/:id/inspect', async (req) => {
    const auth = requirePermission(req, 'returns.receive');
    const { id } = idParams.parse(req.params);
    const b = z
      .strictObject({
        lines: z
          .array(z.strictObject({ itemId: z.uuid(), condition: z.enum(['good', 'quarantine', 'damaged', 'discarded', 'missing']), qty: qtySchema, reason: z.string().trim().min(3).max(300).optional().nullable() }))
          .min(1)
          .max(200),
        version: z.number().int(),
        requestKey: key,
      })
      .parse(req.body);
    try {
      return await act(auth, id, b.requestKey, async (c) => {
        assertVersion(c.r, b.version);
        if (c.r.status !== 'received') throw new AppError(409, 'INVALID_TRANSITION', c.r.status === 'inspected' ? 'A devolução já foi conferida inteira.' : 'Receba a devolução antes de conferir.');
        const items = (
          await c.db.query<ItemRow>(
            `SELECT i.id, i.order_item_id, i.variant_id, i.qty, i.unit_cost_cents, oi.sku FROM customer_return_items i JOIN order_items oi ON oi.id = i.order_item_id WHERE i.return_id = $1`,
            [c.r.id],
          )
        ).rows;
        const byId = new Map(items.map((i) => [i.id, i]));
        for (const l of b.lines) {
          const it = byId.get(l.itemId);
          if (!it) throw new AppError(422, 'ITEM_NOT_IN_RETURN', 'Item que não é desta devolução.');
          assertWhole(await variantInfo(c.db, it.variant_id), l.qty);
          if ((l.condition === 'damaged' || l.condition === 'discarded') && !l.reason) throw new AppError(422, 'REASON_REQUIRED', `${it.sku}: informe o motivo da avaria ou do descarte.`);
        }
        const wh = await activeWarehouse(c.db, c.r.warehouse_id);
        await lockVariants(c.db, items.map((i) => i.variant_id));
        const summary: string[] = [];
        for (const l of b.lines) {
          const it = byId.get(l.itemId)!;
          const ids: string[] = [];
          let cost: string | null = null;
          let source: string | null = null;
          if (l.condition !== 'missing') {
            cost = l.condition === 'discarded' ? null : it.unit_cost_cents;
            source = cost === null ? 'current_avg' : 'sale';
            const base = { variantId: it.variant_id, warehouseId: wh.id, sourceType: 'customer_return' as const, sourceId: it.id, documentRef: docRef(c.r) };
            for (const m of stockPlan(l.condition, base, l.qty, cost, l.reason ?? null)) ids.push((await moveStock(c.db, auth.userId, m)).id);
          }
          await c.db.query(
            `INSERT INTO return_inspections (return_id, return_item_id, condition, qty, warehouse_id, unit_cost_cents, cost_source, movement_ids, reason, actor_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint[], $9, $10)`,
            [c.r.id, it.id, l.condition, l.qty, l.condition === 'missing' ? null : wh.id, l.condition === 'discarded' ? it.unit_cost_cents : cost, source, ids, l.reason ?? null, auth.userId],
          );
          summary.push(`${it.sku} ${Number(l.qty)} ${CONDITION_PT[l.condition]}`);
        }
        const done = await inspectedByItem(c.db, c.r.id);
        const complete = items.every((it) => Object.values(done.get(it.id) ?? {}).reduce((s, v) => s + v, 0) === milli(it.qty));
        if (complete) await setStatus(c.db, c.r, 'inspected', ', inspected_at = now()');
        else await c.db.query('UPDATE customer_returns SET version = version + 1, updated_at = now() WHERE id = $1', [c.r.id]);
        await returnEvent(c.db, { returnId: c.r.id, action: 'inspect', from: c.r.status, to: complete ? 'inspected' : c.r.status, note: summary.join('; ').slice(0, 1000), requestKey: b.requestKey, actorId: auth.userId });
        await audit(c.db, { actorId: auth.userId, action: 'return.inspect', entity: 'customer_return', entityId: c.r.id, after: { lines: b.lines, warehouseId: wh.id }, ip: auth.ip });
      });
    } catch (err) {
      constraintError(err);
    }
  });

  // Estorno de uma linha da conferencia: movimentos de estorno, na ordem inversa, e uma linha nova.
  app.post('/:id/inspections/:inspectionId/reverse', async (req) => {
    const auth = requirePermission(req, 'returns.manage');
    const p = z.object({ id: z.uuid(), inspectionId: z.coerce.number().int().positive() }).parse(req.params);
    const b = z.strictObject({ reason: z.string().trim().min(3).max(300), requestKey: key }).parse(req.body);
    try {
      return await act(auth, p.id, b.requestKey, async (c) => {
        if (!['received', 'inspected'].includes(c.r.status)) throw new AppError(409, 'INVALID_TRANSITION', 'Só a conferência de devolução em aberto pode ser estornada.');
        const i = (
          await c.db.query<{ id: string; return_item_id: string; condition: string; qty: string; warehouse_id: string | null; movement_ids: string[]; reverses_id: string | null; reversed: boolean; variant_id: string; sku: string }>(
            `SELECT i.id, i.return_item_id, i.condition, i.qty, i.warehouse_id, i.movement_ids::text[] AS movement_ids, i.reverses_id,
                    EXISTS (SELECT 1 FROM return_inspections x WHERE x.reverses_id = i.id) AS reversed, ri.variant_id, oi.sku
             FROM return_inspections i JOIN customer_return_items ri ON ri.id = i.return_item_id JOIN order_items oi ON oi.id = ri.order_item_id
             WHERE i.id = $1 AND i.return_id = $2`,
            [p.inspectionId, c.r.id],
          )
        ).rows[0];
        if (!i) throw notFound();
        if (i.reverses_id || i.reversed) throw new AppError(409, 'ALREADY_REVERSED', 'Esta linha já foi estornada (ou é um estorno).');
        if ((await c.db.query('SELECT 1 FROM quarantine_decisions WHERE inspection_id = $1', [i.id])).rows[0]) {
          throw new AppError(409, 'QUARANTINE_DECIDED', 'Esta quarentena já tem decisão registrada; o estorno não é mais possível.');
        }
        const ids: string[] = [];
        if (i.movement_ids.length) {
          await lockVariants(c.db, [i.variant_id]);
          const wh = await activeWarehouse(c.db, i.warehouse_id);
          // A boa voltou ao disponivel: o estorno nao pode tomar mercadoria ja reservada.
          if (i.condition === 'good') await assertFree(c.db, wh, i.variant_id, i.sku, i.qty);
          const moves = (
            await c.db.query<{ id: string; on_hand_delta: string; blocked_delta: string; damaged_delta: string; in_transit_delta: string }>(
              `SELECT id::text, on_hand_delta, blocked_delta, damaged_delta, in_transit_delta FROM stock_movements WHERE id = ANY($1::bigint[]) ORDER BY id DESC`,
              [i.movement_ids],
            )
          ).rows;
          for (const m of moves) {
            const r = await moveStock(c.db, auth.userId, {
              variantId: i.variant_id,
              kind: 'reversal',
              reversesId: m.id,
              warehouseId: wh.id,
              onHandDelta: neg(m.on_hand_delta),
              blockedDelta: neg(m.blocked_delta),
              damagedDelta: neg(m.damaged_delta),
              inTransitDelta: neg(m.in_transit_delta),
              sourceType: 'customer_return',
              sourceId: i.return_item_id,
              documentRef: docRef(c.r),
              reason: b.reason,
              skipShortageCheck: i.condition !== 'good',
            });
            ids.push(r.id);
          }
        }
        await c.db.query(
          `INSERT INTO return_inspections (return_id, return_item_id, condition, qty, warehouse_id, movement_ids, reverses_id, reason, actor_id)
           VALUES ($1, $2, $3, $4, $5, $6::bigint[], $7, $8, $9)`,
          [c.r.id, i.return_item_id, i.condition, i.qty, i.warehouse_id, ids, i.id, b.reason, auth.userId],
        );
        if (c.r.status === 'inspected') await setStatus(c.db, c.r, 'received', ', inspected_at = NULL');
        else await c.db.query('UPDATE customer_returns SET version = version + 1, updated_at = now() WHERE id = $1', [c.r.id]);
        await returnEvent(c.db, { returnId: c.r.id, action: 'inspect_reverse', from: c.r.status, to: 'received', note: `${i.sku} ${Number(i.qty)} ${CONDITION_PT[i.condition]}: ${b.reason}`, requestKey: b.requestKey, actorId: auth.userId });
        await audit(c.db, { actorId: auth.userId, action: 'return.inspect_reverse', entity: 'customer_return', entityId: c.r.id, after: { inspectionId: i.id, reason: b.reason }, ip: auth.ip });
      });
    } catch (err) {
      constraintError(err);
    }
  });

  // Saida da quarentena: liberar para venda, avariar ou baixar. Sempre com motivo e quem decidiu.
  app.post('/quarantine/:inspectionId/decide', async (req) => {
    const auth = requirePermission(req, 'returns.manage');
    const p = z.object({ inspectionId: z.coerce.number().int().positive() }).parse(req.params);
    const b = z.strictObject({ decision: z.enum(['release', 'damaged', 'discard']), qty: qtySchema, reason: z.string().trim().min(3).max(300), requestKey: key }).parse(req.body);
    const head = (await pool.query<{ return_id: string }>('SELECT return_id FROM return_inspections WHERE id = $1', [p.inspectionId])).rows[0];
    if (!head) throw notFound();
    try {
      return await act(auth, head.return_id, b.requestKey, async (c) => {
        const i = (
          await c.db.query<{ id: string; return_item_id: string; condition: string; qty: string; warehouse_id: string; variant_id: string; sku: string; decided: string; reversed: boolean; reverses_id: string | null }>(
            `SELECT i.id, i.return_item_id, i.condition, i.qty, i.warehouse_id, ri.variant_id, oi.sku, i.reverses_id,
                    coalesce((SELECT sum(d.qty) FROM quarantine_decisions d WHERE d.inspection_id = i.id), 0)::text AS decided,
                    EXISTS (SELECT 1 FROM return_inspections x WHERE x.reverses_id = i.id) AS reversed
             FROM return_inspections i JOIN customer_return_items ri ON ri.id = i.return_item_id JOIN order_items oi ON oi.id = ri.order_item_id WHERE i.id = $1`,
            [p.inspectionId],
          )
        ).rows[0]!;
        if (i.condition !== 'quarantine' || i.reverses_id || i.reversed) throw new AppError(409, 'NOT_IN_QUARANTINE', 'Esta linha não está em quarentena.');
        assertWhole(await variantInfo(c.db, i.variant_id), b.qty);
        if (milli(b.qty) > milli(i.qty) - milli(i.decided)) {
          throw new AppError(409, 'QUARANTINE_QTY_EXCEEDED', `${i.sku}: em quarentena ${Number(q3(milli(i.qty) - milli(i.decided)))}, pedido ${Number(b.qty)}.`);
        }
        await lockVariants(c.db, [i.variant_id]);
        const wh = await activeWarehouse(c.db, i.warehouse_id);
        const base = { variantId: i.variant_id, warehouseId: wh.id, sourceType: 'customer_return' as const, sourceId: i.return_item_id, documentRef: docRef(c.r), reason: b.reason };
        const plan: Movement[] = [{ ...base, kind: 'unblock', blockedDelta: neg(b.qty), onHandDelta: b.qty, skipShortageCheck: true }];
        if (b.decision === 'damaged') plan.push({ ...base, kind: 'damage_hold', onHandDelta: neg(b.qty), damagedDelta: b.qty, skipShortageCheck: true });
        if (b.decision === 'discard') plan.push({ ...base, kind: 'damage', onHandDelta: neg(b.qty), skipShortageCheck: true });
        const ids: string[] = [];
        for (const m of plan) ids.push((await moveStock(c.db, auth.userId, m)).id);
        await c.db.query(`INSERT INTO quarantine_decisions (inspection_id, decision, qty, reason, movement_ids, actor_id) VALUES ($1, $2, $3, $4, $5::bigint[], $6)`, [
          i.id,
          b.decision,
          b.qty,
          b.reason,
          ids,
          auth.userId,
        ]);
        await c.db.query('UPDATE customer_returns SET version = version + 1, updated_at = now() WHERE id = $1', [c.r.id]);
        const label = b.decision === 'release' ? 'liberado para venda' : b.decision === 'damaged' ? 'marcado como avariado' : 'baixado';
        await returnEvent(c.db, { returnId: c.r.id, action: 'quarantine', from: c.r.status, to: c.r.status, note: `Quarentena: ${i.sku} ${Number(b.qty)} ${label}. ${b.reason}`, requestKey: b.requestKey, actorId: auth.userId });
        await audit(c.db, { actorId: auth.userId, action: 'return.quarantine', entity: 'customer_return', entityId: c.r.id, after: { inspectionId: i.id, ...b, requestKey: undefined }, ip: auth.ip });
      });
    } catch (err) {
      constraintError(err);
    }
  });

  // Encerrar: tudo conferido e a pendencia fiscal resolvida. O reembolso e outro registro e nao conclui nada aqui.
  app.post('/:id/complete', async (req) => {
    const auth = requirePermission(req, 'returns.manage');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ version: z.number().int(), requestKey: key }).parse(req.body);
    return act(auth, id, b.requestKey, async (c) => {
      assertVersion(c.r, b.version);
      if (c.r.status !== 'inspected') throw new AppError(409, 'INVALID_TRANSITION', 'Confira todos os itens antes de encerrar a devolução.');
      if (c.r.fiscal_required && !(await fiscalResolved(c.db, c.r.id))) {
        throw new AppError(409, 'FISCAL_PENDING', 'O pedido tem NF-e autorizada: registre o documento fiscal da devolução (ou a dispensa justificada) antes de encerrar.');
      }
      await setStatus(c.db, c.r, 'completed', ', completed_at = now(), completed_by = $3', [auth.userId]);
      await returnEvent(c.db, { returnId: c.r.id, action: 'complete', from: c.r.status, to: 'completed', requestKey: b.requestKey, actorId: auth.userId });
      await addEvent(c.db, c.order.id, c.order.status, `${docRef(c.r)} encerrada.`, auth.userId);
      await audit(c.db, { actorId: auth.userId, action: 'return.complete', entity: 'customer_return', entityId: c.r.id, ip: auth.ip });
    });
  });

  // Cancelar: so antes do recebimento (nada entrou no estoque). Libera a quantidade para outra devolucao.
  app.post('/:id/cancel', async (req) => {
    const auth = requirePermission(req, 'returns.manage');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ reason: z.string().trim().min(3).max(300), version: z.number().int(), requestKey: key }).parse(req.body);
    return act(auth, id, b.requestKey, async (c) => {
      assertVersion(c.r, b.version);
      // Recebida, a mercadoria esta no deposito: a devolucao segue para a conferencia (o que nao veio fica 'faltando').
      if (!['authorized', 'in_transit'].includes(c.r.status)) throw new AppError(409, 'INVALID_TRANSITION', 'Só a devolução ainda não recebida pode ser cancelada.');
      if ((await c.db.query('SELECT 1 FROM return_inspections WHERE return_id = $1', [c.r.id])).rows[0]) {
        throw new AppError(409, 'RETURN_INSPECTED', 'A devolução já tem conferência registrada. Estorne as linhas da conferência antes de cancelar.');
      }
      await setStatus(c.db, c.r, 'canceled', ', canceled_at = now(), cancel_reason = $3', [b.reason]);
      await returnEvent(c.db, { returnId: c.r.id, action: 'cancel', from: c.r.status, to: 'canceled', note: b.reason, requestKey: b.requestKey, actorId: auth.userId });
      await addEvent(c.db, c.order.id, c.order.status, `${docRef(c.r)} cancelada: ${b.reason}`, auth.userId);
      await audit(c.db, { actorId: auth.userId, action: 'return.cancel', entity: 'customer_return', entityId: c.r.id, after: { reason: b.reason }, ip: auth.ip });
    });
  });
}

const CONDITION_PT: Record<string, string> = { good: 'em bom estado', quarantine: 'em quarentena', damaged: 'avariado', discarded: 'descartado', missing: 'faltando' };

/** Pendencia fiscal da devolucao resolvida? A Fase 9b registra o documento ou a dispensa. */
async function fiscalResolved(_db: Db, _returnId: string) {
  return false;
}
