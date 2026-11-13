'use client';

import QRCode from 'qrcode';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useMe } from '@/components/shell';
import { Badge, Button, Field, Input, Notice, PageHeader, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { ROLE_LABELS, when } from '@/lib/format';

function Mfa() {
  const { me, reload } = useMe();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<{ tone: 'bad' | 'good'; text: string } | null>(null);

  const start = async () => {
    try {
      const r = await api('/auth/mfa/setup', { method: 'POST', body: {} });
      setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.uri, { margin: 1, width: 200 }) });
    } catch (e) {
      setMsg({ tone: 'bad', text: e instanceof Error ? e.message : 'Falha.' });
    }
  };
  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/auth/mfa/confirm', { method: 'POST', body: { code } });
      setSetup(null);
      setMsg({ tone: 'good', text: 'Verificação em duas etapas ativada.' });
      await reload();
    } catch (err) {
      setMsg({ tone: 'bad', text: err instanceof Error ? err.message : 'Falha.' });
    }
  };

  return (
    <Panel title="Verificação em duas etapas" actions={me.user.mfaEnabled ? <Badge tone="good">Ativa</Badge> : <Badge tone="warn">Inativa</Badge>}>
      {msg && <div className="mb-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      {me.user.mfaEnabled ? (
        <p className="text-sm text-ink-soft">Ao entrar, o painel pede o código do aplicativo autenticador.</p>
      ) : setup ? (
        <form onSubmit={confirm} className="flex flex-wrap items-start gap-5">
          <img src={setup.qr} alt="QR Code para o aplicativo autenticador" className="size-44 rounded border border-line" />
          <div className="max-w-sm space-y-3">
            <p className="text-sm">Leia o QR Code com um aplicativo autenticador (Google Authenticator, Microsoft Authenticator, 1Password…). Sem câmera, digite a chave:</p>
            <code className="block rounded bg-sunken px-2 py-1 font-mono text-xs break-all">{setup.secret}</code>
            <Field label="Código de 6 dígitos">{(id) => <Input id={id} inputMode="numeric" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />}</Field>
            <Button type="submit" variant="primary">Confirmar</Button>
          </div>
        </form>
      ) : (
        <>
          <p className="mb-3 text-sm text-ink-soft">Obrigatória para alterar dados da empresa, fiscal, preços, usuários e configurações.</p>
          <Button variant="primary" onClick={start}>Ativar</Button>
        </>
      )}
    </Panel>
  );
}

function Password() {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ tone: 'bad' | 'good'; text: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/auth/password/change', { method: 'POST', body: { currentPassword: cur, newPassword: next } });
      setCur('');
      setNext('');
      setMsg({ tone: 'good', text: 'Senha alterada. As outras sessões foram encerradas.' });
    } catch (err) {
      setMsg({ tone: 'bad', text: err instanceof Error ? err.message : 'Falha.' });
    }
  };
  return (
    <Panel title="Senha">
      <form onSubmit={submit} className="grid max-w-xl gap-3 sm:grid-cols-2">
        {msg && <div className="sm:col-span-2"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
        <Field label="Senha atual">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} />}</Field>
        <Field label="Nova senha" hint="Ao menos 10 caracteres, com letras e números.">{(id) => <Input id={id} type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
        <div><Button type="submit">Alterar senha</Button></div>
      </form>
    </Panel>
  );
}

function Sessions() {
  const [list, setList] = useState<any[]>([]);
  const load = useCallback(() => api('/auth/sessions').then((r) => setList(r.sessions)), []);
  useEffect(() => void load(), [load]);
  return (
    <Panel title="Sessões abertas">
      <ul className="divide-y divide-line text-sm">
        {list.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
            <span className="min-w-0 flex-1 truncate text-ink-soft" title={s.user_agent}>{s.user_agent ?? 'Navegador desconhecido'}</span>
            <span className="num text-ink-faint">{when(s.last_seen_at)}</span>
            {s.current ? <Badge tone="act">Esta sessão</Badge> : <Button variant="ghost" onClick={() => api(`/auth/sessions/${s.id}`, { method: 'DELETE' }).then(load)}>Encerrar</Button>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export default function AccountPage() {
  const { me } = useMe();
  return (
    <>
      <PageHeader title="Minha conta" description={`${me.user.name} · ${me.user.email} · ${ROLE_LABELS[me.user.role]}`} />
      <div className="space-y-4">
        <Mfa />
        <Password />
        <Sessions />
      </div>
    </>
  );
}
