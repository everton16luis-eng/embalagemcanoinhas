'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { phoneText, QUOTE_STATUS, quoteState } from '@/components/sales';
import { Guard } from '@/components/shell';
import { Badge, Button, Empty, Input, Notice, PageHeader, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { money, when } from '@/lib/format';

type Row = { id: string; number: number; status: string; expired: boolean; buyer: { name: string; phone: string }; total_cents: string; valid_until: string; created_at: string; item_count: number; order_number: number | null };

function QuoteList() {
  const [status, setStatus] = useState('open');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const p = new URLSearchParams({ pageSize: '100' });
    if (status) p.set('status', status);
    if (q.trim()) p.set('q', q.trim());
    const t = setTimeout(() => api<{ items: Row[] }>(`/admin/sales-desk/quotes?${p}`).then((r) => setRows(r.items), (e) => setError(e.message)), 200);
    return () => clearTimeout(t);
  }, [status, q]);

  return (
    <>
      <PageHeader
        title="Orçamentos"
        description="Preço congelado até a validade. Compartilhe o link pelo WhatsApp; o cliente aceita e paga sem redigitar."
        actions={
          <Link href="/painel/balcao">
            <Button variant="primary">Novo orçamento</Button>
          </Link>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="">Todos</option>
          {Object.entries(QUOTE_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
        <Input type="search" aria-label="Buscar" placeholder="Cliente, telefone ou número" value={q} onChange={(e) => setQ(e.target.value)} className="w-auto min-w-56 flex-1 sm:flex-none" />
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {rows && (
        <div className="overflow-x-auto rounded-lg border border-line bg-card">
          {rows.length === 0 ? (
            <Empty title="Nenhum orçamento nesta situação." />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-sunken/60 text-left text-xs text-ink-soft">
                <tr>
                  <th className="py-2 pl-4 font-medium">Orçamento</th>
                  <th className="py-2 pl-3 font-medium">Situação</th>
                  <th className="hidden py-2 pl-3 font-medium sm:table-cell">Validade</th>
                  <th className="py-2 pr-4 pl-3 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => {
                  const s = QUOTE_STATUS[quoteState(r)]!;
                  return (
                    <tr key={r.id} className="hover:bg-sunken/40">
                      <td className="py-2.5 pl-4">
                        <Link href={`/painel/orcamentos/${r.id}`} className="block">
                          <span className="font-medium hover:underline">
                            Nº {r.number} · {r.buyer.name}
                          </span>
                          <span className="block text-xs text-ink-faint">
                            {phoneText(r.buyer.phone)} · {r.item_count} item(ns) · {when(r.created_at)}
                          </span>
                        </Link>
                      </td>
                      <td className="py-2.5 pl-3">
                        <Badge tone={s.tone}>{s.label}</Badge>
                        {r.order_number && <span className="ml-2 text-xs text-ink-soft">Pedido {r.order_number}</span>}
                      </td>
                      <td className="hidden py-2.5 pl-3 sm:table-cell">{new Date(`${r.valid_until.slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR')}</td>
                      <td className="num py-2.5 pr-4 pl-3 text-right">{money(r.total_cents)}</td>
                    </tr>
                  );
                })}
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
    <Guard perm="sales_desk.use">
      <QuoteList />
    </Guard>
  );
}
