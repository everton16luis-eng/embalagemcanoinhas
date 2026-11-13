import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { AppError, notFound } from './errors.js';

// Quantidades sempre em texto (numeric no banco): nada de float em estoque.
export const qty = z
  .string()
  .trim()
  .regex(/^\d{1,11}(\.\d{1,3})?$/, 'Quantidade inválida.')
  .refine((v) => Number(v) > 0, 'A quantidade deve ser maior que zero.');
export const signedQty = z
  .string()
  .trim()
  .regex(/^-?\d{1,11}(\.\d{1,3})?$/, 'Quantidade inválida.')
  .refine((v) => Number(v) !== 0, 'A quantidade não pode ser zero.');
export const hasFraction = (v: string) => /\.\d*[1-9]/.test(v);
export const neg = (v: string) => (v.startsWith('-') ? v.slice(1) : `-${v}`);

export type MovementKind = 'receipt' | 'sale' | 'return' | 'loss' | 'damage' | 'adjustment' | 'inventory' | 'reserve' | 'release';
export type SourceType = 'purchase_receipt' | 'order' | 'cart' | 'quote' | 'inventory' | 'manual' | 'reservation';

type VariantInfo = { variant_id: string; sku: string; allows_fraction: boolean; availability_mode: 'stock' | 'made_to_order'; base_unit: string };

/** Dados da variacao que limitam o movimento: unidade fracionavel e modo de disponibilidade. */
export async function variantInfo(db: Db, variantId: string): Promise<VariantInfo> {
  const { rows } = await db.query<VariantInfo>(
    `SELECT v.id AS variant_id, v.sku, u.allows_fraction, p.availability_mode, p.base_unit
     FROM product_variants v JOIN products p ON p.id = v.product_id JOIN units u ON u.code = p.base_unit WHERE v.id = $1`,
    [variantId],
  );
  if (!rows[0]) throw new AppError(404, 'VARIANT_NOT_FOUND', 'Variação de produto não encontrada.');
  return rows[0];
}

export function assertWhole(info: VariantInfo, value: string) {
  if (!info.allows_fraction && hasFraction(value)) {
    throw new AppError(422, 'FRACTION_NOT_ALLOWED', `${info.sku}: a unidade ${info.base_unit} não aceita quantidade fracionada.`);
  }
}

export type Movement = {
  variantId: string;
  kind: MovementKind;
  onHandDelta?: string;
  reservedDelta?: string;
  /** Custo por unidade base de uma entrada. Recalcula o custo medio. */
  unitCostCents?: string | null;
  sourceType?: SourceType;
  sourceId?: string;
  reason?: string | null;
  requestKey?: string | null;
};

export type MovementRow = {
  id: string;
  variant_id: string;
  kind: MovementKind;
  on_hand_delta: string;
  reserved_delta: string;
  on_hand_after: string;
  reserved_after: string;
  unit_cost_cents: string | null;
  avg_cost_after: string;
  created_at: string;
};

/**
 * Unico caminho que altera saldo. Bloqueia a linha do saldo (UPDATE), grava o movimento com o
 * saldo resultante e recalcula o custo medio ponderado nas entradas com custo. Saldo fisico
 * negativo e recusado pelo banco e vira INSUFFICIENT_STOCK.
 */
export async function moveStock(db: Db, actorId: string | null, m: Movement): Promise<MovementRow> {
  const onHand = m.onHandDelta ?? '0';
  const reserved = m.reservedDelta ?? '0';
  const cost = m.unitCostCents ?? null;
  await db.query('INSERT INTO stock_balances (variant_id) VALUES ($1) ON CONFLICT DO NOTHING', [m.variantId]);
  await db.query('SAVEPOINT move_stock');
  let balance: { on_hand: string; reserved: string; avg_cost_cents: string };
  try {
    const { rows } = await db.query(
      `UPDATE stock_balances SET
         avg_cost_cents = CASE WHEN $4::numeric IS NOT NULL AND $2::numeric > 0
           THEN round((on_hand * avg_cost_cents + $2::numeric * $4::numeric) / (on_hand + $2::numeric), 4)
           ELSE avg_cost_cents END,
         on_hand = on_hand + $2::numeric,
         reserved = reserved + $3::numeric,
         updated_at = now()
       WHERE variant_id = $1 RETURNING on_hand, reserved, avg_cost_cents`,
      [m.variantId, onHand, reserved, cost],
    );
    balance = rows[0];
    await db.query('RELEASE SAVEPOINT move_stock');
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code !== '23514') throw err;
    await db.query('ROLLBACK TO SAVEPOINT move_stock');
    const now = (await db.query<{ on_hand: string; reserved: string }>('SELECT on_hand, reserved FROM stock_balances WHERE variant_id = $1', [m.variantId])).rows[0];
    if (e.constraint?.includes('reserved')) throw new AppError(409, 'RESERVATION_MISMATCH', 'A reserva a liberar é maior que o saldo reservado.');
    throw new AppError(409, 'INSUFFICIENT_STOCK', 'Saldo físico insuficiente para esta saída.', { onHand: now?.on_hand ?? '0', requested: onHand.replace('-', '') });
  }
  const { rows } = await db.query<MovementRow>(
    `INSERT INTO stock_movements (variant_id, kind, on_hand_delta, reserved_delta, on_hand_after, reserved_after, unit_cost_cents, avg_cost_after,
       source_type, source_id, reason, request_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id::text, variant_id, kind, on_hand_delta, reserved_delta, on_hand_after, reserved_after, unit_cost_cents, avg_cost_after, created_at`,
    [m.variantId, m.kind, onHand, reserved, balance.on_hand, balance.reserved, cost, balance.avg_cost_cents, m.sourceType ?? null, m.sourceId ?? null, m.reason ?? null, m.requestKey ?? null, actorId || null],
  );
  return rows[0]!;
}

export type Reservation = {
  id: string;
  variant_id: string;
  qty: string;
  status: 'active' | 'consumed' | 'released' | 'expired';
  backorder: boolean;
  source_type: string;
  source_id: string;
  expires_at: string | null;
};
const RES_COLS = 'id, variant_id, qty, status, backorder, source_type, source_id, expires_at';

/**
 * Reserva quantidade para um carrinho, pedido ou orcamento. O saldo da variacao fica bloqueado
 * durante a conferencia, entao duas reservas simultaneas nunca vendem a mesma unidade.
 * Produto sob encomenda pode reservar alem do disponivel (a diferenca vira compra).
 */
export async function reserve(
  db: Db,
  actorId: string | null,
  r: { variantId: string; qty: string; sourceType: 'order' | 'cart' | 'quote' | 'manual'; sourceId: string; expiresAt?: Date | null },
): Promise<Reservation> {
  const info = await variantInfo(db, r.variantId);
  assertWhole(info, r.qty);
  await db.query('INSERT INTO stock_balances (variant_id) VALUES ($1) ON CONFLICT DO NOTHING', [r.variantId]);
  const bal = (
    await db.query<{ available: string; enough: boolean }>(
      'SELECT on_hand - reserved AS available, on_hand - reserved >= $2::numeric AS enough FROM stock_balances WHERE variant_id = $1 FOR UPDATE',
      [r.variantId, r.qty],
    )
  ).rows[0]!;

  const existing = (
    await db.query<Reservation>(`SELECT ${RES_COLS} FROM stock_reservations WHERE source_type = $1 AND source_id = $2 AND variant_id = $3 AND status = 'active'`, [
      r.sourceType,
      r.sourceId,
      r.variantId,
    ])
  ).rows[0];
  if (existing) {
    // Repeticao do mesmo pedido: devolve a reserva ja feita em vez de reservar duas vezes.
    if (Number(existing.qty) === Number(r.qty)) return existing;
    throw new AppError(409, 'RESERVATION_EXISTS', 'Já existe reserva ativa desta origem para este item. Libere-a antes de reservar outra quantidade.');
  }

  const backorder = !bal.enough;
  if (backorder && info.availability_mode !== 'made_to_order') {
    throw new AppError(409, 'INSUFFICIENT_STOCK', `${info.sku}: disponível ${bal.available}, pedido ${r.qty}.`, { available: bal.available, requested: r.qty });
  }
  const { rows } = await db.query<Reservation>(
    `INSERT INTO stock_reservations (variant_id, qty, backorder, source_type, source_id, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${RES_COLS}`,
    [r.variantId, r.qty, backorder, r.sourceType, r.sourceId, r.expiresAt ?? null, actorId || null],
  );
  const res = rows[0]!;
  await moveStock(db, actorId, { variantId: r.variantId, kind: 'reserve', reservedDelta: r.qty, sourceType: 'reservation', sourceId: res.id });
  return res;
}

async function lockReservation(db: Db, id: string) {
  const res = (await db.query<Reservation>(`SELECT ${RES_COLS} FROM stock_reservations WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!res) throw notFound();
  return res;
}

/** Libera a reserva (desistencia, pagamento recusado ou prazo vencido). Repetir nao tem efeito. */
export async function releaseReservation(db: Db, actorId: string | null, id: string, status: 'released' | 'expired' = 'released') {
  const res = await lockReservation(db, id);
  if (res.status !== 'active') return { reservation: res, changed: false };
  await db.query(`UPDATE stock_reservations SET status = $2, closed_at = now() WHERE id = $1`, [id, status]);
  await moveStock(db, actorId, { variantId: res.variant_id, kind: 'release', reservedDelta: neg(res.qty), sourceType: 'reservation', sourceId: id, reason: status === 'expired' ? 'Reserva vencida' : null });
  return { reservation: { ...res, status }, changed: true };
}

/**
 * Baixa a reserva como venda: sai do fisico e do reservado no mesmo movimento. Item sob
 * encomenda so baixa quando a mercadoria chegou (fisico suficiente).
 */
export async function consumeReservation(db: Db, actorId: string | null, id: string, source: { sourceType: SourceType; sourceId: string }) {
  const res = await lockReservation(db, id);
  if (res.status === 'consumed') return { reservation: res, changed: false };
  if (res.status !== 'active') throw new AppError(409, 'RESERVATION_CLOSED', 'Esta reserva já foi liberada ou venceu.');
  const movement = await moveStock(db, actorId, {
    variantId: res.variant_id,
    kind: 'sale',
    onHandDelta: neg(res.qty),
    reservedDelta: neg(res.qty),
    sourceType: source.sourceType,
    sourceId: source.sourceId,
  });
  await db.query(`UPDATE stock_reservations SET status = 'consumed', closed_at = now() WHERE id = $1`, [id]);
  return { reservation: { ...res, status: 'consumed' as const }, changed: true, movement };
}

/** Libera reservas vencidas. Roda em lote, sem disputar linhas que outra execucao ja pegou. */
export async function expireReservations(db: Db, limit = 200) {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM stock_reservations WHERE status = 'active' AND expires_at < now() ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  for (const r of rows) await releaseReservation(db, null, r.id, 'expired');
  return rows.length;
}
