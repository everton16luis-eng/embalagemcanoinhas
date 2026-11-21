'use client';

// SGLog Fase 9b: reembolsos. So registro do que foi feito fora do sistema (provedor, banco, caixa, marketplace).
import { useCallback, useEffect, useState } from 'react';
import { useMe } from '@/components/shell';
import { newKey } from '@/components/stock';
import { Badge, Button, Field, Input, Notice, Panel, Select, type Tone } from '@/components/ui';
import { api } from '@/lib/api';
import { money, parseMoney, when } from '@/lib/format';

export const REFUND_METHOD: Record<string, string> = {
  mercadopago: 'Mercado Pago',
  pix: 'Pix',
  bank_transfer: 'Transferência bancária',
  cash: 'Dinheiro',
  card_reversal: 'Estorno no cartão',
  marketplace: 'Marketplace (feito pela plataforma)',
  other: 'Outro',
};
export const REFUND_STATUS: Record<string, { label: string; tone: Tone }> = {
  requested: { label: 'Solicitado', tone: 'warn' },
  done: { label: 'Realizado', tone: 'act' },
  confirmed: { label: 'Confirmado', tone: 'good' },
  canceled: { label: 'Cancelado', tone: 'neutral' },
};
export function RefundBadge({ status }: { status: string }) {
  const s = REFUND_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

type Refund = { id: string; number: number; amount_cents: string; method: string; external_ref: string | null; status: string; reason: string; created_at: string; version: number; return_id: string | null; return_number: number | null; requested_by_name: string | null };
type Summary = { totalCents: number; requestedCents: number; doneCents: number; confirmedCents: number; eligibleCents: number; marketplace: boolean; providerRefunded: boolean; items: Refund[] };

/** Reembolsos do pedido: resumo, registro (refunds.record, com MFA) e as transicoes. */
export function OrderRefundsPanel({ orderId, returnId }: { orderId: string; returnId?: string }) {
  const { can, me } = useMe();
  const record = can('refunds.record');
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ amount: '', method: 'pix', externalRef: '', done: false, reason: '' });
  const [busy, setBusy] = useState('');
  const [key, setKey] = useState(newKey);
  const load = useCallback(() => {
    api<Summary>(`/admin/refunds/orders/${orderId}`).then(
      (r) => {
        setS(r);
        if (r.marketplace) setForm((f) => ({ ...f, method: 'marketplace' }));
      },
      (e) => setError(e.message),
    );
  }, [orderId]);
  useEffect(load, [load]);
  if (!s) return error ? <Notice tone="bad">{error}</Notice> : null;
  const cents = parseMoney(form.amount);
  const create = async () => {
    setBusy('create');
    setError('');
    setNotice('');
    try {
      const r = await api<{ refund: { number: number } }>('/admin/refunds', {
        method: 'POST',
        body: { orderId, returnId: returnId ?? null, amountCents: cents, method: form.method, externalRef: form.externalRef.trim() || null, status: form.done ? 'done' : 'requested', reason: form.reason, requestKey: key },
      });
      setNotice(`Reembolso nº ${r.refund.number} registrado. Nada foi pago pelo sistema: é o registro do que foi feito fora.`);
      setOpen(false);
      setKey(newKey());
      setForm({ amount: '', method: s.marketplace ? 'marketplace' : 'pix', externalRef: '', done: false, reason: '' });
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const act = async (r: Refund, action: 'done' | 'confirm' | 'cancel') => {
    const ref = action === 'done' && !r.external_ref ? window.prompt('Referência externa da operação (comprovante, identificador):') : null;
    if (action === 'done' && !r.external_ref && !ref) return;
    const note = window.prompt(action === 'cancel' ? 'Motivo do cancelamento:' : action === 'confirm' ? 'Onde foi conferido (extrato, painel do provedor):' : 'Observação:');
    if (!note || note.trim().length < 3) return;
    setBusy(r.id + action);
    setError('');
    try {
      await api(`/admin/refunds/${r.id}/action`, { method: 'POST', body: { action, note: note.trim(), externalRef: ref?.trim() || null, version: r.version, requestKey: newKey() } });
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const items = returnId ? s.items.filter((i) => i.return_id === returnId) : s.items;
  return (
    <Panel
      title="Reembolsos"
      description="Registro do que foi devolvido ao cliente fora do sistema. Receber a mercadoria não reembolsa nada; a soma nunca passa do total do pedido."
      actions={
        record &&
        s.eligibleCents > 0 && (
          <Button onClick={() => setOpen(!open)} data-testid="open-refund-form">
            Registrar reembolso
          </Button>
        )
      }
    >
      <div className="space-y-3 text-sm" data-testid="refunds-panel">
        {error && <Notice tone="bad">{error}</Notice>}
        {notice && <Notice tone="good">{notice}</Notice>}
        {record && !me.user.mfaEnabled && <Notice tone="warn">Registrar reembolso exige a verificação em duas etapas ativa.</Notice>}
        {s.providerRefunded && <Notice tone="warn">O provedor informou pagamento devolvido neste pedido. Confira e registre o reembolso.</Notice>}
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div>
            <dt className="text-ink-soft">Total do pedido</dt>
            <dd className="num">{money(s.totalCents)}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">Solicitado</dt>
            <dd className="num">{money(s.requestedCents)}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">Realizado / confirmado</dt>
            <dd className="num">
              {money(s.doneCents)} / {money(s.confirmedCents)}
            </dd>
          </div>
          <div>
            <dt className="text-ink-soft">Ainda elegível</dt>
            <dd className="num">{money(s.eligibleCents)}</dd>
          </div>
        </dl>
        {open && (
          <form
            className="space-y-3 rounded-md border border-line bg-sunken/40 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
            data-testid="refund-form"
          >
            {s.marketplace && <Notice tone="neutral">Pedido de marketplace: registre só o que a plataforma informou ter devolvido.</Notice>}
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Valor (R$)" hint={`Até ${money(s.eligibleCents)}`}>
                {(id) => <Input id={id} inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />}
              </Field>
              <Field label="Meio">
                {(id) => (
                  <Select id={id} value={form.method} disabled={s.marketplace} onChange={(e) => setForm({ ...form, method: e.target.value })}>
                    {Object.entries(REFUND_METHOD)
                      .filter(([k]) => (s.marketplace ? k === 'marketplace' : k !== 'marketplace'))
                      .map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
              <Field label="Referência externa" hint="Identificador da operação ou comprovante.">
                {(id) => <Input id={id} value={form.externalRef} maxLength={120} onChange={(e) => setForm({ ...form, externalRef: e.target.value })} />}
              </Field>
            </div>
            <Field label="Justificativa" required>
              {(id) => <Input id={id} value={form.reason} maxLength={500} onChange={(e) => setForm({ ...form, reason: e.target.value })} />}
            </Field>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.done} onChange={(e) => setForm({ ...form, done: e.target.checked })} /> Já foi realizado (exige a referência)
            </label>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" type="submit" busy={busy === 'create'} disabled={!cents || cents <= 0 || cents > s.eligibleCents || form.reason.trim().length < 3 || (form.done && !form.externalRef.trim())}>
                Registrar
              </Button>
              <Button variant="ghost" type="button" onClick={() => setOpen(false)}>
                Voltar
              </Button>
            </div>
          </form>
        )}
        {items.length === 0 ? (
          <p className="text-ink-soft">Nenhum reembolso registrado.</p>
        ) : (
          <ul className="divide-y divide-line" data-testid="refund-list">
            {items.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Nº {r.number}</span>
                  <span className="num">{money(r.amount_cents)}</span>
                  <RefundBadge status={r.status} />
                  <span>{REFUND_METHOD[r.method]}</span>
                </div>
                <span className="min-w-0 flex-1 truncate text-ink-soft">
                  {r.external_ref ? `ref. ${r.external_ref} · ` : ''}
                  {r.reason} · {when(r.created_at)}
                </span>
                {record && (
                  <div className="flex flex-wrap gap-1">
                    {r.status === 'requested' && (
                      <Button variant="ghost" busy={busy === r.id + 'done'} onClick={() => act(r, 'done')}>
                        Realizado
                      </Button>
                    )}
                    {r.status === 'done' && (
                      <Button variant="ghost" busy={busy === r.id + 'confirm'} onClick={() => act(r, 'confirm')}>
                        Confirmar
                      </Button>
                    )}
                    {['requested', 'done'].includes(r.status) && (
                      <Button variant="ghost" busy={busy === r.id + 'cancel'} onClick={() => act(r, 'cancel')}>
                        Cancelar
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
