'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { reais } from '@/components/loja/price';
import { days, type Quote as ShipQuote } from '@/components/loja/shipping-quote';
import { api } from '@/lib/api';

type PublicQuote = {
  number: number;
  status: 'open' | 'converted' | 'canceled';
  expired: boolean;
  validUntil: string;
  buyerName: string;
  buyerKind: 'pf' | 'pj';
  missing: string[];
  shipping: { id: string; name: string; kind: 'pickup' | 'delivery'; minDays: number; maxDays: number } | null;
  subtotalCents: string;
  discountCents: string;
  freightCents: string;
  totalCents: string;
  notes: string | null;
  items: { sku: string; productName: string; packagingLabel: string; packs: number; unitPriceCents: string; totalCents: string; madeToOrder: boolean; leadTimeDays: number | null; slug: string }[];
  orderToken: string | null;
};

const input = 'h-11 w-full border-[1.5px] border-g-line bg-white px-3 outline-none focus:border-g-ink';
function F({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block text-[13px] font-semibold ${className}`}>
      {label}
      <span className="mt-1 block font-normal">{children}</span>
    </label>
  );
}
const day = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR');

export default function QuotePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [q, setQ] = useState<PublicQuote | null>(null);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<'pf' | 'pj'>('pf');
  const [email, setEmail] = useState('');
  const [document, setDocument] = useState('');
  const [method, setMethod] = useState<'pix' | 'card'>('pix');
  const [cep, setCep] = useState('');
  const [options, setOptions] = useState<ShipQuote[] | null>(null);
  const [shipId, setShipId] = useState('');
  const [addr, setAddr] = useState({ recipient: '', street: '', number: '', complement: '', district: '', city: '', uf: 'SC' });
  const [busy, setBusy] = useState(false);
  const [optinText, setOptinText] = useState<string | null>(null);
  const [waOptin, setWaOptin] = useState(false);

  useEffect(() => {
    api<{ whatsappOptinText?: string | null }>('/public/checkout/payment-config').then((c) => setOptinText(c.whatsappOptinText ?? null), () => setOptinText(null));
  }, []);

  const base = `/public/quotes/${encodeURIComponent(token)}`;
  useEffect(() => {
    api<{ quote: PublicQuote }>(base).then(
      (r) => {
        setQ(r.quote);
        setKind(r.quote.buyerKind);
      },
      (e) => setError(e.status === 404 ? 'Orçamento não encontrado. Confira o link recebido.' : e.message),
    );
  }, [base]);

  async function loadOptions() {
    setError('');
    try {
      setOptions((await api<{ options: ShipQuote[] }>(`${base}/shipping${cep.trim() ? `?cep=${encodeURIComponent(cep)}` : ''}`)).options);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!q) return <div className="mx-auto max-w-[900px] px-4 pt-8 sm:px-8">{error ? <p role="alert">{error}</p> : <p className="text-g-faint">Carregando…</p>}</div>;

  const open = q.status === 'open' && !q.expired;
  const ship = q.shipping ?? options?.find((o) => o.id === shipId) ?? null;
  const freight = q.shipping ? Number(q.freightCents) : ((ship as ShipQuote | null)?.priceCents ?? 0);
  const total = Number(q.subtotalCents) - Number(q.discountCents) + freight;

  async function accept(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ orderToken: string }>(`${base}/accept`, {
        method: 'POST',
        body: {
          paymentMethod: method,
          buyer: { kind, email: email.trim() || null, document: document.trim() || null },
          shippingOptionId: q!.shipping ? null : shipId || null,
          address: !q!.shipping && ship?.kind === 'delivery' ? { ...addr, cep, complement: addr.complement || null } : null,
          whatsappOptin: Boolean(optinText) && waOptin,
        },
      });
      router.push(`/pedido/${r.orderToken}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[900px] px-4 pt-6 pb-10 sm:px-8">
      <h1 className="cond border-b-[3px] border-g-ink pb-2 text-[32px] leading-none font-extrabold uppercase">Orçamento Nº {q.number}</h1>
      <p className="mt-3 text-sm text-g-soft">
        Para {q.buyerName} · {open ? `preços válidos até ${day(q.validUntil)}` : q.status === 'canceled' ? 'orçamento cancelado' : q.status === 'converted' ? 'orçamento aceito' : `venceu em ${day(q.validUntil)}`}
      </p>

      {q.orderToken && (
        <p className="mt-4 border-[1.5px] border-g-green bg-g-green-tint p-3 text-sm">
          Este orçamento já virou pedido.{' '}
          <Link href={`/pedido/${q.orderToken}`} className="font-semibold text-g-green underline">
            Acompanhar e pagar
          </Link>
        </p>
      )}
      {!open && !q.orderToken && (
        <p className="mt-4 border-[1.5px] border-g-line p-3 text-sm">
          {q.status === 'canceled' ? 'Este orçamento foi cancelado.' : 'Este orçamento não está mais válido.'} Fale com a loja para um novo orçamento com os preços atuais.
        </p>
      )}

      <section className="mt-6">
        <h2 className="mb-2 text-xs font-bold tracking-[0.06em] uppercase">Itens</h2>
        <ul className="divide-y divide-g-line border-y-[1.5px] border-g-ink">
          {q.items.map((i) => (
            <li key={i.sku + i.packagingLabel} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-3 text-sm">
              <div className="min-w-0">
                <Link href={`/p/${i.slug}`} className="font-semibold hover:underline">
                  {i.productName}
                </Link>
                <p className="text-[13px] text-g-faint">
                  {i.packagingLabel}
                  {i.madeToOrder && ` · sob encomenda${i.leadTimeDays ? `, prazo de ${i.leadTimeDays} dias` : ''}`}
                </p>
              </div>
              <p className="tabular-nums">
                {i.packs} × {reais(i.unitPriceCents)} = <strong>{reais(i.totalCents)}</strong>
              </p>
            </li>
          ))}
        </ul>
        <dl className="mt-3 ml-auto grid max-w-sm grid-cols-[1fr_auto] gap-y-1 text-sm tabular-nums">
          <dt>Itens</dt>
          <dd className="text-right">{reais(q.subtotalCents)}</dd>
          {Number(q.discountCents) > 0 && (
            <>
              <dt>Desconto</dt>
              <dd className="text-right">− {reais(q.discountCents)}</dd>
            </>
          )}
          <dt>Entrega{ship ? ` · ${ship.name}` : ''}</dt>
          <dd className="text-right">{ship ? reais(freight) : 'a escolher'}</dd>
          <dt className="text-base font-bold">Total</dt>
          <dd className="text-right text-base font-bold">{reais(total)}</dd>
        </dl>
        {q.notes && <p className="mt-3 text-sm text-g-soft">Obs.: {q.notes}</p>}
      </section>

      {open && (
        <form onSubmit={accept} className="mt-8 space-y-6">
          {q.missing.length > 0 && (
            <section>
              <h2 className="mb-3 text-xs font-bold tracking-[0.06em] uppercase">Complete seus dados</h2>
              {q.missing.includes('document') && (
                <div role="radiogroup" aria-label="Tipo de comprador" className="mb-3 flex gap-2">
                  {(['pf', 'pj'] as const).map((k) => (
                    <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={`border-[1.5px] px-3 py-2 text-sm font-semibold ${kind === k ? 'border-g-ink bg-g-ink text-white' : 'border-g-line'}`}>
                      {k === 'pf' ? 'Pessoa física' : 'Empresa (CNPJ)'}
                    </button>
                  ))}
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                {q.missing.includes('email') && (
                  <F label="E-mail">
                    <input className={input} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                  </F>
                )}
                {q.missing.includes('document') && (
                  <F label={kind === 'pf' ? 'CPF' : 'CNPJ'}>
                    <input className={input} required value={document} onChange={(e) => setDocument(e.target.value)} />
                  </F>
                )}
              </div>
              <p className="mt-2 text-xs text-g-faint">Usados na nota fiscal e para avisar sobre o pedido.</p>
            </section>
          )}

          {!q.shipping && (
            <section>
              <h2 className="mb-3 text-xs font-bold tracking-[0.06em] uppercase">Entrega</h2>
              <div className="flex gap-2">
                <label htmlFor="cep" className="sr-only">
                  CEP
                </label>
                <input id="cep" className={input} inputMode="numeric" autoComplete="postal-code" placeholder="CEP (entrega)" value={cep} onChange={(e) => setCep(e.target.value)} />
                <button type="button" onClick={loadOptions} className="h-11 shrink-0 border-[1.5px] border-g-ink px-4 text-sm font-semibold">
                  Ver opções
                </button>
              </div>
              <p className="mt-1 text-xs text-g-faint">Para retirar na loja, toque em Ver opções sem CEP.</p>
              {options && (
                <div role="radiogroup" aria-label="Forma de entrega" className="mt-3 grid gap-2">
                  {options.length === 0 && <p className="text-sm">Nenhuma forma de entrega para este CEP. Fale com a loja.</p>}
                  {options.map((o) => (
                    <label key={o.id} className={`flex cursor-pointer items-start gap-3 border-[1.5px] p-3 ${o.id === shipId ? 'border-g-ink' : 'border-g-line'}`}>
                      <input type="radio" name="entrega" className="mt-1" checked={o.id === shipId} onChange={() => setShipId(o.id)} />
                      <span className="flex-1">
                        <span className="block font-semibold">{o.name}</span>
                        <span className="block text-[13px] text-g-soft">{days(o)}</span>
                      </span>
                      <span className="font-semibold tabular-nums">{o.priceCents ? reais(o.priceCents) : 'Grátis'}</span>
                    </label>
                  ))}
                </div>
              )}
              {ship?.kind === 'delivery' && (
                <div className="mt-3 grid gap-3 sm:grid-cols-6">
                  {(
                    [
                      ['recipient', 'Quem recebe', 'sm:col-span-6'],
                      ['street', 'Rua', 'sm:col-span-4'],
                      ['number', 'Número', 'sm:col-span-2'],
                      ['complement', 'Complemento', 'sm:col-span-3'],
                      ['district', 'Bairro', 'sm:col-span-3'],
                      ['city', 'Cidade', 'sm:col-span-4'],
                      ['uf', 'UF', 'sm:col-span-2'],
                    ] as const
                  ).map(([k, label, cls]) => (
                    <F key={k} label={label} className={cls}>
                      <input className={input} required={k !== 'complement'} value={addr[k]} onChange={(e) => setAddr({ ...addr, [k]: e.target.value })} />
                    </F>
                  ))}
                </div>
              )}
            </section>
          )}

          <section>
            <h2 className="mb-3 text-xs font-bold tracking-[0.06em] uppercase">Pagamento</h2>
            <div role="radiogroup" aria-label="Forma de pagamento" className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ['pix', 'Pix', 'Código e QR na próxima tela.'],
                  ['card', 'Cartão de crédito', 'Formulário seguro do Mercado Pago.'],
                ] as const
              ).map(([k, t, d]) => (
                <label key={k} className={`flex cursor-pointer items-start gap-3 border-[1.5px] p-3 ${method === k ? 'border-g-ink' : 'border-g-line'}`}>
                  <input type="radio" name="pagamento" className="mt-1" checked={method === k} onChange={() => setMethod(k)} />
                  <span>
                    <span className="block font-semibold">{t}</span>
                    <span className="block text-[13px] text-g-soft">{d}</span>
                  </span>
                </label>
              ))}
            </div>
            {optinText && (
              <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-sm">
                <input type="checkbox" checked={waOptin} onChange={(e) => setWaOptin(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-g-ink" />
                <span>{optinText}</span>
              </label>
            )}
          </section>

          {error && (
            <p role="alert" className="border-[1.5px] border-g-red p-3 text-sm text-g-red">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy || (!q.shipping && !shipId)} className="w-full bg-g-green py-3.5 font-bold text-white hover:bg-g-green-dark disabled:opacity-50">
            {busy ? 'Aguarde…' : `Aceitar e pagar ${reais(total)}`}
          </button>
          <p className="text-center text-xs text-g-faint">Ao aceitar, o pedido é criado com os preços deste orçamento e os itens ficam reservados para você.</p>
        </form>
      )}
      {!open && error && (
        <p role="alert" className="mt-4 text-sm text-g-red">
          {error}
        </p>
      )}
    </div>
  );
}
