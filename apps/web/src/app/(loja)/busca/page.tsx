import type { Metadata } from 'next';
import { ListingView } from '@/components/loja/listing';
import { storeGet, type Listing } from '@/lib/store';

export const metadata: Metadata = { title: 'Busca', robots: { index: false } };

type Props = { searchParams: Promise<Record<string, string | undefined>> };

export default async function SearchPage({ searchParams }: Props) {
  const sp = await searchParams;
  const term = (sp.q ?? '').trim().slice(0, 100);
  const params = { q: term || undefined, sort: sp.sort, stock: sp.stock, page: sp.page };
  const q = new URLSearchParams({ pageSize: '24' });
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const data = await storeGet<Listing>(`/catalog/products?${q}`);
  return (
    <>
      <header className="mx-auto max-w-[1240px] border-b border-g-line px-4 pt-5 pb-4 sm:px-8">
        <h1 className="cond text-[30px] leading-none font-extrabold uppercase sm:text-[38px]">{term ? `Busca: ${term}` : 'Todos os produtos'}</h1>
      </header>
      <ListingView base="/busca" params={params} data={data} />
    </>
  );
}
