// SGLog Fase 7: Logistica -> Abastecimento (D7-5, D7-8, D7-9, D7-12). Leitura: compras sem confirmacao, atrasos,
// mercadoria a caminho, encomendas afetadas (so o numero do pedido) e desempenho dos fornecedores.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { CATEGORY_LABEL, supplyCounts, supplyOrders, type SupplyCategory } from '../lib/supply.js';
import { requireAnyPermission } from './auth.js';

const CATEGORIES = Object.keys(CATEGORY_LABEL) as [SupplyCategory, ...SupplyCategory[]];
// Ordem de urgencia na tela.
const ORDER: SupplyCategory[] = ['delivery_late', 'confirmation_late', 'price_approval', 'refused', 'no_date', 'awaiting_confirmation', 'delivery_expected', 'untracked'];

export async function supplyRoutes(app: FastifyInstance) {
  app.get('/summary', async (req) => {
    requireAnyPermission(req, 'purchases.view', 'logistics.view');
    const { warehouseId } = z.object({ warehouseId: z.uuid().optional() }).parse(req.query);
    return { summary: await supplyCounts(pool, warehouseId ?? null) };
  });

  app.get('/overview', async (req) => {
    requireAnyPermission(req, 'purchases.view', 'logistics.view');
    const q = z
      .object({
        warehouseId: z.uuid().optional(),
        category: z.enum(CATEGORIES).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    const all = await supplyOrders(pool, { warehouseId: q.warehouseId ?? null });
    const filtered = (q.category ? all.filter((o) => o.category === q.category) : all).sort(
      (a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category) || (a.ref_date ?? '9999').localeCompare(b.ref_date ?? '9999') || a.number - b.number,
    );
    const orders = filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    const counts = await supplyCounts(pool, q.warehouseId ?? null);

    // Mercadoria a caminho por produto (compras enviadas, saldo pendente).
    const inbound = new Map<string, { variantId: string; sku: string; productName: string; pendingBase: number; orders: number[]; nextDate: string | null; late: boolean }>();
    for (const o of all) {
      for (const it of o.items) {
        const cur = inbound.get(it.variant_id) ?? { variantId: it.variant_id, sku: it.sku, productName: it.product_name, pendingBase: 0, orders: [], nextDate: null, late: false };
        cur.pendingBase += Number(it.pending_base);
        if (!cur.orders.includes(o.number)) cur.orders.push(o.number);
        if (it.ref_date && (!cur.nextDate || it.ref_date < cur.nextDate)) cur.nextDate = it.ref_date;
        cur.late ||= it.late;
        inbound.set(it.variant_id, cur);
      }
    }

    // Encomendas afetadas: vinculadas a compra com problema de prazo e encomendas sem compra. So o numero do pedido.
    const troubled = all.filter((o) => ['delivery_late', 'confirmation_late', 'price_approval', 'refused', 'no_date'].includes(o.category));
    const byId = new Map(troubled.map((o) => [o.id, o]));
    const linked = troubled.length
      ? (
          await pool.query<{ purchase_order_id: string; order_number: number; base_qty: string; sku: string; product_name: string }>(
            `SELECT l.purchase_order_id, o.number AS order_number, l.base_qty::text, v.sku, p.name AS product_name
             FROM purchase_order_links l JOIN orders o ON o.id = l.order_id JOIN fulfillment_allocations a ON a.id = l.allocation_id
             JOIN product_variants v ON v.id = a.variant_id JOIN products p ON p.id = v.product_id
             WHERE l.status = 'active' AND l.purchase_order_id = ANY($1::uuid[])
               AND EXISTS (SELECT 1 FROM stock_reservations r WHERE r.allocation_id = l.allocation_id AND r.status = 'active' AND r.backorder)
             ORDER BY o.paid_at NULLS LAST, o.number`,
            [[...byId.keys()]],
          )
        ).rows
      : [];
    const withoutPurchase = (
      await pool.query(
        `SELECT o.number AS order_number, a.base_qty - coalesce((SELECT sum(l.base_qty) FROM purchase_order_links l WHERE l.allocation_id = a.id AND l.status = 'active'), 0) AS unlinked,
                v.sku, p.name AS product_name, w.name AS warehouse_name, q.number AS request_number, q.status AS request_status
         FROM fulfillment_allocations a JOIN fulfillments f ON f.id = a.fulfillment_id AND f.status = 'confirmed' AND f.mode = 'purchase_to_order'
         JOIN orders o ON o.id = a.order_id JOIN product_variants v ON v.id = a.variant_id JOIN products p ON p.id = v.product_id JOIN warehouses w ON w.id = a.warehouse_id
         LEFT JOIN LATERAL (SELECT number, status FROM purchase_requests x WHERE x.allocation_id = a.id ORDER BY x.created_at DESC LIMIT 1) q ON true
         WHERE a.status = 'active' AND ($1::uuid IS NULL OR a.warehouse_id = $1)
           AND EXISTS (SELECT 1 FROM stock_reservations r WHERE r.allocation_id = a.id AND r.status = 'active' AND r.backorder)
           AND a.base_qty > coalesce((SELECT sum(l.base_qty) FROM purchase_order_links l WHERE l.allocation_id = a.id AND l.status = 'active'), 0)
         ORDER BY o.paid_at NULLS LAST, o.number LIMIT 200`,
        [q.warehouseId ?? null],
      )
    ).rows;

    return {
      counts,
      labels: CATEGORY_LABEL,
      orders: orders.map(({ items, ...o }) => ({ ...o, items: items.map(({ order_id: _o, ...i }) => i) })),
      total: filtered.length,
      page: q.page,
      pageSize: q.pageSize,
      inbound: [...inbound.values()].sort((a, b) => Number(b.late) - Number(a.late) || a.productName.localeCompare(b.productName)).map((i) => ({ ...i, pendingBase: i.pendingBase.toFixed(3) })),
      affected: {
        linked: linked.map((l) => {
          const o = byId.get(l.purchase_order_id)!;
          return { orderNumber: l.order_number, baseQty: l.base_qty, sku: l.sku, productName: l.product_name, purchaseNumber: o.number, purchaseOrderId: o.id, category: o.category, refDate: o.ref_date };
        }),
        withoutPurchase,
      },
    };
  });

  /**
   * Desempenho dos fornecedores (D7-12) nas compras enviadas no periodo. Prazo sugerido so como informacao: o
   * cadastro nao muda sozinho.
   */
  app.get('/performance', async (req) => {
    requireAnyPermission(req, 'purchases.view', 'logistics.view');
    const { days } = z.object({ days: z.coerce.number().int().min(7).max(365).default(90) }).parse(req.query);
    const { rows } = await pool.query(
      `WITH po AS (
         SELECT o.id, o.supplier_id, o.sent_at, o.status, o.confirmation_status, coalesce(o.promised_at, (SELECT max(i.promised_at) FROM purchase_order_items i WHERE i.order_id = o.id), o.expected_at) AS due,
                (SELECT min(c.created_at) FROM purchase_confirmations c WHERE c.order_id = o.id) AS first_conf,
                (SELECT min(r.received_at) FROM purchase_receipts r WHERE r.order_id = o.id) AS first_receipt,
                (SELECT max(r.received_at) FROM purchase_receipts r WHERE r.order_id = o.id) AS last_receipt,
                (SELECT count(*) FROM purchase_confirmations c WHERE c.order_id = o.id AND c.outcome = 'changed' AND c.status IN ('applied', 'pending_approval')) AS changed,
                (SELECT count(*) FROM purchase_confirmations c WHERE c.order_id = o.id AND c.outcome = 'refused' AND c.status = 'applied') AS refused
         FROM purchase_orders o WHERE o.sent_at >= now() - make_interval(days => $1) AND o.status IN ('sent', 'partial', 'received')
       ), iss AS (
         SELECT o.supplier_id, x.kind, count(*) AS n FROM purchase_receipt_issues x JOIN purchase_receipts r ON r.id = x.receipt_id JOIN po o ON o.id = r.order_id GROUP BY 1, 2
       )
       SELECT s.id AS supplier_id, s.name AS supplier_name, s.lead_time_days AS registered_lead_days,
              count(po.id)::int AS sent,
              count(po.id) FILTER (WHERE po.confirmation_status <> 'none')::int AS tracked,
              count(po.id) FILTER (WHERE po.first_conf IS NOT NULL)::int AS confirmed,
              round(avg(extract(epoch FROM po.first_conf - po.sent_at) / 3600) FILTER (WHERE po.first_conf IS NOT NULL), 1) AS avg_confirm_hours,
              round(avg(extract(epoch FROM po.first_receipt - po.sent_at) / 86400) FILTER (WHERE po.first_receipt IS NOT NULL), 1) AS avg_lead_days,
              count(po.id) FILTER (WHERE po.first_receipt IS NOT NULL)::int AS lead_samples,
              count(po.id) FILTER (WHERE po.status = 'received' AND po.due IS NOT NULL)::int AS due_samples,
              count(po.id) FILTER (WHERE po.status = 'received' AND po.due IS NOT NULL AND po.last_receipt::date <= po.due)::int AS on_time,
              coalesce(sum(po.changed), 0)::int AS confirmations_changed,
              coalesce(sum(po.refused), 0)::int AS confirmations_refused,
              coalesce((SELECT n FROM iss WHERE iss.supplier_id = s.id AND iss.kind = 'quantity'), 0)::int AS issues_quantity,
              coalesce((SELECT n FROM iss WHERE iss.supplier_id = s.id AND iss.kind = 'price'), 0)::int AS issues_price,
              coalesce((SELECT n FROM iss WHERE iss.supplier_id = s.id AND iss.kind = 'quality'), 0)::int AS issues_quality,
              coalesce((SELECT n FROM iss WHERE iss.supplier_id = s.id AND iss.kind = 'wrong_item'), 0)::int AS issues_wrong_item
       FROM suppliers s JOIN po ON po.supplier_id = s.id
       GROUP BY s.id ORDER BY s.name`,
      [days],
    );
    return {
      days,
      suppliers: rows.map((r) => ({
        ...r,
        confirmation_rate_pct: r.tracked ? Math.round((r.confirmed / r.tracked) * 100) : null,
        on_time_pct: r.due_samples ? Math.round((r.on_time / r.due_samples) * 100) : null,
        // Sugestao com ao menos 3 recebimentos no periodo; o cadastro nao muda sozinho.
        suggested_lead_days: r.lead_samples >= 3 && r.avg_lead_days != null ? Math.ceil(Number(r.avg_lead_days)) : null,
      })),
    };
  });
}
