import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AdminShell } from '@/components/shell';

// O tradutor automático do Chrome troca os textos da página por conta própria e derruba telas que se atualizam
// (o chat de teste, botões que mostram "Aguarde…"). O painel é só em português, então a tradução fica desligada.
export const metadata: Metadata = { title: 'Painel', robots: { index: false, follow: false }, other: { google: 'notranslate' } };

export default function PanelLayout({ children }: { children: ReactNode }) {
  return (
    <div translate="no" className="contents">
      <AdminShell>{children}</AdminShell>
    </div>
  );
}
