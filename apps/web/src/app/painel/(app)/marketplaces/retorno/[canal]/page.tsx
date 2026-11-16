'use client';

import Link from '@/components/painel-link';
import { useParams, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Guard } from '@/components/shell';
import { Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';

const NAMES: Record<string, string> = { mercadolivre: 'Mercado Livre', shopee: 'Shopee' };

/** Pagina cadastrada como URL de retorno no aplicativo do marketplace: repassa code/state para a API uma vez so. */
function Return() {
  const { canal } = useParams<{ canal: string }>();
  const params = useSearchParams();
  const sent = useRef(false);
  const [result, setResult] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const code = params.get('code');
    const state = params.get('state');
    if (!NAMES[canal] || !code || !state) {
      setResult({ tone: 'bad', text: params.get('error_description') || params.get('error') || 'Retorno sem autorização. Tente conectar de novo.' });
      return;
    }
    api<{ account: { name: string } }>('/admin/marketplaces/callback', { method: 'POST', body: { channel: canal, code, state, shopId: params.get('shop_id') || undefined } }).then(
      (r) => setResult({ tone: 'good', text: `${r.account.name} conectada.` }),
      (e) => setResult({ tone: 'bad', text: e.message }),
    );
    // Tira code e state da barra de endereco (e do historico).
    window.history.replaceState(null, '', window.location.pathname);
  }, [canal, params]);

  return (
    <>
      <PageHeader title={`Conectar ${NAMES[canal] ?? 'marketplace'}`} />
      {!result && <p className="text-sm text-ink-soft">Concluindo a autorização…</p>}
      {result && <Notice tone={result.tone}>{result.text}</Notice>}
      <p className="mt-4">
        <Link href="/painel/marketplaces" className="text-sm font-medium text-act hover:underline">
          Voltar para Marketplaces
        </Link>
      </p>
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="marketplaces.manage">
      <Return />
    </Guard>
  );
}
