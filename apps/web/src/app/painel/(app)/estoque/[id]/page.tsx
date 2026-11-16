'use client';

import Link from '@/components/painel-link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Guard, useMe } from '@/components/shell';
import { RequestItem, type AdjustmentRequest } from '@/components/adjustment-requests';
import { MOVEMENT_LABELS, newKey, packLabel, useStockAccess } from '@/components/stock';
import { Badge, Button, Field, Input, Notice, PageHeader, Panel, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { parseQty, qty, qtyToInput, unitMoney, when } from '@/lib/format';

type Bucket = { on_hand: string; reserved: string; blocked: string; damaged: string; in_transit: string; available: string };
type Location = Bucket & { warehouse_id: string; code: string; name: string; is_default: boolean; active: boolean; bin: string | null; min_qty: string | null; max_qty: string | null; alerts: string[] };
type Movement = {
  id: string;
  kind: string;
  on_hand_delta: string;
  reserved_delta: string;
  blocked_delta: string;
  damaged_delta: string;
  in_transit_delta: string;
  on_hand_after: string;
  reserved_after: string;
  unit_cost_cents?: string | null;
  reason: string | null;
  source_type: string | null;
  document_ref: string | null;
  reverses_id: string | null;
  transfer_id: string | null;
  warehouse_name: string | null;
  counter_warehouse_name: string | null;
  reversed: boolean;
  reversible: boolean;
  created_at: string;
  created_by_name: string | null;
};
type Detail = {
  variant: Bucket & { variant_id: string; sku: string; label: string; product_id: string; base_unit: string; min_stock: string; availability_mode: string; allows_fraction: boolean; avg_cost_cents?: string };
  locations: Location[];
  movements: Movement[];
  reservations: { id: string; qty: string; backorder: boolean; source_type: string; source_id: string; expires_at: string | null; created_at: string }[];
  packagings: { id: string; kind: string; label: string; unit_code: string; base_qty: string }[];
};

const signed = (v: string) => (Number(v) > 0 ? `+${qty(v)}` : qty(v));
const cents4 = (v?: string | null) => unitMoney(v);
const BUCKET_NAMES: ['blocked_delta' | 'damaged_delta' | 'in_transit_delta', string][] = [
  ['blocked_delta', 'bloqueado'],
  ['damaged_delta', 'avariado'],
  ['in_transit_delta', 'em trânsito'],
];

function WarehouseSelect({ locations, value, onChange }: { locations: Location[]; value: string; onChange: (v: string) => void }) {
  const active = locations.filter((l) => l.active);
  if (active.length < 2) return null;
  return (
    <Field label="Depósito">
      {(id) => (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {active.map((l) => (
            <option key={l.warehouse_id} value={l.warehouse_id}>
              {l.name}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

const defaultWh = (locations: Location[]) => (locations.find((l) => l.is_default) ?? locations[0])?.warehouse_id ?? '';

/**
 * Ajuste, perda, avaria e devolucao. Ajuste, perda e avaria lancam direto so com stock.adjust (com MFA);
 * sem ela, viram solicitacao para outra pessoa aprovar (D3-2).
 */
function MovementForm({ variantId, unit, locations, onDone }: { variantId: string; unit: string; locations: Location[]; onDone: () => void }) {
  const access = useStockAccess();
  const [kind, setKind] = useState('adjustment');
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [reason, setReason] = useState('');
  const [warehouseId, setWarehouseId] = useState(() => defaultWh(locations));
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const direct = kind === 'return' || access.adjust;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const value = parseQty(amount);
    const body = { variantId, warehouseId: warehouseId || null, kind, qty: kind === 'adjustment' && direction === 'out' ? `-${value}` : value, reason, requestKey: key };
    try {
      if (direct) {
        await api('/admin/stock/movements', { method: 'POST', body });
        setMsg({ tone: 'good', text: 'Lançamento registrado.' });
      } else {
        const r = await api<{ request: { number: number } }>('/admin/stock/adjustment-requests', { method: 'POST', body });
        setMsg({ tone: 'good', text: `Solicitação nº ${r.request.number} enviada para aprovação. O saldo só muda quando ela for aprovada.` });
      }
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
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <WarehouseSelect locations={locations} value={warehouseId} onChange={setWarehouseId} />
        <Field label="Tipo">
          {(id) => (
            <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="adjustment">Ajuste</option>
              <option value="loss">Perda</option>
              <option value="damage">Avaria (baixa)</option>
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
      {!direct && (
        <Notice tone="warn">
          {access.adjustNeedsMfa
            ? 'Ative a verificação em duas etapas para lançar ajustes direto. Sem ela, este lançamento vira uma solicitação que outra pessoa aprova.'
            : 'Sem a permissão de ajuste de estoque, este lançamento vira uma solicitação que outra pessoa aprova.'}
        </Notice>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <Button variant="primary" busy={busy}>
        {direct ? 'Lançar' : 'Enviar para aprovação'}
      </Button>
    </form>
  );
}

const HOLD_OPS: Record<string, { label: string; hint: string; adjust?: boolean }> = {
  block: { label: 'Bloquear / quarentena', hint: 'Sai do disponível e não é vendido até ser liberado.' },
  unblock: { label: 'Liberar do bloqueio', hint: 'Volta ao disponível.' },
  damage_hold: { label: 'Separar como avariado', hint: 'Sai do disponível; aguarda análise.' },
  damage_release: { label: 'Recuperar avariado', hint: 'O item avariado volta ao disponível.' },
  damage_write_off: { label: 'Dar baixa do avariado', hint: 'Sai do estoque de vez. Exige permissão de ajuste.', adjust: true },
};

function HoldForm({ variantId, unit, locations, onDone }: { variantId: string; unit: string; locations: Location[]; onDone: () => void }) {
  const access = useStockAccess();
  const [op, setOp] = useState('block');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [doc, setDoc] = useState('');
  const [warehouseId, setWarehouseId] = useState(() => defaultWh(locations));
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api('/admin/stock/holds', { method: 'POST', body: { variantId, warehouseId: warehouseId || null, op, qty: parseQty(amount), reason, documentRef: doc.trim() || null, requestKey: key } });
      setMsg({ tone: 'good', text: 'Registrado.' });
      setAmount('');
      setReason('');
      setDoc('');
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
      <WarehouseSelect locations={locations} value={warehouseId} onChange={setWarehouseId} />
      <Field label="Operação" hint={HOLD_OPS[op]!.hint}>
        {(id) => (
          <Select id={id} value={op} onChange={(e) => setOp(e.target.value)}>
            {Object.entries(HOLD_OPS)
              .filter(([, o]) => !o.adjust || access.adjust)
              .map(([k, o]) => (
                <option key={k} value={k}>
                  {o.label}
                </option>
              ))}
          </Select>
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={`Quantidade (${unit})`} required>
          {(id) => <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />}
        </Field>
        <Field label="Documento">{(id) => <Input id={id} value={doc} onChange={(e) => setDoc(e.target.value)} maxLength={60} placeholder="Opcional" />}</Field>
      </div>
      <Field label="Motivo" required>
        {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={300} required />}
      </Field>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <Button busy={busy}>Registrar</Button>
    </form>
  );
}

function LocationSettings({ l, variantId, onDone, onCancel }: { l: Location; variantId: string; onDone: () => void; onCancel: () => void }) {
  const [bin, setBin] = useState(l.bin ?? '');
  const [min, setMin] = useState(l.min_qty ? qtyToInput(l.min_qty) : '');
  const [max, setMax] = useState(l.max_qty ? qtyToInput(l.max_qty) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/admin/stock/locations/${l.warehouse_id}/${variantId}`, { method: 'PUT', body: { bin: bin.trim() || null, minQty: min.trim() ? parseQty(min) : null, maxQty: max.trim() ? parseQty(max) : null } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mt-3 space-y-3 border-t border-line pt-3">
      <div className="grid grid-cols-3 gap-2">
        <Field label="Localização">{(id) => <Input id={id} value={bin} onChange={(e) => setBin(e.target.value)} maxLength={40} placeholder="Ex.: A-03" />}</Field>
        <Field label="Mínimo">{(id) => <Input id={id} inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} />}</Field>
        <Field label="Máximo">{(id) => <Input id={id} inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} />}</Field>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="flex gap-2">
        <Button variant="primary" className="h-8" busy={busy}>
          Salvar
        </Button>
        <Button type="button" variant="ghost" className="h-8" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function ReverseForm({ movement, onDone, onCancel }: { movement: Movement; onDone: () => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [key] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/admin/stock/movements/${movement.id}/reverse`, { method: 'POST', body: { reason, requestKey: key } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mt-2 space-y-2">
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Motivo do estorno" placeholder="Motivo do estorno" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={300} required className="min-w-0 flex-1 basis-48" />
        <Button variant="danger" busy={busy}>
          Confirmar estorno
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Voltar
        </Button>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
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
  const access = useStockAccess();
  const [data, setData] = useState<Detail | null>(null);
  const [requests, setRequests] = useState<AdjustmentRequest[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [reversing, setReversing] = useState<string | null>(null);
  const load = useCallback(
    () =>
      Promise.all([
        api<Detail>(`/admin/stock/variants/${id}`).then(setData),
        api<{ items: AdjustmentRequest[] }>(`/admin/stock/adjustment-requests?status=pending&variantId=${id}`).then((r) => setRequests(r.items)),
      ]).catch((e) => setError(e.message)),
    [id],
  );
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
  const multi = data.locations.length > 1;

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
          <>
            {can('stock.transfer') && multi && (
              <Link href={`/painel/transferencias/nova?variantId=${v.variant_id}`}>
                <Button>Transferir</Button>
              </Link>
            )}
            {can('catalog.view') && (
              <Link href={`/painel/produtos/${v.product_id}`}>
                <Button>Abrir cadastro</Button>
              </Link>
            )}
          </>
        }
      />
      {error && (
        <div className="mb-4">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}

      <dl className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
        {(
          [
            ['Vendável', v.available, Number(v.available) <= 0],
            ['Disponível', v.on_hand, false],
            ['Reservado', v.reserved, false],
            ['Bloqueado', v.blocked, false],
            ['Avariado', v.damaged, false],
            ['Em trânsito', v.in_transit, false],
          ] as const
        ).map(([label, value, alert]) => (
          <div key={label} className="bg-card px-4 py-3">
            <dt className="text-xs text-ink-soft">{label}</dt>
            <dd className={`num mt-0.5 text-xl font-semibold ${alert ? 'text-bad' : ''}`}>
              {qty(value)} <span className="text-sm font-normal text-ink-faint">{unit}</span>
            </dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-5">
          <Panel title="Por depósito" description="Vendável = disponível − reservado. O mínimo e o máximo de cada depósito geram os alertas do painel.">
            <ul className="divide-y divide-line">
              {data.locations.map((l) => (
                <li key={l.warehouse_id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{l.name}</span>
                      {l.is_default && <Badge tone="act">Padrão</Badge>}
                      {!l.active && <Badge>Desativado</Badge>}
                      {l.alerts.includes('below_min') && <Badge tone="warn">Abaixo do mínimo</Badge>}
                      {l.alerts.includes('above_max') && <Badge tone="warn">Acima do máximo</Badge>}
                    </p>
                    <p className="text-xs text-ink-faint">
                      {l.bin ? `Local ${l.bin}` : 'Sem localização'} · mín. {l.min_qty ? qty(l.min_qty) : '—'} · máx. {l.max_qty ? qty(l.max_qty) : '—'}
                      {can('stock.manage') && l.active && editing !== l.warehouse_id && (
                        <button type="button" className="ml-2 font-medium text-act-dark hover:underline" onClick={() => setEditing(l.warehouse_id)}>
                          Editar
                        </button>
                      )}
                    </p>
                  </div>
                  <dl className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1 text-sm sm:grid-cols-6">
                    {(
                      [
                        ['Vendável', l.available],
                        ['Disponível', l.on_hand],
                        ['Reservado', l.reserved],
                        ['Bloqueado', l.blocked],
                        ['Avariado', l.damaged],
                        ['Chegando', l.in_transit],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-xs text-ink-soft">{label}</dt>
                        <dd className={`num ${label === 'Vendável' && Number(value) < 0 ? 'text-bad' : ''} ${Number(value) ? '' : 'text-ink-faint'}`}>{qty(value)}</dd>
                      </div>
                    ))}
                  </dl>
                  {editing === l.warehouse_id && (
                    <LocationSettings
                      l={l}
                      variantId={v.variant_id}
                      onCancel={() => setEditing(null)}
                      onDone={() => {
                        setEditing(null);
                        void load();
                      }}
                    />
                  )}
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Movimentações" description="Últimas 100. Cada linha mostra o disponível do produto depois do lançamento; nada é apagado ou editado — correções são estornos.">
            {data.movements.length === 0 ? (
              <p className="text-sm text-ink-soft">Nenhuma movimentação ainda.</p>
            ) : (
              <div className="-mx-4 overflow-x-auto sm:-mx-5">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-ink-soft">
                    <tr className="border-b border-line">
                      <th className="py-2 pl-4 font-medium sm:pl-5">Quando / tipo</th>
                      <th className="py-2 pr-4 pl-3 text-right font-medium sm:pr-0">Disponível</th>
                      <th className="hidden py-2 pl-3 text-right font-medium sm:table-cell sm:pr-5 md:pr-0">Reservado</th>
                      {showCost && <th className="hidden py-2 pr-4 pl-3 text-right font-medium md:table-cell sm:pr-5">Custo</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.movements.map((m) => {
                      const others = BUCKET_NAMES.filter(([k]) => Number(m[k])).map(([k, name]) => `${name} ${signed(m[k])}`);
                      const canReverse = access.adjust && m.reversible && !m.reversed;
                      return (
                        <tr key={m.id} className="align-top">
                          <td className="py-2 pl-4 sm:pl-5">
                            <span className="flex flex-wrap items-center gap-1.5 font-medium">
                              {MOVEMENT_LABELS[m.kind] ?? m.kind}
                              {m.reversed && <Badge>Estornado</Badge>}
                              {m.reverses_id && <span className="text-xs font-normal text-ink-faint">do lançamento #{m.reverses_id}</span>}
                            </span>
                            <span className="block text-xs text-ink-faint">
                              #{m.id} · {when(m.created_at)}
                              {m.created_by_name && ` · ${m.created_by_name}`}
                              {multi && m.warehouse_name && ` · ${m.warehouse_name}`}
                              {m.counter_warehouse_name && ` ⇄ ${m.counter_warehouse_name}`}
                            </span>
                            {(m.reason || m.document_ref) && (
                              <span className="block text-xs text-ink-soft">{[m.reason, m.document_ref && `doc. ${m.document_ref}`].filter(Boolean).join(' · ')}</span>
                            )}
                            {others.length > 0 && <span className="block text-xs text-ink-soft">{others.join(' · ')}</span>}
                            {m.transfer_id && (
                              <Link href={`/painel/transferencias/${m.transfer_id}`} className="text-xs font-medium text-act-dark hover:underline">
                                Ver transferência
                              </Link>
                            )}
                            {canReverse && reversing !== m.id && (
                              <button type="button" className="text-xs font-medium text-bad hover:underline" onClick={() => setReversing(m.id)}>
                                Estornar
                              </button>
                            )}
                            {reversing === m.id && (
                              <ReverseForm
                                movement={m}
                                onCancel={() => setReversing(null)}
                                onDone={() => {
                                  setReversing(null);
                                  void load();
                                }}
                              />
                            )}
                          </td>
                          <td className="num py-2 pr-4 pl-3 text-right sm:pr-0">
                            {Number(m.on_hand_delta) ? <span className={Number(m.on_hand_delta) < 0 ? 'text-bad' : 'text-good'}>{signed(m.on_hand_delta)}</span> : <span className="text-ink-faint">—</span>}
                            <span className="block text-xs text-ink-faint">= {qty(m.on_hand_after)}</span>
                          </td>
                          <td className="num hidden py-2 pl-3 text-right sm:table-cell sm:pr-5 md:pr-0">
                            {Number(m.reserved_delta) ? signed(m.reserved_delta) : <span className="text-ink-faint">—</span>}
                            <span className="block text-xs text-ink-faint">= {qty(m.reserved_after)}</span>
                          </td>
                          {showCost && <td className="num hidden py-2 pr-4 pl-3 text-right md:table-cell sm:pr-5">{m.unit_cost_cents ? cents4(m.unit_cost_cents) : <span className="text-ink-faint">—</span>}</td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          {can('stock.manage') && (
            <Panel title="Lançamento manual" description="Entrada de compra é feita pelo recebimento do pedido de compra, que já calcula o custo.">
              <MovementForm variantId={v.variant_id} unit={unit} locations={data.locations} onDone={load} />
            </Panel>
          )}
        </div>

        <div className="space-y-5">
          {(requests.length > 0 || access.adjust) && (
            <Panel
              title="Solicitações de ajuste"
              actions={
                <Link href="/painel/estoque/solicitacoes" className="text-sm font-medium text-act-dark hover:underline">
                  Todas
                </Link>
              }
            >
              {requests.length === 0 ? (
                <p className="text-sm text-ink-soft">Nenhuma aguardando aprovação.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {requests.map((r) => (
                    <RequestItem key={r.id} r={r} onChange={load} />
                  ))}
                </ul>
              )}
            </Panel>
          )}
          {can('stock.manage') && (
            <Panel title="Bloqueio e avaria" description="Mercadoria parada não é vendida nem transferida.">
              <HoldForm variantId={v.variant_id} unit={unit} locations={data.locations} onDone={load} />
            </Panel>
          )}
          {showCost && (
            <Panel title="Custo médio">
              <p className="num text-xl font-semibold">
                {cents4(v.avg_cost_cents)} <span className="text-sm font-normal text-ink-faint">por {unit}</span>
              </p>
              <p className="mt-1 text-[13px] text-ink-soft">Ponderado pelas entradas de compra, com frete e despesas rateados, sobre todo o estoque da empresa (todos os depósitos).</p>
            </Panel>
          )}
          <Panel title="Reservas ativas" description={multi ? 'Reservas ficam no depósito padrão nesta fase.' : undefined}>
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
