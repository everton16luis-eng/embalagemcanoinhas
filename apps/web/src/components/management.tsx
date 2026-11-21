'use client';

// SGLog Fase 10b: painel Gestao. Filtros (periodo, base, demonstracao, canal), resumo com cobertura, rentabilidade,
// custos logisticos, fornecedores e indicadores. So leitura; CSV direto da API.
import Link from '@/components/painel-link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CHANNEL, COMPONENT } from '@/components/costs';
import { useMe } from '@/components/shell';
import { Badge, Button, Empty, Field, Input, Notice, Panel, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { money, qty } from '@/lib/format';

export type Filters = { from: string; to: string; basis: 'paid' | 'order' | 'dispatch'; demo: 'include' | 'exclude' | 'only'; channel: string };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const minus = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const STORE_KEY = 'gestao-filtros';
const defaults = (): Filters => ({ from: minus(today(), 29), to: today(), basis: 'paid', demo: 'include', channel: '' });

/**
 * Filtros da Gestao, lembrados na aba do navegador (conveniencia; falha sem prejuizo). `ready` so fica true depois de
 * ler o filtro guardado: buscar antes disso dispararia uma consulta com o padrao que podia chegar depois da certa.
 */
export function useFilters() {
  const [f, setF] = useState<Filters>(defaults);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try {
      const s = sessionStorage.getItem(STORE_KEY);
      if (s) setF({ ...defaults(), ...JSON.parse(s) });
    } catch {
      /* sem armazenamento: usa o padrao */
    }
    setReady(true);
  }, []);
  const set = useCallback((n: Filters) => {
    setF(n);
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(n));
    } catch {
      /* ignora */
    }
  }, []);
  return [f, set, ready] as const;
}

/** Resposta de uma busca que ja foi substituida por outra (filtro mudou) e descartada. */
const fresh = () => {
  const s = { alive: true };
  return [<T,>(fn: (v: T) => void) => (v: T) => s.alive && fn(v), () => void (s.alive = false)] as const;
};
export const qs = (f: Filters, extra: Record<string, string | number | undefined> = {}) => {
  const p = new URLSearchParams({ from: f.from, to: f.to, basis: f.basis, demo: f.demo });
  if (f.channel) p.set('channel', f.channel);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') p.set(k, String(v));
  return p.toString();
};

const BASIS = { paid: 'Data do pagamento', order: 'Data do pedido', dispatch: 'Data do despacho' };
const PRESETS: [string, () => [string, string]][] = [
  ['7 dias', () => [minus(today(), 6), today()]],
  ['30 dias', () => [minus(today(), 29), today()]],
  ['Este mês', () => [today().slice(0, 8) + '01', today()]],
  [
    'Mês passado',
    () => {
      const first = today().slice(0, 8) + '01';
      const end = minus(first, 1);
      return [end.slice(0, 8) + '01', end];
    },
  ],
  ['12 meses', () => [minus(today(), 364), today()]],
];

export function FilterBar({ f, onChange, noBasis, noChannel }: { f: Filters; onChange: (f: Filters) => void; noBasis?: boolean; noChannel?: boolean }) {
  const [d, setD] = useState(f);
  useEffect(() => setD(f), [f]);
  const days = Math.round((Date.parse(d.to) - Date.parse(d.from)) / 86_400_000) + 1;
  const bad = !d.from || !d.to || days < 1 || days > 366;
  return (
    <form
      className="space-y-3 rounded-lg border border-line bg-card p-3 sm:p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!bad) onChange(d);
      }}
      data-testid="management-filters"
    >
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map(([label, fn]) => (
          <button
            key={label}
            type="button"
            className="rounded-full border border-line px-3 py-1 text-xs font-medium text-ink-soft hover:border-ink hover:text-ink"
            onClick={() => {
              const [from, to] = fn();
              const n = { ...d, from, to };
              setD(n);
              onChange(n);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 lg:items-end">
        <Field label="De">{(id) => <Input id={id} type="date" value={d.from} onChange={(e) => setD({ ...d, from: e.target.value })} />}</Field>
        <Field label="Até">{(id) => <Input id={id} type="date" value={d.to} onChange={(e) => setD({ ...d, to: e.target.value })} />}</Field>
        {!noBasis && (
          <Field label="Período pela">
            {(id) => (
              <Select id={id} value={d.basis} onChange={(e) => setD({ ...d, basis: e.target.value as Filters['basis'] })}>
                {Object.entries(BASIS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {!noChannel && (
          <Field label="Canal">
            {(id) => (
              <Select id={id} value={d.channel} onChange={(e) => setD({ ...d, channel: e.target.value })}>
                <option value="">Todos</option>
                {Object.entries(CHANNEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="Demonstração">
          {(id) => (
            <Select id={id} value={d.demo} onChange={(e) => setD({ ...d, demo: e.target.value as Filters['demo'] })}>
              <option value="include">Incluir</option>
              <option value="exclude">Excluir</option>
              <option value="only">Só demonstração</option>
            </Select>
          )}
        </Field>
        <div className="col-span-2 sm:col-span-1">
          <Button variant="primary" type="submit" disabled={bad} className="w-full">
            Aplicar
          </Button>
        </div>
      </div>
      {bad && <p className="text-[13px] text-bad">Período de 1 a 366 dias.</p>}
    </form>
  );
}

export function DemoNotice({ count, f }: { count: number; f: Filters }) {
  if (f.demo === 'only') return <Notice tone="warn">Mostrando só dados de demonstração.</Notice>;
  if (f.demo === 'include' && count > 0)
    return (
      <Notice tone="warn">
        {count} pedido(s) de demonstração no resultado. Use Demonstração: Excluir para ver só a operação real.
      </Notice>
    );
  return null;
}

export const pctFmt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);
const delta = (cur: number, prev: number) => (prev === 0 ? null : Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10);

function Kpi({ label, value, hint, change, tone }: { label: string; value: ReactNode; hint?: ReactNode; change?: number | null; tone?: 'good' | 'bad' | 'warn' }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-card px-3 py-3 sm:px-4">
      <p className="text-xs text-ink-soft">{label}</p>
      <p className={`num mt-0.5 truncate text-lg font-semibold sm:text-xl ${tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : ''}`}>{value}</p>
      {(hint || change !== undefined) && (
        <p className="mt-0.5 text-xs text-ink-faint">
          {change !== undefined && change !== null && (
            <span className={change >= 0 ? 'text-good' : 'text-bad'}>
              {change >= 0 ? '▲' : '▼'} {pctFmt(Math.abs(change))}{' '}
            </span>
          )}
          {change === null && <span>sem base anterior · </span>}
          {hint}
        </p>
      )}
    </div>
  );
}

export function Notes({ notes }: { notes: string[] }) {
  return (
    <details className="rounded-lg border border-line bg-card px-4 py-3 text-sm text-ink-soft">
      <summary className="cursor-pointer font-medium text-ink">Como ler estes números</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </details>
  );
}

export function CsvLink({ path }: { path: string }) {
  return (
    <a href={`/api/v1/admin/management/${path}`} className="inline-flex items-center rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:border-ink" data-testid="csv-link" download>
      Exportar CSV
    </a>
  );
}

/** Tabela com rolagem interna (a pagina nunca rola de lado). */
export function Table({ head, children, min = 640, testId }: { head: ReactNode[]; children: ReactNode; min?: number; testId?: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-card">
      <table className="w-full text-left text-sm" style={{ minWidth: min }} data-testid={testId}>
        <thead className="text-xs text-ink-soft">
          <tr className="border-b border-line">
            {head.map((h, i) => (
              <th key={i} className={`px-3 py-2 font-medium ${i > 0 ? 'text-right' : ''}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}
export const Td = ({ children, left, className = '' }: { children: ReactNode; left?: boolean; className?: string }) => <td className={`px-3 py-2 ${left ? '' : 'num whitespace-nowrap text-right'} ${className}`}>{children}</td>;

export function Pager({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  if (total <= pageSize) return null;
  const last = Math.ceil(total / pageSize);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Button variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Anterior
      </Button>
      <span className="text-ink-soft">
        Página {page} de {last} · {total} linha(s)
      </span>
      <Button variant="ghost" disabled={page >= last} onClick={() => onPage(page + 1)}>
        Próxima
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Painel.
type Totals = {
  orders: number;
  completeOrders: number;
  partialOrders: number;
  demoOrders: number;
  coveragePct: number | null;
  revenueCents?: number;
  cogsCents?: number;
  logisticsCents?: number;
  feesCents?: number;
  taxesCents?: number;
  taxesEstimatedCents?: number;
  returnsCents?: number;
  otherCents?: number;
  marginCents?: number;
  marginPct?: number | null;
  completeMarginPct?: number | null;
  revenueCoveragePct?: number | null;
  estimatedCents?: number;
};
type Summary = {
  period: { from: string; to: string; days: number; basisLabel: string };
  financial: boolean;
  totals: Totals;
  previous: { period: { from: string; to: string }; totals: Totals };
  byChannel: (Totals & { channel: string; label: string })[];
  byMonth: (Totals & { month: string })[];
  missing: { component: string; label: string; orders: number }[];
  incomplete: { id: string; number: number; channel: string; demo: boolean; revenueCents?: number; missing: string[] }[];
  notes: string[];
};
type Indicators = {
  period: { orders: number; dispatched: number; delivered: number };
  dispatch: { avgHours: number | null; medianHours: number | null; label: string };
  delivery: { avgDays: number | null; medianDays: number | null; label: string };
  rates: { occurrencePct: number | null; returnPct: number | null; refundPct: number | null };
  now: { staleTracking: number; waitingDispatch: number; openOccurrences: number };
  stock?: { valueCents: number; variantsWithStock: number; variantsWithoutCost: number; status: string; cogsPeriodCents: number; turnover: number | null; coverageDays: number | null; label: string };
  notes: string[];
};
const hours = (h: number | null) => (h === null ? '—' : h >= 48 ? `${(h / 24).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} dias` : `${h.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h`);
const days = (d: number | null) => (d === null ? '—' : `${d.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} dia(s)`);

export function Dashboard() {
  const { can } = useMe();
  const [f, setF, ready] = useFilters();
  const [s, setS] = useState<Summary | null>(null);
  const [ind, setInd] = useState<Indicators | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!ready) return;
    const [ok, stop] = fresh();
    setError('');
    setS(null);
    api<Summary>(`/admin/management/summary?${qs(f)}`).then(ok(setS), ok((e: Error) => setError(e.message)));
    api<Indicators>(`/admin/management/indicators?${qs(f)}`).then(ok(setInd), ok(() => setInd(null)));
    return stop;
  }, [f, ready]);
  const t = s?.totals;
  const p = s?.previous.totals;
  // Card com componente desconhecido: valor parcial (o que falta nao entra como zero).
  const lack = (comps: string[]) => Math.max(0, ...(s?.missing ?? []).filter((m) => comps.includes(m.component)).map((m) => m.orders));
  const partialHint = (comps: string[], base: string) => {
    const n = lack(comps);
    return n ? `parcial: sem valor em ${n} pedido(s)` : base;
  };
  const partialTone = (comps: string[]) => (lack(comps) ? ('warn' as const) : undefined);
  const LOG = ['freight_paid', 'packaging'];
  const FEES = ['payment_fee', 'marketplace_fees', 'marketplace_shipping'];
  const TAX = ['tax_estimated', 'tax_recorded'];
  return (
    <div className="space-y-4" data-testid="management-dashboard">
      <FilterBar f={f} onChange={setF} />
      {error && <Notice tone="bad">{error}</Notice>}
      {s && t && (
        <>
          <DemoNotice count={t.demoOrders} f={f} />
          <p className="text-sm text-ink-soft">
            {t.orders} pedido(s) pagos de {s.period.from.split('-').reverse().join('/')} a {s.period.to.split('-').reverse().join('/')}, pela {s.period.basisLabel}. Comparação com{' '}
            {s.previous.period.from.split('-').reverse().join('/')} a {s.previous.period.to.split('-').reverse().join('/')}.
          </p>
          {t.orders === 0 ? (
            <Empty title="Nenhum pedido pago no período">Escolha outro período, outra base de data ou inclua os dados de demonstração.</Empty>
          ) : (
            <>
              {t.partialOrders > 0 && (
                <Notice tone="warn">
                  Dados insuficientes em {t.partialOrders} de {t.orders} pedido(s): falta ao menos um custo. A margem abaixo deixa esses custos de fora (não entram como zero) e por isso fica
                  maior que a real. Cobertura: {pctFmt(t.coveragePct)} dos pedidos{s.financial ? `, ${pctFmt(t.revenueCoveragePct)} da receita` : ''}.
                </Notice>
              )}
              {s.financial ? (
                <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4" data-testid="kpis">
                  <Kpi label="Receita" value={money(t.revenueCents)} change={delta(t.revenueCents!, p!.revenueCents!)} hint="mercadoria, desconto e frete cobrado" />
                  <Kpi label="CMV" value={money(t.cogsCents)} hint="custo da mercadoria vendida" />
                  <Kpi label="Custos logísticos" value={money(t.logisticsCents)} hint={partialHint(LOG, 'frete pago e embalagem')} tone={partialTone(LOG)} />
                  <Kpi label="Taxas e comissões" value={money(t.feesCents)} hint={partialHint(FEES, 'pagamento e marketplace')} tone={partialTone(FEES)} />
                  <Kpi label="Tributos" value={money(t.taxesCents)} hint={partialHint(TAX, t.taxesEstimatedCents ? `${money(t.taxesEstimatedCents)} estimados (não é valor fiscal)` : 'registrados')} tone={partialTone(TAX)} />
                  <Kpi label="Devoluções e reembolsos" value={money(t.returnsCents)} />
                  <Kpi
                    label="Margem de contribuição"
                    value={money(t.marginCents)}
                    change={delta(t.marginCents!, p!.marginCents!)}
                    hint={`${pctFmt(t.marginPct)} da receita${t.partialOrders ? ' (parcial)' : ''}`}
                    tone={t.marginCents! < 0 ? 'bad' : undefined}
                  />
                  <Kpi
                    label="Cobertura dos custos"
                    value={`${t.completeOrders}/${t.orders}`}
                    hint={t.completeOrders ? `margem dos completos: ${pctFmt(t.completeMarginPct)}` : 'nenhum pedido com todos os custos'}
                    tone={t.partialOrders ? 'warn' : undefined}
                  />
                </div>
              ) : (
                <>
                  <Notice tone="neutral">Valores de receita, custo e margem exigem a permissão de consultar margens.</Notice>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Kpi label="Pedidos" value={t.orders} />
                    <Kpi label="Com todos os custos" value={t.completeOrders} hint={pctFmt(t.coveragePct)} />
                  </div>
                </>
              )}
              <div className="grid gap-4 lg:grid-cols-2">
                <Panel title="Por canal">
                  <ChannelBars rows={s.byChannel} financial={s.financial} />
                </Panel>
                <Panel title="Custos que faltam" description="Componentes desconhecidos, por número de pedidos. Informe a regra ou lance o custo para completar.">
                  {s.missing.length === 0 ? (
                    <p className="text-sm text-good">Nenhum custo faltando no período.</p>
                  ) : (
                    <ul className="space-y-1.5 text-sm" data-testid="missing-components">
                      {s.missing.map((m) => (
                        <li key={m.component} className="flex items-center justify-between gap-2">
                          <span>{COMPONENT[m.component] ?? m.label}</span>
                          <Badge tone="warn">{m.orders} pedido(s)</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                  {can('costs.view') || can('costs.settings') ? (
                    <p className="mt-3 text-sm">
                      <Link className="underline underline-offset-2" href="/painel/gestao/custos">
                        Configurar custos
                      </Link>
                    </p>
                  ) : null}
                </Panel>
              </div>
              {s.byMonth.length > 1 && s.financial && (
                <Panel title="Por mês">
                  <Table head={['Mês', 'Pedidos', 'Receita', 'Margem', '%', 'Cobertura']} min={520}>
                    {s.byMonth.map((m) => (
                      <tr key={m.month}>
                        <Td left>{m.month.split('-').reverse().join('/')}</Td>
                        <Td>{m.orders}</Td>
                        <Td>{money(m.revenueCents)}</Td>
                        <Td>{money(m.marginCents)}</Td>
                        <Td>{pctFmt(m.marginPct)}</Td>
                        <Td>{pctFmt(m.coveragePct)}</Td>
                      </tr>
                    ))}
                  </Table>
                </Panel>
              )}
              {s.incomplete.length > 0 && (
                <Panel title="Pedidos com custo incompleto" description="Os de maior receita primeiro.">
                  <ul className="divide-y divide-line text-sm" data-testid="incomplete-orders">
                    {s.incomplete.map((o) => (
                      <li key={o.id} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-center sm:gap-3">
                        <Link href={`/painel/pedidos/${o.id}`} className="font-medium underline underline-offset-2">
                          Pedido {o.number}
                        </Link>
                        <span className="text-ink-soft">
                          {CHANNEL[o.channel] ?? o.channel}
                          {o.demo ? ' · demonstração' : ''}
                          {o.revenueCents !== undefined ? ` · ${money(o.revenueCents)}` : ''}
                        </span>
                        <span className="min-w-0 flex-1 text-ink-faint sm:text-right">falta: {o.missing.join(', ')}</span>
                      </li>
                    ))}
                  </ul>
                </Panel>
              )}
            </>
          )}
          {ind && <IndicatorPanels ind={ind} />}
          <Notes notes={[...s.notes, ...(ind?.notes ?? [])]} />
        </>
      )}
    </div>
  );
}

function ChannelBars({ rows, financial }: { rows: Summary['byChannel']; financial: boolean }) {
  if (!rows.length) return <p className="text-sm text-ink-soft">Sem pedidos.</p>;
  const max = Math.max(...rows.map((r) => (financial ? (r.revenueCents ?? 0) : r.orders)), 1);
  return (
    <ul className="space-y-3 text-sm" data-testid="channel-bars">
      {rows.map((r) => {
        const v = financial ? (r.revenueCents ?? 0) : r.orders;
        return (
          <li key={r.channel}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="font-medium">{r.label}</span>
              <span className="num text-ink-soft">
                {r.orders} pedido(s){financial ? ` · ${money(r.revenueCents)} · margem ${money(r.marginCents)} (${pctFmt(r.marginPct)})` : ''}
              </span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-sunken">
              <div className="h-2 rounded-full bg-ink" style={{ width: `${Math.max(2, (v / max) * 100)}%` }} />
            </div>
            <p className="mt-0.5 text-xs text-ink-faint">cobertura {pctFmt(r.coveragePct)}</p>
          </li>
        );
      })}
    </ul>
  );
}

function IndicatorPanels({ ind }: { ind: Indicators }) {
  return (
    <div className="space-y-3" data-testid="indicators">
      <h2 className="text-[15px] font-semibold">Operação</h2>
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <Kpi label="Pagamento → despacho" value={hours(ind.dispatch.medianHours)} hint={`mediana; média ${hours(ind.dispatch.avgHours)}`} />
        <Kpi label="Despacho → entrega" value={days(ind.delivery.medianDays)} hint={`mediana; média ${days(ind.delivery.avgDays)}`} />
        <Kpi label="Ocorrências" value={pctFmt(ind.rates.occurrencePct)} hint="dos pedidos do período" />
        <Kpi label="Devoluções" value={pctFmt(ind.rates.returnPct)} hint={`reembolso em ${pctFmt(ind.rates.refundPct)}`} />
        <Kpi label="Rastreio parado" value={ind.now.staleTracking} hint="agora, há mais de 3 dias" tone={ind.now.staleTracking ? 'warn' : undefined} />
        <Kpi label="Pagos sem despacho" value={ind.now.waitingDispatch} hint="agora, há mais de 2 dias" tone={ind.now.waitingDispatch ? 'warn' : undefined} />
        <Kpi label="Ocorrências abertas" value={ind.now.openOccurrences} hint="agora" />
        {ind.stock && (
          <Kpi
            label="Estoque ao custo médio"
            value={money(ind.stock.valueCents)}
            hint={
              ind.stock.variantsWithoutCost
                ? `parcial: ${ind.stock.variantsWithoutCost} item(ns) sem custo`
                : `giro ${ind.stock.turnover === null ? '—' : ind.stock.turnover.toLocaleString('pt-BR')} · cobertura ${ind.stock.coverageDays ?? '—'} dias`
            }
            tone={ind.stock.variantsWithoutCost ? 'warn' : undefined}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Rentabilidade.
type OrderRow = {
  id: string;
  number: number;
  channel: string;
  uf: string | null;
  demo: boolean;
  date: string | null;
  revenueCents: number;
  cogsCents: number;
  logisticsCents: number;
  feesCents: number;
  taxesCents: number;
  returnsCents: number;
  marginCents: number;
  marginPct: number | null;
  status: 'partial' | 'complete';
  missing: string[];
};
type GroupRow = { key: string; label: string; attribution: string | null; orders: number; partialOrders: number; qty: string | null; revenueCents: number; cogsCents: number; logisticsCents: number; feesCents: number; taxesCents: number; returnsCents: number; marginCents: number; marginPct: number | null };
const DIM_TABS = [
  ['orders', 'Pedidos'],
  ['product', 'Produto'],
  ['category', 'Categoria'],
  ['channel', 'Canal'],
  ['supplier', 'Fornecedor'],
  ['uf', 'UF'],
] as const;

export function Profitability() {
  const { can } = useMe();
  const [f, setF, ready] = useFilters();
  const [tab, setTab] = useState<string>('orders');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('margin');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [data, setData] = useState<{ items: (OrderRow | GroupRow)[]; total: number; pageSize: number; notes: string[] } | null>(null);
  const [error, setError] = useState('');
  const path = tab === 'orders' ? 'orders' : 'breakdown';
  const extra = tab === 'orders' ? { status, sort, dir } : { dim: tab, sort: sort === 'date' || sort === 'number' ? 'revenue' : sort, dir };
  const query = qs(f, extra);
  useEffect(() => {
    if (!ready || !can('margins.view')) return;
    const [ok, stop] = fresh();
    setError('');
    api<NonNullable<typeof data>>(`/admin/management/${path}?${query}&page=${page}&pageSize=30`).then(ok(setData), ok((e: Error) => setError(e.message)));
    return stop;
  }, [path, query, page, can, ready]);
  if (!can('margins.view')) return <Notice tone="neutral">Rentabilidade exige a permissão de consultar margens.</Notice>;
  const demoCount = data && tab === 'orders' ? (data.items as OrderRow[]).filter((i) => i.demo).length : 0;
  return (
    <div className="space-y-4">
      <FilterBar f={f} onChange={(n) => (setF(n), setPage(1))} />
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-line">
        {DIM_TABS.map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => (setTab(k), setPage(1), setData(null))}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? 'border-ink text-ink' : 'border-transparent text-ink-soft hover:text-ink'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        {tab === 'orders' && (
          <Field label="Situação" className="w-40">
            {(id) => (
              <Select id={id} value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
                <option value="">Todos</option>
                <option value="partial">Parciais</option>
                <option value="complete">Completos</option>
              </Select>
            )}
          </Field>
        )}
        <Field label="Ordenar por" className="w-44">
          {(id) => (
            <Select id={id} value={sort} onChange={(e) => (setSort(e.target.value), setPage(1))}>
              <option value="margin">Margem</option>
              <option value="margin_pct">Margem %</option>
              <option value="revenue">Receita</option>
              {tab === 'orders' ? <option value="date">Data</option> : <option value="orders">Pedidos</option>}
            </Select>
          )}
        </Field>
        <Field label="Ordem" className="w-36">
          {(id) => (
            <Select id={id} value={dir} onChange={(e) => (setDir(e.target.value as 'asc' | 'desc'), setPage(1))}>
              <option value="desc">Maior primeiro</option>
              <option value="asc">Menor primeiro</option>
            </Select>
          )}
        </Field>
        <CsvLink path={`${path}?${query}&format=csv`} />
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {demoCount > 0 && f.demo === 'include' && <Notice tone="warn">Esta página tem {demoCount} pedido(s) de demonstração (marcados).</Notice>}
      {data && data.items.length === 0 && <Empty title="Nada no período">Sem pedidos pagos com estes filtros.</Empty>}
      {data && data.items.length > 0 && tab === 'orders' && (
        <Table head={['Pedido', 'Data', 'Receita', 'CMV', 'Logística', 'Taxas', 'Tributos', 'Devoluções', 'Margem', '%']} min={880} testId="profit-orders">
          {(data.items as OrderRow[]).map((o) => (
            <tr key={o.id}>
              <Td left>
                <Link href={`/painel/pedidos/${o.id}`} className="font-medium underline underline-offset-2">
                  {o.number}
                </Link>{' '}
                <span className="text-xs text-ink-soft">
                  {CHANNEL[o.channel] ?? o.channel}
                  {o.uf ? ` · ${o.uf}` : ''}
                </span>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {o.status === 'partial' ? <Badge tone="warn">Parcial</Badge> : <Badge tone="good">Completo</Badge>}
                  {o.demo && <Badge tone="neutral">Demonstração</Badge>}
                </div>
                {o.status === 'partial' && <p className="mt-0.5 max-w-[240px] text-xs text-ink-faint">falta: {o.missing.join(', ')}</p>}
              </Td>
              <Td>{o.date ? o.date.split('-').reverse().join('/') : '—'}</Td>
              <Td>{money(o.revenueCents)}</Td>
              <Td>{money(o.cogsCents)}</Td>
              <Td>{money(o.logisticsCents)}</Td>
              <Td>{money(o.feesCents)}</Td>
              <Td>{money(o.taxesCents)}</Td>
              <Td>{money(o.returnsCents)}</Td>
              <Td className="font-medium">{money(o.marginCents)}</Td>
              <Td>{pctFmt(o.marginPct)}</Td>
            </tr>
          ))}
        </Table>
      )}
      {data && data.items.length > 0 && tab !== 'orders' && (
        <Table head={[DIM_TABS.find(([k]) => k === tab)![1], 'Pedidos', ...(tab === 'product' ? ['Quantidade'] : []), 'Receita', 'CMV', 'Logística', 'Taxas', 'Tributos', 'Devoluções', 'Margem', '%']} min={880} testId="profit-groups">
          {(data.items as GroupRow[]).map((g) => (
            <tr key={g.key}>
              <Td left>
                <span className="font-medium">{g.label}</span>
                {g.attribution === 'primary' && <span className="ml-1 text-xs text-ink-faint">(fornecedor principal)</span>}
                {g.partialOrders > 0 && (
                  <div className="mt-0.5">
                    <Badge tone="warn">{g.partialOrders} parcial(is)</Badge>
                  </div>
                )}
              </Td>
              <Td>{g.orders}</Td>
              {tab === 'product' && <Td>{g.qty === null ? '—' : qty(g.qty)}</Td>}
              <Td>{money(g.revenueCents)}</Td>
              <Td>{money(g.cogsCents)}</Td>
              <Td>{money(g.logisticsCents)}</Td>
              <Td>{money(g.feesCents)}</Td>
              <Td>{money(g.taxesCents)}</Td>
              <Td>{money(g.returnsCents)}</Td>
              <Td className="font-medium">{money(g.marginCents)}</Td>
              <Td>{pctFmt(g.marginPct)}</Td>
            </tr>
          ))}
        </Table>
      )}
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
      {data && <Notes notes={data.notes} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Custos logisticos.
type Logistics = {
  components: { component: string; label: string; nature: string; cents: number | null; lines: number; orders: number }[];
  byUf: { uf: string; orders: number; freightChargedCents: number; freightPaidCents: number; ordersFreightUnknown: number; ordersFreightKnown: number; balanceKnownCents: number }[];
  byCarrier: { carrier: string; shipments: number; withCost: number; freightPaidCents: number }[];
  stockLosses: { items: { kind: string; label: string; movements: number; qty: string; cents: number; unknownMovements: number }[]; totalCents: number };
  filters: { demo: string };
  notes: string[];
};
const NAT: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  effective: { label: 'efetivo', tone: 'good' },
  estimated: { label: 'estimado', tone: 'warn' },
  unknown: { label: 'desconhecido', tone: 'bad' },
  info: { label: 'informativo', tone: 'neutral' },
};
export function LogisticsCosts() {
  const { can } = useMe();
  const [f, setF, ready] = useFilters();
  const [d, setD] = useState<Logistics | null>(null);
  const [error, setError] = useState('');
  const allowed = can('costs.view') || can('margins.view');
  useEffect(() => {
    if (!ready || !allowed) return;
    const [ok, stop] = fresh();
    setError('');
    api<Logistics>(`/admin/management/logistics?${qs(f)}`).then(ok(setD), ok((e: Error) => setError(e.message)));
    return stop;
  }, [f, allowed, ready]);
  if (!allowed) return <Notice tone="neutral">Custos logísticos exigem a permissão de consultar custos.</Notice>;
  return (
    <div className="space-y-4">
      <FilterBar f={f} onChange={setF} />
      <div>
        <CsvLink path={`logistics?${qs(f)}&format=csv`} />
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {d && (
        <>
          <Panel title="Componentes" description="Pedidos do período. Desconhecido fica sem valor e fora da soma.">
            {d.components.length === 0 ? (
              <p className="text-sm text-ink-soft">Nenhum frete ou embalagem nos pedidos do período.</p>
            ) : (
              <ul className="divide-y divide-line text-sm" data-testid="logistics-components">
                {d.components.map((c) => (
                  <li key={c.component + c.nature} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="flex items-center gap-2">
                      {COMPONENT[c.component] ?? c.label} <Badge tone={NAT[c.nature]?.tone ?? 'neutral'}>{NAT[c.nature]?.label ?? c.nature}</Badge>
                    </span>
                    <span className="num text-ink-soft">
                      {c.cents === null ? '—' : money(c.cents)} · {c.orders} pedido(s)
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Frete cobrado × pago por UF" description="A diferença só usa os pedidos com o frete pago informado.">
            <Table head={['UF', 'Pedidos', 'Cobrado', 'Pago', 'Sem custo', 'Diferença (conhecidos)']} min={560} testId="freight-by-uf">
              {d.byUf.map((u) => (
                <tr key={u.uf}>
                  <Td left>{u.uf}</Td>
                  <Td>{u.orders}</Td>
                  <Td>{money(u.freightChargedCents)}</Td>
                  <Td>{money(u.freightPaidCents)}</Td>
                  <Td>{u.ordersFreightUnknown ? <Badge tone="warn">{u.ordersFreightUnknown}</Badge> : 0}</Td>
                  <Td className={u.balanceKnownCents < 0 ? 'text-bad' : ''}>{u.ordersFreightKnown ? money(u.balanceKnownCents) : '—'}</Td>
                </tr>
              ))}
            </Table>
          </Panel>
          <Panel title="Por transportadora">
            {d.byCarrier.length === 0 ? (
              <p className="text-sm text-ink-soft">Sem remessas por transportadora no período.</p>
            ) : (
              <Table head={['Transportadora', 'Remessas', 'Com custo', 'Frete pago']} min={420}>
                {d.byCarrier.map((c) => (
                  <tr key={c.carrier}>
                    <Td left>{c.carrier}</Td>
                    <Td>{c.shipments}</Td>
                    <Td>{c.withCost}</Td>
                    <Td>{money(c.freightPaidCents)}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Panel>
          <Panel title="Perdas de estoque" description="Pela data do movimento (não filtra canal nem demonstração). Avaria de devolução fica na margem do pedido.">
            {d.stockLosses.items.length === 0 ? (
              <p className="text-sm text-ink-soft">Nenhuma perda no período.</p>
            ) : (
              <ul className="divide-y divide-line text-sm" data-testid="stock-losses">
                {d.stockLosses.items.map((l) => (
                  <li key={l.kind} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      {l.label} · {l.movements} movimento(s) · {qty(l.qty)} un
                    </span>
                    <span className="num">
                      {money(l.cents)} {l.unknownMovements > 0 && <Badge tone="warn">{l.unknownMovements} sem custo</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Notes notes={d.notes} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Fornecedores.
type SupplierRow = {
  id: string;
  name: string;
  demo: boolean;
  receipts: number;
  onTime: number;
  late: number;
  withoutPromise: number;
  onTimePct: number | null;
  issues: number;
  receivedCents: number | null;
  invoiceDiffCents: number | null;
  costChangePct: number | null;
  rejectedPacks: string;
  supplierReturns: number;
};
export function SupplierPerformance() {
  const [f, setF, ready] = useFilters();
  const [page, setPage] = useState(1);
  const [d, setD] = useState<{ items: SupplierRow[]; total: number; pageSize: number; notes: string[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!ready) return;
    const [ok, stop] = fresh();
    setError('');
    api<NonNullable<typeof d>>(`/admin/management/suppliers?${qs(f)}&page=${page}&pageSize=30`).then(ok(setD), ok((e: Error) => setError(e.message)));
    return stop;
  }, [f, page, ready]);
  const demo = d?.items.filter((i) => i.demo).length ?? 0;
  return (
    <div className="space-y-4">
      <FilterBar f={f} onChange={(n) => (setF(n), setPage(1))} noBasis noChannel />
      <div>
        <CsvLink path={`suppliers?${qs(f)}&format=csv`} />
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {demo > 0 && f.demo === 'include' && <Notice tone="warn">{demo} fornecedor(es) de demonstração na lista (marcados).</Notice>}
      {d && d.items.length === 0 && <Empty title="Nenhum recebimento no período" />}
      {d && d.items.length > 0 && (
        <Table head={['Fornecedor', 'Recebimentos', 'No prazo', 'Ocorrências', 'Recebido', 'Diferença de nota', 'Variação de custo', 'Devoluções']} min={820} testId="supplier-performance">
          {d.items.map((s) => (
            <tr key={s.id}>
              <Td left>
                <Link href={`/painel/fornecedores/${s.id}`} className="font-medium underline underline-offset-2">
                  {s.name}
                </Link>
                {s.demo && (
                  <span className="ml-1">
                    <Badge tone="neutral">Demonstração</Badge>
                  </span>
                )}
              </Td>
              <Td>{s.receipts}</Td>
              <Td>
                {pctFmt(s.onTimePct)}
                {s.late > 0 && <span className="text-xs text-bad"> · {s.late} atrasado(s)</span>}
                {s.withoutPromise > 0 && <span className="text-xs text-ink-faint"> · {s.withoutPromise} sem prazo</span>}
              </Td>
              <Td>{s.issues}</Td>
              <Td>{money(s.receivedCents)}</Td>
              <Td className={(s.invoiceDiffCents ?? 0) > 0 ? 'text-bad' : ''}>{money(s.invoiceDiffCents)}</Td>
              <Td className={(s.costChangePct ?? 0) > 0 ? 'text-bad' : ''}>{s.costChangePct === null ? '—' : `${s.costChangePct > 0 ? '+' : ''}${pctFmt(s.costChangePct)}`}</Td>
              <Td>{s.supplierReturns}</Td>
            </tr>
          ))}
        </Table>
      )}
      {d && <Pager page={page} total={d.total} pageSize={d.pageSize} onPage={setPage} />}
      {d && <Notes notes={d.notes} />}
    </div>
  );
}

