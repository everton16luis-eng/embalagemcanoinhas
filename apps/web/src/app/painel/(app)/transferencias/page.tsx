'use client';

import Link from '@/components/painel-link';
import { useEffect, useState } from 'react';
import { Guard, useMe } from '@/components/shell';
import { TRANSFER_STATUS, useWarehouses } from '@/components/stock';
import { Badge, Empty, Notice, PageHeader, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { qty, when } from '@/lib/format';

type Row = { id: string; number: number; status: string; created_at: string; closed_at: string | null; from_name: string; to_name: string; created_by_name: string; item_count: number; qty_pending: string };

const STATUS_FILTER: Record<string, string> = {
  open: 'Em aberto',
  all: 'Todas',
  received: 'Recebidas',
  closed_divergent: 'Com divergência',
  canceled: 'Canceladas',
};

function Transfers() {
  const { can } = useMe();
  const { warehouses } = useWarehouses();
  const [status, setStatus] = useState('open');
  const [warehouseId, setWarehouseId] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: Row[]; total: number } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => setPage(1), [status, warehouseId]);
  useEffect(() => {
    const params = new URLSearchParams({ status, page: String(page), pageSize: '30' });
    if (warehouseId) params.set('warehouseId', warehouseId);
    api<{ items: Row[]; total: number }>(`/admin/stock-transfers?${params}`).then(setData, (e) => setError(e.message));
  }, [status, warehouseId, page]);
  const pages = data ? Math.max(1, Math.ceil(data.total / 30)) : 1;

  return (
    <>
      <PageHeader
        title="Transferências"
        description="Mercadoria entre depósitos em duas etapas: o envio tira do disponível da origem; o recebimento coloca no destino. Enquanto isso, ela aparece como “chegando” no destino e não é vendida."
        actions={
          can('stock.transfer') && (
            <Link href="/painel/transferencias/nova" className="inline-flex h-9 items-center rounded-[var(--radius-ctl)] bg-act px-3.5 text-sm font-medium text-white hover:bg-act-dark">
              Nova transferência
            </Link>
          )
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          {Object.entries(STATUS_FILTER).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
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
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {data && (
        <div className="rounded-lg border border-line bg-card">
          {data.items.length === 0 ? (
            <Empty title={status === 'open' ? 'Nenhuma transferência em aberto.' : 'Nenhuma transferência com esse filtro.'}>
              {warehouses && warehouses.length < 2 && 'Cadastre um segundo depósito para transferir mercadoria.'}
            </Empty>
          ) : (
            <ul className="divide-y divide-line">
              {data.items.map((t) => {
                const st = TRANSFER_STATUS[t.status] ?? { label: t.status, tone: 'neutral' as const };
                return (
                  <li key={t.id}>
                    <Link href={`/painel/transferencias/${t.id}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 hover:bg-sunken/40 sm:px-5">
                      <span className="min-w-0">
                        <span className="block font-medium">
                          Nº {t.number} · {t.from_name} → {t.to_name}
                        </span>
                        <span className="block text-xs text-ink-faint">
                          {when(t.created_at)} · {t.created_by_name} · {t.item_count} {t.item_count === 1 ? 'item' : 'itens'}
                          {Number(t.qty_pending) > 0 && ` · ${qty(t.qty_pending)} a receber`}
                        </span>
                      </span>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </Link>
                  </li>
                );
              })}
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
      <Transfers />
    </Guard>
  );
}
