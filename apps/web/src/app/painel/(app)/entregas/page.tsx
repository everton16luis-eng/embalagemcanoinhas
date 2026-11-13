'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Empty, Field, Input, Notice, PageHeader, Panel, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { centsToInput, money, parseMoney } from '@/lib/format';

type Option = {
  id: string;
  name: string;
  kind: 'pickup' | 'delivery' | 'carrier';
  description: string | null;
  cep_ranges: string[];
  base_cents: string;
  per_kg_cents: string;
  free_above_cents: string | null;
  max_weight_g: number | null;
  min_days: number;
  max_days: number;
  active: boolean;
  position: number;
  carrier_service: string | null;
  handling_days: number;
};
type CarrierInfo = {
  configured: boolean;
  fake: boolean;
  originCep: string | null;
};
type Form = {
  id?: string;
  name: string;
  kind: 'pickup' | 'delivery' | 'carrier';
  service: string;
  handling: string;
  description: string;
  ranges: string;
  base: string;
  perKg: string;
  freeAbove: string;
  maxKg: string;
  minDays: string;
  maxDays: string;
  active: boolean;
  position: string;
};

function rangeText(r: string) {
  const cep = (v: string) => v.replace(/(\d{5})(\d{3})/, '$1-$2');
  const [a, b] = r.split('-');
  return b ? `${cep(a!)} a ${cep(b)}` : cep(a!);
}
const blank: Form = {
  name: '',
  kind: 'delivery',
  service: '',
  handling: '0',
  description: '',
  ranges: '',
  base: '',
  perKg: '',
  freeAbove: '',
  maxKg: '',
  minDays: '1',
  maxDays: '3',
  active: true,
  position: '0',
};
const toForm = (o: Option): Form => ({
  id: o.id,
  name: o.name,
  kind: o.kind,
  service: o.carrier_service ?? '',
  handling: String(o.handling_days ?? 0),
  description: o.description ?? '',
  ranges: o.cep_ranges.map(rangeText).join('\n'),
  base: centsToInput(o.base_cents),
  perKg: Number(o.per_kg_cents) ? centsToInput(o.per_kg_cents) : '',
  freeAbove: o.free_above_cents ? centsToInput(o.free_above_cents) : '',
  maxKg: o.max_weight_g ? String(o.max_weight_g / 1000).replace('.', ',') : '',
  minDays: String(o.min_days),
  maxDays: String(o.max_days),
  active: o.active,
  position: String(o.position),
});

function ShippingOptions() {
  const { can, me } = useMe();
  const edit = can('settings.manage') && me.user.mfaEnabled;
  const [list, setList] = useState<Option[] | null>(null);
  const [carrier, setCarrier] = useState<CarrierInfo | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<{ options: Option[]; carrier: CarrierInfo }>('/admin/shipping-options').then(
      (r) => {
        setList(r.options);
        setCarrier(r.carrier);
      },
      (e) => setError(e.message),
    );
  useEffect(() => {
    load();
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setError('');
    try {
      const body = {
        name: form.name,
        kind: form.kind,
        description: form.description || null,
        // Cada linha: "89460-000 a 89479-999" ou um CEP so.
        // O servidor conta os digitos: 16 = faixa, 8 = CEP unico.
        carrierService: form.kind === 'carrier' ? form.service.trim() : null,
        handlingDays: form.kind === 'carrier' ? Number(form.handling) || 0 : 0,
        cepRanges:
          form.kind !== 'delivery'
            ? []
            : form.ranges
                .split(/\n|;/)
                .map((l) => l.trim())
                .filter(Boolean),
        baseCents: parseMoney(form.base) ?? 0,
        perKgCents: parseMoney(form.perKg) ?? 0,
        freeAboveCents: parseMoney(form.freeAbove),
        maxWeightG: form.maxKg ? Math.round(Number(form.maxKg.replace(',', '.')) * 1000) : null,
        minDays: Number(form.minDays),
        maxDays: Number(form.maxDays),
        active: form.active,
        position: Number(form.position) || 0,
      };
      await api(form.id ? `/admin/shipping-options/${form.id}` : '/admin/shipping-options', { method: form.id ? 'PUT' : 'POST', body });
      setForm(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  return (
    <>
      <PageHeader
        title="Formas de entrega"
        description="Retirada na loja, entregas próprias por faixa de CEP e transportadoras com cotação automática. O frete é calculado no carrinho com estas regras."
        actions={
          edit &&
          !form && (
            <Button variant="primary" onClick={() => setForm(blank)}>
              Nova forma de entrega
            </Button>
          )
        }
      />
      {!edit && (
        <div className="mb-4">
          <Notice>Alterar fretes exige a permissão de configurações e a verificação em duas etapas.</Notice>
        </div>
      )}
      {error && (
        <div className="mb-4">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
      {form && (
        <Panel title={form.id ? 'Editar forma de entrega' : 'Nova forma de entrega'} className="mb-4">
          <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
            <Field label="Nome" required>
              {(id) => <Input id={id} required value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Entrega em Canoinhas" />}
            </Field>
            <Field label="Tipo">
              {(id) => (
                <Select id={id} value={form.kind} onChange={(e) => set('kind', e.target.value as Form['kind'])}>
                  <option value="delivery">Entrega própria (faixa de CEP)</option>
                  <option value="carrier">Transportadora (cotação automática)</option>
                  <option value="pickup">Retirada na loja</option>
                </Select>
              )}
            </Field>
            <Field label="Descrição para o cliente" className="sm:col-span-2" hint={form.kind === 'pickup' ? 'Endereço e horário de retirada.' : 'Ex.: entregamos de segunda a sexta à tarde.'}>
              {(id) => <Input id={id} maxLength={300} value={form.description} onChange={(e) => set('description', e.target.value)} />}
            </Field>
            {form.kind === 'carrier' && (
              <>
                <div className="sm:col-span-2">
                  <Notice tone={carrier?.configured && carrier.originCep ? 'neutral' : 'warn'}>
                    {carrier?.configured
                      ? `Preço e prazo vêm da cotação do provedor${carrier.fake ? ' (simulado)' : ''}, com o CEP do cliente e peso e medidas dos produtos. Produto sem peso ou medidas não recebe esta opção. ${carrier.originCep ? `Origem: CEP ${carrier.originCep}.` : 'Falta o CEP de origem: cadastre o endereço em Empresa e fiscal, senão esta forma não aparece na loja.'}`
                      : 'Provedor de cotação não configurado no servidor: esta forma não aparece na loja até lá.'}
                  </Notice>
                </div>
                <Field label="Código do serviço no provedor" required hint="Número do serviço na lista do provedor de cotação.">
                  {(id) => <Input id={id} required inputMode="numeric" value={form.service} onChange={(e) => set('service', e.target.value.replace(/\D/g, ''))} />}
                </Field>
                <Field label="Dias de separação" hint="Somados ao prazo da transportadora.">
                  {(id) => <Input id={id} inputMode="numeric" value={form.handling} onChange={(e) => set('handling', e.target.value.replace(/\D/g, ''))} />}
                </Field>
              </>
            )}
            {form.kind === 'delivery' && (
              <Field label="Faixas de CEP atendidas" required className="sm:col-span-2" hint="Uma por linha: 89460-000 a 89479-999, ou um CEP só.">
                {(id) => <Textarea id={id} required value={form.ranges} onChange={(e) => set('ranges', e.target.value)} />}
              </Field>
            )}
            <Field label={form.kind === 'carrier' ? 'Taxa de manuseio (R$)' : 'Valor fixo (R$)'}>
              {(id) => <Input id={id} inputMode="decimal" className="num" value={form.base} onChange={(e) => set('base', e.target.value)} placeholder="0,00" />}
            </Field>
            {form.kind === 'carrier' && (
              <Field label="Grátis acima de (R$)" hint="Vazio = nunca grátis.">
                {(id) => <Input id={id} inputMode="decimal" className="num" value={form.freeAbove} onChange={(e) => set('freeAbove', e.target.value)} />}
              </Field>
            )}
            {form.kind === 'delivery' && (
              <>
                <Field label="Por kg (R$)" hint="Soma ao fixo, por quilo iniciado.">
                  {(id) => <Input id={id} inputMode="decimal" className="num" value={form.perKg} onChange={(e) => set('perKg', e.target.value)} />}
                </Field>
                <Field label="Grátis acima de (R$)" hint="Vazio = nunca grátis.">
                  {(id) => <Input id={id} inputMode="decimal" className="num" value={form.freeAbove} onChange={(e) => set('freeAbove', e.target.value)} />}
                </Field>
                <Field label="Peso máximo (kg)">{(id) => <Input id={id} inputMode="decimal" className="num" value={form.maxKg} onChange={(e) => set('maxKg', e.target.value)} />}</Field>
              </>
            )}
            {form.kind !== 'carrier' && (
              <>
                <Field label="Prazo mínimo (dias úteis)">
                  {(id) => <Input id={id} inputMode="numeric" value={form.minDays} onChange={(e) => set('minDays', e.target.value.replace(/\D/g, ''))} />}
                </Field>
                <Field label="Prazo máximo (dias úteis)">
                  {(id) => <Input id={id} inputMode="numeric" value={form.maxDays} onChange={(e) => set('maxDays', e.target.value.replace(/\D/g, ''))} />}
                </Field>
              </>
            )}
            <Field label="Ordem na lista">{(id) => <Input id={id} inputMode="numeric" value={form.position} onChange={(e) => set('position', e.target.value.replace(/\D/g, ''))} />}</Field>
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} /> Disponível na loja
            </label>
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit" variant="primary" busy={busy}>
                Salvar
              </Button>
              <Button type="button" variant="ghost" onClick={() => setForm(null)}>
                Cancelar
              </Button>
            </div>
          </form>
        </Panel>
      )}
      {list && (
        <div className="overflow-x-auto rounded-lg border border-line bg-card">
          {list.length === 0 ? (
            <Empty title="Nenhuma forma de entrega cadastrada.">Sem ao menos uma, a loja não consegue fechar pedidos.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {list.map((o) => (
                <li key={o.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {o.name} {!o.active && <Badge>Inativa</Badge>}
                    </p>
                    <p className="text-sm text-ink-soft">
                      {o.kind === 'pickup' ? 'Retirada' : o.kind === 'carrier' ? `Transportadora · serviço ${o.carrier_service} · cotação automática` : o.cep_ranges.map(rangeText).join(' · ')}
                    </p>
                    {o.kind === 'carrier' ? (
                      <p className="text-[13px] text-ink-faint">
                        {Number(o.base_cents) ? `+ ${money(o.base_cents)} de manuseio` : 'Preço da cotação'}
                        {o.free_above_cents && ` · grátis acima de ${money(o.free_above_cents)}`} · + {o.handling_days} dia(s) de separação
                      </p>
                    ) : (
                      <p className="text-[13px] text-ink-faint">
                        {Number(o.base_cents) ? money(o.base_cents) : 'Sem custo'}
                        {Number(o.per_kg_cents) > 0 && ` + ${money(o.per_kg_cents)}/kg`}
                        {o.free_above_cents && ` · grátis acima de ${money(o.free_above_cents)}`} · {o.min_days === o.max_days ? `${o.min_days}` : `${o.min_days} a ${o.max_days}`} dia(s) útil(eis)
                      </p>
                    )}
                  </div>
                  {edit && (
                    <Button variant="ghost" onClick={() => setForm(toForm(o))}>
                      Editar
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="orders.view">
      <ShippingOptions />
    </Guard>
  );
}
