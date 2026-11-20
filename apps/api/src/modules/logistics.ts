// SGLog Fase 4: alocacao de estoque nos pedidos (docs/22-sglog-fase4-planejamento.md e docs/23-sglog-fase4.md).
//
// - O pagamento so torna o pedido elegivel (gatilho orders_logistics_project: logistics_status = 'awaiting'). O
//   motor roda aqui, fora da transacao financeira: um erro de alocacao nunca desfaz um pagamento.
// - Confirmar uma alocacao troca a reserva do pedido pela reserva da alocacao NA MESMA TRANSACAO, com as variantes
//   travadas (mesma ordem de moveStock: saldo total antes do deposito). Nenhuma unidade fica livre no meio.
// - Desfazer a alocacao nao libera nada: a reserva continua do pedido, no mesmo deposito, sem alocacao.
// - Toda decisao (automatica, manual, troca, desfeita, analise, falta) grava uma linha imutavel em
//   allocation_decisions, com a entrada e a saida do motor.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, tx, type Db } from '../db/pool.js';
import { allocate, ENGINE_VERSION, type EngineInput, type EngineOutput, type Plan, type PlanLine, type PlanMode } from '../lib/allocation.js';
import { audit } from '../lib/audit.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation, pageQuery } from '../lib/http.js';
import { defaultWarehouseId, lockVariants, releaseReservation, reserve, RES_COLS, type Reservation } from '../lib/stock.js';
import { requireAnyPermission, requirePermission, type Auth } from './auth.js';
import { mulQty } from './orders.js';
import { offerInputs, offerRows, settings as supplierSettings } from './suppliers.js';

export const OPEN_ORDER = ['paid', 'preparing', 'ready'];
const ALLOCATABLE = ['awaiting', 'analysis', 'processing'];
const MARKETPLACES = ['mercadolivre', 'shopee'];

const milli = (v: string | number) => Math.round(Number(v) * 1000);
const q3 = (m: number) => (m / 1000).toFixed(3);

type OrderRow = {
  id: string;
  number: number;
  status: string;
  channel: string;
  logistics_status: string | null;
  logistics_note: string | null;
  logistics_version: number;
  allocation_required: boolean;
};
const ORDER_COLS = 'id, number, status, channel, logistics_status, logistics_note, logistics_version, allocation_required';

type ItemRow = { id: string; variant_id: string; sku: string; product_name: string; base_qty_per_pack: string; packs: number; made_to_order: boolean };

async function orderItems(db: Db | typeof pool, orderId: string) {
  return (
    await db.query<ItemRow>(
      'SELECT id, variant_id, sku, product_name, base_qty_per_pack, packs, made_to_order FROM order_items WHERE order_id = $1 ORDER BY sku, id',
      [orderId],
    )
  ).rows;
}

/** Entrada do motor, lida do banco. Na confirmacao, chamada com as variantes ja travadas. */
export async function engineInput(db: Db | typeof pool, order: OrderRow, items: ItemRow[]): Promise<EngineInput> {
  const variantIds = [...new Set(items.map((i) => i.variant_id))];
  const warehouses = (
    await db.query<{ id: string; code: string; name: string; is_default: boolean; allocation_priority: number }>(
      'SELECT id, code, name, is_default, allocation_priority FROM warehouses WHERE active ORDER BY is_default DESC, allocation_priority, code',
    )
  ).rows;
  // Livre por deposito para ESTE pedido: disponivel - reservado + o que ja esta reservado para ele ali.
  const stock = (
    await db.query<{ warehouse_id: string; variant_id: string; free: string }>(
      `SELECT l.warehouse_id, l.variant_id, (l.on_hand - l.reserved + coalesce(own.qty, 0))::text AS free
       FROM stock_location_balances l JOIN warehouses w ON w.id = l.warehouse_id AND w.active
       LEFT JOIN (SELECT coalesce(r.warehouse_id, (SELECT id FROM warehouses WHERE is_default)) AS warehouse_id, r.variant_id, sum(r.qty) AS qty
                  FROM stock_reservations r WHERE r.source_type = 'order' AND r.source_id = $1 AND r.status = 'active' GROUP BY 1, 2) own
         ON own.warehouse_id = l.warehouse_id AND own.variant_id = l.variant_id
       WHERE l.variant_id = ANY($2::uuid[]) ORDER BY l.warehouse_id, l.variant_id`,
      [order.id, variantIds],
    )
  ).rows;
  const offers: EngineInput['offers'] = {};
  const rows = await offerRows(db, variantIds);
  const variantOf = new Map(rows.map((r) => [r.id as string, r.variant_id as string]));
  for (const o of offerInputs(rows)) (offers[variantOf.get(o.offerId)!] ??= []).push(o);
  const cfg = await supplierSettings(db);
  const ls = (await db.query<{ dropship_status: string }>('SELECT dropship_status FROM logistics_settings')).rows[0]!;
  return {
    orderId: order.id,
    channel: order.channel,
    items: items.map((i) => ({
      orderItemId: i.id,
      variantId: i.variant_id,
      sku: i.sku,
      name: i.product_name,
      need: Number(mulQty(i.base_qty_per_pack, i.packs)),
      madeToOrder: i.made_to_order,
    })),
    warehouses: warehouses.map((w) => ({ id: w.id, code: w.code, name: w.name, isDefault: w.is_default, priority: w.allocation_priority })),
    stock: stock.map((s) => ({ warehouseId: s.warehouse_id, variantId: s.variant_id, free: Number(s.free) })),
    offers,
    choiceSettings: { tieTolerancePct: Number(cfg.tie_tolerance_pct), staleQuoteDays: cfg.stale_quote_days },
    dropshipReleased: ls.dropship_status === 'enabled',
    ownOnly: MARKETPLACES.includes(order.channel),
    now: new Date(),
  };
}

/** Entrada guardada no historico: o que o motor avaliou (sem nada pessoal do cliente). */
const inputSnapshot = (i: EngineInput) => ({
  channel: i.channel,
  items: i.items,
  warehouses: i.warehouses,
  stock: i.stock,
  offers: Object.fromEntries(
    Object.entries(i.offers).map(([v, list]) => [
      v,
      list.map((o) => ({
        offerId: o.offerId,
        supplier: o.supplierName,
        supplierStatus: o.supplierStatus,
        offerStatus: o.offerStatus,
        costCents: o.costCents,
        baseQty: o.baseQty,
        leadDays: o.leadDays,
        isPrimary: o.isPrimary,
        availableQty: o.availableQty,
        availabilityValidUntil: o.availabilityValidUntil,
        dropshipAllowed: o.dropshipAllowed,
      })),
    ]),
  ),
  choiceSettings: i.choiceSettings,
  dropshipReleased: i.dropshipReleased,
  ownOnly: i.ownOnly,
  now: i.now.toISOString(),
});

async function lockOrder(db: Db, id: string) {
  const o = (await db.query<OrderRow>(`SELECT ${ORDER_COLS} FROM orders WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!o) throw notFound();
  return o;
}

async function decision(
  db: Db,
  d: { orderId: string; kind: string; input?: unknown; output?: unknown; chosen?: unknown; justification?: string | null; requestKey?: string | null; actorId: string | null },
) {
  return (
    await db.query<{ id: string }>(
      `INSERT INTO allocation_decisions (order_id, kind, engine_version, input, output, chosen, justification, request_key, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id::text`,
      [
        d.orderId,
        d.kind,
        d.input || d.output ? ENGINE_VERSION : null,
        d.input ? JSON.stringify(d.input) : null,
        d.output ? JSON.stringify(d.output) : null,
        d.chosen ? JSON.stringify(d.chosen) : null,
        d.justification ?? null,
        d.requestKey ?? null,
        d.actorId,
      ],
    )
  ).rows[0]!.id;
}

const lineSchema = z.strictObject({
  orderItemId: z.uuid(),
  qty: z.string().regex(/^\d{1,11}(\.\d{1,3})?$/),
  mode: z.enum(['stock', 'purchase_to_order', 'dropship']),
  warehouseId: z.uuid().nullable().optional(),
  offerId: z.uuid().nullable().optional(),
});
const confirmBody = z
  .strictObject({
    logisticsVersion: z.number().int(),
    planKey: z.string().max(400).optional(),
    lines: z.array(lineSchema).min(1).max(400).optional(),
    justification: z.string().trim().min(3).max(500).optional(),
    requestKey: z.string().min(8).max(100),
  })
  .refine((b) => Boolean(b.planKey) !== Boolean(b.lines), 'Informe planKey ou lines.');
type ConfirmBody = z.infer<typeof confirmBody>;

/** Linhas pedidas, conferidas contra o pedido, os depositos, as ofertas e as travas (D4-4, D4-5, D4-13, D3). */
async function resolveLines(db: Db, order: OrderRow, items: ItemRow[], out: EngineOutput, input: EngineInput, b: ConfirmBody): Promise<{ lines: PlanLine[]; plan: Plan | null }> {
  let plan: Plan | null = null;
  let raw: { orderItemId: string; qty: string; mode: PlanMode; warehouseId?: string | null; offerId?: string | null }[];
  if (b.planKey) {
    plan = [out.recommended, ...out.alternatives].find((p) => p?.key === b.planKey) ?? null;
    if (!plan) throw new AppError(409, 'PLAN_CHANGED', 'A proposta mudou desde que a tela foi aberta (estoque ou ofertas). Recarregue e confira.');
    raw = plan.lines.map((l) => ({ orderItemId: l.orderItemId, qty: q3(milli(l.qty)), mode: l.mode, warehouseId: l.warehouseId, offerId: l.offerId }));
  } else {
    raw = b.lines!;
  }
  const dflt = await defaultWarehouseId(db);
  const byItem = new Map(items.map((i) => [i.id, i]));
  const sum = new Map<string, number>();
  const lines: PlanLine[] = [];
  for (const l of raw) {
    const it = byItem.get(l.orderItemId);
    if (!it) throw new AppError(422, 'ITEM_NOT_IN_ORDER', 'Item não pertence ao pedido.');
    if (milli(l.qty) <= 0) throw new AppError(422, 'INVALID_QTY', 'Quantidade deve ser maior que zero.');
    sum.set(it.id, (sum.get(it.id) ?? 0) + milli(l.qty));
    let warehouseId: string | null = l.warehouseId ?? null;
    let offer: { id: string; supplier_id: string; supplier_name: string; variant_id: string; unit_cost_cents: string | null; lead_days: number | null } | null = null;
    if (l.mode !== 'stock') {
      if (input.ownOnly) throw new AppError(422, 'OWN_STOCK_ONLY', 'Pedido de marketplace: só estoque próprio.');
      if (!l.offerId) throw new AppError(422, 'OFFER_REQUIRED', `${it.sku}: escolha a oferta do fornecedor.`);
      const opt = input.offers[it.variant_id]?.find((o) => o.offerId === l.offerId);
      const row = (
        await db.query(
          `SELECT t.id, t.supplier_id, t.supplier_name, t.variant_id, t.unit_cost_cents::text, t.lead_days, t.status, t.supplier_status, t.dropship_allowed, t.dropship_enabled
           FROM supplier_offer_terms t WHERE t.id = $1`,
          [l.offerId],
        )
      ).rows[0];
      if (!row || !opt || row.variant_id !== it.variant_id || row.status !== 'active' || row.supplier_status !== 'active' || opt.costCents === null) {
        throw new AppError(422, 'OFFER_INVALID', `${it.sku}: oferta inexistente, de outra variante, pausada, sem custo ou de fornecedor inativo.`);
      }
      if (l.mode === 'dropship') {
        if (!input.dropshipReleased) throw new AppError(409, 'DROPSHIP_BLOCKED', 'Dropshipping bloqueado até a validação fiscal.');
        if (!row.dropship_allowed || !row.dropship_enabled) throw new AppError(422, 'OFFER_INVALID', `${it.sku}: oferta ou fornecedor sem dropshipping.`);
        warehouseId = null;
      } else {
        // Encomenda entra pelo recebimento de compra, que ate a Fase 6 e so no padrao.
        warehouseId = dflt;
      }
      offer = row;
    } else if (!warehouseId || !input.warehouses.some((w) => w.id === warehouseId)) {
      throw new AppError(422, 'WAREHOUSE_INVALID', `${it.sku}: depósito inexistente ou desativado.`);
    }
    lines.push({
      orderItemId: it.id,
      variantId: it.variant_id,
      sku: it.sku,
      qty: milli(l.qty) / 1000,
      mode: l.mode,
      warehouseId,
      offerId: offer?.id ?? null,
      supplierId: offer?.supplier_id ?? null,
      supplierName: offer?.supplier_name ?? null,
      unitCostCents: offer?.unit_cost_cents === null || offer === null ? null : Number(offer.unit_cost_cents),
      leadDays: offer?.lead_days ?? null,
    });
  }
  for (const it of items) {
    if ((sum.get(it.id) ?? 0) !== milli(mulQty(it.base_qty_per_pack, it.packs))) {
      throw new AppError(422, 'ALLOCATION_INCOMPLETE', `${it.sku}: a alocação precisa somar exatamente ${Number(mulQty(it.base_qty_per_pack, it.packs))}.`);
    }
  }
  const reserveWarehouses = new Set(lines.filter((l) => l.mode !== 'dropship').map((l) => l.warehouseId));
  if (reserveWarehouses.size > 1) {
    throw new AppError(422, 'ONE_WAREHOUSE', 'Nesta fase o pedido sai de um único depósito próprio (a encomenda chega no depósito padrão). Transfira a mercadoria antes, se precisar.');
  }
  return { lines, plan };
}

/**
 * Troca as reservas do pedido pelas da alocacao, variante por variante, com as variantes ja travadas.
 * - Mesma quantidade, mesmo deposito, uma reserva para uma alocacao: so liga a reserva a alocacao (sem movimento).
 * - Senao: libera as do pedido e reserva as da alocacao, na mesma transacao (nenhuma venda enxerga o meio).
 * Estoque proprio confere o livre do deposito; encomenda reserva mesmo sem fisico (backorder no destino).
 */
async function swapReservations(
  db: Db,
  actorId: string | null,
  order: OrderRow,
  targets: { allocationId: string; variantId: string; warehouseId: string; qty: string; mode: PlanMode }[],
  variantIds: string[],
) {
  for (const variantId of [...new Set(variantIds)].sort()) {
    const current = (
      await db.query<Reservation>(
        `SELECT ${RES_COLS} FROM stock_reservations WHERE source_type = 'order' AND source_id = $1 AND variant_id = $2 AND status = 'active' ORDER BY id FOR UPDATE`,
        [order.id, variantId],
      )
    ).rows;
    // Estoque firme antes da encomenda: a encomenda reserva alem do fisico e nao pode consumir o livre da parte firme.
    const want = targets.filter((t) => t.variantId === variantId).sort((x, y) => Number(x.mode !== 'stock') - Number(y.mode !== 'stock'));
    const dflt = await defaultWarehouseId(db);
    if (current.length === 1 && want.length === 1) {
      const r = current[0]!;
      const t = want[0]!;
      const same = (r.warehouse_id ?? dflt) === t.warehouseId && milli(r.qty) === milli(t.qty);
      let covered = true;
      if (same && t.mode === 'stock') {
        const c = (
          await db.query<{ ok: boolean }>(
            `SELECT coalesce(l.on_hand, 0) - (coalesce(l.reserved, 0) - $3::numeric) >= $3::numeric AS ok
             FROM (SELECT 1) x LEFT JOIN stock_location_balances l ON l.warehouse_id = $1 AND l.variant_id = $2`,
            [t.warehouseId, variantId, r.qty],
          )
        ).rows[0]!;
        covered = c.ok && !r.backorder;
      }
      if (same && covered) {
        await db.query('UPDATE stock_reservations SET allocation_id = $2, warehouse_id = $3 WHERE id = $1', [r.id, t.allocationId, t.warehouseId]);
        continue;
      }
    }
    for (const r of current) await releaseReservation(db, actorId, r.id, 'released', `Troca de reserva da alocação do pedido nº ${order.number}`);
    for (const t of want) {
      await reserve(db, actorId, {
        variantId,
        qty: t.qty,
        sourceType: 'order',
        sourceId: order.id,
        warehouseId: t.warehouseId,
        allocationId: t.allocationId,
        allowBackorder: t.mode === 'purchase_to_order',
      });
    }
  }
}

/** Encerra os atendimentos confirmados do pedido (troca de origem ou desfazer). As reservas sao tratadas depois. */
async function closeFulfillments(db: Db, orderId: string, reason: string) {
  await db.query(
    `UPDATE fulfillment_allocations a SET status = 'canceled', canceled_at = now()
       FROM fulfillments f WHERE f.id = a.fulfillment_id AND f.order_id = $1 AND f.status = 'confirmed' AND a.status = 'active'`,
    [orderId],
  );
  return (await db.query(`UPDATE fulfillments SET status = 'canceled', closed_at = now(), cancel_reason = $2 WHERE order_id = $1 AND status = 'confirmed'`, [orderId, reason])).rowCount ?? 0;
}

/**
 * Grava a alocacao: atendimentos, alocacoes, reservas e a situacao 'processing'. Chamar com o pedido e as variantes
 * travados. Erro em qualquer passo (falta no deposito, por exemplo) desfaz tudo.
 */
async function applyAllocation(
  db: Db,
  actorId: string | null,
  order: OrderRow,
  items: ItemRow[],
  input: EngineInput,
  out: EngineOutput,
  lines: PlanLine[],
  meta: { kind: 'auto' | 'manual' | 'change'; justification: string | null; requestKey: string | null; planKey: string | null },
) {
  // Pedido que voltou para analise (falta descoberta) ainda tem o atendimento anterior confirmado: a nova alocacao o
  // substitui. Sem isso, a trava do teto por item recusa a nova alocacao.
  if (meta.kind === 'change') await closeFulfillments(db, order.id, meta.justification!);
  else await closeFulfillments(db, order.id, `Nova alocação do pedido em análise${order.logistics_note ? `: ${order.logistics_note}` : ''}`.slice(0, 500));
  const decisionId = await decision(db, {
    orderId: order.id,
    kind: meta.kind,
    input: inputSnapshot(input),
    output: out,
    chosen: { planKey: meta.planKey, recommended: out.recommended?.key === meta.planKey, lines },
    justification: meta.justification,
    requestKey: meta.requestKey,
    actorId,
  });
  // Um atendimento por origem: deposito (estoque), fornecedor + destino (encomenda) ou fornecedor (dropshipping).
  const groups = new Map<string, PlanLine[]>();
  for (const l of lines) {
    const k = `${l.mode}|${l.warehouseId ?? ''}|${l.supplierId ?? ''}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  const targets: { allocationId: string; variantId: string; warehouseId: string; qty: string; mode: PlanMode }[] = [];
  for (const [, ls] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const f = ls[0]!;
    const origin = f.warehouseId
      ? (await db.query('SELECT id, code, name, cep, city, uf FROM warehouses WHERE id = $1', [f.warehouseId])).rows[0]
      : null;
    const supplier = f.supplierId ? (await db.query('SELECT id, name, city, uf FROM suppliers WHERE id = $1', [f.supplierId])).rows[0] : null;
    const fid = (
      await db.query<{ id: string }>(
        `INSERT INTO fulfillments (order_id, source_kind, mode, warehouse_id, supplier_id, origin_snapshot, decision_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [order.id, f.mode === 'stock' ? 'own' : 'supplier', f.mode, f.warehouseId, f.supplierId, JSON.stringify({ warehouse: origin, supplier }), decisionId, actorId],
      )
    ).rows[0]!.id;
    for (const l of ls) {
      const aid = (
        await db.query<{ id: string }>(
          `INSERT INTO fulfillment_allocations (fulfillment_id, order_id, order_item_id, variant_id, base_qty, warehouse_id, supplier_product_id, unit_cost_cents, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [fid, order.id, l.orderItemId, l.variantId, q3(milli(l.qty)), l.warehouseId, l.offerId, l.unitCostCents, actorId],
        )
      ).rows[0]!.id;
      if (l.mode !== 'dropship') targets.push({ allocationId: aid, variantId: l.variantId, warehouseId: l.warehouseId!, qty: q3(milli(l.qty)), mode: l.mode });
    }
  }
  await swapReservations(db, actorId, order, targets, items.map((i) => i.variant_id));
  await db.query(
    `UPDATE orders SET logistics_status = 'processing', logistics_note = NULL, logistics_version = logistics_version + 1, logistics_checked_at = now() WHERE id = $1`,
    [order.id],
  );
  return decisionId;
}

/** Ja processado com esta chave (repeticao ou chamada simultanea): devolve a situacao atual, sem agir de novo. */
async function replayed(db: Db | typeof pool, requestKey: string) {
  return (await db.query<{ order_id: string }>('SELECT order_id FROM allocation_decisions WHERE request_key = $1', [requestKey])).rows[0] ?? null;
}

export async function confirmAllocation(auth: Auth, orderId: string, b: ConfirmBody, ip?: string) {
  const prior = await replayed(pool, b.requestKey);
  if (prior) {
    if (prior.order_id !== orderId) throw new AppError(409, 'REQUEST_KEY_REUSED', 'Chave de requisição já usada em outro pedido.');
    return { replayed: true };
  }
  try {
    return await tx(auth.userId, async (db) => {
      const order = await lockOrder(db, orderId);
      if (await replayed(db, b.requestKey)) return { replayed: true };
      if (order.logistics_version !== b.logisticsVersion) throw new AppError(409, 'VERSION_CONFLICT', 'A alocação do pedido mudou. Recarregue a página.');
      if (!OPEN_ORDER.includes(order.status) || !ALLOCATABLE.includes(order.logistics_status ?? '')) {
        throw new AppError(409, 'NOT_ALLOCATABLE', 'Só pedidos pagos, ainda não despachados nem cancelados, podem ser alocados.');
      }
      const change = order.logistics_status === 'processing';
      const items = await orderItems(db, orderId);
      await lockVariants(db, items.map((i) => i.variant_id));
      const input = await engineInput(db, order, items);
      const out = allocate(input);
      const { lines, plan } = await resolveLines(db, order, items, out, input, b);
      const isRecommended = Boolean(plan && out.recommended && plan.key === out.recommended.key);
      if ((change || !isRecommended) && !b.justification) {
        throw new AppError(422, 'JUSTIFICATION_REQUIRED', change ? 'Informe o motivo da troca de origem.' : 'Informe o motivo para escolher outra opção que não a recomendada.');
      }
      const decisionId = await applyAllocation(db, auth.userId, order, items, input, out, lines, {
        kind: change ? 'change' : 'manual',
        justification: b.justification ?? null,
        requestKey: b.requestKey,
        planKey: plan?.key ?? null,
      });
      await audit(db, {
        actorId: auth.userId,
        action: change ? 'logistics.allocation_changed' : 'logistics.allocated',
        entity: 'order',
        entityId: orderId,
        before: { logisticsStatus: order.logistics_status },
        after: { logisticsStatus: 'processing', decisionId, planKey: plan?.key ?? null },
        ip,
      });
      return { replayed: false, decisionId };
    });
  } catch (err) {
    // Duas chamadas simultaneas com a mesma chave: a segunda espera a primeira e cai aqui.
    if (isUniqueViolation(err, 'allocation_decisions_request_key_key') && (await replayed(pool, b.requestKey))) return { replayed: true };
    throw err;
  }
}

const cancelBody = z.strictObject({ logisticsVersion: z.number().int(), reason: z.string().trim().min(3).max(500), requestKey: z.string().min(8).max(100) });

/**
 * Desfaz a alocacao: encerra os atendimentos e devolve as reservas ao pedido (sem alocacao), no mesmo deposito.
 * Nada e liberado para outra venda. O pedido volta para analise com o motivo.
 */
export async function cancelAllocation(auth: Auth, orderId: string, b: z.infer<typeof cancelBody>, ip?: string) {
  const prior = await replayed(pool, b.requestKey);
  if (prior) return { replayed: true };
  try {
    return await tx(auth.userId, async (db) => {
      const order = await lockOrder(db, orderId);
      if (await replayed(db, b.requestKey)) return { replayed: true };
      if (order.logistics_version !== b.logisticsVersion) throw new AppError(409, 'VERSION_CONFLICT', 'A alocação do pedido mudou. Recarregue a página.');
      if (order.logistics_status !== 'processing' || !OPEN_ORDER.includes(order.status)) throw new AppError(409, 'NOT_ALLOCATED', 'O pedido não tem alocação confirmada em aberto.');
      const items = await orderItems(db, orderId);
      await lockVariants(db, items.map((i) => i.variant_id));
      await closeFulfillments(db, orderId, b.reason);
      for (const variantId of [...new Set(items.map((i) => i.variant_id))].sort()) {
        const rs = (
          await db.query<Reservation>(
            `SELECT ${RES_COLS} FROM stock_reservations WHERE source_type = 'order' AND source_id = $1 AND variant_id = $2 AND status = 'active' ORDER BY id FOR UPDATE`,
            [orderId, variantId],
          )
        ).rows;
        if (!rs.length) continue;
        if (rs.length === 1) {
          await db.query('UPDATE stock_reservations SET allocation_id = NULL WHERE id = $1', [rs[0]!.id]);
          continue;
        }
        // Varias reservas da mesma variante (itens em atendimentos diferentes): junta numa so, no mesmo deposito.
        const wh = rs[0]!.warehouse_id;
        const total = rs.reduce((s, r) => s + milli(r.qty), 0);
        for (const r of rs) await releaseReservation(db, auth.userId, r.id, 'released', `Alocação do pedido nº ${order.number} desfeita`);
        await reserve(db, auth.userId, { variantId, qty: q3(total), sourceType: 'order', sourceId: orderId, warehouseId: wh, allowBackorder: true });
      }
      await decision(db, { orderId, kind: 'detach', justification: b.reason, requestKey: b.requestKey, actorId: auth.userId });
      await db.query(
        `UPDATE orders SET logistics_status = 'analysis', logistics_note = $2, logistics_version = logistics_version + 1 WHERE id = $1`,
        [orderId, `Alocação desfeita: ${b.reason}`.slice(0, 500)],
      );
      await audit(db, { actorId: auth.userId, action: 'logistics.allocation_canceled', entity: 'order', entityId: orderId, after: { reason: b.reason }, ip });
      return { replayed: false };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'allocation_decisions_request_key_key') && (await replayed(pool, b.requestKey))) return { replayed: true };
    throw err;
  }
}

/**
 * Rotina (fora do pagamento). Para cada pedido aguardando, roda o motor:
 * - caso simples e ALLOCATION_AUTO ligado: confirma (decisao 'auto');
 * - caso que precisa de pessoa: vai para analise com o motivo (decisao 'analysis');
 * - caso simples com a rotina desligada: continua aguardando a confirmacao manual.
 * Cada pedido na sua transacao; erro num pedido o deixa em analise com o motivo e nao afeta os outros.
 */
export async function allocatePending(opts: { auto: boolean; limit?: number }) {
  const ids = (
    await pool.query<{ id: string }>(
      `SELECT id FROM orders WHERE logistics_status = 'awaiting' AND status = ANY($2::text[])
         AND (logistics_checked_at IS NULL OR logistics_checked_at < now() - interval '10 minutes')
       ORDER BY logistics_checked_at NULLS FIRST, paid_at, id LIMIT $1`,
      [opts.limit ?? 20, OPEN_ORDER],
    )
  ).rows;
  const result = { allocated: 0, analysis: 0, waiting: 0, failed: 0 };
  for (const { id } of ids) {
    try {
      const r = await tx(null, async (db) => {
        const order = (await db.query<OrderRow>(`SELECT ${ORDER_COLS} FROM orders WHERE id = $1 AND logistics_status = 'awaiting' FOR UPDATE SKIP LOCKED`, [id])).rows[0];
        if (!order) return 'skip';
        const items = await orderItems(db, id);
        await lockVariants(db, items.map((i) => i.variant_id));
        const input = await engineInput(db, order, items);
        const out = allocate(input);
        if (out.automatic && opts.auto) {
          await applyAllocation(db, null, order, items, input, out, out.recommended!.lines, { kind: 'auto', justification: null, requestKey: null, planKey: out.recommended!.key });
          return 'allocated';
        }
        if (!out.automatic) {
          await decision(db, { orderId: id, kind: 'analysis', input: inputSnapshot(input), output: out, actorId: null });
          await db.query(
            `UPDATE orders SET logistics_status = 'analysis', logistics_note = $2, logistics_version = logistics_version + 1, logistics_checked_at = now() WHERE id = $1`,
            [id, (out.analysisReason ?? 'Precisa de análise.').slice(0, 500)],
          );
          return 'analysis';
        }
        await db.query('UPDATE orders SET logistics_checked_at = now() WHERE id = $1', [id]);
        return 'waiting';
      });
      if (r === 'allocated') result.allocated++;
      else if (r === 'analysis') result.analysis++;
      else if (r === 'waiting') result.waiting++;
    } catch (err) {
      result.failed++;
      const msg = err instanceof AppError ? err.message : 'erro inesperado';
      await tx(null, async (db) => {
        const ok = (await db.query(`SELECT 1 FROM orders WHERE id = $1 AND logistics_status = 'awaiting' FOR UPDATE SKIP LOCKED`, [id])).rows[0];
        if (!ok) return;
        await decision(db, { orderId: id, kind: 'analysis', chosen: { error: msg }, actorId: null });
        await db.query(
          `UPDATE orders SET logistics_status = 'analysis', logistics_note = $2, logistics_version = logistics_version + 1, logistics_checked_at = now() WHERE id = $1`,
          [id, `Erro ao alocar automaticamente: ${msg}`.slice(0, 500)],
        );
      }).catch(() => undefined);
    }
  }
  return result;
}

/** Ve custo quem ja ve custo hoje (fornecedores ou compras). */
const seesCost = (auth: Auth) => auth.permissions.has('suppliers.view') || auth.permissions.has('purchases.view');
function stripCost<T>(v: T): T {
  return JSON.parse(JSON.stringify(v), (k, val) => (['unitCostCents', 'supplierCostCents', 'unit_cost_cents', 'costCents'].includes(k) ? undefined : val));
}

export async function logisticsRoutes(app: FastifyInstance) {
  // Fila: pedidos por situacao logistica.
  app.get('/queue', async (req) => {
    requirePermission(req, 'logistics.view');
    const q = pageQuery.extend({ status: z.enum(['awaiting', 'analysis', 'processing', 'open']).default('open') }).parse(req.query);
    const statuses = q.status === 'open' ? ['analysis', 'awaiting', 'processing'] : [q.status];
    const where = `o.logistics_status = ANY($1::text[]) AND o.status = ANY($2::text[])`;
    const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM orders o WHERE ${where}`, [statuses, OPEN_ORDER])).rows[0]!.n;
    const counts = (
      await pool.query<{ logistics_status: string; n: number }>(
        `SELECT logistics_status, count(*)::int AS n FROM orders WHERE logistics_status IN ('awaiting', 'analysis', 'processing') AND status = ANY($1::text[]) GROUP BY 1`,
        [OPEN_ORDER],
      )
    ).rows;
    const { rows } = await pool.query(
      `SELECT o.id, o.number, o.status, o.channel, o.paid_at, o.logistics_status, o.logistics_note, o.logistics_version, o.allocation_required,
              (SELECT count(*)::int FROM order_items i WHERE i.order_id = o.id) AS items,
              (SELECT string_agg(DISTINCT coalesce(w.name, s.name), ', ') FROM fulfillments f LEFT JOIN warehouses w ON w.id = f.warehouse_id
                 LEFT JOIN suppliers s ON s.id = f.supplier_id WHERE f.order_id = o.id AND f.status = 'confirmed') AS origins
       FROM orders o WHERE ${where}
       ORDER BY CASE o.logistics_status WHEN 'analysis' THEN 0 WHEN 'awaiting' THEN 1 ELSE 2 END, o.paid_at, o.number
       LIMIT $3 OFFSET $4`,
      [statuses, OPEN_ORDER, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { items: rows, total, page: q.page, pageSize: q.pageSize, counts: Object.fromEntries(counts.map((c) => [c.logistics_status, c.n])), auto: config.ALLOCATION_AUTO };
  });

  // Detalhe: proposta do motor (ao vivo), atendimentos, reservas e historico.
  app.get('/orders/:id', async (req) => {
    const auth = requirePermission(req, 'logistics.view');
    const { id } = idParams.parse(req.params);
    const order = (await pool.query<OrderRow & { paid_at: string | null }>(`SELECT ${ORDER_COLS}, paid_at FROM orders WHERE id = $1`, [id])).rows[0];
    if (!order) throw notFound();
    const items = await orderItems(pool, id);
    const canAllocate = OPEN_ORDER.includes(order.status) && ALLOCATABLE.includes(order.logistics_status ?? '');
    const proposal = canAllocate ? allocate(await engineInput(pool, order, items)) : null;
    const fulfillments = (
      await pool.query(
        `SELECT f.id, f.source_kind, f.mode, f.status, f.warehouse_id, w.name AS warehouse_name, f.supplier_id, s.name AS supplier_name,
                f.cancel_reason, f.created_at, f.closed_at, u.name AS created_by_name,
                coalesce((SELECT json_agg(json_build_object('id', a.id, 'orderItemId', a.order_item_id, 'sku', i.sku, 'qty', a.base_qty, 'status', a.status,
                           'unitCostCents', a.unit_cost_cents) ORDER BY i.sku)
                          FROM fulfillment_allocations a JOIN order_items i ON i.id = a.order_item_id WHERE a.fulfillment_id = f.id), '[]') AS allocations
         FROM fulfillments f LEFT JOIN warehouses w ON w.id = f.warehouse_id LEFT JOIN suppliers s ON s.id = f.supplier_id
         LEFT JOIN users u ON u.id = f.created_by WHERE f.order_id = $1 ORDER BY f.created_at DESC, f.id`,
        [id],
      )
    ).rows;
    const reservations = (
      await pool.query(
        `SELECT r.id, v.sku, r.qty, r.backorder, r.allocation_id, coalesce(w.name, wd.name) AS warehouse_name
         FROM stock_reservations r JOIN product_variants v ON v.id = r.variant_id
         LEFT JOIN warehouses w ON w.id = r.warehouse_id CROSS JOIN (SELECT name FROM warehouses WHERE is_default) wd
         WHERE r.source_type = 'order' AND r.source_id = $1 AND r.status = 'active' ORDER BY v.sku, r.id`,
        [id],
      )
    ).rows;
    const decisions = (
      await pool.query(
        `SELECT d.id::text, d.kind, d.engine_version, d.justification, d.chosen, d.created_at, u.name AS actor_name,
                d.output->'recommended'->>'label' AS recommended_label, d.output->>'analysisReason' AS analysis_reason
         FROM allocation_decisions d LEFT JOIN users u ON u.id = d.actor_id WHERE d.order_id = $1 ORDER BY d.id DESC`,
        [id],
      )
    ).rows;
    const ls = (await pool.query('SELECT dropship_status FROM logistics_settings')).rows[0];
    const body = {
      order,
      items: items.map((i) => ({ ...i, need: mulQty(i.base_qty_per_pack, i.packs) })),
      canAllocate,
      proposal,
      fulfillments,
      reservations,
      decisions,
      dropshipStatus: ls.dropship_status,
      auto: config.ALLOCATION_AUTO,
    };
    return seesCost(auth) ? body : stripCost(body);
  });

  app.post('/orders/:id/allocation', async (req) => {
    const auth = requirePermission(req, 'logistics.allocate');
    const { id } = idParams.parse(req.params);
    return confirmAllocation(auth, id, confirmBody.parse(req.body), req.ip);
  });

  app.post('/orders/:id/allocation/cancel', async (req) => {
    const auth = requirePermission(req, 'logistics.allocate');
    const { id } = idParams.parse(req.params);
    return cancelAllocation(auth, id, cancelBody.parse(req.body), req.ip);
  });

  // Trava do dropshipping (D3).
  app.get('/settings', async (req) => {
    requireAnyPermission(req, 'logistics.view', 'settings.manage');
    const s = (
      await pool.query(
        `SELECT l.dropship_status, l.fiscal_validator_name, l.validated_at, u.name AS validated_by_name, l.version, l.updated_at
         FROM logistics_settings l LEFT JOIN users u ON u.id = l.validated_by`,
      )
    ).rows[0];
    return { settings: s, auto: config.ALLOCATION_AUTO };
  });

  app.put('/settings/dropship', async (req) => {
    const auth = requirePermission(req, 'settings.manage');
    const b = z
      .strictObject({ status: z.enum(['blocked', 'enabled']), fiscalValidatorName: z.string().trim().min(3).max(120).optional(), version: z.number().int() })
      .refine((v) => v.status === 'blocked' || Boolean(v.fiscalValidatorName), 'Informe quem validou o tratamento fiscal.')
      .parse(req.body);
    return tx(auth.userId, async (db) => {
      const before = (await db.query('SELECT dropship_status, fiscal_validator_name, validated_by, validated_at, version FROM logistics_settings FOR UPDATE')).rows[0];
      if (before.version !== b.version) throw new AppError(409, 'VERSION_CONFLICT', 'A configuração mudou. Recarregue a página.');
      const enabled = b.status === 'enabled';
      const after = (
        await db.query(
          `UPDATE logistics_settings SET dropship_status = $1, fiscal_validator_name = $2, validated_by = $3, validated_at = CASE WHEN $4 THEN now() END,
             version = version + 1, updated_at = now() RETURNING dropship_status, fiscal_validator_name, validated_by, validated_at, version`,
          [b.status, enabled ? b.fiscalValidatorName : null, enabled ? auth.userId : null, enabled],
        )
      ).rows[0];
      await audit(db, { actorId: auth.userId, action: 'logistics.dropship', entity: 'logistics_settings', before, after, ip: req.ip });
      return { settings: after };
    });
  });
}
