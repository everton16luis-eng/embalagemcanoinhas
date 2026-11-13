import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * Provedor de pagamento. A loja nunca recebe numero de cartao: o cartao e tokenizado no
 * navegador pelo componente do provedor (Card Payment Brick) e so o token chega aqui.
 */
export type PaymentStatus = 'pending' | 'approved' | 'rejected' | 'canceled' | 'refunded' | 'charged_back' | 'error';

export type ProviderPayment = {
  providerPaymentId: string;
  status: PaymentStatus;
  statusDetail: string | null;
  amountCents: number;
  externalReference: string | null;
  pix?: { qrCode: string; qrBase64: string; expiresAt: string | null };
  card?: { lastFour: string | null; brand: string | null; installments: number | null };
};

export type Payer = { email: string; firstName: string; lastName: string; docType: 'CPF' | 'CNPJ' | null; docNumber: string | null };

export type CardData = {
  token: string;
  paymentMethodId: string;
  issuerId: string | null;
  installments: number;
  payerEmail: string;
  payerDocType: string | null;
  payerDocNumber: string | null;
};

export interface PaymentProvider {
  readonly name: 'mercadopago' | 'fake';
  readonly publicKey: string | null;
  createPix(i: { idempotencyKey: string; amountCents: number; description: string; externalReference: string; payer: Payer; expiresAt: Date }): Promise<ProviderPayment>;
  createCard(i: { idempotencyKey: string; amountCents: number; description: string; externalReference: string; card: CardData }): Promise<ProviderPayment>;
  getPayment(id: string): Promise<ProviderPayment>;
  /** Confere a assinatura da notificacao. Devolve o id do pagamento notificado ou null se invalida. */
  verifyNotification(i: { headers: Record<string, string | string[] | undefined>; query: Record<string, unknown> }): { valid: boolean; resourceId: string | null; dedupeKey: string };
}

const MP_STATUS: Record<string, PaymentStatus> = {
  pending: 'pending',
  in_process: 'pending',
  authorized: 'pending',
  in_mediation: 'pending',
  approved: 'approved',
  rejected: 'rejected',
  cancelled: 'canceled',
  refunded: 'refunded',
  charged_back: 'charged_back',
};

const cents = (v: unknown) => Math.round(Number(v) * 100);
const reais = (c: number) => Math.round(c) / 100;
const header = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h) ?? '';

/** Mercado Pago, Checkout Transparente (POST /v1/payments). Ver docs/decisoes-pagamento.md. */
export class MercadoPagoProvider implements PaymentProvider {
  readonly name = 'mercadopago' as const;
  constructor(
    private readonly accessToken: string,
    readonly publicKey: string,
    private readonly webhookSecret: string | null,
    private readonly notificationUrl: string | null,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async call(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string) {
    const res = await this.fetcher(`https://api.mercadopago.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => null)) as Record<string, any> | null;
    if (!res.ok || !data) {
      // Mensagem do provedor fica no log do servidor, nao vai para o cliente.
      const err = new Error(`Mercado Pago ${res.status}: ${data?.message ?? 'sem resposta'}`) as Error & { providerStatus?: number; providerCause?: unknown };
      err.providerStatus = res.status;
      err.providerCause = data?.cause;
      throw err;
    }
    return data;
  }

  private map(d: Record<string, any>): ProviderPayment {
    const tx = d.point_of_interaction?.transaction_data;
    return {
      providerPaymentId: String(d.id),
      status: MP_STATUS[d.status] ?? 'error',
      statusDetail: d.status_detail ?? null,
      amountCents: cents(d.transaction_amount),
      externalReference: d.external_reference ?? null,
      ...(tx?.qr_code ? { pix: { qrCode: tx.qr_code, qrBase64: tx.qr_code_base64 ?? '', expiresAt: d.date_of_expiration ?? null } } : {}),
      ...(d.card ? { card: { lastFour: d.card.last_four_digits ?? null, brand: d.payment_method_id ?? null, installments: d.installments ?? null } } : {}),
    };
  }

  async createPix(i: Parameters<PaymentProvider['createPix']>[0]) {
    const d = await this.call(
      'POST',
      '/v1/payments',
      {
        transaction_amount: reais(i.amountCents),
        description: i.description,
        payment_method_id: 'pix',
        external_reference: i.externalReference,
        date_of_expiration: i.expiresAt.toISOString().replace('Z', '+00:00'),
        ...(this.notificationUrl ? { notification_url: this.notificationUrl } : {}),
        payer: {
          email: i.payer.email,
          first_name: i.payer.firstName,
          last_name: i.payer.lastName,
          ...(i.payer.docType && i.payer.docNumber ? { identification: { type: i.payer.docType, number: i.payer.docNumber } } : {}),
        },
      },
      i.idempotencyKey,
    );
    return this.map(d);
  }

  async createCard(i: Parameters<PaymentProvider['createCard']>[0]) {
    const d = await this.call(
      'POST',
      '/v1/payments',
      {
        transaction_amount: reais(i.amountCents),
        token: i.card.token,
        description: i.description,
        installments: i.card.installments,
        payment_method_id: i.card.paymentMethodId,
        ...(i.card.issuerId ? { issuer_id: Number(i.card.issuerId) || i.card.issuerId } : {}),
        external_reference: i.externalReference,
        ...(this.notificationUrl ? { notification_url: this.notificationUrl } : {}),
        payer: {
          email: i.card.payerEmail,
          ...(i.card.payerDocType && i.card.payerDocNumber ? { identification: { type: i.card.payerDocType, number: i.card.payerDocNumber } } : {}),
        },
      },
      i.idempotencyKey,
    );
    return this.map(d);
  }

  async getPayment(id: string) {
    return this.map(await this.call('GET', `/v1/payments/${encodeURIComponent(id)}`));
  }

  /**
   * Assinatura x-signature: "ts=...,v1=..." com HMAC-SHA256 (hex) da chave secreta sobre
   * "id:[data.id];request-id:[x-request-id];ts:[ts];". data.id alfanumerico vai em minusculas;
   * partes ausentes saem do texto assinado (documentacao oficial de notificacoes).
   */
  verifyNotification({ headers, query }: Parameters<PaymentProvider['verifyNotification']>[0]) {
    const dataId = typeof query['data.id'] === 'string' ? (query['data.id'] as string) : typeof query.id === 'string' ? (query.id as string) : null;
    const requestId = header(headers['x-request-id']);
    const sig = header(headers['x-signature']);
    const parts = Object.fromEntries(sig.split(',').map((p) => p.trim().split('=', 2) as [string, string]));
    const dedupeKey = `${dataId ?? '-'}:${requestId || parts.ts || '-'}`;
    if (!this.webhookSecret || !parts.ts || !parts.v1) return { valid: false, resourceId: dataId, dedupeKey };
    let manifest = '';
    if (dataId) manifest += `id:${/^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId};`;
    if (requestId) manifest += `request-id:${requestId};`;
    manifest += `ts:${parts.ts};`;
    const expected = createHmac('sha256', this.webhookSecret).update(manifest).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(parts.v1.toLowerCase());
    return { valid: a.length === b.length && timingSafeEqual(a, b), resourceId: dataId, dedupeKey };
  }
}

/** Provedor de teste: aprova, recusa ou deixa pendente conforme o token, sem rede. */
export class FakeProvider implements PaymentProvider {
  readonly name = 'fake' as const;
  readonly publicKey = 'TEST-fake-public-key';
  readonly payments = new Map<string, ProviderPayment>();
  readonly calls: { kind: string; idempotencyKey: string }[] = [];
  private seq = 1000;
  private byKey = new Map<string, string>();

  private store(key: string, p: Omit<ProviderPayment, 'providerPaymentId'>) {
    this.calls.push({ kind: p.pix ? 'pix' : 'card', idempotencyKey: key });
    const existing = this.byKey.get(key);
    if (existing) return this.payments.get(existing)!;
    const id = String(++this.seq);
    const full = { providerPaymentId: id, ...p };
    this.payments.set(id, full);
    this.byKey.set(key, id);
    return full;
  }
  async createPix(i: Parameters<PaymentProvider['createPix']>[0]) {
    return this.store(i.idempotencyKey, {
      status: 'pending',
      statusDetail: 'pending_waiting_transfer',
      amountCents: i.amountCents,
      externalReference: i.externalReference,
      pix: { qrCode: `00020126-fake-${i.externalReference}`, qrBase64: 'iVBORw0KGgo=', expiresAt: i.expiresAt.toISOString() },
    });
  }
  async createCard(i: Parameters<PaymentProvider['createCard']>[0]) {
    const status: PaymentStatus = i.card.token.startsWith('reject') ? 'rejected' : i.card.token.startsWith('pending') ? 'pending' : 'approved';
    return this.store(i.idempotencyKey, {
      status,
      statusDetail: status === 'rejected' ? 'cc_rejected_insufficient_amount' : status === 'approved' ? 'accredited' : 'pending_contingency',
      amountCents: i.amountCents,
      externalReference: i.externalReference,
      card: { lastFour: '4242', brand: i.card.paymentMethodId, installments: i.card.installments },
    });
  }
  async getPayment(id: string) {
    const p = this.payments.get(id);
    if (!p) throw new Error('pagamento inexistente');
    return p;
  }
  /** Teste muda a situacao como se o cliente tivesse pago o Pix. */
  settle(id: string, status: PaymentStatus) {
    const p = this.payments.get(id)!;
    this.payments.set(id, { ...p, status });
  }
  verifyNotification({ headers, query }: Parameters<PaymentProvider['verifyNotification']>[0]) {
    const id = typeof query['data.id'] === 'string' ? (query['data.id'] as string) : null;
    return { valid: header(headers['x-signature']) === 'fake-valid', resourceId: id, dedupeKey: `${id}:${header(headers['x-request-id'])}` };
  }
}

export function providerFromConfig(): PaymentProvider | null {
  if (!config.MP_ACCESS_TOKEN || !config.MP_PUBLIC_KEY) return null;
  const url = config.PUBLIC_API_URL ? `${config.PUBLIC_API_URL.replace(/\/$/, '')}/api/v1/webhooks/mercadopago` : null;
  return new MercadoPagoProvider(config.MP_ACCESS_TOKEN, config.MP_PUBLIC_KEY, config.MP_WEBHOOK_SECRET ?? null, url);
}
