import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ListingView } from '@/components/loja/listing';
import { getCategories, NotFound, storeGet, type Listing } from '@/lib/store';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> };

const pick = (sp: Record<string, string | undefined>) => ({ sort: sp.sort, stock: sp.stock, page: sp.page });

async function load(slug: string, sp: Record<string, string | undefined>) {
  const q = new URLSearchParams({ category: slug, pageSize: '24' });
  for (const [k, v] of Object.entries(pick(sp))) if (v) q.set(k, v);
  try {
    return await storeGet<Listing>(`/catalog/products?${q}`);
  } catch (e) {
    if (e instanceof NotFound) notFound();
    throw e;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const cat = (await getCategories()).find((c) => c.slug === slug);
  // Sem descricao propria, fica a da loja (definida no layout): `description: undefined` apagava a herdada.
  return { title: cat?.name ?? 'Departamento', ...(cat?.description ? { description: cat.description } : {}) };
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const sp = await searchParams;
  const [data, cats] = await Promise.all([load(slug, sp), getCategories()]);
  const cat = data.category!;
  const parent = cat.parent_id ? cats.find((c) => c.id === cat.parent_id) : null;
  const subs = cats.filter((c) => c.parent_id === cat.id && c.product_count > 0);

  return (
    <>
      <nav aria-label="Você está em" className="mx-auto max-w-[1240px] px-4 pt-4 text-xs text-g-soft sm:px-8">
        <Link href="/" className="hover:underline">
          Início
        </Link>
        {parent && (
          <>
            {' › '}
            <Link href={`/c/${parent.slug}`} className="hover:underline">
              {parent.name}
            </Link>
          </>
        )}
        {' › '}
        <span aria-current="page">{cat.name}</span>
      </nav>
      <header className="mx-auto max-w-[1240px] border-b border-g-line px-4 pt-1.5 pb-4 sm:px-8">
        <h1 className="cond text-[30px] leading-none font-extrabold uppercase sm:text-[38px]">{cat.name}</h1>
        {cat.description && <p className="mt-2 max-w-[60ch] text-g-soft">{cat.description}</p>}
      </header>
      <ListingView base={`/c/${slug}`} params={pick(sp)} data={data} subcategories={subs} />
    </>
  );
}
