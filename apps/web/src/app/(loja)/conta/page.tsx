'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useCart } from '@/components/loja/cart';
import { reais } from '@/components/loja/price';
import { api, ApiError } from '@/lib/api';

type Address = { id: string; recipient: string; cep: string; street: string; number: string; complement: string | null; district: string; city: string; uf: string; is_default: boolean };
type Me = { customer: { kind: 'pf' | 'pj'; name: string; email: string; phone: string | null; document: string | null }; addresses: Address[] };
type OrderRow = { id: string; number: number; status: string; total_cents: string; created_at: string; item_count: number };

const STATUS: Record<string, string> = { pending_payment: 'Aguardando pagamento', paid: 'Pago', preparing: 'Em separação', ready: 'Pronto', shipped: 'Enviado', delivered: 'Entregue', canceled: 'Cancelado' };
const input = 'h-11 w-full border-[1.5px] border-g-line bg-white px-3 outline-none focus:border-g-ink';
const date = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' });

function F({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block text-[13px] font-semibold ${className}`}>
      {label}
      <span className="mt-1 block font-normal">{children}</span>
    </label>
  );
}

/** Destino depois de entrar: so caminhos internos da loja. */
const safeBack = (v: string | null) => (v && /^\/(?!\/)[\w\-/]*$/.test(v) && !v.startsWith('/painel') ? v : null);

function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [f, setF] = useState({ kind: 'pf' as 'pf' | 'pj', name: '', email: '', phone: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => ({ value: f[k], onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'login') await api('/customer/login', { method: 'POST', body: { email: f.email, password: f.password } });
      else await api('/customer/register', { method: 'POST', body: f });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md">
      <div role="tablist" className="mb-5 grid grid-cols-2 border-2 border-g-ink">
        {(['login', 'register'] as const).map((m) => (
          <button key={m} role="tab" type="button" aria-selected={mode === m} onClick={() => setMode(m)} className={`py-2.5 text-sm font-bold ${mode === m ? 'bg-g-ink text-white' : ''}`}>
            {m === 'login' ? 'Entrar' : 'Criar conta'}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="space-y-3">
        {mode === 'register' && (
          <>
            <div className="flex gap-2">
              {(['pf', 'pj'] as const).map((k) => (
                <button key={k} type="button" aria-pressed={f.kind === k} onClick={() => setF({ ...f, kind: k })} className={`border-[1.5px] px-3 py-2 text-sm font-semibold ${f.kind === k ? 'border-g-ink bg-g-ink text-white' : 'border-g-line'}`}>
                  {k === 'pf' ? 'Pessoa física' : 'Empresa'}
                </button>
              ))}
            </div>
            <F label={f.kind === 'pf' ? 'Nome completo' : 'Razão social'}>
              <input required minLength={2} className={input} autoComplete="name" {...set('name')} />
            </F>
            <F label="Celular com DDD">
              <input required inputMode="tel" className={input} autoComplete="tel" {...set('phone')} />
            </F>
          </>
        )}
        <F label="E-mail">
          <input required type="email" className={input} autoComplete="email" {...set('email')} />
        </F>
        <F label="Senha">
          <input required type="password" minLength={mode === 'register' ? 10 : 1} className={input} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} {...set('password')} />
        </F>
        {mode === 'register' && <p className="text-xs text-g-faint">Ao menos 10 caracteres, com letras e números.</p>}
        {error && (
          <p role="alert" className="text-[13px] font-semibold text-g-red">
            {error}
          </p>
        )}
        <button disabled={busy} className="w-full bg-g-green py-3 font-bold text-white disabled:opacity-60">
          {busy ? 'Aguarde…' : mode === 'login' ? 'Entrar' : 'Criar conta'}
        </button>
      </form>
    </div>
  );
}

function AddressForm({ onSaved }: { onSaved: () => void }) {
  const [a, setA] = useState({ recipient: '', cep: '', street: '', number: '', complement: '', district: '', city: '', uf: 'SC' });
  const [error, setError] = useState('');
  const set = (k: keyof typeof a) => ({ value: a[k], onChange: (e: { target: { value: string } }) => setA({ ...a, [k]: e.target.value }) });
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError('');
        try {
          await api('/customer/addresses', { method: 'POST', body: { ...a, complement: a.complement || null } });
          onSaved();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
      className="mt-3 grid gap-3 border border-g-line p-3 sm:grid-cols-6"
    >
      <F label="Quem recebe" className="sm:col-span-4">
        <input required className={input} {...set('recipient')} />
      </F>
      <F label="CEP" className="sm:col-span-2">
        <input required inputMode="numeric" className={input} {...set('cep')} />
      </F>
      <F label="Rua" className="sm:col-span-4">
        <input required className={input} {...set('street')} />
      </F>
      <F label="Número" className="sm:col-span-2">
        <input required className={input} {...set('number')} />
      </F>
      <F label="Complemento" className="sm:col-span-3">
        <input className={input} {...set('complement')} />
      </F>
      <F label="Bairro" className="sm:col-span-3">
        <input required className={input} {...set('district')} />
      </F>
      <F label="Cidade" className="sm:col-span-4">
        <input required className={input} {...set('city')} />
      </F>
      <F label="UF" className="sm:col-span-2">
        <input required maxLength={2} className={`${input} uppercase`} {...set('uf')} />
      </F>
      {error && (
        <p role="alert" className="text-[13px] font-semibold text-g-red sm:col-span-6">
          {error}
        </p>
      )}
      <button className="bg-g-ink py-2.5 text-sm font-bold text-white sm:col-span-2">Salvar endereço</button>
    </form>
  );
}

function Account() {
  const router = useRouter();
  const back = safeBack(useSearchParams().get('voltar'));
  const { refresh } = useCart();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const m = await api<Me>('/customer/me');
      setMe(m);
      setOrders((await api<{ orders: OrderRow[] }>('/customer/orders')).orders);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (me === undefined) return <p className="text-g-soft">Carregando…</p>;
  if (me === null)
    return (
      <Auth
        onDone={async () => {
          await refresh();
          if (back) router.push(back);
          else load();
        }}
      />
    );

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_340px]">
      <section className="min-w-0">
        <h2 className="mb-2 text-xs font-bold tracking-[0.06em] uppercase">Meus pedidos</h2>
        {orders.length === 0 ? (
          <p className="border border-g-line p-4 text-g-soft">
            Nenhum pedido ainda.{' '}
            <Link href="/" className="font-semibold text-g-green underline">
              Ver produtos
            </Link>
          </p>
        ) : (
          <ul className="divide-y divide-g-line border-y border-g-line">
            {orders.map((o) => (
              <li key={o.id}>
                <Link href={`/conta/pedidos/${o.id}`} className="flex items-center justify-between gap-3 py-3 hover:bg-g-paper">
                  <span>
                    <span className="block font-semibold">Pedido nº {o.number}</span>
                    <span className="block text-[13px] text-g-soft">
                      {date.format(new Date(o.created_at))} · {o.item_count} {o.item_count === 1 ? 'item' : 'itens'} · {STATUS[o.status] ?? o.status}
                    </span>
                  </span>
                  <span className="num font-semibold">{reais(o.total_cents)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <aside className="space-y-6">
        <section className="border border-g-line p-4 text-sm">
          <h2 className="mb-2 text-xs font-bold tracking-[0.06em] uppercase">Cadastro</h2>
          <p className="font-semibold">{me.customer.name}</p>
          <p className="break-all text-g-soft">{me.customer.email}</p>
          <button
            type="button"
            onClick={async () => {
              await api('/customer/logout', { method: 'POST' }).catch(() => null);
              setMe(null);
              setOrders([]);
            }}
            className="mt-3 text-[13px] font-semibold text-g-red underline"
          >
            Sair
          </button>
        </section>
        <section className="border border-g-line p-4 text-sm">
          <h2 className="mb-2 text-xs font-bold tracking-[0.06em] uppercase">Endereços</h2>
          {me.addresses.length === 0 && <p className="text-g-soft">Nenhum endereço salvo.</p>}
          <ul className="space-y-3">
            {me.addresses.map((a) => (
              <li key={a.id} className="text-g-soft">
                <span className="font-semibold text-g-ink">{a.recipient}</span>
                {a.is_default && <span className="ml-2 bg-g-green-tint px-1.5 text-xs font-semibold text-g-green">principal</span>}
                <br />
                {a.street}, {a.number}
                {a.complement ? ` – ${a.complement}` : ''} · {a.district}
                <br />
                {a.city}/{a.uf} · {a.cep.replace(/(\d{5})(\d{3})/, '$1-$2')}
                <button type="button" onClick={() => api(`/customer/addresses/${a.id}`, { method: 'DELETE' }).then(load)} className="ml-2 text-xs text-g-red underline">
                  remover
                </button>
              </li>
            ))}
          </ul>
          {adding ? (
            <AddressForm
              onSaved={() => {
                setAdding(false);
                load();
              }}
            />
          ) : (
            <button type="button" onClick={() => setAdding(true)} className="mt-3 border-[1.5px] border-g-ink px-3 py-2 text-[13px] font-semibold">
              Adicionar endereço
            </button>
          )}
        </section>
      </aside>
    </div>
  );
}

export default function AccountPage() {
  return (
    <div className="mx-auto max-w-[1240px] px-4 pt-6 sm:px-8">
      <h1 className="cond mb-6 border-b-[3px] border-g-ink pb-2 text-[32px] leading-none font-extrabold uppercase">Minha conta</h1>
      <Suspense>
        <Account />
      </Suspense>
    </div>
  );
}
