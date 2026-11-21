'use client';

import { Activity, ArrowLeftRight, BarChart3, Inbox, Blocks, Building, Mail, MessageCircle, TrendingUp, Boxes, PackageCheck, Hourglass, Building2, ClipboardCheck, ClipboardList, FileText, FolderTree, History, LogOut, MapPinned, Menu, Package, ReceiptText, Receipt, RefreshCw, Route, Search, Settings, ShoppingCart, Store, TriangleAlert, Truck, Undo2, UserRound, Users, Warehouse, X } from 'lucide-react';
import Link from '@/components/painel-link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '@/lib/api';
import { ROLE_LABELS } from '@/lib/format';

export type Me = { user: { id: string; name: string; email: string; role: string; mfaEnabled: boolean }; permissions: string[] };
const MeContext = createContext<{ me: Me; can: (p: string) => boolean; reload: () => Promise<void> } | null>(null);

export function useMe() {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error('useMe fora do painel');
  return ctx;
}

// Itens das fases seguintes nao aparecem: o menu mostra so o que ja funciona.
const NAV = [
  { href: '/painel', label: 'Configuração inicial', icon: ClipboardCheck, perm: null },
  { href: '/painel/balcao', label: 'Balcão', icon: Search, perm: 'sales_desk.use' },
  { href: '/painel/orcamentos', label: 'Orçamentos', icon: ReceiptText, perm: 'sales_desk.use' },
  { href: '/painel/pedidos', label: 'Pedidos', icon: Package, perm: 'orders.view' },
  { href: '/painel/whatsapp', label: 'WhatsApp', icon: MessageCircle, perm: 'sales_desk.use' },
  { href: '/painel/marketplaces', label: 'Marketplaces', icon: Blocks, perm: 'marketplaces.manage' },
  { href: '/painel/produtos', label: 'Produtos', icon: Boxes, perm: 'catalog.view' },
  { href: '/painel/categorias', label: 'Categorias', icon: FolderTree, perm: 'catalog.view' },
  // Menu LOGISTICA (SGLog Fase 3, D3-6): agrupa o que ja existia, sem mudar endereco nem permissao.
  // SGLog Fase 4: alocacao dos pedidos pagos (deposito ou fornecedor).
  { href: '/painel/logistica/alocacao', label: 'Alocação', icon: Route, perm: 'logistics.view', group: 'Logística' },
  { href: '/painel/logistica/expedicao', label: 'Expedição', icon: PackageCheck, perm: 'logistics.view', group: 'Logística' },
  { href: '/painel/logistica/fretes', label: 'Fretes', icon: Receipt, perm: 'logistics.view', group: 'Logística' },
  { href: '/painel/logistica/encomendas', label: 'Encomendas', icon: Hourglass, perm: 'logistics.view', group: 'Logística' },
  // SGLog Fase 9: ocorrencias e devolucoes (logistica reversa, conferencia e quarentena).
  { href: '/painel/logistica/ocorrencias', label: 'Ocorrências', icon: TriangleAlert, perm: 'occurrences.manage|returns.manage|logistics.view', group: 'Logística' },
  { href: '/painel/logistica/devolucoes', label: 'Devoluções', icon: Undo2, perm: 'returns.manage|returns.receive|logistics.view', group: 'Logística' },
  // SGLog Fase 7: abastecimento (compras sem confirmacao, atrasos, a caminho) e requisicoes internas de compra.
  { href: '/painel/logistica/abastecimento', label: 'Abastecimento', icon: Activity, perm: 'logistics.view|purchases.view', group: 'Logística' },
  { href: '/painel/estoque', label: 'Estoque', icon: Warehouse, perm: 'stock.view', group: 'Logística' },
  { href: '/painel/inventario', label: 'Inventário', icon: ClipboardList, perm: 'stock.view', group: 'Logística' },
  { href: '/painel/transferencias', label: 'Transferências', icon: ArrowLeftRight, perm: 'stock.view', group: 'Logística' },
  { href: '/painel/depositos', label: 'Depósitos', icon: Building, perm: 'stock.view', group: 'Logística' },
  { href: '/painel/compras', label: 'Compras', icon: ShoppingCart, perm: 'purchases.view', group: 'Logística' },
  { href: '/painel/compras/requisicoes', label: 'Requisições', icon: Inbox, perm: 'purchases.view|purchases.request', group: 'Logística' },
  { href: '/painel/reposicao', label: 'Reposição', icon: RefreshCw, perm: 'purchases.view', group: 'Logística' },
  { href: '/painel/fornecedores', label: 'Fornecedores', icon: Truck, perm: 'suppliers.view|purchases.view', group: 'Logística' },
  { href: '/painel/fiscal', label: 'Nota fiscal', icon: FileText, perm: 'fiscal.view' },
  { href: '/painel/entregas', label: 'Formas de entrega', icon: MapPinned, perm: 'orders.view' },
  { href: '/painel/vendas', label: 'Vendas', icon: TrendingUp, perm: 'reports.view' },
  { href: '/painel/relatorios', label: 'Relatórios de estoque', icon: BarChart3, perm: 'reports.view' },
  { href: '/painel/empresa', label: 'Empresa e fiscal', icon: Building2, perm: 'company.view' },
  { href: '/painel/loja', label: 'Marca da loja', icon: Store, perm: 'settings.manage' },
  { href: '/painel/usuarios', label: 'Usuários', icon: Users, perm: 'users.view' },
  { href: '/painel/email', label: 'E-mails', icon: Mail, perm: 'email.view' },
  { href: '/painel/auditoria', label: 'Auditoria', icon: History, perm: 'audit.view' },
] as const satisfies readonly { href: string; label: string; icon: unknown; perm: string | null; group?: string }[];

export function AdminShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState(false);

  const reload = useCallback(async () => {
    try {
      setMe(await api<Me>('/auth/me'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.replace(`/painel/entrar?voltar=${encodeURIComponent(pathname)}`);
    }
  }, [router, pathname]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => setOpen(false), [pathname]);

  if (!me) return <div className="grid min-h-dvh place-items-center text-sm text-ink-faint">Carregando…</div>;
  // "a|b": basta uma das permissoes (ex.: fornecedores aceita suppliers.view ou purchases.view).
  const can = (p: string) => p.split('|').some((x) => me.permissions.includes(x));
  const items = NAV.filter((n) => !n.perm || can(n.perm));
  // O item mais especifico vence (Compras x Compras > Requisicoes).
  const active = (href: string) =>
    href === '/painel' ? pathname === href : pathname.startsWith(href) && !NAV.some((n) => n.href.length > href.length && n.href.startsWith(href) && pathname.startsWith(n.href));

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => null);
    router.replace('/painel/entrar');
  };

  const nav = (
    <nav aria-label="Painel" className="flex h-full flex-col">
      <div className="px-4 pt-5 pb-4">
        <p className="text-[11px] font-semibold tracking-[0.14em] text-side-ink uppercase">Painel</p>
        <p className="mt-0.5 text-[15px] font-semibold text-white">Gestão da loja</p>
      </div>
      {/* So a lista rola: usuario e Sair ficam fixos embaixo, sempre sobre o fundo da barra. */}
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain px-2 pb-2 [scrollbar-color:rgb(255_255_255/0.2)_transparent] [scrollbar-width:thin]">
        {items.map(({ href, label, icon: Icon, ...rest }, i) => {
          const group = 'group' in rest ? rest.group : undefined;
          const prev = items[i - 1];
          const opens = group && (!prev || !('group' in prev) || prev.group !== group);
          const closes = !group && prev && 'group' in prev;
          return (
          <li key={href} className={opens ? 'pt-3' : closes ? 'pt-3' : undefined}>
            {opens && <p className="px-2.5 pb-1 text-[11px] font-semibold tracking-[0.14em] text-side-ink/80 uppercase">{group}</p>}
            <Link
              href={href}
              aria-current={active(href) ? 'page' : undefined}
              className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm ${active(href) ? 'bg-white/10 text-white' : 'text-side-ink hover:bg-white/5 hover:text-white'}`}
            >
              <Icon size={17} strokeWidth={1.75} aria-hidden />
              {label}
            </Link>
          </li>
          );
        })}
      </ul>
      <div className="shrink-0 border-t border-side-line p-2">
        <Link href="/painel/conta" className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm ${active('/painel/conta') ? 'bg-white/10 text-white' : 'text-side-ink hover:bg-white/5 hover:text-white'}`}>
          <UserRound size={17} strokeWidth={1.75} aria-hidden />
          <span className="min-w-0">
            <span className="block truncate">{me.user.name}</span>
            <span className="block text-xs text-side-ink/80">{ROLE_LABELS[me.user.role]}</span>
          </span>
        </Link>
        <button onClick={logout} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-side-ink hover:bg-white/5 hover:text-white">
          <LogOut size={17} strokeWidth={1.75} aria-hidden />
          Sair
        </button>
      </div>
    </nav>
  );

  return (
    <MeContext.Provider value={{ me, can, reload }}>
      <div className="min-h-dvh lg:grid lg:grid-cols-[232px_1fr]">
        <aside className="hidden overflow-hidden bg-side lg:sticky lg:top-0 lg:block lg:h-dvh">{nav}</aside>
        <div className="flex items-center justify-between bg-side px-4 py-2.5 lg:hidden">
          <span className="text-sm font-semibold text-white">Gestão da loja</span>
          <button onClick={() => setOpen(true)} aria-label="Abrir menu" className="rounded p-1.5 text-white">
            <Menu size={20} />
          </button>
        </div>
        {open && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <button aria-label="Fechar menu" className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
            <aside className="absolute inset-y-0 left-0 w-72 bg-side">
              <button onClick={() => setOpen(false)} aria-label="Fechar menu" className="absolute top-4 right-3 rounded p-1 text-side-ink">
                <X size={18} />
              </button>
              {nav}
            </aside>
          </div>
        )}
        <main className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
          {!me.user.mfaEnabled && (
            <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warn/25 bg-warn-tint px-3.5 py-2.5 text-sm text-warn">
              <span>Ative a verificação em duas etapas: sem ela, dados da empresa, fiscal, preços e usuários ficam bloqueados.</span>
              <Link href="/painel/conta" className="font-medium underline underline-offset-2">
                Ativar agora
              </Link>
            </div>
          )}
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
    </MeContext.Provider>
  );
}

export function Guard({ perm, children }: { perm: string; children: ReactNode }) {
  const { can } = useMe();
  if (!can(perm)) return <p className="text-sm text-ink-soft">Você não tem permissão para esta área.</p>;
  return <>{children}</>;
}

export { Settings };
