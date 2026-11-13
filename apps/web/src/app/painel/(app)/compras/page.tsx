'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Guard, useMe } from '@/components/shell';
import { PO_STATUS } from '@/components/stock';
import { Badge, Button, Empty, Notice, PageHeader, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { money, when } from '@/lib/format';

type Row = { id: string; number: number; supplier_name: string; status: string; expected_at: string | null; created_at: string; goods_cents: string; freight_cents: string; other_costs_cents: string; item_count: number };

function PurchaseList() {
  const { can } = useMe();
  const [status, setStatus] = useState('open');
  const [data, setData] = useState<{ items: Row[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const params = new URLSearchParams({ pageSize: '100' });
    if (status) params.set('status', status);
    api(`/admin/purchase-orders?${params}`).then(setData, (e) => setError(e.message));
  }, [status]);

  return (
    <>
      <PageHeader
        title="Compras"
        description="Pedido ao fornecedor, recebimento total ou parcial e custo de entrada com frete rateado."
        actions={
          <>
            {can('purchases.view') && (
              <Link href="/painel/reposicao">
                <Button>Sugestão de reposição</Button>
              </Link>
            )}
            {can('purchases.manage') && (
              <Link href="/painel/compras/novo">
                <Button variant="primary">Novo pedido</Button>
              </Link>
            )}
          </>
        }
      />
      <Select aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value)} className="mb-4 w-auto">
        <option value="open">Em aberto</option>
        <option value="">Todos</option>
        {Object.entries(PO_STATUS).map(([k, v]) => (
          <option key={k} value={k}>
            {v.label}
          </option>
        ))}
      </Select>
      {error && <Notice tone="bad">{error}</Notice>}
      {data && (
        <div className="overflow-x-auto rounded-lg border border-line bg-card">
          {data.items.length === 0 ? (
            <Empty title="Nenhum pedido de compra nesta situação." />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-sunken/60 text-left text-xs text-ink-soft">
                <tr>
                  <th className="py-2 pl-4 font-medium">Pedido</th>
                  <th className="py-2 pl-3 font-medium">Situação</th>
                  <th className="hidden py-2 pl-3 font-medium sm:table-cell">Previsão</th>
                  <th className="py-2 pr-4 pl-3 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.items.map((o) => (
                  <tr key={o.id} className="hover:bg-sunken/40">
                    <td className="py-2.5 pl-4">
                      <Link href={`/painel/compras/${o.id}`} className="block">
                        <span className="font-medium hover:underline">
                          Nº {o.number} · {o.supplier_name}
                        </span>
                        <span className="block text-xs text-ink-faint">
                          {o.item_count} item(ns) · criado {when(o.created_at)}
                        </span>
                      </Link>
                    </td>
                    <td className="py-2.5 pl-3">
                      <Badge tone={PO_STATUS[o.status]!.tone}>{PO_STATUS[o.status]!.label}</Badge>
                    </td>
                    <td className="hidden py-2.5 pl-3 sm:table-cell">{o.expected_at ? new Date(`${o.expected_at}T12:00:00`).toLocaleDateString('pt-BR') : '—'}</td>
                    <td className="num py-2.5 pr-4 pl-3 text-right">{money(Number(o.goods_cents) + Number(o.freight_cents) + Number(o.other_costs_cents))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="purchases.view">
      <PurchaseList />
    </Guard>
  );
}
