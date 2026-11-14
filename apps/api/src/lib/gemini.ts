import { config, isProduction } from '../config.js';

/**
 * Gemini API, rota generateContent (docs/10 §4.4). Contrato conferido na documentacao oficial em 14/11/2026:
 * POST https://generativelanguage.googleapis.com/v1beta/models/{modelo}:generateContent, chave no cabecalho
 * x-goog-api-key; funcoes em tools[].functionDeclarations; a chamada volta como parte functionCall com
 * thoughtSignature, que precisa voltar igual no historico (sem ela, os modelos 3.x recusam com 400);
 * o resultado vai numa parte functionResponse {name, response}. Uso em usageMetadata (promptTokenCount,
 * candidatesTokenCount, thoughtsTokenCount). Nada disso foi exercitado contra a API real ainda.
 */
export type AiPart =
  | { text: string; thoughtSignature?: string }
  | { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown> } };
export type AiContent = { role: 'user' | 'model'; parts: AiPart[] };
export type AiFunction = { name: string; description: string; parameters: Record<string, unknown> };
export type AiRequest = { system: string; contents: AiContent[]; functions: AiFunction[]; maxOutputTokens: number };
/**
 * finishReason: candidates[0].finishReason (STOP, MAX_TOKENS, SAFETY, ...). blockReason: promptFeedback.blockReason,
 * quando a propria entrada foi barrada pelos filtros do Google (sem candidato).
 */
export type AiResult = { parts: AiPart[]; inputTokens: number; outputTokens: number; finishReason?: string | null; blockReason?: string | null };

export class AiUnavailable extends Error {}
/** O Google recusou a entrada pelos filtros dele (HTTP 400 com motivo de seguranca). */
export class AiBlocked extends Error {}

/** Motivos de termino (documentacao de generateContent, 14/11/2026) agrupados para o bot. */
export const FINISH_BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'JAILBREAK']);
export const FINISH_INVALID = new Set(['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS', 'MISSING_THOUGHT_SIGNATURE', 'MALFORMED_RESPONSE', 'OTHER', 'FINISH_REASON_UNSPECIFIED']);

/**
 * Filtros do Google (safetySettings). Nao substituem as protecoes da loja: sao mais uma camada. A categoria de
 * jailbreak e recente; se o modelo recusar a configuracao, a chamada repete sem ela (e o servidor lembra).
 */
const BASE_SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
];
const JAILBREAK_SAFETY = { category: 'HARM_CATEGORY_JAILBREAK', threshold: 'BLOCK_MEDIUM_AND_ABOVE' };

/** Segredos do .env que nunca podem aparecer em resposta, erro gravado ou log. */
export function knownSecrets(): string[] {
  const c = config as Record<string, unknown>;
  return [
    'GEMINI_API_KEY',
    'WA_ACCESS_TOKEN',
    'WA_APP_SECRET',
    'WA_VERIFY_TOKEN',
    'ENC_KEY',
    'APP_DB_PASSWORD',
    'MP_ACCESS_TOKEN',
    'MP_WEBHOOK_SECRET',
    'FOCUS_TOKEN_HOMOLOGACAO',
    'FOCUS_TOKEN_PRODUCAO',
    'FISCAL_WEBHOOK_SECRET',
    'ML_CLIENT_SECRET',
    'SHOPEE_PARTNER_KEY',
    'MELHOR_ENVIO_TOKEN',
    'SMTP_PASS',
  ]
    .map((k) => c[k])
    .filter((v): v is string => typeof v === 'string' && v.length >= 8);
}

export interface AiProvider {
  readonly fake: boolean;
  readonly model: string;
  generate(req: AiRequest): Promise<AiResult>;
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; text(): Promise<string> }>;
const defaultFetch: Fetcher = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });

export class GeminiProvider implements AiProvider {
  readonly fake = false;
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly fetcher: Fetcher = defaultFetch,
  ) {}

  /** O modelo aceitou HARM_CATEGORY_JAILBREAK? (null = ainda nao se sabe) */
  private jailbreakFilter: boolean | null = null;

  async generate(req: AiRequest): Promise<AiResult> {
    try {
      return await this.call(req, this.jailbreakFilter !== false);
    } catch (err) {
      // Configuracao recusada por causa da categoria nova: repete sem ela uma vez e guarda a decisao.
      if (err instanceof AiUnavailable && this.jailbreakFilter === null && /JAILBREAK|safety_?settings|HarmCategory/i.test(err.message)) {
        this.jailbreakFilter = false;
        return this.call(req, false);
      }
      throw err;
    }
  }

  private async call(req: AiRequest, withJailbreak: boolean): Promise<AiResult> {
    let res;
    try {
      res = await this.fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: req.contents,
          tools: [{ functionDeclarations: req.functions }],
          // AUTO (padrao estavel): o modelo escolhe texto ou funcao. Quem decide se a funcao roda e o servidor.
          toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
          safetySettings: withJailbreak ? [...BASE_SAFETY, JAILBREAK_SAFETY] : BASE_SAFETY,
          // Raciocinio no minimo: cada token de raciocinio e cobrado como saida.
          generationConfig: { maxOutputTokens: req.maxOutputTokens, candidateCount: 1, thinkingConfig: { thinkingLevel: 'minimal' } },
        }),
      });
    } catch (err) {
      // Mensagem curta e sem detalhes de rede (endereco, cabecalhos).
      throw new AiUnavailable(`falha de comunicacao: ${(err as Error).name === 'TimeoutError' ? 'tempo esgotado' : 'sem resposta'}`);
    }
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (res.status < 200 || res.status >= 300) {
      const msg = typeof body?.error?.message === 'string' ? body.error.message : `HTTP ${res.status}`;
      const clean = `${res.status}: ${msg}`.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[segredo]').slice(0, 300);
      // Entrada barrada pelos filtros do Google (codigos safety/jailbreak/prohibited/blocklist).
      if (res.status === 400 && /input blocked|\b(safety|jailbreak|prohibited_content|blocklist)\b/i.test(msg) && !/safety_?settings|HarmCategory/i.test(msg)) throw new AiBlocked(clean);
      throw new AiUnavailable(clean);
    }
    if (withJailbreak && this.jailbreakFilter === null) this.jailbreakFilter = true;
    const cand = body?.candidates?.[0];
    const parts = cand?.content?.parts;
    const u = body?.usageMetadata ?? {};
    return {
      parts: Array.isArray(parts) ? parts : [],
      inputTokens: Number(u.promptTokenCount ?? 0) || 0,
      outputTokens: (Number(u.candidatesTokenCount ?? 0) || 0) + (Number(u.thoughtsTokenCount ?? 0) || 0),
      finishReason: typeof cand?.finishReason === 'string' ? cand.finishReason.slice(0, 40) : null,
      blockReason: typeof body?.promptFeedback?.blockReason === 'string' ? body.promptFeedback.blockReason.slice(0, 40) : null,
    };
  }
}

/**
 * Simulado (desenvolvimento e testes). Sem roteiro: numero no texto vira consulta de pedido, "atendente" transfere,
 * "copo"/"produto" busca produtos e o resto recebe uma resposta fixa. Com roteiro (script), devolve na ordem.
 */
export class FakeAi implements AiProvider {
  readonly fake = true;
  readonly model = 'simulado';
  requests: AiRequest[] = [];
  script: AiResult[] = [];
  failNext = false;
  /** Proxima chamada lanca este erro (testes de vazamento por mensagem de erro). */
  throwNext: Error | null = null;

  async generate(req: AiRequest): Promise<AiResult> {
    this.requests.push(req);
    if (this.throwNext) {
      const e = this.throwNext;
      this.throwNext = null;
      throw e;
    }
    if (this.failNext) {
      this.failNext = false;
      throw new AiUnavailable('fora do ar (simulado)');
    }
    const scripted = this.script.shift();
    if (scripted) return scripted;
    const last = req.contents.at(-1)!;
    const usage = { inputTokens: 1000, outputTokens: 100 };
    const answered = last.parts.find((p): p is Extract<AiPart, { functionResponse: unknown }> => 'functionResponse' in p);
    if (answered) return { parts: [{ text: `Resposta simulada com os dados: ${JSON.stringify(answered.functionResponse.response).slice(0, 300)}` }], ...usage };
    const text = last.parts.map((p) => ('text' in p ? p.text : '')).join(' ');
    const number = text.match(/\b\d{3,9}\b/)?.[0];
    const call = (name: string, args: Record<string, unknown>): AiResult => ({ parts: [{ functionCall: { name, args }, thoughtSignature: 'assinatura-simulada' }], ...usage });
    if (/atendente/i.test(text)) return call('transferir_atendente', { motivo: 'pedido do cliente' });
    if (number) return call('consultar_pedido', { numero: Number(number) });
    if (/copo|produto|embalagem|forminha/i.test(text)) return call('buscar_produtos', { termo: text.slice(0, 60) });
    return { parts: [{ text: 'Resposta simulada da IA.' }], ...usage };
  }
}

export function aiFromConfig(): AiProvider | null {
  if (config.GEMINI_API_KEY) return new GeminiProvider(config.GEMINI_API_KEY, config.GEMINI_MODEL);
  return config.GEMINI_FAKE && !isProduction ? new FakeAi() : null;
}

/** Custo estimado em US$ pelos precos do .env (por milhao de tokens). */
export const aiCost = (inputTokens: number, outputTokens: number) =>
  (inputTokens * config.GEMINI_PRICE_INPUT_PER_M + outputTokens * config.GEMINI_PRICE_OUTPUT_PER_M) / 1_000_000;
