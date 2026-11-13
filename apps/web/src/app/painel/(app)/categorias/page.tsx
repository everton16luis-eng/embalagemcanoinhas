'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Empty, Field, Input, Notice, PageHeader, Panel, Select } from '@/components/ui';
import { api } from '@/lib/api';

type Category = { id: string; parent_id: string | null; name: string; slug: string; active: boolean; position: number; product_count: number };

function Categories() {
  const { can } = useMe();
  const [list, setList] = useState<Category[]>([]);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [editing, setEditing] = useState<Category | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api('/admin/categories').then((r) => setList(r.categories), (e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);

  const depthOf = (c: Category): number => (c.parent_id ? 1 + depthOf(list.find((x) => x.id === c.parent_id)!) : 0);
  const ordered = (pid: string | null): Category[] => list.filter((c) => c.parent_id === pid).flatMap((c) => [c, ...ordered(c.id)]);
  const rows = ordered(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha.');
      return false;
    }
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api('/admin/categories', { method: 'POST', body: { name, parentId: parentId || null } }))) setName('');
  };

  return (
    <>
      <PageHeader title="Categorias" description="Até três níveis: categoria, subcategoria e mais um nível. O endereço na loja é gerado do nome." />
      {error && <div className="mb-4"><Notice tone="bad">{error}</Notice></div>}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="overflow-hidden rounded-lg border border-line bg-card">
          {rows.length === 0 ? (
            <Empty title="Nenhuma categoria cadastrada." />
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-4 py-2.5" style={{ paddingLeft: `${16 + depthOf(c) * 22}px` }}>
                  {editing?.id === c.id ? (
                    <form
                      className="flex flex-1 flex-wrap gap-2"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (await run(() => api(`/admin/categories/${c.id}`, { method: 'PATCH', body: { name: editing.name, active: editing.active } }))) setEditing(null);
                      }}
                    >
                      <Input aria-label="Nome" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className="max-w-xs" />
                      <label className="flex items-center gap-1.5 text-sm">
                        <input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Ativa
                      </label>
                      <Button type="submit" variant="primary">Salvar</Button>
                      <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancelar</Button>
                    </form>
                  ) : (
                    <>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{c.name}</p>
                        <p className="text-xs text-ink-faint">/{c.slug} · {c.product_count} produto(s)</p>
                      </div>
                      {!c.active && <Badge>Inativa</Badge>}
                      {can('catalog.manage') && (
                        <>
                          <Button variant="ghost" onClick={() => setEditing(c)}>Editar</Button>
                          {c.product_count === 0 && !list.some((x) => x.parent_id === c.id) && (
                            <Button variant="ghost" className="text-bad" onClick={() => void run(() => api(`/admin/categories/${c.id}`, { method: 'DELETE' }))}>Excluir</Button>
                          )}
                        </>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        {can('catalog.manage') && (
          <Panel title="Nova categoria">
            <form onSubmit={create} className="space-y-3">
              <Field label="Nome" required>{(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} placeholder="Embalagens para bolo" />}</Field>
              <Field label="Dentro de">
                {(id) => (
                  <Select id={id} value={parentId} onChange={(e) => setParentId(e.target.value)}>
                    <option value="">Nível principal</option>
                    {rows.filter((c) => depthOf(c) < 2).map((c) => (
                      <option key={c.id} value={c.id}>{`${'— '.repeat(depthOf(c))}${c.name}`}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <Button type="submit" variant="primary" className="w-full">Adicionar</Button>
            </form>
          </Panel>
        )}
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="catalog.view">
      <Categories />
    </Guard>
  );
}
