// SGLog Fase 6: fila de encomendas por deposito e variante, reprocessamento manual (D6-10) e antecipacao (D6-9/D6-11).
// A regra de conversao fica em lib/backorders.ts; aqui so permissao, validacao, transacao e auditoria.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { advanceBackorder, backorderPairs, backorderQueue, freeForBackorders, reprocessBackorders } from '../lib/backorders.js';
import { AppError } from '../lib/errors.js';
import { lockVariants } from '../lib/stock.js';
import { requirePermission } from './auth.js';

const q3 = (m: number) => (m / 1000).toFixed(3);

export async function backorderRoutes(app: FastifyInstance) {
  // Fila: cada deposito x variante com encomenda de pedido pago, na ordem em que converte, e o livre de agora.
  app.get('/', async (req) => {
    requirePermission(req, 'logistics.view');
    const q = z.object({ warehouseId: z.uuid().optional(), variantId: z.uuid().optional() }).parse(req.query);
    const pairs = await backorderPairs(pool, q);
    const groups = [];
    for (const p of pairs.slice(0, 200)) {
      const info = (
        await pool.query<{ sku: string; product_name: string; base_unit: string; warehouse_name: string }>(
          `SELECT v.sku, pr.name AS product_name, pr.base_unit, w.name AS warehouse_name FROM product_variants v JOIN products pr ON pr.id = v.product_id, warehouses w
           WHERE v.id = $1 AND w.id = $2`,
          [p.variant_id, p.warehouse_id],
        )
      ).rows[0];
      const queue = await backorderQueue(pool, p.warehouse_id, p.variant_id);
      const linked = (
        await pool.query<{ allocation_id: string; po_number: number; purchase_order_id: string }>(
          `SELECT l.allocation_id, po.number AS po_number, po.id AS purchase_order_id FROM purchase_order_links l JOIN purchase_orders po ON po.id = l.purchase_order_id
           WHERE l.status = 'active' AND l.allocation_id = ANY($1::uuid[])`,
          [queue.map((e) => e.allocation_id).filter(Boolean)],
        )
      ).rows;
      groups.push({
        warehouseId: p.warehouse_id,
        variantId: p.variant_id,
        ...info,
        free: q3(Math.max(await freeForBackorders(pool, p.warehouse_id, p.variant_id), 0)),
        queue: queue.map((e, i) => ({
          position: i + 1,
          reservationId: e.reservation_id,
          orderId: e.order_id,
          orderNumber: e.order_number,
          paidAt: e.paid_at,
          qty: e.qty,
          purchases: linked.filter((l) => l.allocation_id === e.allocation_id).map((l) => ({ id: l.purchase_order_id, number: l.po_number })),
        })),
      });
    }
    return { groups };
  });

  /**
   * Reprocessamento (D6-10): sem `apply`, so a previa (nada muda). Com `apply`, converte pela fila o que a mercadoria
   * livre cobre inteiro, parando na primeira que nao cabe. Encomendas antigas nao convertem sozinhas na migracao.
   */
  app.post('/reprocess', async (req) => {
    const auth = requirePermission(req, 'logistics.manage');
    const b = z.strictObject({ warehouseId: z.uuid().nullable().optional(), variantId: z.uuid().nullable().optional(), apply: z.boolean().default(false), requestKey: z.string().trim().min(8).max(100) }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const r = await reprocessBackorders(db, auth.userId, { ...b, preview: !b.apply, lockVariants: (ids) => lockVariants(db, ids) });
      if (b.apply && !r.replayed) {
        const converted = r.results.flatMap((x) => x.converted.map((c) => ({ orderNumber: c.orderNumber, variantId: c.variantId, qty: c.qty })));
        await audit(db, { actorId: auth.userId, action: 'logistics.backorders_reprocessed', entity: 'backorders', metadata: { filter: { warehouseId: b.warehouseId ?? null, variantId: b.variantId ?? null }, converted }, ip: req.ip });
      }
      return { preview: !b.apply, ...r };
    });
  });

  /**
   * Antecipacao manual (D6-9/D6-11): uma encomenda fora da ordem, inteira, so com mercadoria livre suficiente.
   * Permissao de gestao logistica, MFA ativo e justificativa; fica no historico imutavel (rule 'manual').
   */
  app.post('/advance', async (req) => {
    const auth = requirePermission(req, 'logistics.manage');
    if (!auth.mfaEnabled) throw new AppError(403, 'MFA_REQUIRED', 'Ative a verificação em duas etapas em Minha conta para continuar.');
    const b = z.strictObject({ reservationId: z.uuid(), justification: z.string().trim().min(10).max(500), requestKey: z.string().trim().min(8).max(100) }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const v = (await db.query<{ variant_id: string }>('SELECT variant_id FROM stock_reservations WHERE id = $1', [b.reservationId])).rows[0];
      if (!v) throw new AppError(404, 'NOT_FOUND', 'Encomenda não encontrada.');
      await lockVariants(db, [v.variant_id]);
      const r = await advanceBackorder(db, auth.userId, b);
      if (!r.replayed) await audit(db, { actorId: auth.userId, action: 'logistics.backorder_advanced', entity: 'order', entityId: r.orderId, metadata: { ...b, position: r.position, ahead: r.ahead }, ip: req.ip });
      return r;
    });
  });
}
