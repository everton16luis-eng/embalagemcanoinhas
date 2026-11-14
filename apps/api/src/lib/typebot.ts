import { config, isProduction } from '../config.js';

/**
 * API de conversa do Typebot (docs/11-typebot.md). Contrato conferido em docs.typebot.com/api-reference/chat em
 * 14/11/2026:
 * - POST {base}/v1/typebots/{publicId}/startChat {prefilledVariables, textBubbleContentFormat} -> {sessionId, messages, input}
 * - POST {base}/v1/sessions/{sessionId}/continueChat {message: {type: 'text', text}} -> {messages, input}
 * messages[]: {type: 'text', content: {type: 'markdown', markdown}} | {type: 'image', content: {url}} | ...
 * input: {type: 'choice input', items: [{id, content, value}]} | {type: 'text input', ...}. Sem input: o fluxo acabou.
 * Nada disso foi exercitado contra um Typebot real ainda.
 */
export type TbChoice = { id: string; content: string; value: string | null };
export type TbTurn = { sessionId: string; texts: string[]; choices: TbChoice[] | null; ended: boolean };

export class TypebotUnavailable extends Error {}
/** Sessao que o Typebot nao conhece mais (expirou ou o fluxo foi trocado). */
export class TypebotSessionGone extends Error {}

export interface TypebotProvider {
  readonly fake: boolean;
  start(publicId: string, variables: Record<string, string>): Promise<TbTurn>;
  continue(sessionId: string, text: string): Promise<TbTurn>;
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; text(): Promise<string> }>;
const defaultFetch: Fetcher = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });

/** Markdown do Typebot para a formatacao do WhatsApp (*negrito*, _italico_, ~riscado~). */
export function markdownToWhatsApp(md: string) {
  // Negrito vai para um marcador antes, para o italico (*x*) nao pegar o negrito ja convertido.
  return md
    .replace(/\*\*(.+?)\*\*/g, '\u0001$1\u0001')
    .replace(/__(.+?)__/g, '\u0001$1\u0001')
    .replace(/\*([^*\n]+)\*/g, '_$1_')
    .replace(/\u0001/g, '*')
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1: $2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, '$1')
    .trim();
}

function parseTurn(body: any, sessionId: string): TbTurn {
  const texts: string[] = [];
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (m?.type === 'text' && typeof m.content?.markdown === 'string') {
      const t = markdownToWhatsApp(m.content.markdown);
      if (t) texts.push(t);
    } else if ((m?.type === 'image' || m?.type === 'video' || m?.type === 'audio' || m?.type === 'embed') && typeof m.content?.url === 'string') {
      texts.push(m.content.url);
    }
  }
  const input = body?.input;
  const choices =
    input?.type === 'choice input' && Array.isArray(input.items)
      ? input.items
          .filter((i: any) => typeof i?.id === 'string' && typeof i.content === 'string' && i.content.trim())
          .map((i: any) => ({ id: i.id, content: i.content.trim(), value: typeof i.value === 'string' && i.value.trim() ? i.value.trim() : null }))
      : null;
  return { sessionId, texts, choices: choices?.length ? choices : null, ended: !input };
}

export class HttpTypebot implements TypebotProvider {
  readonly fake = false;
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: Fetcher = defaultFetch,
  ) {}

  private async post(path: string, payload: unknown) {
    let res;
    try {
      res = await this.fetcher(`${this.baseUrl.replace(/\/+$/, '')}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    } catch (err) {
      throw new TypebotUnavailable(`falha de comunicacao: ${(err as Error).message}`.slice(0, 300));
    }
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  async start(publicId: string, variables: Record<string, string>) {
    const r = await this.post(`/v1/typebots/${encodeURIComponent(publicId)}/startChat`, { prefilledVariables: variables, textBubbleContentFormat: 'markdown' });
    if (r.status < 200 || r.status >= 300 || typeof r.body?.sessionId !== 'string') throw new TypebotUnavailable(`${r.status}: ${String(r.body?.message ?? 'resposta inesperada').slice(0, 200)}`);
    return parseTurn(r.body, r.body.sessionId);
  }

  async continue(sessionId: string, text: string) {
    const r = await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/continueChat`, { message: { type: 'text', text }, textBubbleContentFormat: 'markdown' });
    if (r.status === 404 || r.status === 400) throw new TypebotSessionGone(`${r.status}`);
    if (r.status < 200 || r.status >= 300) throw new TypebotUnavailable(`${r.status}: ${String(r.body?.message ?? '').slice(0, 200)}`);
    return parseTurn(r.body, sessionId);
  }
}

/**
 * Simulado: um fluxo pequeno. Inicio: saudacao + botoes (Ver produtos, Acompanhar pedido = valor "pedido", Falar com
 * atendente = valor "atendente"). "Ver produtos" pede o produto (texto) e encerra com uma resposta.
 */
export class FakeTypebot implements TypebotProvider {
  readonly fake = true;
  calls: { op: 'start' | 'continue'; arg: string; extra: unknown }[] = [];
  failNext = false;
  sessions = new Map<string, string>();
  /** Opcoes a mais no inicio (testes dos valores reservados). */
  extraChoices: TbChoice[] = [];
  private n = 0;

  private check() {
    if (this.failNext) {
      this.failNext = false;
      throw new TypebotUnavailable('fora do ar (simulado)');
    }
  }

  async start(publicId: string, variables: Record<string, string>) {
    this.calls.push({ op: 'start', arg: publicId, extra: variables });
    this.check();
    const sessionId = `sessao-${++this.n}`;
    this.sessions.set(sessionId, 'inicio');
    return {
      sessionId,
      texts: [`Olá${variables.nome ? `, ${variables.nome}` : ''}! Fluxo simulado do Typebot.`],
      choices: [
        { id: 'c1', content: 'Ver produtos', value: null },
        { id: 'c2', content: 'Acompanhar pedido', value: 'pedido' },
        { id: 'c3', content: 'Falar com atendente', value: 'atendente' },
        ...this.extraChoices,
      ],
      ended: false,
    };
  }

  async continue(sessionId: string, text: string) {
    this.calls.push({ op: 'continue', arg: sessionId, extra: text });
    this.check();
    const at = this.sessions.get(sessionId);
    if (!at) throw new TypebotSessionGone('404');
    if (at === 'inicio' && text === 'Ver produtos') {
      this.sessions.set(sessionId, 'produto');
      return { sessionId, texts: ['Qual produto você procura?'], choices: null, ended: false };
    }
    if (at === 'produto') {
      this.sessions.delete(sessionId);
      return { sessionId, texts: [markdownToWhatsApp(`Anotado: ${text}. Veja na loja **virtual**.`)], choices: null, ended: true };
    }
    return { sessionId, texts: ['Escolha uma das opções.'], choices: [{ id: 'c1', content: 'Ver produtos', value: null }], ended: false };
  }
}

export function typebotFromConfig(): TypebotProvider | null {
  if (config.TYPEBOT_API_URL) return new HttpTypebot(config.TYPEBOT_API_URL);
  return config.TYPEBOT_FAKE && !isProduction ? new FakeTypebot() : null;
}
