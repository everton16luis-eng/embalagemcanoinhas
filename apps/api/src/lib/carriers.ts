import { config, isProduction } from '../config.js';
import { sha256 } from './crypto.js';
import type { Db } from '../db/pool.js';

/**
 * Cotacao de frete por transportadora (docs/08 §2). Provedor proposto: Melhor Envio (endpoint de calculo conferido
 * na documentacao oficial). Compra de frete e etiqueta ficam fora.
 */
export type CarrierItem = { id: string; widthCm: number; heightCm: number; lengthCm: number; weightKg: number; insuranceCents: number; quantity: number };
export type CarrierQuote = { service: string; name: string; company: string | null; priceCents: number; days: number };

export class CarrierError extends Error {}

export interface CarrierProvider {
  readonly name: 'melhorenvio' | 'fake';
  quote(q: { fromCep: string; toCep: string; services: string[]; items: CarrierItem[] }): Promise<CarrierQuote[]>;
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;
const defaultFetch: Fetcher = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8_000) });

const cents = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

export class MelhorEnvioProvider implements CarrierProvider {
  readonly name = 'melhorenvio' as const;
  constructor(
    private readonly c: { token: string; userAgent: string; sandbox: boolean },
    private readonly fetcher: Fetcher = defaultFetch,
  ) {}

  async quote(q: { fromCep: string; toCep: string; services: string[]; items: CarrierItem[] }) {
    const host = this.c.sandbox ? 'https://sandbox.melhorenvio.com.br' : 'https://melhorenvio.com.br';
    let res;
    try {
      res = await this.fetcher(`${host}/api/v2/me/shipment/calculate`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${this.c.token}`, 'user-agent': this.c.userAgent },
        body: JSON.stringify({
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
        }),
      });
    } catch (err) {
      throw new CarrierError(`falha de comunicação: ${(err as Error).message}`);
    }
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (res.status !== 200 || !Array.isArray(body)) throw new CarrierError(`cotação recusada (${res.status}) ${typeof body?.message === 'string' ? body.message.slice(0, 200) : ''}`.trim());
    // Servico indisponivel para o trecho vem sem preco: fica de fora.
    return body.flatMap((s: any): CarrierQuote[] => {
      const price = cents(s?.custom_price ?? s?.price);
      const days = Number(s?.custom_delivery_time ?? s?.delivery_time);
      if (s?.id === undefined || price === null || !Number.isFinite(days)) return [];
      return [{ service: String(s.id), name: String(s.name ?? ''), company: s?.company?.name ? String(s.company.name) : null, priceCents: price, days: Math.max(0, Math.round(days)) }];
    });
  }
}

/** Simulado: preco por peso, prazo fixo por servico. */
export class FakeCarrier implements CarrierProvider {
  readonly name = 'fake' as const;
  calls = 0;
  down = false;
  async quote(q: { services: string[]; items: CarrierItem[] }) {
    this.calls += 1;
    if (this.down) throw new CarrierError('fora do ar (simulado)');
    const kg = q.items.reduce((s, i) => s + i.weightKg * i.quantity, 0);
    return q.services.map((service) => ({
      service,
      name: `Serviço ${service}`,
      company: 'Transportadora simulada',
      priceCents: 1500 + Number(service) * 100 + Math.ceil(kg) * 250,
      days: 2 + (Number(service) % 5),
    }));
  }
}

let active: CarrierProvider | null | undefined;

export function carrierFromConfig(): CarrierProvider | null {
  if (config.MELHOR_ENVIO_TOKEN && config.MELHOR_ENVIO_USER_AGENT) {
    return new MelhorEnvioProvider({ token: config.MELHOR_ENVIO_TOKEN, userAgent: config.MELHOR_ENVIO_USER_AGENT, sandbox: config.MELHOR_ENVIO_SANDBOX });
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
