import { CreditCard, FileText, QrCode, Store } from 'lucide-react';
import Link from 'next/link';
import { qtyText, reais, unitName, unitReais } from '@/components/loja/price';
import { Shelf } from '@/components/loja/product-card';
import { departments, getCategories, storeGet, type Listing } from '@/lib/store';

type Detail = { product: { name: string; slug: string; base_unit: string; variants: { packagings: { label: string; base_qty: string; price_cents: string; tiers: { minPacks: number; priceCents: number }[] }[] }[] } };

/** Exemplo real de preco por quantidade: usa um produto cadastrado com faixas. Sem faixa, a secao nao aparece. */
async function ladderExample(list: Listing['products']) {
  const withTier = list.find((p) => p.first_tier);
  if (!withTier) return null;
  const d = await storeGet<Detail>(`/catalog/products/${withTier.slug}`).catch(() => null);
  const pack = d?.product.variants.flatMap((v) => v.packagings).find((k) => k.tiers.length);
  if (!d || !pack) return null;
  return { product: d.product, pack };
}

export default async function Home() {
  const [cats, newest] = await Promise.all([getCategories().catch(() => []), storeGet<Listing>('/catalog/products?sort=newest&pageSize=8').catch(() => null)]);
  const depts = departments(cats).filter((d) => d.total > 0);
  const ladder = newest ? await ladderExample(newest.products) : null;

  return (
    <>
      <section className="bg-g-paper">
        <div className="mx-auto grid max-w-[1240px] gap-7 px-4 py-7 sm:px-8 sm:py-9 lg:grid-cols-[1fr_1.25fr]">
          <div className="self-center">
            <h1 className="cond text-[38px] leading-[0.95] font-extrabold uppercase sm:text-[50px]">
              Embalagens e utensílios para confeitaria e panificação
            </h1>
            <p className="mt-4 max-w-[42ch] text-[17px] text-g-soft">
              Caixas, forminhas, descartáveis e insumos não perecíveis, por unidade ou em quantidade. Preço da embalagem e preço por unidade lado a lado, para você comparar.
            </p>
            <form action="/busca" className="mt-5 flex max-w-md border-2 border-g-ink bg-white" role="search">
              <label htmlFor="sku" className="sr-only">
                Pedido rápido por código
              </label>
              <input id="sku" name="q" placeholder="Pedido rápido: digite o código (SKU)" className="min-w-0 flex-1 px-3 py-2.5 outline-none placeholder:text-g-faint" />
              <button className="bg-g-ink px-4 text-sm font-bold text-white">Ir</button>
            </form>
          </div>
          {depts.length > 0 && (
            <nav aria-label="Departamentos em destaque" className="grid grid-cols-2 content-center gap-2.5 sm:grid-cols-3">
              {depts.slice(0, 6).map((d) => (
                <Link key={d.id} href={`/c/${d.slug}`} className="group flex min-h-28 flex-col justify-between border border-g-line bg-white p-3.5 hover:border-g-ink">
                  <span className="cond text-[22px] leading-none font-extrabold uppercase [overflow-wrap:anywhere]">{d.name}</span>
                  <span className="mt-3 flex items-center justify-between text-[13px] font-semibold text-g-green">
                    {d.total} {d.total === 1 ? 'produto' : 'produtos'} <span aria-hidden>›</span>
                  </span>
                </Link>
              ))}
            </nav>
          )}
        </div>
      </section>

      {ladder && (
        <section className="mx-auto max-w-[1240px] px-4 pt-8 sm:px-8">
          <div className="mb-4 flex items-end justify-between gap-3 border-b-[3px] border-g-ink pb-2">
            <h2 className="cond text-2xl font-extrabold uppercase">Quanto mais leva, menos paga</h2>
            <Link href={`/p/${ladder.product.slug}`} className="shrink-0 text-[13px] font-semibold text-g-green">
              Ver produto ›
            </Link>
          </div>
          <div className="border-2 border-g-ink">
            <div className="grid sm:auto-cols-fr sm:grid-flow-col">
              <div className="border-b border-g-line p-4 sm:border-r sm:border-b-0">
                <p className="font-semibold">{ladder.product.name}</p>
                <p className="text-[13px] text-g-soft">
                  {ladder.pack.label} · {qtyText(ladder.pack.base_qty)} {unitName(ladder.product.base_unit)}
                </p>
              </div>
              {[{ minPacks: 1, priceCents: Number(ladder.pack.price_cents) }, ...ladder.pack.tiers].map((t) => (
                <div key={t.minPacks} className="border-b border-g-line p-4 last:border-0 sm:border-r sm:border-b-0">
                  <p className="cond text-[28px] leading-none font-extrabold">{t.minPacks === 1 ? '1+' : `${t.minPacks}+`}</p>
                  <p className="mt-1.5 inline-block bg-g-label px-2 py-0.5 font-bold">{reais(t.priceCents)} cada</p>
                  <p className="mt-1 text-xs text-g-soft">
                    {unitReais(t.priceCents / Number(ladder.pack.base_qty))} por {unitName(ladder.product.base_unit)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {newest && newest.products.length > 0 && (
        <section className="mx-auto max-w-[1240px] px-4 pt-8 sm:px-8">
          <div className="mb-4 flex items-end justify-between gap-3 border-b-[3px] border-g-ink pb-2">
            <h2 className="cond text-2xl font-extrabold uppercase">Chegaram na loja</h2>
            <Link href="/busca?sort=newest" className="shrink-0 text-[13px] font-semibold text-g-green">
              Ver todos ›
            </Link>
          </div>
          <Shelf products={newest.products} />
        </section>
      )}

      <section aria-label="Como funciona" className="mx-auto max-w-[1240px] px-4 pt-8 sm:px-8">
        <ul className="grid border border-g-line sm:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: QrCode, t: 'Pix', d: 'Código na hora, confirmação automática.' },
            { icon: CreditCard, t: 'Cartão de crédito', d: 'Dados do cartão direto com o Mercado Pago, nunca com a loja.' },
            { icon: FileText, t: 'Nota fiscal', d: 'NF-e emitida para todo pedido, para pessoa física ou empresa.' },
            { icon: Store, t: 'Pronta entrega ou encomenda', d: 'Cada produto mostra se sai do estoque ou se é pedido ao fornecedor.' },
          ].map(({ icon: Icon, t, d }) => (
            <li key={t} className="border-b border-g-line p-4 text-[13px] text-g-soft last:border-0 sm:border-r lg:border-b-0">
              <Icon size={22} className="mb-1.5 text-g-green" aria-hidden />
              <b className="block text-[15px] text-g-ink">{t}</b>
              {d}
            </li>
          ))}
        </ul>
      </section>

      {!newest?.products.length && (
        <section className="mx-auto max-w-[1240px] px-4 pt-8 sm:px-8">
          <p className="border border-g-line p-6 text-g-soft">Os produtos aparecem aqui assim que forem publicados no painel.</p>
        </section>
      )}
    </>
  );
}
