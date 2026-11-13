'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { useCart } from './cart';
import { reais } from './price';

export type Quote = { id: string; name: string; kind: 'pickup' | 'delivery'; description: string | null; priceCents: number; minDays: number; maxDays: number };

export const CEP_KEY = 'loja:cep';
export const readCep = () => {
  try {
    return sessionStorage.getItem(CEP_KEY) ?? '';
  } catch {
    return '';
  }
};
export const days = (q: Quote) => (q.kind === 'pickup' ? (q.maxDays === 0 ? 'no mesmo dia' : `em até ${q.maxDays} dia(s) útil(eis)`) : q.minDays === q.maxDays ? `${q.maxDays} dia(s) útil(eis)` : `${q.minDays} a ${q.maxDays} dias úteis`);

export async function fetchQuote(cep: string) {
  return api<{ cep: string; options: Quote[]; weightMissing: boolean }>(`/public/shipping/quote?cep=${encodeURIComponent(cep)}`);
}

/** Calculo de frete pelo CEP, com as regras cadastradas no painel e o carrinho atual. */
export function ShippingQuote() {
  const { cart } = useCart();
  const [cep, setCep] = useState('');
  const [result, setResult] = useState<{ options: Quote[]; weightMissing: boolean } | null>(null);
  const [error, setError] = useState('');

  const run = async (value: string) => {
    setError('');
    try {
      const r = await fetchQuote(value);
      setResult(r);
      try {
        sessionStorage.setItem(CEP_KEY, r.cep);
      } catch {}
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    const saved = readCep();
    if (saved) {
      setCep(saved.replace(/(\d{5})(\d{3})/, '$1-$2'));
      run(saved);
    }
    // recalcula quando o carrinho muda (subtotal e peso)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart?.subtotalCents, cart?.weightG]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(cep);
  };

  return (
    <div>
      <form onSubmit={submit} className="flex gap-2">
        <label htmlFor="cep-frete" className="sr-only">
          CEP
        </label>
        <input id="cep-frete" inputMode="numeric" autoComplete="postal-code" placeholder="CEP para frete" value={cep} onChange={(e) => setCep(e.target.value)} className="h-10 min-w-0 flex-1 border-[1.5px] border-g-ink px-3" />
        <button className="h-10 border-[1.5px] border-g-ink px-3 text-sm font-semibold">Calcular</button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-g-red">
          {error}
        </p>
      )}
      {result && (
        <ul className="mt-2 space-y-1.5 text-[13px]">
          {result.options.length === 0 && <li className="text-g-soft">Não entregamos neste CEP ainda. Fale com a gente para combinar.</li>}
          {result.options.map((o) => (
            <li key={o.id} className="flex justify-between gap-3">
              <span>
                <span className="font-semibold">{o.name}</span> <span className="text-g-soft">· {days(o)}</span>
              </span>
              <span className="num shrink-0 font-semibold">{o.priceCents ? reais(o.priceCents) : o.kind === 'pickup' ? 'sem custo' : 'grátis'}</span>
            </li>
          ))}
          {result.weightMissing && <li className="text-g-soft">Algumas entregas dependem do peso e não aparecem para estes itens.</li>}
        </ul>
      )}
    </div>
  );
}
