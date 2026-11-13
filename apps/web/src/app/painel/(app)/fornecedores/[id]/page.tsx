'use client';

import { Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Guard, useMe } from '@/components/shell';
import { packLabel, PackagingPicker } from '@/components/stock';
import { Button, Field, Input, Notice, PageHeader, Panel, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { centsToInput, parseMoney, unitMoney } from '@/lib/format';

const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

type Contact = { name: string; role: string; email: string; phone: string };
type Offer = { packagingId: string; label: string; productName: string; sku: string; baseQty: string; baseUnit: string; cost: string; supplierSku: string; leadTimeDays: string; active: boolean };
type Form = {
  name: string;
  legalName: string;
  document: string;
  stateRegistration: string;
  email: string;
  phone: string;
  whatsapp: string;
  website: string;
  city: string;
  uf: string;
  paymentTerms: string;
  leadTimeDays: string;
  minOrder: string;
  freightTerms: string;
  notes: string;
  active: boolean;
  contacts: Contact[];
};

const empty: Form = { name: '', legalName: '', document: '', stateRegistration: '', email: '', phone: '', whatsapp: '', website: '', city: '', uf: 'SC', paymentTerms: '', leadTimeDays: '', minOrder: '', freightTerms: '', notes: '', active: true, contacts: [] };
const nul = (v: string) => (v.trim() ? v.trim() : null);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toForm(s: any): Form {
  return {
    name: s.name,
    legalName: s.legal_name ?? '',
    document: s.document ?? '',
    stateRegistration: s.state_registration ?? '',
    email: s.email ?? '',
    phone: s.phone ?? '',
    whatsapp: s.whatsapp ?? '',
    website: s.website ?? '',
    city: s.city ?? '',
    uf: s.uf ?? '',
    paymentTerms: s.payment_terms ?? '',
    leadTimeDays: s.lead_time_days?.toString() ?? '',
    minOrder: centsToInput(s.min_order_cents),
    freightTerms: s.freight_terms ?? '',
    notes: s.notes ?? '',
    active: s.active,
    contacts: s.contacts.map((c: Record<string, string | null>) => ({ name: c.name ?? '', role: c.role ?? '', email: c.email ?? '', phone: c.phone ?? '' })),
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toOffers = (s: any): Offer[] => // eslint-disable-line @typescript-eslint/no-explicit-any
  s.offers.map((o: any) => ({
    packagingId: o.packaging_id,
    label: o.packaging_label,
    productName: o.product_name,
    sku: o.sku,
    baseQty: o.base_qty,
    baseUnit: o.base_unit,
    cost: centsToInput(o.cost_cents),
    supplierSku: o.supplier_sku ?? '',
    leadTimeDays: o.lead_time_days?.toString() ?? '',
    active: o.active,
  }));

function SupplierEditor() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'novo';
  const router = useRouter();
  const { can } = useMe();
  const editable = can('purchases.manage');
  const [form, setForm] = useState<Form | null>(isNew ? empty : null);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [offerMsg, setOfferMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    if (isNew) return;
    api(`/admin/suppliers/${id}`).then(
      (r) => {
        setForm(toForm(r.supplier));
        setOffers(toOffers(r.supplier));
      },
      (e) => setMsg({ tone: 'bad', text: e.message }),
    );
  }, [id, isNew]);

  if (!form) return msg ? <Notice tone="bad">{msg.text}</Notice> : <p className="text-sm text-ink-faint">Carregando…</p>;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const minOrder = form.minOrder.trim() ? parseMoney(form.minOrder) : null;
    const body = {
      name: form.name,
      legalName: nul(form.legalName),
      document: nul(form.document),
      stateRegistration: nul(form.stateRegistration),
      email: nul(form.email),
      phone: nul(form.phone),
      whatsapp: nul(form.whatsapp),
      website: nul(form.website),
      city: nul(form.city),
      uf: nul(form.uf),
      paymentTerms: nul(form.paymentTerms),
      leadTimeDays: form.leadTimeDays.trim() ? Number(form.leadTimeDays) : null,
      minOrderCents: minOrder,
      freightTerms: nul(form.freightTerms),
      notes: nul(form.notes),
      active: form.active,
      contacts: form.contacts.filter((c) => c.name.trim()).map((c) => ({ name: c.name, role: nul(c.role), email: nul(c.email), phone: nul(c.phone) })),
    };
    try {
      const r = await api(isNew ? '/admin/suppliers' : `/admin/suppliers/${id}`, { method: isNew ? 'POST' : 'PUT', body });
      if (isNew) router.replace(`/painel/fornecedores/${r.supplier.id}`);
      else {
        setForm(toForm(r.supplier));
        setMsg({ tone: 'good', text: 'Fornecedor salvo.' });
      }
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const saveOffers = async () => {
    setOfferMsg(null);
    const body = [];
    for (const o of offers) {
      const cost = parseMoney(o.cost);
      if (!cost) return setOfferMsg({ tone: 'bad', text: `Informe o custo de ${o.productName} — ${o.label}.` });
      body.push({ packagingId: o.packagingId, costCents: cost, supplierSku: nul(o.supplierSku), leadTimeDays: o.leadTimeDays.trim() ? Number(o.leadTimeDays) : null, active: o.active });
    }
    try {
      const r = await api(`/admin/suppliers/${id}/offers`, { method: 'PUT', body });
      setOffers(toOffers(r.supplier));
      setOfferMsg({ tone: 'good', text: 'Lista de custos salva.' });
    } catch (err) {
      setOfferMsg({ tone: 'bad', text: (err as Error).message });
    }
  };
  const setOffer = (i: number, patch: Partial<Offer>) => setOffers(offers.map((o, j) => (j === i ? { ...o, ...patch } : o)));

  const text = (k: keyof Form, label: string, props: Record<string, unknown> = {}) => (
    <Field label={label} required={k === 'name'}>
      {(fid) => <Input id={fid} value={form[k] as string} onChange={(e) => set(k, e.target.value as never)} disabled={!editable} {...props} />}
    </Field>
  );

  return (
    <>
      <PageHeader
        title={isNew ? 'Novo fornecedor' : form.name}
        actions={
          !isNew &&
          can('purchases.manage') && (
            <Link href={`/painel/compras/novo?fornecedor=${id}`}>
              <Button>Novo pedido de compra</Button>
            </Link>
          )
        }
      />
      <div className="space-y-5">
        <Panel title="Cadastro">
          <form onSubmit={save} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {text('name', 'Nome de uso', { required: true, maxLength: 120 })}
              {text('legalName', 'Razão social', { maxLength: 150 })}
              {text('document', 'CNPJ ou CPF')}
              {text('stateRegistration', 'Inscrição estadual')}
              {text('email', 'E-mail', { type: 'email' })}
              {text('phone', 'Telefone', { inputMode: 'tel' })}
              {text('whatsapp', 'WhatsApp (com 55 e DDD)', { inputMode: 'tel', placeholder: '5547999990000' })}
              {text('website', 'Site', { type: 'url', placeholder: 'https://' })}
              {text('city', 'Cidade')}
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
            <div className="grid gap-3 sm:grid-cols-3">
              {text('leadTimeDays', 'Prazo de entrega (dias)', { inputMode: 'numeric' })}
              {text('minOrder', 'Pedido mínimo (R$)', { inputMode: 'decimal' })}
              {text('paymentTerms', 'Condição de pagamento', { placeholder: 'Ex.: 28 dias boleto' })}
            </div>
            {text('freightTerms', 'Frete', { placeholder: 'Ex.: CIF acima de R$ 1.500, FOB abaixo' })}
            <Field label="Observações">{(fid) => <Textarea id={fid} value={form.notes} onChange={(e) => set('notes', e.target.value)} disabled={!editable} maxLength={2000} />}</Field>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Contatos</legend>
              {form.contacts.map((c, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
                  {(['name', 'role', 'email', 'phone'] as const).map((k) => (
                    <Input
                      key={k}
                      aria-label={{ name: 'Nome', role: 'Função', email: 'E-mail', phone: 'Telefone' }[k]}
                      placeholder={{ name: 'Nome', role: 'Função', email: 'E-mail', phone: 'Telefone' }[k]}
                      value={c[k]}
                      disabled={!editable}
                      onChange={(e) => set('contacts', form.contacts.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))}
                    />
                  ))}
                  {editable && (
                    <Button type="button" variant="ghost" aria-label="Remover contato" onClick={() => set('contacts', form.contacts.filter((_, j) => j !== i))}>
                      <Trash2 size={16} />
                    </Button>
                  )}
                </div>
              ))}
              {editable && form.contacts.length < 10 && (
                <Button type="button" variant="ghost" onClick={() => set('contacts', [...form.contacts, { name: '', role: '', email: '', phone: '' }])}>
                  Adicionar contato
                </Button>
              )}
            </fieldset>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} disabled={!editable} /> Fornecedor ativo
            </label>
            {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
            {editable && (
              <Button variant="primary" busy={busy}>
                {isNew ? 'Cadastrar' : 'Salvar'}
              </Button>
            )}
          </form>
        </Panel>

        {!isNew && (
          <Panel title="Custos por embalagem" description="Custo da embalagem de compra sem frete. O custo por unidade base permite comparar pacotes e fornecedores diferentes.">
            {editable && (
              <div className="mb-3">
                <PackagingPicker
                  onPick={(h) => {
                    if (offers.some((o) => o.packagingId === h.id)) return;
                    setOffers([...offers, { packagingId: h.id, label: h.label, productName: h.product_name, sku: h.sku, baseQty: h.base_qty, baseUnit: h.base_unit, cost: '', supplierSku: '', leadTimeDays: '', active: true }]);
                  }}
                />
              </div>
            )}
            {offers.length === 0 ? (
              <p className="text-sm text-ink-soft">Nenhum item na lista deste fornecedor.</p>
            ) : (
              <div className="-mx-4 overflow-x-auto sm:-mx-5">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="text-left text-xs text-ink-soft">
                    <tr className="border-b border-line">
                      <th className="py-2 pl-4 font-medium sm:pl-5">Produto / embalagem</th>
                      <th className="py-2 pl-3 font-medium">Custo (R$)</th>
                      <th className="py-2 pl-3 text-right font-medium">Por unidade</th>
                      <th className="py-2 pl-3 font-medium">Cód. fornecedor</th>
                      <th className="py-2 pl-3 font-medium">Prazo</th>
                      <th className="py-2 pr-4 pl-3 font-medium sm:pr-5">Ativo</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {offers.map((o, i) => {
                      const cents = parseMoney(o.cost);
                      return (
                        <tr key={o.packagingId} className={o.active ? '' : 'text-ink-faint'}>
                          <td className="py-2 pl-4 sm:pl-5">
                            <span className="block font-medium">{o.productName}</span>
                            <span className="block text-xs text-ink-faint">
                              <span className="font-mono">{o.sku}</span> · {packLabel(o.label, o.baseQty, o.baseUnit)}
                            </span>
                          </td>
                          <td className="py-2 pl-3">
                            <Input aria-label="Custo" className="w-24" inputMode="decimal" value={o.cost} disabled={!editable} onChange={(e) => setOffer(i, { cost: e.target.value })} />
                          </td>
                          <td className="num py-2 pl-3 text-right">{cents ? `${unitMoney(cents / Number(o.baseQty))}/${o.baseUnit}` : '—'}</td>
                          <td className="py-2 pl-3">
                            <Input aria-label="Código no fornecedor" className="w-28" value={o.supplierSku} disabled={!editable} onChange={(e) => setOffer(i, { supplierSku: e.target.value })} />
                          </td>
                          <td className="py-2 pl-3">
                            <Input aria-label="Prazo em dias" className="w-16" inputMode="numeric" placeholder="dias" value={o.leadTimeDays} disabled={!editable} onChange={(e) => setOffer(i, { leadTimeDays: e.target.value })} />
                          </td>
                          <td className="py-2 pr-4 pl-3 sm:pr-5">
                            <input type="checkbox" aria-label="Ativo" checked={o.active} disabled={!editable} onChange={(e) => setOffer(i, { active: e.target.checked })} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {offerMsg && (
              <div className="mt-3">
                <Notice tone={offerMsg.tone}>{offerMsg.text}</Notice>
              </div>
            )}
            {editable && offers.length > 0 && (
              <Button className="mt-3" variant="primary" onClick={saveOffers}>
                Salvar lista de custos
              </Button>
            )}
          </Panel>
        )}
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="purchases.view">
      <SupplierEditor />
    </Guard>
  );
}
