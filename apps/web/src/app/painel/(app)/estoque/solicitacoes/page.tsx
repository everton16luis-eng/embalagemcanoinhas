'use client';

import { useCallback, useEffect, useState } from 'react';
import { RequestItem, type AdjustmentRequest } from '@/components/adjustment-requests';
import { Guard } from '@/components/shell';
import { useStockAccess } from '@/components/stock';
import { Empty, Notice, PageHeader, Select } from '@/components/ui';
import { api } from '@/lib/api';

const FILTERS: Record<string, string> = { pending: 'Aguardando aprovação', approved: 'Aprovadas', rejected: 'Recusadas', canceled: 'Canceladas', all: 'Todas' };

function Requests() {
  const access = useStockAccess();
  const [status, setStatus] = useState('pending');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: AdjustmentRequest[]; total: number } | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(
    () => api<{ items: AdjustmentRequest[]; total: number }>(`/admin/stock/adjustment-requests?status=${status}&page=${page}&pageSize=30`).then(setData, (e) => setError(e.message)),
    [status, page],
  );
  useEffect(() => setPage(1), [status]);
  useEffect(() => {
    void load();
  }, [load]);
  const pages = data ? Math.max(1, Math.ceil(data.total / 30)) : 1;

  return (
    <>
      <PageHeader
        title="Solicitações de ajuste"
        description="Ajuste, perda e avaria pedidos por quem não tem permissão de lançar direto. O saldo só muda quando outra pessoa, com permissão de ajuste e verificação em duas etapas, aprova."
      />
      {!access.adjust && (
        <div className="mb-4">
          <Notice>Você pode acompanhar e cancelar os seus pedidos. Para pedir um ajuste, abra o produto em Estoque.</Notice>
        </div>
      )}
      <div className="mb-4">
        <Select aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          {Object.entries(FILTERS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {data && (
        <div className="rounded-lg border border-line bg-card px-4 py-4 sm:px-5">
          {data.items.length === 0 ? (
            <Empty title={status === 'pending' ? 'Nenhuma solicitação aguardando.' : 'Nenhuma solicitação com esse filtro.'} />
          ) : (
            <ul className="divide-y divide-line">
              {data.items.map((r) => (
                <RequestItem key={r.id} r={r} showProduct onChange={load} />
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
      <Requests />
    </Guard>
  );
}
