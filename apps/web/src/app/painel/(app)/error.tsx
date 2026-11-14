'use client';

import { ErrorScreen } from '@/components/error-screen';

export default function PanelError(props: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorScreen {...props} />;
}
