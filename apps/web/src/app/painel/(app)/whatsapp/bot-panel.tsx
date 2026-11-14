'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useMe } from '@/components/shell';
import { Badge, Button, Field, Input, Notice, Panel, Textarea } from '@/components/ui';
import { api } from '@/lib/api';

type Day = { open: string; close: string } | null;
type Audience = 'off' | 'test' | 'all';
type Mode = 'menu' | 'ai' | 'menu_ai';
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
  };
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
          {(['menu', 'menu_ai', 'ai'] as const).map((m) => (
            <label key={m} className="flex min-h-9 items-start gap-2 text-sm">
              <input type="radio" name="mode" className="mt-1" checked={mode === m} onChange={() => setMode(m)} />
              <span>
                {MODES[m].label}
                <span className="block text-[13px] text-ink-faint">{MODES[m].hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {mode !== 'menu' && (
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

        {(audience === 'test' || (mode !== 'menu' && aiPlan === 'free')) && (
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
    </div>
  );
}
