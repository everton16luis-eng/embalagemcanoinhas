'use client';

// SGLog Fase 9a: fila das ocorrencias logisticas (abertas pelo painel ou pelo rastreio).
import Link from '@/components/painel-link';
import { useCallback, useEffect, useState } from 'react';
import { OCCURRENCE_KIND, OCCURRENCE_SOURCE, OccurrenceBadge, RESPONSIBILITY } from '@/components/returns';
import { Guard } from '@/components/shell';
import { Badge, Button, Empty, Input, Notice, PageHeader, Panel, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { when } from '@/lib/format';

type Row = {
  id: string;
  number: number;
  order_id: string;
  order_number: number;
  shipment_seq: number | null;
  item_sku: string | null;
  kind: string;
  responsibility: string;
  status: string;
  source: string;
  blocks_completion: boolean;
  description: string;
  due_at: string | null;
  created_at: string;
  overdue: boolean;
};
type List = { items: Row[]; total: number; page: number; pageSize: number; counts: { open: number; overdue: number; tracking: number } };

function Page() {
  const [status, setStatus] = useState('open');
  const [kind, setKind] = useState('');
  const [order, setOrder] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<List | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const q = new URLSearchParams({ status, page: String(page), pageSize: '30' });
    if (kind) q.set('kind', kind);
    if (/^\d+$/.test(order)) q.set('order', order);
    api<List>(`/admin/occurrences?${q}`).then(setData, (e) => setError(e.message));
  }, [status, kind, order, page]);
  useEffect(load, [load]);
  return (
    <>
      <PageHeader title="Ocorrências" description="Avarias, extravios, atrasos, recusas e pedidos de troca ou devolução. Ocorrência é registro: não mexe no estoque, não reembolsa e não toca a nota fiscal." />
      {error && (
        <div className="mb-4">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
      {data && (
        <div className="mb-4 flex flex-wrap gap-2 text-sm" data-testid="occurrence-counts">
          <Badge tone="warn">{data.counts.open} em aberto</Badge>
          {data.counts.overdue > 0 && <Badge tone="bad">{data.counts.overdue} com prazo vencido</Badge>}
          {data.counts.tracking > 0 && <Badge tone="act">{data.counts.tracking} vinda(s) do rastreio</Badge>}
        </div>
      )}
      <Panel>
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Select aria-label="Situação" className="w-auto" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
            <option value="open">Em aberto</option>
            <option value="resolved">Resolvidas</option>
            <option value="canceled">Canceladas</option>
            <option value="all">Todas</option>
          </Select>
          <Select aria-label="Tipo" className="w-auto" value={kind} onChange={(e) => (setKind(e.target.value), setPage(1))}>
            <option value="">Todos os tipos</option>
            {Object.entries(OCCURRENCE_KIND).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <Input aria-label="Pedido nº" placeholder="Pedido nº" className="w-32" inputMode="numeric" value={order} onChange={(e) => (setOrder(e.target.value), setPage(1))} />
        </div>
        {!data ? null : data.items.length === 0 ? (
          <Empty title="Nenhuma ocorrência">Abra pelo pedido (Ocorrências e devoluções) ou aguarde o aviso do rastreio.</Empty>
        ) : (
          <ul className="divide-y divide-line" data-testid="occurrence-list">
            {data.items.map((o) => (
              <li key={o.id} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/painel/logistica/ocorrencias/${o.id}`} className="font-medium text-act hover:underline">
                    Nº {o.number}
                  </Link>
                  <span>{OCCURRENCE_KIND[o.kind] ?? o.kind}</span>
                  <OccurrenceBadge status={o.status} />
                  {o.source !== 'manual' && <Badge tone="act">{OCCURRENCE_SOURCE[o.source]}</Badge>}
                  {o.overdue && <Badge tone="bad">prazo vencido</Badge>}
                </div>
                <div className="min-w-0 flex-1 truncate text-sm text-ink-soft">
                  Pedido nº {o.order_number}
                  {o.shipment_seq ? ` · remessa ${o.shipment_seq}` : ''}
                  {o.item_sku ? ` · ${o.item_sku}` : ''} · {RESPONSIBILITY[o.responsibility]} · {o.description}
                </div>
                <span className="text-xs text-ink-faint">{when(o.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
        {data && data.total > data.pageSize && (
          <div className="mt-3 flex items-center gap-2 text-sm">
            <Button disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Anterior
            </Button>
            <span>
              Página {page} de {Math.ceil(data.total / data.pageSize)}
            </span>
            <Button disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>
              Próxima
            </Button>
          </div>
        )}
      </Panel>
    </>
  );
}

export default function OcorrenciasPage() {
  return (
    <Guard perm="occurrences.manage|returns.manage|logistics.view|orders.view">
      <Page />
    </Guard>
  );
}
