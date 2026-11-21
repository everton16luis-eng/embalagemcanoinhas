// SGLog Fase 10b: painel Gestao, rentabilidade (pedido, produto, categoria, canal, fornecedor, UF), custos logisticos,
// desempenho de fornecedores e indicadores (docs/41-sglog-fase10.md).
//
// - Tudo e leitura, calculado no banco por agregacao (nunca todos os pedidos em memoria), com paginacao e CSV.
// - Margem de contribuicao, nunca lucro liquido. Custo desconhecido nao vira zero: o pedido fica parcial e o
//   relatorio mostra a cobertura (pedidos completos / pedidos) e os componentes que faltam.
// - Periodo: data do pagamento (padrao), do pedido ou do primeiro despacho. Devolucoes e reembolsos entram no pedido de
//   origem, no periodo dele, com a situacao do momento da consulta (visao por safra). Perda de estoque usa a data do
//   movimento, rotulada a parte.
// - Permissoes: management.view para entrar; valores de margem exigem margins.view; custos, costs.view ou margins.view;
//   valor de estoque, costs.view. Nada aqui grava.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { pageQuery } from '../lib/http.js';
import { BASIS_LABEL, CHANNELS, COMPONENT_LABEL, LINES_SQL, STORE_CARRIER, TZ, basisDateSql, demoSql, ordCte, type Basis, type DemoMode, type OrderFilter } from '../lib/costs.js';
import { requireAnyPermission, requirePermission, type Auth } from './auth.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const filterQuery = z.object({
  from: day.optional(),
  to: day.optional(),
  basis: z.enum(['paid', 'order', 'dispatch']).default('paid'),
  demo: z.enum(['include', 'exclude', 'only']).default('include'),
  channel: z.enum(CHANNELS).optional(),
  uf: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .transform((v) => v.toUpperCase())
    .optional(),
  format: z.enum(['json', 'csv']).default('json'),
});
type Filter = z.infer<typeof filterQuery>;

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const span = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;

/** Periodo pedido (fim inclusivo, ate 366 dias; padrao: ultimos 30 dias). */
function period(q: Filter) {
  const to = q.to ?? today();
  const from = q.from ?? addDays(to, -29);
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw new AppError(400, 'INVALID_PERIOD', 'Data inválida.');
  const days = span(from, to);
  if (days < 1) throw new AppError(400, 'INVALID_PERIOD', 'O início do período precisa ser antes do fim.');
  if (days > 366) throw new AppError(400, 'INVALID_PERIOD', 'Período de até 366 dias.');
  return { from, to, days };
}
const filterOf = (q: Filter, p: { from: string; to: string }): OrderFilter => ({ from: p.from, to: p.to, basis: q.basis as Basis, demo: q.demo as DemoMode, channel: q.channel ?? null, uf: q.uf ?? null });
const base = (f: OrderFilter) => {
  const params: unknown[] = [];
  return { sql: `WITH ${ordCte(f, params)},${LINES_SQL}`, params };
};

const NOTES = {
  cohort:
    'Devoluções, reembolsos e custos lançados depois entram no pedido de origem, no período dele, com a situação de hoje: o resultado de um período passado pode mudar quando chega um custo ou uma devolução.',
  partial: 'Pedido parcial: falta ao menos um custo. O valor que falta fica fora da conta (não entra como zero); a cobertura mostra quanto do período está completo.',
  margin: 'Margem de contribuição: receita menos custos variáveis do pedido (CMV, frete, embalagem, taxas, tributos, devoluções). Não é lucro líquido: não desconta despesas fixas.',
  taxes: 'Tributo estimado vem da alíquota validada pelo contador e não é o valor fiscal definitivo.',
};
const meta = (q: Filter, p: { from: string; to: string; days: number }) => ({
  period: { ...p, basis: q.basis, basisLabel: BASIS_LABEL[q.basis as Basis] },
  filters: { demo: q.demo, channel: q.channel ?? null, uf: q.uf ?? null },
});

// ---------------------------------------------------------------------------------------------------------------
// Totais.
const AGG = `count(*)::int AS orders, count(*) FILTER (WHERE p.unknown = 0)::int AS complete, count(*) FILTER (WHERE p.demo)::int AS demo,
  coalesce(sum(p.revenue), 0)::bigint AS revenue, coalesce(sum(p.cogs), 0)::bigint AS cogs, coalesce(sum(p.logistics), 0)::bigint AS logistics,
  coalesce(sum(p.fees), 0)::bigint AS fees, coalesce(sum(p.taxes), 0)::bigint AS taxes, coalesce(sum(p.taxes_estimated), 0)::bigint AS taxes_estimated,
  coalesce(sum(p.returns), 0)::bigint AS returns, coalesce(sum(p.other), 0)::bigint AS other, coalesce(sum(p.margin), 0)::bigint AS margin,
  coalesce(sum(p.estimated), 0)::bigint AS estimated,
  coalesce(sum(p.revenue) FILTER (WHERE p.unknown = 0), 0)::bigint AS revenue_complete, coalesce(sum(p.margin) FILTER (WHERE p.unknown = 0), 0)::bigint AS margin_complete`;
type Agg = Record<'revenue' | 'cogs' | 'logistics' | 'fees' | 'taxes' | 'taxes_estimated' | 'returns' | 'other' | 'margin' | 'estimated' | 'revenue_complete' | 'margin_complete', string> & {
  orders: number;
  complete: number;
  demo: number;
};
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
function totals(r: Agg | undefined, financial: boolean) {
  const x = r ?? ({ orders: 0, complete: 0, demo: 0 } as Agg);
  const N = (k: keyof Agg) => Number(x[k] ?? 0);
  const out: Record<string, unknown> = {
    orders: x.orders,
    completeOrders: x.complete,
    partialOrders: x.orders - x.complete,
    demoOrders: x.demo,
    coveragePct: pct(x.complete, x.orders),
  };
  if (!financial) return out;
  return {
    ...out,
    revenueCents: N('revenue'),
    cogsCents: N('cogs'),
    logisticsCents: N('logistics'),
    feesCents: N('fees'),
    taxesCents: N('taxes'),
    taxesEstimatedCents: N('taxes_estimated'),
    returnsCents: N('returns'),
    otherCents: N('other'),
    marginCents: N('margin'),
    // Margem sobre todos os pedidos (parciais inclusos: maior que a real enquanto faltar custo) e so sobre os completos.
    marginPct: pct(N('margin'), N('revenue')),
    completeMarginPct: pct(N('margin_complete'), N('revenue_complete')),
    revenueCoveragePct: pct(N('revenue_complete'), N('revenue')),
    estimatedCents: N('estimated'),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// CSV (separador ;, decimal com virgula, BOM para o Excel).
const CSV_MAX = 20_000;
const cell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const reais = (c: unknown) => (c === null || c === undefined ? null : (Number(c) / 100).toFixed(2).replace('.', ','));
function sendCsv(reply: FastifyReply, name: string, head: string[], rows: unknown[][]) {
  const body = '﻿' + [head, ...rows].map((r) => r.map((v) => (typeof v === 'string' && /^-?\d+,\d{2}$/.test(v) ? v : cell(v))).join(';')).join('\r\n') + '\r\n';
  return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}.csv"`).header('cache-control', 'no-store').send(body);
}
const CHANNEL_NAME: Record<string, string> = { store: 'Loja virtual', sales_desk: 'Balcão', mercadolivre: 'Mercado Livre', shopee: 'Shopee' };

/**
 * Consulta gerencial: transacao so de leitura e sem laco aninhado (enable_nestloop = off). As CTEs agregadas nao tem
 * estatistica; com estimativa baixa o planejador escolheria laco aninhado entre elas (10 mil x 10 mil). Com o laco
 * desligado ele usa hash; os LATERAL das configuracoes continuam funcionando (so ficam mais caros no custo estimado).
 */
async function q2(sql: string, params: unknown[]) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query('SET LOCAL enable_nestloop = off');
    const r = await c.query(sql, params);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

const has = (a: Auth, p: Parameters<Auth['permissions']['has']>[0]) => a.permissions.has(p);

export async function managementRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------------------------------------------
  // Resumo do painel: totais, cobertura, comparacao com o periodo anterior, por canal, por mes, o que falta.
  app.get('/summary', async (req) => {
    const auth = requirePermission(req, 'management.view');
    const q = filterQuery.parse(req.query);
    const p = period(q);
    const financial = has(auth, 'margins.view');
    const cur = base(filterOf(q, p));
    const prevP = { from: addDays(p.from, -p.days), to: addDays(p.from, -1), days: p.days };
    const prev = base(filterOf(q, prevP));
    const bdate = basisDateSql(q.basis as Basis);
    const [now, before] = await Promise.all([
      q2(
        `${cur.sql},
         j AS (SELECT o.channel, o.number, o.id, o.demo, ${bdate} AS d, p.* FROM per p JOIN ord o ON o.id = p.order_id)
         SELECT
           (SELECT row_to_json(t) FROM (SELECT ${AGG} FROM j p) t) AS total,
           (SELECT coalesce(json_agg(t ORDER BY t.revenue DESC), '[]') FROM (SELECT p.channel, ${AGG} FROM j p GROUP BY p.channel) t) AS by_channel,
           (SELECT coalesce(json_agg(t ORDER BY t.month), '[]') FROM (SELECT to_char(date_trunc('month', p.d), 'YYYY-MM') AS month, ${AGG} FROM j p GROUP BY 1) t) AS by_month,
           (SELECT coalesce(json_agg(t ORDER BY t.orders DESC), '[]') FROM (SELECT m AS component, count(*)::int AS orders FROM j, unnest(j.missing) m GROUP BY m) t) AS missing,
           (SELECT coalesce(json_agg(t), '[]') FROM (SELECT j.id, j.number, j.channel, j.demo, j.revenue, j.missing FROM j WHERE j.unknown > 0 ORDER BY j.revenue DESC, j.number DESC LIMIT 8) t) AS incomplete`,
        cur.params,
      ),
      q2(`${prev.sql}, j AS (SELECT o.demo, p.* FROM per p JOIN ord o ON o.id = p.order_id) SELECT ${AGG} FROM j p`, prev.params),
    ]);
    const r = now.rows[0];
    return {
      ...meta(q, p),
      financial,
      totals: totals(r.total, financial),
      previous: { period: prevP, totals: totals(before.rows[0], financial) },
      byChannel: (r.by_channel as (Agg & { channel: string })[]).map((c) => ({ channel: c.channel, label: CHANNEL_NAME[c.channel] ?? c.channel, ...totals(c, financial) })),
      byMonth: (r.by_month as (Agg & { month: string })[]).map((c) => ({ month: c.month, ...totals(c, financial) })),
      missing: (r.missing as { component: string; orders: number }[]).map((m) => ({ ...m, label: COMPONENT_LABEL[m.component] ?? m.component })),
      incomplete: (r.incomplete as { id: string; number: number; channel: string; demo: boolean; revenue: string; missing: string[] }[]).map((o) => ({
        id: o.id,
        number: o.number,
        channel: o.channel,
        demo: o.demo,
        revenueCents: financial ? Number(o.revenue) : undefined,
        missing: o.missing.map((c) => COMPONENT_LABEL[c] ?? c),
      })),
      notes: [NOTES.margin, NOTES.partial, NOTES.cohort, NOTES.taxes],
    };
  });

  // -------------------------------------------------------------------------------------------------------------
  // Rentabilidade por pedido (paginada; CSV ate 20 mil linhas).
  const ORDER_SORT: Record<string, string> = {
    number: 'o.number',
    revenue: 'p.revenue',
    margin: 'p.margin',
    margin_pct: 'p.margin::numeric / nullif(p.revenue, 0)',
    unknown: 'p.unknown',
    date: 'd',
  };
  app.get('/orders', async (req, reply) => {
    requirePermission(req, 'management.view');
    requirePermission(req, 'margins.view');
    const q = filterQuery
      .extend(pageQuery.shape)
      .extend({ status: z.enum(['partial', 'complete']).optional(), sort: z.enum(['number', 'revenue', 'margin', 'margin_pct', 'unknown', 'date']).default('date'), dir: z.enum(['asc', 'desc']).default('desc') })
      .parse(req.query);
    const p = period(q);
    const b = base(filterOf(q, p));
    const where = q.status === 'partial' ? 'WHERE p.unknown > 0' : q.status === 'complete' ? 'WHERE p.unknown = 0' : '';
    const csv = q.format === 'csv';
    const limit = csv ? CSV_MAX : q.pageSize;
    const offset = csv ? 0 : (q.page - 1) * q.pageSize;
    const { rows } = await q2(
      `${b.sql}
       SELECT o.id, o.number, o.channel, o.uf, o.demo, o.status, ${basisDateSql(q.basis as Basis)}::text AS d, p.*, count(*) OVER () AS total
       FROM per p JOIN ord o ON o.id = p.order_id ${where}
       ORDER BY ${ORDER_SORT[q.sort]} ${q.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, o.number DESC
       LIMIT ${limit} OFFSET ${offset}`,
      b.params,
    );
    const items = rows.map((r) => ({
      id: r.id,
      number: r.number,
      channel: r.channel,
      uf: r.uf,
      demo: r.demo,
      date: r.d,
      revenueCents: Number(r.revenue),
      cogsCents: Number(r.cogs),
      logisticsCents: Number(r.logistics),
      feesCents: Number(r.fees),
      taxesCents: Number(r.taxes),
      taxesEstimatedCents: Number(r.taxes_estimated),
      returnsCents: Number(r.returns),
      otherCents: Number(r.other),
      marginCents: Number(r.margin),
      marginPct: pct(Number(r.margin), Number(r.revenue)),
      estimatedCents: Number(r.estimated),
      status: r.unknown > 0 ? 'partial' : 'complete',
      missing: (r.missing as string[]).map((c) => COMPONENT_LABEL[c] ?? c),
    }));
    const total = rows.length ? Number(rows[0].total) : 0;
    if (csv)
      return sendCsv(
        reply,
        `margem-pedidos-${p.from}-${p.to}`,
        ['pedido', 'canal', 'uf', 'demonstracao', `data (${BASIS_LABEL[q.basis as Basis]})`, 'receita', 'cmv', 'custos_logisticos', 'taxas_comissoes', 'tributos', 'tributos_estimados', 'devolucoes', 'outros', 'margem_contribuicao', 'margem_pct', 'estimado', 'situacao', 'faltam'],
        items.map((i) => [
          i.number,
          CHANNEL_NAME[i.channel] ?? i.channel,
          i.uf,
          i.demo ? 'sim' : 'não',
          i.date,
          reais(i.revenueCents),
          reais(i.cogsCents),
          reais(i.logisticsCents),
          reais(i.feesCents),
          reais(i.taxesCents),
          reais(i.taxesEstimatedCents),
          reais(i.returnsCents),
          reais(i.otherCents),
          reais(i.marginCents),
          i.marginPct,
          reais(i.estimatedCents),
          i.status === 'partial' ? 'parcial' : 'completo',
          i.missing.join(', '),
        ]),
      );
    return { ...meta(q, p), items, total, page: q.page, pageSize: q.pageSize, truncated: false, notes: [NOTES.partial, NOTES.cohort] };
  });

  // -------------------------------------------------------------------------------------------------------------
  // Rentabilidade por dimensao. Canal e UF somam o pedido inteiro; produto, categoria e fornecedor recebem o custo
  // ligado ao item (CMV, devolucao) direto e o custo do pedido (frete, embalagem, taxas, tributos) pela participacao do
  // item na receita de mercadoria do pedido.
  const DIMS = ['channel', 'uf', 'product', 'category', 'supplier'] as const;
  app.get('/breakdown', async (req, reply) => {
    requirePermission(req, 'management.view');
    requirePermission(req, 'margins.view');
    const q = filterQuery
      .extend(pageQuery.shape)
      .extend({ dim: z.enum(DIMS), sort: z.enum(['margin', 'revenue', 'margin_pct', 'orders']).default('revenue'), dir: z.enum(['asc', 'desc']).default('desc') })
      .parse(req.query);
    const p = period(q);
    const b = base(filterOf(q, p));
    const sort = { margin: 'g.margin', revenue: 'g.revenue', margin_pct: 'g.margin / nullif(g.revenue, 0)', orders: 'g.orders' }[q.sort];
    const csv = q.format === 'csv';
    const limit = csv ? CSV_MAX : q.pageSize;
    const offset = csv ? 0 : (q.page - 1) * q.pageSize;
    const sums = (a: string) => `count(DISTINCT ${a}.order_id)::int AS orders, count(DISTINCT ${a}.order_id) FILTER (WHERE pp.unknown > 0)::int AS partial,
      coalesce(sum(${a}.amount) FILTER (WHERE ${a}.grp = 'revenue'), 0) AS revenue, coalesce(sum(${a}.amount) FILTER (WHERE ${a}.grp = 'cogs'), 0) AS cogs,
      coalesce(sum(${a}.amount) FILTER (WHERE ${a}.grp = 'logistics'), 0) AS logistics, coalesce(sum(${a}.amount) FILTER (WHERE ${a}.grp = 'fees'), 0) AS fees,
      coalesce(sum(${a}.amount) FILTER (WHERE ${a}.grp = 'taxes'), 0) AS taxes, coalesce(sum(${a}.amount) FILTER (WHERE ${a}.grp = 'returns'), 0) AS returns,
      coalesce(sum(${a}.amount) FILTER (WHERE ${a}.grp = 'other'), 0) AS other, coalesce(sum(${a}.amount), 0) AS margin`;
    let sql: string;
    if (q.dim === 'channel' || q.dim === 'uf') {
      const k = q.dim === 'channel' ? 'o.channel' : `coalesce(o.uf, '—')`;
      sql = `${b.sql},
        x AS (SELECT l.order_id, l.grp, l.amount::numeric AS amount FROM lines l WHERE l.nature IN ('effective', 'estimated')),
        g AS (SELECT ${k} AS key, ${k} AS label, NULL::text AS attribution, ${sums('x')}
              FROM x JOIN ord o ON o.id = x.order_id JOIN per pp ON pp.order_id = x.order_id GROUP BY 1)
        SELECT g.*, NULL::numeric AS qty, count(*) OVER () AS total FROM g`;
    } else {
      const key =
        q.dim === 'product'
          ? { k: 'pv.product_id::text', label: 'pr.name', attr: 'NULL::text' }
          : q.dim === 'category'
            ? { k: `coalesce(pr.category_id::text, '-')`, label: `coalesce(c.name, 'Sem categoria')`, attr: 'NULL::text' }
            : {
                k: `coalesce(sa.supplier_id, sp.supplier_id)::text`,
                label: `coalesce(su.name, 'Sem fornecedor identificado')`,
                attr: `CASE WHEN sa.supplier_id IS NOT NULL THEN 'allocation' WHEN sp.supplier_id IS NOT NULL THEN 'primary' ELSE 'none' END`,
              };
      sql = `${b.sql},
        w AS (SELECT i.order_id, i.variant_id, i.qty,
                     coalesce(i.rev::numeric / nullif(sum(i.rev) OVER (PARTITION BY i.order_id), 0), 1.0 / count(*) OVER (PARTITION BY i.order_id)) AS w
              FROM items i),
        alloc AS (
          SELECT l.order_id, l.variant_id, l.grp, l.amount::numeric AS amount
          FROM lines l JOIN items i ON i.order_id = l.order_id AND i.variant_id = l.variant_id WHERE l.nature IN ('effective', 'estimated')
          UNION ALL
          SELECT l.order_id, w.variant_id, l.grp, l.amount * w.w
          FROM lines l JOIN w ON w.order_id = l.order_id
          WHERE l.nature IN ('effective', 'estimated') AND NOT EXISTS (SELECT 1 FROM items i WHERE i.order_id = l.order_id AND i.variant_id = l.variant_id)
        ),
        sa AS (SELECT DISTINCT ON (a.order_id, a.variant_id) a.order_id, a.variant_id, s2.supplier_id
               FROM fulfillment_allocations a JOIN supplier_products s2 ON s2.id = a.supplier_product_id
               WHERE a.status = 'active' AND a.order_id IN (SELECT id FROM ord) ORDER BY a.order_id, a.variant_id, a.created_at),
        sp AS (SELECT DISTINCT ON (s3.variant_id) s3.variant_id, s3.supplier_id FROM supplier_products s3
               WHERE s3.is_primary AND s3.status = 'active' AND s3.variant_id IN (SELECT variant_id FROM items) ORDER BY s3.variant_id, s3.updated_at DESC),
        tagged AS (
          SELECT a.*, ${key.k} AS key, ${key.label} AS label, ${key.attr} AS attribution
          FROM alloc a JOIN product_variants pv ON pv.id = a.variant_id JOIN products pr ON pr.id = pv.product_id
          LEFT JOIN categories c ON c.id = pr.category_id
          LEFT JOIN sa ON sa.order_id = a.order_id AND sa.variant_id = a.variant_id
          LEFT JOIN sp ON sp.variant_id = a.variant_id
          LEFT JOIN suppliers su ON su.id = coalesce(sa.supplier_id, sp.supplier_id)
        ),
        g AS (SELECT t.key, min(t.label) AS label, string_agg(DISTINCT t.attribution, ',') AS attribution, ${sums('t')}
              FROM tagged t JOIN per pp ON pp.order_id = t.order_id GROUP BY t.key)
        SELECT g.*, ${q.dim === 'product' ? `(SELECT sum(w.qty) FROM w JOIN product_variants v2 ON v2.id = w.variant_id WHERE v2.product_id::text = g.key)` : 'NULL::numeric'} AS qty,
               count(*) OVER () AS total FROM g`;
    }
    const { rows } = await q2(`${sql} ORDER BY ${sort} ${q.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, g.label LIMIT ${limit} OFFSET ${offset}`, b.params);
    const R = (v: unknown) => Math.round(Number(v));
    const items = rows.map((r) => ({
      key: r.key,
      label: q.dim === 'channel' ? (CHANNEL_NAME[r.label] ?? r.label) : r.label,
      attribution: r.attribution,
      orders: r.orders,
      partialOrders: r.partial,
      qty: r.qty === null ? null : String(r.qty),
      revenueCents: R(r.revenue),
      cogsCents: R(r.cogs),
      logisticsCents: R(r.logistics),
      feesCents: R(r.fees),
      taxesCents: R(r.taxes),
      returnsCents: R(r.returns),
      otherCents: R(r.other),
      marginCents: R(r.margin),
      marginPct: pct(Number(r.margin), Number(r.revenue)),
    }));
    const total = rows.length ? Number(rows[0].total) : 0;
    if (csv)
      return sendCsv(
        reply,
        `rentabilidade-${q.dim}-${p.from}-${p.to}`,
        [q.dim, 'pedidos', 'pedidos_parciais', 'quantidade', 'receita', 'cmv', 'custos_logisticos', 'taxas_comissoes', 'tributos', 'devolucoes', 'outros', 'margem_contribuicao', 'margem_pct', 'atribuicao'],
        items.map((i) => [i.label, i.orders, i.partialOrders, i.qty === null ? null : Number(i.qty), reais(i.revenueCents), reais(i.cogsCents), reais(i.logisticsCents), reais(i.feesCents), reais(i.taxesCents), reais(i.returnsCents), reais(i.otherCents), reais(i.marginCents), i.marginPct, i.attribution]),
      );
    return {
      ...meta(q, p),
      dim: q.dim,
      items,
      total,
      page: q.page,
      pageSize: q.pageSize,
      notes: [
        q.dim === 'channel' || q.dim === 'uf'
          ? 'Soma dos pedidos inteiros do grupo.'
          : 'CMV e devolução vão direto ao item; frete, embalagem, taxas e tributos do pedido são rateados pela participação do item na receita de mercadoria.',
        ...(q.dim === 'supplier'
          ? ['Fornecedor: o da alocação do item quando houver; senão o fornecedor principal do produto (venda do estoque não guarda de qual compra saiu).']
          : []),
        NOTES.partial,
        NOTES.cohort,
      ],
    };
  });

  // -------------------------------------------------------------------------------------------------------------
  // Custos logisticos: componentes (pedidos do periodo), frete cobrado x pago por UF, por transportadora, perdas de
  // estoque (data do movimento).
  app.get('/logistics', async (req, reply) => {
    requirePermission(req, 'management.view');
    requireAnyPermission(req, 'costs.view', 'margins.view');
    const q = filterQuery.parse(req.query);
    const p = period(q);
    const b = base(filterOf(q, p));
    const [main, losses] = await Promise.all([
      q2(
        `${b.sql},
         fp AS (SELECT l.order_id, coalesce(-sum(l.amount) FILTER (WHERE l.nature = 'effective'), 0)::bigint AS paid, count(*) FILTER (WHERE l.nature = 'unknown')::int AS unknown
                FROM lines l WHERE l.comp = 'freight_paid' GROUP BY 1)
         SELECT
           (SELECT coalesce(json_agg(t ORDER BY t.comp, t.nature), '[]') FROM (
              SELECT l.comp, l.nature, coalesce(sum(l.amount), 0)::bigint AS cents, count(*)::int AS lines, count(DISTINCT l.order_id)::int AS orders
              FROM lines l WHERE l.grp IN ('logistics', 'returns') OR l.comp IN ('freight_charged', 'marketplace_shipping') GROUP BY 1, 2) t) AS components,
           (SELECT coalesce(json_agg(t ORDER BY t.orders DESC), '[]') FROM (
              SELECT coalesce(o.uf, '—') AS uf, count(*)::int AS orders, coalesce(sum(o.freight_cents), 0)::bigint AS charged,
                     coalesce(sum(fp.paid), 0)::bigint AS paid, count(fp.order_id) FILTER (WHERE fp.unknown > 0)::int AS unknown,
                     count(fp.order_id) FILTER (WHERE fp.unknown = 0)::int AS known,
                     coalesce(sum(o.freight_cents - fp.paid) FILTER (WHERE fp.unknown = 0), 0)::bigint AS balance_known
              FROM ord o LEFT JOIN fp ON fp.order_id = o.id GROUP BY 1) t) AS by_uf,
           (SELECT coalesce(json_agg(t ORDER BY t.shipments DESC), '[]') FROM (
              SELECT coalesce(nullif(s.carrier, ''), s.carrier_provider, 'Não informada') AS carrier, count(*)::int AS shipments,
                     count(*) FILTER (WHERE c.n > 0)::int AS with_cost, coalesce(sum(c.net), 0)::bigint AS paid
              FROM ord o JOIN shipments s ON s.order_id = o.id AND s.status <> 'canceled' AND ${STORE_CARRIER}
              LEFT JOIN LATERAL (SELECT count(*) AS n, sum(x.amount_cents) AS net FROM shipment_freight_costs x WHERE x.shipment_id = s.id) c ON true
              GROUP BY 1) t) AS by_carrier`,
        b.params,
      ),
      // Perdas de estoque: perda, avaria baixada e extravio na transferencia, valorizados pelo custo medio da baixa. A baixa
      // de avaria vinda de devolucao de cliente ou de fornecedor fica fora (ja aparece na margem do pedido ou na devolucao).
      q2(
        `WITH m AS (
           SELECT m.kind AS k, m.variant_id, -(m.on_hand_delta + m.damaged_delta + m.in_transit_delta) AS qty, m.avg_cost_after AS unit
           FROM stock_movements m
           WHERE m.kind IN ('loss', 'damage', 'transfer_loss') AND coalesce(m.source_type, '') NOT IN ('customer_return', 'supplier_return')
             AND m.created_at >= ($1::date)::timestamp AT TIME ZONE ${TZ} AND m.created_at < ($2::date + 1)::timestamp AT TIME ZONE ${TZ}
           UNION ALL
           SELECT o.kind, r.variant_id, -(r.on_hand_delta + r.damaged_delta + r.in_transit_delta), o.avg_cost_after
           FROM stock_movements r JOIN stock_movements o ON o.id = r.reverses_id
           WHERE r.kind = 'reversal' AND o.kind IN ('loss', 'damage', 'transfer_loss') AND coalesce(o.source_type, '') NOT IN ('customer_return', 'supplier_return')
             AND r.created_at >= ($1::date)::timestamp AT TIME ZONE ${TZ} AND r.created_at < ($2::date + 1)::timestamp AT TIME ZONE ${TZ}
         )
         SELECT k AS kind, count(*)::int AS movements, sum(qty)::text AS qty, coalesce(round(sum(qty * unit) FILTER (WHERE unit > 0)), 0)::bigint AS cents,
                count(*) FILTER (WHERE coalesce(unit, 0) = 0)::int AS unknown
         FROM m GROUP BY 1 ORDER BY 1`,
        [p.from, p.to],
      ),
    ]);
    const r = main.rows[0];
    const components = (r.components as { comp: string; nature: string; cents: string; lines: number; orders: number }[]).map((c) => ({
      component: c.comp,
      label: COMPONENT_LABEL[c.comp] ?? c.comp,
      nature: c.nature,
      cents: c.nature === 'unknown' ? null : Number(c.cents),
      lines: c.lines,
      orders: c.orders,
    }));
    const byUf = (r.by_uf as Record<string, string | number>[]).map((u) => ({
      uf: u.uf,
      orders: Number(u.orders),
      freightChargedCents: Number(u.charged),
      freightPaidCents: Number(u.paid),
      ordersFreightUnknown: Number(u.unknown),
      ordersFreightKnown: Number(u.known),
      balanceKnownCents: Number(u.balance_known),
    }));
    const byCarrier = (r.by_carrier as Record<string, string | number>[]).map((c) => ({ carrier: c.carrier, shipments: Number(c.shipments), withCost: Number(c.with_cost), freightPaidCents: Number(c.paid) }));
    const LOSS: Record<string, string> = { loss: 'Perda', damage: 'Avaria baixada', transfer_loss: 'Extravio na transferência' };
    const stockLosses = losses.rows.map((l) => ({ kind: l.kind, label: LOSS[l.kind] ?? l.kind, movements: l.movements, qty: l.qty, cents: Number(l.cents), unknownMovements: l.unknown }));
    if (q.format === 'csv')
      return sendCsv(
        reply,
        `custos-logisticos-${p.from}-${p.to}`,
        ['secao', 'item', 'natureza', 'valor', 'pedidos_ou_movimentos', 'observacao'],
        [
          ...components.map((c) => ['componente', c.label, c.nature, reais(c.cents), c.orders, '']),
          ...byUf.map((u) => ['frete por UF', u.uf, '', reais(u.freightChargedCents - u.freightPaidCents), u.orders, `cobrado ${reais(u.freightChargedCents)}; pago ${reais(u.freightPaidCents)}; sem custo ${u.ordersFreightUnknown}`]),
          ...byCarrier.map((c) => ['transportadora', c.carrier, '', reais(c.freightPaidCents), c.shipments, `com custo ${c.withCost}`]),
          ...stockLosses.map((l) => ['perda de estoque (data do movimento)', l.label, l.unknownMovements ? 'parcial' : 'efetivo', reais(l.cents), l.movements, `sem custo ${l.unknownMovements}`]),
        ],
      );
    return {
      ...meta(q, p),
      components,
      byUf,
      byCarrier,
      stockLosses: { basis: 'data do movimento', items: stockLosses, totalCents: stockLosses.reduce((s, l) => s + l.cents, 0) },
      notes: [
        'Componentes, frete por UF e por transportadora: pedidos do período, pela base escolhida. Perda de estoque: pela data do movimento (não filtra canal, UF nem demonstração).',
        'Frete pago desconhecido fica fora da diferença cobrado × pago (a diferença usa só os pedidos com o frete pago informado).',
        NOTES.cohort,
      ],
    };
  });

  // -------------------------------------------------------------------------------------------------------------
  // Desempenho de fornecedores (recebimentos no periodo, pela data do recebimento).
  app.get('/suppliers', async (req, reply) => {
    requirePermission(req, 'management.view');
    requireAnyPermission(req, 'costs.view', 'purchases.view');
    const q = filterQuery.extend(pageQuery.shape).parse(req.query);
    const p = period(q);
    const demo = q.demo === 'exclude' ? `AND su.name NOT LIKE '%(demonstração)%'` : q.demo === 'only' ? `AND su.name LIKE '%(demonstração)%'` : '';
    const csv = q.format === 'csv';
    const limit = csv ? CSV_MAX : q.pageSize;
    const offset = csv ? 0 : (q.page - 1) * q.pageSize;
    const range = (col: string) => `${col} >= ($1::date)::timestamp AT TIME ZONE ${TZ} AND ${col} < ($2::date + 1)::timestamp AT TIME ZONE ${TZ}`;
    const { rows } = await q2(
      `WITH r AS (
         SELECT pr.id, pr.received_at, po.supplier_id, coalesce(po.promised_at, po.expected_at) AS promised
         FROM purchase_receipts pr JOIN purchase_orders po ON po.id = pr.order_id WHERE ${range('pr.received_at')}
       ),
       h AS (
         SELECT ri.receipt_id, ri.item_id, ri.unit_cost_cents, ri.base_qty,
                lag(ri.unit_cost_cents) OVER (PARTITION BY po.supplier_id, poi.variant_id ORDER BY pr.received_at, pr.id) AS prev
         FROM purchase_receipt_items ri JOIN purchase_receipts pr ON pr.id = ri.receipt_id JOIN purchase_orders po ON po.id = pr.order_id
         JOIN purchase_order_items poi ON poi.id = ri.item_id
         WHERE po.supplier_id IN (SELECT supplier_id FROM r) AND pr.received_at < ($2::date + 1)::timestamp AT TIME ZONE ${TZ}
       ),
       it AS (
         SELECT r.supplier_id, ri.packs, ri.base_qty, ri.unit_cost_cents, ri.rejected_packs, poi.pack_cost_cents, ri.invoiced_pack_cost_cents, h.prev
         FROM r JOIN purchase_receipt_items ri ON ri.receipt_id = r.id JOIN purchase_order_items poi ON poi.id = ri.item_id
         LEFT JOIN h ON h.receipt_id = ri.receipt_id AND h.item_id = ri.item_id
       ),
       g AS (
         SELECT su.id, su.name, su.name LIKE '%(demonstração)%' AS demo,
                (SELECT count(*) FROM r WHERE r.supplier_id = su.id)::int AS receipts,
                (SELECT count(*) FROM r WHERE r.supplier_id = su.id AND r.promised IS NOT NULL AND (r.received_at AT TIME ZONE ${TZ})::date <= r.promised)::int AS on_time,
                (SELECT count(*) FROM r WHERE r.supplier_id = su.id AND r.promised IS NOT NULL AND (r.received_at AT TIME ZONE ${TZ})::date > r.promised)::int AS late,
                (SELECT count(*) FROM purchase_receipt_issues x JOIN r ON r.id = x.receipt_id WHERE r.supplier_id = su.id)::int AS issues,
                (SELECT round(sum(it.base_qty * it.unit_cost_cents)) FROM it WHERE it.supplier_id = su.id) AS received,
                (SELECT round(sum(it.packs * it.pack_cost_cents)) FROM it WHERE it.supplier_id = su.id) AS ordered,
                (SELECT round(sum(it.packs * (coalesce(it.invoiced_pack_cost_cents, it.pack_cost_cents) - it.pack_cost_cents))) FROM it WHERE it.supplier_id = su.id) AS invoice_diff,
                (SELECT sum((it.unit_cost_cents - it.prev) * it.base_qty) / nullif(sum(it.prev * it.base_qty), 0) * 100 FROM it WHERE it.supplier_id = su.id AND it.prev > 0) AS cost_change_pct,
                (SELECT coalesce(sum(it.rejected_packs), 0) FROM it WHERE it.supplier_id = su.id)::text AS rejected_packs,
                (SELECT count(*) FROM supplier_returns sr WHERE sr.supplier_id = su.id AND sr.status <> 'canceled' AND ${range('sr.created_at')})::int AS supplier_returns
         FROM suppliers su WHERE su.id IN (SELECT supplier_id FROM r) ${demo}
       )
       SELECT g.*, count(*) OVER () AS total FROM g ORDER BY g.received DESC NULLS LAST, g.name LIMIT ${limit} OFFSET ${offset}`,
      [p.from, p.to],
    );
    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      demo: r.demo,
      receipts: r.receipts,
      onTime: r.on_time,
      late: r.late,
      withoutPromise: r.receipts - r.on_time - r.late,
      onTimePct: pct(r.on_time, r.on_time + r.late),
      issues: r.issues,
      receivedCents: r.received === null ? null : Number(r.received),
      orderedCents: r.ordered === null ? null : Number(r.ordered),
      invoiceDiffCents: r.invoice_diff === null ? null : Number(r.invoice_diff),
      costChangePct: r.cost_change_pct === null ? null : Math.round(Number(r.cost_change_pct) * 10) / 10,
      rejectedPacks: r.rejected_packs,
      supplierReturns: r.supplier_returns,
    }));
    const total = rows.length ? Number(rows[0].total) : 0;
    if (csv)
      return sendCsv(
        reply,
        `fornecedores-${p.from}-${p.to}`,
        ['fornecedor', 'demonstracao', 'recebimentos', 'no_prazo', 'atrasados', 'sem_prazo', 'pct_no_prazo', 'ocorrencias_recebimento', 'valor_recebido', 'valor_pedido', 'diferenca_nota', 'variacao_custo_pct', 'embalagens_recusadas', 'devolucoes_ao_fornecedor'],
        items.map((i) => [i.name, i.demo ? 'sim' : 'não', i.receipts, i.onTime, i.late, i.withoutPromise, i.onTimePct, i.issues, reais(i.receivedCents), reais(i.orderedCents), reais(i.invoiceDiffCents), i.costChangePct, Number(i.rejectedPacks), i.supplierReturns]),
      );
    return {
      ...meta(q, p),
      period: { ...p, basis: 'received', basisLabel: 'data do recebimento' },
      items,
      total,
      page: q.page,
      pageSize: q.pageSize,
      notes: [
        'Recebimentos pela data do recebimento (canal e UF não se aplicam). Prazo: o prometido na confirmação ou o previsto na compra; sem prazo informado, fica fora do percentual.',
        'Variação de custo: custo unitário do recebimento comparado ao recebimento anterior do mesmo item e fornecedor, ponderado pela quantidade.',
        'Diferença de nota: valor da nota menos o valor combinado na compra, nas embalagens recebidas.',
      ],
    };
  });

  // -------------------------------------------------------------------------------------------------------------
  // Indicadores operacionais (pedidos do periodo) e situacao atual (agora).
  app.get('/indicators', async (req) => {
    const auth = requirePermission(req, 'management.view');
    const q = filterQuery.parse(req.query);
    const p = period(q);
    const params: unknown[] = [];
    const f = filterOf(q, p);
    const ord = ordCte(f, params);
    const demo = q.demo === 'exclude' ? `AND NOT x.demo` : q.demo === 'only' ? `AND x.demo` : '';
    const { rows } = await q2(
      `WITH ${ord},
       fs AS (SELECT o.id, o.paid_at, min(s.shipped_at) AS first_ship FROM ord o LEFT JOIN shipments s ON s.order_id = o.id AND s.status <> 'canceled' GROUP BY 1, 2),
       dl AS (SELECT s.shipped_at, s.delivered_at FROM ord o JOIN shipments s ON s.order_id = o.id AND s.status <> 'canceled' AND s.kind <> 'pickup'
              WHERE s.shipped_at IS NOT NULL AND s.delivered_at IS NOT NULL AND s.delivered_at >= s.shipped_at)
       SELECT
         (SELECT count(*) FROM ord)::int AS orders,
         (SELECT count(*) FROM fs WHERE first_ship IS NOT NULL)::int AS dispatched,
         (SELECT round((avg(extract(epoch FROM first_ship - paid_at)) / 3600)::numeric, 1) FROM fs WHERE first_ship IS NOT NULL AND paid_at IS NOT NULL AND first_ship >= paid_at) AS dispatch_avg_h,
         (SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_ship - paid_at)) / 3600)::numeric, 1) FROM fs WHERE first_ship IS NOT NULL AND paid_at IS NOT NULL AND first_ship >= paid_at) AS dispatch_median_h,
         (SELECT count(*) FROM dl)::int AS delivered,
         (SELECT round((avg(extract(epoch FROM delivered_at - shipped_at)) / 86400)::numeric, 1) FROM dl) AS delivery_avg_d,
         (SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM delivered_at - shipped_at)) / 86400)::numeric, 1) FROM dl) AS delivery_median_d,
         (SELECT count(DISTINCT lo.order_id) FROM logistic_occurrences lo JOIN ord o ON o.id = lo.order_id WHERE lo.status <> 'canceled')::int AS with_occurrence,
         (SELECT count(DISTINCT cr.order_id) FROM customer_returns cr JOIN ord o ON o.id = cr.order_id WHERE cr.status <> 'canceled')::int AS with_return,
         (SELECT count(DISTINCT rr.order_id) FROM refund_records rr JOIN ord o ON o.id = rr.order_id WHERE rr.status IN ('done', 'confirmed'))::int AS with_refund,
         -- Agora (nao depende do periodo).
         (SELECT count(*) FROM shipments s JOIN orders x0 ON x0.id = s.order_id CROSS JOIN LATERAL (SELECT ${demoSql('x0')} AS demo) x
          WHERE s.status IN ('shipped', 'in_transit', 'out_for_delivery') AND s.delivered_at IS NULL
            AND coalesce(s.last_tracking_event_at, s.shipped_at) < now() - interval '3 days' ${demo})::int AS stale_tracking,
         (SELECT count(*) FROM orders x0 CROSS JOIN LATERAL (SELECT ${demoSql('x0')} AS demo) x
          WHERE x0.status IN ('paid', 'preparing', 'ready') AND x0.replacement_for_return_id IS NULL AND x0.paid_at < now() - interval '2 days' ${demo})::int AS waiting_dispatch,
         (SELECT count(*) FROM logistic_occurrences lo JOIN orders x0 ON x0.id = lo.order_id CROSS JOIN LATERAL (SELECT ${demoSql('x0')} AS demo) x
          WHERE lo.status IN ('open', 'in_progress') ${demo})::int AS open_occurrences`,
      params,
    );
    const r = rows[0];
    const out: Record<string, unknown> = {
      ...meta(q, p),
      period: { orders: r.orders, dispatched: r.dispatched, delivered: r.delivered },
      dispatch: { avgHours: num(r.dispatch_avg_h), medianHours: num(r.dispatch_median_h), label: 'pagamento até o primeiro despacho ou retirada' },
      delivery: { avgDays: num(r.delivery_avg_d), medianDays: num(r.delivery_median_d), label: 'despacho até a entrega (sem retirada)' },
      rates: {
        occurrencePct: pct(r.with_occurrence, r.orders),
        returnPct: pct(r.with_return, r.orders),
        refundPct: pct(r.with_refund, r.orders),
        withOccurrence: r.with_occurrence,
        withReturn: r.with_return,
        withRefund: r.with_refund,
      },
      now: { staleTracking: r.stale_tracking, waitingDispatch: r.waiting_dispatch, openOccurrences: r.open_occurrences },
      notes: [
        `Taxas e prazos: pedidos do período pela ${BASIS_LABEL[q.basis as Basis]}. "Agora" é a situação atual: rastreio parado há mais de 3 dias, pedido pago há mais de 2 dias sem despacho e ocorrência aberta.`,
      ],
    };
    // Estoque (valor ao custo medio): so com costs.view.
    if (has(auth, 'costs.view')) {
      const s = (
        await q2(
          `SELECT coalesce(round(sum(b.on_hand * b.avg_cost_cents) FILTER (WHERE b.avg_cost_cents > 0)), 0)::bigint AS value,
                  count(*) FILTER (WHERE b.on_hand > 0 AND coalesce(b.avg_cost_cents, 0) = 0)::int AS without_cost,
                  count(*) FILTER (WHERE b.on_hand > 0)::int AS with_stock,
                  (SELECT coalesce(round(sum(-m.on_hand_delta * m.avg_cost_after) FILTER (WHERE m.avg_cost_after > 0)), 0)
                   FROM stock_movements m WHERE m.kind = 'sale'
                     AND m.created_at >= ($1::date)::timestamp AT TIME ZONE ${TZ} AND m.created_at < ($2::date + 1)::timestamp AT TIME ZONE ${TZ})::bigint AS cogs
           FROM stock_balances b`,
          [p.from, p.to],
        )
      ).rows[0];
      const value = Number(s.value);
      const cogs = Number(s.cogs);
      out.stock = {
        valueCents: value,
        variantsWithStock: s.with_stock,
        variantsWithoutCost: s.without_cost,
        status: s.without_cost > 0 ? 'partial' : 'complete',
        cogsPeriodCents: cogs,
        turnover: value > 0 ? Math.round((cogs / value) * 100) / 100 : null,
        coverageDays: cogs > 0 ? Math.round(value / (cogs / p.days)) : null,
        label: 'valor ao custo médio atual; giro = CMV das baixas de venda no período (data do movimento, todos os canais) ÷ valor do estoque',
      };
    }
    return out;
  });
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
