import { createHash, createHmac, randomBytes } from 'node:crypto';
import { config, isProduction } from '../config.js';
import { safeEqual } from './fiscal.js';

/**
 * Adaptadores do Mercado Livre e da Shopee. Endpoints, campos e prazos conferidos na documentacao oficial
 * (docs/07-marketplaces.md). Nada daqui foi exercitado contra as APIs reais ainda: ver docs/TESTES-PENDENTES.md.
 */
export type Channel = 'mercadolivre' | 'shopee';
export const CHANNELS: readonly Channel[] = ['mercadolivre', 'shopee'];
export const CHANNEL_NAME: Record<Channel, string> = { mercadolivre: 'Mercado Livre', shopee: 'Shopee' };

export type Tokens = {
  externalId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date | null;
};

/** Situacao da venda reduzida ao que importa para nos. */
export type SaleStatus = 'paid' | 'pending' | 'canceled' | 'other';

export type MarketOrder = {
  externalId: string;
  status: SaleStatus;
  rawStatus: string;
  items: { itemId: string; variationId: string; sku: string | null; title: string | null; quantity: number; unitPriceCents: number }[];
  totalCents: number | null;
};

export type AccountAuth = { externalId: string; accessToken: string };

/** Credencial recusada (token revogado, refresh vencido): a conta precisa ser autorizada de novo. */
export class MarketplaceAuthError extends Error {}
/** Erro da plataforma ou de rede: tenta de novo mais tarde. */
export class MarketplaceError extends Error {}

export interface MarketplaceAdapter {
  readonly channel: Channel;
  readonly fake: boolean;
  /** Mercado Livre usa PKCE; Shopee nao. */
  readonly usesPkce: boolean;
  /** Anuncio com variacao pode receber saldo automatico? (ML: nao, ver docs/07 §4) */
  readonly stockForVariations: boolean;
  authorizeUrl(state: string, codeChallenge: string | null): string;
  exchangeCode(p: { code: string; codeVerifier: string | null; shopId: string | null }): Promise<Tokens>;
  refresh(p: { externalId: string; refreshToken: string }): Promise<Tokens>;
  getOrder(auth: AccountAuth, orderId: string): Promise<MarketOrder>;
  pushStock(auth: AccountAuth, listing: { itemId: string; variationId: string }, qty: number): Promise<void>;
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;
const defaultFetch: Fetcher = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });

export const pkce = () => {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

const toCents = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) throw new MarketplaceError('valor invalido na resposta da plataforma');
  return Math.round(n * 100);
};
const str = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v));

async function call(fetcher: Fetcher, url: string, init: Parameters<Fetcher>[1]) {
  let res;
  try {
    res = await fetcher(url, init);
  } catch (err) {
    throw new MarketplaceError(`falha de comunicacao: ${(err as Error).message}`);
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// ---------------- Mercado Livre ----------------

const ML_AUTH = 'https://auth.mercadolivre.com.br/authorization';
const ML_API = 'https://api.mercadolibre.com';
const ML_REFRESH_DAYS = 180;

const ML_STATUS: Record<string, SaleStatus> = {
  paid: 'paid',
  partially_refunded: 'paid',
  confirmed: 'pending',
  payment_required: 'pending',
  payment_in_process: 'pending',
  partially_paid: 'pending',
  cancelled: 'canceled',
  invalid: 'canceled',
};

export class MercadoLivreAdapter implements MarketplaceAdapter {
  readonly channel = 'mercadolivre' as const;
  readonly fake = false;
  readonly usesPkce = true;
  readonly stockForVariations = false;
  constructor(
    private readonly c: { clientId: string; clientSecret: string; redirectUri: string },
    private readonly fetcher: Fetcher = defaultFetch,
  ) {}

  authorizeUrl(state: string, challenge: string | null) {
    const q = new URLSearchParams({ response_type: 'code', client_id: this.c.clientId, redirect_uri: this.c.redirectUri, state });
    if (challenge) q.set('code_challenge', challenge), q.set('code_challenge_method', 'S256');
    return `${ML_AUTH}?${q}`;
  }

  private async token(form: Record<string, string>): Promise<Tokens> {
    const { status, body } = await call(this.fetcher, `${ML_API}/oauth/token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.c.clientId, client_secret: this.c.clientSecret, ...form }).toString(),
    });
    if (status === 400 || status === 401 || status === 403) throw new MarketplaceAuthError(`autorizacao recusada (${str(body?.error) ?? status})`);
    if (status !== 200 || !body?.access_token || !body?.refresh_token) throw new MarketplaceError(`token: resposta ${status}`);
    return {
      externalId: String(body.user_id),
      accessToken: String(body.access_token),
      refreshToken: String(body.refresh_token),
      accessExpiresAt: new Date(Date.now() + Number(body.expires_in ?? 21600) * 1000),
      refreshExpiresAt: new Date(Date.now() + ML_REFRESH_DAYS * 86_400_000),
    };
  }

  exchangeCode(p: { code: string; codeVerifier: string | null }) {
    return this.token({ grant_type: 'authorization_code', code: p.code, redirect_uri: this.c.redirectUri, ...(p.codeVerifier ? { code_verifier: p.codeVerifier } : {}) });
  }

  refresh(p: { refreshToken: string }) {
    return this.token({ grant_type: 'refresh_token', refresh_token: p.refreshToken });
  }

  private async api(auth: AccountAuth, method: string, path: string, json?: unknown) {
    const r = await call(this.fetcher, `${ML_API}${path}`, {
      method,
      headers: { accept: 'application/json', authorization: `Bearer ${auth.accessToken}`, ...(json ? { 'content-type': 'application/json' } : {}) },
      ...(json ? { body: JSON.stringify(json) } : {}),
    });
    if (r.status === 401) throw new MarketplaceAuthError('token recusado');
    if (r.status < 200 || r.status >= 300) throw new MarketplaceError(`${method} ${path}: ${r.status} ${str(r.body?.message) ?? ''}`.trim());
    return r.body;
  }

  async getOrder(auth: AccountAuth, orderId: string): Promise<MarketOrder> {
    const o = await this.api(auth, 'GET', `/orders/${encodeURIComponent(orderId)}`);
    const raw = String(o?.status ?? '');
    return {
      externalId: String(o?.id ?? orderId),
      status: ML_STATUS[raw] ?? 'other',
      rawStatus: raw,
      totalCents: o?.total_amount === undefined || o?.total_amount === null ? null : toCents(o.total_amount),
      items: (Array.isArray(o?.order_items) ? o.order_items : []).map((i: any) => ({
        itemId: String(i?.item?.id ?? ''),
        variationId: str(i?.item?.variation_id) ?? '',
        sku: str(i?.item?.seller_sku),
        title: str(i?.item?.title),
        quantity: Number(i?.quantity),
        unitPriceCents: toCents(i?.unit_price),
      })),
    };
  }

  async pushStock(auth: AccountAuth, listing: { itemId: string; variationId: string }, qty: number) {
    // Anuncio com variacao exige enviar todas as variacoes juntas: nao fazemos (docs/07 §4).
    if (listing.variationId) throw new MarketplaceError('anuncio com variacao: saldo manual');
    await this.api(auth, 'PUT', `/items/${encodeURIComponent(listing.itemId)}`, { available_quantity: qty });
  }
}

// ---------------- Shopee ----------------

const SHOPEE_STATUS: Record<string, SaleStatus> = {
  UNPAID: 'pending',
  PENDING: 'pending',
  INVOICE_PENDING: 'pending',
  READY_TO_SHIP: 'paid',
  PROCESSED: 'paid',
  RETRY_SHIP: 'paid',
  SHIPPED: 'paid',
  TO_CONFIRM_RECEIVE: 'paid',
  COMPLETED: 'paid',
  IN_CANCEL: 'other',
  TO_RETURN: 'other',
  CANCELLED: 'canceled',
};
const SHOPEE_REFRESH_DAYS = 30;

export class ShopeeAdapter implements MarketplaceAdapter {
  readonly channel = 'shopee' as const;
  readonly fake = false;
  readonly usesPkce = false;
  readonly stockForVariations = true;
  constructor(
    private readonly c: { partnerId: string; partnerKey: string; redirectUri: string; apiHost: string; authHost: string },
    private readonly fetcher: Fetcher = defaultFetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Assinatura das chamadas: HMAC-SHA256(partner_key, partner_id + caminho + timestamp [+ access_token + shop_id]), hex. */
  sign(path: string, ts: number, shop?: { accessToken: string; shopId: string }) {
    const base = `${this.c.partnerId}${path}${ts}${shop ? `${shop.accessToken}${shop.shopId}` : ''}`;
    return createHmac('sha256', this.c.partnerKey).update(base).digest('hex');
  }

  authorizeUrl(state: string) {
    const q = new URLSearchParams({ partner_id: this.c.partnerId, auth_type: 'seller', redirect_uri: this.c.redirectUri, response_type: 'code', state });
    return `${this.c.authHost.replace(/\/$/, '')}/auth?${q}`;
  }

  private async request(method: 'GET' | 'POST', path: string, opts: { shop?: { accessToken: string; shopId: string }; query?: Record<string, string>; json?: unknown } = {}) {
    const ts = Math.floor(this.now() / 1000);
    const q = new URLSearchParams({ partner_id: this.c.partnerId, timestamp: String(ts), sign: this.sign(path, ts, opts.shop), ...(opts.shop ? { access_token: opts.shop.accessToken, shop_id: opts.shop.shopId } : {}), ...opts.query });
    const r = await call(this.fetcher, `${this.c.apiHost.replace(/\/$/, '')}${path}?${q}`, {
      method,
      headers: { accept: 'application/json', ...(opts.json ? { 'content-type': 'application/json' } : {}) },
      ...(opts.json ? { body: JSON.stringify(opts.json) } : {}),
    });
    const err = str(r.body?.error);
    // Codigos de erro da Shopee nao sao interpretados (nao ha lista oficial conferida): so 401/403 viram reautorizacao.
    if (r.status === 401 || r.status === 403) throw new MarketplaceAuthError(`autorizacao recusada (${err ?? r.status})`);
    if (r.status !== 200 || err) throw new MarketplaceError(`${path}: ${r.status} ${err ?? ''} ${str(r.body?.message) ?? ''}`.trim());
    return r.body;
  }

  private tokens(body: any, shopId: string): Tokens {
    if (!body?.access_token || !body?.refresh_token) throw new MarketplaceError('token: resposta sem access_token');
    return {
      externalId: shopId,
      accessToken: String(body.access_token),
      refreshToken: String(body.refresh_token),
      accessExpiresAt: new Date(this.now() + Number(body.expire_in ?? 14400) * 1000),
      refreshExpiresAt: new Date(this.now() + SHOPEE_REFRESH_DAYS * 86_400_000),
    };
  }

  async exchangeCode(p: { code: string; shopId: string | null }) {
    if (!p.shopId || !/^\d{1,20}$/.test(p.shopId)) throw new MarketplaceAuthError('retorno da Shopee sem shop_id');
    const body = await this.request('POST', '/api/v2/auth/token/get', { json: { code: p.code, partner_id: Number(this.c.partnerId), shop_id: Number(p.shopId) } });
    return this.tokens(body, p.shopId);
  }

  async refresh(p: { externalId: string; refreshToken: string }) {
    const body = await this.request('POST', '/api/v2/auth/access_token/get', { json: { refresh_token: p.refreshToken, partner_id: Number(this.c.partnerId), shop_id: Number(p.externalId) } });
    return this.tokens(body, p.externalId);
  }

  async getOrder(auth: AccountAuth, orderSn: string): Promise<MarketOrder> {
    const body = await this.request('GET', '/api/v2/order/get_order_detail', {
      shop: { accessToken: auth.accessToken, shopId: auth.externalId },
      query: { order_sn_list: orderSn, response_optional_fields: 'item_list,total_amount' },
    });
    const o = (body?.response?.order_list ?? []).find((x: any) => String(x?.order_sn) === orderSn);
    if (!o) throw new MarketplaceError('pedido nao encontrado na Shopee');
    const raw = String(o.order_status ?? '');
    return {
      externalId: orderSn,
      status: SHOPEE_STATUS[raw] ?? 'other',
      rawStatus: raw,
      totalCents: o.total_amount === undefined || o.total_amount === null ? null : toCents(o.total_amount),
      items: (Array.isArray(o.item_list) ? o.item_list : []).map((i: any) => ({
        itemId: String(i?.item_id ?? ''),
        variationId: i?.model_id && String(i.model_id) !== '0' ? String(i.model_id) : '',
        sku: str(i?.model_sku) ?? str(i?.item_sku),
        title: str(i?.item_name),
        quantity: Number(i?.model_quantity_purchased),
        unitPriceCents: toCents(i?.model_discounted_price ?? i?.model_original_price),
      })),
    };
  }

  async pushStock(auth: AccountAuth, listing: { itemId: string; variationId: string }, qty: number) {
    const body = await this.request('POST', '/api/v2/product/update_stock', {
      shop: { accessToken: auth.accessToken, shopId: auth.externalId },
      json: { item_id: Number(listing.itemId), stock_list: [{ model_id: Number(listing.variationId || 0), seller_stock: [{ stock: qty }] }] },
    });
    const fail = body?.response?.failure_list;
    if (Array.isArray(fail) && fail.length) throw new MarketplaceError(`estoque recusado: ${str(fail[0]?.failed_reason) ?? 'motivo nao informado'}`);
  }

  /** Push da Shopee: Authorization = HMAC-SHA256(partner_key, URL + '|' + corpo cru), hex. */
  verifyPush(url: string, rawBody: string, authorization: string | undefined) {
    if (!authorization) return false;
    const expected = createHmac('sha256', this.c.partnerKey).update(`${url}|${rawBody}`).digest('hex');
    return safeEqual(expected, authorization.trim().toLowerCase());
  }
}

// ---------------- simulado (somente desenvolvimento e testes) ----------------

export class FakeMarketplace implements MarketplaceAdapter {
  readonly fake = true;
  readonly usesPkce: boolean;
  readonly stockForVariations: boolean;
  orders = new Map<string, MarketOrder>();
  pushes: { itemId: string; variationId: string; qty: number }[] = [];
  refreshes = 0;
  failNext: 'auth' | 'error' | null = null;
  private n = 0;
  constructor(
    readonly channel: Channel,
    private readonly redirectUri: string,
  ) {
    this.usesPkce = channel === 'mercadolivre';
    this.stockForVariations = channel === 'shopee';
  }

  private maybeFail() {
    const f = this.failNext;
    this.failNext = null;
    if (f === 'auth') throw new MarketplaceAuthError('autorizacao recusada (simulado)');
    if (f === 'error') throw new MarketplaceError('plataforma fora do ar (simulado)');
  }

  authorizeUrl(state: string) {
    const q = new URLSearchParams({ code: `fake-code-${randomBytes(4).toString('hex')}`, state, ...(this.channel === 'shopee' ? { shop_id: '900001' } : {}) });
    return `${this.redirectUri}?${q}`;
  }

  private tokens(externalId: string): Tokens {
    this.n += 1;
    return {
      externalId,
      accessToken: `fake-access-${this.n}`,
      refreshToken: `fake-refresh-${this.n}`,
      accessExpiresAt: new Date(Date.now() + 4 * 3_600_000),
      refreshExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    };
  }

  async exchangeCode(p: { code: string; shopId: string | null }) {
    this.maybeFail();
    if (!p.code.startsWith('fake-code-')) throw new MarketplaceAuthError('codigo invalido (simulado)');
    return this.tokens(this.channel === 'shopee' ? (p.shopId ?? '900001') : '700001');
  }

  async refresh(p: { externalId: string }) {
    this.maybeFail();
    this.refreshes += 1;
    return this.tokens(p.externalId);
  }

  async getOrder(_auth: AccountAuth, orderId: string) {
    this.maybeFail();
    const o = this.orders.get(orderId);
    if (!o) throw new MarketplaceError('pedido nao encontrado (simulado)');
    return structuredClone(o);
  }

  async pushStock(_auth: AccountAuth, listing: { itemId: string; variationId: string }, qty: number) {
    this.maybeFail();
    if (listing.variationId && !this.stockForVariations) throw new MarketplaceError('anuncio com variacao: saldo manual');
    this.pushes.push({ ...listing, qty });
  }

  verifyPush() {
    return true;
  }
}

// ---------------- configuracao ----------------

export type Marketplaces = Record<Channel, MarketplaceAdapter | null>;

export const redirectUri = (channel: Channel) =>
  (channel === 'mercadolivre' ? config.ML_REDIRECT_URI : config.SHOPEE_REDIRECT_URI) ?? `${config.APP_ORIGIN}/painel/marketplaces/retorno/${channel}`;

export const shopeePushUrl = () => config.SHOPEE_PUSH_URL ?? (config.PUBLIC_API_URL ? `${config.PUBLIC_API_URL.replace(/\/$/, '')}/api/v1/webhooks/marketplaces/shopee` : null);

/** Real quando ha credencial; simulado so fora de producao com MARKETPLACE_FAKE; senao desligado. */
export function marketplacesFromConfig(): Marketplaces {
  const fake = config.MARKETPLACE_FAKE && !isProduction;
  return {
    mercadolivre:
      config.ML_CLIENT_ID && config.ML_CLIENT_SECRET
        ? new MercadoLivreAdapter({ clientId: config.ML_CLIENT_ID, clientSecret: config.ML_CLIENT_SECRET, redirectUri: redirectUri('mercadolivre') })
        : fake
          ? new FakeMarketplace('mercadolivre', redirectUri('mercadolivre'))
          : null,
    shopee:
      config.SHOPEE_PARTNER_ID && config.SHOPEE_PARTNER_KEY
        ? new ShopeeAdapter({ partnerId: config.SHOPEE_PARTNER_ID, partnerKey: config.SHOPEE_PARTNER_KEY, redirectUri: redirectUri('shopee'), apiHost: config.SHOPEE_API_HOST, authHost: config.SHOPEE_AUTH_HOST })
        : fake
          ? new FakeMarketplace('shopee', redirectUri('shopee'))
          : null,
  };
}
