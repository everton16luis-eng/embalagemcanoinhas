'use client';

import Link from '@/components/painel-link';
import { useEffect, useState } from 'react';
import { Guard } from '@/components/shell';
import { useWarehouses } from '@/components/stock';
import { Badge, Empty, Notice, PageHeader, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { qty } from '@/lib/format';

type Alert = {
  alert: 'below_min' | 'above_max';
  warehouse_id: string;
  warehouse_name: string;
  variant_id: string;
  sku: string;
  label: string;
  base_unit: string;
  on_hand: string;
  reserved: string;
  in_transit: string;
  available: string;
  min_qty: string | null;
  max_qty: string | null;
};

function Alerts() {
  const { warehouses } = useWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: Alert[]; total: number } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => setPage(1), [warehouseId, kind]);
  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: '50' });
    if (warehouseId) params.set('warehouseId', warehouseId);
    if (kind) params.set('alert', kind);
    api<{ items: Alert[]; total: number }>(`/admin/stock/alerts?${params}`).then(setData, (e) => setError(e.message));
  }, [warehouseId, kind, page]);
  const pages = data ? Math.max(1, Math.ceil(data.total / 50)) : 1;

  return (
    <>
      <PageHeader
        title="Alertas de estoque"
        description="Mínimo e máximo definidos por depósito, no detalhe de cada produto. Abaixo do mínimo: o vendável do depósito ficou menor que o mínimo. Acima do máximo: disponível mais o que está chegando passou do máximo. Os avisos ficam só aqui no painel."
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {warehouses && warehouses.length > 1 && (
          <Select aria-label="Depósito" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="w-auto">
            <option value="">Todos os depósitos</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        )}
        <Select aria-label="Tipo de alerta" value={kind} onChange={(e) => setKind(e.target.value)} className="w-auto">
          <option value="">Todos os alertas</option>
          <option value="below_min">Abaixo do mínimo</option>
          <option value="above_max">Acima do máximo</option>
        </Select>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {data && (
        <div className="rounded-lg border border-line bg-card">
          {data.items.length === 0 ? (
            <Empty title="Nenhum alerta.">Defina mínimo e máximo por depósito no detalhe de cada produto, em Estoque.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {data.items.map((a) => (
                <li key={`${a.alert}-${a.warehouse_id}-${a.variant_id}`}>
                  <Link href={`/painel/estoque/${a.variant_id}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 hover:bg-sunken/40 sm:px-5">
                    <span className="min-w-0">
                      <span className="block font-medium">{a.label}</span>
                      <span className="block text-xs text-ink-faint">
                        <span className="font-mono">{a.sku}</span> · {a.warehouse_name}
                      </span>
                    </span>
                    <span className="flex items-center gap-3 text-sm">
                      <span className="num text-right">
                        {a.alert === 'below_min' ? (
                          <>
                            vendável <strong>{qty(a.available)}</strong> · mín. {qty(a.min_qty ?? '0')}
                          </>
                        ) : (
                          <>
                            {qty(Number(a.on_hand) + Number(a.in_transit))} · máx. {qty(a.max_qty ?? '0')}
                          </>
                        )}{' '}
                        <span className="text-xs text-ink-faint">{a.base_unit}</span>
                      </span>
                      <Badge tone="warn">{a.alert === 'below_min' ? 'Abaixo do mínimo' : 'Acima do máximo'}</Badge>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
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
      <Alerts />
    </Guard>
  );
}
