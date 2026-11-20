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

export type MovementKind =
  | 'receipt' | 'sale' | 'return' | 'loss' | 'damage' | 'adjustment' | 'inventory' | 'reserve' | 'release'
  // SGLog Fase 3 (docs/20-sglog-fase3.md §1)
  | 'transfer_out' | 'transfer_in' | 'transfer_loss' | 'transfer_return' | 'block' | 'unblock' | 'damage_hold' | 'damage_release' | 'reversal';
export type SourceType = 'purchase_receipt' | 'order' | 'cart' | 'quote' | 'inventory' | 'manual' | 'reservation' | 'transfer' | 'adjustment_request';

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
  /** Saldos da Fase 3: bloqueado/quarentena, avariado, em transito para o deposito. */
  blockedDelta?: string;
  damagedDelta?: string;
  inTransitDelta?: string;
  /** Deposito da linha. Sem ele, o padrao (comportamento de antes da Fase 3). */
  warehouseId?: string | null;
  counterWarehouseId?: string | null;
  transferId?: string | null;
  documentRef?: string | null;
  reversesId?: string | null;
};

const BUCKET_LABEL: Record<string, string> = {
  on_hand: 'Saldo disponível',
  reserved: 'Saldo reservado',
  blocked: 'Saldo bloqueado',
  damaged: 'Saldo avariado',
  in_transit: 'Saldo em trânsito',
};

const isCheck = (err: unknown): err is { code: string; constraint?: string } => (err as { code?: string }).code === '23514';

/** Traduz a violacao do CHECK >= 0 (total ou deposito) num erro de negocio, sem expor o banco. */
async function bucketError(db: Db, constraint: string | undefined, m: Movement, atLocation: boolean) {
  const bucket = Object.keys(BUCKET_LABEL).find((b) => constraint?.endsWith(`_${b}_check`)) ?? 'on_hand';
  const requested = (m.onHandDelta ?? '0').replace('-', '');
  if (bucket === 'reserved') return new AppError(409, 'RESERVATION_MISMATCH', 'A reserva a liberar é maior que o saldo reservado.');
  const where = atLocation
    ? (
        await db.query<{ name: string; on_hand: string | null }>(
          `SELECT w.name, l.on_hand::text FROM warehouses w LEFT JOIN stock_location_balances l ON l.warehouse_id = w.id AND l.variant_id = $2
           WHERE w.id = coalesce($1::uuid, (SELECT id FROM warehouses WHERE is_default))`,
          [m.warehouseId ?? null, m.variantId],
        )
      ).rows[0]
    : undefined;
  const suffix = where ? ` no depósito ${where.name}` : '';
  if (bucket === 'on_hand') {
    const onHand = where
      ? (where.on_hand ?? '0')
      : ((await db.query<{ on_hand: string }>('SELECT on_hand FROM stock_balances WHERE variant_id = $1', [m.variantId])).rows[0]?.on_hand ?? '0');
    return new AppError(409, 'INSUFFICIENT_STOCK', `Saldo físico insuficiente para esta saída${suffix}.`, { onHand, requested, ...(where ? { warehouse: where.name } : {}) });
  }
  return new AppError(409, 'INSUFFICIENT_BUCKET', `${BUCKET_LABEL[bucket]} insuficiente${suffix}.`, { bucket, ...(where ? { warehouse: where.name } : {}) });
}

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
 * Unico caminho que altera saldo. Bloqueia a linha do saldo total (UPDATE), grava o movimento com os saldos
 * resultantes e recalcula o custo medio ponderado nas entradas com custo. O gatilho do livro aplica os mesmos
 * deltas no deposito da linha (sem deposito: o padrao). Saldo negativo, no total ou no deposito, e recusado
 * pelo banco e vira erro de negocio (INSUFFICIENT_STOCK, INSUFFICIENT_BUCKET, RESERVATION_MISMATCH).
 * Fase 3: o custo medio pondera o total gerencial (disponivel + bloqueado + avariado + em transito).
 */
export async function moveStock(db: Db, actorId: string | null, m: Movement): Promise<MovementRow> {
  const onHand = m.onHandDelta ?? '0';
  const reserved = m.reservedDelta ?? '0';
  const blocked = m.blockedDelta ?? '0';
  const damaged = m.damagedDelta ?? '0';
  const inTransit = m.inTransitDelta ?? '0';
  const cost = m.unitCostCents ?? null;
  await db.query('INSERT INTO stock_balances (variant_id) VALUES ($1) ON CONFLICT DO NOTHING', [m.variantId]);
  await db.query('SAVEPOINT move_stock');
  let balance: { on_hand: string; reserved: string; blocked: string; damaged: string; in_transit: string; avg_cost_cents: string };
  try {
    const { rows } = await db.query(
      `UPDATE stock_balances SET
         avg_cost_cents = CASE WHEN $4::numeric IS NOT NULL AND $2::numeric > 0
           THEN round(((on_hand + blocked + damaged + in_transit) * avg_cost_cents + $2::numeric * $4::numeric) / (on_hand + blocked + damaged + in_transit + $2::numeric), 4)
           ELSE avg_cost_cents END,
         on_hand = on_hand + $2::numeric,
         reserved = reserved + $3::numeric,
         blocked = blocked + $5::numeric,
         damaged = damaged + $6::numeric,
         in_transit = in_transit + $7::numeric,
         updated_at = now()
       WHERE variant_id = $1 RETURNING on_hand, reserved, blocked, damaged, in_transit, avg_cost_cents`,
      [m.variantId, onHand, reserved, cost, blocked, damaged, inTransit],
    );
    balance = rows[0];
    await db.query('RELEASE SAVEPOINT move_stock');
  } catch (err) {
    if (!isCheck(err)) throw err;
    await db.query('ROLLBACK TO SAVEPOINT move_stock');
    throw await bucketError(db, err.constraint, m, false);
  }
  await db.query('SAVEPOINT move_stock_location');
  try {
    const { rows } = await db.query<MovementRow>(
      `INSERT INTO stock_movements (variant_id, kind, on_hand_delta, reserved_delta, on_hand_after, reserved_after, unit_cost_cents, avg_cost_after,
         source_type, source_id, reason, request_key, created_by,
         blocked_delta, damaged_delta, in_transit_delta, blocked_after, damaged_after, in_transit_after,
         warehouse_id, counter_warehouse_id, transfer_id, document_ref, reverses_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
       RETURNING id::text, variant_id, kind, on_hand_delta, reserved_delta, on_hand_after, reserved_after, unit_cost_cents, avg_cost_after, created_at`,
      [
        m.variantId, m.kind, onHand, reserved, balance.on_hand, balance.reserved, cost, balance.avg_cost_cents,
        m.sourceType ?? null, m.sourceId ?? null, m.reason ?? null, m.requestKey ?? null, actorId || null,
        blocked, damaged, inTransit, balance.blocked, balance.damaged, balance.in_transit,
        m.warehouseId ?? null, m.counterWarehouseId ?? null, m.transferId ?? null, m.documentRef ?? null, m.reversesId ?? null,
      ],
    );
    await db.query('RELEASE SAVEPOINT move_stock_location');
    // SGLog Fase 4: saida que nao e venda pode descobrir reserva de pedido ja alocado (inventario, perda, avaria).
    if (onHand.startsWith('-') && m.kind !== 'sale') await flagShortage(db, m.variantId, m.warehouseId ?? null);
    return rows[0]!;
  } catch (err) {
    // O total comporta, mas o deposito da linha nao (mercadoria em outro deposito).
    if (!isCheck(err) || !err.constraint?.startsWith('stock_location_balances_')) throw err;
    await db.query('ROLLBACK TO SAVEPOINT move_stock_location');
    throw await bucketError(db, err.constraint, m, true);
  }
}

/**
 * Falta descoberta depois da alocacao (D4, regra 13): se o fisico do deposito ficou abaixo das reservas firmes de
 * pedidos em atendimento, esses pedidos voltam para analise com o motivo. Nada e cancelado nem liberado. Pedido
 * travado por outra transacao (confirmacao em andamento) e pulado: ela confere a cobertura depois de travar a variante.
 */
async function flagShortage(db: Db, variantId: string, warehouseId: string | null) {
  const { rows } = await db.query<{ order_id: string }>(
    `WITH wh AS (SELECT id, name FROM warehouses WHERE id = coalesce($2::uuid, (SELECT id FROM warehouses WHERE is_default))),
     firm AS (SELECT coalesce(sum(r.qty), 0) AS qty FROM stock_reservations r, wh
              WHERE r.variant_id = $1 AND r.status = 'active' AND NOT r.backorder AND r.allocation_id IS NOT NULL AND r.warehouse_id = wh.id),
     loc AS (SELECT coalesce((SELECT l.on_hand FROM stock_location_balances l, wh WHERE l.warehouse_id = wh.id AND l.variant_id = $1), 0) AS on_hand),
     hit AS (
       SELECT o.id FROM orders o
        WHERE o.logistics_status = 'processing'
          AND (SELECT on_hand FROM loc) < (SELECT qty FROM firm)
          AND EXISTS (SELECT 1 FROM stock_reservations r, wh WHERE r.source_type = 'order' AND r.source_id = o.id AND r.variant_id = $1
                        AND r.status = 'active' AND NOT r.backorder AND r.allocation_id IS NOT NULL AND r.warehouse_id = wh.id)
        FOR UPDATE OF o SKIP LOCKED
     ),
     upd AS (
       UPDATE orders o SET logistics_status = 'analysis', logistics_version = o.logistics_version + 1,
              logistics_note = left(format('Falta descoberta: %s no depósito %s (físico %s, reservado para pedidos %s).',
                (SELECT sku FROM product_variants WHERE id = $1), (SELECT name FROM wh), (SELECT on_hand FROM loc)::numeric, (SELECT qty FROM firm)::numeric), 500)
         FROM hit WHERE o.id = hit.id
       RETURNING o.id, o.logistics_note
     )
     INSERT INTO allocation_decisions (order_id, kind, chosen, actor_id)
     SELECT upd.id, 'shortage', jsonb_build_object('variantId', $1::uuid, 'warehouseId', (SELECT id FROM wh), 'note', upd.logistics_note), app_user_id() FROM upd
     RETURNING order_id`,
    [variantId, warehouseId],
  );
  return rows.length;
}

/** Deposito padrao (PRINCIPAL). */
export async function defaultWarehouseId(db: Db): Promise<string> {
  const id = (await db.query<{ id: string }>('SELECT id FROM warehouses WHERE is_default')).rows[0]?.id;
  if (!id) throw new AppError(500, 'NO_DEFAULT_WAREHOUSE', 'Nenhum depósito padrão cadastrado.');
  return id;
}

export type WarehouseRef = { id: string; code: string; name: string; active: boolean; is_default: boolean };

/** Deposito informado (ou o padrao), ativo. */
export async function activeWarehouse(db: Db, id: string | null | undefined): Promise<WarehouseRef> {
  const w = (
    await db.query<WarehouseRef>('SELECT id, code, name, active, is_default FROM warehouses WHERE id = coalesce($1::uuid, (SELECT id FROM warehouses WHERE is_default))', [id ?? null])
  ).rows[0];
  if (!w) throw new AppError(404, 'WAREHOUSE_NOT_FOUND', 'Depósito não encontrado.');
  if (!w.active) throw new AppError(409, 'WAREHOUSE_INACTIVE', `O depósito ${w.name} está desativado.`);
  return w;
}

/**
 * Bloqueia o saldo total das variantes, sempre em ordem de id (sem deadlock entre transferencias de varios
 * itens) e na mesma ordem que moveStock usa (total antes do deposito).
 */
export async function lockVariants(db: Db, variantIds: string[]) {
  for (const id of [...new Set(variantIds)].sort()) {
    await db.query('INSERT INTO stock_balances (variant_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
    await db.query('SELECT 1 FROM stock_balances WHERE variant_id = $1 FOR UPDATE', [id]);
  }
}

/**
 * Confere o livre do deposito (disponivel - reservado) para uma saida que nao pode tomar mercadoria reservada:
 * transferencia, bloqueio, marcacao de avaria e estorno. Chamar com a variante ja bloqueada (lockVariants).
 */
export async function assertFree(db: Db, warehouse: WarehouseRef, variantId: string, sku: string, qtyOut: string) {
  const r = (
    await db.query<{ free: string; ok: boolean }>(
      `SELECT (coalesce(l.on_hand, 0) - coalesce(l.reserved, 0))::text AS free, coalesce(l.on_hand, 0) - coalesce(l.reserved, 0) >= $3::numeric AS ok
       FROM (SELECT 1) x LEFT JOIN stock_location_balances l ON l.warehouse_id = $1 AND l.variant_id = $2`,
      [warehouse.id, variantId, qtyOut],
    )
  ).rows[0]!;
  if (!r.ok) {
    throw new AppError(409, 'INSUFFICIENT_STOCK', `${sku}: livre no depósito ${warehouse.name} ${Number(r.free)}, pedido ${Number(qtyOut)}. Mercadoria reservada não pode ser movimentada.`, {
      warehouse: warehouse.name,
      free: r.free,
      requested: qtyOut,
    });
  }
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
  /** SGLog Fase 4: deposito da reserva (nulo = padrao, reservas anteriores a 0023) e alocacao do pedido. */
  warehouse_id: string | null;
  allocation_id: string | null;
};
export const RES_COLS = 'id, variant_id, qty, status, backorder, source_type, source_id, expires_at, warehouse_id, allocation_id';

/**
 * Reserva quantidade para um carrinho, pedido ou orcamento. O saldo da variacao fica bloqueado
 * durante a conferencia, entao duas reservas simultaneas nunca vendem a mesma unidade.
 * Produto sob encomenda pode reservar alem do disponivel (a diferenca vira compra).
 *
 * SGLog Fase 4: sem `warehouseId`, reserva no deposito padrao conferindo o total, como antes (checkout, orcamento,
 * marketplace). Com `warehouseId` (alocacao), confere o livre daquele deposito; `allowBackorder` (encomenda ao
 * fornecedor) aceita reservar alem do fisico do deposito, como o sob encomenda.
 */
export async function reserve(
  db: Db,
  actorId: string | null,
  r: {
    variantId: string;
    qty: string;
    sourceType: 'order' | 'cart' | 'quote' | 'manual';
    sourceId: string;
    expiresAt?: Date | null;
    warehouseId?: string | null;
    allocationId?: string | null;
    allowBackorder?: boolean;
  },
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
  const warehouse = r.warehouseId ? await activeWarehouse(db, r.warehouseId) : null;
  const warehouseId = warehouse?.id ?? (await defaultWarehouseId(db));

  const existing = (
    await db.query<Reservation>(
      `SELECT ${RES_COLS} FROM stock_reservations WHERE source_type = $1 AND source_id = $2 AND variant_id = $3 AND status = 'active'
         AND allocation_id IS NOT DISTINCT FROM $4::uuid`,
      [r.sourceType, r.sourceId, r.variantId, r.allocationId ?? null],
    )
  ).rows[0];
  if (existing) {
    // Repeticao do mesmo pedido: devolve a reserva ja feita em vez de reservar duas vezes.
    if (Number(existing.qty) === Number(r.qty) && (existing.warehouse_id ?? warehouseId) === warehouseId) return existing;
    throw new AppError(409, 'RESERVATION_EXISTS', 'Já existe reserva ativa desta origem para este item. Libere-a antes de reservar outra quantidade.');
  }

  let backorder: boolean;
  if (warehouse) {
    const free = (
      await db.query<{ free: string; enough: boolean }>(
        `SELECT (coalesce(l.on_hand, 0) - coalesce(l.reserved, 0))::text AS free, coalesce(l.on_hand, 0) - coalesce(l.reserved, 0) >= $3::numeric AS enough
         FROM (SELECT 1) x LEFT JOIN stock_location_balances l ON l.warehouse_id = $1 AND l.variant_id = $2`,
        [warehouse.id, r.variantId, r.qty],
      )
    ).rows[0]!;
    backorder = !free.enough;
    if (backorder && !r.allowBackorder) {
      throw new AppError(409, 'INSUFFICIENT_STOCK', `${info.sku}: livre no depósito ${warehouse.name} ${Number(free.free)}, pedido ${Number(r.qty)}.`, {
        available: free.free,
        requested: r.qty,
        warehouse: warehouse.name,
      });
    }
  } else {
    backorder = !bal.enough;
    if (backorder && info.availability_mode !== 'made_to_order') {
      throw new AppError(409, 'INSUFFICIENT_STOCK', `${info.sku}: disponível ${bal.available}, pedido ${r.qty}.`, { available: bal.available, requested: r.qty });
    }
  }
  const { rows } = await db.query<Reservation>(
    `INSERT INTO stock_reservations (variant_id, qty, backorder, source_type, source_id, expires_at, created_by, warehouse_id, allocation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${RES_COLS}`,
    [r.variantId, r.qty, backorder, r.sourceType, r.sourceId, r.expiresAt ?? null, actorId || null, warehouseId, r.allocationId ?? null],
  );
  const res = rows[0]!;
  await moveStock(db, actorId, { variantId: r.variantId, kind: 'reserve', reservedDelta: r.qty, sourceType: 'reservation', sourceId: res.id, warehouseId });
  return res;
}

async function lockReservation(db: Db, id: string) {
  const res = (await db.query<Reservation>(`SELECT ${RES_COLS} FROM stock_reservations WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!res) throw notFound();
  return res;
}

/** Libera a reserva (desistencia, pagamento recusado ou prazo vencido). Repetir nao tem efeito. */
export async function releaseReservation(db: Db, actorId: string | null, id: string, status: 'released' | 'expired' = 'released', reason: string | null = null) {
  const res = await lockReservation(db, id);
  if (res.status !== 'active') return { reservation: res, changed: false };
  await db.query(`UPDATE stock_reservations SET status = $2, closed_at = now() WHERE id = $1`, [id, status]);
  await moveStock(db, actorId, {
    variantId: res.variant_id,
    kind: 'release',
    reservedDelta: neg(res.qty),
    sourceType: 'reservation',
    sourceId: id,
    reason: reason ?? (status === 'expired' ? 'Reserva vencida' : null),
    warehouseId: res.warehouse_id,
  });
  return { reservation: { ...res, status }, changed: true };
}

/**
 * Baixa a reserva como venda: sai do fisico e do reservado no mesmo movimento, no deposito da reserva. Item sob
 * encomenda so baixa quando a mercadoria chegou (fisico suficiente no deposito).
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
    warehouseId: res.warehouse_id,
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
