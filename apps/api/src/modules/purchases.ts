import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation, pageQuery } from '../lib/http.js';
import { assertWhole, moveStock, qty, variantInfo } from '../lib/stock.js';
import { requirePermission } from './auth.js';

const opt = <T extends z.ZodType>(s: T) => s.nullable().optional();
const money = z.number().int().min(0).max(1_000_000_000);

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
  invoiceRef: opt(z.string().trim().max(60)),
  notes: opt(z.string().trim().max(1000)),
  items: z.array(z.strictObject({ itemId: z.uuid(), packs: qty })).min(1).max(200),
});

const ORDER_COLS = `o.id, o.number, o.supplier_id, s.name AS supplier_name, o.status, o.expected_at::text AS expected_at, o.freight_cents, o.other_costs_cents, o.notes,
  o.created_at, o.sent_at, o.closed_at, o.cancel_reason, o.version, u.name AS created_by_name,
  (SELECT coalesce(sum(round(i.packs * i.pack_cost_cents)), 0)::bigint FROM purchase_order_items i WHERE i.order_id = o.id) AS goods_cents`;

async function load(db: Db | typeof pool, id: string) {
  const order = (await db.query(`SELECT ${ORDER_COLS} FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id JOIN users u ON u.id = o.created_by WHERE o.id = $1`, [id])).rows[0];
  if (!order) return null;
  order.items = (
    await db.query(
      `SELECT i.id, i.variant_id, i.packaging_id, i.packaging_label, i.base_qty_per_pack, i.packs, i.pack_cost_cents, i.received_packs,
              i.min_order_packs, i.order_multiple_packs, i.min_exception_reason, v.sku, p.name AS product_name, p.base_unit, (i.packs * i.base_qty_per_pack)::numeric(14,3) AS base_qty,
              round(i.pack_cost_cents / i.base_qty_per_pack, 4) AS unit_cost_cents
       FROM purchase_order_items i JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
       WHERE i.order_id = $1 ORDER BY p.name, v.sku, i.base_qty_per_pack`,
      [id],
    )
  ).rows;
  order.receipts = (
    await db.query(
      `SELECT r.id, r.invoice_ref, r.notes, r.received_at, u.name AS received_by_name,
              coalesce(json_agg(json_build_object('itemId', ri.item_id, 'packs', ri.packs, 'baseQty', ri.base_qty, 'unitCostCents', ri.unit_cost_cents,
                'allocatedExtraCents', ri.allocated_extra_cents) ORDER BY ri.item_id), '[]') AS items
       FROM purchase_receipts r JOIN users u ON u.id = r.received_by LEFT JOIN purchase_receipt_items ri ON ri.receipt_id = r.id
       WHERE r.order_id = $1 GROUP BY r.id, u.name ORDER BY r.received_at`,
      [id],
    )
  ).rows;
  return order;
}

type MinException = { packagingId: string; label: string; packs: string; minOrderPacks: string | null; orderMultiplePacks: string | null; reason: string | null };

/**
 * Valida as embalagens, copia rotulo e conversao e preenche o custo com a lista do fornecedor. Copia tambem o minimo e
 * o multiplo da oferta ativa: abaixo do minimo ou fora do multiplo so passa com justificativa (422 BELOW_MINIMUM com a
 * lista, para a tela pedir); a justificativa fica no item e na auditoria. Devolve as excecoes aceitas.
 */
async function saveItems(db: Db, orderId: string, supplierId: string, items: OrderInput['items']): Promise<MinException[]> {
  const seen = new Set<string>();
  const exceptions: MinException[] = [];
  await db.query('DELETE FROM purchase_order_items WHERE order_id = $1', [orderId]);
  for (const it of items) {
    if (seen.has(it.packagingId)) throw new AppError(422, 'DUPLICATE_ITEM', 'A mesma embalagem aparece duas vezes no pedido.');
    seen.add(it.packagingId);
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
    const base = (await db.query<{ q: string }>('SELECT ($1::numeric * $2::numeric)::numeric(14,3)::text AS q', [it.packs, k.base_qty])).rows[0]!.q;
    assertWhole(info, base);
    const exception = k.below || k.off_multiple;
    if (exception) exceptions.push({ packagingId: it.packagingId, label: k.label, packs: String(it.packs), minOrderPacks: k.min_packs, orderMultiplePacks: k.multiple, reason: it.minExceptionReason ?? null });
    await db.query(
      `INSERT INTO purchase_order_items (order_id, variant_id, packaging_id, packaging_label, base_qty_per_pack, packs, pack_cost_cents, min_order_packs,
         order_multiple_packs, min_exception_reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [orderId, k.variant_id, it.packagingId, k.label, k.base_qty, it.packs, cost, k.min_packs, k.multiple, exception ? (it.minExceptionReason ?? null) : null],
    );
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

async function lockOrder(db: Db, id: string) {
  const o = (await db.query<{ id: string; status: string; supplier_id: string; version: number; freight_cents: string; other_costs_cents: string }>(
    'SELECT id, status, supplier_id, version, freight_cents, other_costs_cents FROM purchase_orders WHERE id = $1 FOR UPDATE',
    [id],
  )).rows[0];
  if (!o) throw notFound();
  return o;
}

export async function purchaseRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    requirePermission(req, 'purchases.view');
    const q = pageQuery.extend({ status: z.enum(['draft', 'sent', 'partial', 'received', 'canceled', 'open']).optional(), supplierId: z.uuid().optional() }).parse(req.query);
    const statuses = q.status === 'open' ? ['draft', 'sent', 'partial'] : q.status ? [q.status] : null;
    const params = [statuses, q.supplierId ?? null];
    const where = '($1::text[] IS NULL OR o.status = ANY($1)) AND ($2::uuid IS NULL OR o.supplier_id = $2)';
    const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM purchase_orders o WHERE ${where}`, params)).rows[0]!.n;
    const { rows } = await pool.query(
      `SELECT ${ORDER_COLS}, (SELECT count(*)::int FROM purchase_order_items i WHERE i.order_id = o.id) AS item_count
       FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id JOIN users u ON u.id = o.created_by
       WHERE ${where} ORDER BY o.number DESC LIMIT $3 OFFSET $4`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { items: rows, total, page: q.page, pageSize: q.pageSize };
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
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO purchase_orders (supplier_id, expected_at, freight_cents, other_costs_cents, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [b.supplierId, b.expectedAt ?? null, b.freightCents, b.otherCostsCents, b.notes ?? null, auth.userId],
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

  // Editavel ate o primeiro recebimento. Depois disso o custo ja entrou no estoque.
  app.put('/:id', async (req) => {
    const auth = requirePermission(req, 'purchases.manage');
    const { id } = idParams.parse(req.params);
    const b = orderSchema.parse(req.body);
    const order = await tx(auth.userId, async (db) => {
      const o = await lockOrder(db, id);
      if (!['draft', 'sent'].includes(o.status)) throw new AppError(409, 'ORDER_LOCKED', 'Pedido com recebimento, encerrado ou cancelado não pode ser alterado.');
      if (b.version !== undefined && b.version !== o.version) throw new AppError(409, 'VERSION_CONFLICT', 'Outra pessoa alterou este pedido. Recarregue para ver a versão atual.');
      if (b.supplierId !== o.supplier_id && o.status !== 'draft') throw new AppError(409, 'ORDER_LOCKED', 'Pedido já enviado não muda de fornecedor.');
      if (b.supplierId !== o.supplier_id) {
        // Trocar o rascunho para um fornecedor bloqueado seria o mesmo que criar pedido novo para ele.
        const st = (await db.query<{ status: string }>('SELECT status FROM suppliers WHERE id = $1', [b.supplierId])).rows[0];
        if (st?.status === 'blocked') throw new AppError(422, 'SUPPLIER_BLOCKED', 'Fornecedor bloqueado: não recebe pedido de compra novo.');
      }
      const before = await load(db, id);
      await db.query(
        `UPDATE purchase_orders SET supplier_id = $2, expected_at = $3, freight_cents = $4, other_costs_cents = $5, notes = $6, version = version + 1, updated_at = now() WHERE id = $1`,
        [id, b.supplierId, b.expectedAt ?? null, b.freightCents, b.otherCostsCents, b.notes ?? null],
      );
      const exceptions = await saveItems(db, id, b.supplierId, b.items);
      const after = await load(db, id);
      await audit(db, { actorId: auth.userId, action: 'purchases.updated', entity: 'purchase_order', entityId: id, before, after, ip: req.ip });
      await auditExceptions(db, auth.userId, id, exceptions, req.ip);
      return after;
    });
    return { order };
  });

  app.post('/:id/send', async (req) => {
    const auth = requirePermission(req, 'purchases.manage');
    const { id } = idParams.parse(req.params);
    return tx(auth.userId, async (db) => {
      const o = await lockOrder(db, id);
      if (o.status !== 'draft') throw new AppError(409, 'INVALID_STATUS', 'Só rascunho pode ser marcado como enviado.');
      // Fornecedor bloqueado: o rascunho nao e enviado (o ja enviado continua podendo ser recebido).
      const st = (await db.query<{ status: string; blocked_reason: string | null }>('SELECT status, blocked_reason FROM suppliers WHERE id = $1', [o.supplier_id])).rows[0];
      if (st?.status === 'blocked') throw new AppError(409, 'SUPPLIER_BLOCKED', `Fornecedor bloqueado${st.blocked_reason ? `: ${st.blocked_reason}` : ''}. O rascunho não pode ser enviado.`);
      await db.query(`UPDATE purchase_orders SET status = 'sent', sent_at = now(), version = version + 1, updated_at = now() WHERE id = $1`, [id]);
      await audit(db, { actorId: auth.userId, action: 'purchases.sent', entity: 'purchase_order', entityId: id, ip: req.ip });
      return { order: await load(db, id) };
    });
  });

  app.post('/:id/cancel', async (req) => {
    const auth = requirePermission(req, 'purchases.manage');
    const { id } = idParams.parse(req.params);
    const { reason } = z.strictObject({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const o = await lockOrder(db, id);
      if (!['draft', 'sent'].includes(o.status)) throw new AppError(409, 'INVALID_STATUS', 'Pedido com recebimento não é cancelado: encerre o saldo pendente.');
      await db.query(`UPDATE purchase_orders SET status = 'canceled', cancel_reason = $2, closed_at = now(), version = version + 1, updated_at = now() WHERE id = $1`, [id, reason]);
      await audit(db, { actorId: auth.userId, action: 'purchases.canceled', entity: 'purchase_order', entityId: id, metadata: { reason }, ip: req.ip });
      return { order: await load(db, id) };
    });
  });

  // Fornecedor entregou menos e nao vai mandar o resto: encerra sem esperar.
  app.post('/:id/close', async (req) => {
    const auth = requirePermission(req, 'purchases.manage');
    const { id } = idParams.parse(req.params);
    const { reason } = z.strictObject({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const o = await lockOrder(db, id);
      if (o.status !== 'partial') throw new AppError(409, 'INVALID_STATUS', 'Só pedido parcialmente recebido pode ser encerrado.');
      await db.query(`UPDATE purchase_orders SET status = 'received', cancel_reason = $2, closed_at = now(), version = version + 1, updated_at = now() WHERE id = $1`, [id, reason]);
      await audit(db, { actorId: auth.userId, action: 'purchases.closed_short', entity: 'purchase_order', entityId: id, metadata: { reason }, ip: req.ip });
      return { order: await load(db, id) };
    });
  });

  /**
   * Recebimento (total ou parcial). Da entrada no estoque com o custo efetivo por unidade base:
   * custo da embalagem + parte do frete e das despesas, rateados pelo valor dos itens. Cada
   * recebimento leva a parte proporcional ao que chegou, entao o frete inteiro so entra uma vez.
   * A chave de requisicao impede entrada dupla quando a tela reenvia.
   */
  app.post('/:id/receipts', async (req, reply) => {
    const auth = requirePermission(req, 'purchases.manage');
    const { id } = idParams.parse(req.params);
    const b = receiptSchema.parse(req.body);
    const replay = async () => {
      const r = (await pool.query<{ order_id: string }>('SELECT order_id FROM purchase_receipts WHERE request_key = $1', [b.requestKey])).rows[0];
      if (r && r.order_id !== id) throw new AppError(409, 'REQUEST_KEY_REUSED', 'Chave de requisição já usada em outro recebimento.');
      return r;
    };
    if (await replay()) return reply.code(200).send({ order: await load(pool, id), replayed: true });
    try {
      const order = await tx(auth.userId, async (db) => {
        const o = await lockOrder(db, id);
        if (!['sent', 'partial'].includes(o.status)) throw new AppError(409, 'INVALID_STATUS', o.status === 'draft' ? 'Marque o pedido como enviado antes de receber.' : 'Pedido encerrado ou cancelado.');
        const receipt = (
          await db.query<{ id: string }>(
            'INSERT INTO purchase_receipts (order_id, request_key, invoice_ref, notes, received_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [id, b.requestKey, b.invoiceRef ?? null, b.notes ?? null, auth.userId],
          )
        ).rows[0]!;
        const seen = new Set<string>();
        for (const it of b.items) {
          if (seen.has(it.itemId)) throw new AppError(422, 'DUPLICATE_ITEM', 'Item repetido no recebimento.');
          seen.add(it.itemId);
          const line = (
            await db.query<{ variant_id: string; over: boolean; base_qty: string; unit_cost: string; extra: string }>(
              `WITH tot AS (
                 SELECT sum(packs * pack_cost_cents) AS goods, sum(packs * base_qty_per_pack) AS qty FROM purchase_order_items WHERE order_id = $1
               ), calc AS (
                 SELECT i.variant_id, i.received_packs + $3::numeric > i.packs AS over,
                        ($3::numeric * i.base_qty_per_pack) AS base_qty,
                        ($3::numeric * i.pack_cost_cents) AS goods_line,
                        CASE WHEN tot.goods > 0 THEN ($4::numeric * $3::numeric * i.pack_cost_cents / tot.goods)
                             ELSE ($4::numeric * $3::numeric * i.base_qty_per_pack / tot.qty) END AS extra
                 FROM purchase_order_items i, tot WHERE i.id = $2 AND i.order_id = $1
               )
               SELECT variant_id, over, base_qty::numeric(14,3)::text AS base_qty, round((goods_line + extra) / base_qty, 4)::text AS unit_cost, round(extra, 4)::text AS extra FROM calc`,
              [id, it.itemId, it.packs, Number(o.freight_cents) + Number(o.other_costs_cents)],
            )
          ).rows[0];
          if (!line) throw new AppError(422, 'INVALID_ITEM', 'Item não pertence a este pedido.');
          if (line.over) throw new AppError(409, 'OVER_RECEIPT', 'Quantidade recebida maior que o saldo pendente do item. Registre o excedente em outro pedido.');
          assertWhole(await variantInfo(db, line.variant_id), line.base_qty);
          await db.query('UPDATE purchase_order_items SET received_packs = received_packs + $2::numeric WHERE id = $1', [it.itemId, it.packs]);
          await db.query(
            'INSERT INTO purchase_receipt_items (receipt_id, item_id, packs, base_qty, unit_cost_cents, allocated_extra_cents) VALUES ($1, $2, $3, $4, $5, $6)',
            [receipt.id, it.itemId, it.packs, line.base_qty, line.unit_cost, line.extra],
          );
          await moveStock(db, auth.userId, { variantId: line.variant_id, kind: 'receipt', onHandDelta: line.base_qty, unitCostCents: line.unit_cost, sourceType: 'purchase_receipt', sourceId: receipt.id });
        }
        const done = (await db.query<{ done: boolean }>('SELECT bool_and(received_packs >= packs) AS done FROM purchase_order_items WHERE order_id = $1', [id])).rows[0]!.done;
        await db.query(
          `UPDATE purchase_orders SET status = $2, closed_at = CASE WHEN $2 = 'received' THEN now() END, version = version + 1, updated_at = now() WHERE id = $1`,
          [id, done ? 'received' : 'partial'],
        );
        await audit(db, { actorId: auth.userId, action: 'purchases.received', entity: 'purchase_order', entityId: id, after: { receiptId: receipt.id, items: b.items, invoiceRef: b.invoiceRef }, ip: req.ip });
        return load(db, id);
      });
      return reply.code(201).send({ order });
    } catch (err) {
      if (isUniqueViolation(err, 'purchase_receipts_request_key_key') && (await replay())) return reply.code(200).send({ order: await load(pool, id), replayed: true });
      throw err;
    }
  });
}
