'use client';

import { useEffect, useState } from 'react';
import { Guard } from '@/components/shell';
import { Button, Notice, PageHeader, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { when } from '@/lib/format';

const ACTIONS: Record<string, string> = {
  'auth.login': 'Entrou no painel',
  'auth.login_failed': 'Tentativa de acesso recusada',
  'auth.logout': 'Saiu do painel',
  'auth.password_changed': 'Trocou a senha',
  'auth.password_reset': 'Redefiniu a senha',
  'auth.mfa_enabled': 'Ativou a verificação em duas etapas',
  'users.created': 'Criou usuário',
  'users.updated': 'Alterou usuário',
  'users.owner_bootstrap': 'Primeiro proprietário criado',
  'categories.created': 'Criou categoria',
  'categories.updated': 'Alterou categoria',
  'categories.deleted': 'Excluiu categoria',
  'products.created': 'Cadastrou produto',
  'products.updated': 'Alterou produto',
  'products.image_added': 'Adicionou foto',
  'products.image_updated': 'Alterou foto',
  'products.image_removed': 'Removeu foto',
  'fiscal.product_informed': 'Informou dados fiscais do produto',
  'fiscal.product_validated': 'Validou classificação fiscal',
  'fiscal.settings_updated': 'Alterou a configuração fiscal',
  'company.updated': 'Alterou dados da empresa',
  'settings.store_updated': 'Alterou a marca da loja',
};

function Audit() {
  const [entity, setEntity] = useState('');
  const [page, setPage] = useState(1);
  const [entries, setEntries] = useState<any[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: '50' });
    if (entity) p.set('entity', entity);
    api(`/admin/audit?${p}`).then((r) => setEntries(r.entries), (e) => setError(e.message));
  }, [entity, page]);

  return (
    <>
      <PageHeader title="Auditoria" description="Registro permanente: ninguém, nem o proprietário, consegue alterar ou apagar." />
      <div className="mb-4">
        <Select aria-label="Filtrar" value={entity} onChange={(e) => { setEntity(e.target.value); setPage(1); }} className="w-auto">
          <option value="">Tudo</option>
          <option value="product">Produtos</option>
          <option value="category">Categorias</option>
          <option value="company">Empresa</option>
          <option value="fiscal_settings">Configuração fiscal</option>
          <option value="user">Usuários</option>
        </Select>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="overflow-hidden rounded-lg border border-line bg-card">
        <ul className="divide-y divide-line text-sm">
          {entries.map((e) => (
            <li key={e.id} className="px-4 py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="num text-ink-faint">{when(e.created_at)}</span>
                <span className="font-medium">{e.actor_name ?? 'Sistema'}</span>
                <span>{ACTIONS[e.action] ?? e.action}</span>
                {(e.before || e.after) && (
                  <button className="text-act hover:underline" onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? 'ocultar' : 'detalhes'}</button>
                )}
              </div>
              {open === e.id && (
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  {(['before', 'after'] as const).map((k) =>
                    e[k] ? (
                      <div key={k}>
                        <p className="text-xs font-medium text-ink-soft">{k === 'before' ? 'Antes' : 'Depois'}</p>
                        <pre className="mt-1 max-h-72 overflow-auto rounded bg-sunken p-2 text-xs">{JSON.stringify(e[k], null, 2)}</pre>
                      </div>
                    ) : null,
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-3 flex gap-2">
        <Button disabled={page === 1} onClick={() => setPage(page - 1)}>Anteriores</Button>
        <Button disabled={entries.length < 50} onClick={() => setPage(page + 1)}>Mais antigos</Button>
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="audit.view">
      <Audit />
    </Guard>
  );
}
