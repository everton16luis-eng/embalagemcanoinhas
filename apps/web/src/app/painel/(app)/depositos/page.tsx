'use client';

import { useState, type FormEvent } from 'react';
import { Guard } from '@/components/shell';
import { useStockAccess, useWarehouses, type Warehouse } from '@/components/stock';
import { Badge, Button, Empty, Field, Input, Notice, PageHeader, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { qty } from '@/lib/format';

const EMPTY = { code: '', name: '', cep: '', street: '', number: '', complement: '', district: '', city: '', uf: '' };
type Form = typeof EMPTY;

const address = (w: Warehouse) =>
  [w.street && `${w.street}${w.number ? `, ${w.number}` : ''}`, w.complement, w.district, w.city && `${w.city}${w.uf ? `/${w.uf}` : ''}`, w.cep && `CEP ${w.cep}`].filter(Boolean).join(' · ');

function WarehouseForm({ initial, onDone, onCancel }: { initial?: Warehouse; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState<Form>(() => (initial ? { ...EMPTY, ...Object.fromEntries(Object.keys(EMPTY).map((k) => [k, (initial as unknown as Record<string, string | null>)[k] ?? ''])) } : EMPTY));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF({ ...f, [k]: k === 'uf' || k === 'code' ? e.target.value.toUpperCase() : e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { code, ...rest } = f;
    const body = { ...rest, cep: rest.cep.replace(/\D/g, '') };
    try {
      if (initial) await api(`/admin/warehouses/${initial.id}`, { method: 'PUT', body });
      else await api('/admin/warehouses', { method: 'POST', body: { code, ...body } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
        <Field label="Código" required hint={initial ? 'Não muda depois de criado.' : 'Ex.: LOJA, GALPAO-2'}>
          {(id) => <Input id={id} value={f.code} onChange={set('code')} disabled={!!initial} required pattern="[A-Z0-9_\-]{2,20}" maxLength={20} />}
        </Field>
        <Field label="Nome" required>
          {(id) => <Input id={id} value={f.name} onChange={set('name')} required minLength={2} maxLength={80} />}
        </Field>
      </div>
      <p className="text-[13px] text-ink-soft">Endereço é opcional. Só informe o que for real: ele será usado como origem de remessas nas próximas fases.</p>
      <div className="grid gap-3 sm:grid-cols-[140px_1fr_110px]">
        <Field label="CEP">{(id) => <Input id={id} value={f.cep} onChange={set('cep')} inputMode="numeric" maxLength={9} />}</Field>
        <Field label="Rua">{(id) => <Input id={id} value={f.street} onChange={set('street')} maxLength={120} />}</Field>
        <Field label="Número">{(id) => <Input id={id} value={f.number} onChange={set('number')} maxLength={20} />}</Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_80px]">
        <Field label="Complemento">{(id) => <Input id={id} value={f.complement} onChange={set('complement')} maxLength={60} />}</Field>
        <Field label="Bairro">{(id) => <Input id={id} value={f.district} onChange={set('district')} maxLength={60} />}</Field>
        <Field label="Cidade">{(id) => <Input id={id} value={f.city} onChange={set('city')} maxLength={60} />}</Field>
        <Field label="UF">{(id) => <Input id={id} value={f.uf} onChange={set('uf')} maxLength={2} />}</Field>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="flex gap-2">
        <Button variant="primary" busy={busy}>
          {initial ? 'Salvar depósito' : 'Cadastrar depósito'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function Warehouses() {
  const access = useStockAccess();
  const { warehouses, error, reload } = useWarehouses();
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const manage = access.warehouses;

  const toggle = async (w: Warehouse) => {
    setMsg(null);
    try {
      await api(`/admin/warehouses/${w.id}`, { method: 'PUT', body: { name: w.name, cep: w.cep, street: w.street, number: w.number, complement: w.complement, district: w.district, city: w.city, uf: w.uf, active: !w.active } });
      setMsg({ tone: 'good', text: w.active ? `${w.name} desativado.` : `${w.name} reativado.` });
      await reload();
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message });
    }
  };

  return (
    <>
      <PageHeader
        title="Depósitos"
        description="Locais onde a mercadoria fica guardada. O Depósito principal é o padrão: pedidos da loja, reservas e recebimentos de compra continuam nele."
        actions={
          manage &&
          editing !== 'new' && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              Novo depósito
            </Button>
          )
        }
      />
      {!manage && (
        <div className="mb-4">
          <Notice>Só o proprietário e o gerente, com verificação em duas etapas, cadastram e alteram depósitos.</Notice>
        </div>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
      {msg && (
        <div className="mb-4">
          <Notice tone={msg.tone}>{msg.text}</Notice>
        </div>
      )}
      {editing === 'new' && (
        <Panel title="Novo depósito" className="mb-5">
          <WarehouseForm
            onCancel={() => setEditing(null)}
            onDone={() => {
              setEditing(null);
              void reload();
            }}
          />
        </Panel>
      )}
      {warehouses && warehouses.length === 0 && <Empty title="Nenhum depósito." />}
      <div className="space-y-3">
        {warehouses?.map((w) =>
          editing === w.id ? (
            <Panel key={w.id} title={`Editar ${w.name}`}>
              <WarehouseForm
                initial={w}
                onCancel={() => setEditing(null)}
                onDone={() => {
                  setEditing(null);
                  void reload();
                }}
              />
            </Panel>
          ) : (
            <section key={w.id} className={`rounded-lg border border-line bg-card px-4 py-3 sm:px-5 ${w.active ? '' : 'opacity-70'}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{w.name}</span>
                    <span className="font-mono text-xs text-ink-faint">{w.code}</span>
                    {w.is_default && <Badge tone="act">Padrão</Badge>}
                    {!w.active && <Badge>Desativado</Badge>}
                    {!!w.alerts && <Badge tone="warn">{w.alerts} alerta(s)</Badge>}
                    {!!w.incoming && <Badge tone="act">{w.incoming} chegando</Badge>}
                  </p>
                  <p className="mt-0.5 text-sm text-ink-soft">{address(w) || 'Sem endereço informado.'}</p>
                </div>
                {manage && (
                  <div className="flex gap-2">
                    <Button className="h-8" onClick={() => setEditing(w.id)}>
                      Editar
                    </Button>
                    {!w.is_default && (
                      <Button className="h-8" variant={w.active ? 'ghost' : 'secondary'} onClick={() => toggle(w)}>
                        {w.active ? 'Desativar' : 'Reativar'}
                      </Button>
                    )}
                  </div>
                )}
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-5">
                {[
                  ['Disponível', w.on_hand],
                  ['Reservado', w.reserved],
                  ['Bloqueado', w.blocked],
                  ['Avariado', w.damaged],
                  ['Chegando', w.in_transit],
                ].map(([label, v]) => (
                  <div key={label} className="flex items-baseline justify-between gap-2 sm:block">
                    <dt className="text-xs text-ink-soft">{label}</dt>
                    <dd className="num">{qty(v ?? '0')}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ),
        )}
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="stock.view">
      <Warehouses />
    </Guard>
  );
}
