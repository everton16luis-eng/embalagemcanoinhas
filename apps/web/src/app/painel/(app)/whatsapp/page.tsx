'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode, type RefObject } from 'react';
import { ArrowLeft, Ban, Bot, Check, CheckCheck, CircleAlert, Clock, Headset, MessageCircle, RefreshCw, Search, SendHorizontal, UserRound } from 'lucide-react';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Empty, Field, Input, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { when } from '@/lib/format';
import { BotTab } from './bot-panel';

type Template = { event: string; name: string; language: string; active: boolean; updated_at: string };
type Overview = {
  configured: boolean;
  fake: boolean;
  optinText: string | null;
  events: { event: string; label: string; template: Template | null }[];
  counts: { status: string; n: number }[];
};
type ConvState = 'bot' | 'agent' | 'closed' | null;
type Conversation = { phone: string; last_at: string; last_dir: 'in' | 'out'; last_body: string | null; name: string | null; window_open: boolean | null; state: ConvState; assigned_name: string | null };
type Message = { dir: 'in' | 'out'; id: string; body: string | null; type: string; status: string | null; error: string | null; event: string | null; order_number: number | null; source: string | null; at: string };
type Thread = { phone: string; messages: Message[]; optedOut: boolean; state: ConvState; assignedName: string | null; lastInboundAt: string | null; windowOpenUntil: string | null };

const SOURCE: Record<string, string> = { bot: 'Bot', agent: 'Atendente', system: 'Aviso automático' };

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
                <Field label={`Modelo para “${ev.label}”`} required>
                  {(id) => (
                    <Input id={id} required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value.toLowerCase() })} placeholder="pedido_pago" aria-describedby={`modelo-dica-${ev.event}`} />
                  )}
                </Field>
                <Field label="Idioma" required>
                  {(id) => <Input id={id} required value={editing.language} onChange={(e) => setEditing({ ...editing, language: e.target.value })} />}
                </Field>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
                  Enviar
                </label>
                <p id={`modelo-dica-${ev.event}`} className="-mt-1.5 text-[13px] text-ink-faint sm:col-span-3">
                  Nome exato do modelo no WhatsApp Manager.
                </p>
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

/* ---------- Apresentação no estilo do WhatsApp Web (só visual: dados e chamadas são os mesmos de antes) ---------- */

const TZ = 'America/Sao_Paulo';
const hourFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const dayFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: TZ });
const weekdayFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: TZ });
const keyFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ });

/** Dias de calendário (no fuso da loja) entre a data e hoje. */
function daysAgo(v: string) {
  return Math.round((Date.parse(keyFmt.format(new Date())) - Date.parse(keyFmt.format(new Date(v)))) / 86_400_000);
}
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Separador de data: Hoje, Ontem, dia da semana ou dd/mm/aaaa. */
function dayLabel(v: string) {
  const d = daysAgo(v);
  if (d === 0) return 'Hoje';
  if (d === 1) return 'Ontem';
  if (d > 1 && d < 7) return capital(weekdayFmt.format(new Date(v)));
  return dayFmt.format(new Date(v));
}
/** Horário da lista: hora se hoje, "Ontem", dia da semana ou data. */
function listTime(v: string) {
  const d = daysAgo(v);
  if (d === 0) return hourFmt.format(new Date(v));
  if (d === 1) return 'Ontem';
  if (d > 1 && d < 7) return weekdayFmt.format(new Date(v));
  return dayFmt.format(new Date(v));
}

function stateText(state: ConvState, assigned: string | null) {
  if (state === 'agent') return `Com atendente${assigned ? `: ${assigned}` : ''}. O bot não responde.`;
  if (state === 'closed') return 'Conversa encerrada. Uma nova mensagem reabre o atendimento.';
  return 'Com o bot (quando ligado).';
}

/** Ocupa a largura útil do painel inteiro (a página comum fica limitada a max-w-6xl). */
function useBleed(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    const main = el?.closest('main');
    if (!el || !parent || !main) return;
    const fit = () => {
      const cs = getComputedStyle(main);
      const pl = parseFloat(cs.paddingLeft);
      const pr = parseFloat(cs.paddingRight);
      el.style.marginLeft = `${main.getBoundingClientRect().left + pl - parent.getBoundingClientRect().left}px`;
      el.style.width = `${main.clientWidth - pl - pr}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(main);
    window.addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
      el.style.marginLeft = '';
      el.style.width = '';
    };
  }, [ref]);
}

/** Estica a caixa até o fim da janela: cada coluna rola sozinha e a página não rola. */
function useFillHeight(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    const main = el?.closest('main');
    if (!el || !main) return;
    const fit = () => {
      const pb = parseFloat(getComputedStyle(main).paddingBottom);
      const top = el.getBoundingClientRect().top + window.scrollY;
      el.style.height = `${Math.max(320, Math.floor(window.innerHeight - top - pb))}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(main);
    window.addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [ref]);
}

/** Área visível de verdade (encolhe com o teclado virtual do celular). */
function useVisualViewport() {
  const [vv, setVv] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const v = window.visualViewport;
    const update = () => setVv(v ? { top: v.offsetTop, height: v.height } : { top: 0, height: window.innerHeight });
    update();
    v?.addEventListener('resize', update);
    v?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      v?.removeEventListener('resize', update);
      v?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  return vv;
}

function Avatar({ size }: { size: number }) {
  return (
    <span aria-hidden className="relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-[#dfe5e7] text-white" style={{ width: size, height: size }}>
      <UserRound size={Math.round(size * 0.78)} strokeWidth={1} fill="currentColor" className="translate-y-[16%]" />
    </span>
  );
}

function Ticks({ status }: { status: string }) {
  const label = STATUS[status]?.label ?? status;
  const icon =
    status === 'queued' ? (
      <Clock size={13} strokeWidth={2} />
    ) : status === 'sent' ? (
      <Check size={16} strokeWidth={2} />
    ) : status === 'delivered' ? (
      <CheckCheck size={16} strokeWidth={2} />
    ) : status === 'read' ? (
      <CheckCheck size={16} strokeWidth={2} className="text-[#53bdeb]" />
    ) : status === 'failed' ? (
      <CircleAlert size={15} strokeWidth={2} className="text-[#ea0038]" />
    ) : status === 'canceled' ? (
      <Ban size={13} strokeWidth={2} />
    ) : null;
  return (
    <span title={label} className="inline-flex items-center">
      {icon && <span aria-hidden className="contents">{icon}</span>}
      <span className={icon ? 'sr-only' : ''}>{label}</span>
    </span>
  );
}

/** Ponta do balão, só na primeira mensagem de cada sequência. */
function Tail({ side }: { side: 'in' | 'out' }) {
  return side === 'in' ? (
    <svg aria-hidden viewBox="0 0 8 13" width="8" height="13" className="absolute top-0 -left-2 text-white">
      <path fill="currentColor" d="M8 0H1.6C.3 0-.3 1.5.6 2.4L8 10z" />
    </svg>
  ) : (
    <svg aria-hidden viewBox="0 0 8 13" width="8" height="13" className="absolute top-0 -right-2 text-[#d9fdd3]">
      <path fill="currentColor" d="M0 0h6.4c1.3 0 1.9 1.5 1 2.4L0 10z" />
    </svg>
  );
}

function Bubble({ m, first }: { m: Message; first: boolean }) {
  const out = m.dir === 'out';
  const extra = [out && m.source ? (SOURCE[m.source] ?? m.source) : null, m.order_number ? `Pedido #${m.order_number}` : null].filter(Boolean).join(' · ');
  const text = m.body ?? (m.type === 'text' ? '' : `[${m.type}]`);
  return (
    <div className={`flex ${out ? 'justify-end' : 'justify-start'} ${first ? 'mt-3' : 'mt-0.5'} px-[4%] md:px-[7%]`}>
      <div
        className={`relative max-w-[85%] rounded-[7.5px] px-[9px] pt-1.5 pb-2 text-[14.2px] leading-[19px] text-[#111b21] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)] md:max-w-[65%] ${
          out ? `bg-[#d9fdd3] ${first ? 'rounded-tr-none' : ''}` : `bg-white ${first ? 'rounded-tl-none' : ''}`
        }`}
      >
        {first && <Tail side={m.dir} />}
        {extra && <p className="mb-0.5 text-[12.5px] leading-4 font-medium text-[#667781]">{extra}</p>}
        <p className={`break-words whitespace-pre-wrap ${m.body === null && m.type !== 'text' ? 'text-[#667781] italic' : ''}`}>
          {text}
          <span className="relative top-[7px] float-right ml-2.5 -mt-1 flex items-center gap-1 text-[11px] leading-[15px] whitespace-nowrap text-[#667781]">
            <time dateTime={m.at} title={when(m.at)}>
              {hourFmt.format(new Date(m.at))}
            </time>
            {out && m.status && <Ticks status={m.status} />}
          </span>
        </p>
        {m.error && <p className="clear-both pt-1.5 text-[12.5px] leading-4 text-[#ea0038]">{m.error}</p>}
      </div>
    </div>
  );
}

/** Aviso centralizado no meio da conversa, como os do próprio WhatsApp. */
function SystemPill({ tone = 'plain', children }: { tone?: 'plain' | 'yellow'; children: ReactNode }) {
  return (
    <div className="mt-3 flex justify-center px-[4%] md:px-[7%]">
      <p
        role="status"
        className={`max-w-[85%] rounded-[7.5px] px-3 py-1.5 text-center text-[12.5px] leading-[17px] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)] md:max-w-[65%] ${
          tone === 'yellow' ? 'bg-[#ffeecd] text-[#54656f]' : 'bg-white text-[#54656f]'
        }`}
      >
        {children}
      </p>
    </div>
  );
}

const WALLPAPER: CSSProperties = {
  backgroundColor: '#efeae2',
  backgroundImage: 'radial-gradient(rgba(84,101,111,0.07) 1px, transparent 1.4px), radial-gradient(rgba(84,101,111,0.05) 1px, transparent 1.4px)',
  backgroundSize: '22px 22px, 22px 22px',
  backgroundPosition: '0 0, 11px 11px',
};

const iconBtn = 'grid size-10 shrink-0 place-items-center rounded-full text-[#54656f] transition-colors hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-[#00a884] disabled:opacity-50';

function ThreadView({ phone, name, onSent, onBack }: { phone: string; name: string | null; onSent: () => void; onBack: () => void }) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const replyId = useId();

  const load = useCallback(() => api<Thread>('/admin/whatsapp/conversations/view', { method: 'POST', body: { phone } }).then(setThread, (e) => setError(e.message)), [phone]);
  useEffect(() => {
    setThread(null);
    setText('');
    setError('');
    load();
  }, [load]);

  // Abre já na mensagem mais recente, como no WhatsApp, e continua no fim quando o campo de resposta cresce.
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [thread, text]);

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

  async function handover(action: 'take' | 'release') {
    setBusy(true);
    setError('');
    try {
      await api(`/admin/whatsapp/conversations/${action}`, { method: 'POST', body: { phone } });
      onSent();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canReply = Boolean(thread?.windowOpenUntil);
  const status = thread ? stateText(thread.state, thread.assignedName) : '';

  // Mensagens agrupadas por dia (separador fixo no topo enquanto o dia rola).
  const days: { key: string; label: string; items: Message[] }[] = [];
  for (const m of thread?.messages ?? []) {
    const key = keyFmt.format(new Date(m.at));
    const last = days[days.length - 1];
    if (last?.key === key) last.items.push(m);
    else days.push({ key, label: dayLabel(m.at), items: [m] });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-[59px] shrink-0 items-center gap-2 bg-[#f0f2f5] pr-2 pl-1 md:gap-3 md:px-4">
        <button type="button" onClick={onBack} aria-label="Voltar para a lista de conversas" className={`${iconBtn} md:hidden`}>
          <ArrowLeft size={22} strokeWidth={2} aria-hidden />
        </button>
        <Avatar size={40} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[16px] leading-[21px] text-[#111b21]">{name ?? phoneText(phone)}</h2>
          <p className="truncate text-[13px] leading-5 text-[#667781]" title={status}>
            {name && <span className="num">{phoneText(phone)} · </span>}
            {thread ? status : 'Carregando…'}
          </p>
        </div>
        {thread &&
          (thread.state === 'agent' ? (
            <button type="button" disabled={busy} onClick={() => handover('release')} title="Devolver ao bot" className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[14px] text-[#008069] transition-colors hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-[#00a884] disabled:opacity-55">
              <Bot size={18} strokeWidth={1.9} aria-hidden />
              <span className="max-lg:sr-only">{busy ? 'Aguarde…' : 'Devolver ao bot'}</span>
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => handover('take')} title="Assumir conversa" className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[14px] text-[#008069] transition-colors hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-[#00a884] disabled:opacity-55">
              <Headset size={18} strokeWidth={1.9} aria-hidden />
              <span className="max-lg:sr-only">{busy ? 'Aguarde…' : 'Assumir conversa'}</span>
            </button>
          ))}
      </header>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.clientHeight - el.scrollTop < 48;
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3"
        style={WALLPAPER}
      >
        {!thread ? (
          error ? (
            <SystemPill tone="yellow">{error}</SystemPill>
          ) : (
            <SystemPill>Carregando…</SystemPill>
          )
        ) : (
          <>
            <ol aria-label={`Mensagens de ${phoneText(phone)}`}>
              {days.map((d) => (
                <li key={d.key}>
                  <div className="sticky top-0 z-10 flex justify-center pt-3 pb-1">
                    <span className="rounded-[7.5px] bg-white px-3 py-[5px] text-[12.5px] leading-[15px] text-[#54656f] uppercase shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]">{d.label}</span>
                  </div>
                  <ol>
                    {d.items.map((m, i) => (
                      <li key={`${m.dir}-${m.id}`}>
                        <Bubble m={m} first={i === 0 || d.items[i - 1].dir !== m.dir} />
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ol>
            {thread.optedOut && <SystemPill tone="yellow">Notificações automáticas de pedido desativadas para este número.</SystemPill>}
            {thread.windowOpenUntil ? (
              <SystemPill>Pode responder até {when(thread.windowOpenUntil)} (24 h após a última mensagem do cliente).</SystemPill>
            ) : (
              <SystemPill tone="yellow">
                Passaram 24 h desde a última mensagem do cliente: o WhatsApp só aceita modelos aprovados. Resposta livre volta a ser possível quando o cliente escrever de novo.
              </SystemPill>
            )}
          </>
        )}
      </div>

      {error && thread && (
        <p role="alert" className="shrink-0 border-t border-[#e9edef] bg-[#fdeceb] px-4 py-2 text-[13px] text-[#b42318]">
          {error}
        </p>
      )}
      {thread && canReply ? (
        <form onSubmit={send} className="flex shrink-0 items-end gap-2 bg-[#f0f2f5] px-2 py-[5px] md:px-4">
          <label htmlFor={replyId} className="sr-only">
            Resposta
          </label>
          <textarea
            id={replyId}
            required
            rows={1}
            maxLength={4096}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Digite uma mensagem"
            className="my-[5px] max-h-[7.5rem] min-h-[42px] min-w-0 flex-1 resize-none rounded-lg bg-white px-3 py-[10px] text-[15px] leading-[21px] text-[#111b21] [field-sizing:content] placeholder:text-[#667781] focus:outline-none focus-visible:ring-0"
          />
          <button
            type="submit"
            disabled={busy || !text.trim()}
            aria-label="Enviar resposta"
            title="Enviar resposta"
            className="mb-[5px] grid size-[42px] shrink-0 place-items-center rounded-full bg-[#00a884] text-white transition-colors hover:bg-[#008f72] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00a884] disabled:bg-transparent disabled:text-[#8696a0]"
          >
            {busy ? <Clock size={20} strokeWidth={2} aria-hidden /> : <SendHorizontal size={22} strokeWidth={2} aria-hidden />}
          </button>
        </form>
      ) : thread ? (
        <p className="flex min-h-[62px] shrink-0 items-center justify-center bg-[#f0f2f5] px-4 py-2 text-center text-[13.5px] text-[#667781]">
          Resposta livre indisponível: fora da janela de 24 h.
        </p>
      ) : null}
    </div>
  );
}

type Filter = 'all' | 'agent' | 'window';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Tudo' },
  { id: 'window', label: 'Janela de 24 h' },
  { id: 'agent', label: 'Com atendente' },
];

function Inbox() {
  const [list, setList] = useState<Conversation[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [reloading, setReloading] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const vv = useVisualViewport();
  useFillHeight(box);
  const load = useCallback(() => api<{ conversations: Conversation[] }>('/admin/whatsapp/conversations').then((r) => setList(r.conversations), (e) => setError(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);

  async function refresh() {
    setReloading(true);
    await load();
    setReloading(false);
  }

  // Busca e filtros só sobre a lista que já veio da API.
  const q = query.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const shown = (list ?? []).filter(
    (c) =>
      (filter === 'all' || (filter === 'agent' ? c.state === 'agent' : Boolean(c.window_open))) &&
      (!q || (c.name ?? '').toLowerCase().includes(q) || (c.last_body ?? '').toLowerCase().includes(q) || (digits.length > 0 && c.phone.includes(digits))),
  );
  const current = list?.find((c) => c.phone === open) ?? null;

  return (
    <div ref={box} className="grid min-h-0 grid-cols-[minmax(0,1fr)] overflow-hidden border border-[#d1d7db] bg-white md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:grid-cols-[minmax(19rem,30%)_minmax(0,1fr)]">
      {/* Lista de conversas */}
      <section aria-label="Conversas" className={`flex min-h-0 flex-col md:border-r md:border-[#d1d7db] ${open ? 'max-md:hidden' : ''}`}>
        <header className="flex h-[59px] shrink-0 items-center justify-between gap-2 bg-[#f0f2f5] px-4">
          <h2 className="text-[16px] font-medium text-[#111b21]">Conversas</h2>
          <button type="button" onClick={refresh} disabled={reloading} aria-label="Atualizar" title="Atualizar" className={iconBtn}>
            <RefreshCw size={19} strokeWidth={1.9} aria-hidden className={reloading ? 'animate-spin' : ''} />
          </button>
        </header>
        <div className="shrink-0 border-b border-[#e9edef] px-3 pt-[7px] pb-2">
          <label className="relative block">
            <span className="sr-only">Pesquisar conversa</span>
            <Search size={16} strokeWidth={2} aria-hidden className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-[#54656f]" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Pesquisar nome, número ou mensagem"
              className="h-[35px] w-full rounded-lg bg-[#f0f2f5] pr-3 pl-12 text-[14px] text-[#111b21] placeholder:text-[#667781] focus:bg-white focus:shadow-[0_0_0_2px_#00a884] focus:outline-none"
            />
          </label>
          <div role="group" aria-label="Filtrar conversas" className="mt-2 flex gap-2 overflow-x-auto [scrollbar-width:none]">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={`h-8 shrink-0 rounded-full px-3 text-[14px] transition-colors focus-visible:outline-2 focus-visible:outline-[#00a884] ${
                  filter === f.id ? 'bg-[#e7fce3] text-[#008069]' : 'bg-[#f0f2f5] text-[#54656f] hover:bg-[#e9edef]'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {error && <p role="alert" className="m-3 rounded-md bg-[#fdeceb] px-3 py-2 text-[13px] text-[#b42318]">{error}</p>}
          {list === null ? (
            !error && <p className="px-4 py-6 text-center text-[14px] text-[#667781]">Carregando…</p>
          ) : list.length === 0 ? (
            <Empty title="Nenhuma conversa ainda">As mensagens dos clientes e os avisos enviados aparecem aqui.</Empty>
          ) : shown.length === 0 ? (
            <p className="px-4 py-8 text-center text-[14px] text-[#667781]">Nenhuma conversa encontrada.</p>
          ) : (
            <ul>
              {shown.map((c) => {
                const selected = open === c.phone;
                return (
                  <li key={c.phone}>
                    <button
                      type="button"
                      onClick={() => setOpen(c.phone)}
                      aria-current={selected}
                      title={c.name ? phoneText(c.phone) : undefined}
                      className={`group flex h-[72px] w-full items-center gap-3 pl-3 text-left transition-colors focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-[#00a884] ${
                        selected ? 'bg-[#f0f2f5]' : 'hover:bg-[#f5f6f6]'
                      }`}
                    >
                      <Avatar size={49} />
                      <span className={`flex h-full min-w-0 flex-1 flex-col justify-center border-b pr-4 ${selected ? 'border-transparent' : 'border-[#e9edef]'}`}>
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-[17px] leading-[21px] text-[#111b21]">{c.name ?? phoneText(c.phone)}</span>
                          <time dateTime={c.last_at} title={when(c.last_at)} className="shrink-0 text-[12px] text-[#667781]">
                            {listTime(c.last_at)}
                          </time>
                        </span>
                        <span className="mt-0.5 flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-[14px] leading-5 text-[#667781]">
                            {c.last_dir === 'out' ? 'Você: ' : ''}
                            {c.last_body ?? '—'}
                          </span>
                          {c.state === 'agent' && (
                            <span title={`Com atendente${c.assigned_name ? `: ${c.assigned_name}` : ''}`} className="inline-flex shrink-0 items-center gap-1 text-[12px] text-[#8a5a00]">
                              <Headset size={15} strokeWidth={1.9} aria-hidden />
                              <span className="sr-only">Atendente</span>
                            </span>
                          )}
                          {c.window_open && (
                            <span title="Dentro da janela de 24 h: dá para responder em texto livre" className="shrink-0 rounded-full bg-[#25d366] px-1.5 py-px text-[11px] leading-4 font-medium text-white">
                              Responder
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {list && list.length > 0 && (
            <p className="px-6 py-5 text-center text-[12px] leading-4 text-[#8696a0]">Últimos 30 dias. Respostas em texto livre só dentro de 24 h da última mensagem do cliente.</p>
          )}
        </div>
      </section>

      {/* Conversa aberta: no celular vira tela cheia por cima, do tamanho da área visível (teclado incluído). */}
      <section
        aria-label="Conversa"
        className={`min-h-0 min-w-0 bg-[#f0f2f5] ${open ? 'max-md:fixed max-md:inset-x-0 max-md:top-[var(--vv-top)] max-md:z-30 max-md:h-[var(--vv-h)]' : 'max-md:hidden'}`}
        style={{ '--vv-top': `${vv?.top ?? 0}px`, '--vv-h': vv ? `${vv.height}px` : '100dvh' } as CSSProperties}
      >
        {open ? (
          <ThreadView key={open} phone={open} name={current?.name ?? null} onSent={load} onBack={() => setOpen(null)} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <MessageCircle size={72} strokeWidth={1} aria-hidden className="text-[#c4ccd0]" />
            <p className="text-[28px] font-light text-[#41525d]">WhatsApp da loja</p>
            <p className="max-w-md text-[14px] leading-5 text-[#667781]">Escolha uma conversa na lista para ver o histórico e responder.</p>
          </div>
        )}
      </section>
    </div>
  );
}

const TABS = [
  { id: 'conversas', label: 'Conversas' },
  { id: 'bot', label: 'Bot de atendimento' },
  { id: 'avisos', label: 'Avisos do pedido' },
] as const;

function WhatsAppPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('conversas');
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  useBleed(root);
  const load = useCallback(() => api<Overview>('/admin/whatsapp').then(setData, (e) => setError(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);
  const count = (s: string) => data?.counts.find((c) => c.status === s)?.n ?? 0;

  return (
    <div ref={root} className="min-w-0">
      <div className="mb-3 flex flex-wrap items-end gap-x-6 gap-y-2 border-b border-line">
        <h1 className="pb-2 text-[22px] leading-7 font-semibold tracking-tight">WhatsApp</h1>
        <div role="tablist" aria-label="Seções" className="flex max-w-full gap-1 overflow-x-auto [scrollbar-width:none]">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap ${tab === t.id ? 'border-act text-ink' : 'border-transparent text-ink-soft hover:text-ink'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {data && (
          <dl className="ml-auto flex flex-wrap gap-x-4 gap-y-0.5 pb-2.5 text-[13px] text-ink-faint" title="Avisos e respostas dos últimos 30 dias">
            {[
              ['Enviadas', count('sent') + count('delivered') + count('read')],
              ['Lidas', count('read')],
              ['Na fila', count('queued')],
              ['Falharam', count('failed')],
            ].map(([label, n]) => (
              <div key={label} className="flex items-baseline gap-1">
                <dt>{label} (30 dias)</dt>
                <dd className="num font-semibold text-ink">{n}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {tab !== 'conversas' && (
        <p className="mb-4 max-w-3xl text-sm text-ink-soft">Avisos de pedido pela API oficial do WhatsApp (Cloud API), só para clientes que autorizaram, e respostas às mensagens recebidas.</p>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
      {data && (
        <div className="space-y-3">
          {!data.configured ? (
            <Notice tone="warn">WhatsApp não configurado neste servidor. Os avisos ficam desligados até as credenciais da Meta serem cadastradas.</Notice>
          ) : data.fake ? (
            <Notice tone="warn">Modo simulado: nada sai para o WhatsApp de verdade.</Notice>
          ) : null}
          {tab === 'conversas' && <Inbox />}
          {tab === 'bot' && <BotTab />}
          {tab === 'avisos' && <Templates data={data} reload={load} />}
        </div>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Guard perm="sales_desk.use">
      <WhatsAppPage />
    </Guard>
  );
}
