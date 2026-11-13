'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Guard, useMe } from '@/components/shell';
import { Button, Field, Input, Notice, PageHeader, Panel, Textarea } from '@/components/ui';
import { api } from '@/lib/api';

const PAGES = [
  ['about', 'Sobre a empresa'],
  ['shipping', 'Entregas e prazos'],
  ['returns', 'Trocas e devoluções'],
  ['privacy', 'Privacidade'],
  ['terms', 'Termos de uso'],
] as const;

function StoreSettings() {
  const { me } = useMe();
  const [f, setF] = useState<Record<string, string>>({});
  const [pages, setPages] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: 'bad' | 'good'; text: string } | null>(null);
  useEffect(() => {
    api('/admin/store-settings').then(({ settings: s }) => {
      setF({ storeName: s.store_name ?? '', tagline: s.tagline ?? '', domain: s.domain ?? '', whatsappNumber: s.whatsapp_number ?? '', supportEmail: s.support_email ?? '' });
      setPages(s.pages ?? {});
    }, (e) => setMsg({ tone: 'bad', text: e.message }));
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() || null]));
      await api('/admin/store-settings', { method: 'PATCH', body: { ...body, pages } });
      setMsg({ tone: 'good', text: 'Configuração gravada.' });
    } catch (err) {
      setMsg({ tone: 'bad', text: err instanceof Error ? err.message : 'Falha.' });
    }
  };
  const input = (k: string, label: string, hint?: string) => (
    <Field label={label} hint={hint}>{(id) => <Input id={id} value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}</Field>
  );

  return (
    <form onSubmit={save} className="space-y-4">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <fieldset disabled={!me.user.mfaEnabled} className="space-y-4">
        <Panel title="Identidade" description="Nome, domínio e marca ainda serão definidos. Cores e logotipo entram com a direção visual aprovada.">
          <div className="grid gap-4 sm:grid-cols-2">
            {input('storeName', 'Nome da loja')}
            {input('domain', 'Domínio', 'Sem https://, ex.: minhaloja.com.br')}
            {input('tagline', 'Frase de apresentação')}
          </div>
        </Panel>
        <Panel title="Atendimento">
          <div className="grid gap-4 sm:grid-cols-2">
            {input('supportEmail', 'E-mail de atendimento')}
            {input('whatsappNumber', 'WhatsApp', 'Com 55 e DDD, só números. Usado nos links wa.me da central comercial.')}
          </div>
        </Panel>
        <Panel title="Páginas institucionais" description="Texto revisado pela empresa. A política de trocas precisa seguir o Código de Defesa do Consumidor.">
          <div className="space-y-4">
            {PAGES.map(([k, label]) => (
              <Field key={k} label={label}>{(id) => <Textarea id={id} rows={4} value={pages[k] ?? ''} onChange={(e) => setPages({ ...pages, [k]: e.target.value })} />}</Field>
            ))}
          </div>
        </Panel>
        <Button type="submit" variant="primary">Gravar</Button>
      </fieldset>
    </form>
  );
}

export default function Page() {
  return (
    <Guard perm="settings.manage">
      <PageHeader title="Marca da loja" description="Tudo o que aparece para o cliente e pode mudar sem alterar o código." />
      <StoreSettings />
    </Guard>
  );
}
