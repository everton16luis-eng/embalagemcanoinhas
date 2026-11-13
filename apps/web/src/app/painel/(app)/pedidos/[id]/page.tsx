'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { DOC_STATUS } from '@/components/fiscal';
import { CHANNEL_LABEL, INVOICE_STATUS, METHOD_LABEL, ORDER_STATUS, PAYMENT_STATUS } from '@/components/orders';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Field, Input, Notice, PageHeader, Panel, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { money, qty, when } from '@/lib/format';

type Order = {
  id: string;
  number: number;
  status: string;
  channel: string;
  // Vendas de marketplace trazem so o nome (os dados do comprador ficam na plataforma).
  buyer: { kind?: string; name: string; email?: string | null; phone?: string | null; document?: string | null; stateRegistration?: string | null };
  ship_to: { recipient: string; cep: string; street: string; number: string; complement?: string | null; district: string; city: string; uf: string } | null;
  shipping_snapshot: { name: string; kind: string; minDays: number; maxDays: number; carrier?: { service: string; company: string | null; serviceName: string } };
  payment_method: string;
  subtotal_cents: string;
  discount_cents: string;
  freight_cents: string;
  total_cents: string;
  notes: string | null;
  invoice_status: string;
  has_backorder: boolean;
  payment_due_at: string;
  paid_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  version: number;
  items: { id: string; sku: string; product_name: string; packaging_label: string; base_qty_per_pack: string; packs: number; list_price_cents: string; unit_price_cents: string; total_cents: string; made_to_order: boolean; lead_time_days: number | null }[];
  payments: { id: string; method: string; status: string; status_detail: string | null; amount_cents: string; card_last_four: string | null; card_brand: string | null; installments: number | null; created_at: string; provider: string; provider_payment_id: string | null }[];
  events: { status: string; note: string | null; created_at: string; actor_name: string | null }[];
  shipment: { carrier: string | null; tracking_code: string | null; tracking_url: string | null; volumes: number | null; shipped_at: string | null; delivered_at: string | null } | null;
  reservations: { id: string; sku: string; qty: string; backorder: boolean; status: string }[];
};

type FiscalCheck = {
  ready: boolean;
  environment: string;
  issues: { code: string; message: string; productId?: string }[];
  documents: { id: string; ref: string; status: string; number: string | null; series: string | null; sefaz_message: string | null; created_at: string; authorized_at: string | null }[];
};

/** Nota fiscal do pedido: conferencia, emissao e situacao. */
function InvoicePanel({ order, onChange }: { order: Order; onChange: () => void }) {
  const { can, me } = useMe();
  const [f, setF] = useState<FiscalCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null);
  const load = useCallback(() => api<FiscalCheck>(`/admin/fiscal/orders/${order.id}`).then(setF, (e) => setMsg({ tone: 'bad', text: e.message })), [order.id]);
  useEffect(() => {
    load();
  }, [load, order.invoice_status]);
  if (!f) return msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null;
  const active = f.documents.find((d) => ['pending', 'processing', 'authorized'].includes(d.status));
  const manage = can('fiscal.manage') && me.user.mfaEnabled;
  const open = ['paid', 'preparing', 'ready'].includes(order.status);
  const call = async (path: string, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ warning?: string | null; document: { status: string; sefaz_message: string | null } }>(path, { method: 'POST' });
      if (r.warning) setMsg({ tone: 'warn', text: `${r.warning} A rotina tenta de novo a cada minuto.` });
      else if (r.document.status === 'rejected') setMsg({ tone: 'bad', text: `Rejeitada: ${r.document.sefaz_message ?? 'veja o detalhe da nota.'}` });
      else if (r.document.status === 'authorized') setMsg({ tone: 'good', text: ok });
      else setMsg({ tone: 'warn', text: 'Nota em processamento na SEFAZ. A situação é atualizada sozinha.' });
      await load();
      onChange();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Nota fiscal"
      description={f.environment === 'homologacao' ? 'Ambiente de homologação: notas sem valor fiscal.' : undefined}
      actions={
        <Link href="/painel/fiscal" className="text-sm text-act-dark underline">
          Configuração fiscal
        </Link>
      }
    >
      {msg && (
        <div className="mb-3">
          <Notice tone={msg.tone}>{msg.text}</Notice>
        </div>
      )}
      {f.documents.length > 0 && (
        <ul className="mb-3 space-y-1.5 text-sm">
          {f.documents.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2">
              <Badge tone={DOC_STATUS[d.status]!.tone}>{DOC_STATUS[d.status]!.label}</Badge>
              <Link href={`/painel/fiscal/notas/${d.id}`} className="font-medium text-act-dark underline">
                {d.number ? `NF-e nº ${d.number}` : d.ref}
              </Link>
              <span className="text-xs text-ink-faint">{when(d.authorized_at ?? d.created_at)}</span>
              {d.status === 'rejected' && d.sefaz_message && <span className="w-full text-[13px] text-bad">{d.sefaz_message}</span>}
            </li>
          ))}
        </ul>
      )}
      {!active && open && !f.ready && (
        <div className="text-sm">
          <p className="mb-1 font-medium">Antes de emitir, falta:</p>
          <ul className="list-disc space-y-1 pl-5 text-ink-soft">
            {f.issues.map((i, n) => (
              <li key={n}>
                {i.message}
                {i.productId && (
                  <Link href={`/painel/produtos/${i.productId}`} className="ml-1 text-act-dark underline">
                    abrir produto
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!active && open && f.ready && manage && (
        <Button variant="primary" busy={busy} onClick={() => call(`/admin/fiscal/orders/${order.id}/emit`, 'NF-e autorizada.')}>
          {f.documents.some((d) => d.status === 'rejected') ? 'Emitir de novo' : 'Emitir NF-e'}
        </Button>
      )}
      {!active && open && f.ready && !manage && <p className="text-sm text-ink-soft">Pronto para emitir. A emissão é feita por quem tem a permissão fiscal com verificação em duas etapas.</p>}
      {active && active.status !== 'authorized' && manage && (
        <Button busy={busy} onClick={() => call(`/admin/fiscal/documents/${active.id}/sync`, 'NF-e autorizada.')}>
          Consultar situação agora
        </Button>
      )}
      {!active && !open && f.documents.length === 0 && <p className="text-sm text-ink-soft">{order.status === 'pending_payment' ? 'A nota é emitida depois do pagamento.' : 'Sem nota.'}</p>}
    </Panel>
  );
}

const doc = (d: string) => (d.length === 11 ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : d.replace(/(\w{2})(\w{3})(\w{3})(\w{4})(\d{2})/, '$1.$2.$3/$4-$5'));
const phone = (p: string) => p.replace(/^(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3');

function Detail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useMe();
  const [o, setO] = useState<Order | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [ship, setShip] = useState({ carrier: '', trackingCode: '', trackingUrl: '', volumes: '1' });

  const load = useCallback(() => api<{ order: Order }>(`/admin/orders/${id}`).then((r) => setO(r.order), (e) => setError(e.message)), [id]);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (name: string, path: string, body: Record<string, unknown>, done?: string) => {
    if (!o) return;
    setBusy(name);
    setError('');
    setMsg('');
    try {
      const r = await api<{ order: Order; refundNeeded?: boolean }>(`/admin/orders/${id}/${path}`, { method: 'POST', body: { version: o.version, ...body } });
      await load();
      setMsg(r.refundNeeded ? 'Pedido cancelado. Ele estava pago: faça a devolução do valor no painel do Mercado Pago.' : (done ?? ''));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  if (!o) return error ? <Notice tone="bad">{error}</Notice> : <p className="text-sm text-ink-soft">Carregando…</p>;
  const st = ORDER_STATUS[o.status]!;
  const open = ['paid', 'preparing', 'ready'].includes(o.status);

  const dispatch = (e: FormEvent) => {
    e.preventDefault();
    act('dispatch', 'dispatch', {
      carrier: ship.carrier || null,
      trackingCode: ship.trackingCode || null,
      trackingUrl: ship.trackingUrl || null,
      volumes: ship.volumes ? Number(ship.volumes) : null,
    }, 'Pedido despachado e estoque baixado.');
  };

  return (
    <>
      <PageHeader
        title={`Pedido nº ${o.number}`}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={st.tone}>{st.label}</Badge>
            <Badge tone={INVOICE_STATUS[o.invoice_status]!.tone}>{INVOICE_STATUS[o.invoice_status]!.label}</Badge>
            {o.has_backorder && <Badge tone="warn">Tem item sob encomenda</Badge>}
            <span>Criado {when(o.created_at)}</span>
          </span>
        }
        actions={
          <Link href="/painel/pedidos">
            <Button>Voltar</Button>
          </Link>
        }
      />
      {error && (
        <div className="mb-4">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
      {msg && (
        <div className="mb-4">
          <Notice tone="good">{msg}</Notice>
        </div>
      )}
      {o.cancel_reason && (
        <div className="mb-4">
          <Notice tone="bad">Cancelado: {o.cancel_reason}</Notice>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-4">
          <Panel title="Itens">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-ink-soft">
                  <tr>
                    <th className="pb-2 font-medium">Produto</th>
                    <th className="pb-2 pl-3 text-right font-medium">Qtd.</th>
                    <th className="pb-2 pl-3 text-right font-medium">Preço</th>
                    <th className="pb-2 pl-3 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {o.items.map((i) => (
                    <tr key={i.id}>
                      <td className="py-2">
                        <span className="font-medium">{i.product_name}</span>
                        <span className="block text-xs text-ink-faint">
                          {i.sku} · {i.packaging_label} ({qty(i.base_qty_per_pack)} un.)
                          {i.made_to_order && ` · sob encomenda${i.lead_time_days ? `, ${i.lead_time_days} dias` : ''}`}
                        </span>
                      </td>
                      <td className="num py-2 pl-3 text-right">{i.packs}</td>
                      <td className="num py-2 pl-3 text-right">
                        {money(i.unit_price_cents)}
                        {i.unit_price_cents !== i.list_price_cents && <span className="block text-xs text-ink-faint line-through">{money(i.list_price_cents)}</span>}
                      </td>
                      <td className="num py-2 pl-3 text-right">{money(i.total_cents)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="text-sm">
                  <tr>
                    <td colSpan={3} className="pt-3 text-right text-ink-soft">Subtotal</td>
                    <td className="num pt-3 text-right">{money(o.subtotal_cents)}</td>
                  </tr>
                  <tr>
                    <td colSpan={3} className="text-right text-ink-soft">Frete ({o.shipping_snapshot.name})</td>
                    <td className="num text-right">{money(o.freight_cents)}</td>
                  </tr>
                  <tr className="font-semibold">
                    <td colSpan={3} className="pt-1 text-right">Total</td>
                    <td className="num pt-1 text-right">{money(o.total_cents)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {o.notes && <p className="mt-3 rounded-md bg-sunken px-3 py-2 text-sm">Observação do cliente: {o.notes}</p>}
          </Panel>

          {open && (can('orders.manage') || can('shipping.manage')) && (
            <Panel title="Atendimento" description="Pago → em separação → pronto → despachado. O despacho só é liberado com a NF-e autorizada.">
              <div className="flex flex-wrap gap-2">
                {o.status === 'paid' && can('orders.manage') && (
                  <Button variant="primary" busy={busy === 'preparing'} onClick={() => act('preparing', 'status', { to: 'preparing' }, 'Pedido em separação.')}>
                    Iniciar separação
                  </Button>
                )}
                {o.status === 'preparing' && can('orders.manage') && (
                  <Button variant="primary" busy={busy === 'ready'} onClick={() => act('ready', 'status', { to: 'ready' }, 'Pedido pronto para nota e despacho.')}>
                    Marcar como pronto
                  </Button>
                )}
                {can('orders.manage') && !cancelling && (
                  <Button variant="ghost" onClick={() => setCancelling(true)}>
                    Cancelar pedido
                  </Button>
                )}
              </div>
              {cancelling && (
                <form
                  className="mt-3 space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act('cancel', 'cancel', { reason }).then(() => setCancelling(false));
                  }}
                >
                  <Field label="Motivo do cancelamento" required>
                    {(fid) => <Textarea id={fid} required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />}
                  </Field>
                  <p className="text-[13px] text-ink-soft">A reserva de estoque volta para o disponível. Pedido pago precisa de devolução no Mercado Pago.</p>
                  <div className="flex gap-2">
                    <Button type="submit" variant="danger" busy={busy === 'cancel'}>
                      Confirmar cancelamento
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setCancelling(false)}>
                      Voltar
                    </Button>
                  </div>
                </form>
              )}
              {o.status === 'ready' && can('shipping.manage') && (
                <form onSubmit={dispatch} className="mt-4 border-t border-line pt-4">
                  <p className="mb-2 text-sm font-semibold">Despacho</p>
                  {o.invoice_status !== 'authorized' && o.invoice_status !== 'not_required' && (
                    <div className="mb-3">
                      <Notice tone="warn">A NF-e deste pedido ainda não foi autorizada. O despacho fica bloqueado até a autorização.</Notice>
                    </div>
                  )}
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field label="Transportadora ou entregador">{(fid) => <Input id={fid} value={ship.carrier} onChange={(e) => setShip({ ...ship, carrier: e.target.value })} placeholder={o.shipping_snapshot.kind === 'pickup' ? 'Retirada no balcão' : ''} />}</Field>
                    <Field label="Volumes">{(fid) => <Input id={fid} inputMode="numeric" value={ship.volumes} onChange={(e) => setShip({ ...ship, volumes: e.target.value.replace(/\D/g, '') })} />}</Field>
                    <Field label="Código de rastreio">{(fid) => <Input id={fid} value={ship.trackingCode} onChange={(e) => setShip({ ...ship, trackingCode: e.target.value })} />}</Field>
                    <Field label="Link de rastreio">{(fid) => <Input id={fid} type="url" value={ship.trackingUrl} onChange={(e) => setShip({ ...ship, trackingUrl: e.target.value })} />}</Field>
                  </div>
                  <Button type="submit" variant="primary" className="mt-3" busy={busy === 'dispatch'} disabled={o.invoice_status !== 'authorized' && o.invoice_status !== 'not_required'}>
                    Despachar e baixar estoque
                  </Button>
                </form>
              )}
            </Panel>
          )}
          {o.status === 'shipped' && can('shipping.manage') && (
            <Panel title="Entrega">
              <Button variant="primary" busy={busy === 'deliver'} onClick={() => act('deliver', 'deliver', {}, 'Entrega registrada.')}>
                Marcar como entregue
              </Button>
            </Panel>
          )}

          {can('fiscal.view') && <InvoicePanel order={o} onChange={load} />}

          <Panel title="Histórico">
            <ol className="space-y-2 text-sm">
              {o.events.map((e, i) => (
                <li key={i} className="flex gap-3">
                  <span className="num w-32 shrink-0 text-xs text-ink-faint">{when(e.created_at)}</span>
                  <span>
                    <span className="font-medium">{e.status === 'invoice' ? 'Nota fiscal' : (ORDER_STATUS[e.status]?.label ?? e.status)}</span>
                    {e.note && <span className="text-ink-soft"> — {e.note}</span>}
                    {e.actor_name && <span className="text-ink-faint"> · {e.actor_name}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
        </div>

        <div className="min-w-0 space-y-4">
          <Panel title="Cliente">
            <p className="font-medium">{o.buyer.name}</p>
            {(o.buyer.document || o.buyer.stateRegistration) && (
              <p className="text-sm text-ink-soft">
                {o.buyer.document && `${o.buyer.kind === 'pj' ? 'CNPJ' : 'CPF'} ${doc(o.buyer.document)}`}
                {o.buyer.stateRegistration && ` · IE ${o.buyer.stateRegistration}`}
              </p>
            )}
            {o.buyer.email && <p className="mt-1 text-sm break-all">{o.buyer.email}</p>}
            {o.buyer.phone && (
              <>
                <p className="text-sm">{phone(o.buyer.phone)}</p>
                <a className="mt-2 inline-block text-sm text-act-dark underline" href={`https://wa.me/55${o.buyer.phone}`} target="_blank" rel="noreferrer">
                  Conversar no WhatsApp
                </a>
              </>
            )}
          </Panel>
          <Panel title="Entrega">
            <p className="text-sm font-medium">{o.shipping_snapshot.name}</p>
            {o.shipping_snapshot.carrier && (
              <p className="text-[13px] text-ink-faint">
                Cotado: {[o.shipping_snapshot.carrier.company, o.shipping_snapshot.carrier.serviceName].filter(Boolean).join(' · ')} (serviço {o.shipping_snapshot.carrier.service})
              </p>
            )}
            {o.ship_to ? (
              <p className="mt-1 text-sm text-ink-soft">
                {o.ship_to.recipient}
                <br />
                {o.ship_to.street}, {o.ship_to.number}
                {o.ship_to.complement ? ` – ${o.ship_to.complement}` : ''}
                <br />
                {o.ship_to.district} · {o.ship_to.city}/{o.ship_to.uf} · CEP {o.ship_to.cep.replace(/(\d{5})(\d{3})/, '$1-$2')}
              </p>
            ) : o.shipping_snapshot.kind === 'marketplace' ? (
              <p className="mt-1 text-sm text-ink-soft">Endereço e etiqueta ficam na plataforma do marketplace.</p>
            ) : (
              <p className="mt-1 text-sm text-ink-soft">Cliente retira na loja.</p>
            )}
            {o.shipment && (
              <p className="mt-2 text-sm">
                Despachado {when(o.shipment.shipped_at)}
                {o.shipment.carrier && ` · ${o.shipment.carrier}`}
                {o.shipment.tracking_code && ` · ${o.shipment.tracking_code}`}
                {o.shipment.delivered_at && <span className="block">Entregue {when(o.shipment.delivered_at)}</span>}
              </p>
            )}
          </Panel>
          <Panel title="Pagamento">
            <p className="text-sm">
              {METHOD_LABEL[o.payment_method]}
              {o.status === 'pending_payment' && <span className="text-ink-soft"> · prazo até {when(o.payment_due_at)}</span>}
              {o.paid_at && <span className="text-ink-soft"> · pago {when(o.paid_at)}</span>}
            </p>
            <ul className="mt-2 space-y-1.5">
              {o.payments.length === 0 && <li className="text-sm text-ink-faint">{o.payment_method === 'marketplace' ? `Recebido pelo ${CHANNEL_LABEL[o.channel] ?? 'marketplace'}; repasse conforme o contrato da plataforma.` : 'Nenhuma tentativa ainda.'}</li>}
              {o.payments.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-1.5 text-sm">
                  <Badge tone={PAYMENT_STATUS[p.status]!.tone}>{PAYMENT_STATUS[p.status]!.label}</Badge>
                  <span className="num">{money(p.amount_cents)}</span>
                  {p.card_last_four && (
                    <span className="text-ink-soft">
                      {p.card_brand} final {p.card_last_four}
                      {p.installments && p.installments > 1 ? ` em ${p.installments}x` : ''}
                    </span>
                  )}
                  {p.provider_payment_id && <span className="text-xs text-ink-faint">MP {p.provider_payment_id}</span>}
                  {p.provider === 'fake' && <span className="text-xs text-ink-faint">(simulado)</span>}
                </li>
              ))}
            </ul>
          </Panel>
          {o.reservations.length > 0 && (
            <Panel title="Estoque reservado">
              <ul className="space-y-1 text-sm">
                {o.reservations.map((r) => (
                  <li key={r.id} className="flex justify-between gap-2">
                    <span>{r.sku}</span>
                    <span className="num">
                      {qty(r.qty)} {r.backorder ? '(encomenda)' : ''} · {r.status === 'active' ? 'reservado' : r.status === 'consumed' ? 'baixado' : 'liberado'}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="orders.view">
      <Detail />
    </Guard>
  );
}
