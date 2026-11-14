// Envio de e-mail pelo SMTP do servidor proprio (porta 587 com STARTTLS obrigatorio). Baseado no envio do portal.
// Nunca lanca: devolve { sent, reason } e quem chama decide. Logs e historico guardam so o dominio do destinatario,
// o assunto e o codigo de erro do servidor; nunca a senha, o texto, links ou tokens.
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

export type MailMessage = { from: string | { name: string; address: string }; to: string; subject: string; text: string; replyTo?: string };
/** O que o envio precisa do nodemailer. Nos testes, um transporte simulado (nunca abre conexao). */
export interface MailTransport {
  sendMail(m: MailMessage): Promise<{ messageId?: string }>;
  verify(): Promise<unknown>;
}
type MailLog = { info: (o: object, m: string) => void; error: (o: object, m: string) => void };

/** Dominio do destinatario (ex.: "***@gmail.com"): o endereco completo nao vai para log nem historico. */
export const maskAddress = (to: string) => `***@${String(to).split('@').pop()}`;
// Respostas do servidor podem citar enderecos: so o dominio fica.
const withoutAddresses = (t: unknown) => String(t ?? '').replace(/[^\s<>"'@]+@([^\s<>"'@]+)/g, '***@$1').slice(0, 300);

/** Endereco do MAIL_FROM sem o nome ("Loja <nao-responda@...>" -> "nao-responda@..."). */
export const addressOf = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim();

export class Mailer {
  private transport: MailTransport | null;
  constructor(
    readonly settings: { host?: string; port: number; secure: boolean; user?: string; from?: string },
    transport: MailTransport | null,
    private log: MailLog,
  ) {
    this.transport = transport;
  }

  get configured() {
    return Boolean(this.settings.host && this.settings.from && this.transport);
  }
  get fromAddress() {
    return this.settings.from ? addressOf(this.settings.from) : null;
  }

  /** Envia texto simples. kind identifica a mensagem no historico (um dos modelos ou outro nome curto). */
  async send(m: { kind: string; to: string; subject: string; text: string; senderName?: string | null; replyTo?: string | null }): Promise<{ sent: boolean; reason?: string }> {
    if (!this.configured) {
      await record(m.kind, m.to, m.subject, 'not_configured');
      return { sent: false, reason: 'O envio de e-mail não está configurado.' };
    }
    // O endereco e sempre o do .env (mesma caixa do login SMTP); o painel muda so o nome exibido.
    const from = m.senderName ? { name: m.senderName, address: this.fromAddress! } : this.settings.from!;
    try {
      const info = await this.transport!.sendMail({ from, to: m.to, subject: m.subject, text: m.text, ...(m.replyTo ? { replyTo: m.replyTo } : {}) });
      this.log.info({ kind: m.kind, to: maskAddress(m.to), id: info.messageId }, 'e-mail enviado');
      await record(m.kind, m.to, m.subject, 'sent');
      return { sent: true };
    } catch (err) {
      const e = err as Error & { code?: string; responseCode?: number };
      this.log.error({ kind: m.kind, to: maskAddress(m.to), code: e.code, response: e.responseCode, err: withoutAddresses(e.message) }, 'falha no envio de e-mail');
      await record(m.kind, m.to, m.subject, 'failed', e);
      return { sent: false, reason: 'O servidor de e-mail recusou ou não respondeu.' };
    }
  }

  /** Confere conexao, STARTTLS e login sem enviar nada. */
  async verify(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.configured) return { ok: false, reason: 'O envio de e-mail não está configurado.' };
    try {
      await this.transport!.verify();
      return { ok: true };
    } catch (err) {
      const e = err as Error & { code?: string; responseCode?: number };
      this.log.error({ code: e.code, response: e.responseCode, err: withoutAddresses(e.message) }, 'falha ao verificar o SMTP');
      return { ok: false, reason: e.code === 'EAUTH' ? 'Usuário ou senha do SMTP recusados.' : 'Não foi possível conectar ao servidor de e-mail.' };
    }
  }
}

async function record(kind: string, to: string, subject: string, status: 'sent' | 'failed' | 'not_configured', err?: Error & { code?: string; responseCode?: number }) {
  try {
    await pool.query('INSERT INTO email_sends (kind, to_domain, subject, status, error_code, error_detail) VALUES ($1, $2, $3, $4, $5, $6)', [
      kind,
      maskAddress(to).slice(0, 300),
      subject.slice(0, 300),
      status,
      err ? String(err.responseCode ?? err.code ?? '').slice(0, 60) || null : null,
      err ? withoutAddresses(err.message) : null,
    ]);
  } catch {
    // O historico e auxiliar: sem ele o envio segue.
  }
}

/** Transporte SMTP do .env, ou nenhum. */
export function smtpTransportFromConfig(): MailTransport | null {
  if (!config.SMTP_HOST || !config.MAIL_FROM) return null;
  return nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    // 465 = TLS desde o inicio; 587 = STARTTLS, exigido antes do login (sem TLS a senha nao sai).
    secure: config.SMTP_SECURE,
    requireTLS: !config.SMTP_SECURE,
    tls: { minVersion: 'TLSv1.2', servername: config.SMTP_HOST },
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS ?? '' } : undefined,
    connectionTimeout: config.SMTP_TIMEOUT_MS,
    greetingTimeout: config.SMTP_TIMEOUT_MS,
    socketTimeout: config.SMTP_TIMEOUT_MS * 2,
  }) as unknown as MailTransport;
}

export const mailSettingsFromConfig = () => ({ host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_SECURE, user: config.SMTP_USER, from: config.MAIL_FROM });

// ---------------- Modelos ----------------
// So as mensagens que a loja realmente envia. Variaveis entre chaves duplas; uma linha cujas variaveis ficaram todas
// vazias some.

export const RESET_VALIDITY = '30 minutos';

type Template = { label: string; description: string; variables: Record<string, string>; required: string[]; subject: string; body: string; example: () => Record<string, string> };

export const TEMPLATES = {
  password_reset: {
    label: 'Redefinição de senha do painel',
    description: 'Enviado quando alguém da equipe usa “Esqueci minha senha” na entrada do painel. O link é de uso único.',
    variables: { nome: 'Nome da pessoa', link: 'Link de redefinição (obrigatório)', validade: 'Validade do link', loja: 'Nome da loja' },
    required: ['link'],
    subject: 'Redefinição de senha — {{loja}}',
    body: 'Olá, {{nome}}.\n\nPara definir uma nova senha de acesso ao painel da {{loja}}, abra o link abaixo (válido por {{validade}}, uso único):\n{{link}}\n\nSe você não pediu a redefinição, ignore esta mensagem: sua senha atual continua valendo.',
    example: () => ({ nome: 'Maria Exemplo', link: `${config.APP_ORIGIN}/painel/redefinir-senha#token=EXEMPLO-SEM-VALIDADE`, validade: RESET_VALIDITY }),
  },
  test: {
    label: 'Teste de envio',
    description: 'Enviado pelo botão “Enviar e-mail de teste”, só para quem pediu.',
    variables: { nome: 'Nome de quem pediu', servidor: 'Servidor de e-mail', data: 'Data e hora do envio', loja: 'Nome da loja' },
    required: [],
    subject: 'Teste de envio — {{loja}}',
    body: 'Olá, {{nome}}.\n\nEste é um e-mail de teste da {{loja}}, enviado pelo servidor {{servidor}} em {{data}}.\nSe ele chegou, o envio de e-mails da loja está funcionando.',
    example: () => ({ nome: 'Maria Exemplo', servidor: config.SMTP_HOST ?? 'servidor de e-mail', data: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) }),
  },
} satisfies Record<string, Template>;
export type TemplateKind = keyof typeof TEMPLATES;
export const isTemplateKind = (k: string): k is TemplateKind => Object.hasOwn(TEMPLATES, k);

const VAR = /\{\{\s*([a-z_]+)\s*\}\}/g;
function fill(text: string, values: Record<string, string>, dropEmptyLines: boolean) {
  return text
    .split('\n')
    .map((line) => {
      const names = [...line.matchAll(VAR)].map((m) => m[1]!);
      if (dropEmptyLines && names.length && names.every((n) => !String(values[n] ?? '').trim())) return null;
      return line.replace(VAR, (_, n: string) => String(values[n] ?? ''));
    })
    .filter((l) => l !== null)
    .join('\n');
}

/** Variaveis usadas no texto que o modelo nao conhece (para recusar antes de salvar). */
export function unknownVariables(kind: TemplateKind, ...texts: string[]) {
  const known: Record<string, string> = TEMPLATES[kind].variables;
  return [...new Set(texts.flatMap((t) => [...t.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1]!)))].filter((n) => !(n in known));
}
export const missingRequired = (kind: TemplateKind, body: string) => TEMPLATES[kind].required.filter((v) => !new RegExp(`\\{\\{\\s*${v}\\s*\\}\\}`).test(body));

export type EmailSettings = { sender_name: string | null; reply_to: string | null; templates: Record<string, { subject: string; body: string }> };
export async function emailSettings(): Promise<EmailSettings> {
  const r = (await pool.query<EmailSettings>('SELECT sender_name, reply_to, templates FROM email_settings')).rows[0];
  return r ?? { sender_name: null, reply_to: null, templates: {} };
}
export async function storeName() {
  return (await pool.query<{ store_name: string | null }>('SELECT store_name FROM store_settings')).rows[0]?.store_name || 'Loja';
}

/** Assunto e texto de um modelo (o salvo no painel, o informado na previa, ou o padrao). */
export async function renderTemplate(kind: TemplateKind, values: Record<string, string>, custom?: { subject: string; body: string } | null) {
  const t = TEMPLATES[kind];
  const saved = custom ?? (await emailSettings()).templates[kind] ?? null;
  const all = { loja: await storeName(), ...values };
  return {
    subject: fill(saved?.subject || t.subject, all, false).replace(/[\r\n]+/g, ' ').trim().slice(0, 250),
    text: fill(saved?.body || t.body, all, true),
  };
}

/** Monta e envia um modelo com o nome do remetente e o Reply-To do painel. */
export async function sendTemplate(mailer: Mailer, kind: TemplateKind, to: string, values: Record<string, string>) {
  const s = await emailSettings();
  const msg = await renderTemplate(kind, values, s.templates[kind] ?? null);
  return mailer.send({ kind, to, subject: msg.subject, text: msg.text, senderName: s.sender_name, replyTo: s.reply_to });
}

/** Link de redefinicao de senha do painel: o token vai no fragmento (#), que o navegador nao envia a servidor nenhum. */
export const resetLink = (token: string) => `${config.APP_ORIGIN}/painel/redefinir-senha#token=${token}`;
