'use client';

// SGLog Fase 8 (docs/35-sglog-fase8.md): Logística → Fretes. Remessas a cotar, cotadas, etiquetas, rastreio parado,
// despachadas sem custo, fila de integrações (com reprocessamento) e o relatório cobrado × cotado × pago.
// A compra de etiqueta aparece sempre com o motivo do bloqueio; nada aqui compra.
import Link from '@/components/painel-link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LABEL_STATUS } from '@/components/freight';
import { ShipmentBadge } from '@/components/shipments';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Empty, Field, Input, Notice, PageHeader, Panel, Select, type Tone } from '@/components/ui';
import { api } from '@/lib/api';
import { money, when } from '@/lib/format';

type Overview = {
  provider: { name: string; capabilities: Record<string, boolean> } | null;
  gate: { allowed: boolean; reasons: string[]; maxCents: number | null };
  settings: { tracking_poll_hours: number; tracking_stale_days: number };
  counts: {
    to_quote: number;
    quoted: number;
    stale: number;
    without_cost: number;
    jobs_dead: number;
    jobs_retrying: number;
    jobs_open: number;
    webhooks_pending: number;
  };
  labels: Record<string, number>;
};
type Row = {
  id: string;
  seq: number;
  kind: string;
  status: string;
  carrier: string | null;
  tracking_code: string | null;
  shipped_at: string | null;
  packed_at: string | null;
  last_tracked_at: string | null;
  last_tracking_event_at: string | null;
  order_number: number;
  freight_cents: number;
  warehouse_name: string | null;
  quoted_cents: number | null;
  service_name: string | null;
  label_status: string | null;
  net_cents: number | null;
};
type Job = {
  id: string;
  kind: string;
  ref_id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  last_error: string | null;
  updated_at: string;
  logs:
    | {
        operation: string;
        httpStatus: number | null;
        ok: boolean;
        error: string | null;
        at: string;
      }[]
    | null;
};
type Report = {
  from: string;
  to: string;
  items: {
    shipmentId: string;
    orderNumber: number;
    seq: number;
    legacy: boolean;
    shippedAt: string;
    carrier: string | null;
    chargedCents: number;
    chargedSplit: boolean;
    quotedCents: number | null;
    netCents: number | null;
    pendingRefunds: number;
    diffCents: number | null;
  }[];
  totals: {
    shipments: number;
    chargedCents: number;
    quotedCents: number | null;
    quotedShipments: number;
    knownShipments: number;
    unknownShipments: number;
    knownChargedCents: number;
    netCents: number | null;
    diffCents: number | null;
    pendingRefunds: number;
  };
  byCarrier: {
    carrier: string;
    shipments: number;
    chargedCents: number;
    netCents: number;
    unknown: number;
    diffCents: number | null;
  }[];
};

const VIEWS: {
  key: string;
  label: string;
  count: keyof Overview['counts'] | null;
  tone: Tone;
}[] = [
  { key: 'to_quote', label: 'A cotar', count: 'to_quote', tone: 'act' },
  { key: 'quoted', label: 'Cotadas', count: 'quoted', tone: 'neutral' },
  { key: 'stale', label: 'Rastreio parado', count: 'stale', tone: 'warn' },
  {
    key: 'without_cost',
    label: 'Sem custo informado',
    count: 'without_cost',
    tone: 'warn',
  },
  { key: 'tracking', label: 'Em transporte', count: null, tone: 'neutral' },
  { key: 'labels', label: 'Etiquetas', count: null, tone: 'neutral' },
];
const JOB_KIND: Record<string, string> = {
  label_purchase: 'Compra de etiqueta',
  label_reconcile: 'Conferência de etiqueta',
  label_cancel: 'Cancelamento de etiqueta',
  tracking_poll: 'Consulta de rastreio',
  webhook_process: 'Aviso do transportador',
};
const JOB_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Na fila', tone: 'neutral' },
  running: { label: 'Rodando', tone: 'act' },
  dead: { label: 'Falhou', tone: 'bad' },
  done: { label: 'Concluída', tone: 'good' },
  canceled: { label: 'Cancelada', tone: 'neutral' },
};
const PROVIDER: Record<string, string> = {
  melhorenvio: 'Melhor Envio',
  fake: 'Simulado (testes)',
};

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const monthStart = () => `${today().slice(0, 8)}01`;
const cents = (v: number | null) => (v === null ? 'não informado' : money(v));

function Shipments({ view }: { view: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    // Cliques seguidos nos cards: so a resposta do card atual vale; erro de um card nao fica preso nos outros.
    let current = true;
    setRows(null);
    setErr('');
    api<{ items: Row[] }>(`/admin/freight/shipments?view=${view}&pageSize=50`).then(
      (r) => current && setRows(r.items),
      (e) => current && setErr(e.message),
    );
    return () => {
      current = false;
    };
  }, [view]);
  if (err) return <Notice tone="bad">{err}</Notice>;
  if (!rows) return <p className="text-sm text-ink-soft">Carregando…</p>;
  if (!rows.length) return <Empty title="Nenhuma remessa nesta lista." />;
  return (
    <ul className="divide-y divide-line" data-testid="freight-list">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
          <span className="min-w-0">
            <Link href={`/painel/logistica/expedicao/${r.id}`} className="font-medium text-act hover:underline">
              Pedido {r.order_number} · remessa {r.seq}
            </Link>
            <span className="block text-xs text-ink-faint">
              {r.warehouse_name ?? '—'}
              {r.service_name && ` · ${r.service_name}`}
              {r.carrier && ` · ${r.carrier}`}
              {r.tracking_code && ` · ${r.tracking_code}`}
              {r.shipped_at ? ` · saiu ${when(r.shipped_at)}` : r.packed_at ? ` · embalada ${when(r.packed_at)}` : ''}
              {view === 'stale' && ` · último evento ${when(r.last_tracking_event_at ?? r.shipped_at)}`}
            </span>
          </span>
          <span className="flex flex-wrap items-center gap-2">
            {r.label_status && <Badge tone={LABEL_STATUS[r.label_status]?.tone ?? 'neutral'}>{LABEL_STATUS[r.label_status]?.label ?? r.label_status}</Badge>}
            <ShipmentBadge status={r.status} />
            <span className="num text-xs text-ink-soft">
              cobrado {money(r.freight_cents)} · cotado {r.quoted_cents === null ? '—' : money(r.quoted_cents)} · pago {cents(r.net_cents)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Jobs({ onChanged }: { onChanged: () => void }) {
  const { can } = useMe();
  const [status, setStatus] = useState('dead');
  const [rows, setRows] = useState<Job[] | null>(null);
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    return api<{ items: Job[] }>(`/admin/freight/jobs?status=${status}&pageSize=30`).then(
      (r) => n === seq.current && setRows(r.items),
      (e) => n === seq.current && setMsg({ tone: 'bad', text: e.message }),
    );
  }, [status]);
  useEffect(() => {
    setRows(null);
    setMsg(null);
    load();
  }, [load]);
  const retry = async (id: string) => {
    setBusy(id);
    setMsg(null);
    try {
      await api(`/admin/freight/jobs/${id}/retry`, {
        method: 'POST',
        body: {},
      });
      setMsg({ tone: 'good', text: 'Tarefa de volta na fila.' });
      await load();
      onChanged();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy('');
    }
  };
  return (
    <Panel
      title="Fila de integrações"
      description="Consultas e avisos do transportador. Falha repetida vira “Falhou” e pode ser reprocessada."
      actions={
        <Select aria-label="Situação da tarefa" className="w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="dead">Com falha</option>
          <option value="open">Na fila</option>
          <option value="done">Concluídas</option>
          <option value="all">Todas</option>
        </Select>
      }
    >
      {msg && (
        <div className="mb-2">
          <Notice tone={msg.tone}>{msg.text}</Notice>
        </div>
      )}
      {!rows ? (
        <p className="text-sm text-ink-soft">Carregando…</p>
      ) : !rows.length ? (
        <Empty title="Nenhuma tarefa." />
      ) : (
        <ul className="divide-y divide-line text-sm" data-testid="freight-jobs">
          {rows.map((j) => (
            <li key={j.id} className="py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <b>{JOB_KIND[j.kind] ?? j.kind}</b>{' '}
                  <span className="text-xs text-ink-faint">
                    tentativa {j.attempts}/{j.max_attempts} · {j.status === 'pending' ? `próxima ${when(j.next_run_at)}` : when(j.updated_at)}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={JOB_STATUS[j.status]?.tone ?? 'neutral'}>{JOB_STATUS[j.status]?.label ?? j.status}</Badge>
                  {j.status === 'dead' && can('logistics.manage') && (
                    <Button busy={busy === j.id} onClick={() => void retry(j.id)}>
                      Reprocessar
                    </Button>
                  )}
                </span>
              </div>
              {j.last_error && <p className="mt-1 break-words text-xs text-ink-soft">{j.last_error}</p>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ReportPanel() {
  const [range, setRange] = useState({ from: monthStart(), to: today() });
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    setErr('');
    if (!range.from || !range.to) return;
    api<{ report: Report }>(`/admin/freight/report?from=${range.from}&to=${range.to}`).then(
      (x) => n === seq.current && setR(x.report),
      (e) => n === seq.current && setErr(e.message),
    );
  }, [range]);
  useEffect(() => {
    load();
  }, [load]);
  const t = r?.totals;
  return (
    <Panel title="Cobrado × cotado × pago" description="Por data de despacho. A diferença só compara remessas com custo informado; as demais aparecem à parte.">
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="De">{(fid) => <Input id={fid} type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />}</Field>
        <Field label="Até">{(fid) => <Input id={fid} type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />}</Field>
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      {t && (
        <div data-testid="freight-report">
          <dl className="mb-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div className="rounded-md border border-line p-2">
              <dt className="text-xs text-ink-soft">Cobrado ({t.shipments} remessas)</dt>
              <dd className="num font-semibold">{money(t.chargedCents)}</dd>
            </div>
            <div className="rounded-md border border-line p-2">
              <dt className="text-xs text-ink-soft">Cotado ({t.quotedShipments})</dt>
              <dd className="num font-semibold">{t.quotedCents === null ? '—' : money(t.quotedCents)}</dd>
            </div>
            <div className="rounded-md border border-line p-2">
              <dt className="text-xs text-ink-soft">Pago ({t.knownShipments})</dt>
              <dd className="num font-semibold">{cents(t.netCents)}</dd>
            </div>
            <div className="rounded-md border border-line p-2">
              <dt className="text-xs text-ink-soft">Cobrado − pago</dt>
              <dd className={`num font-semibold ${t.diffCents !== null && t.diffCents < 0 ? 'text-bad' : ''}`}>{t.diffCents === null ? '—' : money(t.diffCents)}</dd>
              {t.knownShipments > 0 && <dd className="text-xs text-ink-faint">sobre {money(t.knownChargedCents)} cobrados</dd>}
            </div>
          </dl>
          {t.unknownShipments > 0 && <p className="mb-2 text-xs text-warn">{t.unknownShipments} remessa(s) sem custo informado ficaram fora da diferença.</p>}
          {t.pendingRefunds > 0 && <p className="mb-2 text-xs text-warn">{t.pendingRefunds} estorno(s) de etiqueta ainda não confirmado(s).</p>}
          {r.byCarrier.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="text-left text-xs text-ink-soft">
                  <tr>
                    <th className="py-1 font-medium">Transportadora</th>
                    <th className="py-1 pl-3 text-right font-medium">Remessas</th>
                    <th className="py-1 pl-3 text-right font-medium">Cobrado</th>
                    <th className="py-1 pl-3 text-right font-medium">Pago</th>
                    <th className="py-1 pl-3 text-right font-medium">Diferença</th>
                  </tr>
                </thead>
                <tbody>
                  {r.byCarrier.map((g) => (
                    <tr key={g.carrier} className="border-t border-line">
                      <td className="py-1">{g.carrier}</td>
                      <td className="num whitespace-nowrap py-1 pl-3 text-right">
                        {g.shipments}
                        {g.unknown > 0 && <span className="text-xs text-ink-faint"> ({g.unknown} sem custo)</span>}
                      </td>
                      <td className="num whitespace-nowrap py-1 pl-3 text-right">{money(g.chargedCents)}</td>
                      <td className="num whitespace-nowrap py-1 pl-3 text-right">{g.shipments > g.unknown ? money(g.netCents) : 'não informado'}</td>
                      <td className="num whitespace-nowrap py-1 pl-3 text-right">{g.diffCents === null ? '—' : money(g.diffCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function Page() {
  const { can } = useMe();
  const [o, setO] = useState<Overview | null>(null);
  const [err, setErr] = useState('');
  const [view, setView] = useState('to_quote');
  const load = useCallback(
    () =>
      api<Overview>('/admin/freight/overview').then(
        (r) => setO(r),
        (e) => setErr(e.message),
      ),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  return (
    <>
      <PageHeader title="Fretes" description="Cotação pelo depósito de origem e volumes medidos, rastreio e custo real de cada remessa." />
      {err && <Notice tone="bad">{err}</Notice>}
      {o && (
        <>
          <div className="mb-4 space-y-2" data-testid="freight-gate">
            <Notice tone="neutral">
              Transportador: {o.provider ? (PROVIDER[o.provider.name] ?? o.provider.name) : 'nenhum configurado (frete manual)'}
              {o.provider &&
                ` · cotação ${o.provider.capabilities.quote ? 'sim' : 'não'} · rastreio ${o.provider.capabilities.track ? 'sim' : 'não'} · avisos ${o.provider.capabilities.webhook ? 'sim' : 'não'}`}
              {` · rastreio consultado a cada ${o.settings.tracking_poll_hours} h; parado depois de ${o.settings.tracking_stale_days} dia(s).`}
            </Notice>
            {!o.gate.allowed && (
              <Notice tone="warn">
                Compra de etiqueta pelo sistema: bloqueada. <span className="text-xs">{o.gate.reasons.join(' ')}</span>
              </Notice>
            )}
          </div>
          <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="freight-counts">
            {VIEWS.map((v) => {
              const on = view === v.key;
              const n = v.count ? o.counts[v.count] : v.key === 'labels' ? Object.values(o.labels).reduce((s, x) => s + x, 0) : null;
              return (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => setView(v.key)}
                  aria-pressed={on}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${on ? 'border-act bg-act/5' : 'border-line bg-card hover:bg-sunken/50'}`}
                >
                  <span className="block text-xs text-ink-soft">{v.label}</span>
                  <span className="num text-lg font-semibold">{n ?? '—'}</span>
                </button>
              );
            })}
          </div>
          <div className="grid gap-5 lg:grid-cols-[1fr_400px]">
            <div className="min-w-0 space-y-5">
              <Panel title={VIEWS.find((v) => v.key === view)?.label}>
                <Shipments view={view} />
              </Panel>
              {(can('shipping.manage') || can('reports.view')) && <ReportPanel />}
            </div>
            <div className="min-w-0 space-y-5">
              {(o.counts.jobs_dead > 0 || o.counts.webhooks_pending > 0) && (
                <Notice tone="warn">
                  {o.counts.jobs_dead > 0 && `${o.counts.jobs_dead} tarefa(s) com falha. `}
                  {o.counts.webhooks_pending > 0 && `${o.counts.webhooks_pending} aviso(s) do transportador aguardando.`}
                </Notice>
              )}
              <Jobs onChanged={load} />
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default function FretesPage() {
  return (
    <Guard perm="logistics.view">
      <Page />
    </Guard>
  );
}
