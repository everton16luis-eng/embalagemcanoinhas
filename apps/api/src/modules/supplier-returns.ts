// SGLog Fase 9b: devolucao ao fornecedor (docs/38-sglog-fase9.md).
//
// - Ligada a compras: fornecedor, pedido de compra (opcional, do mesmo fornecedor), devolucao do cliente (opcional),
//   itens com o saldo de onde saem (livre, bloqueado ou avariado), motivo e documento enviado.
// - Rascunho nao mexe no estoque. Enviar = saida fisica confirmada: so ai o estoque sai, no deposito escolhido.
//   Bloqueado e avariado passam antes por 'unblock' / 'damage_release' na mesma transacao (nada fica disponivel).
// - Aceita encerra. Recusada (a mercadoria voltou): estorno dos movimentos, cada um no saldo de onde saiu.
// - Nenhum credito, reembolso, abatimento ou e-mail ao fornecedor e gerado. Saida pelo custo medio atual (a media
//   nao muda numa saida).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation, pageQuery } from '../lib/http.js';
import { activeWarehouse, assertFree, assertWhole, lockVariants, moveStock, neg, qty as qtySchema, variantInfo, type Movement } from '../lib/stock.js';
import { requireAnyPermission, requirePermission, type Auth } from './auth.js';

const key = z.string().min(8).max(100);
type Head = { id: string; number: number; status: string; warehouse_id: string; version: number };

const COLS = `s.id, s.number, s.supplier_id, sp.name AS supplier_name, s.purchase_order_id, po.number AS purchase_order_number, s.customer_return_id,
  cr.number AS customer_return_number, s.warehouse_id, w.name AS warehouse_name, s.status, s.reason, s.document_ref, s.carrier, s.tracking_code, s.notes,
  s.sent_at, s.closed_at, s.close_note, s.created_at, s.updated_at, s.version, cu.name AS created_by_name`;
const FROM = `supplier_returns s JOIN suppliers sp ON sp.id = s.supplier_id JOIN warehouses w ON w.id = s.warehouse_id
  LEFT JOIN purchase_orders po ON po.id = s.purchase_order_id LEFT JOIN customer_returns cr ON cr.id = s.customer_return_id LEFT JOIN users cu ON cu.id = s.created_by`;

export async function supplierReturnView(db: Db | typeof pool, id: string) {
  const ret = (await db.query(`SELECT ${COLS} FROM ${FROM} WHERE s.id = $1`, [id])).rows[0];
  if (!ret) throw notFound();
  const items = (
    await db.query(
      `SELECT i.id::text, i.variant_id, i.bucket, i.qty, v.sku, p.name AS product_name, p.base_unit,
              coalesce((SELECT -sum(m.on_hand_delta) FROM stock_movements m LEFT JOIN stock_movements o ON o.id = m.reverses_id
                        WHERE m.source_type = 'supplier_return' AND m.source_id = i.id::text
                          AND (m.kind = 'supplier_return' OR (m.kind = 'reversal' AND o.kind = 'supplier_return'))), 0)::text AS out_qty
       FROM supplier_return_items i JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
       WHERE i.supplier_return_id = $1 ORDER BY v.sku, i.bucket`,
      [id],
    )
  ).rows;
  const events = (
    await db.query(
      `SELECT e.id, e.action, e.from_status, e.to_status, e.note, e.created_at, u.name AS actor_name FROM supplier_return_events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.supplier_return_id = $1 ORDER BY e.id`,
      [id],
    )
  ).rows;
  return { supplierReturn: ret, items, events };
}

async function event(db: Db, e: { id: string; action: string; from: string | null; to: string | null; note?: string | null; requestKey?: string | null; actorId: string }) {
  await db.query(`INSERT INTO supplier_return_events (supplier_return_id, action, from_status, to_status, note, request_key, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    e.id,
    e.action,
    e.from,
    e.to,
    e.note ?? null,
    e.requestKey ?? null,
    e.actorId,
  ]);
}

/** Acao com a devolucao travada; a mesma chave devolve a devolucao sem agir de novo. */
async function act(auth: Auth, id: string, requestKey: string, fn: (db: Db, s: Head) => Promise<void>) {
  const replay = async (db: Db | typeof pool) => (await db.query<{ supplier_return_id: string }>('SELECT supplier_return_id FROM supplier_return_events WHERE request_key = $1', [requestKey])).rows[0];
  const prior = await replay(pool);
  if (prior) {
    if (prior.supplier_return_id !== id) throw new AppError(409, 'REQUEST_KEY_REUSED', 'Chave de requisição já usada em outra devolução.');
    return { replayed: true, ...(await supplierReturnView(pool, id)) };
  }
  try {
    await tx(auth.userId, async (db) => {
      const s = (await db.query<Head>('SELECT id, number, status, warehouse_id, version FROM supplier_returns WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!s) throw notFound();
      if (await replay(db)) return;
      await fn(db, s);
    });
  } catch (err) {
    if (isUniqueViolation(err, 'supplier_return_events_request_key_key') && (await replay(pool))) return { replayed: true, ...(await supplierReturnView(pool, id)) };
    throw err;
  }
  return { replayed: false, ...(await supplierReturnView(pool, id)) };
}

const docRef = (s: { number: number }) => `Devolução ao fornecedor nº ${s.number}`;

export async function supplierReturnRoutes(app: FastifyInstance) {
  const read = ['purchases.view', 'purchases.manage', 'returns.manage', 'stock.view'] as const;

  app.get('/', async (req) => {
    requireAnyPermission(req, ...read);
    const q = pageQuery.extend({ status: z.enum(['draft', 'sent', 'accepted', 'refused', 'canceled', 'open', 'all']).default('open'), supplier: z.uuid().optional() }).parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status === 'open') where.push(`s.status IN ('draft', 'sent')`);
    else if (q.status !== 'all') where.push(`s.status = $${params.push(q.status)}`);
    if (q.supplier) where.push(`s.supplier_id = $${params.push(q.supplier)}`);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((await pool.query(`SELECT count(*) AS n FROM ${FROM} ${w}`, params)).rows[0].n);
    const items = (
      await pool.query(
        `SELECT ${COLS}, (SELECT count(*)::int FROM supplier_return_items i WHERE i.supplier_return_id = s.id) AS item_count
         FROM ${FROM} ${w} ORDER BY s.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, q.pageSize, (q.page - 1) * q.pageSize],
      )
    ).rows;
    return { items, total, page: q.page, pageSize: q.pageSize };
  });

  app.get('/:id', async (req) => {
    requireAnyPermission(req, ...read);
    const { id } = idParams.parse(req.params);
    return supplierReturnView(pool, id);
  });

  // Rascunho: so registro. Itens imutaveis (mudar = cancelar e abrir outro).
  app.post('/', async (req, reply) => {
    const auth = requirePermission(req, 'purchases.manage');
    const b = z
      .strictObject({
        supplierId: z.uuid(),
        purchaseOrderId: z.uuid().optional().nullable(),
        customerReturnId: z.uuid().optional().nullable(),
        warehouseId: z.uuid().optional().nullable(),
        reason: z.string().trim().min(3).max(500),
        notes: z.string().trim().max(1000).optional().nullable(),
        items: z.array(z.strictObject({ variantId: z.uuid(), bucket: z.enum(['on_hand', 'blocked', 'damaged']), qty: qtySchema })).min(1).max(100),
        requestKey: key,
      })
      .parse(req.body);
    const replay = async () => (await pool.query<{ id: string }>('SELECT id FROM supplier_returns WHERE request_key = $1', [b.requestKey])).rows[0];
    const prior = await replay();
    if (prior) return { replayed: true, ...(await supplierReturnView(pool, prior.id)) };
    if (new Set(b.items.map((i) => `${i.variantId}:${i.bucket}`)).size !== b.items.length) throw new AppError(422, 'DUPLICATE_ITEM', 'O mesmo item e saldo aparecem duas vezes.');
    let id: string;
    try {
      id = await tx(auth.userId, async (db) => {
        if (!(await db.query('SELECT 1 FROM suppliers WHERE id = $1', [b.supplierId])).rows[0]) throw notFound();
        if (b.purchaseOrderId && !(await db.query('SELECT 1 FROM purchase_orders WHERE id = $1 AND supplier_id = $2', [b.purchaseOrderId, b.supplierId])).rows[0]) {
          throw new AppError(422, 'PURCHASE_NOT_FROM_SUPPLIER', 'O pedido de compra não é deste fornecedor.');
        }
        if (b.customerReturnId && !(await db.query('SELECT 1 FROM customer_returns WHERE id = $1', [b.customerReturnId])).rows[0]) throw new AppError(422, 'RETURN_NOT_FOUND', 'Devolução do cliente não encontrada.');
        const wh = await activeWarehouse(db, b.warehouseId);
        for (const it of b.items) assertWhole(await variantInfo(db, it.variantId), it.qty);
        const s = (
          await db.query<{ id: string; number: number }>(
            `INSERT INTO supplier_returns (supplier_id, purchase_order_id, customer_return_id, warehouse_id, reason, notes, created_by, request_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, number`,
            [b.supplierId, b.purchaseOrderId ?? null, b.customerReturnId ?? null, wh.id, b.reason, b.notes || null, auth.userId, b.requestKey],
          )
        ).rows[0]!;
        for (const it of b.items) {
          await db.query('INSERT INTO supplier_return_items (supplier_return_id, variant_id, bucket, qty) VALUES ($1, $2, $3, $4)', [s.id, it.variantId, it.bucket, it.qty]);
        }
        await event(db, { id: s.id, action: 'create', from: null, to: 'draft', note: b.reason, actorId: auth.userId });
        await audit(db, { actorId: auth.userId, action: 'supplier_return.create', entity: 'supplier_return', entityId: s.id, after: { ...b, requestKey: undefined }, ip: auth.ip });
        return s.id;
      });
    } catch (err) {
      if (isUniqueViolation(err, 'supplier_returns_request_key_key')) {
        const again = await replay();
        if (again) return { replayed: true, ...(await supplierReturnView(pool, again.id)) };
      }
      throw err;
    }
    reply.code(201);
    return { replayed: false, ...(await supplierReturnView(pool, id)) };
  });

  // Enviar: saida fisica confirmada. So aqui o estoque sai.
  app.post('/:id/send', async (req) => {
    const auth = requirePermission(req, 'purchases.manage');
    const { id } = idParams.parse(req.params);
    const b = z
      .strictObject({
        documentRef: z.string().trim().min(1).max(60),
        carrier: z.string().trim().max(80).optional().nullable(),
        trackingCode: z.string().trim().max(60).optional().nullable(),
        version: z.number().int(),
        requestKey: key,
      })
      .parse(req.body);
    return act(auth, id, b.requestKey, async (db, s) => {
      if (s.version !== b.version) throw new AppError(409, 'VERSION_CONFLICT', 'A devolução foi alterada por outra pessoa. Recarregue a página.');
      if (s.status !== 'draft') throw new AppError(409, 'INVALID_TRANSITION', 'Só o rascunho pode ser enviado.');
      const items = (
        await db.query<{ id: string; variant_id: string; bucket: string; qty: string; sku: string }>(
          `SELECT i.id::text, i.variant_id, i.bucket, i.qty, v.sku FROM supplier_return_items i JOIN product_variants v ON v.id = i.variant_id WHERE i.supplier_return_id = $1 ORDER BY i.id`,
          [s.id],
        )
      ).rows;
      await lockVariants(db, items.map((i) => i.variant_id));
      const wh = await activeWarehouse(db, s.warehouse_id);
      for (const it of items) {
        const base = { variantId: it.variant_id, warehouseId: wh.id, sourceType: 'supplier_return' as const, sourceId: it.id, documentRef: docRef(s), reason: `Devolução ao fornecedor: ${b.documentRef}` };
        const moves: Movement[] = [];
        if (it.bucket === 'on_hand') await assertFree(db, wh, it.variant_id, it.sku, it.qty);
        if (it.bucket === 'blocked') moves.push({ ...base, kind: 'unblock', blockedDelta: neg(it.qty), onHandDelta: it.qty, skipShortageCheck: true });
        if (it.bucket === 'damaged') moves.push({ ...base, kind: 'damage_release', damagedDelta: neg(it.qty), onHandDelta: it.qty, skipShortageCheck: true });
        moves.push({ ...base, kind: 'supplier_return', onHandDelta: neg(it.qty), skipShortageCheck: it.bucket !== 'on_hand' });
        for (const m of moves) await moveStock(db, auth.userId, m);
      }
      await db.query(
        `UPDATE supplier_returns SET status = 'sent', document_ref = $2, carrier = $3, tracking_code = $4, sent_at = now(), sent_by = $5, version = version + 1, updated_at = now() WHERE id = $1`,
        [s.id, b.documentRef, b.carrier || null, b.trackingCode || null, auth.userId],
      );
      await event(db, { id: s.id, action: 'send', from: 'draft', to: 'sent', note: `Saída confirmada. Documento ${b.documentRef}.`, requestKey: b.requestKey, actorId: auth.userId });
      await audit(db, { actorId: auth.userId, action: 'supplier_return.send', entity: 'supplier_return', entityId: s.id, after: { ...b, requestKey: undefined }, ip: auth.ip });
    });
  });

  // Aceita: encerra (nenhum credito ou abatimento automatico). Recusada: a mercadoria voltou; estorna os movimentos.
  // Cancelar: so o rascunho.
  for (const action of ['accept', 'refuse', 'cancel'] as const) {
    app.post(`/:id/${action}`, async (req) => {
      const auth = requirePermission(req, 'purchases.manage');
      const { id } = idParams.parse(req.params);
      const b = z.strictObject({ note: z.string().trim().min(3).max(500), version: z.number().int(), requestKey: key }).parse(req.body);
      return act(auth, id, b.requestKey, async (db, s) => {
        if (s.version !== b.version) throw new AppError(409, 'VERSION_CONFLICT', 'A devolução foi alterada por outra pessoa. Recarregue a página.');
        const allowed = action === 'cancel' ? 'draft' : 'sent';
        if (s.status !== allowed) throw new AppError(409, 'INVALID_TRANSITION', action === 'cancel' ? 'Só o rascunho pode ser cancelado.' : 'Só a devolução enviada pode ser aceita ou recusada.');
        const to = action === 'accept' ? 'accepted' : action === 'refuse' ? 'refused' : 'canceled';
        if (action === 'refuse') {
          const moves = (
            await db.query<{ id: string; variant_id: string; source_id: string; on_hand_delta: string; blocked_delta: string; damaged_delta: string }>(
              `SELECT m.id::text, m.variant_id, m.source_id, m.on_hand_delta, m.blocked_delta, m.damaged_delta FROM stock_movements m
               WHERE m.source_type = 'supplier_return' AND m.kind <> 'reversal' AND m.source_id IN (SELECT id::text FROM supplier_return_items WHERE supplier_return_id = $1)
                 AND NOT EXISTS (SELECT 1 FROM stock_movements x WHERE x.reverses_id = m.id)
               ORDER BY m.id DESC`,
              [s.id],
            )
          ).rows;
          await lockVariants(db, [...new Set(moves.map((m) => m.variant_id))]);
          const wh = await activeWarehouse(db, s.warehouse_id);
          for (const m of moves) {
            await moveStock(db, auth.userId, {
              variantId: m.variant_id,
              kind: 'reversal',
              reversesId: m.id,
              warehouseId: wh.id,
              onHandDelta: neg(m.on_hand_delta),
              blockedDelta: neg(m.blocked_delta),
              damagedDelta: neg(m.damaged_delta),
              sourceType: 'supplier_return',
              sourceId: m.source_id,
              documentRef: docRef(s),
              reason: `Recusada pelo fornecedor: ${b.note}`.slice(0, 300),
              skipShortageCheck: true,
            });
          }
        }
        await db.query(`UPDATE supplier_returns SET status = $2, closed_at = now(), closed_by = $3, close_note = $4, version = version + 1, updated_at = now() WHERE id = $1`, [s.id, to, auth.userId, b.note]);
        await event(db, { id: s.id, action, from: s.status, to, note: b.note, requestKey: b.requestKey, actorId: auth.userId });
        await audit(db, { actorId: auth.userId, action: `supplier_return.${action}`, entity: 'supplier_return', entityId: s.id, after: { note: b.note }, ip: auth.ip });
      });
    });
  }
}
