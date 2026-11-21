// SGLog Fase 10: margem de contribuicao por pedido, com natureza e origem de cada componente (docs/41-sglog-fase10.md).
//
// Tudo e calculado no banco, numa consulta so de leitura: `lines` tem uma linha por componente de cada pedido do
// recorte (`ord`), e os relatorios agregam, paginam e filtram sobre ela sem trazer os pedidos para a memoria.
//
// Convencao: `amount` e a contribuicao para a margem em centavos (receita positiva, custo negativo). Natureza:
//   effective  registro do sistema, documento ou provedor, com origem rastreavel
//   estimated  regra validada em cost_settings (versao e vigencia na data do fato) ou referencia (custo medio atual)
//   unknown    sem registro e sem regra: amount NULL, fora do total, e o pedido fica "parcial"
//   info       informativo (reembolso so solicitado): fora do total
// Margem = soma de effective + estimated. Desconhecido nunca vira zero.
//
// CMV (custo da mercadoria vendida): o livro do estoque (moveStock, src/lib/stock.ts) grava na saida 'sale' o custo
// medio ponderado vigente (avg_cost_after); a saida nunca altera a media, entao esse e o custo por unidade que o livro
// baixou naquela saida. Ele vale como efetivo quando a media nao foi formada com saldo que entrou sem custo (entrada
// sem custo com media zero antes da venda: estimado) e e desconhecido quando a media era zero. Pedido sem baixa
// (nao despachado) usa o custo medio atual como estimativa. Estornos da baixa sao descontados.
import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';

export const TZ = `'America/Sao_Paulo'`;
export const PAID_SQL = `('paid', 'preparing', 'ready', 'shipped', 'delivered')`;
export const MARKETPLACE_SQL = `('mercadolivre', 'shopee')`;
export const CHANNELS = ['store', 'sales_desk', 'mercadolivre', 'shopee'] as const;

/** Pedido de demonstracao: comprador @demo.invalid ou conta de marketplace da demonstracao (DEMO-*). */
export const demoSql = (o = 'o') =>
  `(${o}.buyer->>'email' LIKE '%@demo.invalid' OR EXISTS (SELECT 1 FROM marketplace_orders dm JOIN marketplace_accounts da ON da.id = dm.account_id
     WHERE dm.order_id = ${o}.id AND da.external_id LIKE 'DEMO-%'))`;

export type Basis = 'paid' | 'order' | 'dispatch';
export type DemoMode = 'include' | 'exclude' | 'only';
export type OrderFilter = {
  from: string;
  to: string;
  basis: Basis;
  demo: DemoMode;
  channel?: string | null;
  uf?: string | null;
  orderId?: string | null;
  /** So os N ultimos pedidos pagos (conferencia C24). */
  latest?: number;
};

export const BASIS_LABEL: Record<Basis, string> = { paid: 'data do pagamento', order: 'data do pedido', dispatch: 'data do primeiro despacho' };

/** Intervalo [from, to] em datas de Brasilia (fim inclusivo) sobre uma coluna timestamptz. */
const rangeSql = (col: string, from: string, to: string) => `${col} >= (${from}::date)::timestamp AT TIME ZONE ${TZ} AND ${col} < (${to}::date + 1)::timestamp AT TIME ZONE ${TZ}`;

/**
 * Recorte de pedidos. Entra pedido pago (pago, em preparo, pronto, despachado, entregue); cancelado nao entra
 * (R10-7), nem o pedido de reposicao da troca (o custo dele vai para o pedido de origem).
 */
export function ordCte(f: OrderFilter, params: unknown[]) {
  const p = (v: unknown) => `$${params.push(v)}`;
  const w = [`o.status IN ${PAID_SQL}`, `o.replacement_for_return_id IS NULL`];
  if (f.orderId) w.push(`o.id = ${p(f.orderId)}::uuid`);
  else if (f.latest) w.push(`o.id IN (SELECT x.id FROM orders x WHERE x.paid_at IS NOT NULL ORDER BY x.paid_at DESC LIMIT ${p(Math.max(1, Math.min(2000, Math.trunc(f.latest))))})`);
  else {
    const from = p(f.from);
    const to = p(f.to);
    if (f.basis === 'paid') w.push(rangeSql('o.paid_at', from, to));
    else if (f.basis === 'order') w.push(rangeSql('o.created_at', from, to));
    else
      w.push(`o.id IN (SELECT s.order_id FROM shipments s WHERE s.status <> 'canceled' AND s.shipped_at IS NOT NULL
                       GROUP BY s.order_id HAVING ${rangeSql('min(s.shipped_at)', from, to)})`);
    if (f.channel) w.push(`o.channel = ${p(f.channel)}`);
    if (f.uf) w.push(`o.ship_to->>'uf' = ${p(f.uf)}`);
    if (f.demo === 'exclude') w.push(`NOT ${demoSql('o')}`);
    if (f.demo === 'only') w.push(demoSql('o'));
  }
  return `ord AS (
    SELECT o.id, o.number, o.channel, o.status, o.payment_method, o.shipping_option_id, o.subtotal_cents, o.discount_cents, o.freight_cents,
           o.total_cents, o.paid_at, o.created_at, o.ship_to->>'uf' AS uf, ${demoSql('o')} AS demo,
           (coalesce(o.paid_at, o.created_at) AT TIME ZONE ${TZ})::date AS fact_date,
           EXISTS (SELECT 1 FROM shipping_options so WHERE so.id = o.shipping_option_id AND so.kind = 'pickup') AS pickup
    FROM orders o WHERE ${w.join(' AND ')})`;
}

/** Versao validada de cost_settings vigente na data, a mais especifica primeiro. */
function setting(kind: string, alias: string, date: string, conds: string[], spec: string[]) {
  const order = spec.length ? `${spec.map((s) => `(${s} IS NOT NULL)::int`).join(' + ')} DESC, ` : '';
  return `LEFT JOIN LATERAL (
    SELECT cs.id, cs.number, cs.rate_pct, cs.fixed_cents, cs.base FROM cost_settings cs
    WHERE cs.kind = '${kind}' AND cs.status = 'validated' AND cs.valid_from <= ${date} AND (cs.valid_to IS NULL OR ${date} < cs.valid_to)
      ${conds.map((c) => `AND ${c}`).join(' ')}
    ORDER BY ${order}cs.valid_from DESC LIMIT 1) ${alias} ON true`;
}
// Valor estimado de um percentual + fixo sobre uma base (centavos inteiros, arredondado no fim).
const est = (base: string, a: string) => `(round(${base} * coalesce(${a}.rate_pct, 0) / 100) + coalesce(${a}.fixed_cents, 0))::bigint`;
const pct = (a: string) => `coalesce(trim_scale(${a}.rate_pct)::text || '%', '') || CASE WHEN ${a}.fixed_cents IS NOT NULL THEN ' + ' || ${a}.fixed_cents || ' centavos' ELSE '' END`;

// Remessa paga pela loja a uma transportadora (mesma regra do relatorio de frete da Fase 8).
export const STORE_CARRIER = `(s.kind = 'delivery' OR (s.kind = 'legacy' AND o.channel IN ('store', 'sales_desk') AND NOT o.pickup))`;
// Remessa que leva embalagem de envio (retirada fica de fora).
const PACKED_KIND = `(s.kind IN ('delivery', 'marketplace') OR (s.kind = 'legacy' AND NOT o.pickup))`;

/**
 * CTEs do calculo, depois de `ord`. Termina em `lines` (order_id, comp, grp, nature, amount, src, src_id, ref_id,
 * variant_id, detail) e `per` (um registro por pedido).
 */
export const LINES_SQL = `
items AS (
  SELECT i.order_id, i.variant_id, sum(i.packs * i.base_qty_per_pack) AS qty, sum(i.total_cents) AS rev
  FROM order_items i JOIN ord o ON o.id = i.order_id GROUP BY 1, 2
),
repl AS (
  SELECT r.order_id, x.id AS repl_id FROM orders x JOIN customer_returns r ON r.id = x.replacement_for_return_id JOIN ord o ON o.id = r.order_id
),
sales AS (
  SELECT o.id AS order_id, false AS exchange, m.id, m.variant_id, (-m.on_hand_delta - coalesce(rv.q, 0)) AS qty, m.avg_cost_after AS unit
  FROM ord o JOIN stock_movements m ON m.source_type = 'order' AND m.source_id = o.id::text AND m.kind = 'sale'
  LEFT JOIN LATERAL (SELECT sum(r.on_hand_delta) AS q FROM stock_movements r WHERE r.reverses_id = m.id) rv ON true
  UNION ALL
  SELECT rp.order_id, true, m.id, m.variant_id, (-m.on_hand_delta - coalesce(rv.q, 0)), m.avg_cost_after
  FROM repl rp JOIN stock_movements m ON m.source_type = 'order' AND m.source_id = rp.repl_id::text AND m.kind = 'sale'
  LEFT JOIN LATERAL (SELECT sum(r.on_hand_delta) AS q FROM stock_movements r WHERE r.reverses_id = m.id) rv ON true
),
zero AS (
  SELECT z.variant_id, min(z.id) AS first_id FROM stock_movements z
  WHERE z.variant_id IN (SELECT variant_id FROM sales) AND z.on_hand_delta > 0 AND z.unit_cost_cents IS NULL AND z.avg_cost_after = 0
    AND z.kind IN ('receipt', 'return', 'adjustment', 'inventory')
  GROUP BY z.variant_id
),
sold AS (SELECT order_id, variant_id, sum(qty) AS qty FROM sales WHERE NOT exchange GROUP BY 1, 2),
ent AS (
  SELECT x.order_id, x.kind,
         count(*) FILTER (WHERE x.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM order_cost_entries r WHERE r.reverses_id = x.id)) AS active,
         sum(x.amount_cents)::bigint AS net, string_agg(x.id::text, ',' ORDER BY x.id) AS ids,
         string_agg(DISTINCT x.source, ',') AS sources
  FROM order_cost_entries x JOIN ord o ON o.id = x.order_id GROUP BY 1, 2
),
pkg AS (
  SELECT o.id AS order_id, s.id AS shipment_id, s.seq, (coalesce(s.shipped_at, s.packed_at) AT TIME ZONE ${TZ})::date AS d,
         CASE WHEN g.p ? 'lengthMm' AND g.p ? 'widthMm' AND g.p ? 'heightMm'
              THEN (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[(g.p->>'lengthMm')::int, (g.p->>'widthMm')::int, (g.p->>'heightMm')::int]) x) END AS dims
  FROM ord o JOIN shipments s ON s.order_id = o.id AND s.status <> 'canceled' AND (s.packed_at IS NOT NULL OR s.shipped_at IS NOT NULL) AND ${PACKED_KIND}
  CROSS JOIN LATERAL (
    SELECT e.p FROM jsonb_array_elements(s.packages) AS e(p) WHERE jsonb_typeof(s.packages) = 'array' AND jsonb_array_length(s.packages) > 0
    UNION ALL
    SELECT NULL::jsonb FROM generate_series(1, greatest(coalesce(s.volumes, 1), 1)) WHERE s.packages IS NULL OR jsonb_array_length(s.packages) = 0
  ) g
),
pkg_cost AS (
  SELECT k.order_id, k.shipment_id, k.seq, t.id AS type_id, t.number AS type_number, t.packaging_code, t.fixed_cents AS type_cents,
         gn.id AS gen_id, gn.number AS gen_number, gn.fixed_cents AS gen_cents
  FROM pkg k
  LEFT JOIN LATERAL (
    SELECT cs.id, cs.number, cs.packaging_code, cs.fixed_cents FROM cost_settings cs
    WHERE k.dims IS NOT NULL AND cs.kind = 'packaging' AND cs.status = 'validated' AND cs.length_mm IS NOT NULL
      AND cs.valid_from <= k.d AND (cs.valid_to IS NULL OR k.d < cs.valid_to)
      AND (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[cs.length_mm, cs.width_mm, cs.height_mm]) x) = k.dims
    LIMIT 1) t ON true
  LEFT JOIN LATERAL (
    SELECT cs.id, cs.number, cs.fixed_cents FROM cost_settings cs
    WHERE t.id IS NULL AND cs.kind = 'packaging' AND cs.status = 'validated' AND cs.packaging_code IS NULL
      AND cs.valid_from <= k.d AND (cs.valid_to IS NULL OR k.d < cs.valid_to)
    LIMIT 1) gn ON true
),
rets AS (SELECT r.* FROM customer_returns r JOIN ord o ON o.id = r.order_id WHERE r.status <> 'canceled'),
lines AS (
  -- Receita: mercadoria, desconto e frete cobrado (efetivos, do pedido).
  SELECT o.id AS order_id, 'merchandise'::text AS comp, 'revenue'::text AS grp, 'effective'::text AS nature, o.subtotal_cents::bigint AS amount,
         'orders'::text AS src, o.id::text AS src_id, NULL::text AS ref_id, NULL::uuid AS variant_id, 'mercadoria vendida'::text AS detail
  FROM ord o
  UNION ALL SELECT o.id, 'discount', 'revenue', 'effective', -o.discount_cents, 'orders', o.id::text, NULL, NULL, 'desconto do pedido' FROM ord o WHERE o.discount_cents <> 0
  UNION ALL SELECT o.id, 'freight_charged', 'revenue', 'effective', o.freight_cents, 'orders', o.id::text, NULL, NULL, 'frete cobrado do cliente' FROM ord o WHERE o.freight_cents <> 0

  -- CMV pela baixa do estoque (e o da reposicao da troca, no pedido de origem).
  UNION ALL
  SELECT s.order_id, CASE WHEN s.exchange THEN 'exchange_cogs' ELSE 'cogs' END, 'cogs',
         CASE WHEN s.unit = 0 THEN 'unknown' WHEN z.first_id < s.id THEN 'estimated' ELSE 'effective' END,
         CASE WHEN s.unit > 0 THEN -round(s.qty * s.unit)::bigint END,
         'stock_movements', s.id::text, NULL, s.variant_id,
         CASE WHEN s.unit = 0 THEN 'baixa com custo médio zero (saldo sem custo)'
              WHEN z.first_id < s.id THEN 'custo médio da baixa formado com saldo que entrou sem custo'
              ELSE 'custo médio na baixa' END || CASE WHEN s.exchange THEN ' (reposição da troca)' ELSE '' END
  FROM sales s LEFT JOIN zero z ON z.variant_id = s.variant_id WHERE s.qty > 0
  -- CMV do que ainda nao saiu do estoque: custo medio atual.
  UNION ALL
  SELECT i.order_id, 'cogs_pending', 'cogs', CASE WHEN coalesce(b.avg_cost_cents, 0) > 0 THEN 'estimated' ELSE 'unknown' END,
         CASE WHEN coalesce(b.avg_cost_cents, 0) > 0 THEN -round((i.qty - coalesce(sd.qty, 0)) * b.avg_cost_cents)::bigint END,
         'stock_balances', i.variant_id::text, NULL, i.variant_id,
         CASE WHEN coalesce(b.avg_cost_cents, 0) > 0 THEN 'sem baixa no estoque: custo médio atual' ELSE 'sem baixa e sem custo médio' END
  FROM items i LEFT JOIN sold sd ON sd.order_id = i.order_id AND sd.variant_id = i.variant_id LEFT JOIN stock_balances b ON b.variant_id = i.variant_id
  WHERE i.qty - coalesce(sd.qty, 0) > 0

  -- Frete pago a transportadora, por remessa (Fase 8). Marketplace e retirada nao tem.
  UNION ALL
  SELECT o.id, 'freight_paid', 'logistics', CASE WHEN fc.n = 0 THEN 'unknown' ELSE 'effective' END, CASE WHEN fc.n > 0 THEN -fc.net END,
         'shipment_freight_costs', s.id::text, NULL, NULL,
         'remessa ' || s.seq || ': ' || CASE WHEN fc.n > 0 THEN 'frete pago informado'
                                             WHEN s.shipped_at IS NULL THEN 'ainda não despachada' ELSE 'custo do frete não informado' END
  FROM ord o JOIN shipments s ON s.order_id = o.id AND s.status <> 'canceled' AND ${STORE_CARRIER}
  LEFT JOIN LATERAL (SELECT count(*) AS n, coalesce(sum(c.amount_cents), 0)::bigint AS net FROM shipment_freight_costs c WHERE c.shipment_id = s.id) fc ON true
  UNION ALL
  SELECT o.id, 'freight_paid', 'logistics', 'unknown', NULL, 'orders', o.id::text, NULL, NULL, 'pedido ainda sem remessa de entrega'
  FROM ord o WHERE o.channel NOT IN ${MARKETPLACE_SQL} AND NOT o.pickup
    AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = o.id AND s.status <> 'canceled' AND ${STORE_CARRIER})

  -- Embalagem de envio: estimada por tipo de caixa (medidas iguais) ou pelo custo generico por volume.
  UNION ALL
  SELECT c.order_id, 'packaging', 'logistics', CASE WHEN coalesce(c.type_id, c.gen_id) IS NULL THEN 'unknown' ELSE 'estimated' END,
         CASE WHEN coalesce(c.type_id, c.gen_id) IS NOT NULL THEN -sum(coalesce(c.type_cents, c.gen_cents))::bigint END,
         CASE WHEN coalesce(c.type_id, c.gen_id) IS NULL THEN 'shipments' ELSE 'cost_settings' END,
         coalesce(c.type_id, c.gen_id, c.shipment_id)::text, c.shipment_id::text, NULL,
         'remessa ' || c.seq || ': ' || count(*) || ' volume(s) ' ||
         CASE WHEN c.type_id IS NOT NULL THEN 'do tipo ' || c.packaging_code || ' (configuração nº ' || c.type_number || ')'
              WHEN c.gen_id IS NOT NULL THEN 'pelo custo por volume (configuração nº ' || c.gen_number || ')'
              ELSE 'sem regra de custo de embalagem' END
  FROM pkg_cost c GROUP BY c.order_id, c.shipment_id, c.seq, c.type_id, c.type_number, c.packaging_code, c.gen_id, c.gen_number
  UNION ALL
  SELECT o.id, 'packaging', 'logistics', 'unknown', NULL, 'orders', o.id::text, NULL, NULL, 'ainda não embalado'
  FROM ord o WHERE NOT o.pickup AND NOT EXISTS (SELECT 1 FROM pkg k WHERE k.order_id = o.id)
    AND EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = o.id AND s.status <> 'canceled' AND ${PACKED_KIND}
                UNION ALL SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = o.id AND s.status <> 'canceled'))

  -- Taxa do meio de pagamento (loja e balcao): lancamento efetivo; senao a tabela validada; senao desconhecida.
  UNION ALL
  SELECT o.id, 'payment_fee', 'fees',
         CASE WHEN e.active > 0 THEN 'effective' WHEN f.id IS NOT NULL THEN 'estimated' ELSE 'unknown' END,
         CASE WHEN e.active > 0 THEN -e.net WHEN f.id IS NOT NULL THEN -${est('coalesce(p.amount_cents, o.total_cents)', 'f')} END,
         CASE WHEN e.active > 0 THEN 'order_cost_entries' WHEN f.id IS NOT NULL THEN 'cost_settings' ELSE 'payments' END,
         CASE WHEN e.active > 0 THEN e.ids WHEN f.id IS NOT NULL THEN f.id::text ELSE coalesce(p.id::text, o.id::text) END, p.id::text, NULL,
         CASE WHEN e.active > 0 THEN 'taxa lançada (' || e.sources || ')'
              WHEN f.id IS NOT NULL THEN 'tabela nº ' || f.number || ': ' || ${pct('f')}
              ELSE 'sem lançamento e sem tabela validada para ' || coalesce(p.method, o.payment_method) END
  FROM ord o
  LEFT JOIN ent e ON e.order_id = o.id AND e.kind = 'payment_fee'
  LEFT JOIN LATERAL (SELECT p.id, p.method, p.installments, p.amount_cents FROM payments p WHERE p.order_id = o.id AND p.status IN ('approved', 'refunded', 'charged_back')
                     ORDER BY p.created_at DESC LIMIT 1) p ON true
  ${setting('payment_fee', 'f', 'o.fact_date', ['(cs.channel IS NULL OR cs.channel = o.channel)', '(cs.payment_method IS NULL OR cs.payment_method = coalesce(p.method, o.payment_method))', '(cs.installments IS NULL OR cs.installments = coalesce(p.installments, 1))'], ['cs.channel', 'cs.payment_method', 'cs.installments'])}
  WHERE o.channel NOT IN ${MARKETPLACE_SQL}

  -- Comissao e tarifa do marketplace.
  UNION ALL
  SELECT o.id, 'marketplace_fees', 'fees',
         CASE WHEN coalesce(ec.active, 0) + coalesce(ef.active, 0) > 0 THEN 'effective' WHEN f.id IS NOT NULL THEN 'estimated' ELSE 'unknown' END,
         CASE WHEN coalesce(ec.active, 0) + coalesce(ef.active, 0) > 0 THEN -(coalesce(ec.net, 0) + coalesce(ef.net, 0))
              WHEN f.id IS NOT NULL THEN -${est('o.total_cents', 'f')} END,
         CASE WHEN coalesce(ec.active, 0) + coalesce(ef.active, 0) > 0 THEN 'order_cost_entries' WHEN f.id IS NOT NULL THEN 'cost_settings' ELSE 'orders' END,
         CASE WHEN coalesce(ec.active, 0) + coalesce(ef.active, 0) > 0 THEN concat_ws(',', ec.ids, ef.ids) WHEN f.id IS NOT NULL THEN f.id::text ELSE o.id::text END, NULL, NULL,
         CASE WHEN coalesce(ec.active, 0) + coalesce(ef.active, 0) > 0
                THEN 'lançado: ' || concat_ws(' e ', CASE WHEN ec.active > 0 THEN 'comissão' END, CASE WHEN ef.active > 0 THEN 'tarifa' END)
              WHEN f.id IS NOT NULL THEN 'tabela nº ' || f.number || ': ' || ${pct('f')}
              ELSE 'sem lançamento e sem tabela validada' END
  FROM ord o
  LEFT JOIN ent ec ON ec.order_id = o.id AND ec.kind = 'marketplace_commission'
  LEFT JOIN ent ef ON ef.order_id = o.id AND ef.kind = 'marketplace_fee'
  ${setting('marketplace_fee', 'f', 'o.fact_date', ['cs.channel = o.channel'], [])}
  WHERE o.channel IN ${MARKETPLACE_SQL}
  UNION ALL
  SELECT o.id, 'marketplace_shipping', 'fees', CASE WHEN e.active > 0 THEN 'effective' ELSE 'unknown' END, CASE WHEN e.active > 0 THEN -e.net END,
         CASE WHEN e.active > 0 THEN 'order_cost_entries' ELSE 'orders' END, coalesce(e.ids, o.id::text), NULL, NULL,
         CASE WHEN e.active > 0 THEN 'frete do marketplace lançado' ELSE 'frete cobrado pelo marketplace não lançado' END
  FROM ord o LEFT JOIN ent e ON e.order_id = o.id AND e.kind = 'marketplace_shipping'
  WHERE o.channel IN ${MARKETPLACE_SQL}

  -- Tributos: registrado (lancamento) ou estimado pela aliquota validada pelo contador. Nunca valor fiscal definitivo.
  UNION ALL
  SELECT o.id, CASE WHEN e.active > 0 THEN 'tax_recorded' ELSE 'tax_estimated' END, 'taxes',
         CASE WHEN e.active > 0 THEN 'effective' WHEN f.id IS NOT NULL THEN 'estimated' ELSE 'unknown' END,
         CASE WHEN e.active > 0 THEN -e.net
              WHEN f.id IS NOT NULL THEN -${est(`CASE WHEN f.base = 'merchandise' THEN o.subtotal_cents - o.discount_cents ELSE o.total_cents END`, 'f')} END,
         CASE WHEN e.active > 0 THEN 'order_cost_entries' WHEN f.id IS NOT NULL THEN 'cost_settings' ELSE 'orders' END,
         CASE WHEN e.active > 0 THEN e.ids WHEN f.id IS NOT NULL THEN f.id::text ELSE o.id::text END, NULL, NULL,
         CASE WHEN e.active > 0 THEN 'tributo registrado'
              WHEN f.id IS NOT NULL THEN 'estimativa, alíquota nº ' || f.number || ': ' || ${pct('f')} || CASE WHEN f.base = 'merchandise' THEN ' da mercadoria' ELSE ' do total' END
              ELSE 'sem alíquota validada pelo contador' END
  FROM ord o LEFT JOIN ent e ON e.order_id = o.id AND e.kind = 'tax'
  ${setting('tax_rate', 'f', 'o.fact_date', ['(cs.channel IS NULL OR cs.channel = o.channel)'], ['cs.channel'])}

  -- Outros custos lancados.
  UNION ALL
  SELECT e.order_id, 'other', 'other', 'effective', -e.net, 'order_cost_entries', e.ids, NULL, NULL, 'outros custos lançados'
  FROM ent e WHERE e.kind = 'other' AND e.active > 0

  -- Devolucao fisica (Fase 9): a mercadoria que voltou ao estoque (boa, quarentena, avariada) devolve o CMV pelo custo
  -- da conferencia; o descarte na conferencia nao devolve nada (o CMV fica); o descarte decidido na quarentena desfaz a
  -- devolucao do CMV. A avaria baixada depois e perda do estoque (relatorio de custos logisticos), nao do pedido.
  UNION ALL
  SELECT r.order_id, 'return_credit', 'returns',
         CASE WHEN i.unit_cost_cents IS NULL THEN 'unknown' WHEN i.cost_source = 'sale' THEN 'effective' ELSE 'estimated' END,
         CASE WHEN i.unit_cost_cents IS NOT NULL THEN (CASE WHEN i.reverses_id IS NULL THEN 1 ELSE -1 END) * round(i.qty * i.unit_cost_cents)::bigint END,
         'return_inspections', i.id::text, r.id::text, ri.variant_id,
         'devolução nº ' || r.number || ': ' || CASE i.condition WHEN 'good' THEN 'boa' WHEN 'quarantine' THEN 'quarentena' ELSE 'avariada' END
           || CASE WHEN i.reverses_id IS NOT NULL THEN ' (estorno da conferência)' ELSE '' END
           || CASE WHEN i.cost_source = 'current_avg' THEN ', custo médio atual' ELSE ', custo da venda' END
  FROM rets r JOIN return_inspections i ON i.return_id = r.id JOIN customer_return_items ri ON ri.id = i.return_item_id
  WHERE i.condition IN ('good', 'quarantine', 'damaged')
  UNION ALL
  SELECT r.order_id, 'return_loss', 'returns',
         CASE WHEN i.unit_cost_cents IS NULL THEN 'unknown' WHEN i.cost_source = 'sale' THEN 'effective' ELSE 'estimated' END,
         CASE WHEN i.unit_cost_cents IS NOT NULL THEN -round(q.qty * i.unit_cost_cents)::bigint END,
         'quarantine_decisions', q.id::text, r.id::text, ri.variant_id, 'devolução nº ' || r.number || ': descartada na quarentena'
  FROM rets r JOIN return_inspections i ON i.return_id = r.id JOIN quarantine_decisions q ON q.inspection_id = i.id
  JOIN customer_return_items ri ON ri.id = i.return_item_id
  WHERE q.decision = 'discard'
  UNION ALL
  SELECT r.order_id, 'return_discarded', 'returns', 'info', 0, 'return_inspections', i.id::text, r.id::text, ri.variant_id,
         'devolução nº ' || r.number || ': descartada na conferência (o CMV fica no pedido)'
  FROM rets r JOIN return_inspections i ON i.return_id = r.id JOIN customer_return_items ri ON ri.id = i.return_item_id
  WHERE i.condition = 'discarded' AND i.reverses_id IS NULL
  UNION ALL
  SELECT r.order_id, 'return_freight', 'returns', CASE WHEN r.return_freight_cents IS NOT NULL THEN 'effective' ELSE 'unknown' END,
         -r.return_freight_cents::bigint, 'customer_returns', r.id::text, NULL, NULL,
         'devolução nº ' || r.number || ': ' || CASE WHEN r.return_freight_cents IS NOT NULL THEN 'frete de volta informado' ELSE 'frete de volta não informado' END
  FROM rets r WHERE r.return_freight_cents IS NOT NULL OR r.return_method = 'carrier'

  -- Reembolso financeiro (Fase 9, so registro): confirmado e efetivo; realizado e nao conferido, estimado; solicitado,
  -- so informativo.
  UNION ALL
  SELECT f.order_id, 'refund', 'returns', CASE f.status WHEN 'confirmed' THEN 'effective' WHEN 'done' THEN 'estimated' ELSE 'info' END,
         -f.amount_cents::bigint, 'refund_records', f.id::text, f.return_id::text, NULL,
         'reembolso nº ' || f.number || ': ' || CASE f.status WHEN 'confirmed' THEN 'confirmado' WHEN 'done' THEN 'realizado, aguardando conferência' ELSE 'solicitado (fora do total)' END
  FROM refund_records f JOIN ord o ON o.id = f.order_id WHERE f.status <> 'canceled'
),
per AS (
  SELECT l.order_id,
         coalesce(sum(l.amount) FILTER (WHERE l.grp = 'revenue'), 0)::bigint AS revenue,
         coalesce(sum(l.amount) FILTER (WHERE l.grp = 'cogs' AND l.nature IN ('effective', 'estimated')), 0)::bigint AS cogs,
         coalesce(sum(l.amount) FILTER (WHERE l.grp = 'logistics' AND l.nature IN ('effective', 'estimated')), 0)::bigint AS logistics,
         coalesce(sum(l.amount) FILTER (WHERE l.grp = 'fees' AND l.nature IN ('effective', 'estimated')), 0)::bigint AS fees,
         coalesce(sum(l.amount) FILTER (WHERE l.grp = 'taxes' AND l.nature IN ('effective', 'estimated')), 0)::bigint AS taxes,
         coalesce(sum(l.amount) FILTER (WHERE l.comp = 'tax_estimated' AND l.nature = 'estimated'), 0)::bigint AS taxes_estimated,
         coalesce(sum(l.amount) FILTER (WHERE l.grp = 'returns' AND l.nature IN ('effective', 'estimated')), 0)::bigint AS returns,
         coalesce(sum(l.amount) FILTER (WHERE l.grp = 'other' AND l.nature IN ('effective', 'estimated')), 0)::bigint AS other,
         coalesce(sum(l.amount) FILTER (WHERE l.nature IN ('effective', 'estimated')), 0)::bigint AS margin,
         coalesce(sum(abs(l.amount)) FILTER (WHERE l.nature = 'estimated'), 0)::bigint AS estimated,
         count(*) FILTER (WHERE l.nature = 'unknown')::int AS unknown,
         coalesce(array_agg(DISTINCT l.comp) FILTER (WHERE l.nature = 'unknown'), '{}') AS missing
  FROM lines l GROUP BY l.order_id
)`;

export type MarginQuery = { sql: string; params: unknown[] };
export function marginBase(f: OrderFilter): MarginQuery {
  const params: unknown[] = [];
  return { sql: `WITH ${ordCte(f, params)},${LINES_SQL}`, params };
}

export const COMPONENT_LABEL: Record<string, string> = {
  merchandise: 'Mercadoria',
  discount: 'Desconto',
  freight_charged: 'Frete cobrado',
  cogs: 'CMV (baixa do estoque)',
  cogs_pending: 'CMV (sem baixa, estimado)',
  exchange_cogs: 'CMV da reposição da troca',
  freight_paid: 'Frete pago',
  packaging: 'Embalagem',
  payment_fee: 'Taxa do pagamento',
  marketplace_fees: 'Comissão e tarifa do marketplace',
  marketplace_shipping: 'Frete do marketplace',
  tax_recorded: 'Tributos registrados',
  tax_estimated: 'Tributos estimados',
  other: 'Outros custos',
  return_credit: 'Devolução ao estoque (CMV)',
  return_loss: 'Perda na devolução',
  return_discarded: 'Devolução descartada',
  return_freight: 'Frete de volta',
  refund: 'Reembolso',
};

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export type OrderMarginRow = {
  order_id: string;
  revenue: string;
  cogs: string;
  logistics: string;
  fees: string;
  taxes: string;
  taxes_estimated: string;
  returns: string;
  other: string;
  margin: string;
  estimated: string;
  unknown: number;
  missing: string[];
};

export const marginView = (r: OrderMarginRow) => {
  const revenue = Number(r.revenue);
  const margin = Number(r.margin);
  return {
    revenueCents: revenue,
    cogsCents: Number(r.cogs),
    logisticsCents: Number(r.logistics),
    feesCents: Number(r.fees),
    taxesCents: Number(r.taxes),
    taxesEstimatedCents: Number(r.taxes_estimated),
    returnsCents: Number(r.returns),
    otherCents: Number(r.other),
    marginCents: margin,
    marginPct: revenue > 0 ? Math.round((margin / revenue) * 1000) / 10 : null,
    estimatedCents: Number(r.estimated),
    status: r.unknown > 0 ? ('partial' as const) : ('complete' as const),
    missing: r.missing,
  };
};

/** Margem de um pedido com o detalhe de cada componente (rastreabilidade). Pedido fora do recorte: null. */
export async function orderMargin(db: Db | typeof pool, orderId: string) {
  const q = marginBase({ from: '2000-01-01', to: '2000-01-01', basis: 'paid', demo: 'include', orderId });
  const per = (await db.query<OrderMarginRow>(`${q.sql} SELECT * FROM per`, q.params)).rows[0];
  if (!per) return null;
  const lines = (
    await db.query(
      `${q.sql}
       SELECT l.comp, l.grp, l.nature, l.amount, l.src, l.src_id, l.ref_id, l.variant_id, v.sku, l.detail
       FROM lines l LEFT JOIN product_variants v ON v.id = l.variant_id
       ORDER BY array_position(ARRAY['revenue', 'cogs', 'logistics', 'fees', 'taxes', 'returns', 'other'], l.grp), l.comp, l.src_id`,
      q.params,
    )
  ).rows.map((l) => ({
    component: l.comp,
    label: COMPONENT_LABEL[l.comp] ?? l.comp,
    group: l.grp,
    nature: l.nature,
    amountCents: n(l.amount),
    source: { table: l.src, ids: String(l.src_id ?? '').split(',').filter(Boolean), ref: l.ref_id },
    sku: l.sku ?? null,
    detail: l.detail,
  }));
  return { ...marginView(per), lines };
}

/** Data (Brasilia) que define o periodo do pedido conforme a base escolhida (alias `o` = ord). */
export const basisDateSql = (basis: Basis) =>
  basis === 'paid'
    ? `(o.paid_at AT TIME ZONE ${TZ})::date`
    : basis === 'order'
      ? `(o.created_at AT TIME ZONE ${TZ})::date`
      : `((SELECT min(s.shipped_at) FROM shipments s WHERE s.order_id = o.id AND s.status <> 'canceled') AT TIME ZONE ${TZ})::date`;
