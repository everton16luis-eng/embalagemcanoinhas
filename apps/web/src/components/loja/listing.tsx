import Link from 'next/link';
import type { Category, Listing } from '@/lib/store';
import { Shelf } from './product-card';

const SORTS: [string, string][] = [
  ['relevance', 'Relevância'],
  ['unit_asc', 'Menor preço por unidade'],
  ['price_asc', 'Menor preço'],
  ['price_desc', 'Maior preço'],
  ['name', 'Nome'],
  ['newest', 'Novidades'],
];
const STOCKS: [string, string][] = [
  ['all', 'Todos'],
  ['in_stock', 'Pronta entrega'],
  ['made_to_order', 'Sob encomenda'],
];

type Params = Record<string, string | undefined>;
const href = (base: string, params: Params, patch: Params) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...patch })) if (v && !(k === 'page' && v === '1') && !(k === 'sort' && v === 'relevance') && !(k === 'stock' && v === 'all')) q.set(k, v);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
};

/** Grade de produtos com filtros, ordenacao e paginas. Funciona sem JavaScript (links e formulario GET). */
export function ListingView({ base, params, data, subcategories = [] }: { base: string; params: Params; data: Listing; subcategories?: Category[] }) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const stock = params.stock ?? 'all';
  return (
    <div className="mx-auto grid max-w-[1240px] gap-6 px-4 pt-4 pb-8 sm:px-8 md:grid-cols-[220px_1fr]">
      <aside aria-label="Filtros" className="text-[14px]">
        {subcategories.length > 0 && (
          <section>
            <h2 className="mb-2 border-t-2 border-g-ink pt-2 text-xs font-bold tracking-[0.06em] uppercase">Categorias</h2>
            <ul className="flex flex-wrap gap-2 md:block md:space-y-1.5">
              {subcategories.map((c) => (
                <li key={c.id}>
                  <Link href={`/c/${c.slug}`} className="block border border-g-line px-2.5 py-1.5 hover:border-g-ink md:border-0 md:p-0 md:hover:underline">
                    {c.name} <span className="text-g-faint">({c.product_count})</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className="mt-4 md:mt-5">
          <h2 className="mb-2 border-t-2 border-g-ink pt-2 text-xs font-bold tracking-[0.06em] uppercase">Disponibilidade</h2>
          <ul className="flex flex-wrap gap-2 md:block md:space-y-1.5">
            {STOCKS.map(([k, label]) => (
              <li key={k}>
                <Link href={href(base, params, { stock: k, page: '1' })} aria-current={stock === k ? 'true' : undefined} className="flex items-center gap-2">
                  <span className={`inline-block size-3.5 border-[1.5px] border-g-ink ${stock === k ? 'bg-g-ink shadow-[inset_0_0_0_2px_#fff]' : ''}`} aria-hidden />
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </aside>

      <div className="min-w-0">
        <form action={base} className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[13px]">
          <p className="text-g-soft">
            {data.total} {data.total === 1 ? 'produto' : 'produtos'}
          </p>
          {params.q && <input type="hidden" name="q" value={params.q} />}
          {stock !== 'all' && <input type="hidden" name="stock" value={stock} />}
          <label className="flex items-center gap-2">
            Ordenar por
            <select name="sort" defaultValue={params.sort ?? 'relevance'} className="border-[1.5px] border-g-ink bg-white px-2 py-1.5 font-semibold">
              {SORTS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="border-[1.5px] border-g-ink px-3 py-1.5 font-semibold">
            Aplicar
          </button>
        </form>
        {data.products.length === 0 ? (
          <div className="border border-g-line px-6 py-12 text-center">
            <p className="font-semibold">Nenhum produto encontrado.</p>
            <p className="mt-1 text-sm text-g-soft">Tente outra palavra, um código (SKU) ou tire o filtro de disponibilidade.</p>
          </div>
        ) : (
          <Shelf products={data.products} cols={3} />
        )}
        {pages > 1 && (
          <nav aria-label="Páginas" className="mt-5 flex flex-wrap gap-1.5">
            {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
              <Link
                key={n}
                href={href(base, params, { page: String(n) })}
                aria-current={n === data.page ? 'page' : undefined}
                className={`num grid size-9 place-items-center border-[1.5px] text-sm font-semibold ${n === data.page ? 'border-g-ink bg-g-ink text-white' : 'border-g-line'}`}
              >
                {n}
              </Link>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}
