'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Field, Input, Notice } from '@/components/ui';
import { api } from '@/lib/api';

export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // O token vem no fragmento (#token=...): o navegador nao o envia ao servidor nem a outros sites (Referer).
  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get('token');
    setToken(t && /^[A-Za-z0-9_-]{20,100}$/.test(t) ? t : '');
    if (t) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError('As duas senhas não são iguais.');
    setBusy(true);
    setError('');
    try {
      await api('/auth/password/reset', { method: 'POST', body: { token, newPassword: password } });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível trocar a senha.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-line bg-card p-6">
        <div>
          <p className="text-xs font-semibold tracking-[0.14em] text-ink-faint uppercase">Painel da loja</p>
          <h1 className="mt-1 text-xl font-semibold">Nova senha</h1>
        </div>
        {token === null ? null : done ? (
          <Notice tone="good">Senha trocada. Entre com a senha nova; as outras sessões abertas foram encerradas.</Notice>
        ) : !token ? (
          <Notice tone="bad">Link inválido ou incompleto. Peça um novo em “Esqueci minha senha”.</Notice>
        ) : (
          <>
            {error && <Notice tone="bad">{error}</Notice>}
            <Field label="Nova senha" hint="Ao menos 10 caracteres, com letras e números.">
              {(id) => <Input id={id} type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />}
            </Field>
            <Field label="Repita a nova senha">{(id) => <Input id={id} type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
            <Button type="submit" variant="primary" busy={busy} className="w-full">
              Salvar nova senha
            </Button>
          </>
        )}
        <p className="text-center text-sm">
          <Link href={done ? '/painel/entrar' : '/painel/esqueci-senha'} className="text-act hover:underline">
            {done ? 'Entrar' : 'Pedir um novo link'}
          </Link>
        </p>
      </form>
    </main>
  );
}
