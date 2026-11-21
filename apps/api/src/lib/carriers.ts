import { createHmac, timingSafeEqual } from 'node:crypto';
import { config, isProduction } from '../config.js';
import { sha256 } from './crypto.js';
import type { Db } from '../db/pool.js';

/**
 * Provedores de frete (docs/08 §2 e docs/35-sglog-fase8.md). Cada provedor declara o que suporta (capabilities):
 * - Melhor Envio: cotacao (/me/shipment/calculate), rastreio (/me/shipment/tracking) e aviso assinado (X-ME-Signature),
 *   conferidos na documentacao oficial em 21/11/2026. Compra, impressao e cancelamento de etiqueta DESLIGADOS: a API
 *   nao tem chave de idempotencia documentada e a compra so liga com autorizacao expressa (D8-3).
 * - Fake: tudo simulado, inclusive falhas e respostas incertas. Proibido em producao.
 * - Manual (transportadora sem integracao) nao e provedor: codigo, link e custo informados a mao.
 */
export type CarrierItem = { id: string; widthCm: number; heightCm: number; lengthCm: number; weightKg: number; insuranceCents: number; quantity: number };
export type CarrierQuote = { service: string; name: string; company: string | null; priceCents: number; days: number };
export type Volume = { weightG: number; lengthMm: number; widthMm: number; heightMm: number };
export type Address = { cep: string; street: string; number: string; complement: string | null; district: string; city: string; uf: string };
export type LabelRequest = {
  idempotencyKey: string;
  reference: string;
  service: string;
  from: Address;
  to: Address & { name: string; phone: string | null; document: string | null };
  volumes: Volume[];
  insuranceCents: number;
  invoiceKey: string | null;
};
export type LabelResult = { externalId: string; protocol: string | null; trackingCode: string | null; costCents: number | null };
export type TrackStatus = 'posted' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'delivery_failed' | 'returned' | 'canceled' | 'info';
/** key: identificador estavel do evento no provedor (deduplicacao); null = sem deduplicacao (registro manual). */
export type TrackEvent = { status: TrackStatus; at: Date; key: string | null; tracking: string | null; description?: string | null };
export type CancelResult = { result: 'canceled' | 'pending' | 'refused'; refund: 'none' | 'pending' | 'refunded' | 'unknown'; refundCents?: number | null; message?: string };
export type WebhookParsed = { event: string; externalId: string | null; tracking: string | null; events: TrackEvent[] };
export type Capabilities = { quote: boolean; labels: boolean; cancel: boolean; track: boolean; webhook: boolean };

/**
 * kind: 'rejected' = o provedor recusou com clareza (nada cobrado); 'uncertain' = sem resposta clara (pode ter
 * cobrado); 'unavailable' = nem chegou ao provedor. Na compra de etiqueta, so 'rejected' libera nova tentativa.
 */
export class CarrierError extends Error {
  constructor(
    message: string,
    readonly kind: 'rejected' | 'uncertain' | 'unavailable' = 'unavailable',
    readonly httpStatus: number | null = null,
  ) {
    super(message);
  }
}

export interface CarrierProvider {
  readonly name: 'melhorenvio' | 'fake';
  readonly capabilities: Capabilities;
  quote(q: { fromCep: string; toCep: string; services: string[]; items: CarrierItem[] }): Promise<CarrierQuote[]>;
  buyLabel?(req: LabelRequest): Promise<LabelResult>;
  /** Conferir uma compra incerta: a compra, null (o provedor garante que nao existe) ou 'unknown'. */
  findLabel?(q: { idempotencyKey: string; externalId: string | null }): Promise<LabelResult | null | 'unknown'>;
  printLabel?(q: { externalId: string }): Promise<{ url: string }>;
  cancelLabel?(q: { externalId: string }): Promise<CancelResult>;
  track?(externalIds: string[]): Promise<Map<string, TrackEvent[]>>;
  verifyWebhook?(raw: string, headers: Record<string, string | string[] | undefined>): boolean;
  parseWebhook?(body: unknown): WebhookParsed | null;
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;
const defaultFetch: Fetcher = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8_000) });

const cents = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

/** HMAC-SHA256 do corpo com o segredo, em base64, comparado em tempo constante. */
export function hmacOk(raw: string, secret: string | undefined, header: string | string[] | undefined) {
  if (!secret || typeof header !== 'string' || !header) return false;
  const want = createHmac('sha256', secret).update(raw, 'utf8').digest();
  let got: Buffer;
  try {
    got = Buffer.from(header.trim(), 'base64');
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Data do Melhor Envio: ISO com fuso (aviso) ou "AAAA-MM-DD HH:MM:SS" sem fuso (rastreio), lida no horario de Brasilia. */
export function meDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  const d = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? new Date(`${s.replace(' ', 'T')}-03:00`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Eventos a partir das datas do pedido no Melhor Envio. Cada situacao acontece uma vez: a chave e a situacao. */
function meEvents(o: Record<string, unknown>, status: string | null): TrackEvent[] {
  const tracking = typeof o.tracking === 'string' && o.tracking ? o.tracking : null;
  const out: TrackEvent[] = [];
  const posted = meDate(o.posted_at);
  const delivered = meDate(o.delivered_at);
  const canceled = meDate(o.canceled_at);
  if (posted) out.push({ status: 'posted', at: posted, key: 'me:posted', tracking });
  if (delivered) out.push({ status: 'delivered', at: delivered, key: 'me:delivered', tracking });
  if (canceled) out.push({ status: 'canceled', at: canceled, key: 'me:canceled', tracking });
  if (status === 'undelivered' || status === 'not delivered') out.push({ status: 'delivery_failed', at: posted ?? new Date(), key: 'me:undelivered', tracking });
  return out;
}

export class MelhorEnvioProvider implements CarrierProvider {
  readonly name = 'melhorenvio' as const;
  readonly capabilities: Capabilities;
  constructor(
    private readonly c: { token: string; userAgent: string; sandbox: boolean; webhookSecret?: string },
    private readonly fetcher: Fetcher = defaultFetch,
  ) {
    this.capabilities = { quote: true, labels: false, cancel: false, track: true, webhook: Boolean(c.webhookSecret) };
  }

  private get host() {
    return this.c.sandbox ? 'https://sandbox.melhorenvio.com.br' : 'https://melhorenvio.com.br';
  }

  private async call(path: string, payload: unknown) {
    let res;
    try {
      res = await this.fetcher(`${this.host}${path}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${this.c.token}`, 'user-agent': this.c.userAgent },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new CarrierError(`falha de comunicação: ${(err as Error).message}`, 'unavailable');
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

  async quote(q: { fromCep: string; toCep: string; services: string[]; items: CarrierItem[] }) {
    const { status, body } = await this.call('/api/v2/me/shipment/calculate', {
      from: { postal_code: q.fromCep },
      to: { postal_code: q.toCep },
      products: q.items.map((i) => ({
        id: i.id,
        width: i.widthCm,
        height: i.heightCm,
        length: i.lengthCm,
        weight: i.weightKg,
        insurance_value: Math.round(i.insuranceCents) / 100,
        quantity: i.quantity,
      })),
      services: q.services.join(','),
    });
    if (status !== 200 || !Array.isArray(body)) throw new CarrierError(`cotação recusada (${status}) ${typeof body?.message === 'string' ? body.message.slice(0, 200) : ''}`.trim(), 'rejected', status);
    // Servico indisponivel para o trecho vem sem preco: fica de fora.
    return body.flatMap((s: any): CarrierQuote[] => {
      const price = cents(s?.custom_price ?? s?.price);
      const days = Number(s?.custom_delivery_time ?? s?.delivery_time);
      if (s?.id === undefined || price === null || !Number.isFinite(days)) return [];
      return [{ service: String(s.id), name: String(s.name ?? ''), company: s?.company?.name ? String(s.company.name) : null, priceCents: price, days: Math.max(0, Math.round(days)) }];
    });
  }

  /** POST /api/v2/me/shipment/tracking {orders: [id]} -> { [id]: { status, tracking, posted_at, delivered_at, canceled_at, ... } }. */
  async track(externalIds: string[]) {
    const { status, body } = await this.call('/api/v2/me/shipment/tracking', { orders: externalIds });
    if (status !== 200 || !body || typeof body !== 'object') throw new CarrierError(`rastreio recusado (${status})`, status >= 500 ? 'unavailable' : 'rejected', status);
    const out = new Map<string, TrackEvent[]>();
    for (const id of externalIds) {
      const o = body[id];
      if (o && typeof o === 'object') out.set(id, meEvents(o, typeof o.status === 'string' ? o.status : null));
    }
    return out;
  }

  verifyWebhook(raw: string, headers: Record<string, string | string[] | undefined>) {
    return hmacOk(raw, this.c.webhookSecret, headers['x-me-signature']);
  }

  /** { event: 'order.posted', data: { id, status, tracking, posted_at, delivered_at, canceled_at, ... } }. */
  parseWebhook(body: unknown): WebhookParsed | null {
    const b = body as { event?: unknown; data?: Record<string, unknown> } | null;
    if (!b || typeof b.event !== 'string' || !b.data || typeof b.data !== 'object') return null;
    const id = typeof b.data.id === 'string' ? b.data.id : null;
    const event = b.event;
    const status = event === 'order.undelivered' ? 'undelivered' : typeof b.data.status === 'string' ? b.data.status : null;
    return { event, externalId: id, tracking: typeof b.data.tracking === 'string' ? b.data.tracking : null, events: meEvents(b.data, status) };
  }
}

/**
 * Simulado: preco por peso, prazo fixo por servico; etiqueta com modos de falha (recusa, resposta incerta com ou sem
 * compra feita), compras guardadas pela chave de idempotencia, rastreio roteirizado por etiqueta.
 */
export class FakeCarrier implements CarrierProvider {
  readonly name = 'fake' as const;
  readonly capabilities: Capabilities = { quote: true, labels: true, cancel: true, track: true, webhook: true };
  static readonly WEBHOOK_SECRET = 'segredo-do-aviso-simulado';
  calls = 0;
  down = false;
  buyCalls = 0;
  /** ok | reject | uncertain_charged (cobrou e nao respondeu) | uncertain_none (nao cobrou e nao respondeu) */
  labelMode: 'ok' | 'reject' | 'uncertain_charged' | 'uncertain_none' = 'ok';
  /** Reconciliacao: responde 'unknown' enquanto > 0. */
  findUnknown = 0;
  cancelMode: 'ok' | 'pending' | 'refused' = 'ok';
  costDelta = 0;
  purchases = new Map<string, LabelResult>();
  trackScript = new Map<string, TrackEvent[]>();
  trackDown = false;

  async quote(q: { services: string[]; items: CarrierItem[] }) {
    this.calls += 1;
    if (this.down) throw new CarrierError('fora do ar (simulado)', 'unavailable');
    const kg = q.items.reduce((s, i) => s + i.weightKg * i.quantity, 0);
    return q.services.map((service) => ({
      service,
      name: `Serviço ${service}`,
      company: 'Transportadora simulada',
      priceCents: 1500 + Number(service) * 100 + Math.ceil(kg) * 250,
      days: 2 + (Number(service) % 5),
    }));
  }

  async buyLabel(req: LabelRequest) {
    this.buyCalls += 1;
    if (this.labelMode === 'reject') throw new CarrierError('serviço indisponível para o trecho (simulado)', 'rejected', 422);
    const prior = this.purchases.get(req.idempotencyKey);
    if (prior) return prior; // o simulado e idempotente pela chave
    if (this.labelMode === 'uncertain_none') throw new CarrierError('tempo esgotado (simulado)', 'uncertain', null);
    const kg = req.volumes.reduce((s, v) => s + v.weightG, 0) / 1000;
    const res: LabelResult = {
      externalId: `fake-${sha256(req.idempotencyKey).slice(0, 24)}`,
      protocol: `ORD-${this.purchases.size + 1}`,
      trackingCode: `FK${String(this.purchases.size + 1).padStart(9, '0')}BR`,
      costCents: 1500 + Number(req.service) * 100 + Math.ceil(kg) * 250 + this.costDelta,
    };
    this.purchases.set(req.idempotencyKey, res);
    if (this.labelMode === 'uncertain_charged') throw new CarrierError('tempo esgotado depois da cobrança (simulado)', 'uncertain', 504);
    return res;
  }

  async findLabel(q: { idempotencyKey: string }) {
    if (this.findUnknown > 0) {
      this.findUnknown -= 1;
      return 'unknown' as const;
    }
    return this.purchases.get(q.idempotencyKey) ?? null;
  }

  async printLabel(q: { externalId: string }) {
    return { url: `https://transportadora.simulada.invalid/etiquetas/${encodeURIComponent(q.externalId)}.pdf` };
  }

  async cancelLabel() {
    if (this.cancelMode === 'pending') return { result: 'pending' as const, refund: 'pending' as const };
    if (this.cancelMode === 'refused') return { result: 'refused' as const, refund: 'none' as const, message: 'etiqueta já postada (simulado)' };
    return { result: 'canceled' as const, refund: 'pending' as const };
  }

  async track(externalIds: string[]) {
    if (this.trackDown) throw new CarrierError('rastreio fora do ar (simulado)', 'unavailable', 503);
    return new Map(externalIds.map((id) => [id, this.trackScript.get(id) ?? []]));
  }

  verifyWebhook(raw: string, headers: Record<string, string | string[] | undefined>) {
    return hmacOk(raw, FakeCarrier.WEBHOOK_SECRET, headers['x-me-signature']);
  }

  parseWebhook(body: unknown): WebhookParsed | null {
    const b = body as { event?: string; id?: string; status?: TrackStatus; at?: string; tracking?: string } | null;
    if (!b?.event || !b.status || !b.at) return null;
    return { event: b.event, externalId: b.id ?? null, tracking: b.tracking ?? null, events: [{ status: b.status, at: new Date(b.at), key: `fake:${b.status}:${b.at}`, tracking: b.tracking ?? null }] };
  }
}

let active: CarrierProvider | null | undefined;

export function carrierFromConfig(): CarrierProvider | null {
  if (config.MELHOR_ENVIO_TOKEN && config.MELHOR_ENVIO_USER_AGENT) {
    return new MelhorEnvioProvider({
      token: config.MELHOR_ENVIO_TOKEN,
      userAgent: config.MELHOR_ENVIO_USER_AGENT,
      sandbox: config.MELHOR_ENVIO_SANDBOX,
      webhookSecret: config.MELHOR_ENVIO_WEBHOOK_SECRET,
    });
  }
  return config.CARRIER_FAKE && !isProduction ? new FakeCarrier() : null;
}

export const carrierProvider = () => (active === undefined ? (active = carrierFromConfig()) : active);
export const setCarrierProvider = (p: CarrierProvider | null) => void (active = p);

/** CEP de origem: o da empresa (ultima versao do cadastro) ou SHIP_FROM_CEP. */
export async function originCep(db: { query: Db['query'] }) {
  const cep = (await db.query<{ cep: string | null }>('SELECT cep FROM company_profiles ORDER BY version DESC LIMIT 1')).rows[0]?.cep;
  return cep ?? config.SHIP_FROM_CEP ?? null;
}

export type Parcel = { variantId: string; units: string; valueCents: number };

/**
 * Cotacao com cache de 30 min por (origem, destino, servicos, itens). Item sem peso ou medidas: sem cotacao.
 * Provedor fora do ar: lista vazia (a loja mostra so as formas proprias).
 */
export async function cachedCarrierQuotes(db: { query: Db['query'] }, toCep: string, services: string[], parcels: Parcel[]): Promise<CarrierQuote[]> {
  const provider = carrierProvider();
  if (!provider || !services.length || !parcels.length) return [];
  const fromCep = await originCep(db);
  if (!fromCep) return [];
  const dims = (
    await db.query<{ id: string; weight_g: number | null; length_mm: number | null; width_mm: number | null; height_mm: number | null }>(
      'SELECT id, weight_g, length_mm, width_mm, height_mm FROM product_variants WHERE id = ANY($1)',
      [parcels.map((p) => p.variantId)],
    )
  ).rows;
  const items: CarrierItem[] = [];
  for (const p of parcels) {
    const d = dims.find((x) => x.id === p.variantId);
    if (!d?.weight_g || !d.length_mm || !d.width_mm || !d.height_mm) return [];
    const quantity = Math.max(1, Math.ceil(Number(p.units)));
    items.push({
      id: p.variantId,
      widthCm: Math.max(1, Math.ceil(d.width_mm / 10)),
      heightCm: Math.max(1, Math.ceil(d.height_mm / 10)),
      lengthCm: Math.max(1, Math.ceil(d.length_mm / 10)),
      weightKg: Math.max(0.001, d.weight_g / 1000),
      insuranceCents: Math.round(p.valueCents / quantity),
      quantity,
    });
  }
  const sorted = [...new Set(services)].sort();
  const key = sha256(JSON.stringify({ p: provider.name, fromCep, toCep, s: sorted, i: [...items].sort((a, b) => a.id.localeCompare(b.id)) }));
  const hit = (await db.query<{ quotes: CarrierQuote[] }>('SELECT quotes FROM shipping_quote_cache WHERE key = $1 AND expires_at > now()', [key])).rows[0];
  if (hit) return hit.quotes;
  let quotes: CarrierQuote[];
  try {
    quotes = await provider.quote({ fromCep, toCep, services: sorted, items });
  } catch {
    return [];
  }
  await db.query(
    `INSERT INTO shipping_quote_cache (key, quotes, expires_at) VALUES ($1, $2, now() + interval '30 minutes')
     ON CONFLICT (key) DO UPDATE SET quotes = EXCLUDED.quotes, expires_at = EXCLUDED.expires_at`,
    [key, JSON.stringify(quotes)],
  );
  // Limpeza oportunista das cotacoes vencidas.
  await db.query(`DELETE FROM shipping_quote_cache WHERE expires_at < now() - interval '1 day'`);
  return quotes;
}
