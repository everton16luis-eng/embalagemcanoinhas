// SGLog Fase 5: remessas, separacao, conferencia, embalagem e expedicao (docs/25-sglog-fase5-planejamento.md e
// docs/26-sglog-fase5.md).
//
// - A remessa nasce 'pending' ao confirmar a alocacao: um deposito por pedido (D4-4/D5-3), uma remessa por pedido
//   enquanto as remessas multiplas estiverem travadas (D5-4).
// - Separar e conferir NAO movimentam estoque nem liberam reserva: so registram (shipment_checks, imutavel). O que
//   esta separado e nao despachado nunca passa do fisico do deposito, e a soma das remessas nunca passa da alocacao
//   (gatilho shipment_items_check): duas separacoes nao usam a mesma quantidade.
// - Item de encomenda so pode ser separado quando a mercadoria chegou, por ordem de pagamento (regra provisoria,
//   D5-10; a conversao definitiva da reserva e da Fase 6).
// - Despachar baixa so o que esta na remessa (reserva inteira ou parte dela), numa transacao, com a mesma trava fiscal
//   do despacho antigo (NF-e autorizada ou dispensada). Repetir a acao com a mesma chave devolve a remessa sem agir.
// - Falta na separacao manda o pedido para analise, sem mexer no estoque (D5-9).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation, likePattern, pageQuery } from '../lib/http.js';
import { consumeReservation, lockVariants, moveStock, neg, qty as qtySchema, RES_COLS, variantInfo, assertWhole, type Reservation } from '../lib/stock.js';
import { requireAnyPermission, requirePermission, type Auth } from './auth.js';
import { addEvent } from './orders.js';
import { queueOrderMessage } from './whatsapp.js';

const milli = (v: string | number) => Math.round(Number(v) * 1000);
const q3 = (m: number) => (m / 1000).toFixed(3);
const fmt = (m: number) => String(m / 1000);

export const OPEN_SHIPMENT = ['pending', 'picking', 'checking', 'packed'] as const;
const SENT = ['shipped', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'returned'];
/** Situacoes logisticas em que a remessa pode andar (pedido alocado; despacho parcial ja feito). */
const MOVING = ['processing', 'partially_shipped', 'partially_delivered'];
const MARKETPLACES = ['mercadolivre', 'shopee'];

type ShipmentRow = {
  id: string;
  order_id: string;
  seq: number;
  kind: 'legacy' | 'delivery' | 'pickup' | 'marketplace';
  status: string;
  warehouse_id: string | null;
  version: number;
};
type OrderRow = {
  id: string;
  number: number;
  status: string;
  channel: string;
  version: number;
  invoice_status: string;
  logistics_status: string | null;
  logistics_version: number;
  allocation_required: boolean;
  ship_kind: string | null;
};
type ItemRow = {
  id: string;
  allocation_id: string;
  order_item_id: string;
  variant_id: string;
  sku: string;
  base_qty: string;
  picked_qty: string;
  checked_qty: string;
  status: string;
};

const ORDER_COLS = `id, number, status, channel, version, invoice_status, logistics_status, logistics_version, allocation_required, shipping_snapshot->>'kind' AS ship_kind`;
const SHIP_COLS = 'id, order_id, seq, kind, status, warehouse_id, version';

async function lockOrder(db: Db, id: string) {
  const o = (await db.query<OrderRow>(`SELECT ${ORDER_COLS} FROM orders WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!o) throw notFound();
  return o;
}

/** Trava pedido e remessa, nessa ordem (a mesma da alocacao: pedido antes das variantes). */
async function lockShipment(db: Db, id: string) {
  const s0 = (await db.query<{ order_id: string }>('SELECT order_id FROM shipments WHERE id = $1', [id])).rows[0];
  if (!s0) throw notFound();
  const order = await lockOrder(db, s0.order_id);
  const s = (await db.query<ShipmentRow>(`SELECT ${SHIP_COLS} FROM shipments WHERE id = $1 FOR UPDATE`, [id])).rows[0]!;
  if (s.kind === 'legacy') throw new AppError(409, 'LEGACY_SHIPMENT', 'Remessa de pedido antigo: já foi despachada pelo fluxo anterior.');
  return { order, s };
}

async function shipmentItems(db: Db | typeof pool, shipmentId: string) {
  return (
    await db.query<ItemRow>(
      `SELECT i.id, i.allocation_id, i.order_item_id, i.variant_id, v.sku, i.base_qty, i.picked_qty, i.checked_qty, i.status
       FROM shipment_items i JOIN product_variants v ON v.id = i.variant_id WHERE i.shipment_id = $1 AND i.status = 'active' ORDER BY v.sku, i.id`,
      [shipmentId],
    )
  ).rows;
}

async function settings(db: Db | typeof pool) {
  return (await db.query<{ multi_shipment_status: 'blocked' | 'enabled'; distinct_checker: boolean }>('SELECT multi_shipment_status, distinct_checker FROM logistics_settings')).rows[0]!;
}

async function event(db: Db, e: { shipmentId: string; from: string | null; to: string; action: string; note?: string | null; requestKey?: string | null; actorId: string | null; source?: string }) {
  await db.query(
    `INSERT INTO shipment_events (shipment_id, from_status, to_status, action, source, note, request_key, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.shipmentId, e.from, e.to, e.action, e.source ?? 'manual', e.note ?? null, e.requestKey ?? null, e.actorId],
  );
}

async function setStatus(db: Db, s: ShipmentRow, to: string, extra = '') {
  await db.query(`UPDATE shipments SET status = $2, version = version + 1, updated_at = now()${extra} WHERE id = $1`, [s.id, to]);
}

async function logCheck(
  db: Db,
  c: { shipmentId: string; itemId: string | null; kind: string; qty: string; result: string; skuRead?: string | null; note?: string | null; requestKey?: string | null; actorId: string },
) {
  await db.query(
    `INSERT INTO shipment_checks (shipment_id, shipment_item_id, kind, sku_read, qty, result, note, request_key, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [c.shipmentId, c.itemId, c.kind, c.skuRead ?? null, c.qty, c.result, c.note ?? null, c.requestKey ?? null, c.actorId],
  );
}

const kindFor = (o: { channel: string; ship_kind: string | null }) =>
  MARKETPLACES.includes(o.channel) ? 'marketplace' : o.ship_kind === 'pickup' ? 'pickup' : 'delivery';

// ---------------------------------------------------------------------------------------------------------------
// Ligacao com a alocacao (modules/logistics.ts)

/**
 * Antes de trocar ou desfazer a alocacao: remessa com mercadoria em separacao, conferencia ou embalagem recusa
 * (ajuste 3). Remessas so pendentes, sem nada separado, sao canceladas. Chamar com o pedido travado.
 */
export async function closePendingShipments(db: Db, actorId: string | null, orderId: string, reason: string) {
  const open = (
    await db.query<ShipmentRow & { picked: string }>(
      `SELECT s.id, s.order_id, s.seq, s.kind, s.status, s.warehouse_id, s.version,
              coalesce((SELECT sum(i.picked_qty) FROM shipment_items i WHERE i.shipment_id = s.id AND i.status = 'active'), 0)::text AS picked
       FROM shipments s WHERE s.order_id = $1 AND s.kind <> 'legacy' AND s.status = ANY($2::text[]) ORDER BY s.seq FOR UPDATE`,
      [orderId, OPEN_SHIPMENT],
    )
  ).rows;
  const busy = open.filter((s) => s.status !== 'pending' || milli(s.picked) > 0);
  if (busy.length) {
    throw new AppError(
      409,
      'SHIPMENT_IN_PROGRESS',
      `A remessa nº ${busy[0]!.seq} já está em separação, conferência ou embalagem. Devolva a mercadoria ao lugar e libere a remessa antes de trocar ou desfazer a alocação.`,
      { shipments: busy.map((s) => ({ id: s.id, seq: s.seq, status: s.status })) },
    );
  }
  for (const s of open) {
    await db.query(`UPDATE shipments SET status = 'canceled', canceled_at = now(), cancel_reason = $2, version = version + 1, updated_at = now() WHERE id = $1`, [
      s.id,
      reason.slice(0, 500),
    ]);
    await event(db, { shipmentId: s.id, from: s.status, to: 'canceled', action: 'reallocate', source: 'system', note: reason.slice(0, 500), actorId });
  }
  return open.length;
}

/**
 * Remessa pendente com o que esta alocado e ainda nao foi para outra remessa: um deposito, todas as alocacoes de
 * estoque e de encomenda (dropshipping sai do fornecedor). Chamar com o pedido travado, depois das reservas.
 */
export async function createShipmentsForOrder(db: Db, actorId: string | null, orderId: string, note: string | null = null) {
  const order = (await db.query<OrderRow>(`SELECT ${ORDER_COLS} FROM orders WHERE id = $1`, [orderId])).rows[0]!;
  const free = (
    await db.query<{ allocation_id: string; order_item_id: string; variant_id: string; warehouse_id: string; free: string }>(
      `SELECT a.id AS allocation_id, a.order_item_id, a.variant_id, a.warehouse_id,
              (a.base_qty - coalesce((SELECT sum(i.base_qty) FROM shipment_items i JOIN shipments s ON s.id = i.shipment_id
                                       WHERE i.allocation_id = a.id AND i.status = 'active' AND s.status <> 'canceled'), 0))::text AS free
       FROM fulfillment_allocations a JOIN fulfillments f ON f.id = a.fulfillment_id
       WHERE f.order_id = $1 AND f.status = 'confirmed' AND f.mode IN ('stock', 'purchase_to_order') AND a.status = 'active'
       ORDER BY a.warehouse_id, a.id`,
      [orderId],
    )
  ).rows.filter((r) => milli(r.free) > 0);
  const byWarehouse = new Map<string, typeof free>();
  for (const r of free) byWarehouse.set(r.warehouse_id, [...(byWarehouse.get(r.warehouse_id) ?? []), r]);
  const created: string[] = [];
  for (const [warehouseId, rows] of byWarehouse) {
    const seq = (await db.query<{ n: number }>('SELECT coalesce(max(seq), 0)::int + 1 AS n FROM shipments WHERE order_id = $1', [orderId])).rows[0]!.n;
    const id = (
      await db.query<{ id: string }>(
        `INSERT INTO shipments (order_id, seq, kind, status, warehouse_id, version, created_by, shipped_at) VALUES ($1, $2, $3, 'pending', $4, 0, $5, NULL) RETURNING id`,
        [orderId, seq, kindFor(order), warehouseId, actorId],
      )
    ).rows[0]!.id;
    for (const r of rows) {
      await db.query(`INSERT INTO shipment_items (shipment_id, allocation_id, order_item_id, variant_id, base_qty) VALUES ($1, $2, $3, $4, $5)`, [
        id,
        r.allocation_id,
        r.order_item_id,
        r.variant_id,
        r.free,
      ]);
    }
    await event(db, { shipmentId: id, from: null, to: 'pending', action: 'create', source: actorId ? 'manual' : 'system', note, actorId });
    created.push(id);
  }
  return created;
}

// ---------------------------------------------------------------------------------------------------------------
// Projecao para o pedido (D5-5, tabela do planejamento §3.7)

async function projectOrder(db: Db, order: OrderRow, actorId: string, note: string | null = null) {
  const rows = (
    await db.query<{ status: string }>(`SELECT status FROM shipments WHERE order_id = $1 AND kind <> 'legacy' AND status <> 'canceled'`, [order.id])
  ).rows.map((r) => r.status);
  if (!rows.length) return;
  const open = rows.filter((s) => (OPEN_SHIPMENT as readonly string[]).includes(s));
  const sent = rows.filter((s) => SENT.includes(s));
  const delivered = rows.filter((s) => s === 'delivered');
  let status = order.status;
  let logistics = order.logistics_status;
  if (!sent.length) {
    // Nada despachado: separacao em andamento ou tudo embalado.
    if (open.every((s) => s === 'packed')) status = 'ready';
    else if (open.some((s) => s !== 'pending')) status = 'preparing';
    else status = order.status === 'ready' ? 'preparing' : order.status;
    if (status === 'preparing' && order.status === 'paid' && !open.some((s) => s !== 'pending')) status = 'paid';
  } else if (delivered.length === rows.length) {
    status = 'delivered';
    logistics = 'completed';
  } else {
    status = 'shipped';
    logistics = open.length ? 'partially_shipped' : delivered.length ? 'partially_delivered' : 'shipped';
  }
  if (status === order.status && logistics === order.logistics_status) return;
  // Comercial e logistico juntos: o gatilho orders_logistics_project mantem o parcial e orders_logistics_close so
  // encerra os atendimentos quando nao sobra remessa aberta.
  await db.query(
    `UPDATE orders SET status = $2, logistics_status = $3, updated_at = now(), version = version + 1,
       logistics_version = CASE WHEN $3 IS DISTINCT FROM logistics_status THEN logistics_version + 1 ELSE logistics_version END WHERE id = $1`,
    [order.id, status, logistics],
  );
  if (status === 'shipped' && order.status === 'shipped' && !open.length) {
    // Ultima remessa de um pedido ja 'shipped' (despacho parcial antes): o gatilho nao roda, encerra aqui.
    const n =
      (await db.query(`UPDATE fulfillments SET status = 'done', closed_at = now() WHERE order_id = $1 AND status = 'confirmed'`, [order.id])).rowCount ?? 0;
    if (n) await db.query(`INSERT INTO allocation_decisions (order_id, kind, chosen, actor_id) VALUES ($1, 'shipped', $2, $3)`, [order.id, JSON.stringify({ fulfillments: n }), actorId]);
  }
  if (status !== order.status) {
    await addEvent(db, order.id, status, note, actorId);
    if (status === 'ready' && order.ship_kind === 'pickup') await queueOrderMessage(db, order.id, 'order_ready');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Regras da separacao

/**
 * Pode separar `qty` deste item? Confere, com a variante travada:
 * - a reserva da alocacao continua ativa e cobre o que ja esta separado mais o novo;
 * - encomenda: a mercadoria chegou, por ordem de pagamento (fisico - reservas firmes cobre as encomendas pagas antes
 *   e esta). Regra provisoria D5-10: nada muda na reserva;
 * - fisico: separado e nao despachado no deposito (todas as remessas abertas) + novo <= fisico do deposito.
 */
async function assertPickable(db: Db, s: ShipmentRow, it: ItemRow, add: number) {
  const res = (
    await db.query<Reservation>(`SELECT ${RES_COLS} FROM stock_reservations WHERE allocation_id = $1 AND status = 'active'`, [it.allocation_id])
  ).rows[0];
  if (!res) throw new AppError(409, 'RESERVATION_MISSING', `${it.sku}: a reserva desta alocação não está ativa. Revise a alocação do pedido.`);
  const pickedForAllocation = (
    await db.query<{ q: string }>(
      `SELECT coalesce(sum(i.picked_qty), 0)::text AS q FROM shipment_items i JOIN shipments x ON x.id = i.shipment_id
       WHERE i.allocation_id = $1 AND i.status = 'active' AND x.status = ANY($2::text[])`,
      [it.allocation_id, OPEN_SHIPMENT],
    )
  ).rows[0]!.q;
  if (milli(pickedForAllocation) + add > milli(res.qty)) {
    throw new AppError(409, 'OVER_RESERVATION', `${it.sku}: a separação passaria da quantidade reservada para este pedido (${Number(res.qty)}).`);
  }
  const loc = (
    await db.query<{ on_hand: string; firm: string; picked: string }>(
      `SELECT coalesce((SELECT on_hand FROM stock_location_balances WHERE warehouse_id = $1 AND variant_id = $2), 0)::text AS on_hand,
              coalesce((SELECT sum(qty) FROM stock_reservations WHERE warehouse_id = $1 AND variant_id = $2 AND status = 'active' AND NOT backorder), 0)::text AS firm,
              coalesce((SELECT sum(i.picked_qty) FROM shipment_items i JOIN shipments x ON x.id = i.shipment_id
                         WHERE x.warehouse_id = $1 AND i.variant_id = $2 AND i.status = 'active' AND x.status = ANY($3::text[])), 0)::text AS picked`,
      [s.warehouse_id, it.variant_id, OPEN_SHIPMENT],
    )
  ).rows[0]!;
  if (res.backorder) {
    const queue = (
      await db.query<{ qty: string; mine: boolean }>(
        `SELECT r.qty::text AS qty, r.id = $3 AS mine FROM stock_reservations r LEFT JOIN orders o ON r.source_type = 'order' AND o.id::text = r.source_id
         WHERE r.warehouse_id = $1 AND r.variant_id = $2 AND r.status = 'active' AND r.backorder
         ORDER BY o.paid_at NULLS LAST, r.created_at, r.id`,
        [s.warehouse_id, it.variant_id, res.id],
      )
    ).rows;
    let ahead = 0;
    for (const r of queue) {
      ahead += milli(r.qty);
      if (r.mine) break;
    }
    const arrived = milli(loc.on_hand) - milli(loc.firm);
    if (arrived < ahead) {
      throw new AppError(
        409,
        'AWAITING_GOODS',
        `${it.sku}: encomenda aguardando mercadoria. Chegou ${fmt(Math.max(arrived, 0))}; as encomendas pagas antes desta e ela somam ${fmt(ahead)}.`,
        { arrived: q3(Math.max(arrived, 0)), needed: q3(ahead) },
      );
    }
  }
  if (milli(loc.picked) + add > milli(loc.on_hand)) {
    throw new AppError(
      409,
      'INSUFFICIENT_PHYSICAL',
      `${it.sku}: físico no depósito ${fmt(milli(loc.on_hand))}, já separado em remessas abertas ${fmt(milli(loc.picked))}. Registre a falta se a mercadoria não está no lugar.`,
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Acoes. Todas com chave de requisicao: repetir (duplo clique, rede) devolve a remessa sem agir de novo.

const key = z.string().min(8).max(100);
const versioned = z.strictObject({ version: z.number().int(), requestKey: key });
const note = z.string().trim().min(3).max(300);

async function replayedEvent(db: Db | typeof pool, requestKey: string) {
  return (await db.query<{ shipment_id: string }>('SELECT shipment_id FROM shipment_events WHERE request_key = $1', [requestKey])).rows[0] ?? null;
}
async function replayedCheck(db: Db | typeof pool, requestKey: string) {
  return (await db.query<{ shipment_id: string }>('SELECT shipment_id FROM shipment_checks WHERE request_key = $1', [requestKey])).rows[0] ?? null;
}

type Ctx = { db: Db; order: OrderRow; s: ShipmentRow; auth: Auth };
type Outcome = { rejection?: AppError } | void;

/**
 * Executa a acao na transacao, com pedido e remessa travados. Recusa registrada (SKU de fora, quantidade acima)
 * grava o historico e so depois devolve o erro, fora da transacao, para o registro ficar.
 */
async function act(auth: Auth, shipmentId: string, requestKey: string, kind: 'event' | 'check', fn: (c: Ctx) => Promise<Outcome>) {
  const replay = kind === 'event' ? replayedEvent : replayedCheck;
  const prior = await replay(pool, requestKey);
  if (prior) {
    if (prior.shipment_id !== shipmentId) throw new AppError(409, 'REQUEST_KEY_REUSED', 'Chave de requisição já usada em outra remessa.');
    return { replayed: true, shipment: await shipmentView(pool, shipmentId, auth) };
  }
  let outcome: Outcome;
  try {
    outcome = await tx(auth.userId, async (db) => {
      const { order, s } = await lockShipment(db, shipmentId);
      if (await replay(db, requestKey)) return { replayedInside: true } as unknown as Outcome;
      return fn({ db, order, s, auth });
    });
  } catch (err) {
    if ((isUniqueViolation(err, 'shipment_events_request_key_key') || isUniqueViolation(err, 'shipment_checks_request_key_key')) && (await replay(pool, requestKey))) {
      return { replayed: true, shipment: await shipmentView(pool, shipmentId, auth) };
    }
    throw err;
  }
  if (outcome && 'rejection' in outcome && outcome.rejection) throw outcome.rejection;
  const replayedInside = Boolean(outcome && (outcome as { replayedInside?: boolean }).replayedInside);
  return { replayed: replayedInside, shipment: await shipmentView(pool, shipmentId, auth) };
}

function assertVersion(s: ShipmentRow, version: number) {
  if (s.version !== version) throw new AppError(409, 'VERSION_CONFLICT', 'A remessa foi alterada por outra pessoa. Recarregue a página.');
}
function assertStatus(s: ShipmentRow, allowed: readonly string[], msg: string) {
  if (!allowed.includes(s.status)) throw new AppError(409, 'INVALID_TRANSITION', msg, { status: s.status });
}
function assertMoving(order: OrderRow) {
  if (order.status === 'canceled') throw new AppError(409, 'ORDER_CANCELED', 'Pedido cancelado.');
  if (!MOVING.includes(order.logistics_status ?? '')) {
    throw new AppError(
      409,
      'ORDER_IN_ANALYSIS',
      order.logistics_status === 'analysis'
        ? 'O pedido está em análise (falta ou alocação desfeita). Resolva a alocação antes de continuar a separação.'
        : 'O pedido não está com a alocação confirmada.',
    );
  }
}
function itemOf(items: ItemRow[], id: string) {
  const it = items.find((i) => i.id === id);
  if (!it) throw new AppError(404, 'ITEM_NOT_FOUND', 'Item não encontrado nesta remessa.');
  return it;
}

async function startPicking(c: Ctx, requestKey: string) {
  assertMoving(c.order);
  await setStatus(c.db, c.s, 'picking', ', picking_started_at = coalesce(picking_started_at, now())');
  await event(c.db, { shipmentId: c.s.id, from: c.s.status, to: 'picking', action: 'start_picking', requestKey, actorId: c.auth.userId });
  await projectOrder(c.db, c.order, c.auth.userId, `Separação iniciada (remessa nº ${c.s.seq})`);
}

// ---------------------------------------------------------------------------------------------------------------
// Leitura

export async function shipmentView(db: Db | typeof pool, id: string, auth?: Auth) {
  const s = (
    await db.query(
      `SELECT s.id, s.order_id, s.seq, s.kind, s.status, s.warehouse_id, w.name AS warehouse_name, s.version, s.carrier, s.tracking_code, s.tracking_url,
              s.volumes, s.weight_g, s.packages, s.picking_started_at, s.checked_at, s.packed_at, s.shipped_at, s.delivered_at, s.canceled_at,
              s.cancel_reason, s.created_at, s.updated_at, o.number AS order_number, o.status AS order_status, o.logistics_status, o.logistics_note,
              o.invoice_status, o.channel, o.shipping_snapshot->>'kind' AS ship_kind, o.shipping_snapshot->>'name' AS ship_name,
              o.buyer->>'name' AS buyer_name, o.paid_at, o.allocation_required
       FROM shipments s JOIN orders o ON o.id = s.order_id LEFT JOIN warehouses w ON w.id = s.warehouse_id WHERE s.id = $1`,
      [id],
    )
  ).rows[0];
  if (!s) throw notFound();
  const items = (
    await db.query(
      `SELECT i.id, i.allocation_id, i.order_item_id, i.variant_id, v.sku, oi.product_name, oi.packaging_label, i.base_qty, i.picked_qty, i.checked_qty, i.status,
              l.bin, coalesce(r.backorder, false) AS backorder, r.qty AS reserved_qty, p.base_unit
       FROM shipment_items i JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id JOIN order_items oi ON oi.id = i.order_item_id
       JOIN shipments x ON x.id = i.shipment_id
       LEFT JOIN stock_location_balances l ON l.warehouse_id = x.warehouse_id AND l.variant_id = i.variant_id
       LEFT JOIN stock_reservations r ON r.allocation_id = i.allocation_id AND r.status = 'active'
       WHERE i.shipment_id = $1 ORDER BY i.status, l.bin NULLS LAST, v.sku, i.id`,
      [id],
    )
  ).rows;
  const checks = (
    await db.query(
      `SELECT c.id::text, c.shipment_item_id, c.kind, c.sku_read, c.qty, c.result, c.note, c.created_at, u.name AS actor_name, v.sku
       FROM shipment_checks c LEFT JOIN users u ON u.id = c.actor_id LEFT JOIN shipment_items i ON i.id = c.shipment_item_id
       LEFT JOIN product_variants v ON v.id = i.variant_id WHERE c.shipment_id = $1 ORDER BY c.id DESC LIMIT 300`,
      [id],
    )
  ).rows;
  const events = (
    await db.query(
      `SELECT e.id::text, e.from_status, e.to_status, e.action, e.source, e.note, e.occurred_at, u.name AS actor_name
       FROM shipment_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.shipment_id = $1 ORDER BY e.id DESC`,
      [id],
    )
  ).rows;
  const st = await settings(db);
  const pickers = (
    await db.query<{ actor_id: string }>(`SELECT DISTINCT actor_id FROM shipment_checks WHERE shipment_id = $1 AND kind = 'pick' AND actor_id IS NOT NULL`, [id])
  ).rows.map((r) => r.actor_id);
  return {
    ...s,
    items,
    checks,
    events,
    settings: { multiShipment: st.multi_shipment_status, distinctChecker: st.distinct_checker },
    // A tela avisa antes: com conferente distinto ligado, quem separou nao confere.
    youPicked: auth ? pickers.includes(auth.userId) : false,
  };
}

/** Remessas do pedido, para a tela do pedido (painel e cliente). O cliente nao ve historico nem nomes. */
export async function orderShipments(db: Db | typeof pool, orderId: string, opts: { staff?: boolean } = {}) {
  return (
    await db.query(
      `SELECT s.id, s.seq, s.kind, s.status, s.carrier, s.tracking_code, s.tracking_url, s.volumes, s.weight_g, s.shipped_at, s.delivered_at, s.created_at
              ${opts.staff ? ', s.warehouse_id, w.name AS warehouse_name, s.version, s.canceled_at, s.cancel_reason, s.packed_at' : ''},
              coalesce((SELECT json_agg(json_build_object('sku', v.sku, 'productName', oi.product_name, 'qty', i.base_qty${opts.staff ? `, 'picked', i.picked_qty, 'checked', i.checked_qty` : ''}) ORDER BY v.sku)
                        FROM shipment_items i JOIN product_variants v ON v.id = i.variant_id JOIN order_items oi ON oi.id = i.order_item_id
                        WHERE i.shipment_id = s.id AND i.status = 'active'), '[]') AS items
       FROM shipments s LEFT JOIN warehouses w ON w.id = s.warehouse_id
       WHERE s.order_id = $1 ${opts.staff ? '' : `AND s.status <> 'canceled'`} ORDER BY s.seq`,
      [orderId],
    )
  ).rows;
}

// ---------------------------------------------------------------------------------------------------------------
// Rotas: /api/v1/admin/shipments

const packageSchema = z.strictObject({
  weightG: z.number().int().min(1).max(1_000_000),
  lengthMm: z.number().int().min(1).max(10_000).optional(),
  widthMm: z.number().int().min(1).max(10_000).optional(),
  heightMm: z.number().int().min(1).max(10_000).optional(),
});

export async function shipmentRoutes(app: FastifyInstance) {
  // Fila da expedicao: remessas abertas por situacao (e as despachadas recentes, para acompanhamento).
  app.get('/', async (req) => {
    requirePermission(req, 'logistics.view');
    const q = pageQuery
      .extend({
        status: z.enum(['open', 'pending', 'picking', 'checking', 'packed', 'shipped', 'delivered', 'canceled']).default('open'),
        warehouseId: z.uuid().optional(),
        q: z.string().trim().max(60).optional(),
      })
      .parse(req.query);
    const statuses = q.status === 'open' ? [...OPEN_SHIPMENT] : q.status === 'shipped' ? SENT.filter((s) => s !== 'delivered') : [q.status];
    const params: unknown[] = [statuses];
    let where = `s.kind <> 'legacy' AND s.status = ANY($1::text[])`;
    if (q.warehouseId) {
      params.push(q.warehouseId);
      where += ` AND s.warehouse_id = $${params.length}`;
    }
    if (q.q) {
      const n = Number(q.q.replace(/\D/g, ''));
      params.push(likePattern(q.q), Number.isSafeInteger(n) && n > 0 ? n : -1);
      where += ` AND (o.number = $${params.length} OR o.buyer->>'name' ILIKE $${params.length - 1} OR s.tracking_code ILIKE $${params.length - 1})`;
    }
    const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM shipments s JOIN orders o ON o.id = s.order_id WHERE ${where}`, params)).rows[0]!.n;
    const counts = (
      await pool.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM shipments WHERE kind <> 'legacy' AND status = ANY($1::text[]) GROUP BY 1`, [
        OPEN_SHIPMENT,
      ])
    ).rows;
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const { rows } = await pool.query(
      `SELECT s.id, s.order_id, s.seq, s.kind, s.status, s.version, s.created_at, s.updated_at, s.shipped_at, s.tracking_code, w.name AS warehouse_name,
              o.number AS order_number, o.status AS order_status, o.logistics_status, o.paid_at, o.channel, o.invoice_status, o.buyer->>'name' AS buyer_name,
              (SELECT count(*)::int FROM shipment_items i WHERE i.shipment_id = s.id AND i.status = 'active') AS items,
              (SELECT coalesce(sum(i.base_qty), 0) FROM shipment_items i WHERE i.shipment_id = s.id AND i.status = 'active') AS total_qty,
              (SELECT coalesce(sum(i.picked_qty), 0) FROM shipment_items i WHERE i.shipment_id = s.id AND i.status = 'active') AS picked_qty,
              (SELECT coalesce(sum(i.checked_qty), 0) FROM shipment_items i WHERE i.shipment_id = s.id AND i.status = 'active') AS checked_qty,
              EXISTS (SELECT 1 FROM shipment_items i JOIN stock_reservations r ON r.allocation_id = i.allocation_id AND r.status = 'active'
                       WHERE i.shipment_id = s.id AND i.status = 'active' AND r.backorder) AS has_backorder
       FROM shipments s JOIN orders o ON o.id = s.order_id LEFT JOIN warehouses w ON w.id = s.warehouse_id
       WHERE ${where}
       ORDER BY CASE s.status WHEN 'packed' THEN 0 WHEN 'checking' THEN 1 WHEN 'picking' THEN 2 WHEN 'pending' THEN 3 ELSE 4 END, o.paid_at NULLS LAST, o.number, s.seq
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: rows, total, page: q.page, pageSize: q.pageSize, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
  });

  app.get('/settings', async (req) => {
    requireAnyPermission(req, 'logistics.view', 'settings.manage');
    const s = (
      await pool.query(
        `SELECT l.multi_shipment_status, l.multi_validator_name, l.multi_validated_at, u.name AS multi_validated_by_name, l.distinct_checker, l.version
         FROM logistics_settings l LEFT JOIN users u ON u.id = l.multi_validated_by`,
      )
    ).rows[0];
    return { settings: s };
  });

  // Trava das remessas multiplas (D5-4): so libera com o registro de quem validou o tratamento fiscal.
  app.put('/settings/multi-shipment', async (req) => {
    const auth = requirePermission(req, 'settings.manage');
    const b = z
      .strictObject({ status: z.enum(['blocked', 'enabled']), fiscalValidatorName: z.string().trim().min(3).max(120).optional(), version: z.number().int() })
      .refine((v) => v.status === 'blocked' || Boolean(v.fiscalValidatorName), 'Informe quem validou o tratamento fiscal da entrega parcial.')
      .parse(req.body);
    return tx(auth.userId, async (db) => {
      const before = (await db.query('SELECT multi_shipment_status, multi_validator_name, multi_validated_by, multi_validated_at, version FROM logistics_settings FOR UPDATE')).rows[0];
      if (before.version !== b.version) throw new AppError(409, 'VERSION_CONFLICT', 'A configuração mudou. Recarregue a página.');
      const enabled = b.status === 'enabled';
      const after = (
        await db.query(
          `UPDATE logistics_settings SET multi_shipment_status = $1, multi_validator_name = $2, multi_validated_by = $3, multi_validated_at = CASE WHEN $4 THEN now() END,
             version = version + 1, updated_at = now() RETURNING multi_shipment_status, multi_validator_name, multi_validated_by, multi_validated_at, distinct_checker, version`,
          [b.status, enabled ? b.fiscalValidatorName : null, enabled ? auth.userId : null, enabled],
        )
      ).rows[0];
      await audit(db, { actorId: auth.userId, action: 'logistics.multi_shipment', entity: 'logistics_settings', before, after, ip: req.ip });
      return { settings: after };
    });
  });

  // Conferente diferente de quem separou (D5-7), desligado de inicio.
  app.put('/settings/distinct-checker', async (req) => {
    const auth = requirePermission(req, 'settings.manage');
    const b = z.strictObject({ enabled: z.boolean(), version: z.number().int() }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const before = (await db.query('SELECT distinct_checker, version FROM logistics_settings FOR UPDATE')).rows[0];
      if (before.version !== b.version) throw new AppError(409, 'VERSION_CONFLICT', 'A configuração mudou. Recarregue a página.');
      const after = (
        await db.query('UPDATE logistics_settings SET distinct_checker = $1, version = version + 1, updated_at = now() RETURNING distinct_checker, version', [b.enabled])
      ).rows[0];
      await audit(db, { actorId: auth.userId, action: 'logistics.distinct_checker', entity: 'logistics_settings', before, after, ip: req.ip });
      return { settings: after };
    });
  });

  app.get('/:id', async (req) => {
    const auth = requirePermission(req, 'logistics.view');
    const { id } = idParams.parse(req.params);
    return { shipment: await shipmentView(pool, id, auth) };
  });

  // Criar a remessa do que esta alocado e sem remessa (remessa cancelada, por exemplo). Travado: uma por pedido.
  app.post('/orders/:id', async (req) => {
    const auth = requirePermission(req, 'logistics.manage');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ logisticsVersion: z.number().int(), requestKey: key }).parse(req.body);
    const prior = await replayedEvent(pool, b.requestKey);
    if (prior) return { replayed: true, shipments: await orderShipments(pool, id, { staff: true }) };
    try {
      return await tx(auth.userId, async (db) => {
        const order = await lockOrder(db, id);
        if (await replayedEvent(db, b.requestKey)) return { replayed: true, shipments: await orderShipments(db, id, { staff: true }) };
        if (order.logistics_version !== b.logisticsVersion) throw new AppError(409, 'VERSION_CONFLICT', 'A alocação do pedido mudou. Recarregue a página.');
        assertMoving(order);
        const live = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM shipments WHERE order_id = $1 AND kind <> 'legacy' AND status <> 'canceled'`, [id])).rows[0]!.n;
        if (live > 0 && (await settings(db)).multi_shipment_status !== 'enabled') {
          throw new AppError(409, 'MULTI_SHIPMENT_BLOCKED', 'Remessas múltiplas estão travadas até a validação fiscal da entrega parcial. O pedido sai numa remessa só.');
        }
        const created = await createShipmentsForOrder(db, auth.userId, id, 'Remessa criada manualmente');
        if (!created.length) throw new AppError(409, 'NOTHING_TO_SHIP', 'Tudo o que está alocado já está em remessa.');
        await db.query(`INSERT INTO shipment_events (shipment_id, from_status, to_status, action, note, request_key, actor_id) VALUES ($1, 'pending', 'pending', 'create_request', NULL, $2, $3)`, [
          created[0],
          b.requestKey,
          auth.userId,
        ]);
        await audit(db, { actorId: auth.userId, action: 'shipment.create', entity: 'order', entityId: id, after: { shipments: created }, ip: req.ip });
        return { replayed: false, shipments: await orderShipments(db, id, { staff: true }) };
      });
    } catch (err) {
      if (isUniqueViolation(err, 'shipment_events_request_key_key') && (await replayedEvent(pool, b.requestKey))) {
        return { replayed: true, shipments: await orderShipments(pool, id, { staff: true }) };
      }
      throw err;
    }
  });

  app.post('/:id/start', async (req) => {
    const auth = requirePermission(req, 'shipping.pick');
    const { id } = idParams.parse(req.params);
    const b = versioned.parse(req.body);
    return act(auth, id, b.requestKey, 'event', async (c) => {
      assertVersion(c.s, b.version);
      assertStatus(c.s, ['pending'], 'Só remessas pendentes podem começar a separação.');
      await startPicking(c, b.requestKey);
    });
  });

  // Separar: registra a quantidade tirada do lugar. Nao mexe no estoque.
  app.post('/:id/pick', async (req) => {
    const auth = requirePermission(req, 'shipping.pick');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ itemId: z.uuid(), qty: qtySchema, requestKey: key }).parse(req.body);
    return act(auth, id, b.requestKey, 'check', async (c) => {
      assertStatus(c.s, ['picking'], 'Inicie a separação da remessa antes de separar os itens.');
      assertMoving(c.order);
      const it = itemOf(await shipmentItems(c.db, c.s.id), b.itemId);
      const info = await variantInfo(c.db, it.variant_id);
      assertWhole(info, b.qty);
      const add = milli(b.qty);
      if (milli(it.picked_qty) + add > milli(it.base_qty)) {
        await logCheck(c.db, { shipmentId: c.s.id, itemId: it.id, kind: 'rejected', qty: b.qty, result: 'over', note: `Separação acima do previsto (${Number(it.base_qty)})`, requestKey: b.requestKey, actorId: auth.userId });
        return {
          rejection: new AppError(422, 'OVER_EXPECTED', `${it.sku}: a remessa pede ${Number(it.base_qty)}; já separado ${Number(it.picked_qty)}. Não é possível separar ${Number(b.qty)}.`),
        };
      }
      await lockVariants(c.db, [it.variant_id]);
      await assertPickable(c.db, c.s, it, add);
      await c.db.query('UPDATE shipment_items SET picked_qty = picked_qty + $2 WHERE id = $1', [it.id, b.qty]);
      await logCheck(c.db, { shipmentId: c.s.id, itemId: it.id, kind: 'pick', qty: b.qty, result: 'ok', requestKey: b.requestKey, actorId: auth.userId });
      await c.db.query('UPDATE shipments SET version = version + 1, updated_at = now() WHERE id = $1', [c.s.id]);
    });
  });

  // Devolver ao lugar (correcao da separacao): novo registro, nunca edicao. Nao pode ficar abaixo do conferido.
  app.post('/:id/unpick', async (req) => {
    const auth = requirePermission(req, 'shipping.pick');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ itemId: z.uuid(), qty: qtySchema, note, requestKey: key }).parse(req.body);
    return act(auth, id, b.requestKey, 'check', async (c) => {
      assertStatus(c.s, ['pending', 'picking'], 'Volte a remessa para a separação antes de devolver mercadoria ao lugar.');
      const it = itemOf(await shipmentItems(c.db, c.s.id), b.itemId);
      if (milli(b.qty) > milli(it.picked_qty) - milli(it.checked_qty)) {
        throw new AppError(
          422,
          'OVER_PICKED',
          milli(it.checked_qty) > 0
            ? `${it.sku}: separado ${Number(it.picked_qty)}, conferido ${Number(it.checked_qty)}. Desfaça a conferência antes de devolver mais ao lugar.`
            : `${it.sku}: separado ${Number(it.picked_qty)}. Não é possível devolver ${Number(b.qty)}.`,
        );
      }
      await c.db.query('UPDATE shipment_items SET picked_qty = picked_qty - $2 WHERE id = $1', [it.id, b.qty]);
      await logCheck(c.db, { shipmentId: c.s.id, itemId: it.id, kind: 'unpick', qty: b.qty, result: 'corrected', note: b.note, requestKey: b.requestKey, actorId: auth.userId });
      await c.db.query('UPDATE shipments SET version = version + 1, updated_at = now() WHERE id = $1', [c.s.id]);
    });
  });

  // Falta na separacao (D5-9): registra, devolve a remessa para pendente e manda o pedido para analise. Sem
  // movimento de estoque: a correcao do saldo e por inventario ou perda, com motivo.
  app.post('/:id/shortage', async (req) => {
    const auth = requirePermission(req, 'shipping.pick');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ itemId: z.uuid(), found: z.string().trim().regex(/^\d{1,11}(\.\d{1,3})?$/), note, requestKey: key }).parse(req.body);
    return act(auth, id, b.requestKey, 'check', async (c) => {
      assertStatus(c.s, ['picking'], 'Falta só pode ser registrada durante a separação.');
      const it = itemOf(await shipmentItems(c.db, c.s.id), b.itemId);
      const missing = milli(it.base_qty) - milli(b.found);
      if (missing <= 0) throw new AppError(422, 'NO_SHORTAGE', `${it.sku}: encontrado ${Number(b.found)} cobre a remessa (${Number(it.base_qty)}).`);
      const wh = (await c.db.query<{ name: string }>('SELECT name FROM warehouses WHERE id = $1', [c.s.warehouse_id])).rows[0]!.name;
      const text = `Falta na separação: ${it.sku}, depósito ${wh}, pedido nº ${c.order.number}, remessa nº ${c.s.seq}: pedido ${Number(it.base_qty)}, encontrado ${Number(b.found)}. ${b.note}`.slice(0, 500);
      await logCheck(c.db, { shipmentId: c.s.id, itemId: it.id, kind: 'shortage', qty: q3(missing), result: 'shortage', note: b.note, requestKey: b.requestKey, actorId: auth.userId });
      await setStatus(c.db, c.s, 'pending');
      await event(c.db, { shipmentId: c.s.id, from: c.s.status, to: 'pending', action: 'shortage', note: text, actorId: auth.userId });
      await c.db.query(
        `UPDATE orders SET logistics_status = 'analysis', logistics_note = $2, logistics_version = logistics_version + 1 WHERE id = $1`,
        [c.order.id, text],
      );
      await c.db.query(`INSERT INTO allocation_decisions (order_id, kind, chosen, actor_id) VALUES ($1, 'shortage', $2, $3)`, [
        c.order.id,
        JSON.stringify({ variantId: it.variant_id, warehouseId: c.s.warehouse_id, shipmentId: c.s.id, expected: it.base_qty, found: b.found, note: text }),
        auth.userId,
      ]);
      await audit(c.db, { actorId: auth.userId, action: 'shipment.shortage', entity: 'shipment', entityId: c.s.id, after: { sku: it.sku, expected: it.base_qty, found: b.found }, ip: auth.ip });
    });
  });

  // Fim da separacao: tudo separado na quantidade da remessa.
  app.post('/:id/finish-picking', async (req) => {
    const auth = requirePermission(req, 'shipping.pick');
    const { id } = idParams.parse(req.params);
    const b = versioned.parse(req.body);
    return act(auth, id, b.requestKey, 'event', async (c) => {
      assertVersion(c.s, b.version);
      assertStatus(c.s, ['picking'], 'A remessa não está em separação.');
      assertMoving(c.order);
      const items = await shipmentItems(c.db, c.s.id);
      const short = items.filter((i) => milli(i.picked_qty) !== milli(i.base_qty));
      if (short.length) {
        throw new AppError(422, 'PICKING_INCOMPLETE', `Faltam itens para separar: ${short.map((i) => `${i.sku} (${Number(i.picked_qty)} de ${Number(i.base_qty)})`).join(', ')}. Separe ou registre a falta.`);
      }
      await setStatus(c.db, c.s, 'checking');
      await event(c.db, { shipmentId: c.s.id, from: 'picking', to: 'checking', action: 'finish_picking', requestKey: b.requestKey, actorId: auth.userId });
    });
  });

  // Conferencia por SKU (digitado ou lido de etiqueta), sem GTIN obrigatorio (D5-6). So SKU da remessa; nunca acima
  // do separado. Tentativa recusada fica no historico.
  app.post('/:id/check', async (req) => {
    const auth = requirePermission(req, 'shipping.pick');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ sku: z.string().trim().min(1).max(80), qty: qtySchema, requestKey: key }).parse(req.body);
    return act(auth, id, b.requestKey, 'check', async (c) => {
      assertStatus(c.s, ['checking'], 'A remessa não está em conferência.');
      assertMoving(c.order);
      if ((await settings(c.db)).distinct_checker) {
        const picked = (await c.db.query(`SELECT 1 FROM shipment_checks WHERE shipment_id = $1 AND kind = 'pick' AND actor_id = $2 LIMIT 1`, [c.s.id, auth.userId])).rows[0];
        if (picked) throw new AppError(403, 'DISTINCT_CHECKER', 'A conferência precisa ser feita por outra pessoa: você separou itens desta remessa.');
      }
      const items = await shipmentItems(c.db, c.s.id);
      const read = b.sku.toUpperCase();
      // SKU do item; o codigo de barras, quando cadastrado na variante, tambem vale (nao e exigido).
      const barcodes = (
        await c.db.query<{ id: string; barcode: string | null }>('SELECT id, barcode FROM product_variants WHERE id = ANY($1::uuid[])', [items.map((i) => i.variant_id)])
      ).rows;
      const match = items.filter((i) => i.sku.toUpperCase() === read || barcodes.some((v) => v.id === i.variant_id && v.barcode === b.sku));
      if (!match.length) {
        await logCheck(c.db, { shipmentId: c.s.id, itemId: null, kind: 'rejected', skuRead: b.sku, qty: b.qty, result: 'wrong_sku', requestKey: b.requestKey, actorId: auth.userId });
        return { rejection: new AppError(422, 'WRONG_SKU', `O código ${b.sku} não pertence a esta remessa. Confira a mercadoria.`) };
      }
      let rest = milli(b.qty);
      const room = match.reduce((sum, i) => sum + milli(i.picked_qty) - milli(i.checked_qty), 0);
      if (rest > room) {
        await logCheck(c.db, { shipmentId: c.s.id, itemId: match[0]!.id, kind: 'rejected', skuRead: b.sku, qty: b.qty, result: 'over', note: `Conferido acima do separado (falta conferir ${fmt(room)})`, requestKey: b.requestKey, actorId: auth.userId });
        return {
          rejection: new AppError(422, 'OVER_EXPECTED', `${match[0]!.sku}: falta conferir ${fmt(room)}. A quantidade ${Number(b.qty)} passa do que foi separado.`, { remaining: q3(room) }),
        };
      }
      // Mesmo SKU em mais de um item (itens de pedido diferentes): preenche na ordem.
      let first = true;
      for (const it of match) {
        const take = Math.min(rest, milli(it.picked_qty) - milli(it.checked_qty));
        if (take <= 0) continue;
        await c.db.query('UPDATE shipment_items SET checked_qty = checked_qty + $2 WHERE id = $1', [it.id, q3(take)]);
        await logCheck(c.db, { shipmentId: c.s.id, itemId: it.id, kind: 'check', skuRead: b.sku, qty: q3(take), result: 'ok', requestKey: first ? b.requestKey : null, actorId: auth.userId });
        first = false;
        rest -= take;
      }
      await c.db.query('UPDATE shipments SET version = version + 1, updated_at = now() WHERE id = $1', [c.s.id]);
    });
  });

  // Desfazer conferencia (erro operacional): novo registro com motivo; o anterior continua no historico.
  app.post('/:id/check-undo', async (req) => {
    const auth = requirePermission(req, 'shipping.pick');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ itemId: z.uuid(), qty: qtySchema, note, requestKey: key }).parse(req.body);
    return act(auth, id, b.requestKey, 'check', async (c) => {
      assertStatus(c.s, ['checking'], 'A remessa não está em conferência.');
      const it = itemOf(await shipmentItems(c.db, c.s.id), b.itemId);
      if (milli(b.qty) > milli(it.checked_qty)) throw new AppError(422, 'OVER_CHECKED', `${it.sku}: conferido ${Number(it.checked_qty)}. Não é possível desfazer ${Number(b.qty)}.`);
      await c.db.query('UPDATE shipment_items SET checked_qty = checked_qty - $2 WHERE id = $1', [it.id, b.qty]);
      await logCheck(c.db, { shipmentId: c.s.id, itemId: it.id, kind: 'check_undo', qty: b.qty, result: 'corrected', note: b.note, requestKey: b.requestKey, actorId: auth.userId });
      await c.db.query('UPDATE shipments SET version = version + 1, updated_at = now() WHERE id = $1', [c.s.id]);
    });
  });

  // Voltar uma etapa (divergencia na conferencia, troca de embalagem). Conferencia volta para separacao; embalada
  // volta para conferencia. O que foi separado e conferido continua registrado.
  app.post('/:id/reopen', async (req) => {
    const auth = requirePermission(req, 'shipping.pick');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ version: z.number().int(), to: z.enum(['picking', 'checking']), note, requestKey: key }).parse(req.body);
    return act(auth, id, b.requestKey, 'event', async (c) => {
      assertVersion(c.s, b.version);
      if (b.to === 'picking') assertStatus(c.s, ['checking'], 'Só a remessa em conferência volta para a separação.');
      else assertStatus(c.s, ['packed'], 'Só a remessa embalada volta para a conferência.');
      if (b.to === 'checking') await setStatus(c.db, c.s, 'checking', ', packed_at = NULL, packages = NULL, volumes = NULL, weight_g = NULL');
      else await setStatus(c.db, c.s, 'picking');
      await event(c.db, { shipmentId: c.s.id, from: c.s.status, to: b.to, action: 'reopen', note: b.note, requestKey: b.requestKey, actorId: auth.userId });
      await projectOrder(c.db, c.order, auth.userId, `Remessa nº ${c.s.seq} reaberta: ${b.note}`);
    });
  });

  // Embalar: tudo conferido; volumes com peso (e medidas, quando houver).
  app.post('/:id/pack', async (req) => {
    const auth = requirePermission(req, 'shipping.pick');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ version: z.number().int(), packages: z.array(packageSchema).min(1).max(99), requestKey: key }).parse(req.body);
    return act(auth, id, b.requestKey, 'event', async (c) => {
      assertVersion(c.s, b.version);
      assertStatus(c.s, ['checking'], 'Só a remessa conferida pode ser embalada.');
      assertMoving(c.order);
      const items = await shipmentItems(c.db, c.s.id);
      const open = items.filter((i) => milli(i.checked_qty) !== milli(i.base_qty) || milli(i.picked_qty) !== milli(i.base_qty));
      if (open.length) {
        throw new AppError(422, 'CHECK_INCOMPLETE', `Conferência incompleta: ${open.map((i) => `${i.sku} (${Number(i.checked_qty)} de ${Number(i.base_qty)})`).join(', ')}.`);
      }
      const weight = b.packages.reduce((s, p) => s + p.weightG, 0);
      await c.db.query(
        `UPDATE shipments SET status = 'packed', packed_at = now(), checked_at = coalesce(checked_at, now()), packages = $2, volumes = $3, weight_g = $4,
           version = version + 1, updated_at = now() WHERE id = $1`,
        [c.s.id, JSON.stringify(b.packages), b.packages.length, weight],
      );
      await event(c.db, { shipmentId: c.s.id, from: 'checking', to: 'packed', action: 'pack', note: `${b.packages.length} volume(s), ${weight} g`, requestKey: b.requestKey, actorId: auth.userId });
      await projectOrder(c.db, c.order, auth.userId, `Remessa nº ${c.s.seq} embalada`);
    });
  });

  // Despacho (retirada: entrega ao cliente). Mesmas travas do despacho antigo: NF-e autorizada ou dispensada e
  // alocacao confirmada. Baixa so o que esta na remessa.
  app.post('/:id/dispatch', async (req) => {
    const auth = requirePermission(req, 'shipping.manage');
    const { id } = idParams.parse(req.params);
    const b = z
      .strictObject({
        version: z.number().int(),
        carrier: z.string().trim().max(80).optional().nullable(),
        trackingCode: z.string().trim().max(60).optional().nullable(),
        trackingUrl: z.url().max(300).optional().nullable(),
        requestKey: key,
      })
      .parse(req.body);
    return act(auth, id, b.requestKey, 'event', async (c) => {
      assertVersion(c.s, b.version);
      assertStatus(c.s, ['packed'], 'Só a remessa embalada pode ser despachada.');
      assertMoving(c.order);
      if (c.order.invoice_status !== 'authorized' && c.order.invoice_status !== 'not_required') {
        throw new AppError(409, 'INVOICE_REQUIRED', 'Emita e autorize a NF-e antes de despachar a mercadoria.');
      }
      if (!['paid', 'preparing', 'ready', 'shipped'].includes(c.order.status)) throw new AppError(409, 'INVALID_TRANSITION', 'O pedido não pode ser despachado nesta situação.');
      const items = await shipmentItems(c.db, c.s.id);
      await lockVariants(c.db, items.map((i) => i.variant_id));
      for (const it of items) {
        const res = (
          await c.db.query<Reservation>(`SELECT ${RES_COLS} FROM stock_reservations WHERE allocation_id = $1 AND status = 'active' FOR UPDATE`, [it.allocation_id])
        ).rows[0];
        if (!res) throw new AppError(409, 'RESERVATION_MISSING', `${it.sku}: a reserva desta alocação não está ativa. Revise a alocação do pedido.`);
        const part = milli(it.base_qty);
        if (part > milli(res.qty)) throw new AppError(409, 'OVER_RESERVATION', `${it.sku}: a remessa (${Number(it.base_qty)}) passa da reserva (${Number(res.qty)}).`);
        if (part === milli(res.qty)) {
          await consumeReservation(c.db, auth.userId, res.id, { sourceType: 'order', sourceId: c.order.id }, c.s.id);
        } else {
          // Parte da alocacao (remessas multiplas): consome a parte e o resto continua reservado.
          await c.db.query('UPDATE stock_reservations SET qty = qty - $2 WHERE id = $1', [res.id, it.base_qty]);
          await moveStock(c.db, auth.userId, {
            variantId: res.variant_id,
            kind: 'sale',
            onHandDelta: neg(it.base_qty),
            reservedDelta: neg(it.base_qty),
            sourceType: 'order',
            sourceId: c.order.id,
            warehouseId: res.warehouse_id,
            documentRef: c.s.id,
          });
        }
      }
      const pickup = c.s.kind === 'pickup';
      const marketplace = c.s.kind === 'marketplace';
      await c.db.query(
        `UPDATE shipments SET status = $2, carrier = $3, tracking_code = $4, tracking_url = $5, shipped_at = now(), shipped_by = $6,
           delivered_at = CASE WHEN $7 THEN now() END, version = version + 1, updated_at = now() WHERE id = $1`,
        [c.s.id, pickup ? 'delivered' : 'shipped', pickup || marketplace ? null : b.carrier || null, pickup ? null : b.trackingCode || null, pickup || marketplace ? null : b.trackingUrl || null, auth.userId, pickup],
      );
      await event(c.db, { shipmentId: c.s.id, from: 'packed', to: 'shipped', action: pickup ? 'handover' : 'dispatch', note: b.trackingCode ? `Rastreio ${b.trackingCode}` : null, requestKey: b.requestKey, actorId: auth.userId });
      if (pickup) await event(c.db, { shipmentId: c.s.id, from: 'shipped', to: 'delivered', action: 'handover', note: 'Retirada pelo cliente', actorId: auth.userId });
      await projectOrder(c.db, c.order, auth.userId, b.trackingCode ? `Remessa nº ${c.s.seq}: código de rastreio ${b.trackingCode}` : `Remessa nº ${c.s.seq} ${pickup ? 'retirada' : 'despachada'}`);
      if (!pickup) await queueOrderMessage(c.db, c.order.id, 'order_shipped', c.s.id);
      await audit(c.db, {
        actorId: auth.userId,
        action: pickup ? 'shipment.handover' : 'shipment.dispatch',
        entity: 'shipment',
        entityId: c.s.id,
        after: { orderId: c.order.id, seq: c.s.seq, carrier: b.carrier, trackingCode: b.trackingCode },
        ip: auth.ip,
      });
    });
  });

  app.post('/:id/deliver', async (req) => {
    const auth = requirePermission(req, 'shipping.manage');
    const { id } = idParams.parse(req.params);
    const b = versioned.parse(req.body);
    return act(auth, id, b.requestKey, 'event', async (c) => {
      assertVersion(c.s, b.version);
      assertStatus(c.s, ['shipped', 'in_transit', 'out_for_delivery'], 'Só a remessa despachada pode ser marcada como entregue.');
      await setStatus(c.db, c.s, 'delivered', ', delivered_at = now()');
      await event(c.db, { shipmentId: c.s.id, from: c.s.status, to: 'delivered', action: 'deliver', requestKey: b.requestKey, actorId: auth.userId });
      await projectOrder(c.db, c.order, auth.userId, `Remessa nº ${c.s.seq} entregue`);
      await audit(c.db, { actorId: auth.userId, action: 'shipment.deliver', entity: 'shipment', entityId: c.s.id, ip: auth.ip });
    });
  });

  // Liberar de volta para pendente (logistica): mantem o separado registrado; serve para a falta e a realocacao.
  app.post('/:id/release', async (req) => {
    const auth = requirePermission(req, 'logistics.manage');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ version: z.number().int(), note, requestKey: key }).parse(req.body);
    return act(auth, id, b.requestKey, 'event', async (c) => {
      assertVersion(c.s, b.version);
      assertStatus(c.s, ['picking', 'checking', 'packed'], 'Só remessa em separação, conferência ou embalada volta para pendente.');
      await setStatus(c.db, c.s, 'pending', ', packed_at = NULL, packages = NULL, volumes = NULL, weight_g = NULL');
      await event(c.db, { shipmentId: c.s.id, from: c.s.status, to: 'pending', action: 'release', note: b.note, requestKey: b.requestKey, actorId: auth.userId });
      await projectOrder(c.db, c.order, auth.userId, `Remessa nº ${c.s.seq} voltou para pendente: ${b.note}`);
      await audit(c.db, { actorId: auth.userId, action: 'shipment.release', entity: 'shipment', entityId: c.s.id, after: { note: b.note }, ip: auth.ip });
    });
  });

  // Cancelar a remessa (ate embalada), com motivo. Mercadoria separada precisa voltar ao lugar antes (registro).
  // As reservas continuam com o pedido.
  app.post('/:id/cancel', async (req) => {
    const auth = requirePermission(req, 'logistics.manage');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ version: z.number().int(), reason: z.string().trim().min(3).max(500), requestKey: key }).parse(req.body);
    return act(auth, id, b.requestKey, 'event', async (c) => {
      assertVersion(c.s, b.version);
      assertStatus(c.s, OPEN_SHIPMENT, 'Remessa despachada não pode ser cancelada.');
      const items = await shipmentItems(c.db, c.s.id);
      const held = items.filter((i) => milli(i.picked_qty) > 0);
      if (held.length) {
        throw new AppError(409, 'GOODS_PICKED', `Há mercadoria separada (${held.map((i) => `${i.sku}: ${Number(i.picked_qty)}`).join(', ')}). Devolva ao lugar antes de cancelar.`);
      }
      await c.db.query(`UPDATE shipments SET status = 'canceled', canceled_at = now(), cancel_reason = $2, version = version + 1, updated_at = now() WHERE id = $1`, [c.s.id, b.reason]);
      await event(c.db, { shipmentId: c.s.id, from: c.s.status, to: 'canceled', action: 'cancel', note: b.reason, requestKey: b.requestKey, actorId: auth.userId });
      await projectOrder(c.db, c.order, auth.userId, `Remessa nº ${c.s.seq} cancelada: ${b.reason}`);
      await audit(c.db, { actorId: auth.userId, action: 'shipment.cancel', entity: 'shipment', entityId: c.s.id, after: { reason: b.reason }, ip: auth.ip });
    });
  });

  // Dividir (entrega parcial): so com as remessas multiplas liberadas pela validacao fiscal (D5-4).
  app.post('/:id/split', async (req) => {
    const auth = requirePermission(req, 'logistics.manage');
    const { id } = idParams.parse(req.params);
    const b = z
      .strictObject({ version: z.number().int(), items: z.array(z.strictObject({ itemId: z.uuid(), qty: qtySchema })).min(1).max(200), requestKey: key })
      .parse(req.body);
    return act(auth, id, b.requestKey, 'event', async (c) => {
      if ((await settings(c.db)).multi_shipment_status !== 'enabled') {
        throw new AppError(409, 'MULTI_SHIPMENT_BLOCKED', 'Remessas múltiplas estão travadas até a validação fiscal da entrega parcial. O pedido sai numa remessa só.');
      }
      assertVersion(c.s, b.version);
      assertStatus(c.s, ['pending'], 'Só remessa pendente, sem nada separado, pode ser dividida.');
      const items = await shipmentItems(c.db, c.s.id);
      if (items.some((i) => milli(i.picked_qty) > 0)) throw new AppError(409, 'GOODS_PICKED', 'Devolva a mercadoria separada ao lugar antes de dividir a remessa.');
      const moves = new Map<string, number>();
      for (const m of b.items) moves.set(m.itemId, (moves.get(m.itemId) ?? 0) + milli(m.qty));
      let remaining = 0;
      for (const it of items) {
        const mv = moves.get(it.id) ?? 0;
        if (mv > milli(it.base_qty)) throw new AppError(422, 'OVER_EXPECTED', `${it.sku}: a remessa tem ${Number(it.base_qty)}.`);
        remaining += milli(it.base_qty) - mv;
        assertWhole(await variantInfo(c.db, it.variant_id), q3(mv));
      }
      for (const m of moves.keys()) itemOf(items, m);
      if (remaining === 0) throw new AppError(422, 'SPLIT_EMPTY', 'A remessa original ficaria vazia. Deixe ao menos um item nela.');
      const seq = (await c.db.query<{ n: number }>('SELECT coalesce(max(seq), 0)::int + 1 AS n FROM shipments WHERE order_id = $1', [c.order.id])).rows[0]!.n;
      const newId = (
        await c.db.query<{ id: string }>(
          `INSERT INTO shipments (order_id, seq, kind, status, warehouse_id, version, created_by, shipped_at) VALUES ($1, $2, $3, 'pending', $4, 0, $5, NULL) RETURNING id`,
          [c.order.id, seq, c.s.kind, c.s.warehouse_id, auth.userId],
        )
      ).rows[0]!.id;
      for (const it of items) {
        const mv = moves.get(it.id) ?? 0;
        if (!mv) continue;
        // Primeiro reduz (ou encerra) o item original, para o teto por alocacao aceitar o novo.
        if (mv === milli(it.base_qty)) await c.db.query(`UPDATE shipment_items SET status = 'canceled' WHERE id = $1`, [it.id]);
        else await c.db.query('UPDATE shipment_items SET base_qty = base_qty - $2 WHERE id = $1', [it.id, q3(mv)]);
        await c.db.query(`INSERT INTO shipment_items (shipment_id, allocation_id, order_item_id, variant_id, base_qty) VALUES ($1, $2, $3, $4, $5)`, [
          newId,
          it.allocation_id,
          it.order_item_id,
          it.variant_id,
          q3(mv),
        ]);
      }
      await c.db.query('UPDATE shipments SET version = version + 1, updated_at = now() WHERE id = $1', [c.s.id]);
      await event(c.db, { shipmentId: c.s.id, from: 'pending', to: 'pending', action: 'split', note: `Dividida: itens para a remessa nº ${seq}`, requestKey: b.requestKey, actorId: auth.userId });
      await event(c.db, { shipmentId: newId, from: null, to: 'pending', action: 'create', note: `Dividida da remessa nº ${c.s.seq}`, actorId: auth.userId });
      await audit(c.db, { actorId: auth.userId, action: 'shipment.split', entity: 'shipment', entityId: c.s.id, after: { newShipmentId: newId, items: b.items }, ip: auth.ip });
    });
  });
}
