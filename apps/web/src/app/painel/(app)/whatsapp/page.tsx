'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Empty, Field, Input, Notice, PageHeader, Panel, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { when } from '@/lib/format';

type Template = { event: string; name: string; language: string; active: boolean; updated_at: string };
type Overview = {
  configured: boolean;
  fake: boolean;
  optinText: string | null;
  events: { event: string; label: string; template: Template | null }[];
  counts: { status: string; n: number }[];
};
type Conversation = { phone: string; last_at: string; last_dir: 'in' | 'out'; last_body: string | null; name: string | null; window_open: boolean | null };
type Message = { dir: 'in' | 'out'; id: string; body: string | null; type: string; status: string | null; error: string | null; event: string | null; order_number: number | null; at: string };
type Thread = { phone: string; messages: Message[]; optedOut: boolean; lastInboundAt: string | null; windowOpenUntil: string | null };

const STATUS: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' | 'act' }> = {
  queued: { label: 'Na fila', tone: 'act' },
  sent: { label: 'Enviada', tone: 'neutral' },
  delivered: { label: 'Entregue', tone: 'good' },
  read: { label: 'Lida', tone: 'good' },
  failed: { label: 'Falhou', tone: 'bad' },
  canceled: { label: 'Cancelada', tone: 'neutral' },
};

/** 5547999998888 -> +55 (47) 99999-8888 */
function phoneText(p: string) {
  const m = p.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `+55 (${m[1]}) ${m[2]}-${m[3]}` : `+${p}`;
}

function Templates({ data, reload }: { data: Overview; reload: () => void }) {
  const { can, me } = useMe();
  const edit = can('settings.manage') && me.user.mfaEnabled;
  const [editing, setEditing] = useState<{ event: string; name: string; language: string; active: boolean } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError('');
    try {
      await api(`/admin/whatsapp/templates/${editing.event}`, { method: 'PUT', body: { name: editing.name.trim(), language: editing.language.trim(), active: editing.active } });
      setEditing(null);
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Avisos automáticos do pedido"
      description="Cada aviso usa um modelo aprovado no WhatsApp Manager. Variáveis nomeadas que o sistema preenche: {{nome}}, {{pedido}} e, no despacho, {{rastreio}}."
    >
      <ul className="divide-y divide-line">
        {data.events.map((ev) => (
          <li key={ev.event} className="py-3">
            {editing?.event === ev.event ? (
              <form onSubmit={save} className="grid gap-3 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
                <Field label={`Modelo para “${ev.label}”`} required hint="Nome exato do modelo no WhatsApp Manager.">
                  {(id) => (
                    <Input id={id} required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value.toLowerCase() })} placeholder="pedido_pago" />
                  )}
                </Field>
                <Field label="Idioma" required>
                  {(id) => <Input id={id} required value={editing.language} onChange={(e) => setEditing({ ...editing, language: e.target.value })} />}
                </Field>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
                  Enviar
                </label>
                {error && (
                  <div className="sm:col-span-3">
                    <Notice tone="bad">{error}</Notice>
                  </div>
                )}
                <div className="flex gap-2 sm:col-span-3">
                  <Button variant="primary" type="submit" busy={busy}>
                    Salvar
                  </Button>
                  <Button type="button" onClick={() => setEditing(null)}>
                    Cancelar
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{ev.label}</p>
                  <p className="text-[13px] text-ink-faint">
                    {ev.template ? (
                      <>
                        Modelo <span className="font-mono">{ev.template.name}</span> ({ev.template.language})
                      </>
                    ) : (
                      'Sem modelo: este aviso não é enviado.'
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {ev.template && <Badge tone={ev.template.active ? 'good' : 'neutral'}>{ev.template.active ? 'Ativo' : 'Pausado'}</Badge>}
                  {edit && (
                    <Button
                      onClick={() => {
                        setError('');
                        setEditing({ event: ev.event, name: ev.template?.name ?? '', language: ev.template?.language ?? 'pt_BR', active: ev.template?.active ?? true });
                      }}
                    >
                      {ev.template ? 'Alterar' : 'Definir modelo'}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3 rounded-md bg-sunken p-3 text-sm">
        <p className="text-[13px] text-ink-faint">Texto do consentimento mostrado ao cliente no checkout e no orçamento:</p>
        {data.optinText ? (
          <p className="mt-1">“{data.optinText}”</p>
        ) : (
          <p className="mt-1">Defina o nome da loja em Marca da loja: o consentimento precisa citar o nome do negócio, e sem ele o cliente não vê a opção.</p>
        )}
      </div>
      {!edit && can('settings.manage') && <p className="mt-2 text-[13px] text-ink-faint">Para alterar os modelos, ative a verificação em duas etapas na sua conta.</p>}
    </Panel>
  );
}

function ThreadView({ phone, onSent }: { phone: string; onSent: () => void }) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<Thread>('/admin/whatsapp/conversations/view', { method: 'POST', body: { phone } }).then(setThread, (e) => setError(e.message)), [phone]);
  useEffect(() => {
    setThread(null);
    setText('');
    setError('');
    load();
  }, [load]);

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/admin/whatsapp/conversations/reply', { method: 'POST', body: { phone, text } });
      setText('');
      onSent();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      load();
    }
  }

  if (!thread) return error ? <Notice tone="bad">{error}</Notice> : <p className="text-sm text-ink-faint">Carregando…</p>;
  const canReply = !thread.optedOut && Boolean(thread.windowOpenUntil);
  return (
    <div>
      <ol className="max-h-[28rem] space-y-2 overflow-y-auto" aria-label={`Mensagens de ${phoneText(phone)}`}>
        {thread.messages.map((m) => (
          <li key={`${m.dir}-${m.id}`} className={m.dir === 'in' ? 'mr-8' : 'ml-8 text-right'}>
            <div className={`inline-block max-w-full rounded-md px-3 py-2 text-left text-sm ${m.dir === 'in' ? 'bg-sunken' : 'border border-line bg-card'}`}>
              <p className="whitespace-pre-wrap break-words">{m.body ?? (m.type === 'text' ? '' : `[${m.type}]`)}</p>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-ink-faint">
                {when(m.at)}
                {m.order_number && <span>Pedido #{m.order_number}</span>}
                {m.dir === 'out' && m.status && <Badge tone={STATUS[m.status]?.tone ?? 'neutral'}>{STATUS[m.status]?.label ?? m.status}</Badge>}
              </p>
              {m.error && <p className="mt-1 text-[12px] text-bad">{m.error}</p>}
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-3">
        {thread.optedOut ? (
          <Notice tone="warn">O cliente pediu para não receber mensagens (respondeu SAIR). Nada é enviado para este número.</Notice>
        ) : !thread.windowOpenUntil ? (
          <Notice>
            Passaram 24 h desde a última mensagem do cliente: o WhatsApp só aceita modelos aprovados. Resposta livre volta a ser possível quando o cliente escrever de
            novo.
          </Notice>
        ) : (
          <p className="text-[13px] text-ink-faint">Pode responder até {when(thread.windowOpenUntil)} (24 h após a última mensagem do cliente).</p>
        )}
      </div>
      {canReply && (
        <form onSubmit={send} className="mt-2 grid gap-2">
          <Field label="Resposta" required>
            {(id) => <Textarea id={id} required maxLength={4096} value={text} onChange={(e) => setText(e.target.value)} />}
          </Field>
          {error && <Notice tone="bad">{error}</Notice>}
          <div>
            <Button variant="primary" type="submit" busy={busy} disabled={!text.trim()}>
              Enviar resposta
            </Button>
          </div>
        </form>
      )}
      {!canReply && error && <Notice tone="bad">{error}</Notice>}
    </div>
  );
}

function Inbox() {
  const [list, setList] = useState<Conversation[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api<{ conversations: Conversation[] }>('/admin/whatsapp/conversations').then((r) => setList(r.conversations), (e) => setError(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <Panel
      title="Conversas"
      description="Últimos 30 dias. Respostas em texto livre só dentro de 24 h da última mensagem do cliente."
      actions={<Button onClick={load}>Atualizar</Button>}
    >
      {error && <Notice tone="bad">{error}</Notice>}
      {list === null ? (
        !error && <p className="text-sm text-ink-faint">Carregando…</p>
      ) : list.length === 0 ? (
        <Empty title="Nenhuma conversa ainda">As mensagens dos clientes e os avisos enviados aparecem aqui.</Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <ul className="divide-y divide-line">
            {list.map((c) => (
              <li key={c.phone}>
                <button
                  type="button"
                  onClick={() => setOpen(c.phone)}
                  aria-current={open === c.phone}
                  className={`w-full px-2 py-2 text-left hover:bg-sunken ${open === c.phone ? 'bg-sunken' : ''}`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium">{c.name ?? phoneText(c.phone)}</span>
                    {c.window_open && <Badge tone="act">Responder</Badge>}
                  </span>
                  {c.name && <span className="block text-[12px] text-ink-faint">{phoneText(c.phone)}</span>}
                  <span className="block truncate text-[13px] text-ink-soft">
                    {c.last_dir === 'out' ? 'Você: ' : ''}
                    {c.last_body ?? '—'}
                  </span>
                  <span className="block text-[12px] text-ink-faint">{when(c.last_at)}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="min-w-0">{open ? <ThreadView key={open} phone={open} onSent={load} /> : <p className="text-sm text-ink-faint">Escolha uma conversa.</p>}</div>
        </div>
      )}
    </Panel>
  );
}

function WhatsAppPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api<Overview>('/admin/whatsapp').then(setData, (e) => setError(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);
  const count = (s: string) => data?.counts.find((c) => c.status === s)?.n ?? 0;

  return (
    <>
      <PageHeader title="WhatsApp" description="Avisos de pedido pela API oficial do WhatsApp (Cloud API), só para clientes que autorizaram, e respostas às mensagens recebidas." />
      {error && <Notice tone="bad">{error}</Notice>}
      {data && (
        <div className="space-y-4">
          {!data.configured ? (
            <Notice tone="warn">WhatsApp não configurado neste servidor. Os avisos ficam desligados até as credenciais da Meta serem cadastradas.</Notice>
          ) : data.fake ? (
            <Notice tone="warn">Modo simulado: nada sai para o WhatsApp de verdade.</Notice>
          ) : null}
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ['Enviadas', count('sent') + count('delivered') + count('read')],
              ['Lidas', count('read')],
              ['Na fila', count('queued')],
              ['Falharam', count('failed')],
            ].map(([label, n]) => (
              <div key={label} className="rounded-md border border-line bg-card px-3 py-2">
                <dt className="text-[13px] text-ink-faint">{label} (30 dias)</dt>
                <dd className="num text-lg font-semibold">{n}</dd>
              </div>
            ))}
          </dl>
          <Templates data={data} reload={load} />
          <Inbox />
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="sales_desk.use">
      <WhatsAppPage />
    </Guard>
  );
}
