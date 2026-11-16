'use client';

import Link from '@/components/painel-link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { Guard, useMe } from '@/components/shell';
import { SupplierBadge } from '@/components/suppliers';
import { Badge, Button, Empty, Field, Input, Notice, PageHeader, Panel, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { formatCnpj, when } from '@/lib/format';

const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
const PAGE = 25;

type Row = {
  id: string;
  name: string;
  legal_name: string | null;
  document: string | null;
  city: string | null;
  uf: string | null;
  lead_time_days: number | null;
  prep_days: number | null;
  delivery_days: number | null;
  status: string;
  blocked_reason: string | null;
  archived_at: string | null;
  dropship_enabled: boolean;
  offer_count: number;
  last_receipt_at: string | null;
  stale_quotes: number;
  expired_availability: number;
  missing_contact: boolean;
  missing_document: boolean;
};
type Summary = { active: number; inactive: number; blocked: number; archived: number; stale_quotes: number; expired_availability: number; variants_without_primary: number; single_supplier_variants: number };
type Settings = { tie_tolerance_pct: string; stale_quote_days: number; availability_warning_days: number; version: number };

const leadText = (s: Row) => (s.prep_days !== null && s.delivery_days !== null ? `${s.prep_days}+${s.delivery_days} d` : s.lead_time_days !== null ? `${s.lead_time_days} d` : '—');

function alertsOf(s: Row) {
  const a: string[] = [];
  if (s.stale_quotes) a.push(`${s.stale_quotes} cotação(ões) antiga(s)`);
  if (s.expired_availability) a.push(`${s.expired_availability} disponibilidade(s) vencida(s)`);
  if (s.missing_contact) a.push('sem contato');
  if (s.missing_document) a.push('sem CNPJ/CPF');
  return a;
}

function SettingsPanel({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => void }) {
  const [form, setForm] = useState({ tie: String(Number(settings.tie_tolerance_pct)).replace('.', ','), stale: String(settings.stale_quote_days), warn: String(settings.availability_warning_days) });
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api('/admin/suppliers/settings', {
        method: 'PUT',
        body: { tieTolerancePct: Number(form.tie.replace(',', '.')), staleQuoteDays: Number(form.stale), availabilityWarningDays: Number(form.warn), version: settings.version },
      });
      onSaved(r.settings);
      setMsg({ tone: 'good', text: 'Parâmetros salvos.' });
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Parâmetros" description="Usados nos alertas e na sugestão de fornecedor. Não mudam a reposição.">
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-4 sm:items-end">
        <Field label="Empate técnico (%)" hint="Diferença de custo total tratada como empate.">
          {(id) => <Input id={id} inputMode="decimal" value={form.tie} onChange={(e) => setForm({ ...form, tie: e.target.value })} />}
        </Field>
        <Field label="Cotação antiga (dias)">{(id) => <Input id={id} inputMode="numeric" value={form.stale} onChange={(e) => setForm({ ...form, stale: e.target.value })} />}</Field>
        <Field label="Aviso de disponibilidade (dias)">{(id) => <Input id={id} inputMode="numeric" value={form.warn} onChange={(e) => setForm({ ...form, warn: e.target.value })} />}</Field>
        <Button variant="primary" busy={busy}>
          Salvar parâmetros
        </Button>
      </form>
      {msg && (
        <div className="mt-3">
          <Notice tone={msg.tone}>{msg.text}</Notice>
        </div>
      )}
    </Panel>
  );
}

function SupplierList() {
  const { can } = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  // Filtros e pagina ficam na URL: voltar da pagina do fornecedor mantem a lista como estava.
  const f = { q: sp.get('q') ?? '', status: sp.get('status') ?? 'current', uf: sp.get('uf') ?? '', alert: sp.get('alert') ?? '', dropship: sp.get('dropship') ?? '', sort: sp.get('sort') ?? 'name', page: Number(sp.get('page') ?? '1') };
  const [q, setQ] = useState(f.q);
  const [data, setData] = useState<{ items: Row[]; total: number } | null>(null);
  const [summary, setSummary] = useState<{ summary: Summary; settings: Settings } | null>(null);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  const setFilter = useCallback(
    (patch: Partial<Record<keyof typeof f, string>>) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      if (!('page' in patch)) next.delete('page');
      router.replace(`${pathname}?${next}`);
    },
    [sp, router, pathname],
  );

  useEffect(() => {
    const t = setTimeout(() => q !== f.q && setFilter({ q: q.trim() }), 300);
    return () => clearTimeout(t);
  }, [q, f.q, setFilter]);

  useEffect(() => {
    const params = new URLSearchParams({ pageSize: String(PAGE), page: String(f.page), status: f.status, sort: f.sort });
    for (const k of ['q', 'uf', 'alert', 'dropship'] as const) if (f[k]) params.set(k, f[k]);
    api(`/admin/suppliers?${params}`).then(setData, (e) => setError(e.message));
  }, [f.q, f.status, f.uf, f.alert, f.dropship, f.sort, f.page]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (can('suppliers.view')) api('/admin/suppliers/summary').then(setSummary, () => setSummary(null));
  }, [can]);

  const chip = (label: string, n: number | undefined, patch: Partial<Record<string, string>>, tone: 'neutral' | 'warn' | 'bad' = 'neutral') => (
    <button type="button" onClick={() => setFilter(patch)} className="rounded-md border border-line bg-card px-3 py-2 text-left text-sm hover:bg-sunken">
      <span className={`num block text-lg font-semibold ${tone === 'bad' ? 'text-bad' : tone === 'warn' && n ? 'text-warn' : ''}`}>{n ?? '—'}</span>
      <span className="text-xs text-ink-soft">{label}</span>
    </button>
  );
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;

  return (
    <>
      <PageHeader
        title="Fornecedores"
        description="Cadastro, ofertas por embalagem, custo com histórico e a disponibilidade informada pelo fornecedor."
        actions={
          <>
            {can('settings.manage') && summary && (
              <Button variant="ghost" onClick={() => setShowSettings(!showSettings)}>
                Parâmetros
              </Button>
            )}
            {can('suppliers.manage') && (
              <Link href="/painel/fornecedores/novo">
                <Button variant="primary">Novo fornecedor</Button>
              </Link>
            )}
          </>
        }
      />
      {showSettings && summary && (
        <div className="mb-4">
          <SettingsPanel settings={summary.settings} onSaved={(s) => setSummary({ ...summary, settings: s })} />
        </div>
      )}
      {summary && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {chip('ativos', summary.summary.active, { status: 'active', alert: '' })}
          {chip('bloqueados', summary.summary.blocked, { status: 'blocked', alert: '' }, 'bad')}
          {chip('inativos', summary.summary.inactive, { status: 'inactive', alert: '' })}
          {chip(`cotações com mais de ${summary.settings.stale_quote_days} dias`, summary.summary.stale_quotes, { alert: 'stale_price', status: 'current' }, 'warn')}
          {chip('disponibilidades vencidas', summary.summary.expired_availability, { alert: 'expired_availability', status: 'current' }, 'warn')}
          <div className="rounded-md border border-line bg-card px-3 py-2 text-sm">
            <span className="num block text-lg font-semibold">{summary.summary.variants_without_primary}</span>
            <span className="text-xs text-ink-soft">variantes sem fornecedor principal</span>
          </div>
          <div className="rounded-md border border-line bg-card px-3 py-2 text-sm">
            <span className="num block text-lg font-semibold">{summary.summary.single_supplier_variants}</span>
            <span className="text-xs text-ink-soft">variantes com fornecedor único</span>
          </div>
        </div>
      )}
      <div className="mb-4 flex flex-wrap gap-2">
        <Input aria-label="Buscar" placeholder="Buscar nome, razão social ou CNPJ" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <Select aria-label="Situação" className="w-auto" value={f.status} onChange={(e) => setFilter({ status: e.target.value })}>
          <option value="current">Todos (sem arquivados)</option>
          <option value="active">Ativos</option>
          <option value="inactive">Inativos</option>
          <option value="blocked">Bloqueados</option>
          <option value="archived">Arquivados</option>
          <option value="all">Todos</option>
        </Select>
        <Select aria-label="UF" className="w-auto" value={f.uf} onChange={(e) => setFilter({ uf: e.target.value })}>
          <option value="">UF</option>
          {UFS.map((u) => (
            <option key={u}>{u}</option>
          ))}
        </Select>
        <Select aria-label="Alertas" className="w-auto" value={f.alert} onChange={(e) => setFilter({ alert: e.target.value })}>
          <option value="">Alertas: todos</option>
          <option value="stale_price">Cotação antiga</option>
          <option value="expired_availability">Disponibilidade vencida</option>
          <option value="missing_contact">Sem contato</option>
          <option value="missing_document">Sem CNPJ/CPF</option>
        </Select>
        <Select aria-label="Dropshipping" className="w-auto" value={f.dropship} onChange={(e) => setFilter({ dropship: e.target.value })}>
          <option value="">Dropshipping: todos</option>
          <option value="true">Com dropshipping cadastrado</option>
          <option value="false">Sem dropshipping</option>
        </Select>
        <Select aria-label="Ordenar" className="w-auto" value={f.sort} onChange={(e) => setFilter({ sort: e.target.value })}>
          <option value="name">Nome</option>
          <option value="last_receipt">Última entrega</option>
          <option value="offers">Mais itens</option>
        </Select>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {data && (
        <div className="overflow-x-auto rounded-lg border border-line bg-card">
          {data.items.length === 0 ? (
            <Empty title={f.q || f.alert || f.uf ? 'Nenhum fornecedor com estes filtros.' : 'Nenhum fornecedor cadastrado.'} />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-sunken/60 text-left text-xs text-ink-soft">
                <tr>
                  <th className="py-2 pl-4 font-medium">Fornecedor</th>
                  <th className="hidden py-2 pl-3 font-medium sm:table-cell">Cidade/UF</th>
                  <th className="hidden py-2 pl-3 text-right font-medium md:table-cell">Prazo</th>
                  <th className="hidden py-2 pl-3 text-right font-medium md:table-cell">Itens</th>
                  <th className="py-2 pl-3 font-medium">Alertas</th>
                  <th className="hidden py-2 pr-4 pl-3 text-right font-medium lg:table-cell">Última entrega</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.items.map((s) => {
                  const alerts = alertsOf(s);
                  return (
                    <tr key={s.id} className="hover:bg-sunken/40">
                      <td className="py-2.5 pl-4">
                        <Link href={`/painel/fornecedores/${s.id}`} className="block">
                          <span className="font-medium hover:underline">{s.name}</span> <SupplierBadge status={s.status} archivedAt={s.archived_at} blockedReason={s.blocked_reason} />
                          {s.dropship_enabled && (
                            <span className="ml-1">
                              <Badge>Dropshipping (cadastro)</Badge>
                            </span>
                          )}
                          <span className="block text-xs text-ink-faint">{s.document ? formatCnpj(s.document) : 'Sem documento'}</span>
                        </Link>
                      </td>
                      <td className="hidden py-2.5 pl-3 sm:table-cell">{s.city ? `${s.city}/${s.uf ?? ''}` : (s.uf ?? '—')}</td>
                      <td className="num hidden py-2.5 pl-3 text-right md:table-cell">{leadText(s)}</td>
                      <td className="num hidden py-2.5 pl-3 text-right md:table-cell">{s.offer_count}</td>
                      <td className="py-2.5 pl-3">{alerts.length ? <span title={alerts.join(' · ')}><Badge tone="warn">⚠ {alerts.length}</Badge></span> : <span className="text-ink-faint">—</span>}</td>
                      <td className="hidden py-2.5 pr-4 pl-3 text-right lg:table-cell">{when(s.last_receipt_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {data.total > 0 && (
            <div className="flex items-center justify-between border-t border-line px-4 py-2 text-sm text-ink-soft">
              <span>
                {(f.page - 1) * PAGE + 1}–{Math.min(f.page * PAGE, data.total)} de {data.total}
              </span>
              <span className="flex gap-2">
                <Button variant="ghost" disabled={f.page <= 1} onClick={() => setFilter({ page: String(f.page - 1) })}>
                  ‹ Anterior
                </Button>
                <Button variant="ghost" disabled={f.page >= pages} onClick={() => setFilter({ page: String(f.page + 1) })}>
                  Próxima ›
                </Button>
              </span>
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="suppliers.view|purchases.view">
      <Suspense fallback={<p className="text-sm text-ink-faint">Carregando…</p>}>
        <SupplierList />
      </Suspense>
    </Guard>
  );
}
