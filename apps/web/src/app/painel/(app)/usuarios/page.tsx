'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Field, Input, Notice, PageHeader, Panel, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { PERMISSION_LABELS, ROLE_LABELS, when } from '@/lib/format';

type User = { id: string; email: string; name: string; role: string; is_active: boolean; totp_enabled: boolean; last_login_at: string | null };

function Permissions({ id, onDone }: { id: string; onDone: () => void }) {
  const [data, setData] = useState<{ user: User; effective: string[]; defaults: string[] } | null>(null);
  const [all, setAll] = useState<string[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  useEffect(() => {
    api(`/admin/users/${id}`).then((r) => {
      setData(r);
      setSel(new Set(r.effective));
    });
    api('/admin/users').then((r) => setAll(r.permissions));
  }, [id]);
  if (!data) return null;
  const save = async () => {
    try {
      await api(`/admin/users/${id}`, { method: 'PATCH', body: { overrides: Object.fromEntries(all.map((p) => [p, sel.has(p)])) } });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha.');
    }
  };
  return (
    <Panel title={`Permissões de ${data.user.name}`} description={`Padrão do papel ${ROLE_LABELS[data.user.role]}; marcações diferentes do padrão ficam como exceção individual.`}>
      {error && <div className="mb-3"><Notice tone="bad">{error}</Notice></div>}
      <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {all.map((p) => (
          <label key={p} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={sel.has(p)} onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(p); else n.delete(p); return n; })} />
            <span>{PERMISSION_LABELS[p] ?? p}</span>
            {data.defaults.includes(p) !== sel.has(p) && <Badge tone="warn">exceção</Badge>}
          </label>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <Button variant="primary" onClick={save}>Gravar permissões</Button>
        <Button variant="ghost" onClick={onDone}>Cancelar</Button>
      </div>
    </Panel>
  );
}

function Users() {
  const { can, me } = useMe();
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [form, setForm] = useState({ email: '', name: '', role: 'sales' });
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const manage = can('users.manage') && me.user.mfaEnabled;
  const load = useCallback(() => api('/admin/users').then((r) => { setUsers(r.users); setRoles(r.roles); }, (e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api('/admin/users', { method: 'POST', body: form });
      setCreated({ email: r.user.email, password: r.temporaryPassword });
      setForm({ email: '', name: '', role: 'sales' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha.');
    }
  };
  const patch = async (id: string, body: object) => {
    setError('');
    try {
      await api(`/admin/users/${id}`, { method: 'PATCH', body });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha.');
    }
  };

  return (
    <>
      <PageHeader title="Usuários" description="Cada pessoa tem o próprio acesso. O papel define as permissões padrão." />
      {error && <div className="mb-4"><Notice tone="bad">{error}</Notice></div>}
      {created && (
        <div className="mb-4">
          <Notice tone="act">
            Acesso criado para <strong>{created.email}</strong>. Senha inicial: <code className="rounded bg-card px-1.5 py-0.5 font-mono">{created.password}</code>. Ela aparece só agora: entregue à pessoa por um canal seguro e peça para trocar no primeiro acesso.
          </Notice>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <div className="overflow-x-auto rounded-lg border border-line bg-card">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-sunken/60 text-left text-xs text-ink-soft">
                <tr><th className="py-2 pl-4 font-medium">Pessoa</th><th className="py-2 font-medium">Papel</th><th className="hidden py-2 font-medium md:table-cell">Último acesso</th><th className="py-2 pr-4" /></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {users.map((u) => (
                  <tr key={u.id} className={u.is_active ? '' : 'text-ink-faint'}>
                    <td className="py-2.5 pl-4">
                      <p className="font-medium">{u.name}</p>
                      <p className="text-xs text-ink-faint">{u.email}</p>
                      <span className="mt-1 flex gap-1">{!u.is_active && <Badge>Desativado</Badge>}{u.totp_enabled ? <Badge tone="good">2 etapas</Badge> : <Badge tone="warn">Sem 2 etapas</Badge>}</span>
                    </td>
                    <td className="py-2.5">
                      {manage && u.id !== me.user.id ? (
                        <Select aria-label="Papel" value={u.role} onChange={(e) => void patch(u.id, { role: e.target.value })} className="w-auto">
                          {roles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                        </Select>
                      ) : ROLE_LABELS[u.role]}
                    </td>
                    <td className="num hidden py-2.5 text-ink-soft md:table-cell">{when(u.last_login_at)}</td>
                    <td className="py-2.5 pr-4 text-right whitespace-nowrap">
                      {manage && u.id !== me.user.id && (
                        <>
                          {u.role !== 'owner' && <Button variant="ghost" onClick={() => setEditing(u.id)}>Permissões</Button>}
                          <Button variant="ghost" onClick={() => void patch(u.id, { isActive: !u.is_active })}>{u.is_active ? 'Desativar' : 'Reativar'}</Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {editing && <Permissions id={editing} onDone={() => { setEditing(null); void load(); }} />}
        </div>
        {manage && (
          <Panel title="Novo usuário">
            <form onSubmit={create} className="space-y-3">
              <Field label="Nome" required>{(id) => <Input id={id} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
              <Field label="E-mail" required>{(id) => <Input id={id} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
              <Field label="Papel">
                {(id) => (
                  <Select id={id} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                    {roles.filter((r) => r !== 'owner' || me.user.role === 'owner').map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </Select>
                )}
              </Field>
              <Button type="submit" variant="primary" className="w-full">Criar acesso</Button>
            </form>
          </Panel>
        )}
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="users.view">
      <Users />
    </Guard>
  );
}
