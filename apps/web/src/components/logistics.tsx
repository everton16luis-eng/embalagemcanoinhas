'use client';

// SGLog Fase 4 (docs/23-sglog-fase4.md): alocacao do pedido em deposito ou fornecedor.
import { useCallback, useEffect, useState } from 'react';
import { useMe } from '@/components/shell';
import { newKey } from '@/components/stock';
import { Badge, Button, Field, Notice, Panel, Textarea, type Tone } from '@/components/ui';
import { api } from '@/lib/api';
import { money, qty, when } from '@/lib/format';

export const LOGISTICS_STATUS: Record<string, { label: string; tone: Tone }> = {
  awaiting: { label: 'Aguardando alocação', tone: 'warn' },
  analysis: { label: 'Em análise', tone: 'bad' },
  processing: { label: 'Alocado', tone: 'good' },
  shipped: { label: 'Despachado', tone: 'neutral' },
  completed: { label: 'Concluído', tone: 'neutral' },
  canceled: { label: 'Cancelado', tone: 'neutral' },
};
const MODE_LABEL: Record<string, string> = { stock: 'Estoque próprio', purchase_to_order: 'Encomenda ao fornecedor', dropship: 'Dropshipping' };
const DECISION_LABEL: Record<string, string> = {
  auto: 'Alocação automática',
  manual: 'Alocação confirmada',
  change: 'Origem trocada',
  detach: 'Alocação desfeita',
  analysis: 'Enviado para análise',
  shortage: 'Falta descoberta',
  order_canceled: 'Pedido cancelado',
  shipped: 'Pedido despachado',
};

type Line = { orderItemId: string; sku: string; qty: number; mode: string; warehouseId: string | null; supplierName: string | null; unitCostCents?: number | null; leadDays: number | null };
type Plan = { key: string; label: string; lines: Line[]; supplierCostCents?: number; leadDays: number | null; reasons: string[] };
type Proposal = {
  engineVersion: string;
  criteria: string[];
  automatic: boolean;
  recommended: Plan | null;
  alternatives: Plan[];
  warehouses: { id: string; name: string; isDefault: boolean; priority: number; coversAll: boolean; short: { sku: string; need: number; free: number }[] }[];
  analysisReason: string | null;
  suggestions: string[];
  excluded: { key: string; reasons: string[] }[];
};
type Detail = {
  order: { id: string; number: number; status: string; channel: string; logistics_status: string | null; logistics_note: string | null; logistics_version: number; allocation_required: boolean };
  items: { id: string; sku: string; product_name: string; need: string }[];
  canAllocate: boolean;
  proposal: Proposal | null;
  fulfillments: {
    id: string;
    mode: string;
    status: string;
    warehouse_name: string | null;
    supplier_name: string | null;
    cancel_reason: string | null;
    created_at: string;
    created_by_name: string | null;
    allocations: { id: string; sku: string; qty: string; status: string; unitCostCents?: number | null }[];
  }[];
  reservations: { id: string; sku: string; qty: string; backorder: boolean; allocation_id: string | null; warehouse_name: string }[];
  decisions: { id: string; kind: string; justification: string | null; created_at: string; actor_name: string | null; recommended_label: string | null; analysis_reason: string | null }[];
  dropshipStatus: string;
  auto: boolean;
};

export function LogisticsBadge({ status }: { status: string | null }) {
  if (!status) return null;
  const s = LOGISTICS_STATUS[status] ?? { label: status, tone: 'neutral' as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

function PlanCard({ plan, recommended, chosen, onChoose, disabled }: { plan: Plan; recommended: boolean; chosen: boolean; onChoose: () => void; disabled: boolean }) {
  return (
    <label className={`block cursor-pointer rounded-md border p-3 text-sm ${chosen ? 'border-act bg-act-tint/40' : 'border-line'} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}>
      <span className="flex items-start gap-2">
        <input type="radio" name="plan" className="mt-1" checked={chosen} onChange={onChoose} disabled={disabled} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5 font-medium">
            {plan.label}
            {recommended && <Badge tone="act">Recomendada</Badge>}
          </span>
          <ul className="mt-1 space-y-0.5 text-xs text-ink-soft">
            {plan.lines.map((l, i) => (
              <li key={i}>
                {l.sku}: {qty(l.qty)} · {MODE_LABEL[l.mode] ?? l.mode}
                {l.supplierName && ` · ${l.supplierName}`}
                {l.leadDays ? ` · ${l.leadDays} dias` : ''}
              </li>
            ))}
          </ul>
          {plan.supplierCostCents !== undefined && plan.supplierCostCents > 0 && <span className="mt-1 block text-xs">Custo do fornecedor: {money(plan.supplierCostCents)}</span>}
          <ul className="mt-1 list-disc pl-4 text-xs text-ink-faint">
            {plan.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </span>
      </span>
    </label>
  );
}

/** Bloco de alocacao do pedido: proposta do motor, confirmar, trocar, desfazer e historico. */
export function AllocationPanel({ orderId, onChange }: { orderId: string; onChange?: () => void }) {
  const { can } = useMe();
  const [d, setD] = useState<Detail | null>(null);
  const [planKey, setPlanKey] = useState('');
  const [why, setWhy] = useState('');
  const [undoing, setUndoing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null);
  const [requestKey, setRequestKey] = useState(newKey);

  const load = useCallback(
    () =>
      api<Detail>(`/admin/logistics/orders/${orderId}`).then(
        (r) => {
          setD(r);
          setPlanKey(r.proposal?.recommended?.key ?? '');
        },
        (e) => setMsg({ tone: 'bad', text: e.message }),
      ),
    [orderId],
  );
  useEffect(() => {
    load();
  }, [load]);
  if (!d) return msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null;

  const p = d.proposal;
  const plans = p ? [p.recommended, ...p.alternatives].filter((x): x is Plan => Boolean(x)) : [];
  const processing = d.order.logistics_status === 'processing';
  const isRecommended = planKey !== '' && planKey === p?.recommended?.key;
  const needsWhy = processing || !isRecommended;
  const mayAllocate = can('logistics.allocate') && d.canAllocate;

  const run = async (path: string, body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/admin/logistics/orders/${orderId}/${path}`, { method: 'POST', body: { ...body, logisticsVersion: d.order.logistics_version, requestKey } });
      setMsg({ tone: 'good', text: ok });
      setWhy('');
      setUndoing(false);
      setRequestKey(newKey());
      await load();
      onChange?.();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
      // Conflito de versao ou proposta mudada: recarrega para a pessoa conferir de novo.
      setRequestKey(newKey());
      await load();
    } finally {
      setBusy(false);
    }
  };

  const active = d.fulfillments.filter((f) => f.status === 'confirmed');
  return (
    <Panel
      title="Alocação"
      description="De onde sai cada item: depósito próprio ou fornecedor. O despacho de pedido novo só é liberado com a alocação confirmada."
      actions={<LogisticsBadge status={d.order.logistics_status} />}
    >
      {msg && (
        <div className="mb-3">
          <Notice tone={msg.tone}>{msg.text}</Notice>
        </div>
      )}
      {d.order.logistics_note && (
        <div className="mb-3">
          <Notice tone={d.order.logistics_status === 'analysis' ? 'warn' : 'neutral'}>{d.order.logistics_note}</Notice>
        </div>
      )}
      {!d.order.allocation_required && !d.order.logistics_status && <p className="text-sm text-ink-soft">Pedido anterior à alocação: segue o fluxo antigo, sem exigência.</p>}

      {active.length > 0 && (
        <div className="mb-4 space-y-2">
          <p className="text-sm font-semibold">Origem confirmada</p>
          {active.map((f) => (
            <div key={f.id} className="rounded-md bg-sunken px-3 py-2 text-sm">
              <span className="font-medium">
                {MODE_LABEL[f.mode] ?? f.mode} · {f.warehouse_name ?? f.supplier_name}
                {f.mode === 'purchase_to_order' && f.supplier_name && ` (${f.supplier_name}, entrega no ${f.warehouse_name})`}
              </span>
              <span className="block text-xs text-ink-faint">
                {f.allocations
                  .filter((a) => a.status === 'active')
                  .map((a) => `${a.sku}: ${qty(a.qty)}`)
                  .join(' · ')}
              </span>
            </div>
          ))}
        </div>
      )}

      {p && d.canAllocate && (
        <div className="space-y-3">
          {p.analysisReason && <Notice tone="warn">{p.analysisReason}</Notice>}
          {p.suggestions.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-ink-soft">
              {p.suggestions.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          )}
          {p.excluded.map((x) => (
            <p key={x.key} className="text-[13px] text-ink-faint">
              {x.reasons.join(' ')}
            </p>
          ))}
          {plans.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-semibold">{processing ? 'Trocar a origem' : 'Opções'}</p>
              {plans.map((pl) => (
                <PlanCard key={pl.key} plan={pl} recommended={pl.key === p.recommended?.key} chosen={planKey === pl.key} onChoose={() => setPlanKey(pl.key)} disabled={!mayAllocate} />
              ))}
            </div>
          )}
          {mayAllocate && plans.length > 0 && (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run('allocation', { planKey, ...(why.trim() ? { justification: why.trim() } : {}) }, processing ? 'Origem trocada.' : 'Alocação confirmada. A reserva ficou no depósito escolhido.');
              }}
            >
              {needsWhy && (
                <Field label={processing ? 'Motivo da troca' : 'Motivo para não usar a recomendada'} required>
                  {(fid) => <Textarea id={fid} required minLength={3} maxLength={500} value={why} onChange={(e) => setWhy(e.target.value)} />}
                </Field>
              )}
              <Button type="submit" variant="primary" busy={busy} disabled={!planKey}>
                {processing ? 'Trocar origem' : 'Confirmar alocação'}
              </Button>
            </form>
          )}
          <details className="text-[13px] text-ink-soft">
            <summary className="cursor-pointer">Como o motor decidiu (versão {p.engineVersion})</summary>
            <ol className="mt-2 list-decimal space-y-0.5 pl-5">
              {p.criteria.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ol>
            <ul className="mt-2 space-y-0.5">
              {p.warehouses.map((w) => (
                <li key={w.id}>
                  {w.name}
                  {w.isDefault ? ' (padrão)' : ` (prioridade ${w.priority})`}: {w.coversAll ? 'cobre o pedido' : w.short.map((s) => `${s.sku} livre ${qty(s.free)} de ${qty(s.need)}`).join('; ')}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {processing && can('logistics.allocate') && (
        <div className="mt-4 border-t border-line pt-3">
          {!undoing ? (
            <Button variant="ghost" onClick={() => setUndoing(true)}>
              Desfazer alocação
            </Button>
          ) : (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run('allocation/cancel', { reason: why.trim() }, 'Alocação desfeita. A reserva continua com o pedido e ele foi para análise.');
              }}
            >
              <Field label="Motivo" required>
                {(fid) => <Textarea id={fid} required minLength={3} maxLength={500} value={why} onChange={(e) => setWhy(e.target.value)} />}
              </Field>
              <p className="text-[13px] text-ink-soft">A mercadoria continua reservada para este pedido; nada volta para venda.</p>
              <div className="flex gap-2">
                <Button type="submit" variant="danger" busy={busy}>
                  Desfazer
                </Button>
                <Button type="button" variant="ghost" onClick={() => setUndoing(false)}>
                  Voltar
                </Button>
              </div>
            </form>
          )}
        </div>
      )}

      {d.reservations.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="mb-1 text-sm font-semibold">Reservas</p>
          <ul className="space-y-0.5 text-[13px]">
            {d.reservations.map((r) => (
              <li key={r.id}>
                {r.sku}: {qty(r.qty)} no {r.warehouse_name}
                {r.backorder && ' · aguardando mercadoria'}
                {!r.allocation_id && ' · sem alocação'}
              </li>
            ))}
          </ul>
        </div>
      )}

      {d.decisions.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="mb-1 text-sm font-semibold">Histórico da alocação</p>
          <ol className="space-y-1.5 text-[13px]">
            {d.decisions.map((x) => (
              <li key={x.id}>
                <span className="font-medium">{DECISION_LABEL[x.kind] ?? x.kind}</span>
                <span className="text-ink-faint">
                  {' '}
                  · {when(x.created_at)} · {x.actor_name ?? 'rotina'}
                </span>
                {x.justification && <span className="block text-ink-soft">Motivo: {x.justification}</span>}
                {x.analysis_reason && x.kind === 'analysis' && <span className="block text-ink-soft">{x.analysis_reason}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Panel>
  );
}
