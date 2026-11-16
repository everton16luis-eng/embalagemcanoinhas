'use client';

import Link from '@/components/painel-link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Guard, useMe } from '@/components/shell';
import { useWarehouses } from '@/components/stock';
import { Badge, Button, Empty, Notice, PageHeader, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { when } from '@/lib/format';

type Row = { id: string; status: string; notes: string | null; created_at: string; closed_at: string | null; created_by_name: string; warehouse_id: string; warehouse_name: string; item_count: number; counted_count: number; diff_count: number };
const STATUS: Record<string, { label: string; tone: 'act' | 'good' | 'neutral' }> = {
  open: { label: 'Aberta', tone: 'act' },
  closed: { label: 'Fechada', tone: 'good' },
  canceled: { label: 'Cancelada', tone: 'neutral' },
};

function Counts() {
  const { can } = useMe();
  const router = useRouter();
  const [data, setData] = useState<{ items: Row[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { active: warehouses } = useWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  useEffect(() => {
    if (!warehouseId && warehouses.length) setWarehouseId((warehouses.find((w) => w.is_default) ?? warehouses[0]!).id);
  }, [warehouses, warehouseId]);
  useEffect(() => {
    api('/admin/inventory-counts?pageSize=50').then(setData, (e) => setError(e.message));
  }, []);
  const open = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api('/admin/inventory-counts', { method: 'POST', body: { warehouseId: warehouseId || null } });
      router.push(`/painel/inventario/${r.count.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  // Uma contagem aberta por deposito (Fase 3).
  const hasOpen = data?.items.some((c) => c.status === 'open' && (!warehouseId || c.warehouse_id === warehouseId));
  const multi = warehouses.length > 1;

  return (
    <>
      <PageHeader
        title="Inventário"
        description="Contagem física por depósito. Ao fechar, a diferença entre o contado e o disponível do depósito vira um lançamento de inventário em cada produto. Bloqueado e avariado não entram na contagem."
        actions={
          can('stock.manage') && (
            <>
              {multi && (
                <Select aria-label="Depósito da contagem" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="w-auto">
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              )}
              {!hasOpen && (
                <Button variant="primary" busy={busy} onClick={open}>
                  Abrir contagem geral
                </Button>
              )}
            </>
          )
        }
      />
      {error && <Notice tone="bad">{error}</Notice>}
      {data && (
        <div className="overflow-x-auto rounded-lg border border-line bg-card">
          {data.items.length === 0 ? (
            <Empty title="Nenhuma contagem ainda." />
          ) : (
            <ul className="divide-y divide-line">
              {data.items.map((c) => (
                <li key={c.id}>
                  <Link href={`/painel/inventario/${c.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-sunken/40">
                    <span>
                      <span className="block font-medium">Contagem de {when(c.created_at)}</span>
                      <span className="block text-xs text-ink-faint">
                        {multi && `${c.warehouse_name} · `}
                        {c.created_by_name} · {c.counted_count} de {c.item_count} contados{c.status === 'closed' && ` · ${c.diff_count} com diferença`}
                      </span>
                    </span>
                    <Badge tone={STATUS[c.status]!.tone}>{STATUS[c.status]!.label}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="stock.view">
      <Counts />
    </Guard>
  );
}
