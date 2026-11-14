'use client';

import { Check, ShoppingCart } from 'lucide-react';
import Link from 'next/link';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';

export type CartLine = {
  packagingId: string;
  variantId: string;
  productName: string;
  productSlug: string;
  sku: string;
  attributes: Record<string, string>;
  label: string;
  baseQty: string;
  baseUnit: string;
  packs: number;
  listPriceCents: number;
  unitPriceCents: number;
  totalCents: number;
  tiers: { minPacks: number; priceCents: number }[];
  nextTier: { minPacks: number; priceCents: number } | null;
  imageKey: string | null;
  madeToOrder: boolean;
  leadTimeDays: number | null;
  status: 'ok' | 'insufficient' | 'unavailable';
  available: string;
};
export type Cart = {
  items: CartLine[];
  subtotalCents: number;
  quantitySavingsCents: number;
  weightG: number;
  weightMissing: string[];
  hasMadeToOrder: boolean;
  blocking: { packagingId: string; status: string; available: string }[];
};

type Ctx = {
  cart: Cart | null;
  count: number;
  setCart: (c: Cart) => void;
  refresh: () => Promise<void>;
  add: (packagingId: string, packs: number) => Promise<Cart>;
  lastAdded: { name: string; at: number } | null;
};
const CartContext = createContext<Ctx | null>(null);

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart fora da loja');
  return ctx;
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [cart, setCart] = useState<Cart | null>(null);
  const [lastAdded, setLastAdded] = useState<Ctx['lastAdded']>(null);
  const refresh = useCallback(async () => {
    const r = await api<{ cart: Cart }>('/public/cart').catch(() => null);
    if (r) setCart(r.cart);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const add = useCallback(async (packagingId: string, packs: number) => {
    const r = await api<{ cart: Cart }>('/public/cart/items', { method: 'POST', body: { packagingId, packs } });
    setCart(r.cart);
    const line = r.cart.items.find((i) => i.packagingId === packagingId);
    if (line) setLastAdded({ name: `${line.productName} · ${line.label}`, at: Date.now() });
    return r.cart;
  }, []);
  const count = cart?.items.length ?? 0;
  return (
    <CartContext.Provider value={{ cart, count, setCart, refresh, add, lastAdded }}>
      {children}
      <AddedToast />
    </CartContext.Provider>
  );
}

/** Aviso discreto depois de adicionar: o cliente continua comprando sem ser levado ao carrinho. */
function AddedToast() {
  const { lastAdded } = useCart();
  const [shown, setShown] = useState<typeof lastAdded>(null);
  useEffect(() => {
    if (!lastAdded) return;
    setShown(lastAdded);
    const t = setTimeout(() => setShown(null), 4000);
    return () => clearTimeout(t);
  }, [lastAdded]);
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      {shown && (
        <div className="pointer-events-auto flex max-w-md items-center gap-3 border-2 border-g-ink bg-white px-4 py-3 shadow-[4px_4px_0_var(--color-g-ink)]">
          <Check size={18} className="shrink-0 text-g-green" aria-hidden />
          <p className="min-w-0 text-sm">
            <span className="font-semibold">Adicionado:</span> <span className="line-clamp-1">{shown.name}</span>
          </p>
          <Link href="/carrinho" className="shrink-0 bg-g-ink px-3 py-1.5 text-[13px] font-bold text-white">
            Ver carrinho
          </Link>
        </div>
      )}
    </div>
  );
}

export function CartButton() {
  const { count } = useCart();
  return (
    <Link href="/carrinho" className="flex items-center gap-1.5 text-[13px] font-semibold" aria-label={`Carrinho ${count} ${count === 1 ? 'item' : 'itens'}`}>
      <ShoppingCart size={20} aria-hidden />
      <span className="hidden sm:inline">Carrinho</span>
      <span className="num min-w-5 bg-g-label px-1.5 text-center font-bold">{count}</span>
    </Link>
  );
}
