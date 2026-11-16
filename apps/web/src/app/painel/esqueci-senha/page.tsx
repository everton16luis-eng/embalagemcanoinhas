'use client';

import Link from '@/components/painel-link';
import { useState, type FormEvent } from 'react';
import { Button, Field, Input, Notice } from '@/components/ui';
import { api } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/auth/password/forgot', { method: 'POST', body: { email } });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível enviar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-line bg-card p-6">
        <div>
          <p className="text-xs font-semibold tracking-[0.14em] text-ink-faint uppercase">Painel da loja</p>
          <h1 className="mt-1 text-xl font-semibold">Esqueci minha senha</h1>
        </div>
        {done ? (
          // Mesma mensagem exista ou nao a conta: a tela nao revela quem tem acesso ao painel.
          <Notice tone="good">Se este e-mail tiver acesso ao painel, enviamos um link para criar uma nova senha. Ele vale por 30 minutos e só pode ser usado uma vez.</Notice>
        ) : (
          <>
            <p className="text-sm text-ink-soft">Informe o e-mail que você usa para entrar. Enviaremos um link para criar uma nova senha.</p>
            {error && <Notice tone="bad">{error}</Notice>}
            <Field label="E-mail">{(id) => <Input id={id} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
            <Button type="submit" variant="primary" busy={busy} className="w-full">
              Enviar link
            </Button>
          </>
        )}
        <p className="text-center text-sm">
          <Link href="/painel/entrar" className="text-act hover:underline">
            Voltar para entrar
          </Link>
        </p>
        <p className="text-[13px] text-ink-faint">Não chegou? Confira a caixa de spam ou peça a alguém com acesso a Usuários para gerar uma nova senha.</p>
      </form>
    </main>
  );
}
