'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Guard, useMe } from '@/components/shell';
import { MOVEMENT_LABELS, newKey, packLabel } from '@/components/stock';
import { Badge, Button, Field, Input, Notice, PageHeader, Panel, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { parseQty, qty, unitMoney, when } from '@/lib/format';

type Detail = {
  variant: { variant_id: string; sku: string; label: string; product_id: string; base_unit: string; min_stock: string; availability_mode: string; allows_fraction: boolean; on_hand: string; reserved: string; available: string; avg_cost_cents?: string };
  movements: { id: string; kind: string; on_hand_delta: string; reserved_delta: string; on_hand_after: string; reserved_after: string; unit_cost_cents?: string | null; reason: string | null; source_type: string | null; created_at: string; created_by_name: string | null }[];
  reservations: { id: string; qty: string; backorder: boolean; source_type: string; source_id: string; expires_at: string | null; created_at: string }[];
  packagings: { id: string; kind: string; label: string; unit_code: string; base_qty: string }[];
};

const signed = (v: string) => (Number(v) > 0 ? `+${qty(v)}` : qty(v));
const cents4 = (v?: string | null) => unitMoney(v);

function MovementForm({ variantId, unit, onDone }: { variantId: string; unit: string; onDone: () => void }) {
  const [kind, setKind] = useState('adjustment');
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const value = parseQty(amount);
    try {
      await api('/admin/stock/movements', { method: 'POST', body: { variantId, kind, qty: kind === 'adjustment' && direction === 'out' ? `-${value}` : value, reason, requestKey: key } });
      setMsg({ tone: 'good', text: 'Lançamento registrado.' });
      setAmount('');
      setReason('');
      setKey(newKey());
      onDone();
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Tipo">
          {(id) => (
            <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="adjustment">Ajuste</option>
              <option value="loss">Perda</option>
              <option value="damage">Avaria</option>
              <option value="return">Devolução de cliente</option>
            </Select>
          )}
        </Field>
        {kind === 'adjustment' && (
          <Field label="Sentido">
            {(id) => (
              <Select id={id} value={direction} onChange={(e) => setDirection(e.target.value as 'in' | 'out')}>
                <option value="in">Entrada</option>
                <option value="out">Saída</option>
              </Select>
            )}
          </Field>
        )}
        <Field label={`Quantidade (${unit})`} required>
          {(id) => <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />}
        </Field>
      </div>
      <Field label="Motivo" required hint="Fica no histórico do produto e na auditoria.">
        {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={300} required />}
      </Field>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <Button variant="primary" busy={busy}>
        Lançar
      </Button>
    </form>
  );
}

function ReserveForm({ variantId, unit, onDone }: { variantId: string; unit: string; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [ref, setRef] = useState('');
  const [hours, setHours] = useState('48');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/admin/stock/reservations', { method: 'POST', body: { variantId, qty: parseQty(amount), sourceType: 'manual', sourceId: ref.trim(), expiresInHours: hours ? Number(hours) : null } });
      setAmount('');
      setRef('');
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={`Quantidade (${unit})`} required>
          {(id) => <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />}
        </Field>
        <Field label="Para quem / referência" required>
          {(id) => <Input id={id} value={ref} onChange={(e) => setRef(e.target.value)} maxLength={60} placeholder="Ex.: Padaria Central" required />}
        </Field>
        <Field label="Vence em" hint="Em branco: não vence.">
          {(id) => (
            <Select id={id} value={hours} onChange={(e) => setHours(e.target.value)}>
              <option value="24">24 horas</option>
              <option value="48">2 dias</option>
              <option value="168">7 dias</option>
              <option value="">Não vence</option>
            </Select>
          )}
        </Field>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      <Button busy={busy}>Reservar</Button>
    </form>
  );
}

function StockDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useMe();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api<Detail>(`/admin/stock/variants/${id}`).then(setData, (e) => setError(e.message)), [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (path: string) => {
    setError('');
    try {
      await api(path, { method: 'POST', body: {} });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!data) return error ? <Notice tone="bad">{error}</Notice> : <p className="text-sm text-ink-faint">Carregando…</p>;
  const v = data.variant;
  const unit = v.base_unit;
  const showCost = v.avg_cost_cents !== undefined;

  return (
    <>
      <PageHeader
        title={v.label}
        description={
          <>
            <span className="font-mono">{v.sku}</span> · unidade base {unit}
            {v.availability_mode === 'made_to_order' && ' · sob encomenda'}
          </>
        }
        actions={
          can('catalog.view') && (
            <Link href={`/painel/produtos/${v.product_id}`}>
              <Button>Abrir cadastro</Button>
            </Link>
          )
        }
      />
      {error && (
        <div className="mb-4">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}

      <dl className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
        {[
          ['Disponível', v.available, Number(v.available) <= 0],
          ['Físico', v.on_hand, false],
          ['Reservado', v.reserved, false],
          ['Mínimo', v.min_stock, false],
        ].map(([label, value, alert]) => (
          <div key={label as string} className="bg-card px-4 py-3">
            <dt className="text-xs text-ink-soft">{label as string}</dt>
            <dd className={`num mt-0.5 text-xl font-semibold ${alert ? 'text-bad' : ''}`}>
              {qty(value as string)} <span className="text-sm font-normal text-ink-faint">{unit}</span>
            </dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-5">
          <Panel title="Movimentações" description="Últimas 100. Cada linha mostra o saldo depois do lançamento; nada é apagado ou editado.">
            {data.movements.length === 0 ? (
              <p className="text-sm text-ink-soft">Nenhuma movimentação ainda.</p>
            ) : (
              <div className="-mx-4 overflow-x-auto sm:-mx-5">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-ink-soft">
                    <tr className="border-b border-line">
                      <th className="py-2 pl-4 font-medium sm:pl-5">Quando / tipo</th>
                      <th className="py-2 pl-3 text-right font-medium">Físico</th>
                      <th className="hidden py-2 pl-3 text-right font-medium sm:table-cell">Reservado</th>
                      {showCost && <th className="hidden py-2 pr-4 pl-3 text-right font-medium md:table-cell sm:pr-5">Custo</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.movements.map((m) => (
                      <tr key={m.id}>
                        <td className="py-2 pl-4 sm:pl-5">
                          <span className="block font-medium">{MOVEMENT_LABELS[m.kind] ?? m.kind}</span>
                          <span className="block text-xs text-ink-faint">
                            {when(m.created_at)}
                            {m.created_by_name && ` · ${m.created_by_name}`}
                            {m.reason && ` · ${m.reason}`}
                          </span>
                        </td>
                        <td className="num py-2 pl-3 text-right">
                          {Number(m.on_hand_delta) ? <span className={Number(m.on_hand_delta) < 0 ? 'text-bad' : 'text-good'}>{signed(m.on_hand_delta)}</span> : <span className="text-ink-faint">—</span>}
                          <span className="block text-xs text-ink-faint">= {qty(m.on_hand_after)}</span>
                        </td>
                        <td className="num hidden py-2 pl-3 text-right sm:table-cell">
                          {Number(m.reserved_delta) ? signed(m.reserved_delta) : <span className="text-ink-faint">—</span>}
                          <span className="block text-xs text-ink-faint">= {qty(m.reserved_after)}</span>
                        </td>
                        {showCost && <td className="num hidden py-2 pr-4 pl-3 text-right md:table-cell sm:pr-5">{m.unit_cost_cents ? cents4(m.unit_cost_cents) : <span className="text-ink-faint">—</span>}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          {can('stock.manage') && (
            <Panel title="Lançamento manual" description="Entrada de compra é feita pelo recebimento do pedido de compra, que já calcula o custo.">
              <MovementForm variantId={v.variant_id} unit={unit} onDone={load} />
            </Panel>
          )}
        </div>

        <div className="space-y-5">
          {showCost && (
            <Panel title="Custo médio">
              <p className="num text-xl font-semibold">
                {cents4(v.avg_cost_cents)} <span className="text-sm font-normal text-ink-faint">por {unit}</span>
              </p>
              <p className="mt-1 text-[13px] text-ink-soft">Ponderado pelas entradas de compra, com frete e despesas rateados.</p>
            </Panel>
          )}
          <Panel title="Reservas ativas">
            {data.reservations.length === 0 ? (
              <p className="text-sm text-ink-soft">Nenhuma.</p>
            ) : (
              <ul className="divide-y divide-line">
                {data.reservations.map((r) => (
                  <li key={r.id} className="py-2.5 first:pt-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="num font-medium">
                        {qty(r.qty)} {unit}
                      </span>
                      {r.backorder && <Badge tone="warn">Além do físico</Badge>}
                    </div>
                    <p className="text-xs text-ink-faint">
                      {r.source_type === 'manual' ? r.source_id : `${r.source_type} ${r.source_id}`} · {r.expires_at ? `vence ${when(r.expires_at)}` : 'sem vencimento'}
                    </p>
                    {can('stock.manage') && r.source_type === 'manual' && (
                      <div className="mt-2 flex gap-2">
                        <Button className="h-8" onClick={() => act(`/admin/stock/reservations/${r.id}/consume`)}>
                          Dar baixa
                        </Button>
                        <Button variant="ghost" className="h-8" onClick={() => act(`/admin/stock/reservations/${r.id}/release`)}>
                          Liberar
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {can('stock.manage') && (
              <div className="mt-4 border-t border-line pt-4">
                <ReserveForm variantId={v.variant_id} unit={unit} onDone={load} />
              </div>
            )}
          </Panel>
          <Panel title="Embalagens">
            <ul className="space-y-1 text-sm">
              {data.packagings.map((k) => (
                <li key={k.id} className="flex justify-between gap-2">
                  <span>{packLabel(k.label, k.base_qty, unit)}</span>
                  <span className="text-xs text-ink-faint">{k.kind === 'sale' ? 'venda' : 'compra'}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="stock.view">
      <StockDetail />
    </Guard>
  );
}
