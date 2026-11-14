import { Search } from 'lucide-react';
import Link from 'next/link';
import { departments, getCategories } from '@/lib/store';

/** Conteudo da pagina 404 da loja: etiqueta de gondola "fora de linha", busca e departamentos. */
export async function NotFoundBody() {
  const depts = departments(await getCategories().catch(() => [])).filter((d) => d.total > 0);

  return (
    <section className="mx-auto max-w-[1240px] px-4 pt-10 pb-4 sm:px-8 sm:pt-14">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-start">
        <div>
          {/* Etiqueta de preco da gondola, no lugar do preco: o codigo do erro. */}
          <div className="inline-grid grid-cols-[auto_1fr] items-end gap-x-3 bg-g-label px-4 pt-3 pb-2" aria-hidden>
            <span className="cond-x text-[72px] leading-none font-extrabold sm:text-[96px]">404</span>
            <span className="pb-2 text-[13px] leading-tight font-bold uppercase">
              Fora
              <br />
              de linha
            </span>
          </div>
          <h1 className="cond mt-6 text-[34px] leading-[0.95] font-extrabold uppercase sm:text-[44px]">Esta prateleira está vazia</h1>
          <p className="mt-3 max-w-[52ch] text-[15px] text-g-soft">
            O endereço não existe ou o produto saiu da loja. Procure pelo nome, pela medida ou pelo código, ou escolha um departamento.
          </p>
          <form action="/busca" role="search" className="mt-6 flex h-12 max-w-xl border-2 border-g-ink bg-white">
            <label htmlFor="busca-404" className="sr-only">
              Buscar produtos
            </label>
            <input id="busca-404" name="q" type="search" placeholder="Ex.: forminha nº 4, caixa 12 doces" className="min-w-0 flex-1 px-3.5 text-[15px] outline-none placeholder:text-g-faint" />
            <button type="submit" className="flex items-center gap-2 bg-g-ink px-5 font-semibold text-white">
              <Search size={18} aria-hidden />
              Buscar
            </button>
          </form>
          <Link href="/" className="mt-5 inline-block text-[14px] font-semibold text-g-green underline underline-offset-4">
            Voltar para a página inicial
          </Link>
        </div>

        {depts.length > 0 && (
          <nav aria-label="Departamentos" className="border-t-[3px] border-g-ink pt-3 lg:mt-2">
            <h2 className="cond text-xl font-extrabold uppercase">Departamentos</h2>
            <ul className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {depts.map((d) => (
                <li key={d.id}>
                  <Link href={`/c/${d.slug}`} className="flex min-h-14 items-center justify-between gap-3 border border-g-line bg-white px-3.5 py-2.5 hover:border-g-ink">
                    <span className="cond text-[19px] leading-none font-extrabold uppercase [overflow-wrap:anywhere]">{d.name}</span>
                    <span className="shrink-0 text-[13px] font-semibold text-g-green">
                      {d.total} {d.total === 1 ? 'produto' : 'produtos'} <span aria-hidden>›</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>
    </section>
  );
}
