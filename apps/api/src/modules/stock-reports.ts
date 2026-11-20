import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requirePermission } from './auth.js';

const DEFAULT_LEAD_DAYS = 7;
const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

type Row = {
  variant_id: string;
  sku: string;
  product_name: string;
  base_unit: string;
  allows_fraction: boolean;
  min_stock: string;
  on_hand: string;
  reserved: string;
  inbound: string;
  requested: string;
  sold: string;
  avg_cost_cents: string;
  product_lead: number | null;
};
type Offer = { variant_id: string; supplier_id: string; supplier_name: string; packaging_id: string; label: string; base_qty: string; cost_cents: string; lead_time_days: number | null };

export const replenishmentQuery = z.object({
  // Janela de vendas usada para medir o giro.
  days: z.coerce.number().int().min(7).max(365).default(90),
  // Quantos dias o estoque deve durar depois que a compra chegar.
  coverDays: z.coerce.number().int().min(1).max(180).default(30),
  // Acima disso a compra prende capital de giro: o pacote maior so compensa se nao passar daqui.
  maxCoverDays: z.coerce.number().int().min(7).max(365).default(90),
  all: z.enum(['true', 'false']).default('false'),
});

/**
 * Sugestao de reposicao por giro, com analise de embalagem:
 * necessidade = venda diaria x (prazo do fornecedor + cobertura) + minimo - (disponivel + a caminho).
 * Para cada oferta, quantas embalagens cobrem a necessidade, quanto custa e quantos dias de
 * estoque representa. A recomendada e a de menor custo por unidade que nao passe da cobertura
 * maxima; se todas passarem, a de menor desembolso.
 */
export async function replenishment(params: z.infer<typeof replenishmentQuery>) {
  const rows = (
    await pool.query<Row>(
      `SELECT v.id AS variant_id, v.sku, p.name AS product_name, p.base_unit, u.allows_fraction, p.min_stock, p.lead_time_days AS product_lead,
              coalesce(b.on_hand, 0) AS on_hand, coalesce(b.reserved, 0) AS reserved, coalesce(b.avg_cost_cents, 0) AS avg_cost_cents,
              coalesce((SELECT sum((i.packs - i.received_packs - i.canceled_packs) * i.base_qty_per_pack) FROM purchase_order_items i JOIN purchase_orders o ON o.id = i.order_id
                        WHERE i.variant_id = v.id AND o.status IN ('sent', 'partial')), 0) AS inbound,
              -- Fase 7: requisicao aberta ou ja numa compra ainda nao enviada (rascunho, aprovacao) nao e pedida de novo.
              coalesce((SELECT sum(q.base_qty) FROM purchase_requests q LEFT JOIN purchase_orders o ON o.id = q.purchase_order_id
                        WHERE q.variant_id = v.id AND (q.status = 'open' OR (q.status = 'in_purchase' AND o.status IN ('draft', 'pending_approval', 'approved')))), 0) AS requested,
              coalesce((SELECT -sum(m.on_hand_delta) FROM stock_movements m WHERE m.variant_id = v.id AND m.kind IN ('sale', 'return')
                        AND m.created_at >= now() - make_interval(days => $1)), 0) AS sold
       FROM product_variants v JOIN products p ON p.id = v.product_id JOIN units u ON u.code = p.base_unit LEFT JOIN stock_balances b ON b.variant_id = v.id
       WHERE v.active AND p.status = 'active'`,
      [params.days],
    )
  ).rows;
  const offers = (
    await pool.query<Offer>(
      `SELECT k.variant_id, s.id AS supplier_id, s.name AS supplier_name, k.id AS packaging_id, k.label, k.base_qty, sp.cost_cents,
              coalesce(sp.lead_time_days, s.lead_time_days) AS lead_time_days
       FROM supplier_products sp JOIN suppliers s ON s.id = sp.supplier_id JOIN packagings k ON k.id = sp.packaging_id
       WHERE sp.active AND s.active AND k.active`,
    )
  ).rows;
  const byVariant = new Map<string, Offer[]>();
  for (const o of offers) byVariant.set(o.variant_id, [...(byVariant.get(o.variant_id) ?? []), o]);

  const items = [];
  for (const r of rows) {
    const sold = Math.max(0, Number(r.sold));
    const daily = sold / params.days;
    const available = Number(r.on_hand) - Number(r.reserved);
    const inbound = Number(r.inbound);
    const requested = Number(r.requested);
    const min = Number(r.min_stock);
    const variantOffers = byVariant.get(r.variant_id) ?? [];
    const leads = variantOffers.map((o) => o.lead_time_days).filter((d): d is number => d !== null);
    const lead = leads.length ? Math.min(...leads) : (r.product_lead ?? DEFAULT_LEAD_DAYS);
    let need = daily * (lead + params.coverDays) + min - (available + inbound + requested);
    if (!r.allows_fraction) need = Math.ceil(need);
    need = Math.max(0, round(need));
    const belowMin = min > 0 && available < min;
    if (!need && !belowMin && params.all !== 'true') continue;

    const options = variantOffers
      .map((o) => {
        const base = Number(o.base_qty);
        const packs = Math.max(1, Math.ceil(need / base));
        const buyQty = round(packs * base);
        const unitCost = Number(o.cost_cents) / base;
        const coverage = daily > 0 ? Math.floor((available + inbound + requested + buyQty) / daily) : null;
        return {
          supplierId: o.supplier_id,
          supplierName: o.supplier_name,
          packagingId: o.packaging_id,
          label: o.label,
          baseQtyPerPack: o.base_qty,
          packs,
          buyQty,
          unitCostCents: round(unitCost, 4),
          totalCents: packs * Number(o.cost_cents),
          leadTimeDays: o.lead_time_days,
          coverageDays: coverage,
          // Sem venda no periodo, qualquer compra alem do minimo e capital parado.
          excess: coverage === null ? buyQty > Math.max(need, min) * 2 : coverage > params.maxCoverDays,
          recommended: false,
        };
      })
      .sort((a, b) => a.unitCostCents - b.unitCostCents || a.totalCents - b.totalCents);
    const pick = options.find((o) => !o.excess) ?? [...options].sort((a, b) => a.totalCents - b.totalCents)[0];
    if (pick) pick.recommended = true;

    items.push({
      variantId: r.variant_id,
      sku: r.sku,
      productName: r.product_name,
      baseUnit: r.base_unit,
      onHand: r.on_hand,
      reserved: r.reserved,
      available: round(available),
      inbound: round(inbound),
      requested: round(requested),
      minStock: r.min_stock,
      soldInPeriod: round(sold),
      dailyAvg: round(daily, 3),
      coverageDays: daily > 0 ? Math.floor(Math.max(0, available) / daily) : null,
      leadTimeDays: lead,
      need,
      belowMin,
      options,
    });
  }
  items.sort((a, b) => Number(b.belowMin) - Number(a.belowMin) || (a.coverageDays ?? 1e9) - (b.coverageDays ?? 1e9) || a.productName.localeCompare(b.productName, 'pt-BR'));
  return { params, items };
}

export async function stockReportRoutes(app: FastifyInstance) {
  app.get('/replenishment', async (req) => {
    requirePermission(req, 'purchases.view');
    return replenishment(replenishmentQuery.parse(req.query));
  });

  /** Relatorio basico: valor em estoque, alertas e movimentacao do periodo. */
  app.get('/summary', async (req) => {
    requirePermission(req, 'reports.view');
    const q = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }).parse(req.query);
    const to = q.to ?? new Date().toISOString().slice(0, 10);
    const from = q.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const valuation = (
      await pool.query(
        `SELECT coalesce(c.name, 'Sem categoria') AS category, count(*)::int AS variants, sum(b.on_hand)::numeric(16,3) AS on_hand,
                round(sum(b.on_hand * b.avg_cost_cents))::bigint AS value_cents
         FROM stock_balances b JOIN product_variants v ON v.id = b.variant_id JOIN products p ON p.id = v.product_id LEFT JOIN categories c ON c.id = p.category_id
         WHERE b.on_hand > 0 GROUP BY 1 ORDER BY value_cents DESC`,
      )
    ).rows;
    const alerts = (
      await pool.query<{ below_min: number; out: number; backorder: number }>(
        `SELECT count(*) FILTER (WHERE p.min_stock > 0 AND coalesce(b.on_hand, 0) - coalesce(b.reserved, 0) < p.min_stock)::int AS below_min,
                count(*) FILTER (WHERE p.availability_mode = 'stock' AND coalesce(b.on_hand, 0) - coalesce(b.reserved, 0) <= 0)::int AS out,
                count(*) FILTER (WHERE coalesce(b.on_hand, 0) - coalesce(b.reserved, 0) < 0)::int AS backorder
         FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN stock_balances b ON b.variant_id = v.id
         WHERE v.active AND p.status = 'active'`,
      )
    ).rows[0];
    const range = [from, to];
    const movements = (
      await pool.query(
        `SELECT kind, count(*)::int AS count, sum(on_hand_delta)::numeric(16,3) AS qty,
                round(sum(abs(on_hand_delta) * coalesce(unit_cost_cents, avg_cost_after)))::bigint AS value_cents
         FROM stock_movements WHERE created_at >= $1::date AND created_at < $2::date + 1 AND on_hand_delta <> 0 GROUP BY kind ORDER BY kind`,
        range,
      )
    ).rows;
    const topSold = (
      await pool.query(
        `SELECT v.id AS variant_id, v.sku, p.name AS product_name, p.base_unit, -sum(m.on_hand_delta)::numeric(16,3) AS qty
         FROM stock_movements m JOIN product_variants v ON v.id = m.variant_id JOIN products p ON p.id = v.product_id
         WHERE m.kind = 'sale' AND m.created_at >= $1::date AND m.created_at < $2::date + 1 GROUP BY v.id, p.name, p.base_unit ORDER BY qty DESC LIMIT 10`,
        range,
      )
    ).rows;
    const purchases = (
      await pool.query<{ receipts: number; value_cents: string | null }>(
        `SELECT count(DISTINCT r.id)::int AS receipts, round(sum(ri.base_qty * ri.unit_cost_cents))::bigint AS value_cents
         FROM purchase_receipts r JOIN purchase_receipt_items ri ON ri.receipt_id = r.id WHERE r.received_at >= $1::date AND r.received_at < $2::date + 1`,
        range,
      )
    ).rows[0];
    return { from, to, valuation, alerts, movements, topSold, purchases };
  });
}
