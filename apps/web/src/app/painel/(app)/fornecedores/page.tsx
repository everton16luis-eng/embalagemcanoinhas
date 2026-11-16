'use client';

import Link from '@/components/painel-link';
import { useEffect, useState } from 'react';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Empty, Input, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { formatCnpj, when } from '@/lib/format';

type Row = { id: string; name: string; document: string | null; city: string | null; uf: string | null; lead_time_days: number | null; active: boolean; offer_count: number; last_receipt_at: string | null };

function SupplierList() {
  const { can } = useMe();
  const [q, setQ] = useState('');
  const [data, setData] = useState<{ items: Row[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      const params = new URLSearchParams({ pageSize: '100', active: 'all' });
      if (q.trim()) params.set('q', q.trim());
      api(`/admin/suppliers?${params}`).then(setData, (e) => setError(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <>
      <PageHeader
        title="Fornecedores"
        description="Contatos, prazos e a lista de custos por embalagem, usada no pedido de compra e na comparação de preços."
        actions={can('purchases.manage') && <Link href="/painel/fornecedores/novo"><Button variant="primary">Novo fornecedor</Button></Link>}
      />
      <Input aria-label="Buscar" placeholder="Buscar por nome ou CNPJ" value={q} onChange={(e) => setQ(e.target.value)} className="mb-4 max-w-sm" />
      {error && <Notice tone="bad">{error}</Notice>}
      {data && (
        <div className="overflow-x-auto rounded-lg border border-line bg-card">
          {data.items.length === 0 ? (
            <Empty title={q ? 'Nenhum fornecedor encontrado.' : 'Nenhum fornecedor cadastrado.'} />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-sunken/60 text-left text-xs text-ink-soft">
                <tr>
                  <th className="py-2 pl-4 font-medium">Fornecedor</th>
                  <th className="hidden py-2 pl-3 font-medium sm:table-cell">Cidade</th>
                  <th className="py-2 pl-3 text-right font-medium">Itens</th>
                  <th className="hidden py-2 pr-4 pl-3 text-right font-medium md:table-cell">Última entrega</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.items.map((s) => (
                  <tr key={s.id} className="hover:bg-sunken/40">
                    <td className="py-2.5 pl-4">
                      <Link href={`/painel/fornecedores/${s.id}`} className="block">
                        <span className="font-medium hover:underline">{s.name}</span> {!s.active && <Badge>Inativo</Badge>}
                        <span className="block text-xs text-ink-faint">
                          {s.document ? formatCnpj(s.document) : 'Sem documento'}
                          {s.lead_time_days !== null && ` · entrega em ${s.lead_time_days} dia(s)`}
                        </span>
                      </Link>
                    </td>
                    <td className="hidden py-2.5 pl-3 sm:table-cell">{s.city ? `${s.city}/${s.uf ?? ''}` : '—'}</td>
                    <td className="num py-2.5 pl-3 text-right">{s.offer_count}</td>
                    <td className="hidden py-2.5 pr-4 pl-3 text-right md:table-cell">{when(s.last_receipt_at)}</td>
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
      <SupplierList />
    </Guard>
  );
}
