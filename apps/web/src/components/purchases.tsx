'use client';

// SGLog Fase 6: aprovacao, pagamento informado, transporte, encomendas vinculadas, divergencias e historico da compra.
import Link from '@/components/painel-link';
import { useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Field, Input, Notice, Panel, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { money, parseMoney, qty, when } from '@/lib/format';

export type PoEvent = { id: number; kind: string; note: string | null; data: Record<string, unknown>; created_at: string; actor_name: string };
export type PoIssue = { id: number; receipt_id: string; item_id: string; kind: string; expected: string | null; found: string | null; qty: string | null; destination: string | null; note: string; created_at: string; actor_name: string };
export type PoLink = {
  id: string;
  item_id: string;
  allocation_id: string;
  order_id: string;
  order_number: number;
  base_qty: string;
  status: 'active' | 'canceled';
  cancel_reason: string | null;
  created_at: string;
  closed_at: string | null;
  created_by_name: string;
  reservation_state: string | null;
};
export type PoConversion = { id: number; order_id: string; order_number: number; variant_id: string; qty: string; rule: string; receipt_id: string | null; created_at: string };

export const PURPOSE: Record<string, string> = { replenishment: 'Reposição do estoque', fulfillment: 'Atender encomendas' };
export const RULE: Record<string, string> = { linked: 'vinculada a esta compra', queue: 'pela fila de pagamento', reprocess: 'reprocessamento', manual: 'antecipação manual' };
const EVENT: Record<string, string> = {
  submitted: 'Enviado para aprovação',
  approved: 'Aprovado',
  approval_rejected: 'Devolvido sem aprovação',
  back_to_draft: 'Voltou para rascunho',
  payment_informed: 'Pagamento informado',
  sent: 'Enviado ao fornecedor',
  shipping_updated: 'Transporte atualizado',
  closed_short: 'Encerrado com falta',
  canceled: 'Cancelado',
  // Fase 7
  document_resent: 'Pedido reenviado ao fornecedor',
  confirmation: 'Confirmação do fornecedor registrada',
  confirmation_approved: 'Aumento de preço aprovado',
  confirmation_rejected: 'Aumento de preço recusado',
  closed_by_confirmation: 'Encerrado pela confirmação (restante recusado)',
  followup: 'Contato com o fornecedor',
  requests_added: 'Requisições incluídas',
};
export const ISSUE: Record<string, string> = { quantity: 'Quantidade', quality: 'Qualidade', price: 'Preço', wrong_item: 'Item errado' };
const DEST: Record<string, string> = { blocked: 'bloqueado', damaged: 'avariado' };
const RES_STATE: Record<string, { label: string; tone: 'neutral' | 'act' | 'warn' | 'good' | 'bad' }> = {
  awaiting: { label: 'Aguardando mercadoria', tone: 'warn' },
  converted: { label: 'Atendida', tone: 'good' },
  consumed: { label: 'Despachada', tone: 'good' },
  released: { label: 'Liberada', tone: 'neutral' },
  expired: { label: 'Liberada', tone: 'neutral' },
};

export type ApprovalInfo = {
  status: string;
  submitted_at: string | null;
  approved_at: string | null;
  approved_by_name: string | null;
  approval_self: boolean;
  approval_note: string | null;
  payment_informed_on: string | null;
  payment_informed_amount_cents: string | null;
  payment_informed_ref: string | null;
  payment_informed_at: string | null;
  payment_informed_by_name: string | null;
};

const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('pt-BR');

/** Aprovacao e pagamento informado. O pagamento e so registro: nao movimenta dinheiro nem confirma no banco (D6-5). */
export function ApprovalPanel({ order, canPay, onChange }: { order: ApprovalInfo & { id: string }; canPay: boolean; onChange: (o: never) => void }) {
  const [open, setOpen] = useState(false);
  const [paidOn, setPaidOn] = useState(order.payment_informed_on ?? new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [ref, setRef] = useState(order.payment_informed_ref ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const payable = ['approved', 'sent', 'partial', 'received'].includes(order.status);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const cents = parseMoney(amount);
    if (cents === null) return setError('Informe o valor pago.');
    setBusy(true);
    try {
      const r = await api(`/admin/purchase-orders/${order.id}/payment`, { method: 'POST', body: { paidOn, amountCents: cents, reference: ref.trim() || null } });
      setOpen(false);
      onChange(r.order as never);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Aprovação e pagamento">
      <dl className="space-y-2 text-sm">
        <div>
          <dt className="text-ink-soft">Aprovação</dt>
          <dd>
            {order.approved_at ? (
              <>
                {order.approved_by_name ? `Aprovado por ${order.approved_by_name}` : 'Aprovado automaticamente'} em {when(order.approved_at)}
                {order.approval_self && (
                  <span className="block text-xs text-warn" data-testid="approval-self">
                    Aprovado pelo próprio proprietário: {order.approval_note}
                  </span>
                )}
                {!order.approval_self && order.approval_note && <span className="block text-xs text-ink-faint">{order.approval_note}</span>}
              </>
            ) : order.status === 'pending_approval' ? (
              <span className="text-warn">Aguardando aprovação desde {order.submitted_at ? when(order.submitted_at) : '—'}</span>
            ) : ['sent', 'partial', 'received'].includes(order.status) ? (
              <span className="text-ink-soft">Enviada antes da aprovação de compras existir (registro anterior à Fase 6).</span>
            ) : order.status === 'canceled' ? (
              '—'
            ) : (
              <span className="text-ink-soft">Ainda não enviado para aprovação.</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-ink-soft">Pagamento ao fornecedor</dt>
          <dd data-testid="payment-informed">
            {order.payment_informed_at ? (
              <>
                Informado: {money(order.payment_informed_amount_cents ?? 0)} em {day(order.payment_informed_on!)}
                {order.payment_informed_ref && ` · ${order.payment_informed_ref}`}
                <span className="block text-xs text-ink-faint">
                  Registrado por {order.payment_informed_by_name} em {when(order.payment_informed_at)}. Informação administrativa: não confirma o pagamento no banco.
                </span>
              </>
            ) : (
              <span className="text-ink-soft">Não informado.</span>
            )}
          </dd>
        </div>
      </dl>
      {canPay && payable && !open && (
        <Button className="mt-3" onClick={() => setOpen(true)}>
          {order.payment_informed_at ? 'Corrigir pagamento informado' : 'Informar pagamento'}
        </Button>
      )}
      {open && (
        <form onSubmit={submit} className="mt-3 space-y-3">
          <Notice>Só registra o que foi pago ao fornecedor. Não movimenta dinheiro nem consulta o banco.</Notice>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Data do pagamento" required>
              {(id) => <Input id={id} type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} required />}
            </Field>
            <Field label="Valor pago (R$)" required>
              {(id) => <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />}
            </Field>
          </div>
          <Field label="Referência" hint="Ex.: PIX, boleto, número do comprovante.">
            {(id) => <Input id={id} value={ref} onChange={(e) => setRef(e.target.value)} maxLength={120} />}
          </Field>
          {error && <Notice tone="bad">{error}</Notice>}
          <div className="flex gap-2">
            <Button variant="primary" busy={busy}>
              Registrar
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Fechar
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
}

export function ShippingPanel({ order, canEdit, onChange }: { order: { id: string; status: string; carrier: string | null; tracking_code: string | null }; canEdit: boolean; onChange: (o: never) => void }) {
  const [carrier, setCarrier] = useState(order.carrier ?? '');
  const [tracking, setTracking] = useState(order.tracking_code ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const editable = canEdit && ['approved', 'sent', 'partial'].includes(order.status);
  if (!editable && !order.carrier && !order.tracking_code) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await api(`/admin/purchase-orders/${order.id}/shipping`, { method: 'PATCH', body: { carrier: carrier.trim() || null, trackingCode: tracking.trim() || null } });
      onChange(r.order as never);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Transporte do fornecedor">
      {editable ? (
        <form onSubmit={submit} className="space-y-3">
          <Field label="Transportadora">{(id) => <Input id={id} value={carrier} onChange={(e) => setCarrier(e.target.value)} maxLength={80} />}</Field>
          <Field label="Código de rastreio">{(id) => <Input id={id} value={tracking} onChange={(e) => setTracking(e.target.value)} maxLength={60} />}</Field>
          {error && <Notice tone="bad">{error}</Notice>}
          <Button busy={busy}>Salvar transporte</Button>
        </form>
      ) : (
        <p className="text-sm">
          {order.carrier ?? '—'}
          {order.tracking_code && <span className="block font-mono text-xs text-ink-soft">{order.tracking_code}</span>}
        </p>
      )}
    </Panel>
  );
}

type Candidate = { item_id: string; allocation_id: string; order_id: string; order_number: number; paid_at: string | null; sku: string; product_name: string; base_qty: string; unlinked: string };

/** Encomendas de clientes vinculadas: prioridade na chegada desta compra, sem exclusividade (D6-2). */
export function LinksPanel({
  order,
  canManage,
  onChange,
}: {
  order: { id: string; status: string; links: PoLink[]; conversions: PoConversion[]; items: { id: string; product_name: string; base_unit: string }[] };
  canManage: boolean;
  onChange: (o: never) => void;
}) {
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [error, setError] = useState('');
  const open = ['draft', 'pending_approval', 'approved', 'sent', 'partial'].includes(order.status);
  const itemName = Object.fromEntries(order.items.map((i) => [i.id, i]));
  useEffect(() => {
    if (canManage && open) api(`/admin/purchase-orders/${order.id}/link-candidates`).then((r) => setCands(r.items), () => setCands([]));
  }, [order.id, order.links.length, canManage, open]);

  const link = async (c: Candidate) => {
    setError('');
    try {
      const r = await api(`/admin/purchase-orders/${order.id}/links`, { method: 'POST', body: { itemId: c.item_id, allocationId: c.allocation_id } });
      onChange(r.order as never);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const unlink = async (l: PoLink) => {
    const reason = window.prompt('Por que cancelar o vínculo? A encomenda volta para a fila comum.');
    if (!reason) return;
    setError('');
    try {
      const r = await api(`/admin/purchase-orders/${order.id}/links/${l.id}/cancel`, { method: 'POST', body: { reason } });
      onChange(r.order as never);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (!order.links.length && !order.conversions.length && !(cands && cands.length)) return null;

  return (
    <Panel title="Encomendas de clientes" description="A vinculada tem prioridade quando esta compra chega. Não é exclusiva: sem vínculo, vale a ordem de pagamento.">
      {error && (
        <div className="mb-3">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
      {order.links.length > 0 && (
        <ul className="divide-y divide-line text-sm" data-testid="po-links">
          {order.links.map((l) => {
            const st = l.reservation_state ? RES_STATE[l.reservation_state] : undefined;
            return (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <Link href={`/painel/pedidos/${l.order_id}`} className="font-medium underline underline-offset-2">
                    Pedido nº {l.order_number}
                  </Link>{' '}
                  · {qty(l.base_qty)} {itemName[l.item_id]?.base_unit} de {itemName[l.item_id]?.product_name}
                  {l.status === 'canceled' && <span className="block text-xs text-ink-faint">Vínculo cancelado: {l.cancel_reason}</span>}
                </span>
                <span className="flex items-center gap-2">
                  {l.status === 'active' ? st && <Badge tone={st.tone}>{st.label}</Badge> : <Badge tone="neutral">Cancelado</Badge>}
                  {canManage && open && l.status === 'active' && (
                    <Button variant="ghost" onClick={() => unlink(l)}>
                      Cancelar vínculo
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {canManage && open && cands && cands.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-xs font-medium text-ink-soft">Encomendas que esta compra pode atender</p>
          <ul className="divide-y divide-line text-sm">
            {cands.map((c) => (
              <li key={`${c.item_id}:${c.allocation_id}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  Pedido nº {c.order_number} · {qty(c.unlinked)} de {c.product_name}
                  {c.paid_at && <span className="block text-xs text-ink-faint">Pago em {when(c.paid_at)}</span>}
                </span>
                <Button onClick={() => link(c)}>Vincular</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {order.conversions.length > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          <p className="mb-1 text-xs font-medium text-ink-soft">Atendidas na chegada desta compra</p>
          <ul className="space-y-0.5 text-sm" data-testid="po-conversions">
            {order.conversions.map((c) => (
              <li key={c.id}>
                Pedido nº {c.order_number}: {qty(c.qty)} ({RULE[c.rule] ?? c.rule})
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-ink-faint">A separação, a nota fiscal e o despacho seguem pela expedição.</p>
        </div>
      )}
    </Panel>
  );
}

export function IssuesPanel({ issues, items }: { issues: PoIssue[]; items: { id: string; product_name: string; base_unit: string }[] }) {
  if (!issues.length) return null;
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  return (
    <Panel title="Divergências do recebimento" description="Registro permanente: correção é um novo registro.">
      <ul className="divide-y divide-line text-sm" data-testid="po-issues">
        {issues.map((x) => (
          <li key={x.id} className="py-2">
            <span className="font-medium">{ISSUE[x.kind] ?? x.kind}</span> · {byId[x.item_id]?.product_name}
            {x.kind === 'quality' && x.qty && (
              <span>
                {' '}
                · {qty(x.qty)} {byId[x.item_id]?.base_unit} para {DEST[x.destination ?? ''] ?? x.destination}
              </span>
            )}
            {x.kind === 'price' && (
              <span>
                {' '}
                · pedido {money(Number(x.expected))}, nota {money(Number(x.found))}
              </span>
            )}
            {x.kind === 'quantity' && x.expected !== null && (
              <span>
                {' '}
                · esperado {qty(x.expected)}, chegou {qty(x.found ?? 0)}
              </span>
            )}
            <span className="block text-xs text-ink-soft">
              {x.note} — {x.actor_name}, {when(x.created_at)}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function EventsPanel({ events }: { events: PoEvent[] }) {
  if (!events.length) return null;
  return (
    <Panel title="Histórico da compra">
      <ol className="space-y-1.5 text-sm" data-testid="po-events">
        {events.map((e) => (
          <li key={e.id}>
            <span className="font-medium">{EVENT[e.kind] ?? e.kind}</span> · {e.actor_name} · <span className="text-ink-soft">{when(e.created_at)}</span>
            {e.note && <span className="block text-xs text-ink-soft">{e.note}</span>}
            {Array.isArray(e.data?.pendingOrders) && (e.data.pendingOrders as { order_number: number }[]).length > 0 && (
              <span className="block text-xs text-warn">
                Encomendas que ficaram pendentes: {(e.data.pendingOrders as { order_number: number }[]).map((p) => `nº ${p.order_number}`).join(', ')}
              </span>
            )}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

/** Destino da compra (deposito) e finalidade, no formulario. */
export function WarehouseSelect({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const [list, setList] = useState<{ id: string; name: string; active: boolean; is_default: boolean }[]>([]);
  useEffect(() => {
    api('/admin/warehouses').then((r) => setList((r.items ?? r.warehouses ?? []).filter((w: { active: boolean }) => w.active)), () => setList([]));
  }, []);
  return (
    <Field label="Depósito de destino" hint="O recebimento só é aceito neste depósito.">
      {(id) => (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          <option value="">Depósito padrão</option>
          {list.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
              {w.is_default ? ' (padrão)' : ''}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

/** Regras da compra (D6-3 limite de aprovacao, D6-12 tolerancia de preco). Ver todos; alterar so com settings.manage e MFA. */
export function PurchaseRules({ canEdit }: { canEdit: boolean }) {
  const [s, setS] = useState<{ approvalMinCents: number; priceTolerancePct: string; confirmationDays?: number } | null>(null);
  const [min, setMin] = useState('');
  const [tol, setTol] = useState('');
  const [days, setDays] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api('/admin/purchase-orders/settings').then((r) => setS(r.settings), () => setS(null));
  }, []);
  if (!s) return null;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const cents = parseMoney(min);
    const pct = Number(tol.replace(',', '.'));
    const d = Number(days);
    if (cents === null || !Number.isFinite(pct)) return setError('Informe o limite e a tolerância.');
    if (!Number.isInteger(d) || d < 1 || d > 30) return setError('Prazo de confirmação: de 1 a 30 dias.');
    setBusy(true);
    try {
      const r = await api('/admin/purchase-orders/settings', { method: 'PUT', body: { approvalMinCents: cents, priceTolerancePct: pct, confirmationDays: d } });
      setS(r.settings);
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Regras da compra" className="mb-4">
      <p className="text-sm" data-testid="purchase-rules">
        {s.approvalMinCents === 0 ? 'Toda compra passa por aprovação.' : `Compras abaixo de ${money(s.approvalMinCents)} são aprovadas automaticamente.`} Preço da nota acima de{' '}
        {Number(s.priceTolerancePct).toLocaleString('pt-BR')}% de diferença exige justificativa; na confirmação do fornecedor, aumento acima disso exige aprovação.
        {s.confirmationDays ? ` O fornecedor tem ${s.confirmationDays} dia(s) corrido(s) para confirmar o pedido.` : ''}
      </p>
      {canEdit && !open && (
        <Button className="mt-2" onClick={() => (setMin(String(s.approvalMinCents / 100).replace('.', ',')), setTol(String(Number(s.priceTolerancePct)).replace('.', ',')), setDays(String(s.confirmationDays ?? 2)), setOpen(true))}>
          Alterar regras
        </Button>
      )}
      {open && (
        <form onSubmit={save} className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Aprovar automaticamente abaixo de (R$)" hint="0 = toda compra passa por aprovação.">
            {(id) => <Input id={id} inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} />}
          </Field>
          <Field label="Tolerância de preço da nota (%)">{(id) => <Input id={id} inputMode="decimal" value={tol} onChange={(e) => setTol(e.target.value)} />}</Field>
          <Field label="Prazo para o fornecedor confirmar (dias)" hint="Dias corridos desde o envio. Depois disso, a compra aparece como confirmação atrasada.">
            {(id) => <Input id={id} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />}
          </Field>
          {error && (
            <div className="sm:col-span-2">
              <Notice tone="bad">{error}</Notice>
            </div>
          )}
          <div className="flex gap-2 sm:col-span-2">
            <Button variant="primary" busy={busy}>
              Salvar
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Fechar
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
}
