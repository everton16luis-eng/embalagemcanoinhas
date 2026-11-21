'use client';

// SGLog Fase 9a: devolucoes, quarentena e politica de prazos (so informativa, D9-10).
import Link from '@/components/painel-link';
import { useCallback, useEffect, useState } from 'react';
import { RETURN_KIND, RETURN_REASON, ReturnBadge } from '@/components/returns';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Empty, Field, Input, Notice, PageHeader, Panel, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { qty, when } from '@/lib/format';

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

function Page() {
  const [tab, setTab] = useState<'list' | 'quarantine' | 'policy'>('list');
  const [counts, setCounts] = useState<List['counts'] | null>(null);
  const tabs: [typeof tab, string][] = [
    ['list', 'Devoluções'],
    ['quarantine', `Quarentena${counts?.quarantine ? ` (${counts.quarantine})` : ''}`],
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
