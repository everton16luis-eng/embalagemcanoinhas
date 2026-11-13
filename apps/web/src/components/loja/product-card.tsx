import Link from 'next/link';
import type { Card } from '@/lib/store';
import { QuickAdd } from './quick-add';
import { Photo, PriceTag, qtyText, reais, Stock, unitName } from './price';

/** Card de prateleira: foto, nome, embalagem, etiqueta de preco, faixa de quantidade e disponibilidade. */
export function ProductCard({ p }: { p: Card }) {
  const buyable = p.in_stock || p.availability_mode === 'made_to_order';
  return (
    <article className="flex min-w-0 flex-col gap-2 border-r border-b border-g-line bg-white p-3 sm:p-3.5">
      <Link href={`/p/${p.slug}`} className="group flex flex-col gap-2">
        <Photo imageKey={p.image_key} alt={p.name} />
        <h3 className="line-clamp-2 min-h-[2.5em] text-[15px] leading-tight font-semibold [overflow-wrap:anywhere] group-hover:underline">{p.name}</h3>
      </Link>
      <p className="text-xs text-g-soft">
        {p.packaging_label} · {qtyText(p.base_qty)} {unitName(p.base_unit)}
        {p.variant_count > 1 && ` · ${p.variant_count} opções`}
      </p>
      <PriceTag priceCents={p.price_cents} baseQty={p.base_qty} baseUnit={p.base_unit} />
      <p className="min-h-[1.3em] text-xs font-semibold text-g-green">{p.first_tier ? `A partir de ${p.first_tier.minPacks}: ${reais(p.first_tier.priceCents)} cada` : ''}</p>
      <Stock inStock={p.in_stock} madeToOrder={p.availability_mode === 'made_to_order'} leadTimeDays={p.lead_time_days} />
      <div className="mt-auto pt-1">
        {p.variant_count > 1 || !buyable ? (
          <Link href={`/p/${p.slug}`} className="block border-[1.5px] border-g-ink py-2.5 text-center text-sm font-bold">
            {buyable ? 'Escolher opção' : 'Ver produto'}
          </Link>
        ) : (
          <QuickAdd packagingId={p.packaging_id} />
        )}
      </div>
    </article>
  );
}

export function Shelf({ products, cols = 4 }: { products: Card[]; cols?: 3 | 4 }) {
  return (
    <div className={`grid grid-cols-2 border-t border-l border-g-line ${cols === 4 ? 'md:grid-cols-3 lg:grid-cols-4' : 'md:grid-cols-3'}`}>
      {products.map((p) => (
        <ProductCard key={p.id} p={p} />
      ))}
    </div>
  );
}
