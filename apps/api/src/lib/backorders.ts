// SGLog Fase 6 (docs/29-sglog-fase6.md §3): conversao da reserva de encomenda em firme.
//
// - Mercadoria livre para encomendas no deposito = fisico do deposito - reservas firmes (a mesma conta da liberacao
//   calculada da Fase 5, D5-10). Bloqueado e avariado nao estao no fisico disponivel: nunca convertem nada.
// - Fila por deposito e variante, so pedidos pagos e abertos: primeiro as encomendas vinculadas a compra que chegou
//   (D6-2), depois as demais; em cada grupo pela data de pagamento, desempate pelo numero do pedido e pela reserva
//   (D6-11: deterministico).
// - Converte a reserva INTEIRA; a primeira que nao cabe interrompe a fila (D6-9). Saltar a fila so por antecipacao
//   manual, com permissao, MFA, justificativa e registro (rule 'manual').
// - Uma conversao por reserva (UNIQUE no banco) e o gatilho confere que a reserva e de encomenda, ativa e inteira:
//   dois recebimentos nao convertem a mesma encomenda duas vezes.
// - Travas: chamar com as variantes ja travadas (lockVariants, em ordem). A conversao trava so as reservas e nunca
//   o pedido do cliente: a ordem pedido -> variantes da alocacao e da remessa nao inverte (sem deadlock).
// - Nada muda no pedido do cliente nem libera despacho: a separacao, a NF-e e o despacho seguem as regras da Fase 5.
import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { AppError } from './errors.js';

const milli = (v: string | number) => Math.round(Number(v) * 1000);
const q3 = (m: number) => (m / 1000).toFixed(3);

/** Pedido que entra na fila: pago e ainda nao despachado nem cancelado (mesma lista da alocacao). */
const OPEN = ['paid', 'preparing', 'ready'];

export type QueueEntry = {
  reservation_id: string;
  order_id: string;
  order_number: number;
  paid_at: string;
  variant_id: string;
  warehouse_id: string;
  qty: string;
  linked: boolean;
  allocation_id: string | null;
};

/** Mercadoria livre para encomendas (fisico do deposito - reservas firmes). */
export async function freeForBackorders(db: Db | typeof pool, warehouseId: string, variantId: string) {
  const r = (
    await db.query<{ free: string }>(
      `SELECT (coalesce((SELECT on_hand FROM stock_location_balances WHERE warehouse_id = $1 AND variant_id = $2), 0)
             - coalesce((SELECT sum(qty) FROM stock_reservations r
                          WHERE coalesce(r.warehouse_id, (SELECT id FROM warehouses WHERE is_default)) = $1 AND r.variant_id = $2
                            AND r.status = 'active' AND NOT r.backorder), 0))::text AS free`,
      [warehouseId, variantId],
    )
  ).rows[0]!;
  return milli(r.free);
}

/**
 * Fila de encomendas da variante no deposito. Com a compra informada, as vinculadas a ela vem primeiro. Com lock,
 * trava as reservas (chamar com a variante travada).
 */
export async function backorderQueue(db: Db | typeof pool, warehouseId: string, variantId: string, opts: { purchaseOrderId?: string | null; lock?: boolean } = {}) {
  return (
    await db.query<QueueEntry>(
      `SELECT r.id AS reservation_id, o.id AS order_id, o.number AS order_number, o.paid_at, r.variant_id,
              coalesce(r.warehouse_id, (SELECT id FROM warehouses WHERE is_default)) AS warehouse_id, r.qty::text AS qty, r.allocation_id,
              ($3::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM purchase_order_links l
                 WHERE l.allocation_id = r.allocation_id AND l.purchase_order_id = $3 AND l.status = 'active')) AS linked
       FROM stock_reservations r JOIN orders o ON r.source_type = 'order' AND o.id::text = r.source_id
       WHERE coalesce(r.warehouse_id, (SELECT id FROM warehouses WHERE is_default)) = $1 AND r.variant_id = $2
         AND r.status = 'active' AND r.backorder AND o.paid_at IS NOT NULL AND o.status = ANY($4::text[])
       ORDER BY linked DESC, o.paid_at, o.number, r.id${opts.lock ? ' FOR UPDATE OF r' : ''}`,
      [warehouseId, variantId, opts.purchaseOrderId ?? null, OPEN],
    )
  ).rows;
}

export type Conversion = { reservationId: string; orderId: string; orderNumber: number; variantId: string; warehouseId: string; qty: string; rule: string };
export type PlanResult = { converted: Conversion[]; stoppedAt: { reservationId: string; orderNumber: number; qty: string; free: string } | null; free: string };

/** Calcula a conversao pela fila (sem gravar): para na primeira reserva que nao cabe inteira. */
export function planQueue(queue: QueueEntry[], free: number, rule: (e: QueueEntry) => string): PlanResult {
  const converted: Conversion[] = [];
  let left = free;
  for (const e of queue) {
    if (milli(e.qty) > left) {
      return { converted, stoppedAt: { reservationId: e.reservation_id, orderNumber: e.order_number, qty: e.qty, free: q3(Math.max(left, 0)) }, free: q3(Math.max(left, 0)) };
    }
    left -= milli(e.qty);
    converted.push({ reservationId: e.reservation_id, orderId: e.order_id, orderNumber: e.order_number, variantId: e.variant_id, warehouseId: e.warehouse_id, qty: e.qty, rule: rule(e) });
  }
  return { converted, stoppedAt: null, free: q3(Math.max(left, 0)) };
}

async function insertConversion(
  db: Db,
  c: Conversion,
  meta: { receiptId?: string | null; purchaseOrderId?: string | null; justification?: string | null; requestKey?: string | null; actorId: string | null },
) {
  await db.query(
    `INSERT INTO reservation_conversions (reservation_id, order_id, variant_id, warehouse_id, qty, rule, receipt_id, purchase_order_id, justification, request_key, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [c.reservationId, c.orderId, c.variantId, c.warehouseId, c.qty, c.rule, meta.receiptId ?? null, meta.purchaseOrderId ?? null, meta.justification ?? null, meta.requestKey ?? null, meta.actorId],
  );
}

/**
 * Conversao no recebimento (mesma transacao da entrada). Variante ja travada. Devolve o que converteu e onde parou.
 */
export async function convertOnReceipt(db: Db, actorId: string, p: { warehouseId: string; variantId: string; receiptId: string; purchaseOrderId: string }) {
  const queue = await backorderQueue(db, p.warehouseId, p.variantId, { purchaseOrderId: p.purchaseOrderId, lock: true });
  const plan = planQueue(queue, await freeForBackorders(db, p.warehouseId, p.variantId), (e) => (e.linked ? 'linked' : 'queue'));
  for (const c of plan.converted) await insertConversion(db, c, { receiptId: p.receiptId, purchaseOrderId: p.purchaseOrderId, actorId });
  return plan;
}

/** Pares deposito x variante com encomenda ativa de pedido pago (para o reprocessamento e a tela). */
export async function backorderPairs(db: Db | typeof pool, filter: { warehouseId?: string | null; variantId?: string | null } = {}) {
  return (
    await db.query<{ warehouse_id: string; variant_id: string }>(
      `SELECT DISTINCT coalesce(r.warehouse_id, (SELECT id FROM warehouses WHERE is_default)) AS warehouse_id, r.variant_id
       FROM stock_reservations r JOIN orders o ON r.source_type = 'order' AND o.id::text = r.source_id
       WHERE r.status = 'active' AND r.backorder AND o.paid_at IS NOT NULL AND o.status = ANY($3::text[])
         AND ($1::uuid IS NULL OR coalesce(r.warehouse_id, (SELECT id FROM warehouses WHERE is_default)) = $1) AND ($2::uuid IS NULL OR r.variant_id = $2)
       ORDER BY 2, 1`,
      [filter.warehouseId ?? null, filter.variantId ?? null, OPEN],
    )
  ).rows;
}

/**
 * Reprocessamento manual (D6-10): encomendas antigas e mercadoria que chegou por ajuste, transferencia ou devolucao.
 * Com preview, so calcula. Sem preview, grava (variantes travadas aqui, em ordem). Repetir a mesma chave devolve o
 * que ja foi convertido com ela.
 */
export async function reprocessBackorders(
  db: Db,
  actorId: string,
  p: { warehouseId?: string | null; variantId?: string | null; preview: boolean; requestKey: string; lockVariants: (ids: string[]) => Promise<void> },
) {
  const prior = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM reservation_conversions WHERE request_key = $1', [p.requestKey])).rows[0]!.n;
  if (prior && !p.preview) return { replayed: true, results: [] as (PlanResult & { warehouseId: string; variantId: string })[] };
  const pairs = await backorderPairs(db, p);
  if (!p.preview) await p.lockVariants(pairs.map((x) => x.variant_id));
  const results: (PlanResult & { warehouseId: string; variantId: string })[] = [];
  for (const pair of pairs) {
    const queue = await backorderQueue(db, pair.warehouse_id, pair.variant_id, { lock: !p.preview });
    const plan = planQueue(queue, await freeForBackorders(db, pair.warehouse_id, pair.variant_id), () => 'reprocess');
    if (!p.preview) for (const c of plan.converted) await insertConversion(db, c, { requestKey: p.requestKey, actorId });
    results.push({ ...plan, warehouseId: pair.warehouse_id, variantId: pair.variant_id });
  }
  return { replayed: false, results };
}

/**
 * Antecipacao manual (D6-9/D6-11): converte uma encomenda fora da ordem da fila, inteira, se a mercadoria livre a
 * cobre. Variante travada pelo chamador. Justificativa obrigatoria; fica no historico imutavel.
 */
export async function advanceBackorder(db: Db, actorId: string, p: { reservationId: string; justification: string; requestKey: string }) {
  const done = (await db.query<{ reservation_id: string }>('SELECT reservation_id FROM reservation_conversions WHERE request_key = $1', [p.requestKey])).rows[0];
  if (done) {
    if (done.reservation_id !== p.reservationId) throw new AppError(409, 'REQUEST_KEY_REUSED', 'Chave de requisição já usada em outra encomenda.');
    return { replayed: true };
  }
  const r = (
    await db.query<{ variant_id: string; warehouse_id: string }>(
      `SELECT variant_id, coalesce(warehouse_id, (SELECT id FROM warehouses WHERE is_default)) AS warehouse_id FROM stock_reservations WHERE id = $1`,
      [p.reservationId],
    )
  ).rows[0];
  if (!r) throw new AppError(404, 'NOT_FOUND', 'Encomenda não encontrada.');
  const queue = await backorderQueue(db, r.warehouse_id, r.variant_id, { lock: true });
  const e = queue.find((x) => x.reservation_id === p.reservationId);
  if (!e) throw new AppError(409, 'NOT_BACKORDER', 'Esta reserva não é uma encomenda ativa de pedido pago (já convertida, liberada ou pedido fora da fila).');
  const free = await freeForBackorders(db, r.warehouse_id, r.variant_id);
  if (milli(e.qty) > free) {
    throw new AppError(409, 'AWAITING_GOODS', `Mercadoria livre insuficiente para a encomenda inteira: livre ${q3(Math.max(free, 0))}, encomenda ${e.qty}. Sem conversão parcial.`, {
      free: q3(Math.max(free, 0)),
      needed: e.qty,
    });
  }
  const position = queue.findIndex((x) => x.reservation_id === p.reservationId) + 1;
  await insertConversion(
    db,
    { reservationId: e.reservation_id, orderId: e.order_id, orderNumber: e.order_number, variantId: e.variant_id, warehouseId: e.warehouse_id, qty: e.qty, rule: 'manual' },
    { justification: p.justification, requestKey: p.requestKey, actorId },
  );
  return { replayed: false, orderId: e.order_id, orderNumber: e.order_number, position, ahead: queue.slice(0, position - 1).map((x) => x.order_number) };
}
