'use client';

// SGLog Fase 9 (docs/38-sglog-fase9.md): ocorrencias e devolucoes. Rotulos e o painel do pedido.
import { useCallback, useEffect, useState } from 'react';
import Link from '@/components/painel-link';
import { useMe } from '@/components/shell';
import { newKey } from '@/components/stock';
import { Badge, Button, Field, Input, Notice, Panel, Select, Textarea, type Tone } from '@/components/ui';
import { api } from '@/lib/api';
import { parseQty, qty, when } from '@/lib/format';

export const OCCURRENCE_KIND: Record<string, string> = {
  damaged: 'Avaria',
  lost: 'Extravio',
  late: 'Atraso',
  refused: 'Recusa ou devolução ao remetente',
  wrong_item: 'Item errado',
  regret: 'Arrependimento',
  defect: 'Defeito',
  exchange: 'Pedido de troca',
  refund: 'Reembolso ou contestação',
  reverse: 'Logística reversa',
  delivery_failed: 'Falha na entrega',
  other: 'Outro',
};
export const OCCURRENCE_STATUS: Record<string, { label: string; tone: Tone }> = {
  open: { label: 'Aberta', tone: 'warn' },
  in_progress: { label: 'Em andamento', tone: 'act' },
  resolved: { label: 'Resolvida', tone: 'good' },
  canceled: { label: 'Cancelada', tone: 'neutral' },
};
export const RESPONSIBILITY: Record<string, string> = { company: 'Loja', supplier: 'Fornecedor', carrier: 'Transportadora', customer: 'Cliente', undetermined: 'A definir' };
export const OCCURRENCE_SOURCE: Record<string, string> = { manual: 'Painel', tracking: 'Rastreio', payment: 'Pagamento' };
export const RETURN_STATUS: Record<string, { label: string; tone: Tone }> = {
  authorized: { label: 'Autorizada', tone: 'warn' },
  in_transit: { label: 'Voltando', tone: 'act' },
  received: { label: 'Recebida (conferir)', tone: 'bad' },
  inspected: { label: 'Conferida', tone: 'act' },
  completed: { label: 'Encerrada', tone: 'good' },
  canceled: { label: 'Cancelada', tone: 'neutral' },
};
export const RETURN_KIND: Record<string, string> = { return: 'Devolução', refusal: 'Recusa na entrega', exchange: 'Troca' };
export const RETURN_REASON: Record<string, string> = {
  regret: 'Arrependimento',
  defect: 'Defeito',
  damaged: 'Avaria no transporte',
  wrong_item: 'Item errado',
  refused: 'Recusado na entrega',
  not_delivered: 'Não entregue (voltou)',
  warranty: 'Garantia',
  other: 'Outro',
};
export const RETURN_METHOD: Record<string, string> = { carrier: 'Transportadora', store_dropoff: 'Cliente traz na loja', pickup: 'Coleta combinada' };
export const CONDITION: Record<string, { label: string; tone: Tone; hint: string }> = {
  good: { label: 'Boa', tone: 'good', hint: 'volta ao disponível' },
  quarantine: { label: 'Quarentena', tone: 'warn', hint: 'saldo bloqueado até a decisão' },
  damaged: { label: 'Avariada', tone: 'bad', hint: 'saldo avariado' },
  discarded: { label: 'Descartada', tone: 'bad', hint: 'baixa (perda)' },
  missing: { label: 'Faltando', tone: 'neutral', hint: 'não veio; sem estoque' },
};

export const SUPPLIER_RETURN_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Rascunho', tone: 'neutral' },
  sent: { label: 'Enviada', tone: 'act' },
  accepted: { label: 'Aceita', tone: 'good' },
  refused: { label: 'Recusada (voltou)', tone: 'warn' },
  canceled: { label: 'Cancelada', tone: 'neutral' },
};
export const BUCKET: Record<string, string> = { on_hand: 'Livre', blocked: 'Bloqueado', damaged: 'Avariado' };
export const RETURN_ACTION: Record<string, string> = {
  authorize: 'Autorizada',
  transit: 'Voltando',
  receive: 'Recebida',
  inspect: 'Conferência',
  inspect_reverse: 'Estorno da conferência',
  quarantine: 'Quarentena',
  complete: 'Encerrada',
  cancel: 'Cancelada',
  note: 'Anotação',
  fiscal: 'Documento fiscal',
  exchange: 'Reposição',
  refund: 'Reembolso',
};
export const SUPPLIER_RETURN_ACTION: Record<string, string> = { create: 'Rascunho', send: 'Enviada', accept: 'Aceita', refuse: 'Recusada', cancel: 'Cancelada', note: 'Anotação' };

export function OccurrenceBadge({ status }: { status: string }) {
  const s = OCCURRENCE_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
export function ReturnBadge({ status }: { status: string }) {
  const s = RETURN_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export type Deadline = { kind: string; label: string; days: number; until: string; passed: boolean };
/** Prazos de referencia da politica da loja: so informam (D9-10). */
export function Deadlines({ items, deliveredAt }: { items: Deadline[]; deliveredAt?: string | null }) {
  if (!items.length) return <p className="text-sm text-ink-soft">Sem data de entrega registrada: os prazos de referência aparecem depois da entrega.</p>;
  return (
    <div className="space-y-1 text-sm" data-testid="return-deadlines">
      {deliveredAt !== undefined && <p className="text-ink-soft">Entregue em {when(deliveredAt)}. Prazos de referência da política da loja (só informam; não recusam nada):</p>}
      <ul className="space-y-0.5">
        {items.map((d) => (
          <li key={d.kind} className="flex flex-wrap items-center gap-2">
            <span>{d.label}:</span>
            <span className="num">
              {d.days} dia(s), até {when(d.until)}
            </span>
            {d.passed && <Badge tone="neutral">prazo de referência passou</Badge>}
          </li>
        ))}
      </ul>
    </div>
  );
}

type Ctx = {
  order: { id: string; number: number; status: string; channel: string; invoice_status: string };
  items: { id: string; sku: string; product_name: string; packaging_label: string; base_unit: string; ordered: string; dispatched: string; delivered: string; returned: string; returnable: string; refusable: string }[];
  returns: { id: string; number: number; kind: string; reason: string; status: string; created_at: string }[];
  occurrences: { id: string; number: number; kind: string; status: string; responsibility: string; description: string; created_at: string; source: string }[];
  shipments: { id: string; seq: number; kind: string; status: string }[];
  deadlines: Deadline[];
  deliveredAt: string | null;
  marketplace: boolean;
};

/** Painel do pedido: ocorrencias e devolucoes, com abertura de ocorrencia e autorizacao de devolucao. */
export function OrderReturnsPanel({ orderId, onChange }: { orderId: string; onChange?: () => void }) {
  const { can } = useMe();
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mode, setMode] = useState<'occurrence' | 'return' | null>(null);
  const load = useCallback(() => {
    api<Ctx>(`/admin/returns/orders/${orderId}`).then(setCtx, (e) => setError(e.message));
  }, [orderId]);
  useEffect(load, [load]);
  if (!ctx) return error ? <Notice tone="bad">{error}</Notice> : null;
  const done = (msg: string) => {
    setMode(null);
    setNotice(msg);
    load();
    onChange?.();
  };
  const shipped = ['shipped', 'delivered'].includes(ctx.order.status);
  return (
    <Panel
      title="Ocorrências e devoluções"
      description="Devolução física, reembolso e documento fiscal são registros separados. Autorizar a devolução não mexe no estoque: só a conferência movimenta."
      actions={
        <>
          {can('occurrences.manage') && ctx.order.status !== 'pending_payment' && (
            <Button onClick={() => setMode(mode === 'occurrence' ? null : 'occurrence')}>Abrir ocorrência</Button>
          )}
          {can('returns.manage') && shipped && (
            <Button onClick={() => setMode(mode === 'return' ? null : 'return')} data-testid="open-return-form">
              Registrar devolução
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4" data-testid="order-returns">
        {notice && <Notice tone="good">{notice}</Notice>}
        {mode === 'occurrence' && <OccurrenceForm ctx={ctx} onDone={(n) => done(`Ocorrência nº ${n} aberta.`)} onCancel={() => setMode(null)} />}
        {mode === 'return' && <ReturnForm ctx={ctx} onDone={(n) => done(`Devolução nº ${n} autorizada. Nada entrou no estoque ainda: receba e confira na tela da devolução.`)} onCancel={() => setMode(null)} />}
        {shipped && <Deadlines items={ctx.deadlines} deliveredAt={ctx.deliveredAt} />}
        {ctx.occurrences.length === 0 && ctx.returns.length === 0 ? (
          <p className="text-sm text-ink-soft">Nenhuma ocorrência ou devolução neste pedido.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {ctx.occurrences.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-2 py-2">
                <Link href={`/painel/logistica/ocorrencias/${o.id}`} className="font-medium text-act hover:underline">
                  Ocorrência nº {o.number}
                </Link>
                <span>{OCCURRENCE_KIND[o.kind] ?? o.kind}</span>
                <OccurrenceBadge status={o.status} />
                {o.source !== 'manual' && <Badge>{OCCURRENCE_SOURCE[o.source]}</Badge>}
                <span className="text-ink-faint">{when(o.created_at)}</span>
              </li>
            ))}
            {ctx.returns.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
                <Link href={`/painel/logistica/devolucoes/${r.id}`} className="font-medium text-act hover:underline">
                  {RETURN_KIND[r.kind]} nº {r.number}
                </Link>
                <span>{RETURN_REASON[r.reason] ?? r.reason}</span>
                <ReturnBadge status={r.status} />
                <span className="text-ink-faint">{when(r.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function OccurrenceForm({ ctx, onDone, onCancel }: { ctx: Ctx; onDone: (n: number) => void; onCancel: () => void }) {
  const [kind, setKind] = useState('damaged');
  const [responsibility, setResponsibility] = useState('undetermined');
  const [description, setDescription] = useState('');
  const [shipmentId, setShipmentId] = useState('');
  const [itemId, setItemId] = useState('');
  const [blocks, setBlocks] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [key] = useState(newKey);
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ occurrence: { number: number } }>('/admin/occurrences', {
        method: 'POST',
        body: { orderId: ctx.order.id, kind, responsibility, description, blocksCompletion: blocks, shipmentId: shipmentId || null, orderItemId: itemId || null, requestKey: key },
      });
      onDone(r.occurrence.number);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="space-y-3 rounded-md border border-line bg-sunken/40 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid="occurrence-form"
    >
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tipo">
          {(id) => (
            <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(OCCURRENCE_KIND).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Responsável" hint="Sem responsável definido, a ocorrência não pode ser resolvida.">
          {(id) => (
            <Select id={id} value={responsibility} onChange={(e) => setResponsibility(e.target.value)}>
              {Object.entries(RESPONSIBILITY).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {ctx.shipments.length > 0 && (
          <Field label="Remessa (opcional)">
            {(id) => (
              <Select id={id} value={shipmentId} onChange={(e) => setShipmentId(e.target.value)}>
                <option value="">—</option>
                {ctx.shipments.map((s) => (
                  <option key={s.id} value={s.id}>
                    Remessa nº {s.seq}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="Item (opcional)">
          {(id) => (
            <Select id={id} value={itemId} onChange={(e) => setItemId(e.target.value)}>
              <option value="">—</option>
              {ctx.items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.sku} · {i.product_name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Field label="O que aconteceu" required>
        {(id) => <Textarea id={id} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} required minLength={3} />}
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={blocks} onChange={(e) => setBlocks(e.target.checked)} /> Segura a conclusão do pedido enquanto estiver aberta
      </label>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" type="submit" busy={busy} disabled={description.trim().length < 3}>
          Abrir ocorrência
        </Button>
        <Button variant="ghost" type="button" onClick={onCancel}>
          Voltar
        </Button>
      </div>
    </form>
  );
}

function ReturnForm({ ctx, onDone, onCancel }: { ctx: Ctx; onDone: (n: number) => void; onCancel: () => void }) {
  const [kind, setKind] = useState<'return' | 'refusal' | 'exchange'>(ctx.order.status === 'delivered' ? 'return' : 'refusal');
  const [reason, setReason] = useState(ctx.order.status === 'delivered' ? 'defect' : 'refused');
  const [method, setMethod] = useState('carrier');
  const [occurrenceId, setOccurrenceId] = useState('');
  const [reverseCode, setReverseCode] = useState('');
  const [notes, setNotes] = useState('');
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [key] = useState(newKey);
  const cap = (i: Ctx['items'][number]) => (kind === 'refusal' ? i.refusable : i.returnable);
  const lines = ctx.items.filter((i) => Number(parseQty(qtys[i.id] ?? '0')) > 0).map((i) => ({ orderItemId: i.id, qty: parseQty(qtys[i.id]!) }));
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ return: { number: number } }>('/admin/returns', {
        method: 'POST',
        body: { orderId: ctx.order.id, kind, reason, items: lines, returnMethod: method, occurrenceId: occurrenceId || null, reverseCode: reverseCode || null, notes: notes || null, requestKey: key },
      });
      onDone(r.return.number);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="space-y-3 rounded-md border border-line bg-sunken/40 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid="return-form"
    >
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Tipo">
          {(id) => (
            <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="return">Devolução</option>
              <option value="refusal">Recusa ou voltou</option>
              {!ctx.marketplace && <option value="exchange">Troca</option>}
            </Select>
          )}
        </Field>
        <Field label="Motivo">
          {(id) => (
            <Select id={id} value={reason} onChange={(e) => setReason(e.target.value)}>
              {Object.entries(RETURN_REASON).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Como volta">
          {(id) => (
            <Select id={id} value={method} onChange={(e) => setMethod(e.target.value)}>
              {Object.entries(RETURN_METHOD).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {ctx.occurrences.length > 0 && (
          <Field label="Ocorrência (opcional)">
            {(id) => (
              <Select id={id} value={occurrenceId} onChange={(e) => setOccurrenceId(e.target.value)}>
                <option value="">—</option>
                {ctx.occurrences.map((o) => (
                  <option key={o.id} value={o.id}>
                    Nº {o.number} · {OCCURRENCE_KIND[o.kind]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="Autorização ou postagem reversa (opcional)">{(id) => <Input id={id} value={reverseCode} onChange={(e) => setReverseCode(e.target.value)} maxLength={60} />}</Field>
      </div>
      {ctx.marketplace && <Notice tone="neutral">Pedido de marketplace: a troca e o reembolso são conduzidos pela plataforma. Aqui fica só a devolução física.</Notice>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="text-left text-ink-soft">
            <tr>
              <th className="py-1.5 pr-2 font-medium">Item</th>
              <th className="py-1.5 pr-2 text-right font-medium">{kind === 'refusal' ? 'Despachado' : 'Entregue'}</th>
              <th className="py-1.5 pr-2 text-right font-medium">Já em devolução</th>
              <th className="py-1.5 font-medium">Volta</th>
            </tr>
          </thead>
          <tbody>
            {ctx.items.map((i) => (
              <tr key={i.id} className="border-t border-line">
                <td className="py-1.5 pr-2">
                  <span className="font-medium">{i.sku}</span> <span className="text-ink-soft">{i.product_name}</span>
                </td>
                <td className="num py-1.5 pr-2 text-right">
                  {qty(kind === 'refusal' ? i.dispatched : i.delivered)} {i.base_unit}
                </td>
                <td className="num py-1.5 pr-2 text-right">{qty(i.returned)}</td>
                <td className="py-1.5">
                  <Input
                    aria-label={`Quantidade a devolver de ${i.sku}`}
                    className="w-28"
                    inputMode="decimal"
                    placeholder={`até ${qty(cap(i))}`}
                    value={qtys[i.id] ?? ''}
                    disabled={Number(cap(i)) <= 0}
                    onChange={(e) => setQtys({ ...qtys, [i.id]: e.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Field label="Observação (opcional)">{(id) => <Input id={id} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />}</Field>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" type="submit" busy={busy} disabled={!lines.length}>
          Autorizar devolução
        </Button>
        <Button variant="ghost" type="button" onClick={onCancel}>
          Voltar
        </Button>
      </div>
    </form>
  );
}
