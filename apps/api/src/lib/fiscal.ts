import { randomInt, timingSafeEqual } from 'node:crypto';
import { config, isProduction } from '../config.js';

/**
 * Provedor fiscal (NF-e modelo 55). O provedor transmite a SEFAZ, assina com o certificado A1 da empresa
 * e numera as notas. Contrato da Focus NFe conferido na documentacao oficial: docs/05-fiscal-nfe.md.
 */
export type FiscalEnvironment = 'homologacao' | 'producao';
export type FiscalStatus = 'processing' | 'authorized' | 'rejected' | 'canceled' | 'not_found';
export type FileKind = 'nfe_xml' | 'danfe_pdf' | 'cancel_xml' | 'cce_xml' | 'cce_pdf' | 'inut_xml';

export type FiscalError = { code: string | null; message: string; field: string | null };

export type FiscalResult = {
  status: FiscalStatus;
  sefazStatus: string | null;
  sefazMessage: string | null;
  accessKey: string | null;
  number: string | null;
  series: string | null;
  errors: FiscalError[];
  /** Caminhos de download informados pelo provedor. */
  files: Partial<Record<FileKind, string>>;
};

export type EventResult = {
  ok: boolean;
  sefazStatus: string | null;
  sefazMessage: string | null;
  sequence?: number | null;
  protocol?: string | null;
  errors: FiscalError[];
  files: Partial<Record<FileKind, string>>;
};

/** Erro de comunicacao (rede, 5xx, credencial): nada foi decidido pela SEFAZ. */
export class FiscalTransportError extends Error {}

export interface FiscalProvider {
  readonly name: 'focusnfe' | 'fake';
  /** Ha credencial para o ambiente? Sem ela, a emissao naquele ambiente fica bloqueada. */
  configured(env: FiscalEnvironment): boolean;
  emit(env: FiscalEnvironment, ref: string, payload: Record<string, unknown>): Promise<FiscalResult>;
  get(env: FiscalEnvironment, ref: string): Promise<FiscalResult>;
  cancel(env: FiscalEnvironment, ref: string, justification: string): Promise<EventResult>;
  correct(env: FiscalEnvironment, ref: string, text: string): Promise<EventResult>;
  inutilize(env: FiscalEnvironment, i: { cnpj: string; series: string; start: number; end: number; justification: string }): Promise<EventResult>;
  download(env: FiscalEnvironment, path: string): Promise<Buffer>;
  /** Confere o header de autorizacao do aviso. O corpo nunca e confiavel: so traz a ref para reconsulta. */
  verifyWebhook(headers: Record<string, string | string[] | undefined>): boolean;
}

export const WEBHOOK_HEADER = 'x-fiscal-webhook-token';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const header = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h) ?? '';

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const FOCUS_BASE: Record<FiscalEnvironment, string> = {
  homologacao: 'https://homologacao.focusnfe.com.br',
  producao: 'https://api.focusnfe.com.br',
};

const FOCUS_STATUS: Record<string, FiscalStatus> = {
  processando_autorizacao: 'processing',
  autorizado: 'authorized',
  cancelado: 'canceled',
  erro_autorizacao: 'rejected',
};

const str = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v));
const errorsOf = (d: Record<string, any> | null): FiscalError[] =>
  Array.isArray(d?.erros) ? d!.erros.map((e: any) => ({ code: str(e?.codigo), message: String(e?.mensagem ?? ''), field: str(e?.campo) })) : [];

function focusResult(d: Record<string, any>): FiscalResult {
  const files: FiscalResult['files'] = {};
  if (d.caminho_xml_nota_fiscal) files.nfe_xml = String(d.caminho_xml_nota_fiscal);
  if (d.caminho_danfe) files.danfe_pdf = String(d.caminho_danfe);
  if (d.caminho_xml_cancelamento) files.cancel_xml = String(d.caminho_xml_cancelamento);
  return {
    // Situacao fora da lista documentada: segue como em processamento e a rotina volta a consultar.
    status: FOCUS_STATUS[String(d.status)] ?? 'processing',
    sefazStatus: str(d.status_sefaz),
    sefazMessage: str(d.mensagem_sefaz) ?? (FOCUS_STATUS[String(d.status)] ? null : `Situação do provedor: ${String(d.status)}`),
    accessKey: str(d.chave_nfe)?.replace(/\D/g, '') ?? null,
    number: str(d.numero),
    series: str(d.serie),
    errors: errorsOf(d),
    files,
  };
}

/** Focus NFe, API v2. Autenticacao HTTP Basic: token como usuario, senha vazia. */
export class FocusNfeProvider implements FiscalProvider {
  readonly name = 'focusnfe' as const;
  constructor(
    private readonly tokens: Partial<Record<FiscalEnvironment, string>>,
    private readonly webhookSecret: string | null,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  configured(env: FiscalEnvironment) {
    return Boolean(this.tokens[env]);
  }

  private auth(env: FiscalEnvironment) {
    const token = this.tokens[env];
    if (!token) throw new FiscalTransportError(`Provedor fiscal sem token para ${env}.`);
    return `Basic ${Buffer.from(`${token}:`).toString('base64')}`;
  }

  private async call(env: FiscalEnvironment, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
    let res: Response;
    try {
      res = await this.fetcher(`${FOCUS_BASE[env]}/v2${path}`, {
        method,
        headers: { Authorization: this.auth(env), 'Content-Type': 'application/json', Accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new FiscalTransportError(`Falha de comunicação com o provedor fiscal: ${(err as Error).message}`);
    }
    const data = (await res.json().catch(() => null)) as Record<string, any> | null;
    if (res.status === 401 || res.status === 403) throw new FiscalTransportError('Provedor fiscal recusou a credencial.');
    if (res.status >= 500 || res.status === 429) throw new FiscalTransportError(`Provedor fiscal indisponível (HTTP ${res.status}).`);
    return { status: res.status, data };
  }

  async emit(env: FiscalEnvironment, ref: string, payload: Record<string, unknown>): Promise<FiscalResult> {
    const { status, data } = await this.call(env, 'POST', `/nfe?ref=${encodeURIComponent(ref)}`, payload);
    if (status === 201 || status === 202) return focusResult(data ?? {});
    const code = str(data?.codigo);
    // Ja recebida antes (reenvio da mesma ref): a situacao real vem da consulta.
    if (status === 422 && (code === 'already_processed' || code === 'pending_operation')) return this.get(env, ref);
    if (status === 400 || status === 415 || status === 422) {
      const errors = errorsOf(data);
      return {
        status: 'rejected',
        sefazStatus: null,
        sefazMessage: str(data?.mensagem) ?? `Recusada pelo provedor (HTTP ${status}).`,
        accessKey: null,
        number: null,
        series: null,
        errors: errors.length ? errors : [{ code, message: String(data?.mensagem ?? ''), field: null }],
        files: {},
      };
    }
    throw new FiscalTransportError(`Resposta inesperada do provedor fiscal (HTTP ${status}).`);
  }

  async get(env: FiscalEnvironment, ref: string): Promise<FiscalResult> {
    const { status, data } = await this.call(env, 'GET', `/nfe/${encodeURIComponent(ref)}`);
    if (status === 404) return { status: 'not_found', sefazStatus: null, sefazMessage: null, accessKey: null, number: null, series: null, errors: [], files: {} };
    if (status !== 200 || !data) throw new FiscalTransportError(`Resposta inesperada do provedor fiscal (HTTP ${status}).`);
    return focusResult(data);
  }

  private event(status: number, data: Record<string, any> | null, okStatus: string, files: EventResult['files']): EventResult {
    if (status >= 400 && status !== 422) {
      return { ok: false, sefazStatus: null, sefazMessage: str(data?.mensagem) ?? `HTTP ${status}`, errors: errorsOf(data), files: {} };
    }
    return {
      ok: status === 200 && data?.status === okStatus,
      sefazStatus: str(data?.status_sefaz),
      sefazMessage: str(data?.mensagem_sefaz) ?? str(data?.mensagem),
      sequence: data?.numero_carta_correcao === undefined ? null : Number(data.numero_carta_correcao),
      protocol: str(data?.protocolo_sefaz),
      errors: errorsOf(data),
      files,
    };
  }

  async cancel(env: FiscalEnvironment, ref: string, justification: string) {
    const { status, data } = await this.call(env, 'DELETE', `/nfe/${encodeURIComponent(ref)}`, { justificativa: justification });
    return this.event(status, data, 'cancelado', data?.caminho_xml_cancelamento ? { cancel_xml: String(data.caminho_xml_cancelamento) } : {});
  }

  async correct(env: FiscalEnvironment, ref: string, text: string) {
    const { status, data } = await this.call(env, 'POST', `/nfe/${encodeURIComponent(ref)}/carta_correcao`, { correcao: text });
    const files: EventResult['files'] = {};
    if (data?.caminho_xml_carta_correcao) files.cce_xml = String(data.caminho_xml_carta_correcao);
    if (data?.caminho_pdf_carta_correcao) files.cce_pdf = String(data.caminho_pdf_carta_correcao);
    return this.event(status, data, 'autorizado', files);
  }

  async inutilize(env: FiscalEnvironment, i: { cnpj: string; series: string; start: number; end: number; justification: string }) {
    const { status, data } = await this.call(env, 'POST', '/nfe/inutilizacao', {
      cnpj: i.cnpj,
      serie: i.series,
      numero_inicial: i.start,
      numero_final: i.end,
      justificativa: i.justification,
    });
    return this.event(status, data, 'autorizado', data?.caminho_xml ? { inut_xml: String(data.caminho_xml) } : {});
  }

  /** Baixa um arquivo informado pelo provedor. So endereco https do proprio provedor (nada de URL arbitraria). */
  async download(env: FiscalEnvironment, path: string) {
    const base = new URL(FOCUS_BASE[env]);
    const url = new URL(path, base);
    if (url.protocol !== 'https:' || !(url.hostname === base.hostname || url.hostname.endsWith('.focusnfe.com.br'))) {
      throw new FiscalTransportError(`Arquivo em endereço não reconhecido (${url.hostname}); baixe pelo painel do provedor.`);
    }
    let res: Response;
    try {
      res = await this.fetcher(url, { headers: { Authorization: this.auth(env) }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new FiscalTransportError(`Falha ao baixar arquivo fiscal: ${(err as Error).message}`);
    }
    if (!res.ok) throw new FiscalTransportError(`Arquivo fiscal indisponível (HTTP ${res.status}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_FILE_BYTES) throw new FiscalTransportError('Arquivo fiscal vazio ou grande demais.');
    return buf;
  }

  verifyWebhook(headers: Record<string, string | string[] | undefined>) {
    return Boolean(this.webhookSecret) && safeEqual(header(headers[WEBHOOK_HEADER]), this.webhookSecret!);
  }
}

type FakeDoc = { ref: string; env: FiscalEnvironment; payload: Record<string, unknown>; result: FiscalResult; corrections: number };

/**
 * Provedor simulado para testes e desenvolvimento (FISCAL_FAKE). Nunca usado em producao.
 * Por padrao autoriza na hora; `mode` muda o comportamento da proxima emissao.
 */
export class FakeFiscalProvider implements FiscalProvider {
  readonly name = 'fake' as const;
  readonly docs = new Map<string, FakeDoc>();
  readonly calls: { op: string; ref?: string }[] = [];
  mode: 'authorize' | 'process' | 'reject' | 'network_error' | 'lost' = 'authorize';
  private seq = 0;

  constructor(private readonly webhookSecret = 'segredo-de-teste-do-aviso-fiscal') {}

  configured() {
    return true;
  }

  private authorized(env: FiscalEnvironment, ref: string): FiscalResult {
    this.seq += 1;
    const number = String(this.seq);
    // Chave de 44 digitos so de exemplo (nao e uma chave valida da SEFAZ).
    const key = `42${Array.from({ length: 33 }, () => randomInt(10)).join('')}${number.padStart(9, '0')}`;
    return {
      status: 'authorized',
      sefazStatus: '100',
      sefazMessage: 'Autorizado o uso da NF-e',
      accessKey: key,
      number,
      series: '1',
      errors: [],
      files: { nfe_xml: `/arquivos/${env}/${ref}.xml`, danfe_pdf: `/arquivos/${env}/${ref}.pdf` },
    };
  }

  async emit(env: FiscalEnvironment, ref: string, payload: Record<string, unknown>) {
    this.calls.push({ op: 'emit', ref });
    if (this.mode === 'network_error') throw new FiscalTransportError('rede indisponível (simulado)');
    const existing = this.docs.get(ref);
    if (existing) return existing.result;
    let result: FiscalResult;
    if (this.mode === 'reject') {
      result = { status: 'rejected', sefazStatus: '778', sefazMessage: 'Rejeição: Informado NCM inexistente (simulado)', accessKey: null, number: null, series: null, errors: [], files: {} };
    } else if (this.mode === 'process' || this.mode === 'lost') {
      result = { status: 'processing', sefazStatus: null, sefazMessage: null, accessKey: null, number: null, series: null, errors: [], files: {} };
    } else result = this.authorized(env, ref);
    this.docs.set(ref, { ref, env, payload, result, corrections: 0 });
    // "lost": o provedor recebeu, mas a resposta nao chegou.
    if (this.mode === 'lost') throw new FiscalTransportError('resposta perdida (simulado)');
    return result;
  }

  /** Conclui uma emissao em processamento (como faria a SEFAZ). */
  settle(ref: string, outcome: 'authorize' | 'reject' = 'authorize') {
    const d = this.docs.get(ref);
    if (!d) throw new Error(`ref desconhecida: ${ref}`);
    d.result =
      outcome === 'authorize'
        ? this.authorized(d.env, ref)
        : { status: 'rejected', sefazStatus: '539', sefazMessage: 'Rejeição: Duplicidade de NF-e (simulado)', accessKey: null, number: null, series: null, errors: [], files: {} };
  }

  async get(_env: FiscalEnvironment, ref: string) {
    this.calls.push({ op: 'get', ref });
    if (this.mode === 'network_error') throw new FiscalTransportError('rede indisponível (simulado)');
    return this.docs.get(ref)?.result ?? { status: 'not_found' as const, sefazStatus: null, sefazMessage: null, accessKey: null, number: null, series: null, errors: [], files: {} };
  }

  async cancel(env: FiscalEnvironment, ref: string, _justification: string): Promise<EventResult> {
    this.calls.push({ op: 'cancel', ref });
    const d = this.docs.get(ref);
    if (!d || d.result.status !== 'authorized') return { ok: false, sefazStatus: null, sefazMessage: 'Nota não autorizada.', errors: [], files: {} };
    d.result = { ...d.result, status: 'canceled', sefazStatus: '135', files: { ...d.result.files, cancel_xml: `/arquivos/${env}/${ref}-can.xml` } };
    return { ok: true, sefazStatus: '135', sefazMessage: 'Evento registrado e vinculado a NF-e', errors: [], files: { cancel_xml: `/arquivos/${env}/${ref}-can.xml` } };
  }

  async correct(env: FiscalEnvironment, ref: string, _text: string): Promise<EventResult> {
    this.calls.push({ op: 'correct', ref });
    const d = this.docs.get(ref);
    if (!d || d.result.status !== 'authorized') return { ok: false, sefazStatus: null, sefazMessage: 'Nota não autorizada.', errors: [], files: {} };
    d.corrections += 1;
    return {
      ok: true,
      sefazStatus: '135',
      sefazMessage: 'Evento registrado e vinculado a NF-e',
      sequence: d.corrections,
      errors: [],
      files: { cce_xml: `/arquivos/${env}/${ref}-cce${d.corrections}.xml`, cce_pdf: `/arquivos/${env}/${ref}-cce${d.corrections}.pdf` },
    };
  }

  async inutilize(env: FiscalEnvironment, i: { series: string; start: number; end: number }): Promise<EventResult> {
    this.calls.push({ op: 'inutilize' });
    return { ok: true, sefazStatus: '102', sefazMessage: 'Inutilização de número homologado', protocol: '342000000000001', errors: [], files: { inut_xml: `/arquivos/${env}/inut-${i.series}-${i.start}-${i.end}.xml` } };
  }

  async download(_env: FiscalEnvironment, path: string) {
    return Buffer.from(path.endsWith('.pdf') ? `%PDF-1.4 simulado ${path}` : `<?xml version="1.0"?><simulado caminho="${path}"/>`);
  }

  verifyWebhook(headers: Record<string, string | string[] | undefined>) {
    return safeEqual(header(headers[WEBHOOK_HEADER]), this.webhookSecret);
  }
}

/** Provedor configurado no .env; o simulado so fora de producao. */
export function fiscalProviderFromConfig(): FiscalProvider | null {
  if (config.FOCUS_TOKEN_HOMOLOGACAO || config.FOCUS_TOKEN_PRODUCAO) {
    return new FocusNfeProvider({ homologacao: config.FOCUS_TOKEN_HOMOLOGACAO, producao: config.FOCUS_TOKEN_PRODUCAO }, config.FISCAL_WEBHOOK_SECRET ?? null);
  }
  if (config.FISCAL_FAKE && !isProduction) return new FakeFiscalProvider(config.FISCAL_WEBHOOK_SECRET ?? undefined);
  return null;
}
