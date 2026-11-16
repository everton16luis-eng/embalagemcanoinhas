'use client';

import Link from '@/components/painel-link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Empty, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { when } from '@/lib/format';

type Row = { id: string; status: string; notes: string | null; created_at: string; closed_at: string | null; created_by_name: string; item_count: number; counted_count: number; diff_count: number };
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
  useEffect(() => {
    api('/admin/inventory-counts?pageSize=50').then(setData, (e) => setError(e.message));
  }, []);
  const open = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api('/admin/inventory-counts', { method: 'POST', body: {} });
      router.push(`/painel/inventario/${r.count.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const hasOpen = data?.items.some((c) => c.status === 'open');

  return (
    <>
      <PageHeader
        title="Inventário"
        description="Contagem física. Ao fechar, a diferença entre o contado e o sistema vira um lançamento de inventário em cada produto."
        actions={
          can('stock.manage') &&
          !hasOpen && (
            <Button variant="primary" busy={busy} onClick={open}>
              Abrir contagem geral
            </Button>
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
