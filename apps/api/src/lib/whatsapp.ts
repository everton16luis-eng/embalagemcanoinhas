import { createHmac } from 'node:crypto';
import { config, isProduction } from '../config.js';
import { safeEqual } from './fiscal.js';

/**
 * WhatsApp Cloud API (Meta). Contrato conferido na documentacao oficial: docs/08 §1.
 * Nada daqui foi exercitado contra a API real ainda (TESTES-PENDENTES).
 */
export type TemplateSend = { to: string; name: string; language: string; params: Record<string, string> };
export type SendResult = { wamid: string };

/**
 * Mensagem interativa. Limites da documentacao oficial (interactive-reply-buttons-messages e
 * interactive-list-messages, conferidos em 14/11/2026): ate 3 botoes com titulo de 20 caracteres e corpo de 1024;
 * lista com ate 10 linhas, titulo da linha 24, descricao 72, botao 20, corpo 4096, rodape 60.
 */
export type Interactive =
  | { type: 'button'; body: string; footer?: string; buttons: { id: string; title: string }[] }
  | { type: 'list'; body: string; footer?: string; button: string; rows: { id: string; title: string; description?: string }[] };

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** Objeto "interactive" da Cloud API, cortando cada texto no limite da Meta. */
export function interactivePayload(i: Interactive): Record<string, unknown> {
  const footer = i.footer ? { footer: { text: cut(i.footer, 60) } } : {};
  if (i.type === 'button') {
    if (i.buttons.length < 1 || i.buttons.length > 3) throw new Error('mensagem com botoes: de 1 a 3 botoes');
    return {
      type: 'button',
      body: { text: cut(i.body, 1024) },
      ...footer,
      action: { buttons: i.buttons.map((b) => ({ type: 'reply', reply: { id: b.id.slice(0, 256), title: cut(b.title, 20) } })) },
    };
  }
  if (i.rows.length < 1 || i.rows.length > 10) throw new Error('lista: de 1 a 10 linhas');
  return {
    type: 'list',
    body: { text: cut(i.body, 4096) },
    ...footer,
    action: {
      button: cut(i.button, 20),
      sections: [{ title: 'Opções', rows: i.rows.map((r) => ({ id: r.id.slice(0, 200), title: cut(r.title, 24), ...(r.description ? { description: cut(r.description, 72) } : {}) })) }],
    },
  };
}

/** Texto legivel da mensagem interativa, para a caixa de entrada do painel. */
export function interactiveSummary(i: Interactive) {
  const opts = i.type === 'button' ? i.buttons.map((b) => b.title) : i.rows.map((r) => r.title);
  return `${i.body}\n${opts.map((o) => `[${o}]`).join(' ')}`.slice(0, 4096);
}

/** Recusa definitiva (numero invalido, modelo inexistente): nao adianta tentar de novo. */
export class WhatsAppRejected extends Error {}
/** Rede, 5xx, limite: tenta de novo mais tarde. */
export class WhatsAppTransient extends Error {}

export interface WhatsAppProvider {
  readonly fake: boolean;
  sendTemplate(m: TemplateSend): Promise<SendResult>;
  sendText(to: string, body: string): Promise<SendResult>;
  sendInteractive(to: string, i: Interactive): Promise<SendResult>;
  showTyping?(messageId: string): Promise<void>;
  /** X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, corpo cru). */
  verifySignature(rawBody: string, header: string | undefined): boolean;
  /** Verificacao do webhook (GET): devolve o challenge se o token confere. */
  verifyChallenge(q: Record<string, unknown>): string | null;
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;
const defaultFetch: Fetcher = (url, init) => fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(15_000) });

/** Telefone do cadastro (DDD + numero) no formato internacional sem sinais. Sem DDD valido: null. */
export function toWhatsAppNumber(phone: string | null | undefined) {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (/^55\d{10,11}$/.test(d)) return d;
  if (/^\d{10,11}$/.test(d)) return `55${d}`;
  return null;
}

function challenge(verifyToken: string | undefined, q: Record<string, unknown>) {
  if (!verifyToken) return null;
  const mode = q['hub.mode'];
  const token = q['hub.verify_token'];
  const ch = q['hub.challenge'];
  if (mode !== 'subscribe' || typeof token !== 'string' || typeof ch !== 'string' || ch.length > 200) return null;
  return safeEqual(token, verifyToken) ? ch : null;
}

function signatureOk(secret: string, raw: string, header: string | undefined) {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  return safeEqual(expected, header.slice(7).trim().toLowerCase());
}

export class CloudApiProvider implements WhatsAppProvider {
  readonly fake = false;
  constructor(
    private readonly c: { phoneNumberId: string; accessToken: string; appSecret: string; verifyToken: string; version: string },
    private readonly fetcher: Fetcher = defaultFetch,
  ) {}

  private async post(payload: Record<string, unknown>, signal?: AbortSignal) {
    let res;
    try {
      res = await this.fetcher(`https://graph.facebook.com/${this.c.version}/${this.c.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.c.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
        signal,
      });
    } catch (err) {
      throw new WhatsAppTransient(`falha de comunicacao: ${(err as Error).message}`);
    }
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const msg = typeof body?.error?.message === 'string' ? body.error.message.slice(0, 300) : `HTTP ${res.status}`;
    if (res.status === 429 || res.status >= 500) throw new WhatsAppTransient(msg);
    if (res.status === 401) throw new WhatsAppTransient(`token recusado: ${msg}`); // credencial e problema nosso: espera corrigir
    if (res.status < 200 || res.status >= 300) throw new WhatsAppRejected(msg);
    return body;
  }

  private async send(payload: Record<string, unknown>): Promise<SendResult> {
    const body = await this.post({ recipient_type: 'individual', ...payload });
    const wamid = body?.messages?.[0]?.id;
    if (typeof wamid !== 'string') throw new WhatsAppTransient('resposta sem id da mensagem');
    return { wamid };
  }

  sendTemplate(m: TemplateSend) {
    const parameters = Object.entries(m.params).map(([parameter_name, text]) => ({ type: 'text', parameter_name, text }));
    return this.send({
      to: m.to,
      type: 'template',
      template: { name: m.name, language: { code: m.language }, ...(parameters.length ? { components: [{ type: 'body', parameters }] } : {}) },
    });
  }

  sendText(to: string, body: string) {
    return this.send({ to, type: 'text', text: { preview_url: false, body } });
  }

  sendInteractive(to: string, i: Interactive) {
    return this.send({ to, type: 'interactive', interactive: interactivePayload(i) });
  }

  async showTyping(messageId: string) {
    await this.post({ status: 'read', message_id: messageId, typing_indicator: { type: 'text' } }, AbortSignal.timeout(2_000));
  }

  verifySignature(raw: string, header: string | undefined) {
    return signatureOk(this.c.appSecret, raw, header);
  }

  verifyChallenge(q: Record<string, unknown>) {
    return challenge(this.c.verifyToken, q);
  }
}

/** Simulado: guarda o que seria enviado. Assinatura com segredo fixo de teste. */
export class FakeWhatsApp implements WhatsAppProvider {
  readonly fake = true;
  static readonly SECRET = 'segredo-de-teste-do-whatsapp';
  static readonly VERIFY = 'verificacao-de-teste';
  sent: ({ kind: 'template' } & TemplateSend | { kind: 'text'; to: string; body: string } | { kind: 'interactive'; to: string; interactive: Record<string, unknown> })[] = [];
  failNext: 'reject' | 'transient' | null = null;
  private n = 0;

  private next(): SendResult {
    const f = this.failNext;
    this.failNext = null;
    if (f === 'reject') throw new WhatsAppRejected('numero nao e WhatsApp (simulado)');
    if (f === 'transient') throw new WhatsAppTransient('fora do ar (simulado)');
    this.n += 1;
    return { wamid: `wamid.fake${Date.now()}${this.n}` };
  }

  async sendTemplate(m: TemplateSend) {
    const r = this.next();
    this.sent.push({ kind: 'template', ...m });
    return r;
  }

  async sendText(to: string, body: string) {
    const r = this.next();
    this.sent.push({ kind: 'text', to, body });
    return r;
  }

  async sendInteractive(to: string, i: Interactive) {
    const interactive = interactivePayload(i);
    const r = this.next();
    this.sent.push({ kind: 'interactive', to, interactive });
    return r;
  }

  verifySignature(raw: string, header: string | undefined) {
    return signatureOk(FakeWhatsApp.SECRET, raw, header);
  }

  verifyChallenge(q: Record<string, unknown>) {
    return challenge(FakeWhatsApp.VERIFY, q);
  }
}

export function whatsappFromConfig(): WhatsAppProvider | null {
  if (config.WA_PHONE_NUMBER_ID && config.WA_ACCESS_TOKEN && config.WA_APP_SECRET && config.WA_VERIFY_TOKEN) {
    return new CloudApiProvider({
      phoneNumberId: config.WA_PHONE_NUMBER_ID,
      accessToken: config.WA_ACCESS_TOKEN,
      appSecret: config.WA_APP_SECRET,
      verifyToken: config.WA_VERIFY_TOKEN,
      version: config.WA_GRAPH_VERSION,
    });
  }
  return config.WHATSAPP_FAKE && !isProduction ? new FakeWhatsApp() : null;
}
