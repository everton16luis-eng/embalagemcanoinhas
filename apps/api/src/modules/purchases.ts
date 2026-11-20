import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { convertOnReceipt, type PlanResult } from '../lib/backorders.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation, pageQuery } from '../lib/http.js';
import { activeWarehouse, assertWhole, lockVariants, moveStock, qty, variantInfo } from '../lib/stock.js';
import { applyConfirmation, buildDocument, CHANNELS, documentHash, registerConfirmation, supplyOrders, type Channel } from '../lib/supply.js';
import { requireAnyPermission, requirePermission } from './auth.js';
import { conference } from './purchase-invoices.js';

const opt = <T extends z.ZodType>(s: T) => s.nullable().optional();
const money = z.number().int().min(0).max(1_000_000_000);
const note = (min = 3) => z.string().trim().min(min).max(500);

const itemSchema = z.strictObject({
  packagingId: z.uuid(),
  packs: qty,
  // Sem custo informado, usa o da lista do fornecedor.
  packCostCents: opt(money),
  // Compra abaixo do minimo ou fora do multiplo do fornecedor: aviso; para seguir, a justificativa (D2-11).
  minExceptionReason: opt(z.string().trim().min(3).max(300)),
});

const orderSchema = z.strictObject({
  supplierId: z.uuid(),
  // Fase 6: finalidade (reposicao do estoque x atendimento de encomendas) e deposito de destino (padrao sem informar).
  purpose: z.enum(['replenishment', 'fulfillment']).optional(),
  warehouseId: opt(z.uuid()),
  expectedAt: opt(z.iso.date()),
  freightCents: money.default(0),
  otherCostsCents: money.default(0),
  notes: opt(z.string().trim().max(2000)),
  items: z.array(itemSchema).min(1).max(200),
  version: z.number().int().optional(),
});
type OrderInput = z.infer<typeof orderSchema>;

const receiptSchema = z.strictObject({
  requestKey: z.string().trim().min(8).max(100),
  // D6-6: so o destino da compra. Sem informar, o destino.
  warehouseId: opt(z.uuid()),
  invoiceRef: opt(z.string().trim().max(60)),
  notes: opt(z.string().trim().max(1000)),
  items: z
    .array(
      z.strictObject({
        itemId: z.uuid(),
        // Quantidade que chegou fisicamente (aceita + recusada).
        packs: qty,
        // D6-7: parte do que chegou recusada por qualidade, fora do disponivel.
        rejectedPacks: opt(qty),
        rejectedDestination: opt(z.enum(['blocked', 'damaged'])),
        rejectedReason: opt(note()),
        // D6-12: custo da embalagem na nota. Acima da tolerancia exige justificativa e vira divergencia de preco.
        invoicedPackCostCents: opt(z.number().min(0).max(1_000_000_000)),
        priceJustification: opt(note()),
      }),
    )
    .min(1)
    .max(200),
  // Divergencias de quantidade (falta frente a nota) e item errado: registro, sem entrada.
  issues: z
    .array(z.strictObject({ itemId: z.uuid(), kind: z.enum(['quantity', 'wrong_item']), expected: opt(z.number()), found: opt(z.number()), note: note() }))
    .max(200)
    .default([]),
});

const ORDER_COLS = `o.id, o.number, o.supplier_id, s.name AS supplier_name, o.status, o.purpose, o.warehouse_id, w.name AS warehouse_name,
  o.expected_at::text AS expected_at, o.freight_cents, o.other_costs_cents, o.notes,
  o.created_at, o.created_by, o.sent_at, o.closed_at, o.cancel_reason, o.version, u.name AS created_by_name,
  o.submitted_at, o.approved_at, o.approved_by, ua.name AS approved_by_name, o.approval_self, o.approval_note,
  o.payment_informed_on::text AS payment_informed_on, o.payment_informed_amount_cents, o.payment_informed_ref, o.payment_informed_at, up.name AS payment_informed_by_name,
  o.carrier, o.tracking_code,
  o.sent_via, o.sent_document_version, o.supplier_ref, o.confirmation_status, o.confirmed_at, o.promised_at::text AS promised_at, o.followup_on::text AS followup_on,
  (SELECT coalesce(sum(round((i.packs - i.canceled_packs) * i.pack_cost_cents)), 0)::bigint FROM purchase_order_items i WHERE i.order_id = o.id) AS goods_cents`;
const ORDER_FROM = `purchase_orders o JOIN suppliers s ON s.id = o.supplier_id JOIN users u ON u.id = o.created_by JOIN warehouses w ON w.id = o.warehouse_id
  LEFT JOIN users ua ON ua.id = o.approved_by LEFT JOIN users up ON up.id = o.payment_informed_by`;

/** Aberto: ainda pode receber ou ser aprovado/enviado. Usado pela lista e pelos vinculos. */
const OPEN = ['draft', 'pending_approval', 'approved', 'sent', 'partial'];

async function load(db: Db | typeof pool, id: string) {
  const order = (await db.query(`SELECT ${ORDER_COLS} FROM ${ORDER_FROM} WHERE o.id = $1`, [id])).rows[0];
  if (!order) return null;
  order.items = (
    await db.query(
      `SELECT i.id, i.variant_id, i.packaging_id, i.packaging_label, i.base_qty_per_pack, i.packs, i.pack_cost_cents, i.received_packs, i.rejected_packs,
              i.min_order_packs, i.order_multiple_packs, i.min_exception_reason, v.sku, p.name AS product_name, p.base_unit, (i.packs * i.base_qty_per_pack)::numeric(14,3) AS base_qty,
              i.canceled_packs, i.supplier_outcome, i.promised_at::text AS promised_at, i.partial_packs, i.partial_from_packs, i.rest_promised_at::text AS rest_promised_at,
              (i.packs - i.received_packs - i.canceled_packs) AS pending_packs,
              round(i.pack_cost_cents / i.base_qty_per_pack, 4) AS unit_cost_cents,
              coalesce((SELECT sum(l.base_qty) FROM purchase_order_links l WHERE l.purchase_order_item_id = i.id AND l.status = 'active'), 0)::numeric(14,3) AS linked_qty
       FROM purchase_order_items i JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
       WHERE i.order_id = $1 ORDER BY p.name, v.sku, i.base_qty_per_pack`,
      [id],
    )
  ).rows;
  order.receipts = (
    await db.query(
      `SELECT r.id, r.invoice_ref, r.notes, r.received_at, u.name AS received_by_name, coalesce(r.warehouse_id, (SELECT id FROM warehouses WHERE is_default)) AS warehouse_id,
              coalesce(json_agg(json_build_object('itemId', ri.item_id, 'packs', ri.packs, 'baseQty', ri.base_qty, 'unitCostCents', ri.unit_cost_cents,
                'allocatedExtraCents', ri.allocated_extra_cents, 'rejectedPacks', ri.rejected_packs, 'rejectedBaseQty', ri.rejected_base_qty,
                'rejectedDestination', ri.rejected_destination, 'invoicedPackCostCents', ri.invoiced_pack_cost_cents) ORDER BY ri.item_id)
                FILTER (WHERE ri.item_id IS NOT NULL), '[]') AS items
       FROM purchase_receipts r JOIN users u ON u.id = r.received_by LEFT JOIN purchase_receipt_items ri ON ri.receipt_id = r.id
       WHERE r.order_id = $1 GROUP BY r.id, u.name ORDER BY r.received_at`,
      [id],
    )
  ).rows;
  order.issues = (
    await db.query(
      `SELECT x.id, x.receipt_id, x.item_id, x.kind, x.expected, x.found, x.qty, x.destination, x.note, x.created_at, u.name AS actor_name
       FROM purchase_receipt_issues x JOIN purchase_receipts r ON r.id = x.receipt_id JOIN users u ON u.id = x.actor_id
       WHERE r.order_id = $1 ORDER BY x.id`,
      [id],
    )
  ).rows;
  order.events = (
    await db.query(
      `SELECT e.id, e.kind, e.note, e.data, e.created_at, u.name AS actor_name FROM purchase_order_events e JOIN users u ON u.id = e.actor_id
       WHERE e.order_id = $1 ORDER BY e.id`,
      [id],
    )
  ).rows;
  order.links = (
    await db.query(
      `SELECT l.id, l.purchase_order_item_id AS item_id, l.allocation_id, l.order_id, o.number AS order_number, l.base_qty, l.status, l.cancel_reason,
              l.created_at, l.closed_at, u.name AS created_by_name,
              (SELECT CASE WHEN r.status <> 'active' THEN r.status WHEN r.backorder THEN 'awaiting' ELSE 'converted' END
                 FROM stock_reservations r WHERE r.allocation_id = l.allocation_id ORDER BY r.created_at DESC LIMIT 1) AS reservation_state
       FROM purchase_order_links l JOIN orders o ON o.id = l.order_id JOIN users u ON u.id = l.created_by
       WHERE l.purchase_order_id = $1 ORDER BY l.status, o.number`,
      [id],
    )
  ).rows;
  order.conversions = (
    await db.query(
      `SELECT c.id, c.order_id, o.number AS order_number, c.variant_id, c.qty, c.rule, c.receipt_id, c.created_at
       FROM reservation_conversions c JOIN orders o ON o.id = c.order_id WHERE c.purchase_order_id = $1 ORDER BY c.id`,
      [id],
    )
  ).rows;
  // Fase 7: versoes enviadas (sem o conteudo: GET /:id/documents/:version), confirmacoes, requisicoes, notas e situacao.
  order.documents = (
    await db.query(
      `SELECT d.version, d.channel, d.content_hash, d.note, d.created_at, u.name AS actor_name FROM purchase_order_documents d JOIN users u ON u.id = d.actor_id
       WHERE d.order_id = $1 ORDER BY d.version`,
      [id],
    )
  ).rows;
  order.confirmations = (
    await db.query(
      `SELECT c.id, c.version, c.outcome, c.channel, c.supplier_ref, c.promised_at::text AS promised_at, c.note, c.price_increase_cents, c.status,
              c.decided_at, ud.name AS decided_by_name, c.decision_note, c.decision_self, c.actor_id, c.created_at, u.name AS actor_name,
              (SELECT json_agg(json_build_object('itemId', ci.item_id, 'label', i.packaging_label, 'outcome', ci.outcome, 'pendingPacks', ci.pending_packs,
                 'confirmedPacks', ci.confirmed_packs, 'orderedPackCostCents', ci.ordered_pack_cost_cents, 'confirmedPackCostCents', ci.confirmed_pack_cost_cents,
                 'promisedAt', ci.promised_at, 'restPromisedAt', ci.rest_promised_at, 'note', ci.note) ORDER BY i.packaging_label)
                 FROM purchase_confirmation_items ci JOIN purchase_order_items i ON i.id = ci.item_id WHERE ci.confirmation_id = c.id) AS items
       FROM purchase_confirmations c JOIN users u ON u.id = c.actor_id LEFT JOIN users ud ON ud.id = c.decided_by
       WHERE c.order_id = $1 ORDER BY c.version DESC`,
      [id],
    )
  ).rows;
  order.requests = (
    await db.query(
      `SELECT q.id, q.number, q.source, q.status, q.base_qty, q.reason, q.order_id, o.number AS order_number, q.purchase_order_item_id, v.sku, p.name AS product_name
       FROM purchase_requests q JOIN product_variants v ON v.id = q.variant_id JOIN products p ON p.id = v.product_id LEFT JOIN orders o ON o.id = q.order_id
       WHERE q.purchase_order_id = $1 OR EXISTS (SELECT 1 FROM purchase_request_events e WHERE e.request_id = q.id AND e.purchase_order_id = $1)
       ORDER BY q.number`,
      [id],
    )
  ).rows;
  order.invoices = (
    await db.query('SELECT id, series, number, issued_at, total_cents, protocol_status FROM purchase_invoices WHERE purchase_order_id = $1 ORDER BY created_at', [id])
  ).rows;
  const supply = (await supplyOrders(db, { orderIds: [id] }))[0];
  order.supply = supply ? { category: supply.category, refDate: supply.ref_date, daysLate: supply.days_late, confirmationDue: supply.confirmation_due } : null;
  return order;
}

const sendSchema = z.strictObject({
  channel: z.enum(CHANNELS).default('other'),
  // Mensagem ao fornecedor, impressa no documento. A observacao interna da compra nunca vai para o documento.
  message: opt(z.string().trim().max(1000)),
  note: opt(z.string().trim().max(500)),
});

/** Gera e guarda a proxima versao do documento (imutavel). 422 DOCUMENT_INCOMPLETE com o que falta. */
async function saveDocument(db: Db, actorId: string, orderId: string, channel: Channel, message: string | null, docNote: string | null) {
  const built = await buildDocument(db, orderId, message);
  if (!built.document) {
    throw new AppError(422, 'DOCUMENT_INCOMPLETE', 'Faltam dados obrigatórios para gerar o pedido ao fornecedor.', { missing: built.missing });
  }
  const hash = documentHash(built.document, built.text!);
  const version = (await db.query<{ v: number }>('SELECT coalesce(max(version), 0)::int + 1 AS v FROM purchase_order_documents WHERE order_id = $1', [orderId])).rows[0]!.v;
  await db.query(
    `INSERT INTO purchase_order_documents (order_id, version, channel, content, body_text, content_hash, note, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [orderId, version, channel, JSON.stringify(built.document), built.text, hash, docNote, actorId],
  );
  return { version, hash, text: built.text! };
}

type MinException = { packagingId: string; label: string; packs: string; minOrderPacks: string | null; orderMultiplePacks: string | null; reason: string | null };

/**
 * Valida as embalagens, copia rotulo e conversao e preenche o custo com a lista do fornecedor. Copia tambem o minimo e
 * o multiplo da oferta ativa: abaixo do minimo ou fora do multiplo so passa com justificativa (422 BELOW_MINIMUM com a
 * lista, para a tela pedir); a justificativa fica no item e na auditoria. Devolve as excecoes aceitas.
 *
 * Fase 6: atualiza o item existente da mesma embalagem (o id fica, e os vinculos com encomendas apontam para ele).
 * Item com vinculo nao e removido, e a quantidade nao fica abaixo do que esta vinculado.
 */
export async function saveItems(db: Db, orderId: string, supplierId: string, items: OrderInput['items']): Promise<MinException[]> {
  const seen = new Set<string>();
  const exceptions: MinException[] = [];
  const existing = new Map(
    (
      await db.query<{ id: string; packaging_id: string; linked: string; ever_linked: boolean }>(
        `SELECT i.id, i.packaging_id,
                coalesce((SELECT sum(l.base_qty) FROM purchase_order_links l WHERE l.purchase_order_item_id = i.id AND l.status = 'active'), 0)::text AS linked,
                EXISTS (SELECT 1 FROM purchase_order_links l WHERE l.purchase_order_item_id = i.id) AS ever_linked
         FROM purchase_order_items i WHERE i.order_id = $1`,
        [orderId],
      )
    ).rows.map((r) => [r.packaging_id, r]),
  );
  for (const it of items) {
    if (seen.has(it.packagingId)) throw new AppError(422, 'DUPLICATE_ITEM', 'A mesma embalagem aparece duas vezes no pedido.');
    seen.add(it.packagingId);
  }
  for (const [packagingId, row] of existing) {
    if (seen.has(packagingId)) continue;
    if (row.ever_linked) throw new AppError(409, 'ITEM_LINKED', 'Este item tem vínculo com encomenda de cliente e não pode ser removido. Reduza a quantidade ou cancele o vínculo.');
    // Fase 7: requisicao manual que entrou por este item volta a ficar aberta (nao se perde nem trava a remocao).
    await db.query(
      `WITH r AS (UPDATE purchase_requests SET status = 'open', purchase_order_id = NULL, purchase_order_item_id = NULL, updated_at = now()
                   WHERE purchase_order_item_id = $1 AND status = 'in_purchase' RETURNING id, $2::uuid AS po)
       INSERT INTO purchase_request_events (request_id, kind, note, purchase_order_id) SELECT id, 'returned', 'Item retirado do rascunho da compra: a requisição voltou a ficar aberta', po FROM r`,
      [row.id, orderId],
    );
    await db.query('DELETE FROM purchase_order_items WHERE id = $1', [row.id]);
  }
  for (const it of items) {
    const k = (
      await db.query<{ variant_id: string; label: string; base_qty: string; offer_cost: string | null; active: boolean; min_packs: string | null; multiple: string | null; below: boolean; off_multiple: boolean }>(
        `SELECT k.variant_id, k.label, k.base_qty, (k.active AND v.active) AS active, sp.cost_cents AS offer_cost,
                sp.min_order_packs AS min_packs, sp.order_multiple_packs AS multiple,
                coalesce($3::numeric < sp.min_order_packs, false) AS below, coalesce(mod($3::numeric, sp.order_multiple_packs) <> 0, false) AS off_multiple
         FROM packagings k JOIN product_variants v ON v.id = k.variant_id
         LEFT JOIN supplier_products sp ON sp.supplier_id = $2 AND sp.packaging_id = k.id AND sp.active
         WHERE k.id = $1`,
        [it.packagingId, supplierId, it.packs],
      )
    ).rows[0];
    if (!k || !k.active) throw new AppError(422, 'INVALID_PACKAGING', 'Embalagem inexistente ou inativa.');
    const cost = it.packCostCents ?? (k.offer_cost === null ? null : Number(k.offer_cost));
    if (cost === null) throw new AppError(422, 'COST_REQUIRED', `Informe o custo de "${k.label}": não há preço deste fornecedor cadastrado.`);
    const info = await variantInfo(db, k.variant_id);
    const base = (await db.query<{ q: string; under: boolean }>('SELECT ($1::numeric * $2::numeric)::numeric(14,3)::text AS q, ($1::numeric * $2::numeric) < $3::numeric AS under', [
      it.packs,
      k.base_qty,
      existing.get(it.packagingId)?.linked ?? '0',
    ])).rows[0]!;
    assertWhole(info, base.q);
    if (base.under) throw new AppError(409, 'LINKS_EXCEED', `"${k.label}": a quantidade ficaria abaixo do que está vinculado a encomendas de clientes. Cancele vínculos antes de reduzir.`);
    const exception = k.below || k.off_multiple;
    if (exception) exceptions.push({ packagingId: it.packagingId, label: k.label, packs: String(it.packs), minOrderPacks: k.min_packs, orderMultiplePacks: k.multiple, reason: it.minExceptionReason ?? null });
    const prior = existing.get(it.packagingId);
    if (prior) {
      await db.query(
        `UPDATE purchase_order_items SET packs = $2, pack_cost_cents = $3, min_order_packs = $4, order_multiple_packs = $5, min_exception_reason = $6 WHERE id = $1`,
        [prior.id, it.packs, cost, k.min_packs, k.multiple, exception ? (it.minExceptionReason ?? null) : null],
      );
    } else {
      await db.query(
        `INSERT INTO purchase_order_items (order_id, variant_id, packaging_id, packaging_label, base_qty_per_pack, packs, pack_cost_cents, min_order_packs,
           order_multiple_packs, min_exception_reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [orderId, k.variant_id, it.packagingId, k.label, k.base_qty, it.packs, cost, k.min_packs, k.multiple, exception ? (it.minExceptionReason ?? null) : null],
      );
    }
  }
  const missing = exceptions.filter((e) => !e.reason);
  if (missing.length) {
    throw new AppError(422, 'BELOW_MINIMUM', 'Há itens abaixo do mínimo ou fora do múltiplo do fornecedor. Ajuste a quantidade ou informe a justificativa para seguir.', { items: missing });
  }
  return exceptions;
}

async function auditExceptions(db: Db, actorId: string, orderId: string, exceptions: MinException[], ip: string) {
  if (exceptions.length) await audit(db, { actorId, action: 'purchases.min_exception', entity: 'purchase_order', entityId: orderId, metadata: { items: exceptions }, ip });
}

type LockedOrder = {
  id: string;
  number: number;
  status: string;
  supplier_id: string;
  warehouse_id: string;
  version: number;
  freight_cents: string;
  other_costs_cents: string;
  created_by: string;
  submitted_by: string | null;
  confirmation_status: string;
  sent_document_version: number | null;
};

async function lockOrder(db: Db, id: string) {
  const o = (
    await db.query<LockedOrder>(
      `SELECT id, number, status, supplier_id, warehouse_id, version, freight_cents, other_costs_cents, created_by, submitted_by, confirmation_status, sent_document_version
       FROM purchase_orders WHERE id = $1 FOR UPDATE`,
      [id],
    )
  ).rows[0];
  if (!o) throw notFound();
  return o;
}

async function event(db: Db, orderId: string, kind: string, actorId: string, eventNote: string | null = null, data: Record<string, unknown> = {}) {
  await db.query('INSERT INTO purchase_order_events (order_id, kind, note, data, actor_id) VALUES ($1, $2, $3, $4, $5)', [orderId, kind, eventNote, JSON.stringify(data), actorId]);
}

export async function purchaseSettings(db: Db | typeof pool) {
  return (
    await db.query<{ purchase_approval_min_cents: string; purchase_price_tolerance_pct: string; purchase_confirmation_days: number }>(
      'SELECT purchase_approval_min_cents, purchase_price_tolerance_pct, purchase_confirmation_days FROM logistics_settings',
    )
  ).rows[0]!;
}
// Fase 7 (D7-8): prazo para o fornecedor confirmar, em dias corridos desde o envio.
const settingsView = (s: Awaited<ReturnType<typeof purchaseSettings>>) => ({
  approvalMinCents: Number(s.purchase_approval_min_cents),
  priceTolerancePct: s.purchase_price_tolerance_pct,
  confirmationDays: s.purchase_confirmation_days,
});

/** Valor total da compra (mercadoria + frete + despesas), em centavos. */
async function orderTotal(db: Db, id: string) {
  return Number(
    (
      await db.query<{ t: string }>(
        `SELECT (coalesce((SELECT sum(round(packs * pack_cost_cents)) FROM purchase_order_items WHERE order_id = $1), 0) + o.freight_cents + o.other_costs_cents)::text AS t
         FROM purchase_orders o WHERE o.id = $1`,
        [id],
      )
    ).rows[0]!.t,
  );
}

/**
 * D6-8: compra encerrada ou cancelada com encomendas vinculadas ainda aguardando. O gatilho cancela os vinculos (a
 * encomenda volta para a fila comum, sem cancelar nada do cliente); aqui fica a lista para a resposta, a auditoria e
 * o historico da compra. O pedido do cliente mostra a pendencia pelo vinculo cancelado (sem travar o pedido aqui).
 */
async function pendingLinks(db: Db, purchaseOrderId: string) {
  return (
    await db.query<{ order_id: string; order_number: number; base_qty: string }>(
      `SELECT l.order_id, o.number AS order_number, l.base_qty::text AS base_qty
       FROM purchase_order_links l JOIN orders o ON o.id = l.order_id
       WHERE l.purchase_order_id = $1 AND l.status = 'active'
         AND EXISTS (SELECT 1 FROM stock_reservations r WHERE r.allocation_id = l.allocation_id AND r.status = 'active' AND r.backorder)
       ORDER BY o.number`,
      [purchaseOrderId],
    )
  ).rows;
}

export async function purchaseRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    requirePermission(req, 'purchases.view');
    const q = pageQuery
      .extend({ status: z.enum(['draft', 'pending_approval', 'approved', 'sent', 'partial', 'received', 'canceled', 'open']).optional(), supplierId: z.uuid().optional() })
      .parse(req.query);
    const statuses = q.status === 'open' ? OPEN : q.status ? [q.status] : null;
    const params = [statuses, q.supplierId ?? null];
    const where = '($1::text[] IS NULL OR o.status = ANY($1)) AND ($2::uuid IS NULL OR o.supplier_id = $2)';
    const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM purchase_orders o WHERE ${where}`, params)).rows[0]!.n;
    const { rows } = await pool.query(
      `SELECT ${ORDER_COLS}, (SELECT count(*)::int FROM purchase_order_items i WHERE i.order_id = o.id) AS item_count
       FROM ${ORDER_FROM} WHERE ${where} ORDER BY o.number DESC LIMIT $3 OFFSET $4`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { items: rows, total, page: q.page, pageSize: q.pageSize };
  });

  // Regras da compra (D6-3 limite de aprovacao; D6-12 tolerancia de preco). Antes de /:id.
  app.get('/settings', async (req) => {
    requireAnyPermission(req, 'purchases.view', 'settings.manage');
    return { settings: settingsView(await purchaseSettings(pool)) };
  });

  app.put('/settings', async (req) => {
    const auth = requirePermission(req, 'settings.manage');
    const b = z
      .strictObject({ approvalMinCents: money, priceTolerancePct: z.number().min(0).max(100), confirmationDays: z.number().int().min(1).max(30).optional() })
      .parse(req.body);
    return tx(auth.userId, async (db) => {
      const before = (await db.query('SELECT purchase_approval_min_cents, purchase_price_tolerance_pct, purchase_confirmation_days FROM logistics_settings FOR UPDATE')).rows[0];
      await db.query('UPDATE logistics_settings SET purchase_approval_min_cents = $1, purchase_price_tolerance_pct = $2, purchase_confirmation_days = coalesce($3, purchase_confirmation_days)', [
        b.approvalMinCents,
        b.priceTolerancePct,
        b.confirmationDays ?? null,
      ]);
      const after = await purchaseSettings(db);
      await audit(db, { actorId: auth.userId, action: 'purchases.settings', entity: 'logistics_settings', before, after, ip: req.ip });
      return { settings: settingsView(after) };
    });
  });

  app.get('/:id', async (req) => {
    requirePermission(req, 'purchases.view');
    const { id } = idParams.parse(req.params);
    const order = await load(pool, id);
    if (!order) throw notFound();
    return { order };
  });

  app.post('/', async (req, reply) => {
    const auth = requirePermission(req, 'purchases.manage');
    const b = orderSchema.parse(req.body);
    const order = await tx(auth.userId, async (db) => {
      const s = (await db.query<{ active: boolean; status: string }>('SELECT active, status FROM suppliers WHERE id = $1', [b.supplierId])).rows[0];
      if (s?.status === 'blocked') throw new AppError(422, 'SUPPLIER_BLOCKED', 'Fornecedor bloqueado: não recebe pedido de compra novo.');
      if (!s?.active) throw new AppError(422, 'INVALID_SUPPLIER', 'Fornecedor inexistente ou inativo.');
      const wh = await activeWarehouse(db, b.warehouseId);
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO purchase_orders (supplier_id, purpose, warehouse_id, expected_at, freight_cents, other_costs_cents, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [b.supplierId, b.purpose ?? 'replenishment', wh.id, b.expectedAt ?? null, b.freightCents, b.otherCostsCents, b.notes ?? null, auth.userId],
      );
      const id = rows[0]!.id;
      const exceptions = await saveItems(db, id, b.supplierId, b.items);
      const saved = await load(db, id);
      await audit(db, { actorId: auth.userId, action: 'purchases.created', entity: 'purchase_order', entityId: id, after: saved, ip: req.ip });
      await auditExceptions(db, auth.userId, id, exceptions, req.ip);
      return saved;
    });
    return reply.code(201).send({ order });
  });

  /**
   * Editavel antes do envio (rascunho, aguardando aprovacao ou aprovado). Editar o que estava aguardando ou aprovado
   * volta para rascunho: a aprovacao valia para o pedido anterior (D6-4). Enviado: so previsao e observacao; itens e
   * valores mudam cancelando e refazendo (o fornecedor ja tem o pedido aprovado).
   */
  app.put('/:id', async (req) => {
    const auth = requirePermission(req, 'purchases.manage');
    const { id } = idParams.parse(req.params);
    const b = orderSchema.parse(req.body);
    const order = await tx(auth.userId, async (db) => {
      const o = await lockOrder(db, id);
      if (!['draft', 'pending_approval', 'approved', 'sent'].includes(o.status)) throw new AppError(409, 'ORDER_LOCKED', 'Pedido com recebimento, encerrado ou cancelado não pode ser alterado.');
      if (b.version !== undefined && b.version !== o.version) throw new AppError(409, 'VERSION_CONFLICT', 'Outra pessoa alterou este pedido. Recarregue para ver a versão atual.');
      if (b.supplierId !== o.supplier_id && o.status !== 'draft') throw new AppError(409, 'ORDER_LOCKED', 'Só o rascunho muda de fornecedor.');
      if (b.supplierId !== o.supplier_id) {
        // Trocar o rascunho para um fornecedor bloqueado seria o mesmo que criar pedido novo para ele.
        const st = (await db.query<{ status: string }>('SELECT status FROM suppliers WHERE id = $1', [b.supplierId])).rows[0];
        if (st?.status === 'blocked') throw new AppError(422, 'SUPPLIER_BLOCKED', 'Fornecedor bloqueado: não recebe pedido de compra novo.');
      }
      const wh = b.warehouseId === undefined ? { id: o.warehouse_id } : await activeWarehouse(db, b.warehouseId);
      if (wh.id !== o.warehouse_id) {
        if (o.status === 'sent') throw new AppError(409, 'ORDER_LOCKED', 'Pedido enviado não muda de destino.');
        const linked = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM purchase_order_links WHERE purchase_order_id = $1 AND status = 'active'`, [id])).rows[0]!.n;
        if (linked) throw new AppError(409, 'ORDER_LINKED', 'A compra tem encomendas vinculadas neste depósito. Cancele os vínculos antes de trocar o destino.');
      }
      const before = await load(db, id);
      if (o.status === 'sent') {
        const same =
          before!.purpose === (b.purpose ?? before!.purpose) &&
          Number(before!.freight_cents) === b.freightCents &&
          Number(before!.other_costs_cents) === b.otherCostsCents &&
          b.items.length === before!.items.length &&
          b.items.every((it) => {
            const cur = before!.items.find((x: { packaging_id: string }) => x.packaging_id === it.packagingId);
            return cur && Number(cur.packs) === Number(it.packs) && (it.packCostCents == null || Number(cur.pack_cost_cents) === it.packCostCents);
          });
        if (!same) throw new AppError(409, 'ORDER_LOCKED', 'Pedido já enviado: só a previsão e a observação mudam. Para mudar itens ou valores, cancele e faça outro pedido.');
        await db.query(`UPDATE purchase_orders SET expected_at = $2, notes = $3, version = version + 1, updated_at = now() WHERE id = $1`, [id, b.expectedAt ?? null, b.notes ?? null]);
      } else {
        await db.query(
          `UPDATE purchase_orders SET supplier_id = $2, purpose = $3, warehouse_id = $4, expected_at = $5, freight_cents = $6, other_costs_cents = $7, notes = $8,
             status = 'draft', submitted_by = NULL, submitted_at = NULL, approved_by = NULL, approved_at = NULL, approval_self = false, approval_note = NULL,
             version = version + 1, updated_at = now() WHERE id = $1`,
          [id, b.supplierId, b.purpose ?? before!.purpose, wh.id, b.expectedAt ?? null, b.freightCents, b.otherCostsCents, b.notes ?? null],
        );
        const exceptions = await saveItems(db, id, b.supplierId, b.items);
        await auditExceptions(db, auth.userId, id, exceptions, req.ip);
        if (o.status !== 'draft') await event(db, id, 'back_to_draft', auth.userId, 'Pedido alterado: a aprovação anterior deixou de valer', { from: o.status });
      }
      const after = await load(db, id);
      await audit(db, { actorId: auth.userId, action: 'purchases.updated', entity: 'purchase_order', entityId: id, before, after, ip: req.ip });
      return after;
    });
    return { order };
  });

  /**
   * Envia para aprovacao (D6-3). Total abaixo do limite: aprovado na hora, sem aprovador (approved_by nulo), com o
   * motivo no historico. Com limite 0, toda compra passa pela aprovacao.
   */
  app.post('/:id/submit', async (req) => {
    const auth = requirePermission(req, 'purchases.manage');
    const { id } = idParams.parse(req.params);
    return tx(auth.userId, async (db) => {
      const o = await lockOrder(db, id);
      if (o.status !== 'draft') throw new AppError(409, 'INVALID_STATUS', 'Só rascunho vai para aprovação.');
      const st = (await db.query<{ status: string; blocked_reason: string | null }>('SELECT status, blocked_reason FROM suppliers WHERE id = $1', [o.supplier_id])).rows[0];
      if (st?.status === 'blocked') throw new AppError(409, 'SUPPLIER_BLOCKED', `Fornecedor bloqueado${st.blocked_reason ? `: ${st.blocked_reason}` : ''}. O rascunho não pode seguir.`);
      const total = await orderTotal(db, id);
      const min = Number((await purchaseSettings(db)).purchase_approval_min_cents);
      const auto = total < min;
      await db.query(
        `UPDATE purchase_orders SET status = $2, submitted_by = $3, submitted_at = now(), approved_at = CASE WHEN $4 THEN now() END,
           approval_note = CASE WHEN $4 THEN 'Abaixo do limite de aprovação' END, version = version + 1, updated_at = now() WHERE id = $1`,
        [id, auto ? 'approved' : 'pending_approval', auth.userId, auto],
      );
      await event(db, id, 'submitted', auth.userId, null, { totalCents: total, approvalMinCents: min });
      if (auto) await event(db, id, 'approved', auth.userId, 'Abaixo do limite de aprovação', { automatic: true, totalCents: total });
      await audit(db, { actorId: auth.userId, action: auto ? 'purchases.auto_approved' : 'purchases.submitted', entity: 'purchase_order', entityId: id, metadata: { totalCents: total, approvalMinCents: min }, ip: req.ip });
      return { order: await load(db, id) };
    });
  });

  /**
   * Aprovacao (D6-4): quem criou ou enviou para aprovacao nao aprova. Excecao: o proprietario, com justificativa,
   * marcada na compra (approval_self) e na auditoria. Permissao com MFA.
   */
  app.post('/:id/approve', async (req) => {
    const auth = requirePermission(req, 'purchases.approve');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ note: opt(note()), version: z.number().int().optional() }).parse(req.body ?? {});
    return tx(auth.userId, async (db) => {
      const o = await lockOrder(db, id);
      if (o.status !== 'pending_approval') throw new AppError(409, 'INVALID_STATUS', 'Só pedido aguardando aprovação pode ser aprovado.');
      if (b.version !== undefined && b.version !== o.version) throw new AppError(409, 'VERSION_CONFLICT', 'O pedido mudou desde que você abriu. Recarregue antes de aprovar.');
      const own = o.created_by === auth.userId || o.submitted_by === auth.userId;
      if (own && auth.role !== 'owner') throw new AppError(403, 'SELF_APPROVAL', 'Quem criou ou enviou a compra para aprovação não pode aprová-la. Peça a outra pessoa com a permissão.');
      if (own && !b.note) throw new AppError(422, 'JUSTIFICATION_REQUIRED', 'Proprietário aprovando a própria compra: informe a justificativa.');
      const total = await orderTotal(db, id);
      await db.query(
        `UPDATE purchase_orders SET status = 'approved', approved_by = $2, approved_at = now(), approval_self = $3, approval_note = $4, version = version + 1, updated_at = now() WHERE id = $1`,
        [id, auth.userId, own, b.note ?? null],
      );
      await event(db, id, 'approved', auth.userId, b.note ?? null, { self: own, totalCents: total });
      await audit(db, { actorId: auth.userId, action: own ? 'purchases.approved_self' : 'purchases.approved', entity: 'purchase_order', entityId: id, metadata: { totalCents: total, note: b.note ?? null }, ip: req.ip });
      return { order: await load(db, id) };
    });
  });

  app.post('/:id/reject-approval', async (req) => {
    const auth = requirePermission(req, 'purchases.approve');
    const { id } = idParams.parse(req.params);
    const { reason } = z.strictObject({ reason: note() }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const o = await lockOrder(db, id);
      if (o.status !== 'pending_approval') throw new AppError(409, 'INVALID_STATUS', 'Só pedido aguardando aprovação pode ser devolvido.');
      await db.query(`UPDATE purchase_orders SET status = 'draft', submitted_by = NULL, submitted_at = NULL, version = version + 1, updated_at = now() WHERE id = $1`, [id]);
      await event(db, id, 'approval_rejected', auth.userId, reason);
      await audit(db, { actorId: auth.userId, action: 'purchases.approval_rejected', entity: 'purchase_order', entityId: id, metadata: { reason }, ip: req.ip });
      return { order: await load(db, id) };
    });
  });

  /**
   * Fase 7 (D7-1, D7-2): o envio gera o documento do pedido e guarda a versao enviada (imutavel: conteudo, texto e
   * hash, com usuario, data e canal). O envio em si e manual (impresso, PDF, WhatsApp ou e-mail pela equipe): o
   * sistema nao manda e-mail ao fornecedor. Faltando dado obrigatorio, 422 com a lista. A partir daqui a compra e
   * acompanhada (aguardando confirmacao do fornecedor).
   */
  app.post('/:id/send', async (req) => {
    const auth = requirePermission(req, 'purchases.manage');
    const { id } = idParams.parse(req.params);
    const b = sendSchema.parse(req.body ?? {});
    return tx(auth.userId, async (db) => {
      const o = await lockOrder(db, id);
      if (o.status === 'draft' || o.status === 'pending_approval') throw new AppError(409, 'APPROVAL_REQUIRED', 'A compra precisa ser aprovada antes do envio ao fornecedor.');
      if (o.status !== 'approved') throw new AppError(409, 'INVALID_STATUS', 'Só pedido aprovado pode ser marcado como enviado.');
      // Fornecedor bloqueado: o pedido nao e enviado (o ja enviado continua podendo ser recebido).
      const st = (await db.query<{ status: string; blocked_reason: string | null }>('SELECT status, blocked_reason FROM suppliers WHERE id = $1', [o.supplier_id])).rows[0];
      if (st?.status === 'blocked') throw new AppError(409, 'SUPPLIER_BLOCKED', `Fornecedor bloqueado${st.blocked_reason ? `: ${st.blocked_reason}` : ''}. O pedido não pode ser enviado.`);
      const doc = await saveDocument(db, auth.userId, id, b.channel, b.message ?? null, b.note ?? null);
      await db.query(
        `UPDATE purchase_orders SET status = 'sent', sent_at = now(), sent_via = $2, sent_document_version = $3, confirmation_status = 'awaiting', version = version + 1, updated_at = now()
         WHERE id = $1`,
        [id, b.channel, doc.version],
      );
      await event(db, id, 'sent', auth.userId, b.note ?? null, { channel: b.channel, documentVersion: doc.version, contentHash: doc.hash });
      await audit(db, { actorId: auth.userId, action: 'purchases.sent', entity: 'purchase_order', entityId: id, metadata: { channel: b.channel, documentVersion: doc.version, contentHash: doc.hash }, ip: req.ip });
      return { order: await load(db, id), document: { version: doc.version, text: doc.text } };
    });
  });

  /**
   * D6-5: pagamento INFORMADO ao fornecedor (data, valor, referencia). E um registro administrativo: nao movimenta
   * dinheiro, nao consulta banco nem provedor e nao e confirmacao financeira. Permissao propria (Financeiro), sem a
   * de aprovar. Corrigir e informar de novo (fica no historico).
   */
  app.post('/:id/payment', async (req) => {
    const auth = requirePermission(req, 'purchases.pay');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ paidOn: z.iso.date(), amountCents: money, reference: opt(z.string().trim().max(120)), note: opt(note()) }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const o = await lockOrder(db, id);
      if (!['approved', 'sent', 'partial', 'received'].includes(o.status)) throw new AppError(409, 'INVALID_STATUS', 'Pagamento só é informado para compra aprovada.');
      await db.query(
        `UPDATE purchase_orders SET payment_informed_on = $2, payment_informed_amount_cents = $3, payment_informed_ref = $4, payment_informed_by = $5, payment_informed_at = now(),
           version = version + 1, updated_at = now() WHERE id = $1`,
        [id, b.paidOn, b.amountCents, b.reference ?? null, auth.userId],
      );
      await event(db, id, 'payment_informed', auth.userId, b.note ?? null, { paidOn: b.paidOn, amountCents: b.amountCents, reference: b.reference ?? null, confirmedByProvider: false });
      await audit(db, { actorId: auth.userId, action: 'purchases.payment_informed', entity: 'purchase_order', entityId: id, metadata: { paidOn: b.paidOn, amountCents: b.amountCents }, ip: req.ip });
      return { order: await load(db, id) };
    });
  });

  app.patch('/:id/shipping', async (req) => {
    const auth = requirePermission(req, 'purchases.manage');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ carrier: opt(z.string().trim().max(80)), trackingCode: opt(z.string().trim().max(60)), expectedAt: opt(z.iso.date()) }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const o = await lockOrder(db, id);
      if (!['approved', 'sent', 'partial'].includes(o.status)) throw new AppError(409, 'INVALID_STATUS', 'Transporte só é informado para compra aprovada e ainda não recebida.');
      await db.query(
        `UPDATE purchase_orders SET carrier = $2, tracking_code = $3, expected_at = coalesce($4, expected_at), version = version + 1, updated_at = now() WHERE id = $1`,
        [id, b.carrier || null, b.trackingCode || null, b.expectedAt ?? null],
      );
      await event(db, id, 'shipping_updated', auth.userId, null, { carrier: b.carrier ?? null, trackingCode: b.trackingCode ?? null, expectedAt: b.expectedAt ?? null });
      await audit(db, { actorId: auth.userId, action: 'purchases.shipping', entity: 'purchase_order', entityId: id, metadata: b, ip: req.ip });
      return { order: await load(db, id) };
    });
  });

  app.post('/:id/cancel', async (req) => {
    const auth = requirePermission(req, 'purchases.manage');
    const { id } = idParams.parse(req.params);
    const { reason } = z.strictObject({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const o = await lockOrder(db, id);
      if (!['draft', 'pending_approval', 'approved', 'sent'].includes(o.status)) throw new AppError(409, 'INVALID_STATUS', 'Pedido com recebimento não é cancelado: encerre o saldo pendente.');
      const pending = await pendingLinks(db, id);
      await db.query(`UPDATE purchase_orders SET status = 'canceled', cancel_reason = $2, closed_at = now(), version = version + 1, updated_at = now() WHERE id = $1`, [id, reason]);
      await event(db, id, 'canceled', auth.userId, reason, { pendingOrders: pending });
      await audit(db, { actorId: auth.userId, action: 'purchases.canceled', entity: 'purchase_order', entityId: id, metadata: { reason, pendingOrders: pending }, ip: req.ip });
      return { order: await load(db, id), pendingOrders: pending };
    });
  });

  // Fornecedor entregou menos e nao vai mandar o resto: encerra sem esperar (D6-8: vinculos nao atendidos caem).
  app.post('/:id/close', async (req) => {
    const auth = requirePermission(req, 'purchases.manage');
    const { id } = idParams.parse(req.params);
    const { reason } = z.strictObject({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const o = await lockOrder(db, id);
      if (o.status !== 'partial') throw new AppError(409, 'INVALID_STATUS', 'Só pedido parcialmente recebido pode ser encerrado.');
      const pending = await pendingLinks(db, id);
      await db.query(`UPDATE purchase_orders SET status = 'received', cancel_reason = $2, closed_at = now(), version = version + 1, updated_at = now() WHERE id = $1`, [id, reason]);
      await event(db, id, 'closed_short', auth.userId, reason, { pendingOrders: pending });
      await audit(db, { actorId: auth.userId, action: 'purchases.closed_short', entity: 'purchase_order', entityId: id, metadata: { reason, pendingOrders: pending }, ip: req.ip });
      return { order: await load(db, id), pendingOrders: pending };
    });
  });

  /**
   * Encomendas que podem ser vinculadas a esta compra (D6-2): alocacao ativa "comprar para atender", mesma variante
   * e mesmo deposito, com reserva de encomenda ainda aguardando e quantidade nao vinculada.
   */
  app.get('/:id/link-candidates', async (req) => {
    requirePermission(req, 'purchases.view');
    const { id } = idParams.parse(req.params);
    const { rows } = await pool.query(
      `SELECT i.id AS item_id, a.id AS allocation_id, a.order_id, o.number AS order_number, o.paid_at, a.variant_id, v.sku, p.name AS product_name,
              a.base_qty, (a.base_qty - coalesce((SELECT sum(l.base_qty) FROM purchase_order_links l WHERE l.allocation_id = a.id AND l.status = 'active'), 0))::numeric(14,3) AS unlinked
       FROM purchase_orders po JOIN purchase_order_items i ON i.order_id = po.id
       JOIN fulfillment_allocations a ON a.variant_id = i.variant_id AND a.warehouse_id = po.warehouse_id AND a.status = 'active'
       JOIN fulfillments f ON f.id = a.fulfillment_id AND f.status = 'confirmed' AND f.mode = 'purchase_to_order'
       JOIN orders o ON o.id = a.order_id JOIN product_variants v ON v.id = a.variant_id JOIN products p ON p.id = v.product_id
       WHERE po.id = $1 AND po.status = ANY($2::text[])
         AND EXISTS (SELECT 1 FROM stock_reservations r WHERE r.allocation_id = a.id AND r.status = 'active' AND r.backorder)
         AND a.base_qty > coalesce((SELECT sum(l.base_qty) FROM purchase_order_links l WHERE l.allocation_id = a.id AND l.status = 'active'), 0)
       ORDER BY o.paid_at NULLS LAST, o.number`,
      [id, OPEN],
    );
    return { items: rows };
  });

  /**
   * Vincula uma encomenda a esta compra: prioridade na chegada, sem exclusividade (D6-2). Travas: compra, depois o
   * item e a alocacao (gatilho). Nunca o pedido do cliente (ordem pedido -> alocacao da Fase 5 nao inverte).
   */
  app.post('/:id/links', async (req, reply) => {
    const auth = requirePermission(req, 'purchases.manage');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ itemId: z.uuid(), allocationId: z.uuid(), baseQty: opt(qty) }).parse(req.body);
    const order = await tx(auth.userId, async (db) => {
      const o = await lockOrder(db, id);
      if (!OPEN.includes(o.status)) throw new AppError(409, 'INVALID_STATUS', 'Compra encerrada ou cancelada não recebe vínculo.');
      const a = (
        await db.query<{ order_id: string; free: string; backorder: boolean }>(
          `SELECT a.order_id, (a.base_qty - coalesce((SELECT sum(l.base_qty) FROM purchase_order_links l WHERE l.allocation_id = a.id AND l.status = 'active'), 0))::text AS free,
                  EXISTS (SELECT 1 FROM stock_reservations r WHERE r.allocation_id = a.id AND r.status = 'active' AND r.backorder) AS backorder
           FROM fulfillment_allocations a WHERE a.id = $1`,
          [b.allocationId],
        )
      ).rows[0];
      if (!a) throw notFound();
      if (!a.backorder) throw new AppError(409, 'NOT_BACKORDER', 'A encomenda deste pedido já foi atendida ou liberada.');
      const dup = await db.query(`SELECT 1 FROM purchase_order_links WHERE purchase_order_item_id = $1 AND allocation_id = $2 AND status = 'active'`, [b.itemId, b.allocationId]);
      if (dup.rowCount) throw new AppError(409, 'ALREADY_LINKED', 'Esta encomenda já está vinculada a este item.');
      if (Number(a.free) <= 0) throw new AppError(409, 'LINK_OVER_ALLOCATION', 'Esta encomenda já está toda vinculada a compras.');
      const base = b.baseQty ?? a.free;
      try {
        await db.query(
          `INSERT INTO purchase_order_links (purchase_order_item_id, purchase_order_id, allocation_id, order_id, base_qty, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
          [b.itemId, id, b.allocationId, a.order_id, base, auth.userId],
        );
      } catch (err) {
        const c = (err as { constraint?: string }).constraint;
        if (c === 'purchase_order_links_match') throw new AppError(422, 'LINK_MISMATCH', 'A encomenda é de outro produto ou de outro depósito.');
        if (c === 'purchase_order_links_open') throw new AppError(409, 'LINK_CLOSED', 'Só se vincula compra aberta a encomenda ativa.');
        if (c === 'purchase_order_links_over_item') throw new AppError(409, 'LINK_OVER_ITEM', 'Os vínculos passariam da quantidade comprada.');
        if (c === 'purchase_order_links_over_allocation') throw new AppError(409, 'LINK_OVER_ALLOCATION', 'Os vínculos passariam da quantidade encomendada.');
        if (isUniqueViolation(err, 'purchase_order_links_active')) throw new AppError(409, 'ALREADY_LINKED', 'Esta encomenda já está vinculada a este item.');
        throw err;
      }
      await audit(db, { actorId: auth.userId, action: 'purchases.linked', entity: 'purchase_order', entityId: id, metadata: { ...b, baseQty: base, orderId: a.order_id }, ip: req.ip });
      return load(db, id);
    });
    return reply.code(201).send({ order });
  });

  app.post('/:id/links/:linkId/cancel', async (req) => {
    const auth = requirePermission(req, 'purchases.manage');
    const { id, linkId } = z.object({ id: z.uuid(), linkId: z.uuid() }).parse(req.params);
    const { reason } = z.strictObject({ reason: note() }).parse(req.body);
    return tx(auth.userId, async (db) => {
      await lockOrder(db, id);
      const r = await db.query(
        `UPDATE purchase_order_links SET status = 'canceled', cancel_reason = $3, closed_at = now() WHERE id = $1 AND purchase_order_id = $2 AND status = 'active' RETURNING id`,
        [linkId, id, reason],
      );
      if (!r.rowCount) throw new AppError(409, 'INVALID_STATUS', 'Vínculo inexistente ou já cancelado.');
      await audit(db, { actorId: auth.userId, action: 'purchases.unlinked', entity: 'purchase_order', entityId: id, metadata: { linkId, reason }, ip: req.ip });
      return { order: await load(db, id) };
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Fase 7: documento do pedido, confirmacao do fornecedor, contato e sugestao pelo XML.

  /** Previa do documento (sem gravar). Mostra o que falta para gerar. */
  app.get('/:id/document', async (req) => {
    requirePermission(req, 'purchases.view');
    const { id } = idParams.parse(req.params);
    const { message } = z.object({ message: z.string().trim().max(1000).optional() }).parse(req.query);
    const built = await buildDocument(pool, id, message || null);
    return { document: built.document, text: built.text, missing: built.missing };
  });

  /** Versao enviada, exatamente como foi guardada. */
  app.get('/:id/documents/:version', async (req) => {
    requirePermission(req, 'purchases.view');
    const { id, version } = z.object({ id: z.uuid(), version: z.coerce.number().int().min(1) }).parse(req.params);
    const d = (
      await pool.query(
        `SELECT d.version, d.channel, d.content, d.body_text, d.content_hash, d.note, d.created_at, u.name AS actor_name
         FROM purchase_order_documents d JOIN users u ON u.id = d.actor_id WHERE d.order_id = $1 AND d.version = $2`,
        [id, version],
      )
    ).rows[0];
    if (!d) throw notFound();
    return { document: d };
  });

  /**
   * Reenvio (D7-2): nova versao com o conteudo atual (por exemplo, depois de confirmacao com mudanca). A anterior
   * continua guardada como foi.
   */
  app.post('/:id/documents', async (req, reply) => {
    const auth = requirePermission(req, 'purchases.manage');
    const { id } = idParams.parse(req.params);
    const b = sendSchema.parse(req.body ?? {});
    const result = await tx(auth.userId, async (db) => {
      const o = await lockOrder(db, id);
      if (!['sent', 'partial'].includes(o.status)) throw new AppError(409, 'INVALID_STATUS', 'Só compra enviada e ainda não recebida é reenviada ao fornecedor.');
      const doc = await saveDocument(db, auth.userId, id, b.channel, b.message ?? null, b.note ?? null);
      await db.query(`UPDATE purchase_orders SET sent_via = $2, sent_document_version = $3, version = version + 1, updated_at = now() WHERE id = $1`, [id, b.channel, doc.version]);
      await event(db, id, 'document_resent', auth.userId, b.note ?? null, { channel: b.channel, documentVersion: doc.version, contentHash: doc.hash });
      await audit(db, { actorId: auth.userId, action: 'purchases.document_resent', entity: 'purchase_order', entityId: id, metadata: { channel: b.channel, documentVersion: doc.version, contentHash: doc.hash }, ip: req.ip });
      return { order: await load(db, id), document: { version: doc.version, text: doc.text } };
    });
    return reply.code(201).send(result);
  });

  const confirmationSchema = z.strictObject({
    channel: z.enum(CHANNELS).default('other'),
    supplierRef: opt(z.string().trim().min(1).max(60)),
    promisedAt: opt(z.iso.date()),
    note: opt(note()),
    items: z
      .array(
        z.strictObject({
          itemId: z.uuid(),
          // confirmed: tudo o pendente; partial: parte agora e o resto continua pendente; reduced: o resto e
          // cancelado; refused: nada vem (todo o pendente e cancelado).
          outcome: z.enum(['confirmed', 'partial', 'reduced', 'refused']),
          packs: opt(qty),
          packCostCents: opt(money),
          promisedAt: opt(z.iso.date()),
          restPromisedAt: opt(z.iso.date()),
          note: opt(note()),
        }),
      )
      .min(1)
      .max(200),
  });

  /**
   * Confirmacao do fornecedor (D7-3, D7-4). Cada registro e uma versao (imutavel). Entrega parcial nao libera nada;
   * so reducao e recusa cancelam saldo e desfazem vinculos de encomendas que deixam de caber. Aumento de preco acima
   * da tolerancia fica aguardando aprovacao (purchases.approve, com MFA). Nao mexe em estoque nem em custo medio.
   */
  app.post('/:id/confirmations', async (req, reply) => {
    const auth = requirePermission(req, 'purchases.manage');
    const { id } = idParams.parse(req.params);
    const b = confirmationSchema.parse(req.body);
    const result = await tx(auth.userId, async (db) => {
      const o = await lockOrder(db, id);
      if (!['sent', 'partial'].includes(o.status)) throw new AppError(409, 'INVALID_STATUS', 'Só compra enviada e ainda não recebida recebe confirmação do fornecedor.');
      const r = await registerConfirmation(db, auth.userId, id, b);
      await audit(db, {
        actorId: auth.userId,
        action: r.status === 'pending_approval' ? 'purchases.confirmation_pending' : 'purchases.confirmation',
        entity: 'purchase_order',
        entityId: id,
        metadata: { confirmationId: r.confirmationId, version: r.version, outcome: r.outcome, increaseCents: r.increaseCents, released: r.released, items: r.summary },
        ip: req.ip,
      });
      return { order: await load(db, id), confirmation: { id: r.confirmationId, version: r.version, outcome: r.outcome, status: r.status, increaseCents: r.increaseCents }, released: r.released, closed: r.closed };
    });
    return reply.code(201).send(result);
  });

  /**
   * Aprovacao do aumento de preco (D7-4). A aprovacao nomeia a versao e o valor que a pessoa viu: se a confirmacao
   * mudou (outra versao) ou o valor e outro, recusa. Quem registrou nao aprova; o proprietario pode, com justificativa.
   */
  app.post('/:id/confirmations/:cid/approve', async (req) => {
    const auth = requirePermission(req, 'purchases.approve');
    const { id, cid } = z.object({ id: z.uuid(), cid: z.uuid() }).parse(req.params);
    const b = z.strictObject({ version: z.number().int().min(1), increaseCents: z.number().int().min(0), note: opt(note()) }).parse(req.body);
    return tx(auth.userId, async (db) => {
      await lockOrder(db, id);
      const c = (
        await db.query<{ id: string; version: number; status: string; actor_id: string; price_increase_cents: string }>(
          'SELECT id, version, status, actor_id, price_increase_cents::text FROM purchase_confirmations WHERE id = $1 AND order_id = $2 FOR UPDATE',
          [cid, id],
        )
      ).rows[0];
      if (!c) throw notFound();
      if (c.status !== 'pending_approval') throw new AppError(409, 'INVALID_STATUS', 'Esta confirmação não está aguardando aprovação (já decidida ou substituída por outra).');
      if (c.version !== b.version || Number(c.price_increase_cents) !== b.increaseCents) {
        throw new AppError(409, 'CONFIRMATION_CHANGED', 'A confirmação ou o valor do aumento não é o que você viu. Recarregue antes de aprovar.');
      }
      const own = c.actor_id === auth.userId;
      if (own && auth.role !== 'owner') throw new AppError(403, 'SELF_APPROVAL', 'Quem registrou a confirmação não pode aprovar o aumento. Peça a outra pessoa com a permissão.');
      if (own && !b.note) throw new AppError(422, 'JUSTIFICATION_REQUIRED', 'Proprietário aprovando o próprio registro: informe a justificativa.');
      const items = (
        await db.query(
          `SELECT ci.item_id AS "itemId", i.packaging_label AS label, ci.outcome, ci.confirmed_packs AS "confirmedPacks",
                  ci.ordered_pack_cost_cents AS "fromCents", ci.confirmed_pack_cost_cents AS "toCents"
           FROM purchase_confirmation_items ci JOIN purchase_order_items i ON i.id = ci.item_id
           WHERE ci.confirmation_id = $1 AND ci.confirmed_pack_cost_cents > ci.ordered_pack_cost_cents ORDER BY i.packaging_label`,
          [cid],
        )
      ).rows;
      await db.query(`UPDATE purchase_confirmations SET status = 'applied', decided_by = $2, decided_at = now(), decision_note = $3, decision_self = $4 WHERE id = $1`, [
        cid,
        auth.userId,
        b.note ?? null,
        own,
      ]);
      const data = { confirmationId: cid, version: c.version, increaseCents: b.increaseCents, items, self: own };
      await event(db, id, 'confirmation_approved', auth.userId, b.note ?? null, data);
      const applied = await applyConfirmation(db, auth.userId, id, cid);
      await audit(db, { actorId: auth.userId, action: own ? 'purchases.confirmation_approved_self' : 'purchases.confirmation_approved', entity: 'purchase_order', entityId: id, metadata: { ...data, released: applied.released }, ip: req.ip });
      return { order: await load(db, id), released: applied.released, closed: applied.closed };
    });
  });

  /** Aumento recusado: nada e aplicado; a compra volta a aguardar a confirmacao (ou fica com a anterior aplicada). */
  app.post('/:id/confirmations/:cid/reject', async (req) => {
    const auth = requirePermission(req, 'purchases.approve');
    const { id, cid } = z.object({ id: z.uuid(), cid: z.uuid() }).parse(req.params);
    const { reason } = z.strictObject({ reason: note() }).parse(req.body);
    return tx(auth.userId, async (db) => {
      await lockOrder(db, id);
      const c = (await db.query<{ version: number; status: string }>('SELECT version, status FROM purchase_confirmations WHERE id = $1 AND order_id = $2 FOR UPDATE', [cid, id])).rows[0];
      if (!c) throw notFound();
      if (c.status !== 'pending_approval') throw new AppError(409, 'INVALID_STATUS', 'Esta confirmação não está aguardando aprovação.');
      await db.query(`UPDATE purchase_confirmations SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [cid, auth.userId, reason]);
      const prior = (
        await db.query<{ outcome: string }>(`SELECT outcome FROM purchase_confirmations WHERE order_id = $1 AND status = 'applied' ORDER BY version DESC LIMIT 1`, [id])
      ).rows[0];
      await db.query(`UPDATE purchase_orders SET confirmation_status = $2, version = version + 1, updated_at = now() WHERE id = $1`, [id, prior?.outcome ?? 'awaiting']);
      await event(db, id, 'confirmation_rejected', auth.userId, reason, { confirmationId: cid, version: c.version });
      await audit(db, { actorId: auth.userId, action: 'purchases.confirmation_rejected', entity: 'purchase_order', entityId: id, metadata: { confirmationId: cid, version: c.version, reason }, ip: req.ip });
      return { order: await load(db, id) };
    });
  });

  /** Contato de acompanhamento com o fornecedor (cobranca de confirmacao ou prazo) e o proximo retorno. */
  app.post('/:id/followup', async (req) => {
    const auth = requirePermission(req, 'purchases.manage');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ note: note(), channel: z.enum(CHANNELS).default('other'), followupOn: opt(z.iso.date()) }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const o = await lockOrder(db, id);
      if (!['sent', 'partial'].includes(o.status)) throw new AppError(409, 'INVALID_STATUS', 'Só compra enviada e ainda não recebida tem acompanhamento.');
      await db.query(`UPDATE purchase_orders SET followup_on = $2, version = version + 1, updated_at = now() WHERE id = $1`, [id, b.followupOn ?? null]);
      await event(db, id, 'followup', auth.userId, b.note, { channel: b.channel, followupOn: b.followupOn ?? null });
      await audit(db, { actorId: auth.userId, action: 'purchases.followup', entity: 'purchase_order', entityId: id, metadata: b, ip: req.ip });
      return { order: await load(db, id) };
    });
  });

  /**
   * Sugestao do recebimento pelo XML da nota vinculada (D7-10): quantidades e custos para a pessoa conferir. Nao
   * grava nada; o recebimento continua pelo POST /:id/receipts, com as mesmas verificacoes de preco e quantidade.
   */
  app.get('/:id/receipt-suggestions', async (req) => {
    requireAnyPermission(req, 'purchases.receive', 'purchases.manage');
    const { id } = idParams.parse(req.params);
    const { invoiceId } = z.object({ invoiceId: z.uuid() }).parse(req.query);
    const inv = (await pool.query('SELECT * FROM purchase_invoices WHERE id = $1', [invoiceId])).rows[0];
    if (!inv) throw notFound();
    if (inv.purchase_order_id !== id) throw new AppError(422, 'INVOICE_NOT_LINKED', 'Esta nota não está vinculada a esta compra. Vincule a nota em Notas de compra antes.');
    const conf = await conference(pool, inv);
    const items = conf.items
      .filter((i) => i.order)
      .map((i) => {
        const pending = Number(i.order!.pendingPacks);
        const packs = Math.min(Number(i.qty), pending);
        return {
          itemId: i.order!.itemId,
          label: i.match!.label,
          invoiceQty: String(i.qty),
          pendingPacks: String(pending),
          packs: String(Math.max(packs, 0)),
          invoicedPackCostCents: Math.round(Number(i.unitValue) * 100),
          orderedPackCostCents: Number(i.order!.packCostCents),
          divergences: i.divergences,
        };
      })
      .filter((i) => Number(i.pendingPacks) > 0);
    const unmatched = conf.items.filter((i) => !i.order).map((i) => ({ description: i.description, code: i.code, qty: String(i.qty), divergences: i.divergences }));
    return {
      invoiceRef: `${inv.series}/${inv.number}`,
      warnings: conf.warnings,
      items,
      unmatched,
      missingFromInvoice: conf.missingFromInvoice,
      note: 'Sugestão a partir do XML: confira a mercadoria antes de confirmar o recebimento.',
    };
  });

  /**
   * Recebimento (total ou parcial). Da entrada no estoque com o custo efetivo por unidade base:
   * custo da embalagem (o da nota, quando informado: D6-12) + parte do frete e das despesas, rateados pelo valor dos
   * itens. Cada recebimento leva a parte proporcional ao que chegou, entao o frete inteiro so entra uma vez.
   * A chave de requisicao impede entrada dupla quando a tela reenvia.
   *
   * Fase 6: so no destino da compra (D6-6). Entra tudo o que chegou fisicamente; o recusado sai na mesma transacao
   * para bloqueado ou avariado (D6-7), nunca fica disponivel. Depois converte as encomendas pela fila (D6-9), na
   * mesma transacao. Travas: compra, variantes (em ordem), reservas. Nunca o pedido do cliente.
   */
  app.post('/:id/receipts', async (req, reply) => {
    const auth = requirePermission(req, 'purchases.receive');
    const { id } = idParams.parse(req.params);
    const b = receiptSchema.parse(req.body);
    const replay = async () => {
      const r = (await pool.query<{ order_id: string }>('SELECT order_id FROM purchase_receipts WHERE request_key = $1', [b.requestKey])).rows[0];
      if (r && r.order_id !== id) throw new AppError(409, 'REQUEST_KEY_REUSED', 'Chave de requisição já usada em outro recebimento.');
      return r;
    };
    if (await replay()) return reply.code(200).send({ order: await load(pool, id), replayed: true });
    try {
      const result = await tx(auth.userId, async (db) => {
        const o = await lockOrder(db, id);
        if (!['sent', 'partial'].includes(o.status)) {
          throw new AppError(409, 'INVALID_STATUS', ['draft', 'pending_approval', 'approved'].includes(o.status) ? 'Marque o pedido como enviado antes de receber.' : 'Pedido encerrado ou cancelado.');
        }
        // Fase 7 (D7-4): aumento de preco do fornecedor aguardando aprovacao trava o recebimento.
        if (o.confirmation_status === 'pending_approval') {
          throw new AppError(409, 'CONFIRMATION_APPROVAL_PENDING', 'A confirmação do fornecedor tem aumento de preço aguardando aprovação. Aprove ou recuse antes de receber.');
        }
        if (b.warehouseId && b.warehouseId !== o.warehouse_id) {
          throw new AppError(409, 'WRONG_WAREHOUSE', 'O recebimento é no depósito de destino da compra. Receba no destino e transfira depois, ou corrija o destino antes do primeiro recebimento.');
        }
        const wh = await activeWarehouse(db, o.warehouse_id);
        const tolerance = Number((await purchaseSettings(db)).purchase_price_tolerance_pct);
        const seen = new Set<string>();
        for (const it of b.items) {
          if (seen.has(it.itemId)) throw new AppError(422, 'DUPLICATE_ITEM', 'Item repetido no recebimento.');
          seen.add(it.itemId);
        }
        const variants = (await db.query<{ id: string; variant_id: string }>('SELECT id, variant_id FROM purchase_order_items WHERE order_id = $1 AND id = ANY($2::uuid[])', [id, [...seen]])).rows;
        if (variants.length !== seen.size) throw new AppError(422, 'INVALID_ITEM', 'Item não pertence a este pedido.');
        for (const x of b.issues) if (!(await db.query('SELECT 1 FROM purchase_order_items WHERE id = $1 AND order_id = $2', [x.itemId, id])).rowCount) throw new AppError(422, 'INVALID_ITEM', 'Item não pertence a este pedido.');
        await lockVariants(db, variants.map((v) => v.variant_id));
        const receipt = (
          await db.query<{ id: string }>(
            'INSERT INTO purchase_receipts (order_id, request_key, invoice_ref, notes, received_by, warehouse_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [id, b.requestKey, b.invoiceRef ?? null, b.notes ?? null, auth.userId, wh.id],
          )
        ).rows[0]!;
        const issue = (itemId: string, kind: string, f: { expected?: number | string | null; found?: number | string | null; qty?: string | null; destination?: string | null; note: string }) =>
          db.query('INSERT INTO purchase_receipt_issues (receipt_id, item_id, kind, expected, found, qty, destination, note, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
            receipt.id,
            itemId,
            kind,
            f.expected ?? null,
            f.found ?? null,
            f.qty ?? null,
            f.destination ?? null,
            f.note,
            auth.userId,
          ]);
        const touched = new Set<string>();
        for (const it of b.items) {
          const line = (
            await db.query<{ variant_id: string; over: boolean; base_qty: string; rejected_base: string; unit_cost: string; extra: string; pack_cost: string; reject_over: boolean }>(
              `WITH tot AS (
                 SELECT sum((packs - canceled_packs) * pack_cost_cents) AS goods, sum((packs - canceled_packs) * base_qty_per_pack) AS qty FROM purchase_order_items WHERE order_id = $1
               ), calc AS (
                 SELECT i.variant_id, i.received_packs + i.canceled_packs + $3::numeric > i.packs AS over, i.pack_cost_cents,
                        ($3::numeric * i.base_qty_per_pack) AS base_qty,
                        ($6::numeric * i.base_qty_per_pack) AS rejected_base,
                        $6::numeric > $3::numeric AS reject_over,
                        ($3::numeric * coalesce($5::numeric, i.pack_cost_cents)) AS goods_line,
                        CASE WHEN tot.goods > 0 THEN ($4::numeric * $3::numeric * i.pack_cost_cents / tot.goods)
                             WHEN tot.qty > 0 THEN ($4::numeric * $3::numeric * i.base_qty_per_pack / tot.qty)
                             ELSE 0 END AS extra
                 FROM purchase_order_items i, tot WHERE i.id = $2 AND i.order_id = $1
               )
               SELECT variant_id, over, reject_over, pack_cost_cents::text AS pack_cost, base_qty::numeric(14,3)::text AS base_qty, rejected_base::numeric(14,3)::text AS rejected_base,
                      round((goods_line + extra) / base_qty, 4)::text AS unit_cost, round(extra, 4)::text AS extra FROM calc`,
              [id, it.itemId, it.packs, Number(o.freight_cents) + Number(o.other_costs_cents), it.invoicedPackCostCents ?? null, it.rejectedPacks ?? '0'],
            )
          ).rows[0];
          if (!line) throw new AppError(422, 'INVALID_ITEM', 'Item não pertence a este pedido.');
          if (line.over) throw new AppError(409, 'OVER_RECEIPT', 'Quantidade recebida maior que o saldo pendente do item. Registre o excedente em outro pedido.');
          const info = await variantInfo(db, line.variant_id);
          assertWhole(info, line.base_qty);
          const rejected = Number(line.rejected_base) > 0;
          if (line.reject_over) throw new AppError(422, 'REJECT_OVER', 'A quantidade recusada não pode passar da recebida.');
          if (rejected) {
            assertWhole(info, line.rejected_base);
            if (!it.rejectedDestination || !it.rejectedReason) throw new AppError(422, 'REJECT_DETAILS_REQUIRED', 'Para recusar, informe o destino (bloqueado ou avariado) e o motivo.');
          }
          // D6-12: preco da nota x pedido. Acima da tolerancia, justificativa e divergencia de preco.
          if (it.invoicedPackCostCents != null) {
            const ordered = Number(line.pack_cost);
            const diffPct = ordered > 0 ? (Math.abs(it.invoicedPackCostCents - ordered) / ordered) * 100 : it.invoicedPackCostCents > 0 ? Infinity : 0;
            if (diffPct > tolerance + 1e-9) {
              if (!it.priceJustification) {
                throw new AppError(422, 'PRICE_JUSTIFICATION_REQUIRED', `Custo da nota diferente do pedido acima da tolerância de ${tolerance}%. Informe a justificativa.`, {
                  itemId: it.itemId,
                  orderedCents: ordered,
                  invoicedCents: it.invoicedPackCostCents,
                  tolerancePct: tolerance,
                });
              }
              await issue(it.itemId, 'price', { expected: ordered, found: it.invoicedPackCostCents, note: it.priceJustification });
            }
          }
          await db.query('UPDATE purchase_order_items SET received_packs = received_packs + $2::numeric, rejected_packs = rejected_packs + $3::numeric WHERE id = $1', [
            it.itemId,
            it.packs,
            it.rejectedPacks ?? '0',
          ]);
          await db.query(
            `INSERT INTO purchase_receipt_items (receipt_id, item_id, packs, base_qty, unit_cost_cents, allocated_extra_cents, rejected_packs, rejected_base_qty, rejected_destination, invoiced_pack_cost_cents)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [receipt.id, it.itemId, it.packs, line.base_qty, line.unit_cost, line.extra, it.rejectedPacks ?? '0', line.rejected_base, rejected ? it.rejectedDestination : null, it.invoicedPackCostCents ?? null],
          );
          await moveStock(db, auth.userId, {
            variantId: line.variant_id,
            kind: 'receipt',
            onHandDelta: line.base_qty,
            unitCostCents: line.unit_cost,
            warehouseId: wh.id,
            sourceType: 'purchase_receipt',
            sourceId: receipt.id,
          });
          if (rejected) {
            const damaged = it.rejectedDestination === 'damaged';
            await moveStock(db, auth.userId, {
              variantId: line.variant_id,
              kind: damaged ? 'damage_hold' : 'block',
              onHandDelta: `-${line.rejected_base}`,
              ...(damaged ? { damagedDelta: line.rejected_base } : { blockedDelta: line.rejected_base }),
              reason: `Recusado no recebimento: ${it.rejectedReason}`,
              warehouseId: wh.id,
              sourceType: 'purchase_receipt',
              sourceId: receipt.id,
              skipShortageCheck: true,
            });
            await issue(it.itemId, 'quality', { qty: line.rejected_base, destination: it.rejectedDestination, note: it.rejectedReason! });
          }
          touched.add(line.variant_id);
        }
        for (const x of b.issues) await issue(x.itemId, x.kind, { expected: x.expected ?? null, found: x.found ?? null, note: x.note });
        // Conversao das encomendas pela fila, na mesma transacao (variantes ja travadas, em ordem).
        const conversions: (PlanResult & { variantId: string })[] = [];
        for (const variantId of [...touched].sort()) {
          const plan = await convertOnReceipt(db, auth.userId, { warehouseId: wh.id, variantId, receiptId: receipt.id, purchaseOrderId: id });
          conversions.push({ ...plan, variantId });
        }
        const done = (await db.query<{ done: boolean }>('SELECT bool_and(received_packs + canceled_packs >= packs) AS done FROM purchase_order_items WHERE order_id = $1', [id])).rows[0]!.done;
        await db.query(
          `UPDATE purchase_orders SET status = $2, closed_at = CASE WHEN $2 = 'received' THEN now() END, version = version + 1, updated_at = now() WHERE id = $1`,
          [id, done ? 'received' : 'partial'],
        );
        const converted = conversions.flatMap((c) => c.converted.map((x) => ({ orderNumber: x.orderNumber, qty: x.qty, rule: x.rule })));
        await audit(db, {
          actorId: auth.userId,
          action: 'purchases.received',
          entity: 'purchase_order',
          entityId: id,
          after: { receiptId: receipt.id, items: b.items, invoiceRef: b.invoiceRef, warehouseId: wh.id, issues: b.issues, converted },
          ip: req.ip,
        });
        return { order: await load(db, id), conversions };
      });
      return reply.code(201).send(result);
    } catch (err) {
      if (isUniqueViolation(err, 'purchase_receipts_request_key_key') && (await replay())) return reply.code(200).send({ order: await load(pool, id), replayed: true });
      throw err;
    }
  });
}

