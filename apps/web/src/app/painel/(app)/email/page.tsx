'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Empty, Field, Input, Notice, PageHeader, Panel, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { when } from '@/lib/format';

type Tpl = { kind: string; label: string; description: string; variables: Record<string, string>; required: string[]; subject: string; body: string; default: { subject: string; body: string }; customized: boolean };
type Overview = {
  smtp: { configured: boolean; host: string | null; port: number; security: string; user: string | null; passwordSet: boolean; from: string | null };
  settings: { senderName: string; replyTo: string };
  templates: Tpl[];
  accountsIntegrated: boolean;
};
type Account = { address: string; login: boolean; receives: boolean; suspended: boolean; usageBytes: number; sender: boolean; name: string; note: string; createdAt: string | null };
type Alias = { address: string; targets: string[] };
type Client = { server: string | null; imap: { port: number; security: string }; smtp: { port: number; security: string }; pop?: { port: number; security: string } | null; webmail: string | null };
type Accounts = { integrated: boolean; error?: string; domain?: string; domainServed?: boolean; accounts?: Account[]; aliases?: Alias[]; client: Client };
type Send = { id: number; created_at: string; kind: string; to_domain: string; subject: string; status: string; error_code: string | null; error_detail: string | null };

const SEND_STATUS: Record<string, { label: string; tone: 'good' | 'bad' | 'warn' }> = {
  sent: { label: 'Enviado', tone: 'good' },
  failed: { label: 'Falhou', tone: 'bad' },
  not_configured: { label: 'Sem SMTP', tone: 'warn' },
};
const KIND_LABEL: Record<string, string> = { password_reset: 'Redefinição de senha', test: 'Teste' };

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2).replace('.', ',')} GB`;
}

/** Senha forte gerada no navegador (nao passa por servidor nenhum ate ser salva). */
function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const base = Array.from(bytes, (b) => chars[b % chars.length]).join('');
  return `${base.slice(0, 4)}-${base.slice(4, 8)}-${base.slice(8, 12)}-${base.slice(12, 15)}7`;
}

/** Campo de senha com "gerar" e "mostrar": quem cria a caixa precisa ver a senha para entregar a pessoa. */
function PasswordInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex gap-2">
      <Input id={id} type={show ? 'text' : 'password'} autoComplete="new-password" required minLength={10} value={value} onChange={(e) => onChange(e.target.value)} className="font-mono" />
      <Button type="button" onClick={() => setShow(!show)}>
        {show ? 'Ocultar' : 'Mostrar'}
      </Button>
      <Button
        type="button"
        onClick={() => {
          onChange(generatePassword());
          setShow(true);
        }}
      >
        Gerar
      </Button>
    </div>
  );
}

// ---------------- Caixas ----------------

function AccountsTab() {
  const { can, me } = useMe();
  const edit = can('email.accounts') && me.user.mfaEnabled;
  const [data, setData] = useState<Accounts | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState({ local: '', name: '', note: '', password: '' });
  const [pwFor, setPwFor] = useState<string | null>(null);
  const [newPw, setNewPw] = useState('');
  const [editFor, setEditFor] = useState<Account | null>(null);
  const [aliasForm, setAliasForm] = useState<{ address: string; targets: string; editing: boolean } | null>(null);

  const load = useCallback(() => {
    api<Accounts>('/admin/email/accounts').then(setData, (e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function run(key: string, fn: () => Promise<{ message?: string } | void>) {
    setBusy(key);
    setError('');
    setMessage('');
    try {
      const r = await fn();
      if (r && r.message) setMessage(r.message);
      load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy('');
    }
  }
  const enc = (a: string) => encodeURIComponent(a);

  if (!data) return error ? <Notice tone="bad">{error}</Notice> : <p className="text-sm text-ink-faint">Carregando…</p>;

  if (!data.integrated) {
    return (
      <Panel title="Caixas de e-mail" description="A integração com o servidor de e-mail está desligada neste ambiente.">
        <p className="text-sm text-ink-soft">
          Com ela ligada (EMAIL_ACCOUNTS_SOCKET no .env do servidor), esta tela cria caixas, troca senhas, suspende, exclui e cria apelidos do domínio da loja. O passo a passo está em
          docs/EMAIL.md. Até lá, as caixas são criadas à mão no servidor.
        </p>
      </Panel>
    );
  }

  const domain = data.domain ?? '';
  const createAccount = (e: FormEvent) => {
    e.preventDefault();
    void run('create', async () => {
      const r = await api<{ message: string }>('/admin/email/accounts', { method: 'POST', body: { address: `${form.local.trim().toLowerCase()}@${domain}`, name: form.name.trim(), note: form.note.trim(), password: form.password } });
      setForm({ local: '', name: '', note: '', password: '' });
      return r;
    });
  };

  return (
    <div className="space-y-4">
      {error && <Notice tone="bad">{error}</Notice>}
      {message && <Notice tone="good">{message}</Notice>}
      {data.error && <Notice tone="bad">Não foi possível ler as caixas: {data.error}</Notice>}
      {data.domainServed === false && (
        <Notice tone="warn">
          O domínio {domain} ainda não foi incluído no servidor de e-mail (virtual_domains). Siga o passo 1 de docs/EMAIL.md antes de criar caixas.
        </Notice>
      )}

      <Panel title={`Caixas @${domain}`} description="Só os endereços da loja aparecem aqui. Os outros sites do servidor não são vistos nem alterados por esta tela.">
        {data.accounts?.length ? (
          <ul className="divide-y divide-line">
            {data.accounts.map((a) => (
              <li key={a.address} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium break-all">{a.address}</p>
                    <p className="text-[13px] text-ink-faint">
                      {[a.name, a.note].filter(Boolean).join(' · ') || 'Sem nome de exibição'} · {size(a.usageBytes)} em mensagens
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {a.sender && <Badge tone="act">Usada pela loja para enviar</Badge>}
                      {a.suspended && <Badge tone="warn">Suspensa</Badge>}
                      {!a.login && <Badge>Sem login</Badge>}
                      {!a.receives && <Badge>Não recebe</Badge>}
                    </div>
                  </div>
                  {edit && (
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={() => setEditFor(a)}>Nome</Button>
                      {a.login && (
                        <Button
                          onClick={() => {
                            setPwFor(a.address);
                            setNewPw('');
                          }}
                        >
                          Trocar senha
                        </Button>
                      )}
                      {a.login && !a.sender && (
                        <Button busy={busy === `s${a.address}`} onClick={() => run(`s${a.address}`, () => api(`/admin/email/accounts/${enc(a.address)}/${a.suspended ? 'reactivate' : 'suspend'}`, { method: 'POST' }))}>
                          {a.suspended ? 'Reativar' : 'Suspender'}
                        </Button>
                      )}
                      {!a.sender && (
                        <Button
                          variant="danger"
                          busy={busy === `d${a.address}`}
                          onClick={() => {
                            if (window.confirm(`Excluir a caixa ${a.address}? Ela deixa de receber e-mails. As mensagens ficam guardadas no servidor (não são apagadas).`))
                              void run(`d${a.address}`, () => api(`/admin/email/accounts/${enc(a.address)}`, { method: 'DELETE' }));
                          }}
                        >
                          Excluir
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                {pwFor === a.address && (
                  <form
                    className="mt-3 grid gap-2 rounded-md bg-sunken p-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run('pw', () => api(`/admin/email/accounts/${enc(a.address)}/password`, { method: 'POST', body: { password: newPw } })).then((ok) => ok && setPwFor(null));
                    }}
                  >
                    <Field label={`Nova senha de ${a.address}`} hint="Ao menos 10 caracteres, com letras e números. Anote antes de salvar: o painel não a guarda.">
                      {(id) => <PasswordInput id={id} value={newPw} onChange={setNewPw} />}
                    </Field>
                    <div className="flex gap-2">
                      <Button variant="primary" type="submit" busy={busy === 'pw'}>
                        Salvar senha
                      </Button>
                      <Button type="button" onClick={() => setPwFor(null)}>
                        Cancelar
                      </Button>
                    </div>
                  </form>
                )}
                {editFor?.address === a.address && (
                  <form
                    className="mt-3 grid gap-2 rounded-md bg-sunken p-3 sm:grid-cols-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run('ed', () => api(`/admin/email/accounts/${enc(a.address)}`, { method: 'PUT', body: { name: editFor.name.trim(), note: editFor.note.trim() } })).then((ok) => ok && setEditFor(null));
                    }}
                  >
                    <Field label="Nome de exibição">{(id) => <Input id={id} maxLength={80} value={editFor.name} onChange={(e) => setEditFor({ ...editFor, name: e.target.value })} />}</Field>
                    <Field label="Observação">{(id) => <Input id={id} maxLength={200} value={editFor.note} onChange={(e) => setEditFor({ ...editFor, note: e.target.value })} />}</Field>
                    <div className="flex gap-2 sm:col-span-2">
                      <Button variant="primary" type="submit" busy={busy === 'ed'}>
                        Salvar
                      </Button>
                      <Button type="button" onClick={() => setEditFor(null)}>
                        Cancelar
                      </Button>
                    </div>
                  </form>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="Nenhuma caixa ainda" />
        )}
      </Panel>

      {edit && data.domainServed && (
        <Panel title="Nova caixa" description="A senha vira código no servidor de e-mail. Entregue-a à pessoa por um canal seguro: o painel não a guarda nem mostra de novo.">
          <form onSubmit={createAccount} className="grid gap-3 sm:grid-cols-2">
            <Field label="Endereço" required>
              {(id) => (
                <div className="flex items-center gap-1.5">
                  <Input id={id} required maxLength={64} pattern="[a-zA-Z0-9]([a-zA-Z0-9._\-]*[a-zA-Z0-9])?" value={form.local} onChange={(e) => setForm({ ...form, local: e.target.value })} placeholder="vendas" />
                  <span className="text-sm whitespace-nowrap text-ink-soft">@{domain}</span>
                </div>
              )}
            </Field>
            <Field label="Nome de exibição">{(id) => <Input id={id} maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Vendas" />}</Field>
            <Field label="Senha" required hint="Ao menos 10 caracteres, com letras e números." className="sm:col-span-2">
              {(id) => <PasswordInput id={id} value={form.password} onChange={(v) => setForm({ ...form, password: v })} />}
            </Field>
            <Field label="Observação" className="sm:col-span-2">
              {(id) => <Input id={id} maxLength={200} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Quem usa e para quê" />}
            </Field>
            <div className="sm:col-span-2">
              <Button variant="primary" type="submit" busy={busy === 'create'}>
                Criar caixa
              </Button>
            </div>
          </form>
        </Panel>
      )}

      <Panel
        title="Apelidos"
        description="Um apelido entrega o e-mail em outra caixa (ou fora, como um Gmail), sem senha própria. Ex.: contato@ entregando em vendas@."
        actions={edit && data.domainServed && !aliasForm ? <Button onClick={() => setAliasForm({ address: '', targets: '', editing: false })}>Novo apelido</Button> : undefined}
      >
        {aliasForm && (
          <form
            className="mb-3 grid gap-3 rounded-md bg-sunken p-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              const targets = aliasForm.targets;
              void run('al', () =>
                aliasForm.editing
                  ? api(`/admin/email/aliases/${enc(aliasForm.address)}`, { method: 'PUT', body: { targets } })
                  : api('/admin/email/aliases', { method: 'POST', body: { address: `${aliasForm.address.trim().toLowerCase()}@${domain}`, targets } }),
              ).then((ok) => ok && setAliasForm(null));
            }}
          >
            <Field label="Apelido" required>
              {(id) =>
                aliasForm.editing ? (
                  <Input id={id} value={aliasForm.address} disabled />
                ) : (
                  <div className="flex items-center gap-1.5">
                    <Input id={id} required maxLength={64} value={aliasForm.address} onChange={(e) => setAliasForm({ ...aliasForm, address: e.target.value })} placeholder="contato" />
                    <span className="text-sm whitespace-nowrap text-ink-soft">@{domain}</span>
                  </div>
                )
              }
            </Field>
            <Field label="Entregar em" required hint="Um ou mais endereços, separados por vírgula (até 10).">
              {(id) => <Input id={id} required value={aliasForm.targets} onChange={(e) => setAliasForm({ ...aliasForm, targets: e.target.value })} placeholder={`vendas@${domain}`} />}
            </Field>
            <div className="flex gap-2 sm:col-span-2">
              <Button variant="primary" type="submit" busy={busy === 'al'}>
                Salvar apelido
              </Button>
              <Button type="button" onClick={() => setAliasForm(null)}>
                Cancelar
              </Button>
            </div>
          </form>
        )}
        {data.aliases?.length ? (
          <ul className="divide-y divide-line">
            {data.aliases.map((a) => (
              <li key={a.address} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <p className="min-w-0 text-sm break-all">
                  <span className="font-medium">{a.address}</span> <span className="text-ink-faint">→</span> {a.targets.join(', ')}
                </p>
                {edit && (
                  <div className="flex gap-2">
                    <Button onClick={() => setAliasForm({ address: a.address, targets: a.targets.join(', '), editing: true })}>Alterar</Button>
                    <Button
                      variant="danger"
                      busy={busy === `a${a.address}`}
                      onClick={() => {
                        if (window.confirm(`Excluir o apelido ${a.address}? Mensagens para ele passam a ser recusadas.`)) void run(`a${a.address}`, () => api(`/admin/email/aliases/${enc(a.address)}`, { method: 'DELETE' }));
                      }}
                    >
                      Excluir
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          !aliasForm && <p className="text-sm text-ink-faint">Nenhum apelido.</p>
        )}
      </Panel>

      <Panel title="Configurar num programa de e-mail" description="Celular, Outlook, Thunderbird: o usuário é o endereço completo e a senha é a da caixa.">
        <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-ink-faint">Servidor</dt>
          <dd className="font-mono">{data.client.server ?? 'definido no .env (SMTP_HOST)'}</dd>
          <dt className="text-ink-faint">Recebimento (IMAP)</dt>
          <dd>
            porta {data.client.imap.port}, {data.client.imap.security}
          </dd>
          <dt className="text-ink-faint">Envio (SMTP)</dt>
          <dd>
            porta {data.client.smtp.port}, {data.client.smtp.security}, com a mesma senha
          </dd>
          {data.client.pop === null && (
            <>
              <dt className="text-ink-faint">POP3</dt>
              <dd>não disponível neste servidor (use IMAP)</dd>
            </>
          )}
          {data.client.webmail && (
            <>
              <dt className="text-ink-faint">Webmail</dt>
              <dd>
                <a href={data.client.webmail} className="text-act hover:underline" target="_blank" rel="noreferrer">
                  {data.client.webmail}
                </a>
              </dd>
            </>
          )}
        </dl>
      </Panel>
      {!edit && can('email.accounts') && <p className="text-[13px] text-ink-faint">Para alterar as caixas, ative a verificação em duas etapas na sua conta.</p>}
    </div>
  );
}

// ---------------- Envio e modelos ----------------

function SendingTab({ data, reload }: { data: Overview; reload: () => void }) {
  const { can, me } = useMe();
  const edit = can('email.manage') && me.user.mfaEnabled;
  const [settings, setSettings] = useState(data.settings);
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState<{ kind: string; subject: string; body: string } | null>(null);
  const [preview, setPreview] = useState<{ subject: string; text: string } | null>(null);

  async function act(key: string, fn: () => Promise<{ ok?: boolean; message?: string } | void>, okText?: string) {
    setBusy(key);
    setNotice(null);
    try {
      const r = await fn();
      if (r && r.ok === false) setNotice({ tone: 'bad', text: r.message ?? 'Não deu certo.' });
      else setNotice({ tone: 'good', text: (r && r.message) || okText || 'Salvo.' });
      return true;
    } catch (e) {
      setNotice({ tone: 'bad', text: (e as Error).message });
      return false;
    } finally {
      setBusy('');
    }
  }

  const s = data.smtp;
  return (
    <div className="space-y-4">
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      <Panel
        title="Servidor de envio"
        description="Servidor, usuário, senha e endereço do remetente ficam só no .env do servidor: a senha nunca vem ao navegador."
        actions={
          edit && s.configured ? (
            <div className="flex flex-wrap gap-2">
              <Button busy={busy === 'verify'} onClick={() => act('verify', () => api('/admin/email/verify', { method: 'POST' }))}>
                Testar conexão
              </Button>
              <Button busy={busy === 'test'} onClick={() => act('test', () => api('/admin/email/test', { method: 'POST' }))}>
                Enviar e-mail de teste
              </Button>
            </div>
          ) : undefined
        }
      >
        <div className="mb-3">{s.configured ? <Badge tone="good">Envio configurado</Badge> : <Badge tone="warn">Envio desligado</Badge>}</div>
        {!s.configured && <p className="mb-3 text-sm text-ink-soft">Sem SMTP_HOST e MAIL_FROM no .env, nenhum e-mail sai: a recuperação de senha fica indisponível. Veja docs/EMAIL.md.</p>}
        <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-ink-faint">Servidor</dt>
          <dd className="font-mono break-all">{s.host ? `${s.host}:${s.port}` : '—'}</dd>
          <dt className="text-ink-faint">Segurança</dt>
          <dd>{s.security}</dd>
          <dt className="text-ink-faint">Usuário</dt>
          <dd className="break-all">{s.user ?? '—'}</dd>
          <dt className="text-ink-faint">Senha</dt>
          <dd>{s.passwordSet ? 'definida' : 'não definida'}</dd>
          <dt className="text-ink-faint">Remetente</dt>
          <dd className="break-all">{s.from ?? '—'}</dd>
        </dl>
        {edit && s.configured && <p className="mt-3 text-[13px] text-ink-faint">O e-mail de teste vai só para {me.user.email}. No máximo 5 por hora.</p>}
      </Panel>

      <Panel title="Remetente e respostas">
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act('settings', () => api('/admin/email/settings', { method: 'PUT', body: { senderName: settings.senderName.trim(), replyTo: settings.replyTo.trim() } }), 'Remetente salvo.').then((ok) => ok && reload());
          }}
        >
          <Field label="Nome do remetente" hint="O que aparece como “De:”. O endereço continua o do .env, porque o servidor só aceita a caixa do login.">
            {(id) => <Input id={id} maxLength={80} disabled={!edit} value={settings.senderName} onChange={(e) => setSettings({ ...settings, senderName: e.target.value })} placeholder="Nome da loja" />}
          </Field>
          <Field label="Responder para" hint="Quem recebe quando a pessoa clica em Responder. Vazio = o próprio remetente.">
            {(id) => <Input id={id} type="email" maxLength={254} disabled={!edit} value={settings.replyTo} onChange={(e) => setSettings({ ...settings, replyTo: e.target.value })} placeholder="contato@" />}
          </Field>
          {edit && (
            <div className="sm:col-span-2">
              <Button variant="primary" type="submit" busy={busy === 'settings'}>
                Salvar
              </Button>
            </div>
          )}
        </form>
      </Panel>

      <Panel title="Textos dos e-mails automáticos" description="Só os e-mails que a loja realmente envia. Os e-mails são de texto simples; uma linha cujas variáveis ficaram vazias some.">
        <ul className="divide-y divide-line">
          {data.templates.map((t) => (
            <li key={t.kind} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium">
                    {t.label} {t.customized && <Badge tone="act">Personalizado</Badge>}
                  </p>
                  <p className="text-[13px] text-ink-faint">{t.description}</p>
                </div>
                {edit && editing?.kind !== t.kind && (
                  <Button
                    onClick={() => {
                      setPreview(null);
                      setEditing({ kind: t.kind, subject: t.subject, body: t.body });
                    }}
                  >
                    Editar texto
                  </Button>
                )}
              </div>
              {editing?.kind === t.kind ? (
                <form
                  className="mt-3 grid gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act('tpl', () => api(`/admin/email/templates/${t.kind}`, { method: 'PUT', body: { subject: editing.subject, body: editing.body } }), 'Texto salvo.').then((ok) => {
                      if (ok) {
                        setEditing(null);
                        reload();
                      }
                    });
                  }}
                >
                  <Field label="Assunto" required>
                    {(id) => <Input id={id} required maxLength={200} value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} />}
                  </Field>
                  <Field label="Texto" required>
                    {(id) => <Textarea id={id} required rows={8} maxLength={5000} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} className="font-mono text-sm" />}
                  </Field>
                  <div className="text-[13px] text-ink-soft">
                    Variáveis:{' '}
                    {Object.entries(t.variables).map(([v, label], i) => (
                      <span key={v}>
                        {i > 0 && ', '}
                        <code className="font-mono">{`{{${v}}}`}</code> {label.toLowerCase()}
                      </span>
                    ))}
                  </div>
                  {preview && (
                    <div className="rounded-md border border-line bg-sunken p-3 text-sm">
                      <p className="text-[13px] text-ink-faint">Prévia com dados de exemplo</p>
                      <p className="mt-1 font-medium">{preview.subject}</p>
                      <pre className="mt-2 font-sans whitespace-pre-wrap">{preview.text}</pre>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" type="submit" busy={busy === 'tpl'}>
                      Salvar texto
                    </Button>
                    <Button
                      type="button"
                      busy={busy === 'prev'}
                      onClick={() => {
                        setBusy('prev');
                        setNotice(null);
                        api(`/admin/email/templates/${t.kind}/preview`, { method: 'POST', body: { subject: editing.subject, body: editing.body } })
                          .then(setPreview, (e) => setNotice({ tone: 'bad', text: e.message }))
                          .finally(() => setBusy(''));
                      }}
                    >
                      Prévia
                    </Button>
                    <Button type="button" onClick={() => setEditing({ ...editing, subject: t.default.subject, body: t.default.body })}>
                      Voltar ao texto padrão
                    </Button>
                    {t.customized && (
                      <Button
                        type="button"
                        variant="danger"
                        busy={busy === 'restore'}
                        onClick={() =>
                          void act('restore', () => api(`/admin/email/templates/${t.kind}`, { method: 'DELETE' }), 'Texto padrão restaurado.').then((ok) => {
                            if (ok) {
                              setEditing(null);
                              reload();
                            }
                          })
                        }
                      >
                        Apagar personalização
                      </Button>
                    )}
                    <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                      Cancelar
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="mt-2 rounded-md bg-sunken p-3 text-sm">
                  <p className="font-medium">{t.subject}</p>
                  <pre className="mt-1 font-sans whitespace-pre-wrap text-ink-soft">{t.body}</pre>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Panel>
      {!edit && can('email.manage') && <p className="text-[13px] text-ink-faint">Para alterar o envio e os textos, ative a verificação em duas etapas na sua conta.</p>}
    </div>
  );
}

// ---------------- Historico ----------------

function HistoryTab() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Send[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const p = new URLSearchParams({ page: String(page) });
    if (status) p.set('status', status);
    api<{ sends: Send[] }>(`/admin/email/sends?${p}`).then((r) => setRows(r.sends), (e) => setError(e.message));
  }, [status, page]);

  return (
    <Panel title="Histórico de envios" description="Guarda só o domínio do destinatário, o assunto e o resultado. Nunca o texto, links ou senhas.">
      <div className="mb-3">
        <Select aria-label="Filtrar por situação" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))} className="w-auto">
          <option value="">Todos</option>
          <option value="sent">Enviados</option>
          <option value="failed">Com falha</option>
          <option value="not_configured">Sem SMTP</option>
        </Select>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {rows && !rows.length && <Empty title="Nenhum envio" />}
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-line text-sm">
          {rows.map((r) => (
            <li key={r.id} className="py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="num text-ink-faint">{when(r.created_at)}</span>
                <Badge tone={SEND_STATUS[r.status]?.tone}>{SEND_STATUS[r.status]?.label ?? r.status}</Badge>
                <span>{KIND_LABEL[r.kind] ?? r.kind}</span>
                <span className="text-ink-faint">{r.to_domain}</span>
              </div>
              <p className="mt-0.5 text-ink-soft">{r.subject}</p>
              {r.error_detail && (
                <p className="mt-0.5 text-[13px] text-bad">
                  {r.error_code && <span className="font-mono">{r.error_code} </span>}
                  {r.error_detail}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex gap-2">
        <Button disabled={page === 1} onClick={() => setPage(page - 1)}>
          Mais recentes
        </Button>
        <Button disabled={!rows || rows.length < 30} onClick={() => setPage(page + 1)}>
          Mais antigos
        </Button>
      </div>
    </Panel>
  );
}

const TABS = [
  { id: 'caixas', label: 'Caixas de e-mail' },
  { id: 'envio', label: 'Envio e textos' },
  { id: 'historico', label: 'Histórico' },
] as const;

function EmailPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('caixas');
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<Overview>('/admin/email').then(setData, (e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  return (
    <>
      <PageHeader title="E-mails" description="Caixas do domínio da loja, envio dos e-mails automáticos e o que já foi enviado." />
      <div role="tablist" aria-label="Seções" className="mb-4 flex flex-wrap gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === t.id ? 'border-act text-ink' : 'border-transparent text-ink-soft hover:text-ink'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {data && tab === 'caixas' && <AccountsTab />}
      {data && tab === 'envio' && <SendingTab key={JSON.stringify(data.settings)} data={data} reload={load} />}
      {tab === 'historico' && <HistoryTab />}
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="email.view">
      <EmailPage />
    </Guard>
  );
}
