'use client';

import Link from '@/components/painel-link';
import { useState } from 'react';
import { useMe } from '@/components/shell';
import { useStockAccess } from '@/components/stock';
import { Badge, Button, Input, Notice } from '@/components/ui';
import { api } from '@/lib/api';
import { qty, when } from '@/lib/format';

export type AdjustmentRequest = {
  id: string;
  number: number;
  kind: 'adjustment' | 'loss' | 'damage';
  qty: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'canceled';
  requested_at: string;
  decided_at: string | null;
  decision_note: string | null;
  movement_id: string | null;
  warehouse_name: string;
  variant_id: string;
  sku: string;
  label: string;
  base_unit: string;
  requested_by: string;
  requested_by_name: string;
  decided_by_name: string | null;
};

export const REQUEST_KIND: Record<string, string> = { adjustment: 'Ajuste', loss: 'Perda', damage: 'Avaria' };
export const REQUEST_STATUS: Record<string, { label: string; tone: 'neutral' | 'act' | 'warn' | 'good' | 'bad' }> = {
  pending: { label: 'Aguardando aprovação', tone: 'warn' },
  approved: { label: 'Aprovada', tone: 'good' },
  rejected: { label: 'Recusada', tone: 'bad' },
  canceled: { label: 'Cancelada', tone: 'neutral' },
};

/** Efeito da solicitacao no disponivel: perda e avaria sao saidas; ajuste traz o sinal. */
const effect = (r: AdjustmentRequest) => (r.kind === 'adjustment' ? (Number(r.qty) > 0 ? `+${qty(r.qty)}` : qty(r.qty)) : `−${qty(r.qty)}`);

/**
 * Uma solicitacao de ajuste com as acoes possiveis para quem esta logado: aprovar/recusar
 * (stock.adjust, nunca a propria) e cancelar (quem pediu ou um aprovador).
 */
export function RequestItem({ r, showProduct, onChange }: { r: AdjustmentRequest; showProduct?: boolean; onChange: () => void }) {
  const { me } = useMe();
  const access = useStockAccess();
  const [mode, setMode] = useState<'approve' | 'reject' | 'cancel' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const own = r.requested_by === me.user.id;
  const approver = access.adjust;
  const pending = r.status === 'pending';

  const send = async () => {
    if (!mode) return;
    setBusy(true);
    setError('');
    try {
      await api(`/admin/stock/adjustment-requests/${r.id}/${mode}`, { method: 'POST', body: { note: note.trim() || null } });
      setMode(null);
      setNote('');
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const st = REQUEST_STATUS[r.status]!;
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0">
          <span className="font-medium">
            Nº {r.number} · {REQUEST_KIND[r.kind]} <span className={`num ${r.kind === 'adjustment' && Number(r.qty) > 0 ? 'text-good' : 'text-bad'}`}>{effect(r)}</span> {r.base_unit}
          </span>
          {showProduct && (
            <Link href={`/painel/estoque/${r.variant_id}`} className="block text-sm hover:underline">
              {r.label} <span className="font-mono text-xs text-ink-faint">{r.sku}</span>
            </Link>
          )}
        </p>
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>
      <p className="mt-0.5 text-sm text-ink-soft">{r.reason}</p>
      <p className="text-xs text-ink-faint">
        {r.warehouse_name} · pedida por {r.requested_by_name} em {when(r.requested_at)}
        {r.decided_at && ` · ${r.status === 'canceled' ? 'cancelada' : 'decidida'} por ${r.decided_by_name ?? '—'} em ${when(r.decided_at)}`}
        {r.decision_note && ` · “${r.decision_note}”`}
      </p>
      {pending && (
        <div className="mt-2 space-y-2">
          {mode ? (
            <div className="flex flex-wrap gap-2">
              <Input
                aria-label={mode === 'reject' ? 'Motivo da recusa' : 'Observação'}
                placeholder={mode === 'reject' ? 'Motivo da recusa (obrigatório)' : 'Observação (opcional)'}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={300}
                className="min-w-0 flex-1 basis-48"
              />
              <Button variant={mode === 'approve' ? 'primary' : 'danger'} busy={busy} disabled={mode === 'reject' && !note.trim()} onClick={send} className="h-9">
                {mode === 'approve' ? 'Confirmar aprovação' : mode === 'reject' ? 'Confirmar recusa' : 'Confirmar cancelamento'}
              </Button>
              <Button variant="ghost" onClick={() => setMode(null)}>
                Voltar
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {approver && !own && (
                <>
                  <Button variant="primary" className="h-8" onClick={() => setMode('approve')}>
                    Aprovar
                  </Button>
                  <Button variant="danger" className="h-8" onClick={() => setMode('reject')}>
                    Recusar
                  </Button>
                </>
              )}
              {(own || approver) && (
                <Button variant="ghost" className="h-8" onClick={() => setMode('cancel')}>
                  Cancelar pedido
                </Button>
              )}
              {approver && own && <span className="self-center text-xs text-ink-faint">Outra pessoa precisa aprovar o seu pedido.</span>}
            </div>
          )}
          {error && <Notice tone="bad">{error}</Notice>}
        </div>
      )}
    </li>
  );
}
