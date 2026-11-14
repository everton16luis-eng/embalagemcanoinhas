'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useMe } from '@/components/shell';
import { Badge, Button, Field, Input, Notice, Panel, Textarea } from '@/components/ui';
import { api } from '@/lib/api';

type Day = { open: string; close: string } | null;
type Audience = 'off' | 'test' | 'all';
type Mode = 'menu' | 'ai' | 'menu_ai' | 'typebot';
type AiPlan = 'free' | 'paid';
type BotData = {
  settings: {
    audience: Audience;
    mode: Mode;
    testPhones: string[];
    hours: Record<string, Day>;
    texts: Record<string, string>;
    aiPlan: AiPlan;
    aiMonthlyLimitUsd: number;
    aiDailyPerPhone: number;
    typebotPublicId: string | null;
  };
  typebot: { configured: boolean; simulated: boolean };
  ai: { configured: boolean; simulated: boolean; model: string | null; month: { usd: number; calls: number; failed: number } };
  defaults: Record<string, string>;
  labels: Record<string, string>;
  variables: string[];
  open: boolean;
  hoursText: string | null;
};
type Interactive =
  | { type: 'button'; body: string; buttons: { id: string; title: string }[] }
  | { type: 'list'; body: string; button: string; rows: { id: string; title: string; description?: string }[] };
type Reply = { kind: 'text'; body: string } | { kind: 'interactive'; i: Interactive };
type ChatLine = { from: 'you' | 'bot'; reply: Reply; ai?: boolean } | { from: 'note'; text: string };

export const AUDIENCE: Record<Audience, { label: string; tone: 'good' | 'warn' | 'neutral' }> = {
  off: { label: 'Desligado', tone: 'neutral' },
  test: { label: 'Só números de teste', tone: 'warn' },
  all: { label: 'Ligado para todos', tone: 'good' },
};
const MODES: Record<Mode, { label: string; hint: string }> = {
  menu: { label: 'Só menu', hint: 'Respostas fixas: o cliente escolhe uma opção. Sem custo e sem IA.' },
  menu_ai: { label: 'Menu e IA', hint: 'O menu abre a conversa; quando o cliente escreve algo que o menu não entende, a IA responde.' },
  ai: { label: 'IA', hint: 'A IA responde o que o cliente escrever. Os botões, a consulta de pedido e a confirmação por CPF/CNPJ continuam com o menu.' },
  typebot: { label: 'Typebot', hint: 'Um fluxo montado no editor do Typebot conduz a conversa. Pedido e atendente continuam com a loja (valores reservados nos botões).' },
};
const usd = (n: number) => `US$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 })}`;

const DAYS = [
  ['1', 'Segunda'],
  ['2', 'Terça'],
  ['3', 'Quarta'],
  ['4', 'Quinta'],
  ['5', 'Sexta'],
  ['6', 'Sábado'],
  ['0', 'Domingo'],
] as const;

function Settings({ data, reload }: { data: BotData; reload: () => void }) {
  const { can, me } = useMe();
  const edit = can('bot.manage') && me.user.mfaEnabled;
  const [audience, setAudience] = useState<Audience>(data.settings.audience);
  const [phones, setPhones] = useState(data.settings.testPhones.join('\n'));
  const [useHours, setUseHours] = useState(Object.keys(data.settings.hours).length > 0);
  const [hours, setHours] = useState<Record<string, Day>>(() =>
    Object.fromEntries(DAYS.map(([d]) => [d, Object.keys(data.settings.hours).length ? (data.settings.hours[d] ?? null) : d === '0' ? null : { open: '08:00', close: '18:00' }])),
  );
  const [texts, setTexts] = useState<Record<string, string>>(data.settings.texts);
  const [mode, setMode] = useState<Mode>(data.settings.mode);
  const [aiPlan, setAiPlan] = useState<AiPlan>(data.settings.aiPlan);
  const [monthly, setMonthly] = useState(String(data.settings.aiMonthlyLimitUsd));
  const [daily, setDaily] = useState(String(data.settings.aiDailyPerPhone));
  const [typebotId, setTypebotId] = useState(data.settings.typebotPublicId ?? '');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await api('/admin/whatsapp/bot', {
        method: 'PUT',
        body: {
          audience,
          testPhones: phones
            .split(/[\n,;]+/)
            .map((p) => p.replace(/\D/g, ''))
            .filter(Boolean),
          hours: useHours ? hours : {},
          texts,
          mode,
          aiPlan,
          aiMonthlyLimitUsd: Number(monthly.replace(',', '.')),
          aiDailyPerPhone: Number(daily),
          typebotPublicId: typebotId.trim() || null,
        },
      });
      setSaved(true);
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Bot de atendimento"
      description="Responde as mensagens dos clientes com um menu (acompanhar pedido, orçamento, horário e endereço, falar com um atendente) e, se você ligar, com IA. Não altera pedidos nem dá descontos."
      actions={<Badge tone={AUDIENCE[data.settings.audience].tone}>{AUDIENCE[data.settings.audience].label}</Badge>}
    >
      <form onSubmit={save} className="space-y-5">
        <fieldset disabled={!edit} className="space-y-2">
          <legend className="text-sm font-medium">Quem o bot atende</legend>
          {(['off', 'test', 'all'] as const).map((a) => (
            <label key={a} className="flex min-h-9 items-start gap-2 text-sm">
              <input type="radio" name="audience" className="mt-1" checked={audience === a} onChange={() => setAudience(a)} />
              <span>
                {AUDIENCE[a].label}
                <span className="block text-[13px] text-ink-faint">
                  {a === 'off' && 'Ninguém recebe resposta automática. Mensagens que chegarem desligado não são respondidas depois.'}
                  {a === 'test' && 'Só os números da lista abaixo. Os clientes não recebem nada do bot.'}
                  {a === 'all' && 'Todos os clientes que escreverem para a loja.'}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset disabled={!edit} className="space-y-2">
          <legend className="text-sm font-medium">Como o bot responde</legend>
          {(['menu', 'menu_ai', 'ai', 'typebot'] as const).map((m) => (
            <label key={m} className="flex min-h-9 items-start gap-2 text-sm">
              <input type="radio" name="mode" className="mt-1" checked={mode === m} onChange={() => setMode(m)} />
              <span>
                {MODES[m].label}
                <span className="block text-[13px] text-ink-faint">{MODES[m].hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {mode === 'typebot' && (
          <fieldset disabled={!edit} className="space-y-3 rounded-md border border-line p-3">
            <legend className="px-1 text-sm font-medium">Typebot</legend>
            {!data.typebot.configured ? (
              <Notice tone="warn">O Typebot não está ligado no servidor (TYPEBOT_API_URL). Até lá, o bot responde só com o menu.</Notice>
            ) : (
              data.typebot.simulated && <p className="text-[13px] text-ink-faint">Typebot simulado (desenvolvimento).</p>
            )}
            <Field label="ID público do fluxo" hint="No editor do Typebot, publique o fluxo e copie o final do endereço de compartilhamento (bot.embalagemcanoinhas.com.br/<id>).">
              {(id) => <Input id={id} value={typebotId} onChange={(e) => setTypebotId(e.target.value)} className="max-w-sm font-mono" />}
            </Field>
            <p className="text-[13px] text-ink-faint">
              Valores reservados nos botões do fluxo: <code>atendente</code> passa para um atendente, <code>pedido</code> abre a consulta de pedido da loja (com CPF/CNPJ quando
              precisa) e <code>menu</code> mostra o menu. Não monte fluxos que peçam documento ou senha.
            </p>
          </fieldset>
        )}

        {(mode === 'ai' || mode === 'menu_ai') && (
          <fieldset disabled={!edit} className="space-y-3 rounded-md border border-line p-3">
            <legend className="px-1 text-sm font-medium">Inteligência artificial (Gemini)</legend>
            {!data.ai.configured ? (
              <Notice tone="warn">A chave da IA não está configurada no servidor. Até lá, o bot responde só com o menu.</Notice>
            ) : (
              <p className="text-[13px] text-ink-faint">
                Modelo: {data.ai.simulated ? 'simulado (desenvolvimento)' : data.ai.model}. Neste mês: {data.ai.month.calls} chamada(s), gasto estimado de {usd(data.ai.month.usd)}
                {data.ai.month.failed > 0 && `, ${data.ai.month.failed} com falha`}.
              </p>
            )}
            <div className="space-y-2">
              {(['free', 'paid'] as const).map((p) => (
                <label key={p} className="flex min-h-9 items-start gap-2 text-sm">
                  <input type="radio" name="aiPlan" className="mt-1" checked={aiPlan === p} onChange={() => setAiPlan(p)} />
                  <span>
                    {p === 'free' ? 'Plano gratuito (testes)' : 'Plano pago'}
                    <span className="block text-[13px] text-ink-faint">
                      {p === 'free'
                        ? 'A IA só atende o chat de teste e os números de teste. No plano gratuito o Google pode usar as conversas para melhorar os produtos dele, por isso clientes não falam com a IA.'
                        : 'A IA atende todos os clientes. Só use depois de ativar o faturamento na conta do Google com a chave do servidor: cada resposta é cobrada.'}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Limite de gasto no mês (US$)" hint="Atingido o limite, o bot volta ao menu até o mês seguinte. 0 desliga a IA.">
                {(id) => <Input id={id} inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} className="max-w-32" />}
              </Field>
              <Field label="Respostas da IA por cliente em 24 h" hint="Passou disso, a conversa vai para um atendente.">
                {(id) => <Input id={id} inputMode="numeric" value={daily} onChange={(e) => setDaily(e.target.value)} className="max-w-32" />}
              </Field>
            </div>
          </fieldset>
        )}

        {(audience === 'test' || ((mode === 'ai' || mode === 'menu_ai') && aiPlan === 'free')) && (
          <Field label="Números de teste" hint="Um por linha, com 55 e DDD, por exemplo 5547999998888. Até 20. No plano gratuito, só eles falam com a IA.">
            {(id) => <Textarea id={id} disabled={!edit} value={phones} onChange={(e) => setPhones(e.target.value)} className="font-mono" />}
          </Field>
        )}

        <fieldset disabled={!edit} className="space-y-2">
          <legend className="text-sm font-medium">Horário de atendimento</legend>
          <label className="flex min-h-9 items-center gap-2 text-sm">
            <input type="checkbox" checked={useHours} onChange={(e) => setUseHours(e.target.checked)} />
            Avisar quando a mensagem chegar fora do horário
          </label>
          {useHours && (
            <div className="grid gap-2 sm:grid-cols-2">
              {DAYS.map(([d, label]) => {
                const h = hours[d] ?? null;
                return (
                  <div key={d} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-sm">
                    <label className="flex w-28 items-center gap-2">
                      <input type="checkbox" checked={Boolean(h)} onChange={(e) => setHours({ ...hours, [d]: e.target.checked ? { open: '08:00', close: '18:00' } : null })} />
                      {label}
                    </label>
                    {h ? (
                      <>
                        <Input type="time" aria-label={`${label}: abre`} value={h.open} onChange={(e) => setHours({ ...hours, [d]: { ...h, open: e.target.value } })} className="w-28" />
                        <span className="text-ink-faint">às</span>
                        <Input type="time" aria-label={`${label}: fecha`} value={h.close} onChange={(e) => setHours({ ...hours, [d]: { ...h, close: e.target.value } })} className="w-28" />
                      </>
                    ) : (
                      <span className="text-ink-faint">Fechado</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {data.hoursText && <p className="text-[13px] text-ink-faint">Agora: {data.open ? 'dentro do horário' : 'fora do horário'} (horário de Brasília).</p>}
        </fieldset>

        <fieldset disabled={!edit} className="space-y-3">
          <legend className="text-sm font-medium">Textos</legend>
          <p className="text-[13px] text-ink-faint">
            Deixe em branco para usar o texto padrão. Variáveis: {data.variables.map((v) => `{${v}}`).join(', ')} (nome da loja, primeiro nome do cliente no WhatsApp, endereço da loja virtual).
          </p>
          {Object.keys(data.defaults).map((k) => (
            <Field key={k} label={data.labels[k] ?? k}>
              {(id) => <Textarea id={id} maxLength={1000} placeholder={data.defaults[k]} value={texts[k] ?? ''} onChange={(e) => setTexts({ ...texts, [k]: e.target.value })} className="min-h-16" />}
            </Field>
          ))}
        </fieldset>

        {error && <Notice tone="bad">{error}</Notice>}
        {saved && <Notice tone="good">Configuração salva.</Notice>}
        {edit ? (
          <Button variant="primary" type="submit" busy={busy}>
            Salvar
          </Button>
        ) : (
          <p className="text-[13px] text-ink-faint">
            {can('bot.manage') ? 'Para alterar o bot, ative a verificação em duas etapas na sua conta.' : 'Só quem tem a permissão “Configurar o bot de atendimento do WhatsApp” altera o bot.'}
          </p>
        )}
      </form>
    </Panel>
  );
}

function Bubble({ line, onChoose, busy }: { line: ChatLine; onChoose: (id: string, title: string) => void; busy: boolean }) {
  if (line.from === 'note') return <li className="text-center text-[12px] text-ink-faint">{line.text}</li>;
  const r = line.reply;
  const body = r.kind === 'text' ? r.body : r.i.body;
  const options = r.kind === 'interactive' ? (r.i.type === 'button' ? r.i.buttons : r.i.rows) : [];
  return (
    <li className={line.from === 'you' ? 'ml-8 text-right' : 'mr-8'}>
      <div className={`inline-block max-w-full rounded-md px-3 py-2 text-left text-sm ${line.from === 'you' ? 'border border-line bg-card' : 'bg-sunken'}`}>
        {line.from === 'bot' && line.ai && <span className="mb-0.5 block text-[11px] font-medium uppercase tracking-wide text-ink-faint">IA</span>}
        <p className="whitespace-pre-wrap break-words">{body}</p>
        {options.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {options.map((o) => (
              <Button key={o.id} disabled={busy} onClick={() => onChoose(o.id, o.title)} className="h-8 px-2.5 text-[13px]">
                {o.title}
              </Button>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

function TestChat() {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [text, setText] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [lines]);

  async function talk(input: { text?: string; replyId?: string }, shown: string) {
    setBusy(true);
    setError('');
    setLines((l) => [...l, { from: 'you', reply: { kind: 'text', body: shown } }]);
    try {
      const digits = phone.replace(/\D/g, '');
      const r = await api<{ replies: Reply[]; handoff: boolean; ai: boolean }>('/admin/whatsapp/bot/test', { method: 'POST', body: { ...input, phone: digits || null } });
      setLines((l) => [
        ...l,
        ...r.replies.map((reply): ChatLine => ({ from: 'bot', reply, ai: r.ai })),
        ...(r.handoff ? [{ from: 'note' as const, text: 'Aqui a conversa iria para a caixa de entrada, e o bot pararia de responder.' }] : []),
      ]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setError('');
    try {
      await api('/admin/whatsapp/bot/test', { method: 'DELETE' });
      setLines([]);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Panel
      title="Chat de teste"
      description="Converse com o bot aqui, sem WhatsApp e sem gastar mensagens. Funciona mesmo com o bot desligado. Com a IA ligada, as respostas dela contam no limite de gasto."
      actions={<Button onClick={reset}>Recomeçar</Button>}
    >
      <Field label="Telefone simulado" hint="Opcional. O bot só mostra pedidos feitos com este telefone, como faria com o cliente de verdade.">
        {(id) => <Input id={id} inputMode="numeric" placeholder="5547999998888" value={phone} onChange={(e) => setPhone(e.target.value)} className="max-w-xs font-mono" />}
      </Field>
      <ol className="mt-3 max-h-[28rem] min-h-32 space-y-2 overflow-y-auto rounded-md border border-line p-3" aria-label="Conversa de teste" aria-live="polite">
        {lines.length === 0 && <li className="text-sm text-ink-faint">Escreva “oi” para começar.</li>}
        {lines.map((line, k) => (
          <Bubble key={k} line={line} busy={busy} onChoose={(id, title) => talk({ replyId: id }, title)} />
        ))}
        <li ref={end} aria-hidden />
      </ol>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (!t) return;
          setText('');
          talk({ text: t }, t);
        }}
        className="mt-2 flex gap-2"
      >
        <Input aria-label="Mensagem" maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Mensagem do cliente" className="flex-1" />
        <Button variant="primary" type="submit" busy={busy} disabled={!text.trim()}>
          Enviar
        </Button>
      </form>
      {error && (
        <div className="mt-2">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
    </Panel>
  );
}

type SecEvent = { at: string; channel: 'whatsapp' | 'teste'; protection: string; outcome: string; categories: string[]; tool: string | null; who: string };
type Security = { byKind: { protection: string; outcome: string; n: number }[]; byCategory: { category: string; n: number }[]; paused: number; recent: SecEvent[] };

const PROTECTION: Record<string, string> = {
  input_guard: 'Filtro de entrada',
  tool_guard: 'Controle de funções',
  output_guard: 'Filtro de resposta',
  model_filter: 'Filtro do Google',
  rate_limit: 'Limite de uso',
  cooldown: 'Pausa de 24 h',
  indirect_guard: 'Dado da loja com instrução',
};
const OUTCOME: Record<string, { label: string; tone: 'bad' | 'warn' | 'neutral' }> = {
  blocked: { label: 'barrado', tone: 'bad' },
  denied: { label: 'negado', tone: 'bad' },
  flagged: { label: 'suspeito', tone: 'warn' },
  redacted: { label: 'corrigido', tone: 'warn' },
  limited: { label: 'limitado', tone: 'neutral' },
};
const CATEGORY: Record<string, string> = {
  override: 'ignorar instruções',
  prompt_extraction: 'pedir instruções internas',
  identity: 'troca de identidade',
  privilege: 'falso administrador',
  jailbreak: 'jailbreak',
  credentials: 'senhas e chaves',
  sql: 'comando SQL',
  code_exec: 'execução de comandos',
  file_access: 'arquivos do servidor',
  tool_manipulation: 'manipular funções',
  data_other: 'dados de outros clientes',
  history_manipulation: 'mexer no histórico',
  write_attempt: 'alterar dados',
  encoding: 'texto codificado',
  overlong: 'mensagem muito longa',
  split: 'ataque dividido',
  not_allowed: 'função inexistente',
  invalid_args: 'dados inválidos na função',
  repeated_denied_calls: 'insistência em funções',
  repeated_attempts: 'tentativas repetidas',
  burst: 'rajada de mensagens',
  secret: 'segredo na resposta',
  prompt_leak: 'cópia das instruções',
  internal: 'detalhe técnico',
  external_link: 'link de fora',
  personal_data: 'dado pessoal',
  too_long: 'resposta longa',
  format: 'formatação',
  empty: 'resposta vazia',
  indirect_injection: 'instrução em dado da loja',
  input_blocked: 'entrada barrada pelo Google',
};
const catLabel = (c: string) => CATEGORY[c] ?? (c.startsWith('gemini:') ? `Google: ${c.slice(7)}` : c);

function OutcomeBadge({ outcome }: { outcome: string }) {
  const o = OUTCOME[outcome];
  return <Badge tone={o?.tone ?? 'neutral'}>{o?.label ?? outcome}</Badge>;
}

function SecurityPanel() {
  const [data, setData] = useState<Security | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api<Security>('/admin/whatsapp/bot/security').then(setData, (e) => setError(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);
  const empty = data !== null && data.byKind.length === 0 && data.recent.length === 0;
  return (
    <Panel
      title="Segurança da IA"
      description="Tentativas de manipular o bot nos últimos 7 dias. Os eventos não guardam o texto nem o telefone do cliente: cada pessoa aparece só como um código."
      actions={
        <Button type="button" onClick={load}>
          Atualizar
        </Button>
      }
    >
      <div className="space-y-4 p-4 sm:p-5">
        {error && <Notice tone="bad">{error}</Notice>}
        {!data && !error && <p className="text-sm text-ink-faint">Carregando…</p>}
        {empty && <p className="text-sm text-ink-soft">Nenhum evento registrado.</p>}
        {data && !empty && (
          <>
            {data.paused > 0 && (
              <Notice tone="warn">
                {data.paused === 1 ? '1 contato está' : `${data.paused} contatos estão`} com a IA pausada por 24 h após tentativas repetidas. Eles continuam recebendo o menu.
              </Notice>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-semibold">Por proteção</h3>
                <ul className="space-y-1 text-sm">
                  {data.byKind.map((k) => (
                    <li key={`${k.protection}-${k.outcome}`} className="flex items-center justify-between gap-2">
                      <span>
                        {PROTECTION[k.protection] ?? k.protection} <OutcomeBadge outcome={k.outcome} />
                      </span>
                      <span className="tabular-nums text-ink-soft">{k.n}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="mb-2 text-sm font-semibold">Por tipo</h3>
                <ul className="space-y-1 text-sm">
                  {data.byCategory.map((c) => (
                    <li key={c.category} className="flex items-center justify-between gap-2">
                      <span>{catLabel(c.category)}</span>
                      <span className="tabular-nums text-ink-soft">{c.n}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Últimos eventos</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-ink-faint">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Quando</th>
                      <th className="py-1 pr-3 font-medium">Proteção</th>
                      <th className="py-1 pr-3 font-medium">Tipo</th>
                      <th className="py-1 pr-3 font-medium">Contato</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((e, i) => (
                      <tr key={i} className="border-t border-line align-top">
                        <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums">{new Date(e.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</td>
                        <td className="py-1.5 pr-3">
                          {PROTECTION[e.protection] ?? e.protection} <OutcomeBadge outcome={e.outcome} />
                        </td>
                        <td className="py-1.5 pr-3">
                          {e.categories.map(catLabel).join(', ')}
                          {e.tool && <span className="text-ink-faint"> ({e.tool})</span>}
                        </td>
                        <td className="py-1.5 pr-3 font-mono text-xs text-ink-soft">
                          {e.who}
                          {e.channel === 'teste' && ' · teste'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

export function BotTab() {
  const { can } = useMe();
  const [data, setData] = useState<BotData | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api<BotData>('/admin/whatsapp/bot').then(setData, (e) => setError(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <p className="text-sm text-ink-faint">Carregando…</p>;
  return (
    <div className="space-y-4">
      <Settings key={JSON.stringify(data.settings)} data={data} reload={load} />
      {can('bot.manage') && <TestChat />}
      {can('bot.manage') && <SecurityPanel />}
    </div>
  );
}
