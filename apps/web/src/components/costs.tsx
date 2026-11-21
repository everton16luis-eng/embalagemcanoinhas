'use client';

// SGLog Fase 10a: margem de contribuicao do pedido (com a origem de cada componente), configuracoes de custo
// (informado -> validado), lancamentos de custos externos, importacao por planilha e conferencia C22-C24.
import { useCallback, useEffect, useState } from 'react';
import { useMe } from '@/components/shell';
import { newKey } from '@/components/stock';
import { Badge, Button, Empty, Field, Input, Notice, Panel, Select, type Tone } from '@/components/ui';
import { api } from '@/lib/api';
import { money, parseMoney, when } from '@/lib/format';

export const NATURE: Record<string, { label: string; tone: Tone }> = {
  effective: { label: 'Efetivo', tone: 'good' },
  estimated: { label: 'Estimado', tone: 'warn' },
  unknown: { label: 'Desconhecido', tone: 'bad' },
  info: { label: 'Informativo', tone: 'neutral' },
};
export function NatureBadge({ nature }: { nature: string }) {
  const n = NATURE[nature] ?? { label: nature, tone: 'neutral' as Tone };
  return <Badge tone={n.tone}>{n.label}</Badge>;
}
export const COMPONENT: Record<string, string> = {
  merchandise: 'Mercadoria',
  discount: 'Desconto',
  freight_charged: 'Frete cobrado',
  cogs: 'CMV (baixa do estoque)',
  cogs_pending: 'CMV (sem baixa)',
  exchange_cogs: 'CMV da reposição da troca',
  freight_paid: 'Frete pago',
  packaging: 'Embalagem',
  payment_fee: 'Taxa do pagamento',
  marketplace_fees: 'Comissão e tarifa do marketplace',
  marketplace_shipping: 'Frete do marketplace',
  tax_recorded: 'Tributos registrados',
  tax_estimated: 'Tributos estimados',
  other: 'Outros custos',
  return_credit: 'Devolução ao estoque (CMV)',
  return_loss: 'Perda na devolução',
  return_discarded: 'Devolução descartada',
  return_freight: 'Frete de volta',
  refund: 'Reembolso',
};
export const ENTRY_KIND: Record<string, string> = {
  payment_fee: 'Taxa do pagamento',
  marketplace_commission: 'Comissão do marketplace',
  marketplace_fee: 'Tarifa do marketplace',
  marketplace_shipping: 'Frete do marketplace',
  tax: 'Tributo registrado',
  other: 'Outro custo',
};
export const SETTING_KIND: Record<string, string> = {
  tax_rate: 'Tributo estimado (alíquota)',
  payment_fee: 'Taxa do meio de pagamento',
  marketplace_fee: 'Comissão e tarifa do marketplace',
  packaging: 'Embalagem de envio',
};
export const CHANNEL: Record<string, string> = { store: 'Loja virtual', sales_desk: 'Balcão', mercadolivre: 'Mercado Livre', shopee: 'Shopee' };
const SOURCE_TABLE: Record<string, string> = {
  orders: 'pedido',
  stock_movements: 'movimento de estoque',
  stock_balances: 'custo médio atual',
  shipment_freight_costs: 'custo de frete da remessa',
  shipments: 'remessa',
  cost_settings: 'configuração de custo',
  order_cost_entries: 'lançamento',
  payments: 'pagamento',
  return_inspections: 'conferência da devolução',
  quarantine_decisions: 'decisão da quarentena',
  customer_returns: 'devolução',
  refund_records: 'reembolso',
};
const short = (id: string) => (id.length > 12 ? id.slice(0, 8) : id);

type Line = { component: string; label: string; group: string; nature: string; amountCents: number | null; source: { table: string; ids: string[]; ref: string | null }; sku: string | null; detail: string };
type Margin = {
  revenueCents: number;
  cogsCents: number;
  logisticsCents: number;
  feesCents: number;
  taxesCents: number;
  taxesEstimatedCents: number;
  returnsCents: number;
  otherCents: number;
  marginCents: number;
  marginPct: number | null;
  estimatedCents: number;
  status: 'complete' | 'partial';
  missing: string[];
  lines: Line[];
};
type Entry = { id: string; order_number: number; kind: string; amount_cents: string; occurred_on: string; source: string; import_number: number | null; external_ref: string | null; note: string | null; reverses_id: string | null; reason: string | null; created_at: string; actor_name: string | null; reversed: boolean };
type OrderMargin = { order: { id: string; number: number; channel: string }; excluded: string | null; margin: Margin | null; entries: Entry[]; canRecord: boolean };

const EXCLUDED: Record<string, string> = {
  replacement: 'Pedido de reposição da troca: não é venda. O custo dele entra na margem do pedido de origem.',
  canceled: 'Pedido cancelado: fica fora da margem.',
  not_paid: 'Pedido ainda não pago: a margem aparece depois do pagamento.',
};

export function MarginSummary({ m }: { m: Margin }) {
  // Grupo com componente desconhecido: o valor mostrado e parcial (o que falta nao entra como zero).
  const lacks = (comps: string[]) => (m.missing.some((c) => comps.includes(c)) ? 'parcial' : undefined);
  const cells: [string, number, string?][] = [
    ['Receita', m.revenueCents],
    ['CMV', m.cogsCents, lacks(['cogs', 'cogs_pending', 'exchange_cogs'])],
    ['Custos logísticos', m.logisticsCents, lacks(['freight_paid', 'packaging'])],
    ['Taxas e comissões', m.feesCents, lacks(['payment_fee', 'marketplace_fees', 'marketplace_shipping'])],
    ['Tributos', m.taxesCents, lacks(['tax_estimated', 'tax_recorded']) ?? (m.taxesEstimatedCents ? 'estimados' : undefined)],
    ['Devoluções', m.returnsCents, lacks(['return_freight'])],
  ];
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-4">
      {cells.map(([label, v, hint]) => (
        <div key={label} className="bg-card px-3 py-2">
          <dt className={`text-xs ${hint === 'parcial' ? 'text-warn' : 'text-ink-soft'}`}>
            {label}
            {hint === 'parcial' ? ' (parcial: falta custo)' : hint ? ` (${hint})` : ''}
          </dt>
          <dd className="num text-sm font-medium">{money(v)}</dd>
        </div>
      ))}
      <div className="col-span-2 bg-card px-3 py-2">
        <dt className="text-xs text-ink-soft">Margem de contribuição</dt>
        <dd className="num text-lg font-semibold">
          {money(m.marginCents)} {m.marginPct !== null && <span className="text-sm font-normal text-ink-soft">({String(m.marginPct).replace('.', ',')}%)</span>}
        </dd>
      </div>
    </dl>
  );
}

/** Margem de contribuicao do pedido com o detalhe de cada componente e os lancamentos (margins.view). */
export function OrderMarginPanel({ orderId }: { orderId: string }) {
  const { can, me } = useMe();
  const [d, setD] = useState<OrderMargin | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ kind: 'payment_fee', amount: '', occurredOn: new Date().toLocaleDateString('en-CA'), externalRef: '', note: '' });
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState('');
  const load = useCallback(() => {
    api<OrderMargin>(`/admin/costs/orders/${orderId}/margin`).then(setD, (e) => setError(e.message));
  }, [orderId]);
  useEffect(load, [load]);
  if (!d) return error ? <Notice tone="bad">{error}</Notice> : null;
  const mkt = ['mercadolivre', 'shopee'].includes(d.order.channel);
  const kinds = Object.keys(ENTRY_KIND).filter((k) => (mkt ? k !== 'payment_fee' : !k.startsWith('marketplace_')));
  const cents = parseMoney(form.amount);
  const record = can('costs.record');
  const submit = async () => {
    setBusy('create');
    setError('');
    try {
      await api('/admin/costs/entries', {
        method: 'POST',
        body: { orderId, kind: form.kind, amountCents: cents, occurredOn: form.occurredOn, externalRef: form.externalRef.trim() || null, note: form.note.trim() || null, requestKey: key },
      });
      setKey(newKey());
      setOpen(false);
      setForm({ ...form, amount: '', externalRef: '', note: '' });
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const reverse = async (e: Entry) => {
    const reason = window.prompt('Motivo do estorno:');
    if (!reason || reason.trim().length < 3) return;
    setBusy(e.id);
    setError('');
    try {
      await api(`/admin/costs/entries/${e.id}/reverse`, { method: 'POST', body: { reason: reason.trim(), requestKey: newKey() } });
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  };
  return (
    <Panel
      title="Margem de contribuição"
      description="Receita menos custos variáveis do pedido. Não é lucro líquido. Cada valor mostra se é efetivo, estimado ou desconhecido, e de onde veio."
      actions={
        record &&
        d.margin && (
          <Button onClick={() => setOpen(!open)} data-testid="open-cost-entry">
            Lançar custo
          </Button>
        )
      }
    >
      <div className="space-y-3 text-sm" data-testid="order-margin">
        {error && <Notice tone="bad">{error}</Notice>}
        {d.excluded && <Notice tone="neutral">{EXCLUDED[d.excluded]}</Notice>}
        {d.margin && (
          <>
            {d.margin.status === 'partial' ? (
              <Notice tone="warn">
                Resultado parcial: faltam {d.margin.missing.map((c) => COMPONENT[c] ?? c).join(', ')}. Esses custos ficam fora da conta (não entram como zero).
              </Notice>
            ) : (
              <Notice tone="good">Todos os componentes conhecidos{d.margin.estimatedCents ? `, ${money(d.margin.estimatedCents)} por estimativa` : ''}.</Notice>
            )}
            <MarginSummary m={d.margin} />
            {record && !me.user.mfaEnabled && <Notice tone="warn">Lançar custo exige a verificação em duas etapas ativa.</Notice>}
            {open && (
              <form
                className="space-y-3 rounded-md border border-line bg-sunken/40 p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
                data-testid="cost-entry-form"
              >
                <div className="grid gap-3 sm:grid-cols-4">
                  <Field label="Tipo">
                    {(id) => (
                      <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                        {kinds.map((k) => (
                          <option key={k} value={k}>
                            {ENTRY_KIND[k]}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label="Valor (R$)" hint="Zero: custo conhecido e nulo.">
                    {(id) => <Input id={id} inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />}
                  </Field>
                  <Field label="Data do fato">
                    {(id) => <Input id={id} type="date" value={form.occurredOn} onChange={(e) => setForm({ ...form, occurredOn: e.target.value })} />}
                  </Field>
                  <Field label="Referência externa" hint="Identificador no provedor ou no extrato.">
                    {(id) => <Input id={id} maxLength={120} value={form.externalRef} onChange={(e) => setForm({ ...form, externalRef: e.target.value })} />}
                  </Field>
                </div>
                <Field label="Observação" required={form.kind === 'other'}>
                  {(id) => <Input id={id} maxLength={300} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" type="submit" busy={busy === 'create'} disabled={cents === null || cents < 0 || !form.occurredOn || (form.kind === 'other' && form.note.trim().length < 3)}>
                    Lançar
                  </Button>
                  <Button variant="ghost" type="button" onClick={() => setOpen(false)}>
                    Voltar
                  </Button>
                </div>
              </form>
            )}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm" data-testid="margin-lines">
                <thead className="text-xs text-ink-soft">
                  <tr>
                    <th className="py-1.5 pr-2 font-medium">Componente</th>
                    <th className="py-1.5 pr-2 font-medium">Natureza</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Valor</th>
                    <th className="py-1.5 font-medium">Origem</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {d.margin.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="py-1.5 pr-2">
                        {COMPONENT[l.component] ?? l.label}
                        {l.sku && <span className="text-ink-soft"> · {l.sku}</span>}
                      </td>
                      <td className="py-1.5 pr-2">
                        <NatureBadge nature={l.nature} />
                      </td>
                      <td className={`num whitespace-nowrap py-1.5 pr-2 text-right ${l.nature === 'info' ? 'text-ink-soft line-through' : ''}`}>{l.amountCents === null ? '—' : money(l.amountCents)}</td>
                      <td className="py-1.5 text-ink-soft">
                        {l.detail}
                        <span className="text-ink-faint">
                          {' '}
                          ({SOURCE_TABLE[l.source.table] ?? l.source.table} {l.source.ids.map(short).join(', ')})
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {d.entries.length > 0 && (
          <div>
            <h3 className="mb-1 text-sm font-medium">Lançamentos</h3>
            <ul className="divide-y divide-line" data-testid="cost-entries">
              {d.entries.map((e) => (
                <li key={e.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:gap-3">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{ENTRY_KIND[e.kind]}</span>
                    <span className="num">{money(e.amount_cents)}</span>
                    {e.reverses_id && <Badge tone="neutral">Estorno</Badge>}
                    {e.reversed && <Badge tone="neutral">Estornado</Badge>}
                    <Badge tone="neutral">{e.source === 'import' ? `Planilha nº ${e.import_number}` : 'Manual'}</Badge>
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ink-soft">
                    {e.external_ref ? `ref. ${e.external_ref} · ` : ''}
                    {e.reason ?? e.note ?? ''} · {when(e.created_at)} · {e.actor_name ?? '—'}
                  </span>
                  {record && !e.reverses_id && !e.reversed && (
                    <Button variant="ghost" busy={busy === e.id} onClick={() => reverse(e)}>
                      Estornar
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Configuracoes de custo.
type Setting = {
  id: string;
  number: number;
  kind: string;
  channel: string | null;
  payment_method: string | null;
  installments: number | null;
  packaging_code: string | null;
  packaging_name: string | null;
  length_mm: number | null;
  width_mm: number | null;
  height_mm: number | null;
  rate_pct: string | null;
  fixed_cents: number | null;
  base: string;
  valid_from: string;
  valid_to: string | null;
  status: string;
  source: string;
  informed_by_name: string | null;
  validator_name: string | null;
  validated_at: string | null;
  version: number;
};
const day = (v: string | null) => (v ? new Date(v).toISOString().slice(0, 10).split('-').reverse().join('/') : '');
const SETTING_STATUS: Record<string, { label: string; tone: Tone }> = {
  informed: { label: 'A validar', tone: 'warn' },
  validated: { label: 'Validada', tone: 'good' },
  canceled: { label: 'Cancelada', tone: 'neutral' },
};

function settingScope(s: Setting) {
  const parts: string[] = [];
  if (s.channel) parts.push(CHANNEL[s.channel] ?? s.channel);
  if (s.payment_method) parts.push(s.payment_method === 'pix' ? 'Pix' : 'Cartão');
  if (s.installments) parts.push(`${s.installments}x`);
  if (s.packaging_code) parts.push(`${s.packaging_code} · ${s.packaging_name} (${s.length_mm}×${s.width_mm}×${s.height_mm} mm)`);
  if (s.kind === 'packaging' && !s.packaging_code) parts.push('qualquer volume');
  return parts.length ? parts.join(' · ') : 'geral';
}
const settingValue = (s: Setting) =>
  [s.rate_pct !== null ? `${Number(s.rate_pct).toLocaleString('pt-BR', { maximumFractionDigits: 4 })}%${s.kind === 'tax_rate' && s.base === 'merchandise' ? ' da mercadoria' : ''}` : '', s.fixed_cents !== null ? money(s.fixed_cents) : '']
    .filter(Boolean)
    .join(' + ');

const blank = { kind: 'payment_fee', channel: '', paymentMethod: '', installments: '', packagingCode: '', packagingName: '', lengthMm: '', widthMm: '', heightMm: '', ratePct: '', fixed: '', base: 'order_total', validFrom: '', validTo: '', source: '', note: '' };

export function CostSettings() {
  const { can, me } = useMe();
  const [items, setItems] = useState<Setting[] | null>(null);
  const [regime, setRegime] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(blank);
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState('');
  const load = useCallback(() => {
    api<{ items: Setting[]; taxRegime: string | null }>('/admin/costs/settings').then(
      (r) => {
        setItems(r.items);
        setRegime(r.taxRegime);
      },
      (e) => setError(e.message),
    );
  }, []);
  useEffect(load, [load]);
  const manage = can('costs.settings');
  const num = (v: string) => (v.trim() ? Number(v) : null);
  const submit = async () => {
    setBusy('create');
    setError('');
    setNotice('');
    try {
      const fixed = f.fixed.trim() ? parseMoney(f.fixed) : null;
      await api('/admin/costs/settings', {
        method: 'POST',
        body: {
          kind: f.kind,
          channel: f.channel || null,
          paymentMethod: f.kind === 'payment_fee' && f.paymentMethod ? f.paymentMethod : null,
          installments: f.kind === 'payment_fee' && f.paymentMethod === 'card' ? num(f.installments) : null,
          packagingCode: f.kind === 'packaging' && f.packagingCode.trim() ? f.packagingCode.trim() : null,
          packagingName: f.kind === 'packaging' && f.packagingCode.trim() ? f.packagingName.trim() : null,
          lengthMm: f.kind === 'packaging' && f.packagingCode.trim() ? num(f.lengthMm) : null,
          widthMm: f.kind === 'packaging' && f.packagingCode.trim() ? num(f.widthMm) : null,
          heightMm: f.kind === 'packaging' && f.packagingCode.trim() ? num(f.heightMm) : null,
          ratePct: f.kind === 'packaging' || !f.ratePct.trim() ? null : f.ratePct.trim().replace(',', '.'),
          fixedCents: f.kind === 'tax_rate' ? null : fixed,
          base: f.kind === 'tax_rate' ? f.base : 'order_total',
          validFrom: f.validFrom,
          validTo: f.validTo || null,
          source: f.source.trim(),
          note: f.note.trim() || null,
          requestKey: key,
        },
      });
      setNotice(f.kind === 'tax_rate' ? 'Alíquota informada. Ela só entra no cálculo depois de validada pelo contador.' : 'Configuração informada. Ela só entra no cálculo depois de validada.');
      setKey(newKey());
      setOpen(false);
      setF(blank);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const act = async (s: Setting, action: 'validate' | 'cancel' | 'end') => {
    let body: Record<string, unknown> = { version: s.version };
    if (action === 'validate') {
      const name = window.prompt(s.kind === 'tax_rate' ? 'Nome do contador ou responsável tributário que validou:' : 'Nome de quem conferiu e validou:');
      if (!name || name.trim().length < 2) return;
      body = { ...body, validatorName: name.trim() };
    } else {
      const reason = window.prompt(action === 'cancel' ? 'Motivo do cancelamento:' : 'Motivo do encerramento:');
      if (!reason || reason.trim().length < 3) return;
      body = { ...body, reason: reason.trim() };
      if (action === 'end') {
        const to = window.prompt('Fim da vigência (AAAA-MM-DD). A configuração vale até o dia anterior:');
        if (!to || !/^\d{4}-\d{2}-\d{2}$/.test(to.trim())) return;
        body = { ...body, validTo: to.trim() };
      }
    }
    setBusy(s.id + action);
    setError('');
    try {
      await api(`/admin/costs/settings/${s.id}/${action}`, { method: 'POST', body });
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const canValidate = (s: Setting) => (s.kind === 'tax_rate' ? can('fiscal.validate') : manage);
  return (
    <div className="space-y-4">
      {error && <Notice tone="bad">{error}</Notice>}
      {notice && <Notice tone="good">{notice}</Notice>}
      <Notice tone="neutral">
        Só a versão <strong>validada</strong> entra no cálculo, pela vigência na data do fato. Tributo estimado é validado pelo contador (permissão de validação fiscal) e nunca é valor
        fiscal definitivo. Regime informado na empresa: {regime ?? 'não informado'}.
      </Notice>
      {manage && !me.user.mfaEnabled && <Notice tone="warn">Alterar configuração financeira exige a verificação em duas etapas ativa.</Notice>}
      {manage && (
        <div>
          <Button onClick={() => setOpen(!open)} data-testid="open-setting-form">
            Nova configuração
          </Button>
        </div>
      )}
      {open && (
        <form
          className="space-y-3 rounded-lg border border-line bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          data-testid="setting-form"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Tipo">
              {(id) => (
                <Select id={id} value={f.kind} onChange={(e) => setF({ ...blank, kind: e.target.value, validFrom: f.validFrom, source: f.source })}>
                  {Object.entries(SETTING_KIND).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {f.kind !== 'packaging' && (
              <Field label="Canal">
                {(id) => (
                  <Select id={id} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
                    {f.kind !== 'marketplace_fee' && <option value="">Todos</option>}
                    {Object.entries(CHANNEL)
                      .filter(([k]) => (f.kind === 'marketplace_fee' ? ['mercadolivre', 'shopee'].includes(k) : f.kind === 'payment_fee' ? ['store', 'sales_desk'].includes(k) : true))
                      .map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
            )}
            {f.kind === 'payment_fee' && (
              <Field label="Meio">
                {(id) => (
                  <Select id={id} value={f.paymentMethod} onChange={(e) => setF({ ...f, paymentMethod: e.target.value })}>
                    <option value="">Todos</option>
                    <option value="pix">Pix</option>
                    <option value="card">Cartão</option>
                  </Select>
                )}
              </Field>
            )}
            {f.kind === 'payment_fee' && f.paymentMethod === 'card' && (
              <Field label="Parcelas" hint="Vazio: qualquer número.">
                {(id) => <Input id={id} inputMode="numeric" value={f.installments} onChange={(e) => setF({ ...f, installments: e.target.value })} />}
              </Field>
            )}
            {f.kind === 'packaging' && (
              <>
                <Field label="Código do tipo" hint="Vazio: custo por volume, para qualquer caixa.">
                  {(id) => <Input id={id} maxLength={30} value={f.packagingCode} onChange={(e) => setF({ ...f, packagingCode: e.target.value.toUpperCase() })} />}
                </Field>
                {f.packagingCode && (
                  <Field label="Nome do tipo">
                    {(id) => <Input id={id} maxLength={80} value={f.packagingName} onChange={(e) => setF({ ...f, packagingName: e.target.value })} />}
                  </Field>
                )}
              </>
            )}
          </div>
          {f.kind === 'packaging' && f.packagingCode && (
            <div className="grid grid-cols-3 gap-3">
              {(['lengthMm', 'widthMm', 'heightMm'] as const).map((k, i) => (
                <Field key={k} label={['Comprimento (mm)', 'Largura (mm)', 'Altura (mm)'][i]!}>
                  {(id) => <Input id={id} inputMode="numeric" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}
                </Field>
              ))}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-4">
            {f.kind !== 'packaging' && (
              <Field label="Percentual (%)">{(id) => <Input id={id} inputMode="decimal" value={f.ratePct} onChange={(e) => setF({ ...f, ratePct: e.target.value })} />}</Field>
            )}
            {f.kind !== 'tax_rate' && (
              <Field label={f.kind === 'packaging' ? 'Custo por volume (R$)' : 'Valor fixo (R$)'}>
                {(id) => <Input id={id} inputMode="decimal" value={f.fixed} onChange={(e) => setF({ ...f, fixed: e.target.value })} />}
              </Field>
            )}
            {f.kind === 'tax_rate' && (
              <Field label="Base">
                {(id) => (
                  <Select id={id} value={f.base} onChange={(e) => setF({ ...f, base: e.target.value })}>
                    <option value="order_total">Total do pedido</option>
                    <option value="merchandise">Só a mercadoria</option>
                  </Select>
                )}
              </Field>
            )}
            <Field label="Vale a partir de" required>
              {(id) => <Input id={id} type="date" value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} />}
            </Field>
            <Field label="Vale até (exclusive)" hint="Vazio: sem fim.">
              {(id) => <Input id={id} type="date" value={f.validTo} onChange={(e) => setF({ ...f, validTo: e.target.value })} />}
            </Field>
          </div>
          <Field label="Origem do valor" required hint="Tabela do provedor, contrato ou orientação do contador.">
            {(id) => <Input id={id} maxLength={200} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} />}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" type="submit" busy={busy === 'create'} disabled={!f.validFrom || f.source.trim().length < 3 || (f.kind === 'marketplace_fee' && !f.channel)}>
              Informar
            </Button>
            <Button variant="ghost" type="button" onClick={() => setOpen(false)}>
              Voltar
            </Button>
          </div>
        </form>
      )}
      {!items ? null : items.length === 0 ? (
        <Empty title="Nenhuma configuração de custo">Sem configuração validada, taxas, tributos e embalagem ficam como desconhecidos nas margens.</Empty>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-card" data-testid="setting-list">
          {items.map((s) => (
            <li key={s.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    Nº {s.number} · {SETTING_KIND[s.kind]}
                  </span>
                  <Badge tone={SETTING_STATUS[s.status]?.tone ?? 'neutral'}>{SETTING_STATUS[s.status]?.label ?? s.status}</Badge>
                </div>
                <p className="text-sm text-ink-soft">
                  {settingScope(s)} · <span className="num text-ink">{settingValue(s)}</span> · de {day(s.valid_from)}
                  {s.valid_to ? ` até ${day(s.valid_to)} (exclusive)` : ' sem fim'}
                </p>
                <p className="text-xs text-ink-faint">
                  {s.source} · informada por {s.informed_by_name ?? '—'}
                  {s.validator_name ? ` · validada por ${s.validator_name} em ${when(s.validated_at)}` : ''}
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                {s.status === 'informed' && canValidate(s) && (
                  <Button variant="ghost" busy={busy === s.id + 'validate'} onClick={() => act(s, 'validate')}>
                    Validar
                  </Button>
                )}
                {s.status === 'informed' && manage && (
                  <Button variant="ghost" busy={busy === s.id + 'cancel'} onClick={() => act(s, 'cancel')}>
                    Cancelar
                  </Button>
                )}
                {s.status === 'validated' && !s.valid_to && (manage || (s.kind === 'tax_rate' && can('fiscal.validate'))) && (
                  <Button variant="ghost" busy={busy === s.id + 'end'} onClick={() => act(s, 'end')}>
                    Encerrar
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Lancamentos e importacao.
export function CostEntries() {
  const [order, setOrder] = useState('');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: (Entry & { order_id: string })[]; total: number; pageSize: number } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const q = new URLSearchParams({ page: String(page), pageSize: '30' });
    if (/^\d+$/.test(order)) q.set('order', order);
    if (kind) q.set('kind', kind);
    api(`/admin/costs/entries?${q}`).then(setData, (e) => setError(e.message));
  }, [order, kind, page]);
  return (
    <div className="space-y-3">
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Pedido nº" className="w-36">
          {(id) => <Input id={id} inputMode="numeric" value={order} onChange={(e) => (setOrder(e.target.value), setPage(1))} />}
        </Field>
        <Field label="Tipo" className="w-56">
          {(id) => (
            <Select id={id} value={kind} onChange={(e) => (setKind(e.target.value), setPage(1))}>
              <option value="">Todos</option>
              {Object.entries(ENTRY_KIND).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <p className="text-sm text-ink-soft">Para lançar ou estornar, abra o pedido (painel Margem de contribuição) ou importe uma planilha.</p>
      {data && data.items.length === 0 && <Empty title="Nenhum lançamento" />}
      {data && data.items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line bg-card">
          <table className="w-full min-w-[640px] text-left text-sm" data-testid="entry-list">
            <thead className="text-xs text-ink-soft">
              <tr className="border-b border-line">
                <th className="px-3 py-2 font-medium">Pedido</th>
                <th className="px-3 py-2 font-medium">Tipo</th>
                <th className="px-3 py-2 text-right font-medium">Valor</th>
                <th className="px-3 py-2 font-medium">Data</th>
                <th className="px-3 py-2 font-medium">Origem</th>
                <th className="px-3 py-2 font-medium">Referência</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.items.map((e) => (
                <tr key={e.id}>
                  <td className="px-3 py-2">
                    <a className="underline underline-offset-2" href={`/painel/pedidos/${e.order_id}`}>
                      {e.order_number}
                    </a>
                  </td>
                  <td className="px-3 py-2">
                    {ENTRY_KIND[e.kind]}
                    {e.reverses_id && ' (estorno)'}
                    {e.reversed && ' (estornado)'}
                  </td>
                  <td className="num px-3 py-2 text-right">{money(e.amount_cents)}</td>
                  <td className="px-3 py-2">{day(e.occurred_on)}</td>
                  <td className="px-3 py-2">{e.source === 'import' ? `Planilha nº ${e.import_number}` : 'Manual'}</td>
                  <td className="px-3 py-2 text-ink-soft">{e.external_ref ?? e.reason ?? e.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > data.pageSize && (
        <div className="flex gap-2">
          <Button variant="ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>
            Anterior
          </Button>
          <Button variant="ghost" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>
            Próxima
          </Button>
        </div>
      )}
    </div>
  );
}

type Preview = {
  fileName: string;
  alreadyImported: number | null;
  rows: { line: number; orderNumber: number | null; kind: string | null; amountCents: number | null; occurredOn: string | null; externalRef: string | null; errors: string[] }[];
  valid: number;
  invalid: number;
  totalCents: number;
};
export function CostImport() {
  const { can, me } = useMe();
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [key, setKey] = useState(newKey);
  if (!can('costs.record')) return <Notice tone="neutral">Importar planilha exige a permissão de lançar custos externos.</Notice>;
  const check = async (f: { name: string; content: string }) => {
    setBusy('preview');
    setError('');
    setNotice('');
    try {
      setPreview(await api<Preview>('/admin/costs/imports/preview', { method: 'POST', body: { fileName: f.name, content: f.content } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const confirm = async () => {
    if (!file) return;
    setBusy('import');
    setError('');
    try {
      const r = await api<{ import: { number: number; rows: number } }>('/admin/costs/imports', { method: 'POST', body: { fileName: file.name, content: file.content, requestKey: key } });
      setNotice(`Importação nº ${r.import.number}: ${r.import.rows} lançamento(s).`);
      setPreview(null);
      setFile(null);
      setKey(newKey());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="space-y-3" data-testid="cost-import">
      {error && <Notice tone="bad">{error}</Notice>}
      {notice && <Notice tone="good">{notice}</Notice>}
      {!me.user.mfaEnabled && <Notice tone="warn">Importar exige a verificação em duas etapas ativa.</Notice>}
      <Notice tone="neutral">
        Planilha CSV com as colunas <code>pedido;tipo;valor;data;referencia;observacao</code>. Tipos: taxa_pagamento, comissao_marketplace, tarifa_marketplace, frete_marketplace, tributo,
        outro. A planilha é conferida antes e entra inteira ou nada; a mesma taxa não entra duas vezes (nem importada e depois manual).
      </Notice>
      <Field label="Arquivo CSV">
        {(id) => (
          <Input
            id={id}
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const content = await f.text();
              setFile({ name: f.name, content });
              setKey(newKey());
              check({ name: f.name, content });
            }}
          />
        )}
      </Field>
      {busy === 'preview' && <p className="text-sm text-ink-soft">Conferindo…</p>}
      {preview && (
        <Panel title={`Prévia: ${preview.fileName}`} description={`${preview.valid} linha(s) boa(s), ${preview.invalid} com erro, ${money(preview.totalCents)} no total.`}>
          {preview.alreadyImported && <Notice tone="warn">Esta planilha já foi importada (importação nº {preview.alreadyImported}).</Notice>}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm" data-testid="import-preview">
              <thead className="text-xs text-ink-soft">
                <tr>
                  <th className="py-1.5 pr-2 font-medium">Linha</th>
                  <th className="py-1.5 pr-2 font-medium">Pedido</th>
                  <th className="py-1.5 pr-2 font-medium">Tipo</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Valor</th>
                  <th className="py-1.5 font-medium">Situação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {preview.rows.map((r) => (
                  <tr key={r.line}>
                    <td className="py-1.5 pr-2">{r.line}</td>
                    <td className="py-1.5 pr-2">{r.orderNumber ?? '—'}</td>
                    <td className="py-1.5 pr-2">{r.kind ? ENTRY_KIND[r.kind] : '—'}</td>
                    <td className="num py-1.5 pr-2 text-right">{money(r.amountCents)}</td>
                    <td className={`py-1.5 ${r.errors.length ? 'text-bad' : 'text-good'}`}>{r.errors.length ? r.errors.join('; ') : 'ok'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" busy={busy === 'import'} disabled={preview.invalid > 0 || !!preview.alreadyImported || preview.valid === 0} onClick={confirm}>
              Importar {preview.valid} lançamento(s)
            </Button>
            <Button variant="ghost" onClick={() => (setPreview(null), setFile(null))}>
              Descartar
            </Button>
          </div>
        </Panel>
      )}
    </div>
  );
}

type Reconcile = { divergences: { check_code: string; field: string; ref_id: string; expected: string; found: string }[]; checkedOrders: number };
const RECONCILE_FIELD: Record<string, string> = {
  reversal: 'estorno diferente do original',
  net: 'líquido negativo no pedido e tipo',
  single: 'mais de um lançamento ativo do mesmo tipo',
  external_ref: 'referência externa repetida',
  channel: 'tipo incompatível com o canal',
  overlap: 'versões validadas sobrepostas',
  packaging_dims: 'tipos de embalagem com as mesmas medidas',
  sum: 'margem diferente da soma dos componentes',
  unknown_valued: 'componente desconhecido com valor',
};
export function CostReconcile() {
  const [r, setR] = useState<Reconcile | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      setR(await api<Reconcile>('/admin/costs/reconcile'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3" data-testid="cost-reconcile">
      <p className="text-sm text-ink-soft">
        C22 lançamentos (estorno, duplicidade, canal), C23 configurações (vigências sobrepostas) e C24 margem de cada pedido igual à soma dos componentes, nos últimos pedidos pagos. Só leitura.
      </p>
      <Button onClick={run} busy={busy}>
        Conferir C22–C24
      </Button>
      {error && <Notice tone="bad">{error}</Notice>}
      {r &&
        (r.divergences.length === 0 ? (
          <Notice tone="good">Nenhuma divergência ({r.checkedOrders} pedido(s) conferido(s) no C24).</Notice>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-card text-sm">
            {r.divergences.map((d, i) => (
              <li key={i} className="px-3 py-2">
                <strong>{d.check_code}</strong> {RECONCILE_FIELD[d.field] ?? d.field} · {d.ref_id} · esperado {d.expected}, encontrado {d.found}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
