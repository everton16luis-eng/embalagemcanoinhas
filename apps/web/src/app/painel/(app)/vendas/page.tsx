'use client';

import { useEffect, useState } from 'react';
import { CHANNEL_LABEL, METHOD_LABEL } from '@/components/orders';
import { Guard } from '@/components/shell';
import { Badge, Button, Empty, Field, Input, Notice, PageHeader, Panel, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { money, qty } from '@/lib/format';

type Group = { key: string | null; orders: number; totalCents: number };
type Summary = {
  from: string;
  to: string;
  groupBy: 'day' | 'month';
  totals: { orders: number; totalCents: number; freightCents: number; discountCents: number; averageTicketCents: number };
  series: { period: string; orders: number; totalCents: number; freightCents: number; discountCents: number }[];
  byChannel: Group[];
  byPaymentMethod: Group[];
};
type ProductRow = {
  variantId: string;
  sku: string;
  productName: string;
  baseUnit: string;
  qty: string;
  orders: number;
  revenueCents: number;
  costCents: number;
  marginCents: number;
  marginPct: number | null;
  costMissing: boolean;
  sharePct: number;
  cumulativePct: number;
  abc: 'A' | 'B' | 'C';
};
type Products = {
  totals: { revenueCents: number; costCents: number; marginCents: number; costMissing: boolean };
  abc: { class: 'A' | 'B' | 'C'; products: number; revenueCents: number }[];
  products: ProductRow[];
};

const periodLabel = (p: string, g: 'day' | 'month') => {
  const [y, m, d] = p.split('-');
  return g === 'month' ? `${m}/${y}` : `${d}/${m}`;
};
const pct = (v: number | null) => (v === null ? '—' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);
const centsCsv = (c: number) => (c / 100).toFixed(2).replace('.', ',');

/** CSV com ; e decimal com virgula (abre direto no Excel em pt-BR). */
function downloadCsv(name: string, header: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = '﻿' + [header, ...rows].map((r) => r.map(esc).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Bars({ rows, label }: { rows: { key: string; value: number; note: string }[]; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-center gap-3 text-sm sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)]">
          <span className="truncate">{r.key}</span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1" aria-hidden>
              <span className="block h-3 rounded-sm bg-act" style={{ width: `${Math.max(1, (r.value / max) * 100)}%` }} />
            </span>
            <span className="num shrink-0 text-[13px]">{r.note}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function SalesReports() {
  const [range, setRange] = useState({ from: '', to: '', groupBy: 'day' as 'day' | 'month' });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [products, setProducts] = useState<Products | null>(null);
  const [abc, setAbc] = useState<'' | 'A' | 'B' | 'C'>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (r = range) => {
    const p = new URLSearchParams({ groupBy: r.groupBy });
    if (r.from) p.set('from', r.from);
    if (r.to) p.set('to', r.to);
    setBusy(true);
    setError('');
    try {
      const [s, pr] = await Promise.all([api<Summary>(`/admin/sales-reports/summary?${p}`), api<Products>(`/admin/sales-reports/products?${p}`)]);
      setSummary(s);
      setProducts(pr);
      setRange({ from: s.from, to: s.to, groupBy: s.groupBy });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = products?.products.filter((p) => !abc || p.abc === abc) ?? [];
  const t = summary?.totals;

  return (
    <>
      <PageHeader title="Relatórios de vendas" description="Pedidos pagos no período (data do pagamento, horário de Brasília), por canal, forma de pagamento e produto." />
      <form
        className="mb-5 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
      >
        <Field label="De" className="w-44">
          {(id) => <Input id={id} type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />}
        </Field>
        <Field label="Até" className="w-44">
          {(id) => <Input id={id} type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />}
        </Field>
        <Field label="Agrupar por" className="w-36">
          {(id) => (
            <Select id={id} value={range.groupBy} onChange={(e) => setRange({ ...range, groupBy: e.target.value as 'day' | 'month' })}>
              <option value="day">Dia</option>
              <option value="month">Mês</option>
            </Select>
          )}
        </Field>
        <Button busy={busy}>Atualizar</Button>
      </form>
      {error && <Notice tone="bad">{error}</Notice>}
      {summary && t && products && (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-2 lg:grid-cols-5">
            {[
              ['Pedidos pagos', String(t.orders)],
              ['Faturamento', money(t.totalCents)],
              ['Ticket médio', money(t.averageTicketCents)],
              ['Frete cobrado', money(t.freightCents)],
              ['Margem bruta (estimada)', money(products.totals.marginCents)],
            ].map(([label, v]) => (
              <div key={label} className="rounded-md border border-line bg-card px-3 py-2">
                <dt className="text-[13px] text-ink-faint">{label}</dt>
                <dd className="num text-lg font-semibold">{v}</dd>
              </div>
            ))}
          </dl>

          {t.orders === 0 ? (
            <Empty title="Nenhum pedido pago no período">Escolha outro período.</Empty>
          ) : (
            <>
              <Panel
                title={range.groupBy === 'month' ? 'Faturamento por mês' : 'Faturamento por dia'}
                actions={
                  <Button
                    onClick={() =>
                      downloadCsv(
                        `vendas-${summary.from}-a-${summary.to}.csv`,
                        ['Período', 'Pedidos', 'Faturamento', 'Frete', 'Descontos'],
                        summary.series.map((s) => [s.period, s.orders, centsCsv(s.totalCents), centsCsv(s.freightCents), centsCsv(s.discountCents)]),
                      )
                    }
                  >
                    Baixar CSV
                  </Button>
                }
              >
                <Bars
                  label="Faturamento por período"
                  rows={summary.series.map((s) => ({ key: periodLabel(s.period, summary.groupBy), value: s.totalCents, note: `${money(s.totalCents)} · ${s.orders} ped.` }))}
                />
              </Panel>
              <div className="grid gap-4 lg:grid-cols-2">
                <Panel title="Por canal">
                  <Bars
                    label="Faturamento por canal"
                    rows={summary.byChannel.map((g) => ({ key: CHANNEL_LABEL[g.key ?? ''] ?? g.key ?? '—', value: g.totalCents, note: `${money(g.totalCents)} · ${g.orders} ped.` }))}
                  />
                </Panel>
                <Panel title="Por forma de pagamento">
                  <Bars
                    label="Faturamento por forma de pagamento"
                    rows={summary.byPaymentMethod.map((g) => ({ key: METHOD_LABEL[g.key ?? ''] ?? g.key ?? '—', value: g.totalCents, note: `${money(g.totalCents)} · ${g.orders} ped.` }))}
                  />
                </Panel>
              </div>
            </>
          )}

          {products.products.length > 0 && (
            <Panel
              title="Produtos: margem e curva ABC"
              description="Curva ABC pelo faturamento: A soma os primeiros 80%, B os 15% seguintes, C o resto. Custo pelo custo médio na baixa do estoque (ou o atual, se o pedido ainda não saiu): é estimativa."
              actions={
                <Button
                  onClick={() =>
                    downloadCsv(
                      `produtos-${summary.from}-a-${summary.to}.csv`,
                      ['SKU', 'Produto', 'Quantidade', 'Unidade', 'Pedidos', 'Faturamento', 'Custo', 'Margem', 'Margem %', 'Participação %', 'Curva', 'Sem custo'],
                      products.products.map((p) => [
                        p.sku,
                        p.productName,
                        p.qty.replace('.', ','),
                        p.baseUnit,
                        p.orders,
                        centsCsv(p.revenueCents),
                        centsCsv(p.costCents),
                        centsCsv(p.marginCents),
                        p.marginPct === null ? '' : String(p.marginPct).replace('.', ','),
                        String(p.sharePct).replace('.', ','),
                        p.abc,
                        p.costMissing ? 'sim' : '',
                      ]),
                    )
                  }
                >
                  Baixar CSV
                </Button>
              }
            >
              {products.totals.costMissing && <Notice tone="warn">Há produtos sem custo cadastrado: a margem deles aparece cheia e infla o total.</Notice>}
              <div className="my-3 flex flex-wrap gap-2" role="group" aria-label="Filtrar pela curva">
                <Button variant={abc === '' ? 'primary' : 'secondary'} onClick={() => setAbc('')}>
                  Todos ({products.products.length})
                </Button>
                {products.abc.map((c) => (
                  <Button key={c.class} variant={abc === c.class ? 'primary' : 'secondary'} onClick={() => setAbc(c.class)}>
                    Curva {c.class} ({c.products}) · {money(c.revenueCents)}
                  </Button>
                ))}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[44rem] text-sm">
                  <thead className="text-left text-[13px] text-ink-faint">
                    <tr className="border-b border-line">
                      <th className="py-2 pr-3 font-medium">Produto</th>
                      <th className="py-2 pr-3 text-right font-medium">Quantidade</th>
                      <th className="py-2 pr-3 text-right font-medium">Faturamento</th>
                      <th className="py-2 pr-3 text-right font-medium">Custo</th>
                      <th className="py-2 pr-3 text-right font-medium">Margem</th>
                      <th className="py-2 pr-3 text-right font-medium">Part.</th>
                      <th className="py-2 font-medium">Curva</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((p) => (
                      <tr key={p.variantId} className="border-b border-line">
                        <td className="py-2 pr-3">
                          <span className="font-medium">{p.productName}</span>
                          <span className="block text-[12px] text-ink-faint">
                            {p.sku} · {p.orders} pedido(s)
                          </span>
                        </td>
                        <td className="num py-2 pr-3 text-right">
                          {qty(p.qty)} {p.baseUnit}
                        </td>
                        <td className="num py-2 pr-3 text-right">{money(p.revenueCents)}</td>
                        <td className="num py-2 pr-3 text-right">{p.costMissing ? <Badge tone="warn">Sem custo</Badge> : money(p.costCents)}</td>
                        <td className="num py-2 pr-3 text-right">
                          {money(p.marginCents)}
                          <span className="block text-[12px] text-ink-faint">{pct(p.marginPct)}</span>
                        </td>
                        <td className="num py-2 pr-3 text-right">{pct(p.sharePct)}</td>
                        <td className="py-2">
                          <Badge tone={p.abc === 'A' ? 'good' : p.abc === 'B' ? 'act' : 'neutral'}>{p.abc}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="reports.view">
      <SalesReports />
    </Guard>
  );
}
