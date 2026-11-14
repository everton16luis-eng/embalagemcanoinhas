import { Package } from 'lucide-react';
import { imageUrl } from '@/lib/api';

const brl = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const unitFmt = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const qtyFmt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });

export const reais = (cents: string | number) => `R$ ${brl.format(Number(cents) / 100)}`;
export const unitReais = (cents: string | number) => `R$ ${unitFmt.format(Number(cents) / 100)}`;
export const qtyText = (v: string | number) => qtyFmt.format(Number(v));

const UNIT_NAMES: Record<string, string> = { UN: 'un.', KG: 'kg', G: 'g', L: 'L', ML: 'ml', M: 'm', CM: 'cm', PCT: 'pct', CX: 'cx', FD: 'fardo', RL: 'rolo' };
export const unitName = (code: string) => UNIT_NAMES[code] ?? code.toLowerCase();

/**
 * Etiqueta de gondola: preco da embalagem em destaque e, ao lado, o preco por unidade base,
 * para comparar pacotes de tamanhos diferentes. O amarelo da loja so aparece aqui.
 */
export function PriceTag({ priceCents, baseQty, baseUnit, size = 'md' }: { priceCents: string | number; baseQty: string; baseUnit: string; size?: 'md' | 'lg' }) {
  const [int, dec] = brl.format(Number(priceCents) / 100).split(',');
  const per = Number(baseQty) > 1 || baseUnit !== 'UN' ? Number(priceCents) / Number(baseQty) : null;
  return (
    <div className={`grid grid-cols-[auto_1fr] items-end gap-x-3 bg-g-label ${size === 'lg' ? 'px-4 py-3' : 'px-2.5 pt-2 pb-1.5'}`}>
      <p className={`cond-x num leading-none font-extrabold ${size === 'lg' ? 'text-[44px]' : 'text-[27px]'}`}>
        <span className={`align-top font-bold ${size === 'lg' ? 'text-lg' : 'text-sm'}`}>R$&nbsp;</span>
        {int}
        <span className={size === 'lg' ? 'text-2xl' : 'text-base'}>,{dec}</span>
      </p>
      {per !== null && (
        <p className={`text-right leading-tight font-semibold ${size === 'lg' ? 'text-sm' : 'text-[11px]'}`}>
          {unitReais(per)}
          <br />
          por {unitName(baseUnit)}
        </p>
      )}
    </div>
  );
}

export function Stock({ inStock, madeToOrder, leadTimeDays }: { inStock: boolean; madeToOrder: boolean; leadTimeDays: number | null }) {
  if (inStock) return <p className="flex items-center gap-1.5 text-[13px] font-semibold text-g-green before:size-2 before:bg-g-green">Pronta entrega</p>;
  if (madeToOrder)
    return (
      <p className="flex items-center gap-1.5 text-[13px] font-semibold text-g-amber before:size-2 before:bg-[#d08b00]">
        Sob encomenda{leadTimeDays ? ` · ${leadTimeDays} dias` : ''}
      </p>
    );
  return <p className="flex items-center gap-1.5 text-[13px] font-semibold text-g-faint before:size-2 before:bg-g-line">Esgotado no momento</p>;
}

/** Foto do produto ou um espaco neutro marcado para substituicao (nunca imagem inventada). */
export function Photo({ imageKey, alt, size = 320, className = '' }: { imageKey: string | null; alt: string; size?: 320 | 800 | 1600; className?: string }) {
  if (imageKey) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={imageUrl(imageKey, size)} alt={alt} loading="lazy" className={`aspect-square w-full bg-g-photo object-contain ${className}`} />;
  }
  return (
    <div role="img" aria-label={`${alt}: foto em breve`} className={`@container grid aspect-square w-full place-items-center bg-g-photo text-g-faint ${className}`}>
      <span className="flex flex-col items-center gap-1 text-[11px] font-semibold tracking-wider uppercase">
        <Package size={size === 320 ? 30 : 56} strokeWidth={1.25} aria-hidden />
        {/* Em miniaturas pequenas (carrinho) fica so o icone. */}
        <span className="hidden @[120px]:inline">Foto em breve</span>
      </span>
    </div>
  );
}
