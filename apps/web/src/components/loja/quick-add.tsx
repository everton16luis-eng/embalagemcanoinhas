'use client';

import { useState } from 'react';
import { useCart } from './cart';

export function QuickAdd({ packagingId, packs = 1, label = 'Adicionar' }: { packagingId: string; packs?: number; label?: string }) {
  const { add } = useCart();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            await add(packagingId, packs);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
        className="w-full bg-g-green py-2.5 text-sm font-bold text-white hover:bg-g-green-dark disabled:opacity-60"
      >
        {busy ? 'Adicionando…' : label}
      </button>
      {error && (
        <p role="alert" className="mt-1 text-xs text-g-red">
          {error}
        </p>
      )}
    </>
  );
}
