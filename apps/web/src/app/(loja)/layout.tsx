import '@fontsource-variable/archivo/wdth.css';
import { Search, UserRound } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CartButton, CartProvider } from '@/components/loja/cart';
import { MobileDepartments } from '@/components/loja/nav';
import { departments, getCategories, getStore } from '@/lib/store';

export async function generateMetadata(): Promise<Metadata> {
  const { store } = await getStore().catch(() => ({ store: { name: null, tagline: null } }));
  return {
    title: { default: store.name ?? 'Loja', template: `%s · ${store.name ?? 'Loja'}` },
    description: store.tagline ?? 'Embalagens, utensílios e insumos não perecíveis para confeitaria e panificação.',
  };
}

const PAGE_TITLES: Record<string, string> = { about: 'Quem somos', shipping: 'Entrega e retirada', returns: 'Trocas e devoluções', privacy: 'Privacidade', terms: 'Termos de uso' };
const cnpjText = (v: string) => v.replace(/^(\w{2})(\w{3})(\w{3})(\w{4})(\d{2})$/, '$1.$2.$3/$4-$5');

export default async function StoreLayout({ children }: { children: ReactNode }) {
  const [cats, info] = await Promise.all([getCategories().catch(() => []), getStore().catch(() => null)]);
  const depts = departments(cats).filter((d) => d.total > 0);
  const name = info?.store.name;
  const c = info?.company;

  return (
    <CartProvider>
      <div className="loja flex min-h-dvh flex-col">
        <a href="#conteudo" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-g-label focus:px-3 focus:py-2">
          Ir para o conteúdo
        </a>
        <header>
          <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-8 sm:py-3.5">
            <Link href="/" className="order-1 mr-auto sm:mr-0">
              {name ? (
                <span className="cond block text-[26px] leading-none font-extrabold tracking-tight uppercase">{name}</span>
              ) : (
                // Nome provisorio ate a marca ser cadastrada em Painel > Marca da loja.
                <span className="cond block border-2 border-dashed border-g-line px-2 py-0.5 text-[22px] leading-none font-extrabold text-g-faint uppercase">Nome da loja</span>
              )}
            </Link>
            <form action="/busca" role="search" className="order-3 flex h-11 w-full border-2 border-g-ink sm:order-2 sm:w-auto sm:flex-1">
              <label htmlFor="busca" className="sr-only">
                Buscar produtos
              </label>
              <input id="busca" name="q" type="search" placeholder="Buscar por produto, medida ou código" className="min-w-0 flex-1 px-3.5 text-[15px] outline-none placeholder:text-g-faint" />
              <button type="submit" aria-label="Buscar" className="flex items-center gap-2 bg-g-ink px-4 font-semibold text-white sm:px-5">
                <Search size={18} aria-hidden />
                <span className="hidden sm:inline">Buscar</span>
              </button>
            </form>
            <nav aria-label="Atalhos" className="order-2 flex items-center gap-5 sm:order-3">
              <Link href="/conta" aria-label="Minha conta" className="flex items-center gap-1.5 text-[13px] font-semibold">
                <UserRound size={20} aria-hidden />
                <span className="hidden sm:inline">Minha conta</span>
              </Link>
              <CartButton />
            </nav>
          </div>
          {depts.length > 0 && (
            <nav aria-label="Departamentos" className="bg-g-ink text-white">
              <div className="mx-auto hidden max-w-[1240px] px-8 sm:flex">
                {depts.map((d) => (
                  <Link key={d.id} href={`/c/${d.slug}`} className="border-r border-white/15 px-3.5 py-2.5 text-[13px] font-semibold tracking-wide uppercase hover:bg-g-green">
                    {d.name}
                  </Link>
                ))}
              </div>
              <MobileDepartments items={depts.map((d) => ({ name: d.name, slug: d.slug, children: d.children.filter((x) => x.product_count > 0).map((x) => ({ name: x.name, slug: x.slug })) }))} />
            </nav>
          )}
        </header>

        <main id="conteudo" className="flex-1">
          {children}
        </main>

        <footer className="mt-12 bg-g-ink text-[13px] text-[#cfd5d1]">
          <div className="mx-auto grid max-w-[1240px] gap-8 px-4 py-8 sm:grid-cols-[1.4fr_1fr_1fr] sm:px-8">
            <div>
              <p className="mb-2 text-xs font-bold tracking-[0.08em] text-white uppercase">{name ?? 'Loja'}</p>
              {c?.legal_name ? (
                <p className="leading-relaxed">
                  {c.legal_name}
                  {c.cnpj && (
                    <>
                      <br />
                      CNPJ {cnpjText(c.cnpj)}
                    </>
                  )}
                  {c.city && (
                    <>
                      <br />
                      {c.street ? `${c.street}, ${c.number ?? 's/n'} · ${c.district ?? ''} · ` : ''}
                      {c.city}/{c.uf}
                    </>
                  )}
                </p>
              ) : (
                <p className="text-[#9aa29e]">Identificação da empresa ainda não cadastrada no painel.</p>
              )}
            </div>
            <div>
              <p className="mb-2 text-xs font-bold tracking-[0.08em] text-white uppercase">Atendimento</p>
              <ul className="space-y-1.5">
                {info?.store.whatsapp && (
                  <li>
                    <a className="hover:text-white" href={`https://wa.me/${info.store.whatsapp}`} target="_blank" rel="noreferrer">
                      WhatsApp
                    </a>
                  </li>
                )}
                {info?.store.email && (
                  <li>
                    <a className="hover:text-white" href={`mailto:${info.store.email}`}>
                      {info.store.email}
                    </a>
                  </li>
                )}
                <li>
                  <Link className="hover:text-white" href="/conta">
                    Meus pedidos
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <p className="mb-2 text-xs font-bold tracking-[0.08em] text-white uppercase">Compra segura</p>
              <ul className="space-y-1.5">
                <li>Pix e cartão processados pelo Mercado Pago</li>
                <li>Nota fiscal eletrônica em todos os pedidos</li>
                {(info?.store.pages ?? []).map((k) => (
                  <li key={k}>
                    <Link className="hover:text-white" href={`/institucional/${k}`}>
                      {PAGE_TITLES[k] ?? k}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </footer>
      </div>
    </CartProvider>
  );
}
