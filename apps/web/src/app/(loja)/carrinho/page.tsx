'use client';

import { Minus, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useCart, type Cart, type CartLine } from '@/components/loja/cart';
import { Photo, qtyText, reais, unitName } from '@/components/loja/price';
import { ShippingQuote } from '@/components/loja/shipping-quote';
import { api } from '@/lib/api';

function Line({ l, onChange }: { l: CartLine; onChange: (c: Cart) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = async (packs: number) => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ cart: Cart }>(`/public/cart/items/${l.packagingId}`, packs ? { method: 'PUT', body: { packs } } : { method: 'DELETE' });
      onChange(r.cart);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const attrs = Object.values(l.attributes).join(' · ');
  return (
    <li className={`grid grid-cols-[72px_1fr] gap-3 border-b border-g-line py-4 sm:grid-cols-[88px_1fr_auto] ${busy ? 'opacity-60' : ''}`}>
      <Link href={`/p/${l.productSlug}`}>
        <Photo imageKey={l.imageKey} alt={l.productName} />
      </Link>
      <div className="min-w-0">
        <Link href={`/p/${l.productSlug}`} className="font-semibold [overflow-wrap:anywhere] hover:underline">
          {l.productName}
        </Link>
        <p className="text-[13px] text-g-soft">
          {attrs && `${attrs} · `}
          {l.label} ({qtyText(l.baseQty)} {unitName(l.baseUnit)}) · {l.sku}
        </p>
        <p className="mt-1 text-[13px]">
          {reais(l.unitPriceCents)} cada
          {l.unitPriceCents < l.listPriceCents && <span className="ml-1.5 font-semibold text-g-green">preço de quantidade</span>}
        </p>
        {l.nextTier && l.status === 'ok' && (
          <button type="button" onClick={() => set(l.nextTier!.minPacks)} className="mt-1 text-left text-[13px] font-semibold text-g-green underline-offset-2 hover:underline">
            Leve {l.nextTier.minPacks - l.packs} a mais e pague {reais(l.nextTier.priceCents)} cada
          </button>
        )}
        {l.madeToOrder && <p className="mt-1 text-[13px] font-semibold text-g-amber">Sob encomenda{l.leadTimeDays ? ` · ${l.leadTimeDays} dias após o pagamento` : ''}</p>}
        {l.status === 'insufficient' && (
          <p role="alert" className="mt-1 text-[13px] font-semibold text-g-red">
            Temos {qtyText(Math.floor(Number(l.available) / Number(l.baseQty)))} embalagem(ns) agora. Ajuste a quantidade.
          </p>
        )}
        {l.status === 'unavailable' && (
          <p role="alert" className="mt-1 text-[13px] font-semibold text-g-red">
            Este item saiu da loja. Remova para continuar.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-1 text-[13px] text-g-red">
            {error}
          </p>
        )}
        <div className="mt-2 flex items-center gap-3 sm:hidden">
          <Stepper l={l} set={set} busy={busy} />
        </div>
      </div>
      <div className="col-span-2 hidden flex-col items-end gap-2 sm:col-span-1 sm:flex">
        <p className="num text-lg font-bold">{reais(l.totalCents)}</p>
        <Stepper l={l} set={set} busy={busy} />
      </div>
    </li>
  );
}

function Stepper({ l, set, busy }: { l: CartLine; set: (n: number) => void; busy: boolean }) {
  return (
    <>
      <div className="flex h-9 border-[1.5px] border-g-ink">
        <button type="button" aria-label="Diminuir" disabled={busy || l.packs <= 1} onClick={() => set(l.packs - 1)} className="grid w-8 place-items-center disabled:opacity-40">
          <Minus size={15} />
        </button>
        <span className="num grid w-12 place-items-center border-x-[1.5px] border-g-ink font-bold" aria-label="Quantidade">
          {l.packs}
        </span>
        <button type="button" aria-label="Aumentar" disabled={busy} onClick={() => set(l.packs + 1)} className="grid w-8 place-items-center">
          <Plus size={15} />
        </button>
      </div>
      <button type="button" aria-label={`Remover ${l.productName}`} disabled={busy} onClick={() => set(0)} className="flex items-center gap-1 text-[13px] text-g-soft hover:text-g-red">
        <Trash2 size={15} /> <span className="sm:hidden">Remover</span>
      </button>
      <span className="num ml-auto font-bold sm:hidden">{reais(l.totalCents)}</span>
    </>
  );
}

export default function CartPage() {
  const { cart, setCart } = useCart();
  if (!cart) return <p className="mx-auto max-w-[1240px] px-4 py-10 text-g-soft sm:px-8">Carregando o carrinho…</p>;
  const empty = cart.items.length === 0;
  return (
    <div className="mx-auto max-w-[1240px] px-4 pt-6 sm:px-8">
      <h1 className="cond border-b-[3px] border-g-ink pb-2 text-[32px] leading-none font-extrabold uppercase">Carrinho</h1>
      {empty ? (
        <div className="py-12 text-center">
          <p className="font-semibold">Seu carrinho está vazio.</p>
          <Link href="/" className="mt-4 inline-block bg-g-ink px-5 py-3 font-bold text-white">
            Ver produtos
          </Link>
        </div>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
          <ul>
            {cart.items.map((l) => (
              <Line key={l.packagingId} l={l} onChange={setCart} />
            ))}
          </ul>
          <aside className="h-fit border-2 border-g-ink p-4 lg:sticky lg:top-4 lg:mt-4">
            <h2 className="text-xs font-bold tracking-[0.06em] uppercase">Resumo</h2>
            <dl className="mt-3 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <dt>Subtotal</dt>
                <dd className="num font-semibold">{reais(cart.subtotalCents)}</dd>
              </div>
              {cart.quantitySavingsCents > 0 && (
                <div className="flex justify-between text-g-green">
                  <dt>Economia por quantidade</dt>
                  <dd className="num font-semibold">−{reais(cart.quantitySavingsCents)}</dd>
                </div>
              )}
            </dl>
            <div className="mt-4 border-t border-g-line pt-4">
              <ShippingQuote />
            </div>
            {cart.blocking.length > 0 ? (
              <p role="alert" className="mt-4 text-[13px] font-semibold text-g-red">
                Ajuste os itens marcados para continuar.
              </p>
            ) : (
              <Link href="/finalizar" className="mt-4 block bg-g-green py-3.5 text-center font-bold text-white hover:bg-g-green-dark">
                Continuar para pagamento
              </Link>
            )}
            {cart.hasMadeToOrder && <p className="mt-3 text-[13px] text-g-soft">Itens sob encomenda são pedidos ao fornecedor depois do pagamento; o pedido é enviado completo.</p>}
          </aside>
        </div>
      )}
    </div>
  );
}
