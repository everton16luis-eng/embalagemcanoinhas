'use client';

import { useEffect } from 'react';

// Depois de uma atualização no servidor, uma aba aberta antes dela pede arquivos de JavaScript que já não existem.
// Nesse caso a solução é recarregar a página.
const STALE = /ChunkLoadError|Loading (CSS )?chunk|dynamically imported module|Importing a module script failed/i;
const MARK = 'reload-after-update';

export function ErrorScreen({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const stale = STALE.test(`${error.name} ${error.message}`);
  useEffect(() => {
    console.error(error);
    if (!stale) return;
    try {
      // Só recarrega sozinho se não recarregou há menos de um minuto, para não entrar em laço.
      if (Date.now() - Number(sessionStorage.getItem(MARK) ?? 0) < 60_000) return;
      sessionStorage.setItem(MARK, String(Date.now()));
    } catch {
      return;
    }
    window.location.reload();
  }, [error, stale]);

  return (
    <div className="mx-auto max-w-md px-4 py-12 text-center">
      <h1 className="text-lg font-semibold">{stale ? 'O sistema foi atualizado' : 'Esta tela não carregou'}</h1>
      <p className="mt-2 text-sm text-ink-soft">
        {stale ? 'Recarregue a página para usar a versão nova.' : 'Tente de novo. Se continuar, recarregue a página. Nada do que já estava salvo foi perdido.'}
      </p>
      {error.digest && <p className="mt-2 font-mono text-xs text-ink-faint">Código: {error.digest}</p>}
      <div className="mt-5 flex justify-center gap-2">
        {!stale && (
          <button type="button" onClick={() => retry()} className="h-9 rounded-[var(--radius-ctl)] bg-act px-3.5 text-sm font-medium text-white hover:bg-act-dark">
            Tentar de novo
          </button>
        )}
        <button type="button" onClick={() => window.location.reload()} className="h-9 rounded-[var(--radius-ctl)] border border-line-strong bg-card px-3.5 text-sm font-medium hover:bg-sunken">
          Recarregar a página
        </button>
      </div>
    </div>
  );
}
