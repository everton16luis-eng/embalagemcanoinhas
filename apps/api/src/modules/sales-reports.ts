import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { requirePermission } from './auth.js';

/**
 * Relatorios de vendas (docs/08 §3). Base: pedidos pagos pela data do pagamento no horario de Brasilia.
 * Custo = custo medio na baixa do estoque (pedido despachado) ou custo medio atual (ainda nao despachado): estimativa.
 */
const PAID = `('paid', 'preparing', 'ready', 'shipped', 'delivered')`;
const TZ = `'America/Sao_Paulo'`;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD.');

const brToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const periodQuery = z
  .object({ from: date.optional(), to: date.optional(), groupBy: z.enum(['day', 'month']).default('day') })
  .transform((q) => {
    const to = q.to ?? brToday();
    const from = q.from ?? addDays(to, -29);
    return { ...q, from, to };
  })
  .refine((q) => q.from <= q.to, { message: 'A data inicial é depois da final.', path: ['from'] })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 731 * 86_400_000, { message: 'Período máximo de 2 anos.', path: ['to'] });

// Pedidos pagos no periodo [from, to] (datas de Brasilia, fim inclusivo).
const paidCte = `paid AS (
  SELECT o.* FROM orders o
  WHERE o.status IN ${PAID} AND o.paid_at >= ($1::date)::timestamp AT TIME ZONE ${TZ} AND o.paid_at < ($2::date + 1)::timestamp AT TIME ZONE ${TZ})`;

const n = (v: unknown) => Number(v ?? 0);

export async function salesSummary(q: z.infer<typeof periodQuery>) {
  const p = [q.from, q.to];
  const series = (
    await pool.query(
      `WITH ${paidCte}
       SELECT to_char(date_trunc('${q.groupBy}', o.paid_at AT TIME ZONE ${TZ}), 'YYYY-MM-DD') AS period, count(*)::int AS orders,
              sum(o.total_cents)::text AS total, sum(o.freight_cents)::text AS freight, sum(o.discount_cents)::text AS discount
       FROM paid o GROUP BY 1 ORDER BY 1`,
      p,
    )
  ).rows.map((r) => ({ period: r.period, orders: r.orders, totalCents: n(r.total), freightCents: n(r.freight), discountCents: n(r.discount) }));
  const group = async (col: 'channel' | 'payment_method') =>
    (
      await pool.query(`WITH ${paidCte} SELECT o.${col} AS key, count(*)::int AS orders, sum(o.total_cents)::text AS total FROM paid o GROUP BY 1 ORDER BY sum(o.total_cents) DESC`, p)
    ).rows.map((r) => ({ key: r.key, orders: r.orders, totalCents: n(r.total) }));
  const orders = series.reduce((s, r) => s + r.orders, 0);
  const totalCents = series.reduce((s, r) => s + r.totalCents, 0);
  return {
    from: q.from,
    to: q.to,
    groupBy: q.groupBy,
    totals: {
      orders,
      totalCents,
      freightCents: series.reduce((s, r) => s + r.freightCents, 0),
      discountCents: series.reduce((s, r) => s + r.discountCents, 0),
      averageTicketCents: orders ? Math.round(totalCents / orders) : 0,
    },
    series,
    byChannel: await group('channel'),
    byPaymentMethod: await group('payment_method'),
  };
}

export async function productSales(q: z.infer<typeof periodQuery>) {
  const { rows } = await pool.query(
    `WITH ${paidCte}
     SELECT v.id AS variant_id, v.sku, p.id AS product_id, p.name AS product_name, p.base_unit,
            sum(i.base_qty_per_pack * i.packs)::text AS qty, count(DISTINCT o.id)::int AS orders, sum(i.total_cents)::text AS revenue,
            round(sum(i.base_qty_per_pack * i.packs * coalesce(m.cost, b.avg_cost_cents, 0)))::text AS cost,
            bool_or(coalesce(m.cost, b.avg_cost_cents, 0) = 0) AS cost_missing
     FROM paid o JOIN order_items i ON i.order_id = o.id JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
     LEFT JOIN stock_balances b ON b.variant_id = v.id
     LEFT JOIN LATERAL (
       SELECT mv.avg_cost_after AS cost FROM stock_movements mv
       WHERE mv.source_type = 'order' AND mv.source_id = o.id::text AND mv.variant_id = i.variant_id AND mv.kind = 'sale' ORDER BY mv.id DESC LIMIT 1
     ) m ON true
     GROUP BY v.id, v.sku, p.id, p.name, p.base_unit
     ORDER BY sum(i.total_cents) DESC, v.sku`,
    [q.from, q.to],
  );
  const total = rows.reduce((s, r) => s + n(r.revenue), 0);
  let acc = 0;
  const products = rows.map((r) => {
    const revenue = n(r.revenue);
    const cost = n(r.cost);
    // Classe pela participacao acumulada ANTES do item: o item que cruza 80% ainda e A.
    const before = total ? acc / total : 0;
    acc += revenue;
    return {
      variantId: r.variant_id,
      sku: r.sku,
      productId: r.product_id,
      productName: r.product_name,
      baseUnit: r.base_unit,
      qty: r.qty,
      orders: r.orders,
      revenueCents: revenue,
      costCents: cost,
      marginCents: revenue - cost,
      marginPct: revenue ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null,
      costMissing: r.cost_missing,
      sharePct: total ? Math.round((revenue / total) * 1000) / 10 : 0,
      cumulativePct: total ? Math.round((acc / total) * 1000) / 10 : 0,
      abc: before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C',
    };
  });
  const cost = products.reduce((s, r) => s + r.costCents, 0);
  return {
    from: q.from,
    to: q.to,
    totals: { revenueCents: total, costCents: cost, marginCents: total - cost, costMissing: products.some((p) => p.costMissing) },
    abc: (['A', 'B', 'C'] as const).map((c) => {
      const items = products.filter((p) => p.abc === c);
      return { class: c, products: items.length, revenueCents: items.reduce((s, p) => s + p.revenueCents, 0) };
    }),
    products,
  };
}

export async function salesReportRoutes(app: FastifyInstance) {
  const parse = (query: unknown) => {
    const r = periodQuery.safeParse(query);
    if (!r.success) throw new AppError(400, 'INVALID_PERIOD', r.error.issues[0]?.message ?? 'Período inválido.');
    return r.data;
  };
  app.get('/summary', async (req) => {
    requirePermission(req, 'reports.view');
    return salesSummary(parse(req.query));
  });
  app.get('/products', async (req) => {
    requirePermission(req, 'reports.view');
    return productSales(parse(req.query));
  });
}
