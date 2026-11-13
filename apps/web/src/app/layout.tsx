import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/ibm-plex-sans/wght.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Loja',
  description: 'Embalagens e utensílios para confeitaria e panificação.',
};

export const viewport: Viewport = { themeColor: '#1b1d20' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
