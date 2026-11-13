'use client';

import { Check, Copy } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { reais } from './price';

type Payment = { id: string; method: string; status: string; status_detail: string | null; amount_cents: string; pix_qr_code: string | null; pix_qr_base64: string | null; pix_expires_at: string | null; card_last_four: string | null; card_brand: string | null; installments: number | null };
export type Order = {
  id: string;
  number: number;
  status: string;
  buyer: { name: string; email: string };
  ship_to: { recipient: string; cep: string; street: string; number: string; complement?: string | null; district: string; city: string; uf: string } | null;
  shipping_snapshot: { name: string; kind: string; description: string | null; minDays: number; maxDays: number };
  payment_method: 'pix' | 'card';
  subtotal_cents: string;
  freight_cents: string;
  total_cents: string;
  has_backorder: boolean;
  payment_due_at: string;
  paid_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  items: { id: string; sku: string; product_name: string; packaging_label: string; base_qty_per_pack: string; packs: number; unit_price_cents: string; total_cents: string; made_to_order: boolean; lead_time_days: number | null }[];
  payments: Payment[];
  events: { status: string; note: string | null; created_at: string }[];
  shipment: { carrier: string | null; tracking_code: string | null; tracking_url: string | null; shipped_at: string | null; delivered_at: string | null } | null;
};
type PayConfig = { enabled: boolean; provider: 'mercadopago' | 'fake' | null; publicKey: string | null };

const dt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' });
const STEPS = [
  ['pending_payment', 'Pagamento'],
  ['paid', 'Pago'],
  ['preparing', 'Separação'],
  ['ready', 'Pronto'],
  ['shipped', 'Enviado'],
  ['delivered', 'Entregue'],
] as const;
const DONE_TEXT: Record<string, string> = {
  paid: 'Pagamento confirmado. Vamos separar seu pedido.',
  preparing: 'Seu pedido está em separação.',
  ready: 'Pedido separado. A nota fiscal é emitida antes do envio.',
  shipped: 'Pedido enviado.',
  delivered: 'Pedido entregue. Obrigado pela compra!',
};

/** Pedido do cliente: acompanhamento e pagamento. `base` e o caminho na API (link publico ou conta). */
export function OrderView({ base, devToken }: { base: string; devToken?: string }) {
  const [o, setO] = useState<Order | null>(null);
  const [cfg, setCfg] = useState<PayConfig | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<{ order: Order }>(base).then((r) => setO(r.order), (e) => setError(e.message)), [base]);
  useEffect(() => {
    load();
    api<PayConfig>('/public/checkout/payment-config').then(setCfg, () => null);
  }, [load]);

  // Enquanto espera o Pix, consulta a cada 5 segundos (a API confere com o provedor).
  const pix = o?.payments.find((p) => p.method === 'pix' && p.status === 'pending');
  useEffect(() => {
    if (o?.status !== 'pending_payment' || !pix) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [o?.status, pix, load]);

  const post = async (path: string, body: unknown = {}) => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ order: Order }>(`${base}${path}`, { method: 'POST', body });
      setO(r.order);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!o) return <p className="py-10 text-g-soft">{error || 'Carregando pedido…'}</p>;
  const canceled = o.status === 'canceled';
  const stepIndex = STEPS.findIndex(([k]) => k === o.status);
  const lastCard = o.payments.find((p) => p.method === 'card');

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
      <div className="min-w-0">
        <p className="text-[13px] text-g-soft">Feito em {dt.format(new Date(o.created_at))}</p>
        <h1 className="cond border-b-[3px] border-g-ink pb-2 text-[32px] leading-none font-extrabold uppercase">Pedido nº {o.number}</h1>

        {canceled ? (
          <p role="status" className="mt-4 border-[1.5px] border-g-red p-3 text-sm text-g-red">
            Pedido cancelado{o.cancel_reason ? `: ${o.cancel_reason}` : ''}.
          </p>
        ) : (
          <ol className="mt-4 grid grid-cols-3 border border-g-line text-center text-xs font-semibold sm:grid-cols-6">
            {STEPS.map(([k, label], i) => (
              <li key={k} aria-current={i === stepIndex ? 'step' : undefined} className={`border-r border-b border-g-line px-1 py-2 sm:border-b-0 ${i < stepIndex ? 'bg-g-green-tint text-g-green' : i === stepIndex ? 'bg-g-ink text-white' : 'text-g-faint'}`}>
                {label}
              </li>
            ))}
          </ol>
        )}
        {DONE_TEXT[o.status] && <p className="mt-3 font-semibold">{DONE_TEXT[o.status]}</p>}
        {o.shipment?.tracking_code && (
          <p className="mt-1 text-sm">
            Rastreio: {o.shipment.tracking_url ? (
              <a href={o.shipment.tracking_url} target="_blank" rel="noreferrer" className="font-semibold text-g-green underline">
                {o.shipment.tracking_code}
              </a>
            ) : (
              <b>{o.shipment.tracking_code}</b>
            )}
            {o.shipment.carrier && ` · ${o.shipment.carrier}`}
          </p>
        )}

        {o.status === 'pending_payment' && (
          <section className="mt-6 border-2 border-g-ink p-4">
            <h2 className="cond text-xl font-extrabold uppercase">Pagamento · {reais(o.total_cents)}</h2>
            <p className="mt-1 text-[13px] text-g-soft">Pague até {dt.format(new Date(o.payment_due_at))}. Depois disso o pedido é cancelado e o estoque liberado.</p>
            {cfg && !cfg.enabled && <p className="mt-3 text-sm text-g-red">Pagamento online indisponível no momento. Fale com a loja.</p>}
            {cfg?.enabled && o.payment_method === 'pix' && (
              <div className="mt-4">
                {pix?.pix_qr_code ? (
                  <PixBox p={pix} />
                ) : (
                  <button type="button" disabled={busy} onClick={() => post('/pay/pix')} className="bg-g-green px-5 py-3 font-bold text-white disabled:opacity-60">
                    {busy ? 'Gerando…' : 'Gerar código Pix'}
                  </button>
                )}
                {pix && cfg.provider === 'fake' && devToken && (
                  <button type="button" disabled={busy} onClick={() => api<{ order: Order }>(`/public/dev-payments/${devToken}/approve-pix`, { method: 'POST', body: {} }).then((r) => setO(r.order), (e) => setError(e.message))} className="mt-3 block border border-dashed border-g-amber px-3 py-2 text-[13px] text-g-amber">
                    Simular Pix pago (somente ambiente de desenvolvimento)
                  </button>
                )}
              </div>
            )}
            {cfg?.enabled && o.payment_method === 'card' && (
              <div className="mt-4">
                {lastCard?.status === 'rejected' && <p className="mb-3 text-sm font-semibold text-g-red">O cartão foi recusado. Confira os dados ou tente outro cartão.</p>}
                {lastCard?.status === 'pending' ? (
                  <p className="text-sm">Pagamento em análise pelo Mercado Pago. Esta página atualiza quando houver resposta.</p>
                ) : cfg.provider === 'mercadopago' && cfg.publicKey ? (
                  <CardBrick publicKey={cfg.publicKey} amountCents={Number(o.total_cents)} email={o.buyer.email} onToken={(body) => post('/pay/card', body)} />
                ) : cfg.provider === 'fake' ? (
                  <div className="flex flex-wrap gap-2">
                    <p className="w-full text-[13px] text-g-amber">Provedor simulado (desenvolvimento): nenhum cartão real é usado.</p>
                    {(['approve', 'reject'] as const).map((k) => (
                      <button key={k} type="button" disabled={busy} onClick={() => post('/pay/card', { attemptKey: crypto.randomUUID(), token: `${k}-dev-${Date.now()}`, paymentMethodId: 'visa', installments: 1, payer: { email: o.buyer.email } })} className="border-[1.5px] border-g-ink px-3 py-2 text-sm font-semibold">
                        {k === 'approve' ? 'Simular cartão aprovado' : 'Simular cartão recusado'}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
            {error && (
              <p role="alert" className="mt-3 text-sm font-semibold text-g-red">
                {error}
              </p>
            )}
          </section>
        )}

        <h2 className="mt-8 mb-2 text-xs font-bold tracking-[0.06em] uppercase">Itens</h2>
        <ul className="divide-y divide-g-line border-y border-g-line text-sm">
          {o.items.map((i) => (
            <li key={i.id} className="flex justify-between gap-3 py-2.5">
              <span className="min-w-0">
                <span className="block font-semibold [overflow-wrap:anywhere]">{i.product_name}</span>
                <span className="block text-xs text-g-soft">
                  {i.packs} × {i.packaging_label} · {reais(i.unit_price_cents)} cada
                  {i.made_to_order && ` · sob encomenda${i.lead_time_days ? `, ${i.lead_time_days} dias` : ''}`}
                </span>
              </span>
              <span className="num shrink-0">{reais(i.total_cents)}</span>
            </li>
          ))}
        </ul>
      </div>

      <aside className="h-fit space-y-4 text-sm lg:mt-12">
        <div className="border border-g-line p-4">
          <h2 className="mb-2 text-xs font-bold tracking-[0.06em] uppercase">Valores</h2>
          <dl className="space-y-1">
            <div className="flex justify-between">
              <dt>Subtotal</dt>
              <dd className="num">{reais(o.subtotal_cents)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Frete</dt>
              <dd className="num">{Number(o.freight_cents) ? reais(o.freight_cents) : 'sem custo'}</dd>
            </div>
            <div className="flex justify-between border-t-2 border-g-ink pt-1.5 text-base font-extrabold">
              <dt>Total</dt>
              <dd className="num">{reais(o.total_cents)}</dd>
            </div>
          </dl>
          <p className="mt-2 text-[13px] text-g-soft">
            {o.payment_method === 'pix' ? 'Pix' : 'Cartão de crédito'}
            {o.paid_at && ` · pago em ${dt.format(new Date(o.paid_at))}`}
          </p>
        </div>
        <div className="border border-g-line p-4">
          <h2 className="mb-2 text-xs font-bold tracking-[0.06em] uppercase">Entrega</h2>
          <p className="font-semibold">{o.shipping_snapshot.name}</p>
          {o.ship_to ? (
            <p className="mt-1 text-g-soft">
              {o.ship_to.recipient}
              <br />
              {o.ship_to.street}, {o.ship_to.number}
              {o.ship_to.complement ? ` – ${o.ship_to.complement}` : ''}
              <br />
              {o.ship_to.district} · {o.ship_to.city}/{o.ship_to.uf}
            </p>
          ) : (
            o.shipping_snapshot.description && <p className="mt-1 text-g-soft">{o.shipping_snapshot.description}</p>
          )}
          {o.has_backorder && <p className="mt-2 text-[13px] text-g-amber">Inclui item sob encomenda: o prazo conta a partir da confirmação do pagamento.</p>}
        </div>
      </aside>
    </div>
  );
}

function PixBox({ p }: { p: Payment }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
      {p.pix_qr_base64 && p.pix_qr_base64.length > 100 ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`data:image/png;base64,${p.pix_qr_base64}`} alt="QR Code do Pix" className="w-full max-w-[200px] border border-g-line" />
      ) : (
        <div className="grid aspect-square max-w-[200px] place-items-center border border-dashed border-g-line p-3 text-center text-xs text-g-faint">QR Code indisponível; use o código copia e cola.</div>
      )}
      <div className="min-w-0">
        <p className="text-sm font-semibold">Pix copia e cola</p>
        <p className="mt-1 max-h-24 overflow-auto border border-g-line bg-g-paper p-2 font-mono text-xs break-all">{p.pix_qr_code}</p>
        <button
          type="button"
          onClick={() => navigator.clipboard?.writeText(p.pix_qr_code ?? '').then(() => setCopied(true))}
          className="mt-2 flex items-center gap-2 bg-g-ink px-4 py-2.5 text-sm font-bold text-white"
        >
          {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copiado' : 'Copiar código'}
        </button>
        <p className="mt-2 text-[13px] text-g-soft">Abra o app do seu banco, escolha Pix copia e cola ou leia o QR. A confirmação aparece aqui sozinha.</p>
        {p.pix_expires_at && <p className="text-[13px] text-g-soft">Código válido até {dt.format(new Date(p.pix_expires_at))}.</p>}
      </div>
    </div>
  );
}

declare global {
  interface Window {
    MercadoPago?: new (key: string, opts: { locale: string }) => { bricks: () => { create: (name: string, container: string, settings: unknown) => Promise<{ unmount: () => void }> } };
  }
}

/**
 * Formulario de cartao do Mercado Pago (Card Payment Brick). O numero do cartao e digitado
 * dentro do componente do provedor; a loja recebe so o token.
 */
function CardBrick({ publicKey, amountCents, email, onToken }: { publicKey: string; amountCents: number; email: string; onToken: (body: unknown) => Promise<void> }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const attempt = useRef<string>(crypto.randomUUID());
  // A tela do pedido se atualiza sozinha; o formulario nao pode ser recriado a cada atualizacao.
  const submit = useRef(onToken);
  submit.current = onToken;
  useEffect(() => {
    let ctrl: { unmount: () => void } | null = null;
    let cancelled = false;
    const start = async () => {
      if (!window.MercadoPago) {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://sdk.mercadopago.com/js/v2';
          s.onload = () => resolve();
          s.onerror = () => reject(new Error('sdk'));
          document.head.appendChild(s);
        });
      }
      if (cancelled || !window.MercadoPago) return;
      const mp = new window.MercadoPago(publicKey, { locale: 'pt-BR' });
      ctrl = await mp.bricks().create('cardPayment', 'card-brick', {
        initialization: { amount: amountCents / 100, payer: { email } },
        callbacks: {
          onReady: () => setState('ready'),
          onError: () => setState('error'),
          onSubmit: (f: { token: string; payment_method_id: string; issuer_id?: string | number; installments: number; payer: { email: string; identification?: { type: string; number: string } } }) =>
            submit.current({
              attemptKey: attempt.current,
              token: f.token,
              paymentMethodId: f.payment_method_id,
              issuerId: f.issuer_id ?? null,
              installments: f.installments,
              payer: { email: f.payer?.email || email, identification: f.payer?.identification ?? null },
            }).finally(() => {
              attempt.current = crypto.randomUUID();
            }),
        },
      });
    };
    start().catch(() => setState('error'));
    return () => {
      cancelled = true;
      ctrl?.unmount();
    };
  }, [publicKey, amountCents, email]);
  return (
    <div>
      {state === 'loading' && <p className="text-sm text-g-soft">Carregando formulário seguro do Mercado Pago…</p>}
      {state === 'error' && <p className="text-sm text-g-red">Não foi possível carregar o formulário do cartão. Recarregue a página.</p>}
      <div id="card-brick" />
    </div>
  );
}
