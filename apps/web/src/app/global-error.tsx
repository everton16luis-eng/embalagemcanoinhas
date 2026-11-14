'use client';

import './globals.css';
import { ErrorScreen } from '@/components/error-screen';

export default function GlobalError(props: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="pt-BR">
      <body>
        <ErrorScreen {...props} />
      </body>
    </html>
  );
}
