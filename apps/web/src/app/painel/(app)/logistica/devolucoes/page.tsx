'use client';

// SGLog Fase 9a: devolucoes, quarentena e politica de prazos (so informativa, D9-10).
import Link from '@/components/painel-link';
import { useCallback, useEffect, useState } from 'react';
import { REFUND_METHOD, REFUND_STATUS, RefundBadge } from '@/components/refunds';
import { CONDITION, OCCURRENCE_KIND, OCCURRENCE_STATUS, RESPONSIBILITY, RETURN_KIND, RETURN_REASON, RETURN_STATUS, ReturnBadge, SUPPLIER_RETURN_STATUS } from '@/components/returns';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Empty, Field, Input, Notice, PageHeader, Panel, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { money, qty, when } from '@/lib/format';

type Row = { id: string; number: number; order_id: string; order_number: number; kind: string; reason: string; status: string; warehouse_name: string | null; item_count: number; created_at: string; channel: string };
type List = { items: Row[]; total: number; page: number; pageSize: number; counts: { awaiting: number; to_inspect: number; to_complete: number; quarantine: number } };
type Q = { inspection_id: string; return_id: string; return_number: number; order_number: number; sku: string; product_name: string; base_unit: string; warehouse_name: string; qty: string; open_qty: string; reason: string | null; created_at: string; age_days: number };
type Policy = { regretDays: number | null; defectDays: number | null; defectNondurableDays: number | null; warrantyDays: number | null; policyText: string | null; version: number };

function Returns({ onCounts }: { onCounts: (c: List['counts']) => void }) {
  const [status, setStatus] = useState('open');
  const [kind, setKind] = useState('');
  const [order, setOrder] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<List | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const q = new URLSearchParams({ status, page: String(page), pageSize: '30' });
    if (kind) q.set('kind', kind);
    if (/^\d+$/.test(order)) q.set('order', order);
    api<List>(`/admin/returns?${q}`).then(
      (r) => {
        setData(r);
        onCounts(r.counts);
      },
      (e) => setError(e.message),
    );
  }, [status, kind, order, page, onCounts]);
  return (
    <Panel>
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Select aria-label="Situação" className="w-auto" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
          <option value="open">Em aberto</option>
          <option value="authorized">Autorizadas</option>
          <option value="in_transit">Voltando</option>
          <option value="received">Recebidas (conferir)</option>
          <option value="inspected">Conferidas</option>
          <option value="completed">Encerradas</option>
          <option value="canceled">Canceladas</option>
          <option value="all">Todas</option>
        </Select>
        <Select aria-label="Tipo" className="w-auto" value={kind} onChange={(e) => (setKind(e.target.value), setPage(1))}>
          <option value="">Todos os tipos</option>
          {Object.entries(RETURN_KIND).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Input aria-label="Pedido nº" placeholder="Pedido nº" className="w-32" inputMode="numeric" value={order} onChange={(e) => (setOrder(e.target.value), setPage(1))} />
      </div>
      {!data ? null : data.items.length === 0 ? (
        <Empty title="Nenhuma devolução">Registre pelo pedido, em Ocorrências e devoluções.</Empty>
      ) : (
        <ul className="divide-y divide-line" data-testid="return-list">
          {data.items.map((r) => (
            <li key={r.id} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/painel/logistica/devolucoes/${r.id}`} className="font-medium text-act hover:underline">
                  {RETURN_KIND[r.kind]} nº {r.number}
                </Link>
                <ReturnBadge status={r.status} />
              </div>
              <div className="min-w-0 flex-1 truncate text-sm text-ink-soft">
                Pedido nº {r.order_number} · {RETURN_REASON[r.reason] ?? r.reason} · {r.item_count} item(ns)
                {r.warehouse_name ? ` · ${r.warehouse_name}` : ''}
              </div>
              <span className="text-xs text-ink-faint">{when(r.created_at)}</span>
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
  );
}

function Quarantine() {
  const [items, setItems] = useState<Q[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ items: Q[] }>('/admin/returns/quarantine').then((r) => setItems(r.items), (e) => setError(e.message));
  }, []);
  return (
    <Panel title="Em quarentena" description="Mercadoria devolvida no saldo bloqueado, aguardando decisão (liberar, avariar ou descartar) na tela da devolução. Nada aqui aparece como disponível.">
      {error && <Notice tone="bad">{error}</Notice>}
      {!items ? null : items.length === 0 ? (
        <Empty title="Nada em quarentena" />
      ) : (
        <ul className="divide-y divide-line text-sm" data-testid="quarantine-list">
          {items.map((i) => (
            <li key={i.inspection_id} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:gap-3">
              <Link href={`/painel/logistica/devolucoes/${i.return_id}`} className="font-medium text-act hover:underline">
                Devolução nº {i.return_number}
              </Link>
              <span className="min-w-0 flex-1 truncate">
                {i.sku} · {i.product_name} · <span className="num">{qty(i.open_qty)}</span> {i.base_unit} · {i.warehouse_name} · pedido nº {i.order_number}
              </span>
              <Badge tone={i.age_days > 15 ? 'bad' : 'warn'}>{i.age_days} dia(s)</Badge>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function PolicyForm() {
  const { can, me } = useMe();
  const edit = can('settings.manage');
  const [p, setP] = useState<Policy | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const fill = useCallback((x: Policy) => {
    setP(x);
    setForm({
      regretDays: x.regretDays?.toString() ?? '',
      defectDays: x.defectDays?.toString() ?? '',
      defectNondurableDays: x.defectNondurableDays?.toString() ?? '',
      warrantyDays: x.warrantyDays?.toString() ?? '',
      policyText: x.policyText ?? '',
    });
  }, []);
  useEffect(() => {
    api<{ policy: Policy }>('/admin/returns/settings').then((r) => fill(r.policy), (e) => setError(e.message));
  }, [fill]);
  if (!p) return error ? <Notice tone="bad">{error}</Notice> : null;
  const days = (v: string) => (v.trim() === '' ? null : Number(v));
  const save = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await api<{ policy: Policy }>('/admin/returns/settings', {
        method: 'PUT',
        body: { regretDays: days(form.regretDays!), defectDays: days(form.defectDays!), defectNondurableDays: days(form.defectNondurableDays!), warrantyDays: days(form.warrantyDays!), policyText: form.policyText || null, version: p.version },
      });
      fill(r.policy);
      setNotice('Política salva.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const field = (k: string, label: string, hint: string) => (
    <Field label={label} hint={hint}>
      {(id) => <Input id={id} inputMode="numeric" value={form[k] ?? ''} disabled={!edit} onChange={(e) => setForm({ ...form, [k]: e.target.value.replace(/\D/g, '') })} />}
    </Field>
  );
  return (
    <Panel
      title="Política de devolução"
      description="Prazos de referência contados da entrega. Só informam a equipe na tela do pedido e da devolução: nenhum pedido é recusado por prazo, e a abertura de ocorrência nunca é bloqueada. Confira a política com o seu contador ou advogado."
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        data-testid="return-policy"
      >
        {error && <Notice tone="bad">{error}</Notice>}
        {notice && <Notice tone="good">{notice}</Notice>}
        {edit && !me.user.mfaEnabled && <Notice tone="warn">Salvar exige a verificação em duas etapas ativa.</Notice>}
        <div className="grid gap-3 sm:grid-cols-2">
          {field('regretDays', 'Arrependimento (dias)', 'Compra fora da loja física. Em branco: não mostra.')}
          {field('defectDays', 'Defeito, produto durável (dias)', 'Referência para vício aparente.')}
          {field('defectNondurableDays', 'Defeito, produto não durável (dias)', 'Referência para vício aparente.')}
          {field('warrantyDays', 'Garantia da loja (dias)', 'Garantia contratual, se houver.')}
        </div>
        <Field label="Texto da política (opcional)">{(id) => <Textarea id={id} value={form.policyText ?? ''} disabled={!edit} maxLength={2000} onChange={(e) => setForm({ ...form, policyText: e.target.value })} />}</Field>
        {edit && (
          <Button variant="primary" type="submit" busy={busy}>
            Salvar política
          </Button>
        )}
      </form>
    </Panel>
  );
}

type RefundRow = { id: string; number: number; order_id: string; order_number: number; return_number: number | null; amount_cents: string; method: string; external_ref: string | null; status: string; reason: string; created_at: string };
type RefundList = { items: RefundRow[]; counts: { requested: number; done: number; requested_cents: string; done_cents: string } };

function Refunds() {
  const [status, setStatus] = useState('open');
  const [data, setData] = useState<RefundList | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<RefundList>(`/admin/refunds?status=${status}&pageSize=50`).then(setData, (e) => setError(e.message));
  }, [status]);
  return (
    <Panel title="Reembolsos" description="Registros do que foi devolvido ao cliente fora do sistema. O registro e as transições ficam na tela do pedido (permissão própria, com verificação em duas etapas).">
      {error && <Notice tone="bad">{error}</Notice>}
      {data && (
        <div className="mb-3 flex flex-wrap gap-2 text-sm">
          <Badge tone="warn">
            {data.counts.requested} solicitado(s) · {money(data.counts.requested_cents)}
          </Badge>
          <Badge tone="act">
            {data.counts.done} realizado(s) sem confirmação · {money(data.counts.done_cents)}
          </Badge>
        </div>
      )}
      <Select aria-label="Situação do reembolso" className="mb-3 w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="open">Em aberto (solicitado ou realizado)</option>
        <option value="confirmed">Confirmados</option>
        <option value="canceled">Cancelados</option>
        <option value="all">Todos</option>
      </Select>
      {!data ? null : data.items.length === 0 ? (
        <Empty title="Nenhum reembolso" />
      ) : (
        <ul className="divide-y divide-line text-sm" data-testid="refund-queue">
          {data.items.map((r) => (
            <li key={r.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/painel/pedidos/${r.order_id}`} className="font-medium text-act hover:underline">
                  Pedido nº {r.order_number}
                </Link>
                <span className="num">{money(r.amount_cents)}</span>
                <RefundBadge status={r.status} />
              </div>
              <span className="min-w-0 flex-1 truncate text-ink-soft">
                Nº {r.number} · {REFUND_METHOD[r.method]}
                {r.external_ref ? ` · ref. ${r.external_ref}` : ''} · {r.reason}
              </span>
              <span className="text-xs text-ink-faint">{when(r.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

type ReportData = {
  returns: { kind: string; reason: string; status: string; n: number }[];
  conditions: { condition: string; qty: string; cost_cents: string }[];
  occurrences: { kind: string; responsibility: string; status: string; n: number }[];
  refunds: { method: string; status: string; n: number; amount_cents: string }[];
  supplierReturns: { status: string; n: number; qty: string }[];
  pending: { fiscal_pending: number; refunds_requested: number; refunds_unconfirmed: number; orders_on_hold: number };
};

function ReportTable({ title, head, rows }: { title: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <div>
      <h3 className="mb-1 text-sm font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-soft">Nada no período.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead className="text-left text-ink-soft">
              <tr>
                {head.map((h) => (
                  <th key={h} className="py-1 pr-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-line">
                  {r.map((c, j) => (
                    <td key={j} className="num py-1 pr-2">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Report() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today.slice(0, 8) + '01');
  const [to, setTo] = useState(today);
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!from || !to) return;
    api<ReportData>(`/admin/returns/report?from=${from}&to=${to}`).then(
      (r) => {
        setError('');
        setData(r);
      },
      (e) => setError(e.message),
    );
  }, [from, to]);
  const st = (s: string) => RETURN_STATUS[s]?.label ?? REFUND_STATUS[s]?.label ?? s;
  return (
    <Panel title="Relatório do período" description="Devoluções, conferência por condição (valor pelo custo de entrada), ocorrências, reembolsos registrados (não conciliados) e devoluções ao fornecedor.">
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Field label="De">{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="Até">{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {data && (
        <div className="space-y-5" data-testid="returns-report">
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge tone={data.pending.fiscal_pending ? 'warn' : 'neutral'}>{data.pending.fiscal_pending} com pendência fiscal</Badge>
            <Badge tone={data.pending.refunds_requested ? 'warn' : 'neutral'}>{data.pending.refunds_requested} reembolso(s) solicitado(s)</Badge>
            <Badge tone={data.pending.refunds_unconfirmed ? 'act' : 'neutral'}>{data.pending.refunds_unconfirmed} realizado(s) sem confirmação</Badge>
            <Badge tone={data.pending.orders_on_hold ? 'bad' : 'neutral'}>{data.pending.orders_on_hold} pedido(s) com ocorrência</Badge>
          </div>
          <ReportTable title="Devoluções" head={['Tipo', 'Motivo', 'Situação', 'Qtd.']} rows={data.returns.map((r) => [RETURN_KIND[r.kind] ?? r.kind, RETURN_REASON[r.reason] ?? r.reason, st(r.status), r.n])} />
          <ReportTable title="Conferência" head={['Condição', 'Quantidade', 'Valor (custo)']} rows={data.conditions.map((c) => [CONDITION[c.condition]?.label ?? c.condition, qty(c.qty), money(c.cost_cents)])} />
          <ReportTable
            title="Ocorrências"
            head={['Tipo', 'Responsável', 'Situação', 'Qtd.']}
            rows={data.occurrences.map((o) => [OCCURRENCE_KIND[o.kind] ?? o.kind, RESPONSIBILITY[o.responsibility] ?? o.responsibility, OCCURRENCE_STATUS[o.status]?.label ?? o.status, o.n])}
          />
          <ReportTable title="Reembolsos registrados" head={['Meio', 'Situação', 'Qtd.', 'Valor']} rows={data.refunds.map((r) => [REFUND_METHOD[r.method] ?? r.method, st(r.status), r.n, money(r.amount_cents)])} />
          <ReportTable title="Devoluções ao fornecedor" head={['Situação', 'Qtd.', 'Itens']} rows={data.supplierReturns.map((r) => [SUPPLIER_RETURN_STATUS[r.status]?.label ?? r.status, r.n, qty(r.qty)])} />
        </div>
      )}
    </Panel>
  );
}

function Page() {
  const [tab, setTab] = useState<'list' | 'quarantine' | 'refunds' | 'report' | 'policy'>('list');
  const [counts, setCounts] = useState<List['counts'] | null>(null);
  const tabs: [typeof tab, string][] = [
    ['list', 'Devoluções'],
    ['quarantine', `Quarentena${counts?.quarantine ? ` (${counts.quarantine})` : ''}`],
    ['refunds', 'Reembolsos'],
    ['report', 'Relatório'],
    ['policy', 'Política'],
  ];
  return (
    <>
      <PageHeader
        title="Devoluções"
        description="Devolução, recusa na entrega e troca. Autorizar e receber não mexem no estoque: só a conferência movimenta (boa, quarentena, avariada, descartada ou faltando)."
      />
      {counts && (
        <div className="mb-4 flex flex-wrap gap-2 text-sm" data-testid="return-counts">
          <Badge tone="warn">{counts.awaiting} aguardando chegada</Badge>
          <Badge tone="bad">{counts.to_inspect} para conferir</Badge>
          <Badge tone="act">{counts.to_complete} para encerrar</Badge>
        </div>
      )}
      <div className="mb-4 flex flex-wrap gap-1 border-b border-line" role="tablist">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? 'border-act text-ink' : 'border-transparent text-ink-soft hover:text-ink'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'list' && <Returns onCounts={setCounts} />}
      {tab === 'quarantine' && <Quarantine />}
      {tab === 'refunds' && <Refunds />}
      {tab === 'report' && <Report />}
      {tab === 'policy' && <PolicyForm />}
    </>
  );
}

export default function DevolucoesPage() {
  return (
    <Guard perm="returns.manage|returns.receive|occurrences.manage|logistics.view|orders.view">
      <Page />
    </Guard>
  );
}
