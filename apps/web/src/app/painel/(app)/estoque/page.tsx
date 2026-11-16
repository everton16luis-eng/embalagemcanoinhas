'use client';

import Link from '@/components/painel-link';
import { useEffect, useState } from 'react';
import { Guard } from '@/components/shell';
import { Badge, Empty, Input, Notice, PageHeader, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { qty, unitMoney } from '@/lib/format';

type Row = {
  variant_id: string;
  sku: string;
  label: string;
  base_unit: string;
  min_stock: string;
  availability_mode: string;
  on_hand: string;
  reserved: string;
  available: string;
  avg_cost_cents?: string;
  below_min: boolean;
};

const FILTERS: Record<string, string> = {
  all: 'Todos',
  below: 'Abaixo do mínimo',
  out: 'Sem disponível',
  reserved: 'Com reserva',
  backorder: 'Reservado além do físico',
};

function StockList() {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: Row[]; total: number } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => setPage(1), [q, filter]);
  useEffect(() => {
    const t = setTimeout(() => {
      const params = new URLSearchParams({ pageSize: '50', page: String(page), filter });
      if (q.trim()) params.set('q', q.trim());
      api(`/admin/stock?${params}`).then(setData, (e) => setError(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [q, filter, page]);

  const showCost = data?.items.some((r) => r.avg_cost_cents !== undefined);
  const pages = data ? Math.max(1, Math.ceil(data.total / 50)) : 1;

  return (
    <>
      <PageHeader title="Estoque" description="Saldo na unidade base de cada produto. Disponível = físico − reservado para pedidos e orçamentos." />
      <div className="mb-4 flex flex-wrap gap-2">
        <Input aria-label="Buscar" placeholder="Buscar por nome, SKU ou código de barras" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
        <Select aria-label="Filtro" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-auto">
          {Object.entries(FILTERS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {data && (
        <div className="overflow-x-auto rounded-lg border border-line bg-card">
          {data.items.length === 0 ? (
            <Empty title={q || filter !== 'all' ? 'Nada encontrado com esse filtro.' : 'Nenhum produto ativo.'} />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-sunken/60 text-left text-xs text-ink-soft">
                <tr>
                  <th className="py-2 pl-4 font-medium">Produto</th>
                  <th className="py-2 pr-4 pl-3 text-right font-medium sm:pr-0">Disponível</th>
                  <th className="hidden py-2 pl-3 text-right font-medium sm:table-cell">Físico</th>
                  <th className="hidden py-2 pl-3 text-right font-medium sm:table-cell sm:pr-4 md:pr-0">Reservado</th>
                  <th className={`hidden py-2 pl-3 text-right font-medium md:table-cell md:pr-4 ${showCost ? 'lg:pr-0' : ''}`}>Mínimo</th>
                  {showCost && <th className="hidden py-2 pr-4 pl-3 text-right font-medium lg:table-cell">Custo médio</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.items.map((r) => (
                  <tr key={r.variant_id} className="hover:bg-sunken/40">
                    <td className="py-2.5 pl-4">
                      <Link href={`/painel/estoque/${r.variant_id}`} className="block">
                        <span className="block font-medium hover:underline">{r.label}</span>
                        <span className="flex flex-wrap items-center gap-1.5 text-xs text-ink-faint">
                          <span className="font-mono">{r.sku}</span>
                          {r.below_min && <Badge tone="warn">Abaixo do mínimo</Badge>}
                          {Number(r.available) < 0 && <Badge tone="bad">Falta {qty(-Number(r.available))}</Badge>}
                          {r.availability_mode === 'made_to_order' && <Badge>Sob encomenda</Badge>}
                        </span>
                      </Link>
                    </td>
                    <td className={`num py-2.5 pr-4 pl-3 text-right font-medium sm:pr-0 ${Number(r.available) <= 0 ? 'text-bad' : ''}`}>
                      {qty(r.available)} <span className="text-xs font-normal text-ink-faint">{r.base_unit}</span>
                    </td>
                    <td className="num hidden py-2.5 pl-3 text-right sm:table-cell">{qty(r.on_hand)}</td>
                    <td className="num hidden py-2.5 pl-3 text-right sm:table-cell sm:pr-4 md:pr-0">{Number(r.reserved) ? qty(r.reserved) : '—'}</td>
                    <td className={`num hidden py-2.5 pl-3 text-right md:table-cell md:pr-4 ${showCost ? 'lg:pr-0' : ''}`}>{Number(r.min_stock) ? qty(r.min_stock) : '—'}</td>
                    {showCost && <td className="num hidden py-2.5 pr-4 pl-3 text-right lg:table-cell">{Number(r.avg_cost_cents) ? unitMoney(r.avg_cost_cents) : '—'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {data && pages > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2 text-sm">
          <button className="rounded px-2 py-1 hover:bg-sunken disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Anterior
          </button>
          <span className="text-ink-soft">
            {page} de {pages}
          </span>
          <button className="rounded px-2 py-1 hover:bg-sunken disabled:opacity-40" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Próxima
          </button>
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="stock.view">
      <StockList />
    </Guard>
  );
}
