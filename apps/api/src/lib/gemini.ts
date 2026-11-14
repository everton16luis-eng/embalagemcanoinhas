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
export type AiResult = { parts: AiPart[]; inputTokens: number; outputTokens: number };

export class AiUnavailable extends Error {}

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

  async generate(req: AiRequest): Promise<AiResult> {
    let res;
    try {
      res = await this.fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: req.contents,
          tools: [{ functionDeclarations: req.functions }],
          // Raciocinio no minimo: cada token de raciocinio e cobrado como saida.
          generationConfig: { maxOutputTokens: req.maxOutputTokens, thinkingConfig: { thinkingLevel: 'minimal' } },
        }),
      });
    } catch (err) {
      throw new AiUnavailable(`falha de comunicacao: ${(err as Error).message}`.slice(0, 300));
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
      throw new AiUnavailable(`${res.status}: ${msg}`.slice(0, 300));
    }
    const parts = body?.candidates?.[0]?.content?.parts;
    const u = body?.usageMetadata ?? {};
    return {
      parts: Array.isArray(parts) ? parts : [],
      inputTokens: Number(u.promptTokenCount ?? 0) || 0,
      outputTokens: (Number(u.candidatesTokenCount ?? 0) || 0) + (Number(u.thoughtsTokenCount ?? 0) || 0),
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

  async generate(req: AiRequest): Promise<AiResult> {
    this.requests.push(req);
    if (this.failNext) {
      this.failNext = false;
      throw new AiUnavailable('fora do ar (simulado)');
    }
    const scripted = this.script.shift();
    if (scripted) return scripted;
    const last = req.contents.at(-1)!;
    const usage = { inputTokens: 1000, outputTokens: 100 };
    const answered = last.parts.find((p): p is Extract<AiPart, { functionResponse: unknown }> => 'functionResponse' in p);
    if (answered) return { parts: [{ text: `Resposta simulada com ${answered.functionResponse.name}: ${JSON.stringify(answered.functionResponse.response).slice(0, 300)}` }], ...usage };
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
