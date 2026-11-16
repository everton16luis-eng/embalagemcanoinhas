'use client';

import { Copy, MessageCircle } from 'lucide-react';
import Link from '@/components/painel-link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ORDER_STATUS } from '@/components/orders';
import { phoneText, QUOTE_STATUS, quoteState, waLink } from '@/components/sales';
import { Guard } from '@/components/shell';
import { newKey } from '@/components/stock';
import { Badge, Button, Field, Input, Notice, PageHeader, Panel, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { formatCnpj, money, when } from '@/lib/format';

type Quote = {
  id: string;
  number: number;
  status: string;
  expired: boolean;
  buyer: { kind: 'pf' | 'pj'; name: string; phone: string; email: string | null; document: string | null };
  ship_to: Record<string, string> | null;
  shipping_snapshot: { name: string; kind: string } | null;
  subtotal_cents: string;
  discount_cents: string;
  freight_cents: string;
  total_cents: string;
  notes: string | null;
  valid_until: string;
  order_id: string | null;
  order_number: number | null;
  order_status: string | null;
  cancel_reason: string | null;
  created_at: string;
  created_by_name: string;
  token: string;
  missing: string[];
  items: { id: string; sku: string; product_name: string; packaging_label: string; packs: number; unit_price_cents: string; list_price_cents: string; total_cents: string; made_to_order: boolean; lead_time_days: number | null }[];
  events: { kind: string; note: string | null; created_at: string; actor_name: string | null }[];
};
type ShipOption = { id: string; name: string; kind: 'pickup' | 'delivery'; active: boolean };

const EVENT: Record<string, string> = { created: 'Criado', shared: 'Compartilhado', converted: 'Virou pedido', canceled: 'Cancelado', duplicated: 'Copiado' };
const day = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR');
const docText = (b: Quote['buyer']) => (!b.document ? '—' : b.kind === 'pj' ? formatCnpj(b.document) : b.document.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4'));

function Convert({ quote, onDone }: { quote: Quote; onDone: (q: Quote, orderToken: string) => void }) {
  const [method, setMethod] = useState<'pix' | 'card'>('pix');
  const [email, setEmail] = useState('');
  const [document, setDocument] = useState('');
  const [ships, setShips] = useState<ShipOption[]>([]);
  const [shipId, setShipId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!quote.shipping_snapshot) api<{ options: ShipOption[] }>('/admin/shipping-options').then((r) => setShips(r.options.filter((o) => o.active && o.kind === 'pickup')), () => null);
  }, [quote.shipping_snapshot]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ quote: Quote; orderToken: string }>(`/admin/sales-desk/quotes/${quote.id}/convert`, {
        method: 'POST',
        body: {
          paymentMethod: method,
          buyer: { email: email.trim() || null, document: document.trim() || null },
          shippingOptionId: quote.shipping_snapshot ? null : shipId || null,
        },
      });
      onDone(r.quote, r.orderToken);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Gerar pedido" description="Com os preços deste orçamento. O estoque é reservado e o cliente recebe o link para pagar.">
      <form onSubmit={submit} className="grid gap-3">
        {error && <Notice tone="bad">{error}</Notice>}
        <Field label="Pagamento">
          {(id) => (
            <Select id={id} value={method} onChange={(e) => setMethod(e.target.value as 'pix' | 'card')}>
              <option value="pix">Pix</option>
              <option value="card">Cartão</option>
            </Select>
          )}
        </Field>
        {quote.missing.includes('email') && <Field label="E-mail do cliente" required>{(id) => <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>}
        {quote.missing.includes('document') && (
          <Field label={quote.buyer.kind === 'pj' ? 'CNPJ' : 'CPF'} required>
            {(id) => <Input id={id} required value={document} onChange={(e) => setDocument(e.target.value)} />}
          </Field>
        )}
        {!quote.shipping_snapshot && (
          <Field label="Entrega" required hint="Entrega com endereço: envie o link para o cliente escolher e informar o endereço.">
            {(id) => (
              <Select id={id} required value={shipId} onChange={(e) => setShipId(e.target.value)}>
                <option value="">Escolha</option>
                {ships.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Button type="submit" variant="primary" busy={busy}>
          Gerar pedido
        </Button>
      </form>
    </Panel>
  );
}

function Detail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [q, setQ] = useState<Quote | null>(null);
  const [orderToken, setOrderToken] = useState('');
  const [origin, setOrigin] = useState('');
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
    api<{ quote: Quote }>(`/admin/sales-desk/quotes/${id}`).then((r) => setQ(r.quote), (e) => setError(e.message));
  }, [id]);
  if (!q) return error ? <Notice tone="bad">{error}</Notice> : <p className="text-sm text-ink-soft">Carregando…</p>;

  const state = quoteState(q);
  const s = QUOTE_STATUS[state]!;
  const link = `${origin}/orcamento/${q.token}`;
  const quoteMsg = `Olá, ${q.buyer.name.split(' ')[0]}! Segue o orçamento Nº ${q.number} (${money(q.total_cents)}), válido até ${day(q.valid_until)}:\n${link}`;
  const payLink = orderToken ? `${origin}/pedido/${orderToken}` : '';
  const shared = (channel: 'whatsapp' | 'link') => void api(`/admin/sales-desk/quotes/${q.id}/shared`, { method: 'POST', body: { channel } }).then((r) => setQ(r.quote), () => null);
  const run = async (fn: () => Promise<{ quote: Quote }>) => {
    setError('');
    try {
      const r = await fn();
      if (r.quote.id !== q.id) router.push(`/painel/orcamentos/${r.quote.id}`);
      else setQ(r.quote);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <PageHeader
        title={`Orçamento Nº ${q.number}`}
        description={`${q.buyer.name} · criado ${when(q.created_at)} por ${q.created_by_name}`}
        actions={<Badge tone={s.tone}>{s.label}</Badge>}
      />
      <p className="mb-4 text-sm">
        <Link href="/painel/orcamentos" className="text-act-dark underline">
          Voltar para Orçamentos
        </Link>
      </p>
      {error && <Notice tone="bad">{error}</Notice>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="grid gap-4">
          <Panel title="Itens">
            <ul className="divide-y divide-line text-sm">
              {q.items.map((i) => (
                <li key={i.id} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2 first:pt-0">
                  <div className="min-w-0">
                    <p className="font-medium">{i.product_name}</p>
                    <p className="text-xs text-ink-faint">
                      {i.sku} · {i.packaging_label}
                      {i.made_to_order && ` · sob encomenda${i.lead_time_days ? ` (${i.lead_time_days} dias)` : ''}`}
                    </p>
                  </div>
                  <p className="num text-right">
                    {i.packs} × {money(i.unit_price_cents)} = <strong>{money(i.total_cents)}</strong>
                  </p>
                </li>
              ))}
            </ul>
            <dl className="mt-3 grid grid-cols-[1fr_auto] gap-y-1 border-t border-line pt-3 text-sm">
              <dt className="text-ink-soft">Itens</dt>
              <dd className="num text-right">{money(q.subtotal_cents)}</dd>
              {Number(q.discount_cents) > 0 && (
                <>
                  <dt className="text-ink-soft">Desconto</dt>
                  <dd className="num text-right">− {money(q.discount_cents)}</dd>
                </>
              )}
              <dt className="text-ink-soft">Entrega{q.shipping_snapshot ? ` · ${q.shipping_snapshot.name}` : ' · a combinar'}</dt>
              <dd className="num text-right">{money(q.freight_cents)}</dd>
              <dt className="font-semibold">Total</dt>
              <dd className="num text-right font-semibold">{money(q.total_cents)}</dd>
            </dl>
            {q.notes && <p className="mt-3 text-sm text-ink-soft">Obs.: {q.notes}</p>}
          </Panel>

          <Panel title="Histórico">
            <ol className="grid gap-1.5 text-sm">
              {q.events.map((e, i) => (
                <li key={i}>
                  <span className="font-medium">{EVENT[e.kind] ?? e.kind}</span>
                  {e.note && ` · ${e.note}`}
                  <span className="text-ink-faint">
                    {' '}
                    · {when(e.created_at)}
                    {e.actor_name && ` · ${e.actor_name}`}
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
        </div>

        <div className="grid content-start gap-4">
          <Panel title="Cliente">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-ink-soft">WhatsApp</dt>
              <dd>{phoneText(q.buyer.phone)}</dd>
              <dt className="text-ink-soft">E-mail</dt>
              <dd className="break-all">{q.buyer.email ?? '—'}</dd>
              <dt className="text-ink-soft">{q.buyer.kind === 'pj' ? 'CNPJ' : 'CPF'}</dt>
              <dd>{docText(q.buyer)}</dd>
              <dt className="text-ink-soft">Validade</dt>
              <dd>{day(q.valid_until)}</dd>
            </dl>
            {q.ship_to && (
              <p className="mt-2 text-sm text-ink-soft">
                {q.ship_to.street}, {q.ship_to.number} · {q.ship_to.district} · {q.ship_to.city}/{q.ship_to.uf}
              </p>
            )}
          </Panel>

          {state === 'open' && (
            <Panel title="Compartilhar" description="O link abre o orçamento; o cliente completa os dados e paga.">
              <div className="flex flex-wrap gap-2">
                <a href={waLink(q.buyer.phone, quoteMsg)} target="_blank" rel="noopener noreferrer" onClick={() => shared('whatsapp')}>
                  <Button variant="primary">
                    <MessageCircle className="size-4" aria-hidden />
                    Enviar no WhatsApp
                  </Button>
                </a>
                <Button
                  onClick={() =>
                    void navigator.clipboard?.writeText(link).then(() => {
                      setCopied(true);
                      shared('link');
                    })
                  }
                >
                  <Copy className="size-4" aria-hidden />
                  {copied ? 'Link copiado' : 'Copiar link'}
                </Button>
              </div>
            </Panel>
          )}

          {(state === 'open' || (q.status === 'converted' && q.order_status === 'canceled' && !q.expired)) && (
            <Convert
              quote={q}
              onDone={(nq, token) => {
                setQ(nq);
                setOrderToken(token);
              }}
            />
          )}

          {q.order_id && (
            <Panel title={`Pedido Nº ${q.order_number}`}>
              <p className="text-sm">
                Situação: <strong>{ORDER_STATUS[q.order_status ?? '']?.label ?? q.order_status}</strong>
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link href={`/painel/pedidos/${q.order_id}`}>
                  <Button>Abrir pedido</Button>
                </Link>
                {payLink && (
                  <a href={waLink(q.buyer.phone, `Pedido Nº ${q.order_number} gerado. Para pagar e acompanhar:\n${payLink}`)} target="_blank" rel="noopener noreferrer">
                    <Button variant="primary">
                      <MessageCircle className="size-4" aria-hidden />
                      Enviar link de pagamento
                    </Button>
                  </a>
                )}
              </div>
              {!payLink && <p className="mt-2 text-xs text-ink-faint">O link de pagamento também aparece para o cliente ao abrir o link do orçamento.</p>}
            </Panel>
          )}

          {(state === 'expired' || q.status !== 'open') && (
            <Button onClick={() => run(() => api(`/admin/sales-desk/quotes/${q.id}/duplicate`, { method: 'POST', body: { requestKey: newKey() } }))}>Novo orçamento com preços atuais</Button>
          )}

          {q.status === 'open' && (
            <Panel title="Cancelar orçamento">
              <form
                className="grid gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() => api(`/admin/sales-desk/quotes/${q.id}/cancel`, { method: 'POST', body: { reason } }));
                }}
              >
                <Textarea aria-label="Motivo" required minLength={3} maxLength={300} placeholder="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-16" />
                <Button type="submit" variant="danger">
                  Cancelar orçamento
                </Button>
              </form>
            </Panel>
          )}
          {q.cancel_reason && <Notice tone="warn">Cancelado: {q.cancel_reason}</Notice>}
        </div>
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="sales_desk.use">
      <Detail />
    </Guard>
  );
}
