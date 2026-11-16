'use client';

import Link from '@/components/painel-link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Button, Field, Input, Notice } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

function LoginForm() {
  const router = useRouter();
  const back = useSearchParams().get('voltar');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/auth/login', { method: 'POST', body: { email, password, ...(needsCode ? { totp } : {}) } });
      // So volta para dentro do painel: nunca para um endereco externo.
      router.replace(back?.startsWith('/painel') ? back : '/painel');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MFA_CODE_REQUIRED') setNeedsCode(true);
      else setError(err instanceof Error ? err.message : 'Não foi possível entrar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-line bg-card p-6">
      <div>
        <p className="text-xs font-semibold tracking-[0.14em] text-ink-faint uppercase">Painel da loja</p>
        <h1 className="mt-1 text-xl font-semibold">Entrar</h1>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      <Field label="E-mail">{(id) => <Input id={id} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
      <Field label="Senha">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
      {needsCode && (
        <Field label="Código de verificação" hint="Os 6 dígitos do aplicativo autenticador.">
          {(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} />}
        </Field>
      )}
      <Button type="submit" variant="primary" busy={busy} className="w-full">
        Entrar
      </Button>
      <p className="text-center text-sm">
        <Link href="/painel/esqueci-senha" className="text-act hover:underline">
          Esqueci minha senha
        </Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
