'use client';

import { Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import { useCart } from './cart';
import { PriceTag, qtyText, reais, Stock, unitName, unitReais } from './price';

type Tier = { minPacks: number; priceCents: number };
type Pack = { id: string; label: string; unit_code: string; base_qty: string; price_cents: string; is_default: boolean; unit_price_cents: string; tiers: Tier[]; in_stock: boolean; max_packs: number };
type Variant = { id: string; sku: string; attributes: Record<string, string>; packagings: Pack[] };
export type ProductDetail = {
  id: string;
  name: string;
  slug: string;
  summary: string | null;
  description: string | null;
  brand: string | null;
  base_unit: string;
  base_unit_name: string;
  availability_mode: 'stock' | 'made_to_order';
  lead_time_days: number | null;
  specs: unknown;
  breadcrumb: { name: string; slug: string }[];
  variants: Variant[];
  images: { file_key: string; alt: string | null; variant_id: string | null }[];
};

const priceFor = (list: number, tiers: Tier[], n: number) => tiers.reduce((p, t) => (n >= t.minPacks ? t.priceCents : p), list);
const variantName = (v: Variant) => Object.values(v.attributes).join(' · ') || v.sku;

export function BuyBox({ product: p }: { product: ProductDetail }) {
  const { add } = useCart();
  const sellable = p.variants.filter((v) => v.packagings.length);
  const [vi, setVi] = useState(0);
  const variant = sellable[vi];
  const [packId, setPackId] = useState(variant?.packagings.find((k) => k.is_default)?.id ?? variant?.packagings[0]?.id);
  const pack = variant?.packagings.find((k) => k.id === packId) ?? variant?.packagings[0];
  const [n, setN] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const madeToOrder = p.availability_mode === 'made_to_order';

  if (!variant || !pack) {
    return (
      <div>
        <h1 className="cond text-[32px] leading-none font-extrabold uppercase">{p.name}</h1>
        <p className="mt-4 text-g-soft">Produto sem embalagem à venda no momento.</p>
      </div>
    );
  }

  const tiers = [...pack.tiers].sort((a, b) => a.minPacks - b.minPacks);
  const unit = priceFor(Number(pack.price_cents), tiers, n);
  const next = tiers.find((t) => t.minPacks > n);
  const tooMany = !madeToOrder && n > pack.max_packs;
  const canBuy = madeToOrder || pack.in_stock;

  const pickVariant = (i: number) => {
    setVi(i);
    const v = sellable[i]!;
    setPackId(v.packagings.find((k) => k.is_default)?.id ?? v.packagings[0]?.id);
    setN(1);
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await add(pack.id, n);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-w-0">
      {p.brand && <p className="text-[13px] font-semibold tracking-wide text-g-soft uppercase">{p.brand}</p>}
      <h1 className="cond text-[32px] leading-[0.98] font-extrabold uppercase [overflow-wrap:anywhere] sm:text-[38px]">{p.name}</h1>
      <p className="mt-2 text-[13px] text-g-faint">Código {variant.sku}</p>
      {p.summary && <p className="mt-3 max-w-[56ch] text-g-soft">{p.summary}</p>}

      {sellable.length > 1 && (
        <fieldset className="mt-5">
          <legend className="mb-2 text-xs font-bold tracking-[0.06em] uppercase">Opção</legend>
          <div className="flex flex-wrap gap-2">
            {sellable.map((v, i) => (
              <button key={v.id} type="button" aria-pressed={i === vi} onClick={() => pickVariant(i)} className={`border-[1.5px] px-3 py-2 text-sm font-semibold ${i === vi ? 'border-g-ink bg-g-ink text-white' : 'border-g-line hover:border-g-ink'}`}>
                {variantName(v)}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      <fieldset className="mt-5">
        <legend className="mb-2 text-xs font-bold tracking-[0.06em] uppercase">Embalagem</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {variant.packagings.map((k) => (
            <label key={k.id} className={`flex cursor-pointer items-start gap-2.5 border-[1.5px] p-3 ${k.id === pack.id ? 'border-g-ink' : 'border-g-line hover:border-g-ink'}`}>
              <input
                type="radio"
                name="embalagem"
                className="mt-1 accent-[var(--color-g-ink)]"
                checked={k.id === pack.id}
                onChange={() => {
                  setPackId(k.id);
                  setN(1);
                }}
              />
              <span className="min-w-0">
                <span className="block font-semibold">{k.label}</span>
                <span className="block text-[13px] text-g-soft">
                  {qtyText(k.base_qty)} {unitName(p.base_unit)} · {reais(k.price_cents)}
                </span>
                <span className="block text-xs text-g-faint">
                  {unitReais(k.unit_price_cents)} por {unitName(p.base_unit)}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-5 max-w-sm">
        <PriceTag priceCents={unit} baseQty={pack.base_qty} baseUnit={p.base_unit} size="lg" />
        {unit < Number(pack.price_cents) && <p className="mt-1 text-[13px] text-g-soft">Preço de 1 embalagem: <s>{reais(pack.price_cents)}</s></p>}
      </div>

      {tiers.length > 0 && (
        <table className="mt-4 w-full max-w-md border-2 border-g-ink text-sm">
          <caption className="mb-1.5 text-left text-xs font-bold tracking-[0.06em] uppercase">Preço por quantidade</caption>
          <tbody>
            {[{ minPacks: 1, priceCents: Number(pack.price_cents) }, ...tiers].map((t, i, all) => {
              const to = all[i + 1]?.minPacks;
              const active = n >= t.minPacks && (!to || n < to);
              return (
                <tr key={t.minPacks} className={`border-b border-g-line last:border-0 ${active ? 'bg-g-green-tint font-semibold' : ''}`}>
                  <td className="px-3 py-2">{to ? (to - 1 === t.minPacks ? `${t.minPacks}` : `${t.minPacks} a ${to - 1}`) : `${t.minPacks} ou mais`}</td>
                  <td className="num px-3 py-2 text-right">{reais(t.priceCents)} cada</td>
                  <td className="num hidden px-3 py-2 text-right text-g-soft sm:table-cell">
                    {unitReais(t.priceCents / Number(pack.base_qty))}/{unitName(p.base_unit)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="mt-5">
        <Stock inStock={pack.in_stock} madeToOrder={madeToOrder} leadTimeDays={p.lead_time_days} />
        {madeToOrder && !pack.in_stock && (
          <p className="mt-1 max-w-[56ch] text-[13px] text-g-soft">Pedimos ao fornecedor depois da confirmação do pagamento. O prazo conta a partir daí.</p>
        )}
      </div>

      {canBuy && (
        <div className="mt-4 flex flex-wrap items-stretch gap-3">
          <div className="flex h-12 border-2 border-g-ink">
            <button type="button" aria-label="Diminuir" onClick={() => setN(Math.max(1, n - 1))} className="grid w-11 place-items-center">
              <Minus size={18} />
            </button>
            <label htmlFor="qtd" className="sr-only">
              Quantidade de embalagens
            </label>
            <input id="qtd" inputMode="numeric" value={n} onChange={(e) => setN(Math.min(100000, Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1)))} className="num w-16 border-x-2 border-g-ink text-center text-lg font-bold outline-none" />
            <button type="button" aria-label="Aumentar" onClick={() => setN(n + 1)} className="grid w-11 place-items-center">
              <Plus size={18} />
            </button>
          </div>
          <button type="button" onClick={submit} disabled={busy || tooMany} className="h-12 min-w-48 flex-1 bg-g-green px-6 font-bold text-white hover:bg-g-green-dark disabled:opacity-50 sm:flex-none">
            {busy ? 'Adicionando…' : `Adicionar · ${reais(unit * n)}`}
          </button>
        </div>
      )}
      {next && canBuy && (
        <p className="mt-2 text-[13px] font-semibold text-g-green">
          Leve {next.minPacks - n} a mais e cada embalagem sai por {reais(next.priceCents)}.
        </p>
      )}
      {tooMany && (
        <p role="alert" className="mt-2 text-[13px] text-g-red">
          Temos {pack.max_packs} {pack.max_packs === 1 ? 'embalagem' : 'embalagens'} desta opção agora.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-g-red">
          {error}
        </p>
      )}
    </div>
  );
}
