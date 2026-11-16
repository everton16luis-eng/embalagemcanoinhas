'use client';

import Link from '@/components/painel-link';
import { useEffect, useState } from 'react';
import { Guard } from '@/components/shell';
import { MOVEMENT_LABELS } from '@/components/stock';
import { Button, Field, Input, Notice, PageHeader, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { money, qty } from '@/lib/format';

type Summary = {
  from: string;
  to: string;
  valuation: { category: string; variants: number; on_hand: string; value_cents: string }[];
  alerts: { below_min: number; out: number; backorder: number };
  movements: { kind: string; count: number; qty: string; value_cents: string | null }[];
  topSold: { variant_id: string; sku: string; product_name: string; base_unit: string; qty: string }[];
  purchases: { receipts: number; value_cents: string | null };
};

function Reports() {
  const [range, setRange] = useState({ from: '', to: '' });
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const load = (r = range) => {
    const p = new URLSearchParams();
    if (r.from) p.set('from', r.from);
    if (r.to) p.set('to', r.to);
    api(`/admin/stock-reports/summary?${p}`).then(
      (d: Summary) => {
        setData(d);
        setRange({ from: d.from, to: d.to });
      },
      (e) => setError(e.message),
    );
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(), []);

  const total = data?.valuation.reduce((s, v) => s + Number(v.value_cents), 0) ?? 0;

  return (
    <>
      <PageHeader title="Relatórios de estoque" description="Valor em estoque pelo custo médio, alertas e movimentação do período." />
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
        <Button>Atualizar</Button>
      </form>
      {error && <Notice tone="bad">{error}</Notice>}
      {data && (
        <div className="space-y-5">
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-4">
            {[
              ['Valor em estoque', money(total)],
              ['Abaixo do mínimo', String(data.alerts.below_min)],
              ['Sem disponível', String(data.alerts.out)],
              ['Compras recebidas no período', money(data.purchases.value_cents ?? 0)],
            ].map(([label, value]) => (
              <div key={label} className="bg-card px-4 py-3">
                <dt className="text-xs text-ink-soft">{label}</dt>
                <dd className="num mt-0.5 text-xl font-semibold">{value}</dd>
              </div>
            ))}
          </dl>

          <div className="grid gap-5 lg:grid-cols-2">
            <Panel title="Valor por categoria">
              {data.valuation.length === 0 ? (
                <p className="text-sm text-ink-soft">Sem saldo em estoque.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-line">
                    {data.valuation.map((v) => (
                      <tr key={v.category}>
                        <td className="py-2">{v.category}</td>
                        <td className="num py-2 text-right text-ink-soft">{v.variants} item(ns)</td>
                        <td className="num py-2 pl-3 text-right font-medium">{money(v.value_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
            <Panel title="Movimentação no período">
              {data.movements.length === 0 ? (
                <p className="text-sm text-ink-soft">Nenhuma movimentação.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-line">
                    {data.movements.map((m) => (
                      <tr key={m.kind}>
                        <td className="py-2">{MOVEMENT_LABELS[m.kind] ?? m.kind}</td>
                        <td className="num py-2 text-right text-ink-soft">{m.count} lanç.</td>
                        <td className="num py-2 pl-3 text-right font-medium">{money(m.value_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </div>

          <Panel title="Mais vendidos no período" description="Em unidade base.">
            {data.topSold.length === 0 ? (
              <p className="text-sm text-ink-soft">Nenhuma venda registrada no período.</p>
            ) : (
              <ol className="divide-y divide-line text-sm">
                {data.topSold.map((t, i) => (
                  <li key={t.variant_id} className="flex justify-between gap-3 py-2">
                    <Link href={`/painel/estoque/${t.variant_id}`} className="hover:underline">
                      {i + 1}. {t.product_name} <span className="font-mono text-xs text-ink-faint">{t.sku}</span>
                    </Link>
                    <span className="num">
                      {qty(t.qty)} {t.base_unit}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="reports.view">
      <Reports />
    </Guard>
  );
}
