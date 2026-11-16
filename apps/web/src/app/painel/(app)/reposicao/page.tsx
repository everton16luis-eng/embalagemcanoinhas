'use client';

import Link from '@/components/painel-link';
import { useEffect, useState } from 'react';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Empty, Field, Input, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { money, qty, unitMoney } from '@/lib/format';

type Option = {
  supplierId: string;
  supplierName: string;
  packagingId: string;
  label: string;
  baseQtyPerPack: string;
  packs: number;
  buyQty: number;
  unitCostCents: number;
  totalCents: number;
  leadTimeDays: number | null;
  coverageDays: number | null;
  excess: boolean;
  recommended: boolean;
};
type Item = {
  variantId: string;
  sku: string;
  productName: string;
  baseUnit: string;
  available: number;
  inbound: number;
  minStock: string;
  soldInPeriod: number;
  dailyAvg: number;
  coverageDays: number | null;
  leadTimeDays: number;
  need: number;
  belowMin: boolean;
  options: Option[];
};

function Replenishment() {
  const { can } = useMe();
  const [params, setParams] = useState({ days: '90', coverDays: '30', maxCoverDays: '90' });
  const [items, setItems] = useState<Item[] | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ id: string; number: number; supplier: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setError('');
    api(`/admin/stock-reports/replenishment?${new URLSearchParams(params)}`).then(
      (r) => {
        setItems(r.items);
        setChoice(Object.fromEntries(r.items.map((i: Item) => [i.variantId, i.options.find((o) => o.recommended)?.packagingId ?? ''])));
      },
      (e) => setError(e.message),
    );
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  const chosen = (items ?? []).flatMap((i) => {
    const o = i.options.find((x) => x.packagingId === choice[i.variantId]);
    return o ? [{ item: i, option: o }] : [];
  });
  const bySupplier = new Map<string, { name: string; lines: typeof chosen }>();
  for (const c of chosen) {
    const g = bySupplier.get(c.option.supplierId) ?? { name: c.option.supplierName, lines: [] };
    g.lines.push(c);
    bySupplier.set(c.option.supplierId, g);
  }

  const createOrders = async () => {
    setBusy(true);
    setError('');
    const done: typeof created = [];
    try {
      for (const [supplierId, g] of bySupplier) {
        const r = await api('/admin/purchase-orders', {
          method: 'POST',
          body: { supplierId, notes: 'Gerado pela sugestão de reposição.', items: g.lines.map((l) => ({ packagingId: l.option.packagingId, packs: String(l.option.packs) })) },
        });
        done.push({ id: r.order.id, number: r.order.number, supplier: g.name });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreated(done);
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Sugestão de reposição"
        description="Pelo giro do período: quanto comprar para cobrir o prazo do fornecedor e a cobertura desejada, descontando o que já está a caminho. Embalagem maior só é recomendada se não deixar estoque parado além da cobertura máxima."
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
        className="mb-4 flex flex-wrap items-end gap-3"
      >
        {(
          [
            ['days', 'Giro dos últimos (dias)'],
            ['coverDays', 'Cobrir (dias)'],
            ['maxCoverDays', 'Cobertura máxima (dias)'],
          ] as const
        ).map(([k, label]) => (
          <Field key={k} label={label} className="w-40">
            {(id) => <Input id={id} inputMode="numeric" value={params[k]} onChange={(e) => setParams({ ...params, [k]: e.target.value })} />}
          </Field>
        ))}
        <Button>Recalcular</Button>
      </form>
      {error && (
        <div className="mb-4">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
      {created.length > 0 && (
        <div className="mb-4">
          <Notice tone="good">
            Pedidos criados como rascunho:{' '}
            {created.map((c, i) => (
              <span key={c.id}>
                {i > 0 && ', '}
                <Link className="underline" href={`/painel/compras/${c.id}`}>
                  nº {c.number} ({c.supplier})
                </Link>
              </span>
            ))}
            . Revise e marque como enviado.
          </Notice>
        </div>
      )}
      {items && items.length === 0 && (
        <div className="rounded-lg border border-line bg-card">
          <Empty title="Nada a repor agora.">Nenhum produto abaixo do mínimo ou sem cobertura para o prazo do fornecedor.</Empty>
        </div>
      )}
      {items && items.length > 0 && (
        <div className="space-y-3">
          {items.map((i) => (
            <section key={i.variantId} className="rounded-lg border border-line bg-card px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link href={`/painel/estoque/${i.variantId}`} className="font-medium hover:underline">
                    {i.productName}
                  </Link>
                  <p className="text-xs text-ink-faint">
                    <span className="font-mono">{i.sku}</span> · disponível {qty(i.available)} · a caminho {qty(i.inbound)} · vendeu {qty(i.soldInPeriod)} ({qty(i.dailyAvg)}/dia) ·{' '}
                    {i.coverageDays === null ? 'sem venda no período' : `dura ~${i.coverageDays} dia(s)`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {i.belowMin && <Badge tone="warn">Abaixo do mínimo</Badge>}
                  <span className="num text-sm">
                    Comprar <strong>{qty(i.need)}</strong> {i.baseUnit}
                  </span>
                </div>
              </div>
              {i.options.length === 0 ? (
                <p className="mt-2 text-sm text-warn">Nenhum fornecedor com custo cadastrado para este item.</p>
              ) : (
                <fieldset className="mt-2 space-y-1">
                  <legend className="sr-only">Opções de compra</legend>
                  {i.options.map((o) => (
                    <label key={o.packagingId + o.supplierId} className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md px-2 py-1.5 text-sm hover:bg-sunken has-checked:bg-act-tint">
                      <input type="radio" name={i.variantId} checked={choice[i.variantId] === o.packagingId} onChange={() => setChoice({ ...choice, [i.variantId]: o.packagingId })} />
                      <span className="min-w-0 flex-1">
                        {o.packs} × {o.label} <span className="text-ink-faint">· {o.supplierName}</span>
                      </span>
                      <span className="num text-ink-soft">
                        {unitMoney(o.unitCostCents)}/{i.baseUnit}
                      </span>
                      <span className="num w-24 text-right font-medium">{money(o.totalCents)}</span>
                      <span className="w-36 text-right text-xs">
                        {o.excess ? <Badge tone="warn">Prende capital</Badge> : o.recommended ? <Badge tone="good">Recomendado</Badge> : null}
                        {o.coverageDays !== null && <span className="ml-1 text-ink-faint">{o.coverageDays} d</span>}
                      </span>
                    </label>
                  ))}
                  <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm text-ink-soft hover:bg-sunken">
                    <input type="radio" name={i.variantId} checked={!choice[i.variantId]} onChange={() => setChoice({ ...choice, [i.variantId]: '' })} /> Não comprar agora
                  </label>
                </fieldset>
              )}
            </section>
          ))}
          {can('purchases.manage') && bySupplier.size > 0 && (
            <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-card px-4 py-3 shadow-sm">
              <span className="text-sm">
                {chosen.length} item(ns) em {bySupplier.size} fornecedor(es) · {money(chosen.reduce((s, c) => s + c.option.totalCents, 0))}
              </span>
              <Button variant="primary" busy={busy} onClick={createOrders}>
                Criar pedidos de compra
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="purchases.view">
      <Replenishment />
    </Guard>
  );
}
