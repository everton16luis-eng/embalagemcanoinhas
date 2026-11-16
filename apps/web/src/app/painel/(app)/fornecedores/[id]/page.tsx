'use client';

import { Pencil, Star, Trash2 } from 'lucide-react';
import Link from '@/components/painel-link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Guard, useMe } from '@/components/shell';
import { packLabel, PackagingPicker, type PackagingHit } from '@/components/stock';
import { AVAILABILITY_SOURCE, AvailabilityBadge, OFFER_STATUS, SupplierBadge } from '@/components/suppliers';
import { Badge, Button, Empty, Field, Input, Notice, PageHeader, Panel, Select, Textarea } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { centsToInput, formatCnpj, money, parseMoney, parseQty, qty, qtyToInput, unitMoney, when } from '@/lib/format';

/* eslint-disable @typescript-eslint/no-explicit-any */
const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
const TABS = [
  ['visao', 'Visão geral'],
  ['cadastro', 'Cadastro'],
  ['produtos', 'Produtos e embalagens'],
  ['disponibilidade', 'Disponibilidade'],
  ['historico', 'Histórico'],
] as const;
type Msg = { tone: 'good' | 'bad' | 'warn'; text: string; conflict?: boolean } | null;
const nul = (v: string) => (v.trim() ? v.trim() : null);
const intOrNull = (v: string) => (v.trim() ? Number(v) : null);
const moneyOrNull = (v: string) => (v.trim() ? parseMoney(v) : null);
const errMsg = (err: unknown): Msg => {
  const e = err as ApiError;
  if (e?.code === 'VERSION_CONFLICT') return { tone: 'bad', text: 'Outra pessoa alterou este registro. Nada foi gravado: recarregue para ver a versão atual.', conflict: true };
  return { tone: 'bad', text: (err as Error).message };
};

function MsgBox({ msg, onReload }: { msg: Msg; onReload?: () => void }) {
  if (!msg) return null;
  return (
    <Notice tone={msg.tone}>
      {msg.text}{' '}
      {msg.conflict && onReload && (
        <button type="button" className="font-medium underline" onClick={onReload}>
          Recarregar
        </button>
      )}
    </Notice>
  );
}

// ------------------------------------------------------------------ cadastro
type Contact = { name: string; role: string; email: string; phone: string; whatsapp: string; isPrimary: boolean };
type Form = Record<
  | 'name' | 'legalName' | 'document' | 'stateRegistration' | 'email' | 'phone' | 'whatsapp' | 'website' | 'cep' | 'street' | 'number' | 'complement' | 'district' | 'city' | 'uf'
  | 'paymentTerms' | 'leadTimeDays' | 'prepDays' | 'deliveryDays' | 'minOrder' | 'orderFreight' | 'orderExtra' | 'freightTerms' | 'returnPolicy' | 'returnDays' | 'notes',
  string
> & { dropshipEnabled: boolean; contacts: Contact[] };

const emptyForm: Form = {
  name: '', legalName: '', document: '', stateRegistration: '', email: '', phone: '', whatsapp: '', website: '', cep: '', street: '', number: '', complement: '', district: '', city: '', uf: 'SC',
  paymentTerms: '', leadTimeDays: '', prepDays: '', deliveryDays: '', minOrder: '', orderFreight: '', orderExtra: '', freightTerms: '', returnPolicy: '', returnDays: '', notes: '', dropshipEnabled: false, contacts: [],
};
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
function toForm(s: any): Form {
  return {
    name: s.name, legalName: str(s.legal_name), document: str(s.document), stateRegistration: str(s.state_registration), email: str(s.email), phone: str(s.phone), whatsapp: str(s.whatsapp),
    website: str(s.website), cep: str(s.cep), street: str(s.street), number: str(s.number), complement: str(s.complement), district: str(s.district), city: str(s.city), uf: str(s.uf),
    paymentTerms: str(s.payment_terms), leadTimeDays: str(s.lead_time_days), prepDays: str(s.prep_days), deliveryDays: str(s.delivery_days), minOrder: centsToInput(s.min_order_cents),
    orderFreight: centsToInput(s.order_freight_cents), orderExtra: centsToInput(s.order_extra_cents), freightTerms: str(s.freight_terms), returnPolicy: str(s.return_policy), returnDays: str(s.return_days),
    notes: str(s.notes), dropshipEnabled: s.dropship_enabled,
    contacts: s.contacts.map((c: any) => ({ name: str(c.name), role: str(c.role), email: str(c.email), phone: str(c.phone), whatsapp: str(c.whatsapp), isPrimary: c.is_primary })),
  };
}

function SupplierForm({ supplier, onSaved, onReload }: { supplier: any | null; onSaved: (s: any) => void; onReload: () => void }) {
  const isNew = !supplier;
  const { can } = useMe();
  const router = useRouter();
  const editable = can('suppliers.manage');
  const [form, setForm] = useState<Form>(supplier ? toForm(supplier) : emptyForm);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  useEffect(() => {
    if (supplier) setForm(toForm(supplier));
  }, [supplier]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    for (const [k, label] of [['minOrder', 'pedido mínimo'], ['orderFreight', 'frete por pedido'], ['orderExtra', 'despesas por pedido']] as const) {
      if (form[k].trim() && parseMoney(form[k]) === null) return setMsg({ tone: 'bad', text: `Valor inválido em ${label}.` });
    }
    const body: Record<string, unknown> = {
      name: form.name, legalName: nul(form.legalName), document: nul(form.document), stateRegistration: nul(form.stateRegistration), email: nul(form.email), phone: nul(form.phone),
      whatsapp: nul(form.whatsapp), website: nul(form.website), cep: nul(form.cep), street: nul(form.street), number: nul(form.number), complement: nul(form.complement),
      district: nul(form.district), city: nul(form.city), uf: nul(form.uf), paymentTerms: nul(form.paymentTerms), leadTimeDays: intOrNull(form.leadTimeDays),
      prepDays: intOrNull(form.prepDays), deliveryDays: intOrNull(form.deliveryDays), minOrderCents: moneyOrNull(form.minOrder), orderFreightCents: moneyOrNull(form.orderFreight),
      orderExtraCents: moneyOrNull(form.orderExtra), freightTerms: nul(form.freightTerms), returnPolicy: nul(form.returnPolicy), returnDays: intOrNull(form.returnDays),
      dropshipEnabled: form.dropshipEnabled, notes: nul(form.notes),
      contacts: form.contacts.filter((c) => c.name.trim()).map((c) => ({ name: c.name, role: nul(c.role), email: nul(c.email), phone: nul(c.phone), whatsapp: nul(c.whatsapp), isPrimary: c.isPrimary })),
    };
    if (!isNew) body.version = supplier.version;
    setBusy(true);
    try {
      const r = await api(isNew ? '/admin/suppliers' : `/admin/suppliers/${supplier.id}`, { method: isNew ? 'POST' : 'PUT', body });
      if (isNew) router.replace(`/painel/fornecedores/${r.supplier.id}?aba=produtos`);
      else {
        onSaved(r.supplier);
        setMsg({ tone: 'good', text: 'Fornecedor salvo.' });
      }
    } catch (err) {
      setMsg(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const text = (k: keyof Omit<Form, 'contacts' | 'dropshipEnabled'>, label: string, props: Record<string, unknown> = {}, hint?: string) => (
    <Field label={label} required={k === 'name'} hint={hint}>
      {(fid) => <Input id={fid} value={form[k]} onChange={(e) => set(k, e.target.value)} disabled={!editable} {...props} />}
    </Field>
  );
  const setContact = (i: number, patch: Partial<Contact>) =>
    set('contacts', form.contacts.map((c, j) => (j === i ? { ...c, ...patch } : patch.isPrimary ? { ...c, isPrimary: false } : c)));

  return (
    <form onSubmit={save} className="space-y-5">
      <Panel title="Identificação">
        <div className="grid gap-3 sm:grid-cols-2">
          {text('name', 'Nome fantasia (nome de uso)', { required: true, maxLength: 120 })}
          {text('legalName', 'Razão social', { maxLength: 150 })}
          {text('document', 'CNPJ ou CPF', {}, 'A NF-e de compra encontra o fornecedor por este número.')}
          {text('stateRegistration', 'Inscrição estadual')}
          {text('email', 'E-mail', { type: 'email' })}
          {text('phone', 'Telefone', { inputMode: 'tel' })}
          {text('whatsapp', 'WhatsApp (com 55 e DDD)', { inputMode: 'tel', placeholder: '5547999990000' })}
          {text('website', 'Site', { type: 'url', placeholder: 'https://' })}
        </div>
      </Panel>
      <Panel title="Endereço" description="Digitado: o sistema não consulta CEP em serviço externo.">
        <div className="grid gap-3 sm:grid-cols-6">
          <div className="sm:col-span-2">{text('cep', 'CEP', { inputMode: 'numeric', maxLength: 9 })}</div>
          <div className="sm:col-span-4">{text('street', 'Rua', { maxLength: 120 })}</div>
          <div className="sm:col-span-2">{text('number', 'Número', { maxLength: 20 })}</div>
          <div className="sm:col-span-4">{text('complement', 'Complemento', { maxLength: 60 })}</div>
          <div className="sm:col-span-2">{text('district', 'Bairro', { maxLength: 60 })}</div>
          <div className="sm:col-span-3">{text('city', 'Cidade', { maxLength: 60 })}</div>
          <Field label="UF">
            {(fid) => (
              <Select id={fid} value={form.uf} onChange={(e) => set('uf', e.target.value)} disabled={!editable}>
                <option value="">—</option>
                {UFS.map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Panel>
      <Panel title="Contatos">
        <div className="space-y-2">
          {form.contacts.map((c, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_1fr_auto_auto] sm:items-center">
              {(['name', 'role', 'email', 'phone', 'whatsapp'] as const).map((k) => (
                <Input
                  key={k}
                  aria-label={{ name: 'Nome', role: 'Função', email: 'E-mail', phone: 'Telefone', whatsapp: 'WhatsApp' }[k]}
                  placeholder={{ name: 'Nome', role: 'Função', email: 'E-mail', phone: 'Telefone', whatsapp: 'WhatsApp (55…)' }[k]}
                  value={c[k]}
                  disabled={!editable}
                  onChange={(e) => setContact(i, { [k]: e.target.value })}
                />
              ))}
              <label className="flex items-center gap-1 text-xs text-ink-soft">
                <input type="radio" name="primary-contact" checked={c.isPrimary} disabled={!editable} onChange={() => setContact(i, { isPrimary: true })} /> Principal
              </label>
              {editable && (
                <Button type="button" variant="ghost" aria-label="Remover contato" onClick={() => set('contacts', form.contacts.filter((_, j) => j !== i))}>
                  <Trash2 size={16} />
                </Button>
              )}
            </div>
          ))}
          {form.contacts.length === 0 && <p className="text-sm text-ink-soft">Nenhum contato.</p>}
          {editable && form.contacts.length < 10 && (
            <Button type="button" variant="ghost" onClick={() => set('contacts', [...form.contacts, { name: '', role: '', email: '', phone: '', whatsapp: '', isPrimary: form.contacts.length === 0 }])}>
              Adicionar contato
            </Button>
          )}
        </div>
      </Panel>
      <Panel title="Condições comerciais e prazos" description="Frete e despesas por pedido vazios = desconhecidos: a sugestão nunca os trata como zero. Informe 0 quando estiverem inclusos.">
        <div className="grid gap-3 sm:grid-cols-3">
          {text('paymentTerms', 'Condição de pagamento', { placeholder: 'Ex.: 28 dias boleto' })}
          {text('minOrder', 'Pedido mínimo (R$)', { inputMode: 'decimal' })}
          {text('freightTerms', 'Frete (texto)', { placeholder: 'Ex.: CIF acima de R$ 1.500' })}
          {text('orderFreight', 'Frete por pedido (R$)', { inputMode: 'decimal' })}
          {text('orderExtra', 'Outras despesas por pedido (R$)', { inputMode: 'decimal' })}
          <div />
          {text('prepDays', 'Preparação (dias)', { inputMode: 'numeric' }, 'Separação no fornecedor.')}
          {text('deliveryDays', 'Transporte (dias)', { inputMode: 'numeric' }, 'Até chegar na loja.')}
          {text('leadTimeDays', 'Prazo total antigo (dias)', { inputMode: 'numeric' }, 'Usado quando preparação ou transporte faltam, e pela reposição.')}
        </div>
      </Panel>
      <Panel title="Devolução">
        <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
          <Field label="Política de devolução">{(fid) => <Textarea id={fid} value={form.returnPolicy} onChange={(e) => set('returnPolicy', e.target.value)} disabled={!editable} maxLength={2000} />}</Field>
          {text('returnDays', 'Prazo para devolver (dias)', { inputMode: 'numeric' })}
        </div>
      </Panel>
      <Panel title="Dropshipping">
        <Notice tone="warn">Somente cadastro. A operação por dropshipping está bloqueada até a validação fiscal e uma autorização específica.</Notice>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.dropshipEnabled} disabled={!editable} onChange={(e) => set('dropshipEnabled', e.target.checked)} /> Fornecedor aceita enviar direto ao cliente
        </label>
      </Panel>
      <Panel title="Observações">
        <Field label="Observações internas">{(fid) => <Textarea id={fid} value={form.notes} onChange={(e) => set('notes', e.target.value)} disabled={!editable} maxLength={2000} />}</Field>
      </Panel>
      <MsgBox msg={msg} onReload={onReload} />
      {editable && (
        <Button variant="primary" busy={busy}>
          {isNew ? 'Cadastrar fornecedor' : 'Salvar cadastro'}
        </Button>
      )}
    </form>
  );
}

// ------------------------------------------------------------------ situacao
function StatusActions({ s, onChanged }: { s: any; onChanged: (s: any, note?: string) => void }) {
  const [action, setAction] = useState<null | 'blocked' | 'inactive' | 'active' | 'archive' | 'restore'>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      let r;
      if (action === 'archive') r = await api(`/admin/suppliers/${s.id}/archive`, { method: 'POST', body: { reason, version: s.version } });
      else if (action === 'restore') r = await api(`/admin/suppliers/${s.id}/restore`, { method: 'POST', body: { version: s.version } });
      else r = await api(`/admin/suppliers/${s.id}/status`, { method: 'POST', body: { status: action, ...(reason.trim() ? { reason } : {}), version: s.version } });
      const notes: string[] = [];
      if (r.openOrders) notes.push(`${r.openOrders} pedido(s) de compra em aberto com este fornecedor.`);
      if (r.variantsLostPrimary?.length) notes.push(`Ficaram sem fornecedor principal: ${r.variantsLostPrimary.map((v: any) => v.sku).join(', ')}.`);
      onChanged(r.supplier, notes.join(' '));
      setAction(null);
      setReason('');
    } catch (err) {
      setMsg(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  const needsReason = action === 'blocked' || action === 'archive';
  const title = { blocked: 'Bloquear fornecedor', inactive: 'Inativar fornecedor', active: s.status === 'blocked' ? 'Desbloquear (volta a ativo)' : 'Ativar fornecedor', archive: 'Arquivar fornecedor', restore: 'Restaurar fornecedor' };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {s.archived_at ? (
          <Button onClick={() => setAction('restore')}>Restaurar</Button>
        ) : (
          <>
            {s.status !== 'active' && <Button onClick={() => setAction('active')}>{s.status === 'blocked' ? 'Desbloquear' : 'Ativar'}</Button>}
            {s.status === 'active' && <Button onClick={() => setAction('inactive')}>Inativar</Button>}
            {s.status !== 'blocked' && (
              <Button variant="danger" onClick={() => setAction('blocked')}>
                Bloquear
              </Button>
            )}
            {s.status !== 'active' && <Button onClick={() => setAction('archive')}>Arquivar</Button>}
          </>
        )}
      </div>
      {action && (
        <div className="rounded-md border border-line bg-sunken/50 p-3">
          <p className="mb-2 text-sm font-medium">{title[action]}</p>
          {action === 'blocked' && <p className="mb-2 text-xs text-ink-soft">Bloqueado não recebe pedido novo, rascunhos não são enviados e perde a marca de principal. O que já foi enviado pode ser recebido.</p>}
          {action === 'archive' && <p className="mb-2 text-xs text-ink-soft">Nada é apagado: pedidos, recebimentos, notas e históricos continuam ligados. Restaurar volta como inativo.</p>}
          {action === 'active' && <p className="mb-2 text-xs text-ink-soft">A marca de fornecedor principal não volta sozinha.</p>}
          {needsReason && <Input aria-label="Motivo" placeholder="Motivo (obrigatório)" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} className="mb-2" />}
          <div className="flex gap-2">
            <Button variant={action === 'blocked' ? 'danger' : 'primary'} busy={busy} disabled={needsReason && reason.trim().length < 3} onClick={run}>
              Confirmar
            </Button>
            <Button variant="ghost" onClick={() => setAction(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
      <MsgBox msg={msg} />
    </div>
  );
}

// ------------------------------------------------------------------ visao geral
function Overview({ s }: { s: any }) {
  const i = s.indicators ?? {};
  const a = s.alerts ?? {};
  const contact = s.contacts.find((c: any) => c.is_primary) ?? s.contacts[0];
  const alerts: [string, string][] = [];
  if (a.stale_quotes) alerts.push([`${a.stale_quotes} oferta(s) com cotação antiga`, 'produtos']);
  if (a.expired_availability) alerts.push([`${a.expired_availability} disponibilidade(s) vencida(s)`, 'disponibilidade']);
  if (a.missing_contact) alerts.push(['Sem telefone, WhatsApp ou e-mail', 'cadastro']);
  if (a.missing_document) alerts.push(['Sem CNPJ/CPF: a NF-e de compra não encontra o fornecedor', 'cadastro']);
  const stat = (label: string, value: ReactNode) => (
    <div className="rounded-md border border-line px-3 py-2">
      <span className="num block text-base font-semibold">{value ?? '—'}</span>
      <span className="text-xs text-ink-soft">{label}</span>
    </div>
  );
  const wa = contact?.whatsapp ?? s.whatsapp;
  const phone = contact?.phone ?? s.phone;
  const email = contact?.email ?? s.email;
  return (
    <div className="space-y-5">
      {alerts.length > 0 && (
        <Notice tone="warn">
          {alerts.map(([t, tab]) => (
            <span key={t} className="block">
              ⚠ {t} —{' '}
              <Link href={`?aba=${tab}`} className="underline">
                ver
              </Link>
            </span>
          ))}
        </Notice>
      )}
      <Panel title="Indicadores de compras">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {stat('comprado em 90 dias', money(i.purchased_90d_cents))}
          {stat('pedidos / recebimentos', `${i.orders ?? 0} / ${i.receipts ?? 0}`)}
          {stat('prazo real médio (dias)', i.avg_real_lead_days === null ? null : qty(i.avg_real_lead_days))}
          {stat('entregas no prazo', i.on_time_pct === null ? null : `${i.on_time_pct} %`)}
          {stat('variação de custo em 90 dias', i.cost_change_90d_pct === null ? null : `${Number(i.cost_change_90d_pct) > 0 ? '+' : ''}${qty(i.cost_change_90d_pct)} %`)}
          {stat('última compra', when(i.last_purchase_at))}
          {stat('última entrega', when(i.last_delivery_at))}
          {stat('principal / mais barato em', `${i.primary_items ?? 0} / ${i.cheapest_items ?? 0} itens`)}
        </div>
      </Panel>
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Contato">
          {contact || phone || email || wa ? (
            <div className="space-y-1 text-sm">
              {contact && (
                <p className="font-medium">
                  {contact.name}
                  {contact.role && <span className="font-normal text-ink-soft"> · {contact.role}</span>}
                </p>
              )}
              {phone && (
                <p>
                  <a className="underline" href={`tel:+55${phone}`}>
                    {phone}
                  </a>
                </p>
              )}
              {wa && (
                <p>
                  <a className="underline" href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer">
                    WhatsApp {wa}
                  </a>
                </p>
              )}
              {email && (
                <p>
                  <a className="underline" href={`mailto:${email}`}>
                    {email}
                  </a>
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-ink-soft">Sem contato cadastrado.</p>
          )}
        </Panel>
        <Panel title="Condições">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink-soft">Documento</dt>
            <dd>{s.document ? formatCnpj(s.document) : '—'}</dd>
            <dt className="text-ink-soft">Pagamento</dt>
            <dd>{s.payment_terms ?? '—'}</dd>
            <dt className="text-ink-soft">Pedido mínimo</dt>
            <dd>{money(s.min_order_cents)}</dd>
            <dt className="text-ink-soft">Frete / despesas por pedido</dt>
            <dd>
              {s.order_freight_cents === null ? 'desconhecido' : money(s.order_freight_cents)} / {s.order_extra_cents === null ? 'desconhecidas' : money(s.order_extra_cents)}
            </dd>
            <dt className="text-ink-soft">Prazo</dt>
            <dd>{s.prep_days !== null && s.delivery_days !== null ? `${s.prep_days} d preparo + ${s.delivery_days} d transporte` : s.lead_time_days !== null ? `${s.lead_time_days} dias` : '—'}</dd>
            <dt className="text-ink-soft">Devolução</dt>
            <dd>{s.return_policy ? `${s.return_policy}${s.return_days !== null ? ` (${s.return_days} dias)` : ''}` : '—'}</dd>
          </dl>
        </Panel>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ ofertas
type OfferEdit = { cost: string; costReason: string; supplierSku: string; minOrderPacks: string; orderMultiplePacks: string; prepDays: string; leadTimeDays: string; quotedAt: string; dropshipAllowed: boolean };
const toEdit = (o: any): OfferEdit => ({
  cost: centsToInput(o.cost_cents), costReason: '', supplierSku: str(o.supplier_sku), minOrderPacks: o.min_order_packs ? qtyToInput(o.min_order_packs) : '',
  orderMultiplePacks: o.order_multiple_packs ? qtyToInput(o.order_multiple_packs) : '', prepDays: str(o.offer_prep_days), leadTimeDays: str(o.lead_time_days),
  quotedAt: typeof o.quoted_at === 'string' ? o.quoted_at.slice(0, 10) : '', dropshipAllowed: o.dropship_allowed,
});

function PriceHistory({ offerId }: { offerId: string }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    api(`/admin/suppliers/offers/${offerId}/price-history?pageSize=50`).then(setData, () => setData({ items: [] }));
  }, [offerId]);
  if (!data) return <p className="text-xs text-ink-faint">Carregando…</p>;
  const SRC: Record<string, string> = { manual: 'manual', legacy_list: 'lista de custos', migration: 'implantação', invoice: 'nota', system: 'sistema' };
  return (
    <table className="w-full text-xs">
      <thead className="text-left text-ink-soft">
        <tr>
          <th className="py-1 font-medium">Quando</th>
          <th className="py-1 text-right font-medium">Antes</th>
          <th className="py-1 text-right font-medium">Depois</th>
          <th className="py-1 pl-3 font-medium">Cotação</th>
          <th className="py-1 font-medium">Quem / origem</th>
          <th className="py-1 font-medium">Justificativa</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {data.items.map((h: any) => {
          const diff = h.old_cost_cents ? ((Number(h.new_cost_cents) - Number(h.old_cost_cents)) / Number(h.old_cost_cents)) * 100 : null;
          return (
            <tr key={h.id}>
              <td className="py-1">{when(h.changed_at)}</td>
              <td className="num py-1 text-right">{money(h.old_cost_cents)}</td>
              <td className="num py-1 text-right">
                {money(h.new_cost_cents)}
                {diff !== null && <span className={diff > 0 ? 'text-bad' : 'text-good'}> ({diff > 0 ? '+' : ''}{diff.toFixed(1)} %)</span>}
              </td>
              <td className="py-1 pl-3">{h.quoted_at?.slice?.(0, 10) ?? '—'}</td>
              <td className="py-1">
                {h.changed_by_name ?? '—'} · {SRC[h.source] ?? h.source}
              </td>
              <td className="py-1">{h.reason ?? '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function OfferRow({ o, settings, editable, onChanged }: { o: any; settings: any; editable: boolean; onChanged: () => void }) {
  const [edit, setEdit] = useState<OfferEdit | null>(null);
  const [pending, setPending] = useState<null | 'end' | 'reactivate'>(null);
  const [reason, setReason] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  // Historico de custo exige suppliers.view (quem so tem purchases.view ve a oferta, como antes).
  const canHistory = useMe().can('suppliers.view');
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const call = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setEdit(null);
      setPending(null);
      setReason('');
      if (ok) setMsg({ tone: 'good', text: ok });
      onChanged();
    } catch (err) {
      setMsg(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    if (!edit) return;
    const cost = parseMoney(edit.cost);
    if (!cost) return setMsg({ tone: 'bad', text: 'Custo inválido.' });
    return call(() =>
      api(`/admin/suppliers/offers/${o.id}`, {
        method: 'PATCH',
        body: {
          costCents: cost, ...(edit.costReason.trim() ? { costReason: edit.costReason.trim() } : {}), supplierSku: edit.supplierSku,
          minOrderPacks: edit.minOrderPacks.trim() ? parseQty(edit.minOrderPacks) : null, orderMultiplePacks: edit.orderMultiplePacks.trim() ? parseQty(edit.orderMultiplePacks) : null,
          prepDays: intOrNull(edit.prepDays), leadTimeDays: intOrNull(edit.leadTimeDays), dropshipAllowed: edit.dropshipAllowed,
          ...(edit.quotedAt ? { quotedAt: edit.quotedAt } : {}), version: o.version,
        },
      }),
    );
  };
  const togglePrimary = () => {
    if (!o.is_primary && !window.confirm(`Tornar ${o.supplier_name} o fornecedor principal de ${o.sku}? Se houver outro principal, ele deixa de ser.`)) return;
    return call(() => api(`/admin/suppliers/offers/${o.id}/primary`, { method: 'POST', body: { primary: !o.is_primary, version: o.version } }));
  };
  const st = OFFER_STATUS[o.status]!;
  const ended = o.status === 'ended';
  const e = edit;
  const cell = 'py-2 pl-3 align-top';
  return (
    <>
      <tr className={ended ? 'text-ink-faint' : ''}>
        <td className="py-2 pl-4 align-top sm:pl-5">
          <span className="flex items-center gap-1 font-medium">
            {o.is_primary && <Star size={14} className="fill-current text-warn" aria-label="Fornecedor principal" />}
            {o.product_name}
          </span>
          <span className="block text-xs text-ink-faint">
            <span className="font-mono">{o.sku}</span> · {packLabel(o.packaging_label, o.base_qty, o.base_unit)}
          </span>
          <span className="mt-1 flex flex-wrap gap-1">
            <Badge tone={st.tone}>{st.label}</Badge>
            {o.stale_quote && <Badge tone="warn">Cotação antiga</Badge>}
            {(!o.packaging_active || !o.variant_active) && <Badge tone="warn">Inativo no catálogo</Badge>}
          </span>
        </td>
        <td className={cell}>
          {e ? (
            <div className="space-y-1">
              <Input aria-label="Custo (R$)" className="w-24" inputMode="decimal" value={e.cost} onChange={(ev) => setEdit({ ...e, cost: ev.target.value })} />
              <Input aria-label="Data da cotação" type="date" className="w-36" value={e.quotedAt} onChange={(ev) => setEdit({ ...e, quotedAt: ev.target.value })} />
              <Input aria-label="Justificativa da mudança de custo" placeholder="Justificativa (opcional)" className="w-44" maxLength={300} value={e.costReason} onChange={(ev) => setEdit({ ...e, costReason: ev.target.value })} />
            </div>
          ) : (
            <>
              <span className="num block">{money(o.cost_cents)}</span>
              <span className="num block text-xs text-ink-faint">
                {unitMoney(o.unit_cost_cents)}/{o.base_unit} · {o.quoted_at?.slice?.(0, 10)}
              </span>
            </>
          )}
        </td>
        <td className={cell}>{e ? <Input aria-label="Código no fornecedor" className="w-28" maxLength={60} value={e.supplierSku} onChange={(ev) => setEdit({ ...e, supplierSku: ev.target.value })} /> : <span className="font-mono text-xs">{o.supplier_sku ?? '—'}</span>}</td>
        <td className={cell}>
          {e ? (
            <div className="space-y-1">
              <Input aria-label="Mínimo (embalagens)" placeholder="mínimo" className="w-20" inputMode="decimal" value={e.minOrderPacks} onChange={(ev) => setEdit({ ...e, minOrderPacks: ev.target.value })} />
              <Input aria-label="Múltiplo (embalagens)" placeholder="múltiplo" className="w-20" inputMode="decimal" value={e.orderMultiplePacks} onChange={(ev) => setEdit({ ...e, orderMultiplePacks: ev.target.value })} />
            </div>
          ) : (
            <span className="text-xs">
              {o.min_order_packs ? `mín. ${qty(o.min_order_packs)}` : '—'}
              {o.order_multiple_packs && <span className="block">múlt. {qty(o.order_multiple_packs)}</span>}
            </span>
          )}
        </td>
        <td className={cell}>
          {e ? (
            <div className="space-y-1">
              <Input aria-label="Preparação do item (dias)" placeholder="preparo" className="w-20" inputMode="numeric" value={e.prepDays} onChange={(ev) => setEdit({ ...e, prepDays: ev.target.value })} />
              <Input aria-label="Prazo antigo (dias)" placeholder="prazo" className="w-20" inputMode="numeric" value={e.leadTimeDays} onChange={(ev) => setEdit({ ...e, leadTimeDays: ev.target.value })} />
            </div>
          ) : (
            <span className="num">{o.lead_days === null ? '—' : `${o.lead_days} d`}</span>
          )}
        </td>
        <td className={cell}>
          {e ? (
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={e.dropshipAllowed} onChange={(ev) => setEdit({ ...e, dropshipAllowed: ev.target.checked })} /> dropshipping (cadastro)
            </label>
          ) : (
            <AvailabilityBadge qtyValue={o.available_qty} validUntil={o.availability_valid_until} expired={o.availability_expired} unit={o.base_unit} warnDays={settings?.availability_warning_days} />
          )}
        </td>
        <td className="py-2 pr-4 pl-3 align-top sm:pr-5">
          <div className="flex flex-wrap justify-end gap-1">
            {e ? (
              <>
                <Button variant="primary" busy={busy} onClick={save}>
                  Salvar
                </Button>
                <Button variant="ghost" onClick={() => setEdit(null)}>
                  Cancelar
                </Button>
              </>
            ) : (
              <>
                {editable && !ended && (
                  <Button variant="ghost" aria-label="Editar oferta" onClick={() => setEdit(toEdit(o))}>
                    <Pencil size={15} />
                  </Button>
                )}
                {editable && o.status === 'active' && o.supplier_status === 'active' && (
                  <Button variant="ghost" busy={busy} onClick={togglePrimary} title={o.is_primary ? 'Deixar de ser principal' : 'Tornar principal'}>
                    <Star size={15} className={o.is_primary ? 'fill-current text-warn' : ''} />
                  </Button>
                )}
                {editable && !ended && (
                  <Button variant="ghost" busy={busy} onClick={() => call(() => api(`/admin/suppliers/offers/${o.id}`, { method: 'PATCH', body: { status: o.status === 'active' ? 'paused' : 'active', version: o.version } }))}>
                    {o.status === 'active' ? 'Pausar' : 'Ativar'}
                  </Button>
                )}
                {editable && !ended && (
                  <Button variant="ghost" onClick={() => setPending('end')}>
                    Encerrar
                  </Button>
                )}
                {editable && ended && <Button onClick={() => setPending('reactivate')}>Reativar</Button>}
                {canHistory && (
                  <Button variant="ghost" onClick={() => setShowHistory(!showHistory)}>
                    {showHistory ? 'Fechar histórico' : 'Histórico de custo'}
                  </Button>
                )}
              </>
            )}
          </div>
        </td>
      </tr>
      {(pending || msg || showHistory) && (
        <tr>
          <td colSpan={7} className="px-4 pb-3 sm:px-5">
            {pending && (
              <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-line bg-sunken/50 p-2">
                <span className="text-sm">{pending === 'end' ? 'Encerrar a oferta (sai da sugestão e do custo padrão; nada é apagado).' : 'Reativar a oferta encerrada.'}</span>
                <Input aria-label="Motivo" placeholder="Motivo (obrigatório)" className="max-w-xs" maxLength={300} value={reason} onChange={(ev) => setReason(ev.target.value)} />
                <Button
                  variant="primary"
                  busy={busy}
                  disabled={reason.trim().length < 3}
                  onClick={() => call(() => api(`/admin/suppliers/offers/${o.id}/${pending}`, { method: 'POST', body: { reason: reason.trim(), version: o.version } }))}
                >
                  Confirmar
                </Button>
                <Button variant="ghost" onClick={() => setPending(null)}>
                  Cancelar
                </Button>
              </div>
            )}
            <MsgBox msg={msg} onReload={onChanged} />
            {showHistory && <PriceHistory offerId={o.id} />}
          </td>
        </tr>
      )}
    </>
  );
}

function NewOffer({ supplierId, hit, onDone }: { supplierId: string; hit: PackagingHit; onDone: (saved: boolean) => void }) {
  const [f, setF] = useState({ cost: '', supplierSku: '', minOrderPacks: '', orderMultiplePacks: '', prepDays: '', leadTimeDays: '' });
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const cost = parseMoney(f.cost);
    if (!cost) return setMsg({ tone: 'bad', text: 'Informe o custo da embalagem.' });
    setBusy(true);
    try {
      await api(`/admin/suppliers/${supplierId}/offers/item`, {
        method: 'POST',
        body: {
          packagingId: hit.id, costCents: cost, supplierSku: f.supplierSku, minOrderPacks: f.minOrderPacks.trim() ? parseQty(f.minOrderPacks) : null,
          orderMultiplePacks: f.orderMultiplePacks.trim() ? parseQty(f.orderMultiplePacks) : null, prepDays: intOrNull(f.prepDays), leadTimeDays: intOrNull(f.leadTimeDays),
        },
      });
      onDone(true);
    } catch (err) {
      setMsg(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  const inp = (k: keyof typeof f, label: string, props: Record<string, unknown> = {}) => <Field label={label}>{(id) => <Input id={id} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} />}</Field>;
  return (
    <form onSubmit={save} className="mb-4 space-y-3 rounded-md border border-line bg-sunken/40 p-3">
      <p className="text-sm font-medium">
        {hit.product_name} · <span className="font-mono">{hit.sku}</span> · {packLabel(hit.label, hit.base_qty, hit.base_unit)}
        {hit.kind === 'sale' && <span className="ml-2 text-xs text-warn">(embalagem de venda)</span>}
      </p>
      <div className="grid gap-3 sm:grid-cols-6">
        {inp('cost', 'Custo (R$)', { inputMode: 'decimal', required: true })}
        {inp('supplierSku', 'Código no fornecedor', { maxLength: 60 })}
        {inp('minOrderPacks', 'Mínimo (emb.)', { inputMode: 'decimal' })}
        {inp('orderMultiplePacks', 'Múltiplo (emb.)', { inputMode: 'decimal' })}
        {inp('prepDays', 'Preparo (dias)', { inputMode: 'numeric' })}
        {inp('leadTimeDays', 'Prazo antigo (dias)', { inputMode: 'numeric' })}
      </div>
      <MsgBox msg={msg} />
      <div className="flex gap-2">
        <Button variant="primary" busy={busy}>
          Incluir oferta
        </Button>
        <Button type="button" variant="ghost" onClick={() => onDone(false)}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function OffersTab({ s }: { s: any }) {
  const { can } = useMe();
  const editable = can('suppliers.manage') && !s.archived_at;
  const [status, setStatus] = useState('current');
  const [data, setData] = useState<{ items: any[]; settings: any } | null>(null);
  const [adding, setAdding] = useState<PackagingHit | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api(`/admin/suppliers/${s.id}/offers?status=${status}`).then(setData, (e) => setError(e.message));
  }, [s.id, status]);
  useEffect(load, [load]);
  return (
    <Panel
      title="Produtos e embalagens"
      description="Uma oferta por embalagem. Custo sem frete; o custo por unidade base compara pacotes e fornecedores. Cada linha é salva sozinha."
      actions={
        <Select aria-label="Situação das ofertas" className="w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="current">Ativas e pausadas</option>
          <option value="active">Ativas</option>
          <option value="paused">Pausadas</option>
          <option value="ended">Encerradas</option>
          <option value="all">Todas</option>
        </Select>
      }
    >
      {editable && !adding && (
        <div className="mb-3">
          <PackagingPicker placeholder="Adicionar item: nome, SKU ou código de barras" onPick={setAdding} />
        </div>
      )}
      {adding && (
        <NewOffer
          supplierId={s.id}
          hit={adding}
          onDone={(saved) => {
            setAdding(null);
            if (saved) load();
          }}
        />
      )}
      {error && <Notice tone="bad">{error}</Notice>}
      {data &&
        (data.items.length === 0 ? (
          <Empty title="Nenhuma oferta nesta situação." />
        ) : (
          <div className="-mx-4 overflow-x-auto sm:-mx-5">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="text-left text-xs text-ink-soft">
                <tr className="border-b border-line">
                  <th className="py-2 pl-4 font-medium sm:pl-5">Produto / embalagem</th>
                  <th className="py-2 pl-3 font-medium">Custo</th>
                  <th className="py-2 pl-3 font-medium">Código</th>
                  <th className="py-2 pl-3 font-medium">Mínimo</th>
                  <th className="py-2 pl-3 font-medium">Prazo</th>
                  <th className="py-2 pl-3 font-medium">Disponível (fornecedor)</th>
                  <th className="py-2 pr-4 pl-3 text-right font-medium sm:pr-5">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.items.map((o) => (
                  <OfferRow key={`${o.id}-${o.version}`} o={o} settings={data.settings} editable={editable} onChanged={load} />
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </Panel>
  );
}

// ------------------------------------------------------------------ disponibilidade
function AvailabilityTab({ s }: { s: any }) {
  const { can } = useMe();
  const editable = can('suppliers.manage') && !s.archived_at;
  const [data, setData] = useState<any>(null);
  const [page, setPage] = useState(1);
  const variants = [...new Map(s.offers.filter((o: any) => o.status !== 'ended').map((o: any) => [o.variant_id, o])).values()] as any[];
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const [f, setF] = useState({ variantId: '', qty: '', validUntil: tomorrow, source: 'whatsapp', note: '' });
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api(`/admin/suppliers/${s.id}/availability?page=${page}&pageSize=20`).then(setData, (e) => setMsg({ tone: 'bad', text: e.message }));
  }, [s.id, page]);
  useEffect(load, [load]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api(`/admin/suppliers/${s.id}/availability`, {
        method: 'POST',
        body: { variantId: f.variantId, availableQty: parseQty(f.qty), validUntil: new Date(`${f.validUntil}T23:59:59-03:00`).toISOString(), source: f.source, note: nul(f.note) },
      });
      setF({ ...f, qty: '', note: '' });
      setMsg({ tone: 'good', text: 'Disponibilidade registrada.' });
      load();
    } catch (err) {
      setMsg(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-5">
      <Notice tone="neutral">Quantidade informada pelo fornecedor, em unidade base. Não entra no estoque da loja, na vitrine nem nos marketplaces. Vencida vale como &quot;sem informação&quot;.</Notice>
      {editable && (
        <Panel title="Informar disponibilidade">
          {variants.length === 0 ? (
            <p className="text-sm text-ink-soft">Cadastre uma oferta antes de informar a disponibilidade.</p>
          ) : (
            <form onSubmit={save} className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_1fr] sm:items-end">
              <Field label="Variante">
                {(id) => (
                  <Select id={id} required value={f.variantId} onChange={(e) => setF({ ...f, variantId: e.target.value })}>
                    <option value="">Escolha…</option>
                    {variants.map((v) => (
                      <option key={v.variant_id} value={v.variant_id}>
                        {v.product_name} · {v.sku}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Quantidade disponível">{(id) => <Input id={id} required inputMode="decimal" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} />}</Field>
              <Field label="Válida até">{(id) => <Input id={id} required type="date" min={new Date().toISOString().slice(0, 10)} value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} />}</Field>
              <Field label="Origem">
                {(id) => (
                  <Select id={id} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
                    {['whatsapp', 'email', 'phone', 'manual'].map((k) => (
                      <option key={k} value={k}>
                        {AVAILABILITY_SOURCE[k]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <div className="sm:col-span-3">
                <Field label="Observação">{(id) => <Input id={id} maxLength={300} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}</Field>
              </div>
              <Button variant="primary" busy={busy}>
                Registrar
              </Button>
            </form>
          )}
          <div className="mt-3">
            <MsgBox msg={msg} />
          </div>
        </Panel>
      )}
      {data && (
        <>
          <Panel title="Vigente por variante">
            {data.current.length === 0 ? (
              <p className="text-sm text-ink-soft">Nenhuma disponibilidade informada.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody className="divide-y divide-line">
                  {data.current.map((a: any) => (
                    <tr key={a.variant_id}>
                      <td className="py-2">
                        {a.product_name} <span className="font-mono text-xs text-ink-faint">{a.sku}</span>
                      </td>
                      <td className="py-2">
                        <AvailabilityBadge qtyValue={a.available_qty} validUntil={a.valid_until} expired={a.expired} unit={a.base_unit} />
                      </td>
                      <td className="py-2 text-xs text-ink-soft">
                        confirmada {when(a.confirmed_at)} · {AVAILABILITY_SOURCE[a.source] ?? a.source}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
          <Panel title="Registros (só inclusão)">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-line">
                {data.history.map((h: any) => (
                  <tr key={h.id}>
                    <td className="py-1.5">{when(h.created_at)}</td>
                    <td className="py-1.5 font-mono">{h.sku}</td>
                    <td className="num py-1.5 text-right">{qty(h.available_qty)}</td>
                    <td className="py-1.5 pl-3">até {when(h.valid_until)}</td>
                    <td className="py-1.5">
                      {AVAILABILITY_SOURCE[h.source] ?? h.source} · {h.created_by_name ?? '—'}
                    </td>
                    <td className="py-1.5">{h.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager page={page} total={data.total} size={20} onPage={setPage} />
          </Panel>
        </>
      )}
    </div>
  );
}

function Pager({ page, total, size, onPage }: { page: number; total: number; size: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return null;
  return (
    <div className="mt-2 flex items-center justify-end gap-2 text-sm text-ink-soft">
      <span>
        Página {page} de {pages}
      </span>
      <Button variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ‹
      </Button>
      <Button variant="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        ›
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ historico
const ACTION_TEXT: Record<string, string> = {
  'suppliers.created': 'Cadastrou o fornecedor',
  'suppliers.updated': 'Alterou o cadastro',
  'suppliers.offers_updated': 'Alterou a lista de custos',
  'suppliers.status_changed': 'Mudou a situação',
  'suppliers.archived': 'Arquivou',
  'suppliers.restored': 'Restaurou',
  'suppliers.offer_created': 'Incluiu oferta',
  'suppliers.offer_updated': 'Alterou oferta',
  'suppliers.offer_ended': 'Encerrou oferta',
  'suppliers.offer_reactivated': 'Reativou oferta',
  'suppliers.primary_changed': 'Trocou o fornecedor principal',
};
function HistoryTab({ s }: { s: any }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    api(`/admin/suppliers/${s.id}/history?page=${page}&pageSize=30`).then(setData, () => setData({ items: [], total: 0 }));
  }, [s.id, page]);
  if (!data) return <p className="text-sm text-ink-faint">Carregando…</p>;
  const describe = (h: any) => {
    if (h.kind === 'cost') return `Custo de ${h.details.sku}: ${h.details.old === null ? 'inicial' : money(h.details.old)} → ${money(h.details.new)}${h.details.reason ? ` (${h.details.reason})` : ''}`;
    if (h.kind === 'availability') return `Disponibilidade de ${h.details.sku}: ${qty(h.details.qty)} até ${when(h.details.validUntil)} (${AVAILABILITY_SOURCE[h.what] ?? h.what})`;
    const m = h.details.metadata ?? {};
    return `${ACTION_TEXT[h.what] ?? h.what}${m.reason ? `: ${m.reason}` : ''}`;
  };
  return (
    <Panel title="Linha do tempo">
      {data.items.length === 0 ? (
        <p className="text-sm text-ink-soft">Sem registros.</p>
      ) : (
        <ol className="space-y-2 text-sm">
          {data.items.map((h: any, i: number) => (
            <li key={i} className="flex gap-3 border-b border-line pb-2 last:border-0">
              <span className="w-32 shrink-0 text-xs text-ink-faint">{when(h.at)}</span>
              <span className="min-w-0">
                <Badge tone={h.kind === 'cost' ? 'act' : h.kind === 'availability' ? 'good' : 'neutral'}>{h.kind === 'cost' ? 'Custo' : h.kind === 'availability' ? 'Disponibilidade' : 'Cadastro'}</Badge> {describe(h)}
                <span className="block text-xs text-ink-faint">{h.actor ?? 'sistema'}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      <Pager page={page} total={data.total} size={30} onPage={setPage} />
    </Panel>
  );
}

// ------------------------------------------------------------------ pagina
function SupplierPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'novo';
  const { can } = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const fullAccess = can('suppliers.view');
  const tab = (sp.get('aba') ?? (fullAccess ? 'visao' : 'cadastro')) as (typeof TABS)[number][0];
  const [s, setS] = useState<any>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const load = useCallback(() => {
    if (!isNew) api(`/admin/suppliers/${id}`).then((r) => setS(r.supplier), (e) => setError(e.message));
  }, [id, isNew]);
  useEffect(load, [load]);

  if (isNew)
    return (
      <>
        <PageHeader title="Novo fornecedor" />
        <SupplierForm supplier={null} onSaved={() => undefined} onReload={() => undefined} />
      </>
    );
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!s) return <p className="text-sm text-ink-faint">Carregando…</p>;
  // Quem so tem purchases.view ve cadastro e ofertas (como antes); as demais abas exigem suppliers.view.
  const tabs = TABS.filter(([k]) => fullAccess || k === 'cadastro' || k === 'produtos');

  return (
    <>
      <PageHeader
        title={s.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <SupplierBadge status={s.status} archivedAt={s.archived_at} blockedReason={s.blocked_reason} />
            {s.archived_at && <span>Arquivado em {when(s.archived_at)}: {s.archive_reason}</span>}
            {s.document && <span>{formatCnpj(s.document)}</span>}
          </span>
        }
        actions={
          can('purchases.manage') &&
          s.status === 'active' &&
          !s.archived_at && (
            <Link href={`/painel/compras/novo?fornecedor=${s.id}`}>
              <Button>Novo pedido de compra</Button>
            </Link>
          )
        }
      />
      {can('suppliers.manage') && (
        <div className="mb-4">
          <StatusActions
            s={s}
            onChanged={(next, n) => {
              setNote(n ?? '');
              load();
              void next;
            }}
          />
        </div>
      )}
      {note && (
        <div className="mb-4">
          <Notice tone="warn">{note}</Notice>
        </div>
      )}
      <nav className="mb-5 flex gap-1 overflow-x-auto border-b border-line" aria-label="Seções do fornecedor">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => router.replace(`${pathname}?aba=${k}`)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap ${tab === k ? 'border-act font-medium text-ink' : 'border-transparent text-ink-soft hover:text-ink'}`}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === 'visao' && fullAccess && <Overview s={s} />}
      {tab === 'cadastro' && <SupplierForm supplier={s} onSaved={setS} onReload={load} />}
      {tab === 'produtos' && <OffersTab s={s} />}
      {tab === 'disponibilidade' && fullAccess && <AvailabilityTab s={s} />}
      {tab === 'historico' && fullAccess && <HistoryTab s={s} />}
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="suppliers.view|purchases.view">
      <Suspense fallback={<p className="text-sm text-ink-faint">Carregando…</p>}>
        <SupplierPage />
      </Suspense>
    </Guard>
  );
}
