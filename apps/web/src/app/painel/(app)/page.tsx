'use client';

import { Check, Clock, Circle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge, Notice, PageHeader, Panel } from '@/components/ui';
import { api } from '@/lib/api';

type Item = { key: string; label: string; status: 'done' | 'missing' | 'later'; owner: 'empresa' | 'contador' | 'sistema'; required: boolean; hint?: string };
type Setup = { groups: { key: string; title: string; items: Item[] }[]; summary: { required: number; done: number; later: number } };

const OWNER = { empresa: 'Empresa', contador: 'Contador', sistema: 'Sistema' };
const LINKS: Record<string, string> = { company: '/painel/empresa', accountant: '/painel/empresa', fiscal: '/painel/empresa#fiscal', store: '/painel/loja' };

function StatusIcon({ status }: { status: Item['status'] }) {
  if (status === 'done') return <Check size={16} className="text-good" aria-label="Informado" />;
  if (status === 'later') return <Clock size={16} className="text-ink-faint" aria-label="Conferido fora do sistema" />;
  return <Circle size={16} className="text-bad" aria-label="Pendente" />;
}

export default function SetupPage() {
  const [data, setData] = useState<Setup | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<Setup>('/admin/setup').then(setData, (e) => setError(e.message));
  }, []);

  return (
    <>
      <PageHeader
        title="Configuração inicial"
        description="O que a loja precisa para vender e emitir NF-e, até o lançamento. Nenhum dado é preenchido automaticamente: cada item é informado pela empresa ou pelo contador."
      />
      {error && <Notice tone="bad">{error}</Notice>}
      {data && (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-line bg-card px-5 py-4">
            <p className="num text-3xl font-semibold">
              {data.summary.done}
              <span className="text-lg text-ink-faint">/{data.summary.required}</span>
            </p>
            <p className="max-w-lg text-sm text-ink-soft">
              itens obrigatórios prontos.{' '}
              {data.summary.later > 0 && `${data.summary.later} ${data.summary.later === 1 ? 'item é conferido' : 'itens são conferidos'} fora do sistema (backup no servidor). `}
              Simulados de desenvolvimento não contam: só credenciais reais.
            </p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {data.groups.map((g) => (
              <Panel key={g.key} title={g.title} actions={LINKS[g.key] ? <Link className="text-sm font-medium text-act hover:underline" href={LINKS[g.key]!}>Abrir</Link> : undefined}>
                <ul className="-my-1 divide-y divide-line">
                  {g.items.map((i) => (
                    <li key={i.key} className="flex gap-3 py-2.5">
                      <span className="mt-0.5 shrink-0">
                        <StatusIcon status={i.status} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">
                          {i.label}
                          {!i.required && <span className="text-ink-faint"> (recomendado)</span>}
                        </p>
                        {i.hint && <p className="text-[13px] text-ink-faint">{i.hint}</p>}
                      </div>
                      <span className="shrink-0">
                        <Badge>{OWNER[i.owner]}</Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            ))}
          </div>
        </>
      )}
    </>
  );
}
