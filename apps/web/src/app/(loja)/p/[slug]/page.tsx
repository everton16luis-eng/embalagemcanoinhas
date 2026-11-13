import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BuyBox, type ProductDetail } from '@/components/loja/buy-box';
import { Gallery } from '@/components/loja/gallery';
import { NotFound, storeGet } from '@/lib/store';

type Props = { params: Promise<{ slug: string }> };

async function load(slug: string) {
  try {
    return (await storeGet<{ product: ProductDetail }>(`/catalog/products/${encodeURIComponent(slug)}`)).product;
  } catch (e) {
    if (e instanceof NotFound) notFound();
    throw e;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = await load((await params).slug);
  return { title: p.name, description: p.summary ?? undefined };
}

export default async function ProductPage({ params }: Props) {
  const p = await load((await params).slug);
  const specs = p.specs && typeof p.specs === 'object' && !Array.isArray(p.specs) ? Object.entries(p.specs as Record<string, unknown>).filter(([, v]) => v !== null && v !== '') : [];
  return (
    <>
      <nav aria-label="Você está em" className="mx-auto max-w-[1240px] px-4 pt-4 text-xs text-g-soft sm:px-8">
        <Link href="/" className="hover:underline">
          Início
        </Link>
        {p.breadcrumb.map((b) => (
          <span key={b.slug}>
            {' › '}
            <Link href={`/c/${b.slug}`} className="hover:underline">
              {b.name}
            </Link>
          </span>
        ))}
      </nav>
      <div className="mx-auto grid max-w-[1240px] gap-8 px-4 pt-4 pb-6 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:gap-10">
        <Gallery images={p.images} alt={p.name} />
        <BuyBox product={p} />
      </div>
      {(p.description || specs.length > 0) && (
        <div className="mx-auto grid max-w-[1240px] gap-8 px-4 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:gap-10">
          {p.description && (
            <section>
              <h2 className="cond mb-3 border-b-[3px] border-g-ink pb-2 text-xl font-extrabold uppercase">Descrição</h2>
              <div className="max-w-[68ch] leading-relaxed whitespace-pre-line text-g-soft">{p.description}</div>
            </section>
          )}
          {specs.length > 0 && (
            <section>
              <h2 className="cond mb-3 border-b-[3px] border-g-ink pb-2 text-xl font-extrabold uppercase">Especificações</h2>
              <dl className="grid grid-cols-[auto_1fr] text-sm">
                {specs.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="border-b border-g-line py-2 pr-4 font-semibold">{k}</dt>
                    <dd className="border-b border-g-line py-2">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </div>
      )}
    </>
  );
}
