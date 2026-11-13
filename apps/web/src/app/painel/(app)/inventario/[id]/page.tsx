'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Input, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { parseQty, qty, qtyToInput, when } from '@/lib/format';

type Item = { variant_id: string; sku: string; product_name: string; attributes: Record<string, string>; base_unit: string; counted_qty: string | null; system_qty: string | null; diff_qty: string | null; current_on_hand: string | null };
type Count = { id: string; status: string; created_at: string; closed_at: string | null; created_by_name: string; items: Item[] };

function CountPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useMe();
  const [count, setCount] = useState<Count | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = (c: Count) => {
    setCount(c);
    setValues(Object.fromEntries(c.items.map((i) => [i.variant_id, i.counted_qty === null ? '' : qtyToInput(i.counted_qty)])));
  };
  useEffect(() => {
    api(`/admin/inventory-counts/${id}`).then((r) => apply(r.count), (e) => setMsg({ tone: 'bad', text: e.message }));
  }, [id]);

  if (!count) return msg ? <Notice tone="bad">{msg.text}</Notice> : <p className="text-sm text-ink-faint">Carregando…</p>;
  const editable = count.status === 'open' && can('stock.manage');
  const changed = count.items.filter((i) => (values[i.variant_id] ?? '') !== (i.counted_qty === null ? '' : qtyToInput(i.counted_qty)));

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api(`/admin/inventory-counts/${id}/items`, { method: 'PUT', body: changed.map((i) => ({ variantId: i.variant_id, countedQty: values[i.variant_id]?.trim() ? parseQty(values[i.variant_id]!) : null })) });
      apply(r.count);
      setMsg({ tone: 'good', text: 'Contagem salva.' });
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const finish = async (path: 'close' | 'cancel') => {
    if (changed.length) return setMsg({ tone: 'bad', text: 'Salve a contagem antes.' });
    if (!window.confirm(path === 'close' ? 'Fechar a contagem e lançar as diferenças no estoque?' : 'Cancelar esta contagem? Nada será lançado.')) return;
    setBusy(true);
    try {
      const r = await api(`/admin/inventory-counts/${id}/${path}`, { method: 'POST', body: {} });
      apply(r.count);
      setMsg(null);
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const term = filter.trim().toLowerCase();
  const visible = term ? count.items.filter((i) => i.product_name.toLowerCase().includes(term) || i.sku.toLowerCase().includes(term)) : count.items;
  const counted = count.items.filter((i) => i.counted_qty !== null).length;

  return (
    <>
      <PageHeader
        title={`Contagem de ${when(count.created_at)}`}
        description={`${counted} de ${count.items.length} itens contados. Item não contado não é alterado.`}
        actions={
          editable && (
            <>
              <Button variant="ghost" onClick={() => finish('cancel')} disabled={busy}>
                Cancelar contagem
              </Button>
              <Button variant="primary" onClick={() => finish('close')} disabled={busy}>
                Fechar e lançar diferenças
              </Button>
            </>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone={count.status === 'open' ? 'act' : count.status === 'closed' ? 'good' : 'neutral'}>{{ open: 'Aberta', closed: 'Fechada', canceled: 'Cancelada' }[count.status]}</Badge>
        <Input aria-label="Filtrar" placeholder="Filtrar por nome ou SKU" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-xs" />
      </div>
      {msg && (
        <div className="mb-4">
          <Notice tone={msg.tone}>{msg.text}</Notice>
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-line bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-sunken/60 text-left text-xs text-ink-soft">
            <tr>
              <th className="py-2 pl-4 font-medium">Produto</th>
              <th className="py-2 pl-3 font-medium">Contado</th>
              {count.status === 'closed' && <th className="py-2 pr-4 pl-3 text-right font-medium">Sistema / diferença</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {visible.map((i) => (
              <tr key={i.variant_id}>
                <td className="py-2 pl-4">
                  <span className="block font-medium">
                    {i.product_name}
                    {Object.values(i.attributes).length > 0 && ` — ${Object.values(i.attributes).join(' / ')}`}
                  </span>
                  <span className="block font-mono text-xs text-ink-faint">{i.sku}</span>
                </td>
                <td className="py-2 pl-3">
                  {editable ? (
                    <span className="flex items-center gap-1.5">
                      <Input aria-label={`Contado de ${i.product_name}`} className="w-24" inputMode="decimal" value={values[i.variant_id] ?? ''} onChange={(e) => setValues({ ...values, [i.variant_id]: e.target.value })} />
                      <span className="text-xs text-ink-faint">{i.base_unit}</span>
                    </span>
                  ) : (
                    <span className="num">{i.counted_qty === null ? '—' : `${qty(i.counted_qty)} ${i.base_unit}`}</span>
                  )}
                </td>
                {count.status === 'closed' && (
                  <td className="num py-2 pr-4 pl-3 text-right">
                    {i.system_qty === null ? (
                      '—'
                    ) : (
                      <>
                        {qty(i.system_qty)}{' '}
                        <span className={Number(i.diff_qty) < 0 ? 'text-bad' : Number(i.diff_qty) > 0 ? 'text-good' : 'text-ink-faint'}>
                          ({Number(i.diff_qty) > 0 ? '+' : ''}
                          {qty(i.diff_qty!)})
                        </span>
                      </>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editable && (
        <div className="sticky bottom-0 mt-3 flex items-center justify-between gap-3 rounded-lg border border-line bg-card px-4 py-3">
          <span className="text-sm text-ink-soft">{changed.length ? `${changed.length} alteração(ões) não salva(s)` : 'Tudo salvo'}</span>
          <Button variant="primary" busy={busy} disabled={!changed.length} onClick={save}>
            Salvar contagem
          </Button>
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="stock.view">
      <CountPage />
    </Guard>
  );
}
