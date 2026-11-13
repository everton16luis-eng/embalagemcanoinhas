'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useCart } from '@/components/loja/cart';
import { qtyText, reais, unitName } from '@/components/loja/price';
import { CEP_KEY, days, fetchQuote, readCep, type Quote } from '@/components/loja/shipping-quote';
import { api, ApiError } from '@/lib/api';

type Me = {
  customer: { kind: 'pf' | 'pj'; name: string; email: string; phone: string | null; document: string | null; state_registration: string | null };
  addresses: { id: string; recipient: string; cep: string; street: string; number: string; complement: string | null; district: string; city: string; uf: string; is_default: boolean }[];
};
type PayConfig = { enabled: boolean; methods: string[]; whatsappOptinText?: string | null };
const newKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const input = 'h-11 w-full border-[1.5px] border-g-line bg-white px-3 outline-none focus:border-g-ink';
function F({ label, children, hint, className = '' }: { label: string; children: ReactNode; hint?: string; className?: string }) {
  return (
    <label className={`block text-[13px] font-semibold ${className}`}>
      {label}
      <span className="mt-1 block font-normal">{children}</span>
      {hint && <span className="mt-0.5 block text-xs font-normal text-g-faint">{hint}</span>}
    </label>
  );
}

export default function CheckoutPage() {
  const router = useRouter();
  const { cart, refresh } = useCart();
  const [requestKey] = useState(newKey);
  const [me, setMe] = useState<Me | null>(null);
  const [pay, setPay] = useState<PayConfig | null>(null);
  const [buyer, setBuyer] = useState({ kind: 'pf' as 'pf' | 'pj', name: '', email: '', phone: '', document: '', stateRegistration: '' });
  const [cep, setCep] = useState('');
  const [options, setOptions] = useState<Quote[] | null>(null);
  const [shipId, setShipId] = useState('');
  const [addr, setAddr] = useState({ recipient: '', street: '', number: '', complement: '', district: '', city: '', uf: 'SC' });
  const [method, setMethod] = useState<'pix' | 'card'>('pix');
  const [notes, setNotes] = useState('');
  const [waOptin, setWaOptin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<PayConfig>('/public/checkout/payment-config').then(setPay, () => setPay({ enabled: false, methods: [] }));
    api<Me>('/customer/me').then(
      (m) => {
        setMe(m);
        const c = m.customer;
        setBuyer({ kind: c.kind, name: c.name, email: c.email, phone: c.phone ?? '', document: c.document ?? '', stateRegistration: c.state_registration ?? '' });
        const a = m.addresses.find((x) => x.is_default);
        if (a) {
          setAddr({ recipient: a.recipient, street: a.street, number: a.number, complement: a.complement ?? '', district: a.district, city: a.city, uf: a.uf });
          setCep(a.cep);
          quote(a.cep);
          return;
        }
        const saved = readCep();
        if (saved) {
          setCep(saved);
          quote(saved);
        }
      },
      () => {
        const saved = readCep();
        if (saved) {
          setCep(saved);
          quote(saved);
        }
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const quote = async (value: string) => {
    try {
      const r = await fetchQuote(value);
      setOptions(r.options);
      try {
        sessionStorage.setItem(CEP_KEY, r.cep);
      } catch {}
      setShipId((cur) => (r.options.some((o) => o.id === cur) ? cur : (r.options[0]?.id ?? '')));
    } catch (e) {
      setOptions(null);
      setError((e as Error).message);
    }
  };

  const ship = options?.find((o) => o.id === shipId) ?? null;
  const total = (cart?.subtotalCents ?? 0) + (ship?.priceCents ?? 0);
  const ready = useMemo(() => Boolean(cart?.items.length && !cart.blocking.length && ship && pay?.enabled), [cart, ship, pay]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ship || !cart) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ order: { token: string } }>('/public/checkout', {
        method: 'POST',
        body: {
          requestKey,
          buyer: { ...buyer, stateRegistration: buyer.kind === 'pj' ? buyer.stateRegistration || null : null },
          shippingOptionId: ship.id,
          address: ship.kind === 'delivery' ? { ...addr, cep, complement: addr.complement || null } : null,
          paymentMethod: method,
          notes: notes || null,
          whatsappOptin: Boolean(pay?.whatsappOptinText) && waOptin,
          expectedTotalCents: total,
        },
      });
      await refresh();
      router.push(`/pedido/${r.order.token}`);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'PRICE_CHANGED' || err.code === 'CART_BLOCKED')) {
        await refresh();
        if (cep) await quote(cep);
      }
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (!cart) return <p className="mx-auto max-w-[1240px] px-4 py-10 text-g-soft sm:px-8">Carregando…</p>;
  if (!cart.items.length)
    return (
      <div className="mx-auto max-w-[1240px] px-4 py-12 text-center sm:px-8">
        <p className="font-semibold">Seu carrinho está vazio.</p>
        <Link href="/" className="mt-4 inline-block bg-g-ink px-5 py-3 font-bold text-white">
          Ver produtos
        </Link>
      </div>
    );

  const b = (k: keyof typeof buyer) => ({ value: buyer[k], onChange: (e: { target: { value: string } }) => setBuyer({ ...buyer, [k]: e.target.value }) });
  const a = (k: keyof typeof addr) => ({ value: addr[k], onChange: (e: { target: { value: string } }) => setAddr({ ...addr, [k]: e.target.value }) });

  return (
    <form onSubmit={submit} className="mx-auto grid max-w-[1240px] gap-8 px-4 pt-6 sm:px-8 lg:grid-cols-[1fr_380px]">
      <div className="min-w-0 space-y-8">
        <h1 className="cond border-b-[3px] border-g-ink pb-2 text-[32px] leading-none font-extrabold uppercase">Finalizar compra</h1>

        <section>
          <h2 className="mb-3 text-xs font-bold tracking-[0.06em] uppercase">1 · Seus dados</h2>
          {!me && (
            <p className="mb-3 text-[13px] text-g-soft">
              Já comprou aqui?{' '}
              <Link href="/conta?voltar=/finalizar" className="font-semibold text-g-green underline">
                Entrar
              </Link>{' '}
              para preencher com seu cadastro. Também dá para comprar sem conta.
            </p>
          )}
          <div role="radiogroup" aria-label="Tipo de comprador" className="mb-3 flex gap-2">
            {(['pf', 'pj'] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={buyer.kind === k} disabled={Boolean(me)} onClick={() => setBuyer({ ...buyer, kind: k })} className={`border-[1.5px] px-3 py-2 text-sm font-semibold ${buyer.kind === k ? 'border-g-ink bg-g-ink text-white' : 'border-g-line'}`}>
                {k === 'pf' ? 'Pessoa física' : 'Empresa (CNPJ)'}
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <F label={buyer.kind === 'pf' ? 'Nome completo' : 'Razão social'} className="sm:col-span-2">
              <input required minLength={2} autoComplete={buyer.kind === 'pf' ? 'name' : 'organization'} className={input} {...b('name')} />
            </F>
            <F label="E-mail" hint="Para o comprovante e a nota fiscal.">
              <input required type="email" autoComplete="email" className={input} {...b('email')} />
            </F>
            <F label="Celular com DDD">
              <input required inputMode="tel" autoComplete="tel" className={input} {...b('phone')} />
            </F>
            <F label={buyer.kind === 'pf' ? 'CPF' : 'CNPJ'} hint="Obrigatório na NF-e.">
              <input required inputMode={buyer.kind === 'pf' ? 'numeric' : 'text'} className={input} {...b('document')} />
            </F>
            {buyer.kind === 'pj' && (
              <F label="Inscrição estadual" hint="Deixe vazio se for isenta.">
                <input className={input} {...b('stateRegistration')} />
              </F>
            )}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-xs font-bold tracking-[0.06em] uppercase">2 · Entrega</h2>
          <div className="flex max-w-sm gap-2">
            <label htmlFor="cep" className="sr-only">
              CEP
            </label>
            <input id="cep" inputMode="numeric" autoComplete="postal-code" placeholder="CEP" value={cep} onChange={(e) => setCep(e.target.value)} className={input} />
            <button type="button" onClick={() => quote(cep)} className="h-11 shrink-0 border-[1.5px] border-g-ink px-4 text-sm font-semibold">
              Ver opções
            </button>
          </div>
          {options && (
            <div role="radiogroup" aria-label="Forma de entrega" className="mt-3 grid gap-2">
              {options.length === 0 && <p className="text-[13px] text-g-soft">Nenhuma forma de entrega para este CEP.</p>}
              {options.map((o) => (
                <label key={o.id} className={`flex cursor-pointer items-start gap-3 border-[1.5px] p-3 ${o.id === shipId ? 'border-g-ink' : 'border-g-line'}`}>
                  <input type="radio" name="entrega" className="mt-1" checked={o.id === shipId} onChange={() => setShipId(o.id)} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{o.name}</span>
                    <span className="block text-[13px] text-g-soft">
                      {days(o)}
                      {o.description ? ` · ${o.description}` : ''}
                    </span>
                  </span>
                  <span className="num shrink-0 font-semibold">{o.priceCents ? reais(o.priceCents) : o.kind === 'pickup' ? 'sem custo' : 'grátis'}</span>
                </label>
              ))}
            </div>
          )}
          {ship?.kind === 'delivery' && (
            <div className="mt-4 grid gap-3 sm:grid-cols-6">
              <F label="Quem recebe" className="sm:col-span-6">
                <input required className={input} autoComplete="name" {...a('recipient')} />
              </F>
              <F label="Rua" className="sm:col-span-4">
                <input required className={input} autoComplete="address-line1" {...a('street')} />
              </F>
              <F label="Número" className="sm:col-span-2">
                <input required className={input} {...a('number')} />
              </F>
              <F label="Complemento" className="sm:col-span-3">
                <input className={input} autoComplete="address-line2" {...a('complement')} />
              </F>
              <F label="Bairro" className="sm:col-span-3">
                <input required className={input} {...a('district')} />
              </F>
              <F label="Cidade" className="sm:col-span-4">
                <input required className={input} autoComplete="address-level2" {...a('city')} />
              </F>
              <F label="UF" className="sm:col-span-2">
                <input required maxLength={2} className={`${input} uppercase`} autoComplete="address-level1" {...a('uf')} />
              </F>
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-xs font-bold tracking-[0.06em] uppercase">3 · Pagamento</h2>
          {pay && !pay.enabled ? (
            <p role="alert" className="border-[1.5px] border-g-red p-3 text-sm text-g-red">
              Pagamento online indisponível no momento. Fale com a loja para concluir o pedido.
            </p>
          ) : (
            <div role="radiogroup" aria-label="Forma de pagamento" className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ['pix', 'Pix', 'Código e QR na próxima tela. Confirmação automática.'],
                  ['card', 'Cartão de crédito', 'Dados digitados no formulário seguro do Mercado Pago.'],
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
          )}
          <F label="Observação (opcional)" className="mt-4">
            <textarea maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-20 w-full border-[1.5px] border-g-line px-3 py-2 outline-none focus:border-g-ink" />
          </F>
          {pay?.whatsappOptinText && (
            <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-sm">
              <input type="checkbox" checked={waOptin} onChange={(e) => setWaOptin(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-g-ink" />
              <span>{pay.whatsappOptinText}</span>
            </label>
          )}
        </section>
      </div>

      <aside className="h-fit border-2 border-g-ink p-4 lg:sticky lg:top-4 lg:mt-14">
        <h2 className="text-xs font-bold tracking-[0.06em] uppercase">Seu pedido</h2>
        <ul className="mt-3 divide-y divide-g-line text-sm">
          {cart.items.map((l) => (
            <li key={l.packagingId} className="flex justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="block font-semibold [overflow-wrap:anywhere]">{l.productName}</span>
                <span className="block text-xs text-g-soft">
                  {l.packs} × {l.label} ({qtyText(l.baseQty)} {unitName(l.baseUnit)})
                </span>
              </span>
              <span className="num shrink-0">{reais(l.totalCents)}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-3 space-y-1.5 border-t border-g-line pt-3 text-sm">
          <div className="flex justify-between">
            <dt>Subtotal</dt>
            <dd className="num">{reais(cart.subtotalCents)}</dd>
          </div>
          {cart.quantitySavingsCents > 0 && (
            <div className="flex justify-between text-g-green">
              <dt>Economia por quantidade</dt>
              <dd className="num">−{reais(cart.quantitySavingsCents)}</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt>Frete</dt>
            <dd className="num">{ship ? (ship.priceCents ? reais(ship.priceCents) : 'sem custo') : '—'}</dd>
          </div>
          <div className="flex justify-between border-t-2 border-g-ink pt-2 text-lg font-extrabold">
            <dt>Total</dt>
            <dd className="num">{reais(total)}</dd>
          </div>
        </dl>
        {error && (
          <p role="alert" className="mt-3 text-[13px] font-semibold text-g-red">
            {error}
          </p>
        )}
        <button type="submit" disabled={!ready || busy} className="mt-4 w-full bg-g-green py-3.5 font-bold text-white hover:bg-g-green-dark disabled:opacity-50">
          {busy ? 'Criando pedido…' : method === 'pix' ? 'Fazer pedido e pagar com Pix' : 'Fazer pedido e pagar com cartão'}
        </button>
        {!ship && <p className="mt-2 text-[13px] text-g-soft">Informe o CEP e escolha a entrega.</p>}
        <p className="mt-3 text-xs text-g-faint">O estoque fica reservado para você até o prazo de pagamento.</p>
      </aside>
    </form>
  );
}
