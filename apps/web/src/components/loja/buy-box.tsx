'use client';

import { Minus, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
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
const tiersOf = (k: Pack) => [...k.tiers].sort((a, b) => a.minPacks - b.minPacks);

/** Uma camada por embalagem na mesma celula da grade; so a ativa aparece e e lida por leitor de tela. */
function Layers({ packs, activeId, render }: { packs: Pack[]; activeId: string; render: (k: Pack, active: boolean) => ReactNode }) {
  return (
    <div className="grid">
      {packs.map((k) => {
        const active = k.id === activeId;
        return (
          <div key={k.id} className={`col-start-1 row-start-1 min-w-0 transition-none ${active ? '' : 'invisible'}`} aria-hidden={!active} inert={!active}>
            {render(k, active)}
          </div>
        );
      })}
    </div>
  );
}

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

  const tiers = tiersOf(pack);
  const unit = priceFor(Number(pack.price_cents), tiers, n);
  const next = tiers.find((t) => t.minPacks > n);
  const canBuy = madeToOrder || pack.in_stock;
  // Esgotado ja aparece no botao; o aviso de quantidade e so para quando ha algum estoque.
  const tooMany = canBuy && !madeToOrder && n > pack.max_packs;
  // Os blocos que dependem da embalagem (tabela de precos e estoque) sao desenhados para todas as embalagens
  // de todas as opcoes, empilhados na mesma celula, e so a escolhida fica visivel. A altura e a da maior:
  // trocar de embalagem troca o conteudo sem mover o que vem abaixo.
  const allPacks = sellable.flatMap((v) => v.packagings);
  const anyTiers = allPacks.some((k) => k.tiers.length > 0);

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
        {/* Linha sempre reservada: o preco cheio riscado aparece ao entrar numa faixa de desconto sem empurrar nada. */}
        {anyTiers && (
          <p className="mt-1 min-h-5 text-[13px] text-g-soft">
            {unit < Number(pack.price_cents) && (
              <>
                Preço de 1 embalagem: <s className="num">{reais(pack.price_cents)}</s>
              </>
            )}
          </p>
        )}
      </div>

      {anyTiers && (
        <div className="mt-4 max-w-md">
          <Layers
            packs={allPacks}
            activeId={pack.id}
            render={(k, current) => (
              <table className="w-full border-2 border-g-ink text-sm">
                <caption className="mb-1.5 text-left text-xs font-bold tracking-[0.06em] uppercase">Preço por quantidade</caption>
                <tbody>
                  {[{ minPacks: 1, priceCents: Number(k.price_cents) }, ...tiersOf(k)].map((t, i, all) => {
                    const to = all[i + 1]?.minPacks;
                    const active = current && n >= t.minPacks && (!to || n < to);
                    return (
                      // Faixa ativa so muda o fundo: o peso da fonte fica igual para os numeros nao mudarem de largura.
                      <tr key={t.minPacks} className={`border-b border-g-line last:border-0 ${active ? 'bg-g-green-tint' : ''}`}>
                        <td className="px-3 py-2">{to ? (to - 1 === t.minPacks ? `${t.minPacks}` : `${t.minPacks} a ${to - 1}`) : `${t.minPacks} ou mais`}</td>
                        <td className="num px-3 py-2 text-right font-semibold">{reais(t.priceCents)} cada</td>
                        <td className="num hidden px-3 py-2 text-right text-g-soft sm:table-cell">
                          {unitReais(t.priceCents / Number(k.base_qty))}/{unitName(p.base_unit)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          />
        </div>
      )}

      <div className="mt-5">
        <Layers
          packs={allPacks}
          activeId={pack.id}
          render={(k) => (
            <>
              <Stock inStock={k.in_stock} madeToOrder={madeToOrder} leadTimeDays={p.lead_time_days} />
              {madeToOrder && !k.in_stock && (
                <p className="mt-1 max-w-[56ch] text-[13px] text-g-soft">Pedimos ao fornecedor depois da confirmação do pagamento. O prazo conta a partir daí.</p>
              )}
            </>
          )}
        />
      </div>

      {/* Os controles ficam sempre no lugar; sem estoque, ficam desabilitados em vez de sumir. */}
      <div className="mt-4 flex flex-wrap items-stretch gap-3">
        <div className="flex h-12 shrink-0 border-2 border-g-ink">
          <button type="button" aria-label="Diminuir" disabled={!canBuy || n <= 1} onClick={() => setN(Math.max(1, n - 1))} className="grid w-11 place-items-center disabled:opacity-40">
            <Minus size={18} />
          </button>
          <label htmlFor="qtd" className="sr-only">
            Quantidade de embalagens
          </label>
          <input id="qtd" inputMode="numeric" disabled={!canBuy} value={n} onChange={(e) => setN(Math.min(100000, Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1)))} className="num w-16 border-x-2 border-g-ink text-center text-lg font-bold outline-none disabled:opacity-40" />
          <button type="button" aria-label="Aumentar" disabled={!canBuy || n >= 100000} onClick={() => setN(Math.min(100000, n + 1))} className="grid w-11 place-items-center disabled:opacity-40">
            <Plus size={18} />
          </button>
        </div>
        {/* Largura vem do espaco livre, nao do texto: o total mudar de tamanho nao mexe no botao. */}
        <button type="button" onClick={submit} disabled={!canBuy || busy || tooMany} className="num h-12 min-w-48 flex-1 bg-g-green px-6 font-bold whitespace-nowrap text-white hover:bg-g-green-dark disabled:opacity-50">
          {!canBuy ? 'Esgotado no momento' : busy ? 'Adicionando…' : `Adicionar · ${reais(unit * n)}`}
        </button>
      </div>
      {/* Uma linha reservada para dica de desconto, falta de estoque ou erro: so uma aparece por vez. */}
      <div className="mt-2 min-h-5 text-[13px]" aria-live="polite">
        {error ? (
          <p role="alert" className="text-g-red">
            {error}
          </p>
        ) : tooMany ? (
          <p role="alert" className="text-g-red">
            Temos {pack.max_packs} {pack.max_packs === 1 ? 'embalagem' : 'embalagens'} desta opção agora.
          </p>
        ) : next && canBuy ? (
          <p className="font-semibold text-g-green">
            Leve {next.minPacks - n} a mais e cada embalagem sai por {reais(next.priceCents)}.
          </p>
        ) : null}
      </div>
    </div>
  );
}
