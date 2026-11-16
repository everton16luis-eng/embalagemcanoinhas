'use client';

import Link from '@/components/painel-link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Guard } from '@/components/shell';
import { newKey, TRANSFER_STATUS, useStockAccess } from '@/components/stock';
import { Badge, Button, Input, Notice, PageHeader, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { parseQty, qty, qtyToInput, when } from '@/lib/format';

type Item = { variant_id: string; sku: string; label: string; base_unit: string; qty_sent: string; qty_received: string; qty_lost: string; qty_returned: string; qty_pending: string };
type Event = { id: string; kind: string; items: { variantId: string; qty: string }[]; reason: string | null; created_at: string; created_by_name: string };
type Transfer = {
  id: string;
  number: number;
  status: string;
  notes: string | null;
  document_ref: string | null;
  created_at: string;
  closed_at: string | null;
  from_name: string;
  to_name: string;
  created_by_name: string;
  items: Item[];
  events: Event[];
};

const EVENT_LABEL: Record<string, string> = { send: 'Enviada', receive: 'Recebimento', loss: 'Extravio', return: 'Recusa / devolução à origem', cancel: 'Cancelamento' };
const ACTIONS = {
  receive: { title: 'Receber no destino', button: 'Confirmar recebimento', hint: 'Informe o que chegou. O que faltar continua pendente.' },
  return: { title: 'Recusar / devolver à origem', button: 'Confirmar devolução', hint: 'O que voltar entra de novo no disponível da origem.' },
  loss: { title: 'Registrar extravio', button: 'Confirmar extravio', hint: 'Sai do estoque de vez. Exige permissão de ajuste.' },
} as const;
type Action = keyof typeof ACTIONS;

function SettleForm({ t, action, onDone, onCancel }: { t: Transfer; action: Action; onDone: () => void; onCancel: () => void }) {
  const pending = t.items.filter((i) => Number(i.qty_pending) > 0);
  const [amounts, setAmounts] = useState<Record<string, string>>(() => Object.fromEntries(pending.map((i) => [i.variant_id, action === 'receive' ? qtyToInput(i.qty_pending) : ''])));
  const [reason, setReason] = useState('');
  const [key] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const a = ACTIONS[action];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const items = Object.entries(amounts)
      .filter(([, v]) => v.trim() && Number(parseQty(v)) > 0)
      .map(([variantId, v]) => ({ variantId, qty: parseQty(v) }));
    if (!items.length) {
      setError('Informe a quantidade de pelo menos um item.');
      setBusy(false);
      return;
    }
    try {
      await api(`/admin/stock-transfers/${t.id}/${action}`, { method: 'POST', body: action === 'receive' ? { items, requestKey: key } : { items, reason, requestKey: key } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title={a.title} description={a.hint}>
      <form onSubmit={submit} className="space-y-3">
        <ul className="divide-y divide-line">
          {pending.map((i) => (
            <li key={i.variant_id} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <span className="min-w-0 flex-1 basis-48">
                <span className="block font-medium">{i.label}</span>
                <span className="block text-xs text-ink-faint">
                  <span className="font-mono">{i.sku}</span> · pendente {qty(i.qty_pending)} {i.base_unit}
                </span>
              </span>
              <Input
                aria-label={`Quantidade de ${i.label}`}
                inputMode="decimal"
                value={amounts[i.variant_id] ?? ''}
                onChange={(e) => setAmounts({ ...amounts, [i.variant_id]: e.target.value })}
                className="w-28"
                placeholder="0"
              />
            </li>
          ))}
        </ul>
        {action !== 'receive' && <Input aria-label="Motivo" placeholder="Motivo (obrigatório)" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={300} required />}
        {error && <Notice tone="bad">{error}</Notice>}
        <div className="flex flex-wrap gap-2">
          <Button variant={action === 'receive' ? 'primary' : 'danger'} busy={busy}>
            {a.button}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Voltar
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function CancelForm({ t, onDone, onCancel }: { t: Transfer; onDone: () => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [key] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/admin/stock-transfers/${t.id}/cancel`, { method: 'POST', body: { reason, requestKey: key } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Cancelar transferência" description="Desfaz o envio: tudo volta ao disponível da origem. Só é possível enquanto nada foi recebido, devolvido ou extraviado.">
      <form onSubmit={submit} className="space-y-3">
        <Input aria-label="Motivo do cancelamento" placeholder="Motivo (obrigatório)" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={300} required />
        {error && <Notice tone="bad">{error}</Notice>}
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" busy={busy}>
            Confirmar cancelamento
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Voltar
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function TransferDetail() {
  const { id } = useParams<{ id: string }>();
  const access = useStockAccess();
  const [t, setT] = useState<Transfer | null>(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<Action | 'cancel' | null>(null);
  const [busy, setBusy] = useState(false);
  const [receiveKey, setReceiveKey] = useState(newKey);
  const load = useCallback(() => api<{ transfer: Transfer }>(`/admin/stock-transfers/${id}`).then((r) => setT(r.transfer), (e) => setError(e.message)), [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const receiveAll = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ transfer: Transfer }>(`/admin/stock-transfers/${id}/receive`, { method: 'POST', body: { requestKey: receiveKey } });
      setT(r.transfer);
      setReceiveKey(newKey());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const done = () => {
    setMode(null);
    void load();
  };

  if (!t) return error ? <Notice tone="bad">{error}</Notice> : <p className="text-sm text-ink-faint">Carregando…</p>;
  const st = TRANSFER_STATUS[t.status] ?? { label: t.status, tone: 'neutral' as const };
  const open = t.status === 'in_transit' || t.status === 'partial';
  const untouched = t.items.every((i) => Number(i.qty_received) === 0 && Number(i.qty_lost) === 0 && Number(i.qty_returned) === 0);
  const labelOf = (variantId: string) => t.items.find((i) => i.variant_id === variantId);

  return (
    <>
      <PageHeader
        title={`Transferência nº ${t.number}`}
        description={
          <>
            {t.from_name} → {t.to_name} · enviada em {when(t.created_at)} por {t.created_by_name}
            {t.document_ref && ` · doc. ${t.document_ref}`}
          </>
        }
        actions={<Badge tone={st.tone}>{st.label}</Badge>}
      />
      {error && (
        <div className="mb-4">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
      {t.notes && <p className="mb-4 text-sm text-ink-soft">{t.notes}</p>}

      {open && !mode && (
        <div className="mb-5 flex flex-wrap gap-2">
          {access.transfer && (
            <>
              <Button variant="primary" busy={busy} onClick={receiveAll}>
                Receber tudo
              </Button>
              <Button onClick={() => setMode('receive')}>Receber em parte</Button>
              <Button onClick={() => setMode('return')}>Recusar / devolver</Button>
            </>
          )}
          {access.adjust && <Button onClick={() => setMode('loss')}>Registrar extravio</Button>}
          {access.adjust && untouched && (
            <Button variant="ghost" onClick={() => setMode('cancel')}>
              Cancelar transferência
            </Button>
          )}
        </div>
      )}
      {mode && mode !== 'cancel' && (
        <div className="mb-5">
          <SettleForm t={t} action={mode} onDone={done} onCancel={() => setMode(null)} />
        </div>
      )}
      {mode === 'cancel' && (
        <div className="mb-5">
          <CancelForm t={t} onDone={done} onCancel={() => setMode(null)} />
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <Panel title="Itens">
          <div className="-mx-4 overflow-x-auto sm:-mx-5">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-ink-soft">
                <tr className="border-b border-line">
                  <th className="py-2 pl-4 font-medium sm:pl-5">Produto</th>
                  <th className="py-2 pl-3 text-right font-medium">Enviado</th>
                  <th className="py-2 pl-3 text-right font-medium">Recebido</th>
                  <th className="hidden py-2 pl-3 text-right font-medium sm:table-cell">Extraviado</th>
                  <th className="hidden py-2 pl-3 text-right font-medium sm:table-cell">Devolvido</th>
                  <th className="py-2 pr-4 pl-3 text-right font-medium sm:pr-5">Pendente</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {t.items.map((i) => (
                  <tr key={i.variant_id}>
                    <td className="py-2 pl-4 sm:pl-5">
                      <Link href={`/painel/estoque/${i.variant_id}`} className="block font-medium hover:underline">
                        {i.label}
                      </Link>
                      <span className="text-xs text-ink-faint">
                        <span className="font-mono">{i.sku}</span> · {i.base_unit}
                        {Number(i.qty_lost) > 0 && <span className="sm:hidden"> · extraviado {qty(i.qty_lost)}</span>}
                        {Number(i.qty_returned) > 0 && <span className="sm:hidden"> · devolvido {qty(i.qty_returned)}</span>}
                      </span>
                    </td>
                    <td className="num py-2 pl-3 text-right">{qty(i.qty_sent)}</td>
                    <td className="num py-2 pl-3 text-right">{qty(i.qty_received)}</td>
                    <td className={`num hidden py-2 pl-3 text-right sm:table-cell ${Number(i.qty_lost) ? 'text-bad' : 'text-ink-faint'}`}>{qty(i.qty_lost)}</td>
                    <td className={`num hidden py-2 pl-3 text-right sm:table-cell ${Number(i.qty_returned) ? '' : 'text-ink-faint'}`}>{qty(i.qty_returned)}</td>
                    <td className={`num py-2 pr-4 pl-3 text-right font-medium sm:pr-5 ${Number(i.qty_pending) ? 'text-warn' : 'text-ink-faint'}`}>{qty(i.qty_pending)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="Histórico">
          <ol className="space-y-3">
            {t.events.map((e) => (
              <li key={e.id} className="text-sm">
                <p className="font-medium">{EVENT_LABEL[e.kind] ?? e.kind}</p>
                <p className="text-xs text-ink-faint">
                  {when(e.created_at)} · {e.created_by_name}
                </p>
                {e.kind !== 'send' && e.kind !== 'cancel' && (
                  <ul className="mt-0.5 text-xs text-ink-soft">
                    {e.items.map((it) => (
                      <li key={it.variantId}>
                        {qty(it.qty)} {labelOf(it.variantId)?.base_unit} · {labelOf(it.variantId)?.label}
                      </li>
                    ))}
                  </ul>
                )}
                {e.reason && <p className="text-xs text-ink-soft">“{e.reason}”</p>}
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="stock.view">
      <TransferDetail />
    </Guard>
  );
}
