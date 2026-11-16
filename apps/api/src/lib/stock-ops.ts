// SGLog Fase 3: operacoes de estoque por deposito (docs/20-sglog-fase3.md). Todas passam por moveStock, numa
// unica transacao do chamador, com o saldo total das variantes bloqueado antes (lockVariants).
import type { Db } from '../db/pool.js';
import { AppError, notFound } from './errors.js';
import { activeWarehouse, assertFree, assertWhole, lockVariants, moveStock, neg, variantInfo, type WarehouseRef } from './stock.js';

export type TransferItemInput = { variantId: string; qty: string };

type TransferRow = {
  id: string;
  number: number;
  from_warehouse_id: string;
  to_warehouse_id: string;
  status: 'in_transit' | 'partial' | 'received' | 'closed_divergent' | 'canceled';
};

function uniqueItems(items: TransferItemInput[]) {
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.variantId)) throw new AppError(422, 'DUPLICATE_ITEM', 'O mesmo produto aparece duas vezes. Some as quantidades numa linha só.');
    seen.add(it.variantId);
  }
}

async function lockTransfer(db: Db, id: string) {
  const t = (await db.query<TransferRow>('SELECT id, number, from_warehouse_id, to_warehouse_id, status FROM stock_transfers WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!t) throw notFound();
  return t;
}

/** Recalcula a situacao a partir dos itens: pendente, recebido, com divergencia. */
async function refreshStatus(db: Db, id: string) {
  await db.query(
    `UPDATE stock_transfers t SET
       status = CASE WHEN s.pending > 0 THEN CASE WHEN s.done > 0 THEN 'partial' ELSE 'in_transit' END
                     WHEN s.divergent > 0 THEN 'closed_divergent' ELSE 'received' END,
       closed_at = CASE WHEN s.pending > 0 THEN NULL ELSE now() END,
       updated_at = now()
     FROM (SELECT sum(qty_sent - qty_received - qty_lost - qty_returned) AS pending, sum(qty_received + qty_lost + qty_returned) AS done,
                  sum(qty_lost + qty_returned) AS divergent FROM stock_transfer_items WHERE transfer_id = $1) s
     WHERE t.id = $1`,
    [id],
  );
}

async function recordEvent(db: Db, actorId: string, transferId: string, kind: string, items: TransferItemInput[], reason: string | null, requestKey: string | null) {
  await db.query('INSERT INTO stock_transfer_events (transfer_id, kind, items, reason, request_key, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [
    transferId,
    kind,
    JSON.stringify(items),
    reason,
    requestKey,
    actorId,
  ]);
}

/**
 * Envio: origem perde do disponivel (so do livre: nunca toma reservado) e o destino ganha em transito, na mesma
 * transacao. Com receiveNow (operacao interna), o recebimento total e gravado em seguida como evento proprio.
 */
export async function sendTransfer(
  db: Db,
  actorId: string,
  b: { fromWarehouseId: string; toWarehouseId: string; items: TransferItemInput[]; notes?: string | null; documentRef?: string | null; requestKey: string; receiveNow?: boolean },
) {
  if (b.fromWarehouseId === b.toWarehouseId) throw new AppError(422, 'SAME_WAREHOUSE', 'Origem e destino precisam ser depósitos diferentes.');
  uniqueItems(b.items);
  const from = await activeWarehouse(db, b.fromWarehouseId);
  const to = await activeWarehouse(db, b.toWarehouseId);
  const infos = new Map<string, Awaited<ReturnType<typeof variantInfo>>>();
  for (const it of b.items) {
    const info = await variantInfo(db, it.variantId);
    assertWhole(info, it.qty);
    infos.set(it.variantId, info);
  }
  await lockVariants(db, b.items.map((i) => i.variantId));
  for (const it of b.items) await assertFree(db, from, it.variantId, infos.get(it.variantId)!.sku, it.qty);

  const t = (
    await db.query<{ id: string; number: number }>(
      `INSERT INTO stock_transfers (from_warehouse_id, to_warehouse_id, notes, document_ref, request_key, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, number`,
      [from.id, to.id, b.notes ?? null, b.documentRef ?? null, b.requestKey, actorId],
    )
  ).rows[0]!;
  for (const it of [...b.items].sort((x, y) => x.variantId.localeCompare(y.variantId))) {
    await db.query('INSERT INTO stock_transfer_items (transfer_id, variant_id, qty_sent) VALUES ($1, $2, $3)', [t.id, it.variantId, it.qty]);
    const common = { variantId: it.variantId, kind: 'transfer_out' as const, sourceType: 'transfer' as const, sourceId: t.id, transferId: t.id, documentRef: b.documentRef ?? null };
    await moveStock(db, actorId, { ...common, warehouseId: from.id, counterWarehouseId: to.id, onHandDelta: neg(it.qty) });
    await moveStock(db, actorId, { ...common, warehouseId: to.id, counterWarehouseId: from.id, inTransitDelta: it.qty });
  }
  await recordEvent(db, actorId, t.id, 'send', b.items, null, null);
  if (b.receiveNow) await settleTransfer(db, actorId, t.id, 'receive', b.items, null, null);
  return { id: t.id, number: t.number, from, to };
}

/**
 * Recebimento (total ou parcial), extravio ou recusa de itens pendentes. A transferencia fica bloqueada na linha:
 * dois recebimentos simultaneos nao passam do enviado (e o CHECK do item recusa de qualquer forma).
 *   receive: destino em transito -> disponivel
 *   loss:    destino em transito -> baixa (extravio)
 *   return:  destino em transito -> disponivel da origem (recusa; registrar quando a mercadoria voltou)
 */
export async function settleTransfer(
  db: Db,
  actorId: string,
  transferId: string,
  kind: 'receive' | 'loss' | 'return',
  items: TransferItemInput[],
  reason: string | null,
  requestKey: string | null,
) {
  uniqueItems(items);
  const t = await lockTransfer(db, transferId);
  if (t.status !== 'in_transit' && t.status !== 'partial') throw new AppError(409, 'TRANSFER_CLOSED', `A transferência nº ${t.number} já foi encerrada.`);
  if ((kind === 'loss' || kind === 'return') && !reason) throw new AppError(422, 'REASON_REQUIRED', 'Informe o motivo.');
  const dest = await activeWarehouse(db, t.to_warehouse_id);
  const origin = kind === 'return' ? await activeWarehouse(db, t.from_warehouse_id) : null;
  for (const it of items) assertWhole(await variantInfo(db, it.variantId), it.qty);
  await lockVariants(db, items.map((i) => i.variantId));
  const column = kind === 'receive' ? 'qty_received' : kind === 'loss' ? 'qty_lost' : 'qty_returned';
  for (const it of [...items].sort((x, y) => x.variantId.localeCompare(y.variantId))) {
    const row = (
      await db.query<{ pending: string; ok: boolean }>(
        `SELECT (qty_sent - qty_received - qty_lost - qty_returned)::text AS pending, qty_sent - qty_received - qty_lost - qty_returned >= $3::numeric AS ok
         FROM stock_transfer_items WHERE transfer_id = $1 AND variant_id = $2`,
        [t.id, it.variantId, it.qty],
      )
    ).rows[0];
    if (!row) throw new AppError(422, 'NOT_IN_TRANSFER', 'Item fora desta transferência.');
    if (!row.ok) throw new AppError(409, 'OVER_PENDING', `Quantidade maior que a pendente (${Number(row.pending)}). Nada foi gravado.`, { pending: row.pending, requested: it.qty });
    await db.query(`UPDATE stock_transfer_items SET ${column} = ${column} + $3 WHERE transfer_id = $1 AND variant_id = $2`, [t.id, it.variantId, it.qty]);
    const common = { variantId: it.variantId, sourceType: 'transfer' as const, sourceId: t.id, transferId: t.id, reason };
    if (kind === 'receive') {
      await moveStock(db, actorId, { ...common, kind: 'transfer_in', warehouseId: dest.id, counterWarehouseId: t.from_warehouse_id, inTransitDelta: neg(it.qty), onHandDelta: it.qty });
    } else if (kind === 'loss') {
      await moveStock(db, actorId, { ...common, kind: 'transfer_loss', warehouseId: dest.id, counterWarehouseId: t.from_warehouse_id, inTransitDelta: neg(it.qty) });
    } else {
      await moveStock(db, actorId, { ...common, kind: 'transfer_return', warehouseId: dest.id, counterWarehouseId: origin!.id, inTransitDelta: neg(it.qty) });
      await moveStock(db, actorId, { ...common, kind: 'transfer_return', warehouseId: origin!.id, counterWarehouseId: dest.id, onHandDelta: it.qty });
    }
  }
  await recordEvent(db, actorId, t.id, kind, items, reason, requestKey);
  await refreshStatus(db, t.id);
  return t;
}

/**
 * Cancela o envio (estorno): so sem nenhum recebimento, extravio ou recusa. Cada movimento do envio recebe seu
 * estorno (o banco confere que e o oposto exato e que nao foi estornado antes).
 */
export async function cancelTransfer(db: Db, actorId: string, transferId: string, reason: string, requestKey: string | null) {
  const t = await lockTransfer(db, transferId);
  if (t.status !== 'in_transit') {
    throw new AppError(409, 'TRANSFER_MOVED', `A transferência nº ${t.number} já teve recebimento, extravio ou recusa (ou foi encerrada) e não pode ser cancelada. Use a recusa ou uma transferência de volta.`);
  }
  const items = (await db.query<{ variant_id: string; qty_sent: string }>('SELECT variant_id, qty_sent FROM stock_transfer_items WHERE transfer_id = $1 ORDER BY variant_id', [t.id])).rows;
  await lockVariants(db, items.map((i) => i.variant_id));
  const moves = (
    await db.query<{ id: string; variant_id: string; warehouse_id: string; counter_warehouse_id: string; on_hand_delta: string; in_transit_delta: string }>(
      `SELECT id::text, variant_id, warehouse_id, counter_warehouse_id, on_hand_delta, in_transit_delta FROM stock_movements
       WHERE transfer_id = $1 AND kind = 'transfer_out' ORDER BY variant_id, id`,
      [t.id],
    )
  ).rows;
  // Primeiro o destino (tira do em transito), depois a origem (devolve ao disponivel).
  for (const m of [...moves].sort((a, b) => Number(b.in_transit_delta !== '0.000') - Number(a.in_transit_delta !== '0.000'))) {
    await moveStock(db, actorId, {
      variantId: m.variant_id,
      kind: 'reversal',
      reversesId: m.id,
      warehouseId: m.warehouse_id,
      counterWarehouseId: m.counter_warehouse_id,
      transferId: t.id,
      onHandDelta: neg(m.on_hand_delta),
      inTransitDelta: neg(m.in_transit_delta),
      sourceType: 'transfer',
      sourceId: t.id,
      reason,
    });
  }
  await recordEvent(db, actorId, t.id, 'cancel', items.map((i) => ({ variantId: i.variant_id, qty: i.qty_sent })), reason, requestKey);
  await db.query(`UPDATE stock_transfers SET status = 'canceled', closed_at = now(), updated_at = now() WHERE id = $1`, [t.id]);
  return t;
}

export type HoldOp = 'block' | 'unblock' | 'damage_hold' | 'damage_release' | 'damage_write_off';

/**
 * Bloqueio/quarentena, avaria e baixa do avariado num deposito.
 *   block / damage_hold:     disponivel -> bloqueado / avariado (so do livre)
 *   unblock / damage_release: bloqueado / avariado -> disponivel
 *   damage_write_off:        baixa do avariado (stock.adjust)
 */
export async function holdStock(
  db: Db,
  actorId: string,
  b: { warehouseId?: string | null; variantId: string; op: HoldOp; qty: string; reason: string; requestKey: string; documentRef?: string | null },
) {
  const wh = await activeWarehouse(db, b.warehouseId);
  const info = await variantInfo(db, b.variantId);
  assertWhole(info, b.qty);
  await lockVariants(db, [b.variantId]);
  if (b.op === 'block' || b.op === 'damage_hold') await assertFree(db, wh, b.variantId, info.sku, b.qty);
  const base = { variantId: b.variantId, warehouseId: wh.id, sourceType: 'manual' as const, reason: b.reason, requestKey: b.requestKey, documentRef: b.documentRef ?? null };
  const m =
    b.op === 'block'
      ? { ...base, kind: 'block' as const, onHandDelta: neg(b.qty), blockedDelta: b.qty }
      : b.op === 'unblock'
        ? { ...base, kind: 'unblock' as const, onHandDelta: b.qty, blockedDelta: neg(b.qty) }
        : b.op === 'damage_hold'
          ? { ...base, kind: 'damage_hold' as const, onHandDelta: neg(b.qty), damagedDelta: b.qty }
          : b.op === 'damage_release'
            ? { ...base, kind: 'damage_release' as const, onHandDelta: b.qty, damagedDelta: neg(b.qty) }
            : { ...base, kind: 'damage' as const, damagedDelta: neg(b.qty) };
  return { movement: await moveStock(db, actorId, m), warehouse: wh };
}

const REVERSIBLE = new Set(['adjustment', 'loss', 'damage', 'return', 'block', 'unblock', 'damage_hold', 'damage_release']);

/**
 * Estorno auditavel de movimento manual: grava um movimento novo com os deltas opostos, sem tocar no original.
 * Recusa: tipo nao estornavel (venda, reserva, compra, inventario, transferencia: tem fluxo proprio), estorno ja
 * feito, deposito desativado, e saida maior que o livre do deposito (nao toma reservado nem saldo ja consumido).
 */
export async function reverseMovement(db: Db, actorId: string, movementId: string, reason: string, requestKey: string) {
  const head = (await db.query<{ variant_id: string }>('SELECT variant_id FROM stock_movements WHERE id = $1', [movementId])).rows[0];
  if (!head) throw notFound();
  await lockVariants(db, [head.variant_id]);
  const o = (
    await db.query<{
      id: string;
      variant_id: string;
      kind: string;
      source_type: string | null;
      warehouse_id: string | null;
      on_hand_delta: string;
      reserved_delta: string;
      blocked_delta: string;
      damaged_delta: string;
      in_transit_delta: string;
      reversed: boolean;
    }>(
      `SELECT m.id::text, m.variant_id, m.kind, m.source_type, m.warehouse_id, m.on_hand_delta, m.reserved_delta, m.blocked_delta, m.damaged_delta, m.in_transit_delta,
              EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_id = m.id) AS reversed
       FROM stock_movements m WHERE m.id = $1`,
      [movementId],
    )
  ).rows[0]!;
  if (o.kind.startsWith('transfer_')) throw new AppError(409, 'NOT_REVERSIBLE', 'Movimento de transferência: use Cancelar envio, a recusa ou uma transferência de volta.');
  if (!REVERSIBLE.has(o.kind) || !['manual', 'adjustment_request'].includes(o.source_type ?? '')) {
    throw new AppError(409, 'NOT_REVERSIBLE', 'Só ajustes, perdas, avarias, devoluções, bloqueios e liberações lançados à mão podem ser estornados. Venda, reserva, compra e inventário têm fluxo próprio.');
  }
  if (o.reversed) throw new AppError(409, 'ALREADY_REVERSED', 'Este movimento já foi estornado.');
  const wh = await activeWarehouse(db, o.warehouse_id);
  const info = await variantInfo(db, o.variant_id);
  const onHandOut = o.on_hand_delta.startsWith('-') ? null : o.on_hand_delta; // estorno de entrada = saida
  if (onHandOut && Number(onHandOut) !== 0) await assertFree(db, wh, o.variant_id, info.sku, onHandOut);
  try {
    return await moveStock(db, actorId, {
      variantId: o.variant_id,
      kind: 'reversal',
      reversesId: o.id,
      warehouseId: wh.id,
      onHandDelta: neg(o.on_hand_delta),
      blockedDelta: neg(o.blocked_delta),
      damagedDelta: neg(o.damaged_delta),
      inTransitDelta: neg(o.in_transit_delta),
      sourceType: 'manual',
      sourceId: o.id,
      reason,
      requestKey,
    });
  } catch (err) {
    if ((err as { constraint?: string }).constraint === 'stock_movements_reverses_unique') throw new AppError(409, 'ALREADY_REVERSED', 'Este movimento já foi estornado.');
    throw err;
  }
}

export type AdjustKind = 'adjustment' | 'loss' | 'damage';

/** Lancamento de ajuste, perda ou avaria (baixa) num deposito. Perda e avaria saem; ajuste segue o sinal. */
export async function adjustStock(
  db: Db,
  actorId: string,
  b: { warehouse: WarehouseRef; variantId: string; kind: AdjustKind | 'return'; qty: string; reason: string; requestKey?: string | null; sourceType: 'manual' | 'adjustment_request'; sourceId?: string },
) {
  const delta = b.kind === 'loss' || b.kind === 'damage' ? neg(b.qty.replace('-', '')) : b.qty;
  return moveStock(db, actorId, {
    variantId: b.variantId,
    kind: b.kind,
    onHandDelta: delta,
    warehouseId: b.warehouse.id,
    sourceType: b.sourceType,
    sourceId: b.sourceId,
    reason: b.reason,
    requestKey: b.requestKey ?? null,
  });
}

