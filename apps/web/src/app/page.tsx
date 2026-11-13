// Pagina provisoria. A vitrine sera construida na Fase 4, depois da aprovacao da direcao visual.
export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6">
      <p className="text-sm font-medium tracking-wide text-ink-faint uppercase">Em preparação</p>
      <h1 className="mt-2 text-3xl font-semibold text-balance">A loja virtual está sendo montada.</h1>
      <p className="mt-3 text-ink-soft">Embalagens e utensílios para confeitaria e panificação, com entrega no Planalto Norte catarinense.</p>
      <a href="/painel" className="mt-8 self-start text-sm font-medium text-act underline underline-offset-4">
        Acesso da equipe
      </a>
    </main>
  );
}
