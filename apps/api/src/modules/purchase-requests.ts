// SGLog Fase 7 (D7-6, D7-7): requisicoes internas de compra. A requisicao nao reserva nem movimenta estoque e nao
// vira compra sozinha: quem compra consolida as abertas num rascunho (novo ou existente) pelo caminho normal da
// compra (aprovacao, envio e recebimento da Fase 6). A requisicao de encomenda vira vinculo da Fase 6 ao consolidar.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation, pageQuery } from '../lib/http.js';
import { activeWarehouse, assertWhole, qty, variantInfo } from '../lib/stock.js';
import { syncBackorderRequests } from '../lib/supply.js';
import { requireAnyPermission, requirePermission } from './auth.js';
import { saveItems } from './purchases.js';

const opt = <T extends z.ZodType>(s: T) => s.nullable().optional();
const note = z.string().trim().min(3).max(500);

const COLS = `q.id, q.number, q.source, q.status, q.variant_id, v.sku, p.name AS product_name, p.base_unit, q.packaging_id, k.label AS packaging_label,
  q.warehouse_id, w.name AS warehouse_name, q.base_qty, q.reason, q.needed_by::text AS needed_by, q.allocation_id, q.order_id, o.number AS order_number,
  q.purchase_order_id, po.number AS purchase_order_number, q.purchase_order_item_id, q.decision_note, q.requested_by, ur.name AS requested_by_name,
  q.decided_by, ud.name AS decided_by_name, q.created_at, q.updated_at,
  (current_date - q.created_at::date) AS age_days,
  sp.supplier_id AS suggested_supplier_id, s.name AS suggested_supplier_name`;
// Pedido do cliente: so o numero (D7: nada de dado pessoal do cliente nas telas de compra).
const FROM = `purchase_requests q JOIN product_variants v ON v.id = q.variant_id JOIN products p ON p.id = v.product_id JOIN warehouses w ON w.id = q.warehouse_id
  LEFT JOIN packagings k ON k.id = q.packaging_id LEFT JOIN orders o ON o.id = q.order_id LEFT JOIN purchase_orders po ON po.id = q.purchase_order_id
  LEFT JOIN users ur ON ur.id = q.requested_by LEFT JOIN users ud ON ud.id = q.decided_by
  LEFT JOIN supplier_products sp ON sp.variant_id = q.variant_id AND sp.is_primary LEFT JOIN suppliers s ON s.id = sp.supplier_id`;

async function load(db: Db | typeof pool, id: string) {
  const r = (await db.query(`SELECT ${COLS} FROM ${FROM} WHERE q.id = $1`, [id])).rows[0];
  if (!r) return null;
  r.events = (
    await db.query(
      `SELECT e.id, e.kind, e.note, e.purchase_order_id, po.number AS purchase_order_number, e.created_at, u.name AS actor_name
       FROM purchase_request_events e LEFT JOIN users u ON u.id = e.actor_id LEFT JOIN purchase_orders po ON po.id = e.purchase_order_id
       WHERE e.request_id = $1 ORDER BY e.id`,
      [id],
    )
  ).rows;
  return r;
}

async function event(db: Db, requestId: string, kind: string, actorId: string | null, eventNote: string | null, purchaseOrderId: string | null = null) {
  await db.query('INSERT INTO purchase_request_events (request_id, kind, note, purchase_order_id, actor_id) VALUES ($1, $2, $3, $4, $5)', [requestId, kind, eventNote, purchaseOrderId, actorId]);
}

const convertSchema = z.strictObject({
  requestIds: z.array(z.uuid()).min(1).max(100),
  // Rascunho existente (mesmo fornecedor e deposito); sem informar, cria um rascunho novo.
  purchaseOrderId: opt(z.uuid()),
  supplierId: opt(z.uuid()),
  // Abaixo do minimo ou fora do multiplo do fornecedor (D2-11): justificativa para os itens acrescentados.
  minExceptionReason: opt(z.string().trim().min(3).max(300)),
});

export async function purchaseRequestRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    requireAnyPermission(req, 'purchases.view', 'purchases.request');
    const q = pageQuery
      .extend({
        status: z.enum(['open', 'in_purchase', 'done', 'rejected', 'canceled', 'all']).default('open'),
        source: z.enum(['manual', 'backorder']).optional(),
        warehouseId: z.uuid().optional(),
        supplierId: z.uuid().optional(),
      })
      .parse(req.query);
    const params = [q.status === 'all' ? null : q.status, q.source ?? null, q.warehouseId ?? null, q.supplierId ?? null];
    const where = `($1::text IS NULL OR q.status = $1) AND ($2::text IS NULL OR q.source = $2) AND ($3::uuid IS NULL OR q.warehouse_id = $3)
      AND ($4::uuid IS NULL OR sp.supplier_id = $4)`;
    const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${FROM} WHERE ${where}`, params)).rows[0]!.n;
    const { rows } = await pool.query(`SELECT ${COLS} FROM ${FROM} WHERE ${where} ORDER BY s.name NULLS LAST, q.number LIMIT $5 OFFSET $6`, [
      ...params,
      q.pageSize,
      (q.page - 1) * q.pageSize,
    ]);
    return { items: rows, total, page: q.page, pageSize: q.pageSize };
  });

  /** Gera agora as requisicoes de encomendas sem compra (a rotina de 1 minuto faz o mesmo). Idempotente. */
  app.post('/sync', async (req) => {
    const auth = requireAnyPermission(req, 'purchases.manage', 'purchases.request');
    const result = await tx(auth.userId, (db) => syncBackorderRequests(db));
    return { result };
  });

  app.get('/:id', async (req) => {
    requireAnyPermission(req, 'purchases.view', 'purchases.request');
    const r = await load(pool, idParams.parse(req.params).id);
    if (!r) throw notFound();
    return { request: r };
  });

  /**
   * Requisicao manual (purchases.request). Uma aberta por variante e deposito; quem precisa de mais altera a aberta
   * (cancela e abre outra). Com requisicao automatica de encomenda aberta para a mesma variante e deposito, pede a
   * confirmacao de que a manual e para estoque, alem da encomenda (evita pedir em dobro).
   */
  app.post('/', async (req, reply) => {
    const auth = requirePermission(req, 'purchases.request');
    const b = z
      .strictObject({
        variantId: z.uuid(),
        packagingId: opt(z.uuid()),
        warehouseId: opt(z.uuid()),
        baseQty: qty,
        reason: note,
        neededBy: opt(z.iso.date()),
        forStock: z.boolean().optional(),
      })
      .parse(req.body);
    const request = await tx(auth.userId, async (db) => {
      const wh = await activeWarehouse(db, b.warehouseId);
      const v = (await db.query<{ active: boolean }>(`SELECT v.active AND p.status = 'active' AS active FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1`, [b.variantId])).rows[0];
      if (!v?.active) throw new AppError(422, 'INVALID_VARIANT', 'Produto inexistente ou inativo.');
      assertWhole(await variantInfo(db, b.variantId), String(b.baseQty));
      if (b.packagingId) {
        const k = (await db.query('SELECT 1 FROM packagings WHERE id = $1 AND variant_id = $2 AND active', [b.packagingId, b.variantId])).rowCount;
        if (!k) throw new AppError(422, 'INVALID_PACKAGING', 'Embalagem inexistente, inativa ou de outro produto.');
      }
      const auto = (
        await db.query<{ number: number; order_number: number; base_qty: string }>(
          `SELECT q.number, o.number AS order_number, q.base_qty::text FROM purchase_requests q JOIN orders o ON o.id = q.order_id
           WHERE q.source = 'backorder' AND q.status = 'open' AND q.variant_id = $1 AND q.warehouse_id = $2 ORDER BY q.number`,
          [b.variantId, wh.id],
        )
      ).rows;
      if (auto.length && !b.forStock) {
        throw new AppError(409, 'BACKORDER_REQUEST_EXISTS', 'Já há requisição automática aberta deste produto para encomenda de cliente. Confirme se a sua é para estoque, além da encomenda.', {
          requests: auto.map((a) => ({ number: a.number, orderNumber: a.order_number, baseQty: a.base_qty })),
        });
      }
      let id: string;
      try {
        id = (
          await db.query<{ id: string }>(
            `INSERT INTO purchase_requests (source, variant_id, packaging_id, warehouse_id, base_qty, reason, needed_by, requested_by)
             VALUES ('manual', $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [b.variantId, b.packagingId ?? null, wh.id, b.baseQty, b.reason, b.neededBy ?? null, auth.userId],
          )
        ).rows[0]!.id;
      } catch (err) {
        if (isUniqueViolation(err, 'purchase_requests_one_manual')) {
          throw new AppError(409, 'REQUEST_EXISTS', 'Já há requisição aberta deste produto para este depósito. Cancele a aberta e abra outra com a quantidade certa.');
        }
        throw err;
      }
      await event(db, id, 'created', auth.userId, b.reason);
      const saved = await load(db, id);
      await audit(db, { actorId: auth.userId, action: 'purchases.request_created', entity: 'purchase_request', entityId: id, after: saved, ip: req.ip });
      return saved;
    });
    return reply.code(201).send({ request });
  });

  /** Quem pediu cancela a propria requisicao aberta; o comprador (purchases.manage) cancela qualquer manual aberta. */
  app.post('/:id/cancel', async (req) => {
    const auth = requireAnyPermission(req, 'purchases.request', 'purchases.manage');
    const { id } = idParams.parse(req.params);
    const { reason } = z.strictObject({ reason: note }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const r = (await db.query<{ status: string; source: string; requested_by: string | null }>('SELECT status, source, requested_by FROM purchase_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw notFound();
      if (r.source !== 'manual') throw new AppError(409, 'AUTOMATIC_REQUEST', 'Requisição de encomenda é cancelada sozinha quando a encomenda é atendida ou desfeita. Para não comprar, recuse com o motivo.');
      if (r.status !== 'open') throw new AppError(409, 'INVALID_STATUS', 'Só requisição aberta é cancelada.');
      if (r.requested_by !== auth.userId && !auth.permissions.has('purchases.manage')) throw new AppError(403, 'FORBIDDEN', 'Só quem pediu ou o comprador cancela esta requisição.');
      await db.query(`UPDATE purchase_requests SET status = 'canceled', decision_note = $2, decided_by = $3, updated_at = now() WHERE id = $1`, [id, reason, auth.userId]);
      await event(db, id, 'canceled', auth.userId, reason);
      await audit(db, { actorId: auth.userId, action: 'purchases.request_canceled', entity: 'purchase_request', entityId: id, metadata: { reason }, ip: req.ip });
      return { request: await load(db, id) };
    });
  });

  /** O comprador recusa com motivo. Recusada, a de encomenda nao volta sozinha (a encomenda segue na fila da Fase 6). */
  app.post('/:id/reject', async (req) => {
    const auth = requirePermission(req, 'purchases.manage');
    const { id } = idParams.parse(req.params);
    const { reason } = z.strictObject({ reason: note }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const r = (await db.query<{ status: string }>('SELECT status FROM purchase_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw notFound();
      if (r.status !== 'open') throw new AppError(409, 'INVALID_STATUS', 'Só requisição aberta é recusada.');
      await db.query(`UPDATE purchase_requests SET status = 'rejected', decision_note = $2, decided_by = $3, updated_at = now() WHERE id = $1`, [id, reason, auth.userId]);
      await event(db, id, 'rejected', auth.userId, reason);
      await audit(db, { actorId: auth.userId, action: 'purchases.request_rejected', entity: 'purchase_request', entityId: id, metadata: { reason }, ip: req.ip });
      return { request: await load(db, id) };
    });
  });

  /**
   * Consolida requisicoes abertas numa compra (D7-6): rascunho novo ou existente, do mesmo deposito de destino.
   * Embalagem: a da requisicao ou a da oferta do fornecedor (principal primeiro); quantidade arredondada para cima
   * em embalagens inteiras. Itens pelo mesmo caminho da tela da compra (minimo, multiplo, custo da lista). A de
   * encomenda vira vinculo da Fase 6. Travas: compra -> itens -> requisicoes (ordem de id). Nada de estoque.
   */
  app.post('/convert', async (req, reply) => {
    const auth = requirePermission(req, 'purchases.manage');
    const b = convertSchema.parse(req.body);
    const result = await tx(auth.userId, async (db) => {
      let orderId: string;
      let supplierId: string;
      let created = false;
      const ids = [...new Set(b.requestIds)].sort();
      // A compra primeiro (mesma ordem da Fase 6), depois as requisicoes.
      if (b.purchaseOrderId) {
        const po = (await db.query<{ id: string; status: string; supplier_id: string; warehouse_id: string }>('SELECT id, status, supplier_id, warehouse_id FROM purchase_orders WHERE id = $1 FOR UPDATE', [b.purchaseOrderId])).rows[0];
        if (!po) throw notFound();
        if (po.status !== 'draft') throw new AppError(409, 'ORDER_LOCKED', 'Só rascunho de compra recebe requisições. Para compra já aprovada ou enviada, faça outra compra.');
        if (b.supplierId && b.supplierId !== po.supplier_id) throw new AppError(422, 'SUPPLIER_MISMATCH', 'O rascunho é de outro fornecedor.');
        orderId = po.id;
        supplierId = po.supplier_id;
      } else {
        if (!b.supplierId) throw new AppError(422, 'SUPPLIER_REQUIRED', 'Escolha o fornecedor da compra.');
        supplierId = b.supplierId;
      }
      const reqs = (
        await db.query<{ id: string; number: number; status: string; source: string; variant_id: string; packaging_id: string | null; warehouse_id: string; base_qty: string; allocation_id: string | null; order_id: string | null }>(
          `SELECT id, number, status, source, variant_id, packaging_id, warehouse_id, base_qty::text, allocation_id, order_id FROM purchase_requests WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
          [ids],
        )
      ).rows;
      if (reqs.length !== ids.length) throw notFound();
      const notOpen = reqs.filter((r) => r.status !== 'open');
      if (notOpen.length) {
        throw new AppError(409, 'REQUEST_NOT_OPEN', 'Há requisição que não está mais aberta (já em compra, recusada ou cancelada). Recarregue a lista.', { numbers: notOpen.map((r) => r.number) });
      }
      const warehouses = new Set(reqs.map((r) => r.warehouse_id));
      if (warehouses.size > 1) throw new AppError(422, 'WAREHOUSE_MISMATCH', 'As requisições são de depósitos diferentes. Uma compra tem um só destino: gere uma compra por depósito.');
      const warehouseId = reqs[0]!.warehouse_id;
      if (!b.purchaseOrderId) {
        const s = (await db.query<{ active: boolean; status: string }>('SELECT active, status FROM suppliers WHERE id = $1', [supplierId])).rows[0];
        if (s?.status === 'blocked') throw new AppError(422, 'SUPPLIER_BLOCKED', 'Fornecedor bloqueado: não recebe pedido de compra novo.');
        if (!s?.active) throw new AppError(422, 'INVALID_SUPPLIER', 'Fornecedor inexistente ou inativo.');
        await activeWarehouse(db, warehouseId);
        const purpose = reqs.every((r) => r.source === 'backorder') ? 'fulfillment' : 'replenishment';
        orderId = (
          await db.query<{ id: string }>(`INSERT INTO purchase_orders (supplier_id, purpose, warehouse_id, created_by, notes) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
            supplierId,
            purpose,
            warehouseId,
            auth.userId,
            `Gerada das requisições ${reqs.map((r) => `nº ${r.number}`).join(', ')}`,
          ])
        ).rows[0]!.id;
        created = true;
      } else {
        const po = (await db.query<{ warehouse_id: string }>('SELECT warehouse_id FROM purchase_orders WHERE id = $1', [orderId!])).rows[0]!;
        if (po.warehouse_id !== warehouseId) throw new AppError(422, 'WAREHOUSE_MISMATCH', 'O rascunho é para outro depósito. A requisição só entra em compra do mesmo depósito de destino.');
      }

      // Embalagem de cada requisicao e total por embalagem.
      const perPack = new Map<string, { base: number; perPack: number; reqs: typeof reqs }>();
      const noOffer: number[] = [];
      for (const r of reqs) {
        const k = (
          await db.query<{ id: string; base_qty: string }>(
            r.packaging_id
              ? `SELECT k.id, k.base_qty::text FROM packagings k WHERE k.id = $1 AND k.active`
              : `SELECT k.id, k.base_qty::text FROM supplier_products sp JOIN packagings k ON k.id = sp.packaging_id AND k.active
                 WHERE sp.supplier_id = $2 AND sp.variant_id = $1 AND sp.active AND sp.status = 'active' ORDER BY sp.is_primary DESC, sp.cost_cents / k.base_qty LIMIT 1`,
            r.packaging_id ? [r.packaging_id] : [r.variant_id, supplierId],
          )
        ).rows[0];
        if (!k) {
          noOffer.push(r.number);
          continue;
        }
        const cur = perPack.get(k.id) ?? { base: 0, perPack: Number(k.base_qty), reqs: [] };
        cur.base += Number(r.base_qty);
        cur.reqs.push(r);
        perPack.set(k.id, cur);
      }
      if (noOffer.length) {
        throw new AppError(422, 'NO_OFFER', 'Há requisição sem embalagem de compra deste fornecedor. Cadastre a oferta do fornecedor ou escolha outro.', { numbers: noOffer });
      }
      const current = (
        await db.query<{ packaging_id: string; packs: string; pack_cost_cents: string; min_exception_reason: string | null }>(
          'SELECT packaging_id, packs::text, pack_cost_cents::text, min_exception_reason FROM purchase_order_items WHERE order_id = $1',
          [orderId!],
        )
      ).rows;
      const fmt = (n: number) => String(Number(n.toFixed(3)));
      const items = current.map((c) => ({ packagingId: c.packaging_id, packs: Number(c.packs), packCostCents: Number(c.pack_cost_cents) as number | null, minExceptionReason: c.min_exception_reason }));
      const added: { packagingId: string; packs: number }[] = [];
      for (const [packagingId, g] of perPack) {
        const packs = Math.ceil(g.base / g.perPack - 1e-9);
        added.push({ packagingId, packs });
        const ex = items.find((i) => i.packagingId === packagingId);
        if (ex) {
          ex.packs += packs;
          ex.minExceptionReason = ex.minExceptionReason ?? b.minExceptionReason ?? null;
        } else items.push({ packagingId, packs, packCostCents: null, minExceptionReason: b.minExceptionReason ?? null });
      }
      await saveItems(
        db,
        orderId!,
        supplierId,
        items.map((i) => ({ packagingId: i.packagingId, packs: fmt(i.packs), packCostCents: i.packCostCents, minExceptionReason: i.minExceptionReason })),
      );
      const itemIds = new Map(
        (await db.query<{ id: string; packaging_id: string }>('SELECT id, packaging_id FROM purchase_order_items WHERE order_id = $1', [orderId!])).rows.map((r) => [r.packaging_id, r.id]),
      );
      const links: { orderNumber: number | null; baseQty: string }[] = [];
      for (const [packagingId, g] of perPack) {
        const itemId = itemIds.get(packagingId)!;
        for (const r of g.reqs) {
          if (r.source === 'backorder') {
            // A encomenda vira vinculo da Fase 6 (o gatilho confere produto, deposito e quantidades).
            const free = (
              await db.query<{ free: string; awaiting: boolean }>(
                `SELECT (a.base_qty - coalesce((SELECT sum(l.base_qty) FROM purchase_order_links l WHERE l.allocation_id = a.id AND l.status = 'active'), 0))::text AS free,
                        EXISTS (SELECT 1 FROM stock_reservations s WHERE s.allocation_id = a.id AND s.status = 'active' AND s.backorder) AS awaiting
                 FROM fulfillment_allocations a WHERE a.id = $1`,
                [r.allocation_id],
              )
            ).rows[0];
            if (!free?.awaiting || Number(free.free) <= 0) {
              throw new AppError(409, 'REQUEST_STALE', `A encomenda da requisição nº ${r.number} já foi atendida ou vinculada. Recarregue a lista.`);
            }
            try {
              await db.query(
                `INSERT INTO purchase_order_links (purchase_order_item_id, purchase_order_id, allocation_id, order_id, base_qty, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
                [itemId, orderId!, r.allocation_id, r.order_id, Math.min(Number(free.free), Number(r.base_qty)), auth.userId],
              );
            } catch (err) {
              const c = (err as { constraint?: string }).constraint;
              if (c?.startsWith('purchase_order_links_')) throw new AppError(409, 'LINK_REJECTED', `A encomenda da requisição nº ${r.number} não pôde ser vinculada a esta compra.`);
              throw err;
            }
            links.push({ orderNumber: (await db.query<{ number: number }>('SELECT number FROM orders WHERE id = $1', [r.order_id])).rows[0]!.number, baseQty: String(Math.min(Number(free.free), Number(r.base_qty))) });
          }
          await db.query(`UPDATE purchase_requests SET status = 'in_purchase', purchase_order_id = $2, purchase_order_item_id = $3, decided_by = $4, updated_at = now() WHERE id = $1`, [
            r.id,
            orderId!,
            itemId,
            auth.userId,
          ]);
          await event(db, r.id, 'in_purchase', auth.userId, null, orderId!);
        }
      }
      const numbers = reqs.map((r) => r.number);
      await db.query('UPDATE purchase_orders SET version = version + 1, updated_at = now() WHERE id = $1', [orderId!]);
      await db.query('INSERT INTO purchase_order_events (order_id, kind, note, data, actor_id) VALUES ($1, $2, $3, $4, $5)', [
        orderId!,
        'requests_added',
        null,
        JSON.stringify({ requests: numbers, items: added, links, created }),
        auth.userId,
      ]);
      await audit(db, { actorId: auth.userId, action: 'purchases.requests_converted', entity: 'purchase_order', entityId: orderId!, metadata: { requests: numbers, items: added, links, created }, ip: req.ip });
      return { purchaseOrderId: orderId!, created, requests: numbers, links };
    });
    return reply.code(created(result) ? 201 : 200).send(result);
  });
}

const created = (r: { created: boolean }) => r.created;
