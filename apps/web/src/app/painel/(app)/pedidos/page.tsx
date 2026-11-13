'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CHANNEL_LABEL, INVOICE_STATUS, METHOD_LABEL, ORDER_STATUS } from '@/components/orders';
import { Guard } from '@/components/shell';
import { Badge, Empty, Input, Notice, PageHeader, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { money, when } from '@/lib/format';

type Row = {
  id: string;
  number: number;
  status: string;
  buyer_name: string;
  channel: string;
  payment_method: string;
  total_cents: string;
  invoice_status: string;
  has_backorder: boolean;
  shipping_name: string;
  shipping_kind: string;
  created_at: string;
};
type Data = { orders: Row[]; total: number; counts: { status: string; n: number }[] };

function OrderList() {
  const [status, setStatus] = useState('open');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const params = new URLSearchParams({ pageSize: '100' });
    if (status) params.set('status', status);
    if (term) params.set('q', term);
    api<Data>(`/admin/orders?${params}`).then(setData, (e) => setError(e.message));
  }, [status, term]);

  const count = (s: string) => data?.counts.find((c) => c.status === s)?.n ?? 0;

  return (
    <>
      <PageHeader title="Pedidos" description="Pedidos da loja: pagamento, separação, nota fiscal e despacho." />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="open">Para atender ({count('paid') + count('preparing') + count('ready')})</option>
          <option value="">Todos</option>
          {Object.entries(ORDER_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label} ({count(k)})
            </option>
          ))}
        </Select>
        <Input aria-label="Buscar pedido" placeholder="Nº, nome ou e-mail" value={q} onChange={(e) => setQ(e.target.value)} className="w-64 max-w-full" />
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {data && (
        <div className="overflow-x-auto rounded-lg border border-line bg-card">
          {data.orders.length === 0 ? (
            <Empty title="Nenhum pedido aqui." />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-sunken/60 text-left text-xs text-ink-soft">
                <tr>
                  <th className="py-2 pl-4 font-medium">Pedido</th>
                  <th className="py-2 pl-3 font-medium">Situação</th>
                  <th className="hidden py-2 pl-3 font-medium md:table-cell">Entrega</th>
                  <th className="py-2 pr-4 pl-3 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.orders.map((o) => (
                  <tr key={o.id} className="hover:bg-sunken/40">
                    <td className="py-2.5 pl-4">
                      <Link href={`/painel/pedidos/${o.id}`} className="block">
                        <span className="font-medium hover:underline">
                          Nº {o.number} · {o.buyer_name}
                        </span>
                        <span className="block text-xs text-ink-faint">
                          {when(o.created_at)} · {METHOD_LABEL[o.payment_method]}
                          {o.channel && o.channel !== 'store' && ` · ${CHANNEL_LABEL[o.channel] ?? o.channel}`}
                        </span>
                      </Link>
                    </td>
                    <td className="py-2.5 pl-3">
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={ORDER_STATUS[o.status]!.tone}>{ORDER_STATUS[o.status]!.label}</Badge>
                        {['paid', 'preparing', 'ready'].includes(o.status) && <Badge tone={INVOICE_STATUS[o.invoice_status]!.tone}>{INVOICE_STATUS[o.invoice_status]!.label}</Badge>}
                        {o.has_backorder && <Badge tone="warn">Encomenda</Badge>}
                      </div>
                    </td>
                    <td className="hidden py-2.5 pl-3 md:table-cell">{o.shipping_name}</td>
                    <td className="num py-2.5 pr-4 pl-3 text-right">{money(o.total_cents)}</td>
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
    <Guard perm="orders.view">
      <OrderList />
    </Guard>
  );
}
