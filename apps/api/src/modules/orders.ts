import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config, isProduction } from '../config.js';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { keyedHash, sha256 } from '../lib/crypto.js';
import { AppError, notFound } from '../lib/errors.js';
import { invoiceSummary, sendOrderInvoice } from '../lib/fiscal-files.js';
import { idParams, likePattern, pageQuery } from '../lib/http.js';
import type { PaymentProvider, ProviderPayment } from '../lib/payments.js';
import { consumeReservation, releaseReservation, reserve } from '../lib/stock.js';
import { requirePermission } from './auth.js';
import { addressSchema, documentFor, personSchema, requireCustomer } from './customers.js';
import { CART_COOKIE, cartLines, quoteShipping, summarize } from './storefront.js';

declare module 'fastify' {
  interface FastifyInstance {
    payments: PaymentProvider | null;
  }
}

export const ORDER_STATUS = ['pending_payment', 'paid', 'preparing', 'ready', 'shipped', 'delivered', 'canceled'] as const;

/** Quantidade na unidade base: embalagem x quantidade, sem passar por ponto flutuante. */
export function mulQty(baseQty: string, packs: number) {
  const [i, f = ''] = baseQty.split('.');
  const milli = BigInt(i!) * 1000n + BigInt((f + '000').slice(0, 3));
  const total = milli * BigInt(packs);
  return `${total / 1000n}.${(total % 1000n).toString().padStart(3, '0')}`;
}

/**
 * Link de acompanhamento: derivado da chave do pedido com a chave secreta do servidor.
 * Repetir o mesmo envio devolve o mesmo link sem guardar o token em texto no banco.
 */
const publicToken = (requestKey: string) => keyedHash(`order-link:${requestKey}`);

const paymentUnavailable = () => new AppError(503, 'PAYMENT_UNAVAILABLE', 'Pagamento online indisponível no momento. Fale com a loja pelo WhatsApp para concluir a compra.');

// ---------------- visao do pedido ----------------

export async function orderView(db: Db | typeof pool, orderId: string, opts: { staff?: boolean } = {}) {
  const o = (
    await db.query(
      `SELECT id, number, status, channel, buyer, ship_to, shipping_snapshot, payment_method, subtotal_cents, discount_cents, freight_cents, total_cents,
              notes, invoice_status, has_backorder, payment_due_at, paid_at, canceled_at, cancel_reason, created_at, version${opts.staff ? ', customer_id, request_key' : ''}
       FROM orders WHERE id = $1`,
      [orderId],
    )
  ).rows[0];
  if (!o) throw notFound();
  const items = (
    await db.query(
      `SELECT id, variant_id, packaging_id, sku, product_name, packaging_label, base_qty_per_pack, packs, list_price_cents, unit_price_cents, total_cents, made_to_order, lead_time_days
       FROM order_items WHERE order_id = $1 ORDER BY sku`,
      [orderId],
    )
  ).rows;
  const payments = (
    await db.query(
      `SELECT id, method, status, status_detail, amount_cents, pix_qr_code, pix_qr_base64, pix_expires_at, card_last_four, card_brand, installments, created_at, updated_at
              ${opts.staff ? ', provider, provider_payment_id' : ''}
       FROM payments WHERE order_id = $1 ORDER BY created_at DESC`,
      [orderId],
    )
  ).rows;
  const events = (
    await db.query(
      `SELECT e.status, e.note, e.created_at${opts.staff ? ', u.name AS actor_name' : ''} FROM order_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.order_id = $1 ORDER BY e.id`,
      [orderId],
    )
  ).rows;
  const shipment = (await db.query('SELECT carrier, tracking_code, tracking_url, volumes, weight_g, shipped_at, delivered_at FROM shipments WHERE order_id = $1', [orderId])).rows[0] ?? null;
  return { ...o, items, payments, events, shipment, invoice: await invoiceSummary(db, orderId) };
}

async function orderByToken(db: Db | typeof pool, token: string) {
  if (token.length > 100) throw notFound();
  const row = (await db.query<{ id: string }>('SELECT id FROM orders WHERE public_token_hash = $1', [sha256(token)])).rows[0];
  if (!row) throw notFound();
  return row.id;
}

async function addEvent(db: Db, orderId: string, status: string, note: string | null, actorId: string | null = null) {
  await db.query('INSERT INTO order_events (order_id, status, note, actor_id) VALUES ($1, $2, $3, $4)', [orderId, status, note, actorId]);
}

async function releaseOrderReservations(db: Db, actorId: string | null, orderId: string) {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM stock_reservations WHERE source_type = 'order' AND source_id = $1 AND status = 'active'`, [orderId]);
  for (const r of rows) await releaseReservation(db, actorId, r.id);
  return rows.length;
}

// ---------------- pagamento: aplicar a situacao vinda do provedor ----------------

type PaymentRow = { id: string; order_id: string; status: string; amount_cents: string; method: string };

/**
 * Grava a situacao informada pelo provedor e avanca o pedido quando aprovado.
 * Valor ou pedido divergente nunca aprova: fica registrado para conferencia.
 */
export async function applyPayment(db: Db, paymentId: string, p: ProviderPayment) {
  const pay = (await db.query<PaymentRow>('SELECT id, order_id, status, amount_cents, method FROM payments WHERE id = $1 FOR UPDATE', [paymentId])).rows[0];
  if (!pay) throw notFound();
  const order = (await db.query<{ id: string; status: string; total_cents: string }>('SELECT id, status, total_cents FROM orders WHERE id = $1 FOR UPDATE', [pay.order_id])).rows[0]!;
  const mismatch = p.amountCents !== Number(order.total_cents) || (p.externalReference !== null && p.externalReference !== order.id);
  const status = mismatch && p.status === 'approved' ? 'error' : p.status;
  await db.query(
    `UPDATE payments SET provider_payment_id = $2, status = $3, status_detail = $4, updated_at = now(),
       pix_qr_code = coalesce($5, pix_qr_code), pix_qr_base64 = coalesce($6, pix_qr_base64), pix_expires_at = coalesce($7, pix_expires_at),
       card_last_four = coalesce($8, card_last_four), card_brand = coalesce($9, card_brand), installments = coalesce($10, installments)
     WHERE id = $1`,
    [
      pay.id,
      p.providerPaymentId,
      status,
      mismatch ? 'valor ou pedido divergente' : p.statusDetail,
      p.pix?.qrCode ?? null,
      p.pix?.qrBase64 ?? null,
      p.pix?.expiresAt ?? null,
      p.card?.lastFour ?? null,
      p.card?.brand ?? null,
      p.card?.installments ?? null,
    ],
  );
  if (pay.status === status) return { orderStatus: order.status, paymentStatus: status };

  if (status === 'approved') {
    if (order.status === 'pending_payment') {
      await db.query(`UPDATE orders SET status = 'paid', paid_at = now(), updated_at = now(), version = version + 1 WHERE id = $1`, [order.id]);
      await addEvent(db, order.id, 'paid', pay.method === 'pix' ? 'Pix confirmado' : 'Cartão aprovado');
      return { orderStatus: 'paid', paymentStatus: status };
    }
    if (order.status === 'canceled') await addEvent(db, order.id, 'canceled', 'Pagamento aprovado depois do cancelamento: devolver o valor pelo painel do Mercado Pago.');
  } else if (status === 'refunded' || status === 'charged_back') {
    await addEvent(db, order.id, order.status, status === 'refunded' ? 'Pagamento devolvido ao cliente.' : 'Contestação (chargeback) aberta pelo cliente.');
  } else if (mismatch) {
    await addEvent(db, order.id, order.status, 'Pagamento com valor divergente: conferir no Mercado Pago.');
  }
  return { orderStatus: order.status, paymentStatus: status };
}

/** Consulta o provedor e aplica. Usado pelo aviso (webhook), pela tela do pedido e pela rotina de vencimento. */
export async function syncPayment(provider: PaymentProvider, paymentId: string, providerPaymentId: string) {
  const p = await provider.getPayment(providerPaymentId);
  return tx(null, (db) => applyPayment(db, paymentId, p));
}

/**
 * Cancela pedidos sem pagamento depois do prazo (com 5 minutos de folga) e libera o estoque.
 * Antes, pergunta ao provedor: um Pix pago no ultimo minuto nao pode ser cancelado.
 */
export async function expireOrders(provider: PaymentProvider | null, limit = 50) {
  const due = (
    await pool.query<{ id: string }>(
      `SELECT id FROM orders WHERE status = 'pending_payment' AND payment_due_at < now() - interval '5 minutes' ORDER BY payment_due_at LIMIT $1`,
      [limit],
    )
  ).rows;
  let canceled = 0;
  for (const { id } of due) {
    const pending = (
      await pool.query<{ id: string; provider_payment_id: string; method: string; created_at: Date }>(
        `SELECT id, provider_payment_id, method, created_at FROM payments WHERE order_id = $1 AND status = 'pending' AND provider_payment_id IS NOT NULL`,
        [id],
      )
    ).rows;
    let cardInReview = false;
    for (const p of pending) {
      if (!provider) continue;
      try {
        const r = await syncPayment(provider, p.id, p.provider_payment_id);
        // Cartao em analise pelo provedor: espera ate 2 dias antes de desistir.
        if (r.paymentStatus === 'pending' && p.method === 'card' && Date.now() - p.created_at.getTime() < 2 * 86_400_000) cardInReview = true;
      } catch {
        cardInReview = true; // provedor fora do ar: tenta de novo na proxima rodada
      }
    }
    if (cardInReview) continue;
    const done = await tx(null, async (db) => {
      const o = (await db.query(`SELECT id FROM orders WHERE id = $1 AND status = 'pending_payment' FOR UPDATE SKIP LOCKED`, [id])).rows[0];
      if (!o) return false;
      await db.query(`UPDATE orders SET status = 'canceled', canceled_at = now(), cancel_reason = 'Prazo de pagamento vencido', updated_at = now(), version = version + 1 WHERE id = $1`, [id]);
      await db.query(`UPDATE payments SET status = 'canceled', updated_at = now() WHERE order_id = $1 AND status IN ('created', 'pending')`, [id]);
      await releaseOrderReservations(db, null, id);
      await addEvent(db, id, 'canceled', 'Prazo de pagamento vencido');
      return true;
    });
    if (done) canceled++;
  }
  return canceled;
}

// ---------------- checkout (publico) ----------------

const checkoutSchema = z.strictObject({
  requestKey: z.string().min(8).max(100),
  buyer: personSchema,
  shippingOptionId: z.uuid(),
  address: addressSchema.optional().nullable(),
  paymentMethod: z.enum(['pix', 'card']),
  notes: z.string().trim().max(500).optional().nullable(),
  // Total que o cliente viu. Se o preco mudou nesse meio tempo, o pedido nao e criado.
  expectedTotalCents: z.number().int().positive(),
});

export async function checkoutRoutes(app: FastifyInstance) {
  app.get('/payment-config', async () => ({
    enabled: Boolean(app.payments),
    provider: app.payments?.name ?? null,
    publicKey: app.payments?.publicKey ?? null,
    methods: app.payments ? ['pix', 'card'] : [],
  }));

  app.post('/', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = checkoutSchema.parse(req.body);
    if (!app.payments) throw paymentUnavailable();
    const token = publicToken(b.requestKey);

    // Repeticao do mesmo envio (duplo clique, rede instavel): devolve o pedido ja criado.
    const prior = (await pool.query<{ id: string; number: number }>('SELECT id, number FROM orders WHERE request_key = $1', [b.requestKey])).rows[0];
    if (prior) return { order: { id: prior.id, number: prior.number, token }, replay: true };

    const document = documentFor(b.buyer.kind, b.buyer.document);
    if (!document) throw new AppError(400, 'INVALID_DOCUMENT', b.buyer.kind === 'pf' ? 'CPF inválido.' : 'CNPJ inválido.');
    const cartToken = req.cookies[CART_COOKIE];
    if (!cartToken || cartToken.length > 100) throw new AppError(422, 'CART_EMPTY', 'Seu carrinho está vazio.');

    const result = await tx(null, async (db) => {
      const cart = (await db.query<{ id: string }>(`SELECT id FROM carts WHERE token_hash = $1 AND status = 'active' FOR UPDATE`, [sha256(cartToken)])).rows[0];
      if (!cart) {
        // Carrinho ja convertido por um envio concorrente com a mesma chave.
        const again = (await db.query<{ id: string; number: number }>('SELECT id, number FROM orders WHERE request_key = $1', [b.requestKey])).rows[0];
        if (again) return { id: again.id, number: again.number, replay: true };
        throw new AppError(422, 'CART_EMPTY', 'Seu carrinho está vazio.');
      }
      const lines = await cartLines(db, cart.id);
      const sum = summarize(lines);
      if (!lines.length) throw new AppError(422, 'CART_EMPTY', 'Seu carrinho está vazio.');
      if (sum.blocking.length) throw new AppError(409, 'CART_BLOCKED', 'Alguns itens mudaram de disponibilidade. Revise o carrinho.', { blocking: sum.blocking });

      const options = await quoteShipping(db, b.address?.cep ?? null, sum.subtotalCents, sum.weightG, sum.weightMissing.length > 0);
      const ship = options.find((o) => o.id === b.shippingOptionId);
      if (!ship) throw new AppError(422, 'SHIPPING_UNAVAILABLE', 'Esta forma de entrega não atende o endereço informado.');
      if (ship.kind === 'delivery' && !b.address) throw new AppError(400, 'ADDRESS_REQUIRED', 'Informe o endereço de entrega.');

      const total = sum.subtotalCents + ship.priceCents;
      if (total !== b.expectedTotalCents) {
        throw new AppError(409, 'PRICE_CHANGED', 'Os valores foram atualizados. Confira o novo total antes de finalizar.', { totalCents: total, subtotalCents: sum.subtotalCents, freightCents: ship.priceCents });
      }

      const minutes = b.paymentMethod === 'pix' ? config.PIX_EXPIRATION_MINUTES : config.CARD_PAYMENT_WINDOW_MINUTES;
      const buyer = { ...b.buyer, document, stateRegistration: b.buyer.stateRegistration || null };
      const { rows } = await db.query<{ id: string; number: number }>(
        `INSERT INTO orders (public_token_hash, request_key, customer_id, buyer, ship_to, shipping_option_id, shipping_snapshot, payment_method,
                             subtotal_cents, freight_cents, total_cents, notes, has_backorder, payment_due_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now() + make_interval(mins => $14)) RETURNING id, number`,
        [
          sha256(token),
          b.requestKey,
          req.customer?.id ?? null,
          JSON.stringify(buyer),
          ship.kind === 'delivery' ? JSON.stringify(b.address) : null,
          ship.id,
          JSON.stringify(ship),
          b.paymentMethod,
          sum.subtotalCents,
          ship.priceCents,
          total,
          b.notes || null,
          false,
          minutes,
        ],
      );
      const order = rows[0]!;
      let backorder = false;
      for (const l of lines) {
        await db.query(
          `INSERT INTO order_items (order_id, variant_id, packaging_id, sku, product_name, packaging_label, base_qty_per_pack, packs, list_price_cents, unit_price_cents, total_cents, made_to_order, lead_time_days)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [order.id, l.variantId, l.packagingId, l.sku, l.productName, l.label, l.baseQty, l.packs, l.listPriceCents, l.unitPriceCents, l.totalCents, l.madeToOrder, l.leadTimeDays],
        );
      }
      // Reserva por variacao (duas embalagens da mesma variacao somam numa reserva so).
      const perVariant = new Map<string, bigint>();
      for (const l of lines) {
        const [i, f = ''] = mulQty(l.baseQty, l.packs).split('.');
        perVariant.set(l.variantId, (perVariant.get(l.variantId) ?? 0n) + BigInt(i!) * 1000n + BigInt(f.padEnd(3, '0')));
      }
      for (const [variantId, milli] of perVariant) {
        const qty = `${milli / 1000n}.${(milli % 1000n).toString().padStart(3, '0')}`;
        const r = await reserve(db, null, { variantId, qty, sourceType: 'order', sourceId: order.id });
        backorder ||= r.backorder;
      }
      if (backorder) await db.query('UPDATE orders SET has_backorder = true WHERE id = $1', [order.id]);
      await addEvent(db, order.id, 'pending_payment', b.paymentMethod === 'pix' ? 'Pedido criado, aguardando Pix' : 'Pedido criado, aguardando cartão');
      await db.query(`UPDATE carts SET status = 'converted', customer_id = coalesce(customer_id, $2), updated_at = now() WHERE id = $1`, [cart.id, req.customer?.id ?? null]);
      return { id: order.id, number: order.number, replay: false };
    });

    if (!result.replay) reply.clearCookie(CART_COOKIE, { path: '/' });
    return reply.code(result.replay ? 200 : 201).send({ order: { id: result.id, number: result.number, token }, replay: result.replay });
  });
}

// ---------------- pedido do cliente (link publico ou conta) ----------------

const cardSchema = z.strictObject({
  attemptKey: z.uuid(),
  token: z.string().min(8).max(200),
  paymentMethodId: z.string().regex(/^[a-z_]{2,30}$/),
  issuerId: z.union([z.string().max(20), z.number().int()]).optional().nullable(),
  installments: z.number().int().min(1).max(12),
  payer: z.strictObject({
    email: z.email().max(254),
    identification: z.strictObject({ type: z.enum(['CPF', 'CNPJ']), number: z.string().max(20) }).optional().nullable(),
  }),
});

async function lockPayable(db: Db, orderId: string, method: 'pix' | 'card') {
  const o = (
    await db.query<{ id: string; status: string; payment_method: string; total_cents: string; number: number; buyer: Record<string, string>; payment_due_at: Date }>(
      'SELECT id, status, payment_method, total_cents, number, buyer, payment_due_at FROM orders WHERE id = $1 FOR UPDATE',
      [orderId],
    )
  ).rows[0];
  if (!o) throw notFound();
  if (o.status !== 'pending_payment') throw new AppError(409, 'ORDER_NOT_PAYABLE', 'Este pedido não está aguardando pagamento.');
  if (o.payment_due_at.getTime() < Date.now()) throw new AppError(409, 'ORDER_EXPIRED', 'O prazo de pagamento deste pedido terminou.');
  if (o.payment_method !== method) throw new AppError(409, 'WRONG_METHOD', 'Forma de pagamento diferente da escolhida no pedido.');
  return o;
}

export function orderPaymentRoutes(app: FastifyInstance, resolve: (req: FastifyRequest) => Promise<string>, opts: { staff?: boolean } = {}) {
  const limit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  // DANFE (PDF) e XML da nota autorizada do pedido.
  app.get('/invoice/:which', limit, async (req, reply) => {
    const id = await resolve(req);
    const { which } = z.object({ which: z.enum(['danfe', 'xml']) }).parse(req.params);
    return sendOrderInvoice(pool, reply, id, which);
  });

  app.get('/', async (req) => {
    const id = await resolve(req);
    // Pix pendente: confere com o provedor, no maximo a cada 15 segundos, para a tela atualizar mesmo sem aviso.
    if (app.payments) {
      const stale = (
        await pool.query<{ id: string; provider_payment_id: string }>(
          `SELECT p.id, p.provider_payment_id FROM payments p JOIN orders o ON o.id = p.order_id
           WHERE p.order_id = $1 AND p.status = 'pending' AND p.provider_payment_id IS NOT NULL AND o.status = 'pending_payment' AND p.updated_at < now() - interval '15 seconds'
           ORDER BY p.created_at DESC LIMIT 1`,
          [id],
        )
      ).rows[0];
      if (stale) {
        await pool.query('UPDATE payments SET updated_at = now() WHERE id = $1', [stale.id]);
        await syncPayment(app.payments, stale.id, stale.provider_payment_id).catch((err) => req.log.warn(err, 'consulta de pagamento falhou'));
      }
    }
    return { order: await orderView(pool, id, opts) };
  });

  app.post('/pay/pix', limit, async (req) => {
    const id = await resolve(req);
    const provider = app.payments;
    if (!provider) throw paymentUnavailable();
    const prepared = await tx(null, async (db) => {
      const o = await lockPayable(db, id, 'pix');
      // Pix ainda valido: mostra o mesmo, nao gera outro.
      const open = (
        await db.query(`SELECT id FROM payments WHERE order_id = $1 AND method = 'pix' AND status = 'pending' AND pix_expires_at > now() + interval '2 minutes' ORDER BY created_at DESC LIMIT 1`, [id])
      ).rows[0];
      if (open) return { reuse: true as const };
      const key = randomUUID();
      const pay = (
        await db.query<{ id: string }>(`INSERT INTO payments (order_id, provider, method, idempotency_key, amount_cents) VALUES ($1, $2, 'pix', $3, $4) RETURNING id`, [
          id,
          provider.name,
          key,
          o.total_cents,
        ])
      ).rows[0]!;
      // O Mercado Pago exige ao menos 30 minutos de validade. O pedido acompanha o Pix.
      const expiresAt = new Date(Math.max(o.payment_due_at.getTime(), Date.now() + 31 * 60_000));
      await db.query('UPDATE orders SET payment_due_at = greatest(payment_due_at, $2) WHERE id = $1', [id, expiresAt]);
      return { reuse: false as const, paymentId: pay.id, key, order: o, expiresAt };
    });
    if (!prepared.reuse) {
      const { order: o } = prepared;
      const [first, ...rest] = String(o.buyer.name).split(' ');
      try {
        const p = await provider.createPix({
          idempotencyKey: prepared.key,
          amountCents: Number(o.total_cents),
          description: `Pedido ${o.number}`,
          externalReference: o.id,
          expiresAt: prepared.expiresAt,
          payer: {
            email: o.buyer.email!,
            firstName: first ?? '',
            lastName: rest.join(' '),
            docType: o.buyer.kind === 'pj' ? 'CNPJ' : 'CPF',
            docNumber: o.buyer.document ?? null,
          },
        });
        await tx(null, (db) => applyPayment(db, prepared.paymentId, p));
      } catch (err) {
        req.log.error(err, 'falha ao gerar Pix');
        await pool.query(`UPDATE payments SET status = 'error', status_detail = 'falha ao gerar', updated_at = now() WHERE id = $1 AND status = 'created'`, [prepared.paymentId]);
        throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'Não foi possível gerar o Pix agora. Tente novamente em instantes.');
      }
    }
    return { order: await orderView(pool, id, opts) };
  });

  app.post('/pay/card', limit, async (req) => {
    const id = await resolve(req);
    const provider = app.payments;
    if (!provider) throw paymentUnavailable();
    const b = cardSchema.parse(req.body);
    const prepared = await tx(null, async (db) => {
      // Mesma tentativa repetida: devolve o resultado ja registrado.
      const same = (await db.query('SELECT id FROM payments WHERE idempotency_key = $1', [b.attemptKey])).rows[0];
      if (same) return { reuse: true as const };
      const o = await lockPayable(db, id, 'card');
      const inFlight = (await db.query(`SELECT 1 FROM payments WHERE order_id = $1 AND status IN ('created', 'pending', 'approved')`, [id])).rowCount;
      if (inFlight) throw new AppError(409, 'PAYMENT_IN_PROGRESS', 'Já existe um pagamento em análise para este pedido.');
      const attempts = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM payments WHERE order_id = $1`, [id])).rows[0]!.n;
      if (attempts >= 5) throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Muitas tentativas de pagamento neste pedido. Fale com a loja.');
      const pay = (
        await db.query<{ id: string }>(`INSERT INTO payments (order_id, provider, method, idempotency_key, amount_cents) VALUES ($1, $2, 'card', $3, $4) RETURNING id`, [
          id,
          provider.name,
          b.attemptKey,
          o.total_cents,
        ])
      ).rows[0]!;
      return { reuse: false as const, paymentId: pay.id, order: o };
    });
    if (!prepared.reuse) {
      const { order: o } = prepared;
      try {
        const p = await provider.createCard({
          idempotencyKey: b.attemptKey,
          amountCents: Number(o.total_cents),
          description: `Pedido ${o.number}`,
          externalReference: o.id,
          card: {
            token: b.token,
            paymentMethodId: b.paymentMethodId,
            issuerId: b.issuerId === undefined || b.issuerId === null ? null : String(b.issuerId),
            installments: b.installments,
            payerEmail: b.payer.email,
            payerDocType: b.payer.identification?.type ?? null,
            payerDocNumber: b.payer.identification?.number.replace(/\W/g, '') ?? null,
          },
        });
        await tx(null, (db) => applyPayment(db, prepared.paymentId, p));
      } catch (err) {
        req.log.error(err, 'falha no pagamento com cartao');
        await pool.query(`UPDATE payments SET status = 'error', status_detail = 'falha na comunicacao', updated_at = now() WHERE id = $1 AND status = 'created'`, [prepared.paymentId]);
        throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'Não foi possível processar o cartão agora. Nenhuma cobrança foi confirmada; tente novamente.');
      }
    }
    return { order: await orderView(pool, id, opts) };
  });
}

export async function publicOrderRoutes(app: FastifyInstance) {
  await app.register(
    async (scoped) => {
      orderPaymentRoutes(scoped, async (req) => orderByToken(pool, z.object({ token: z.string().min(10).max(100) }).parse(req.params).token));
    },
    { prefix: '/:token' },
  );
}

export async function customerOrderRoutes(app: FastifyInstance) {
  await app.register(
    async (scoped) => {
      orderPaymentRoutes(scoped, async (req) => {
        const c = requireCustomer(req);
        const { id } = idParams.parse(req.params);
        const ok = (await pool.query('SELECT 1 FROM orders WHERE id = $1 AND customer_id = $2', [id, c.id])).rowCount;
        if (!ok) throw notFound();
        return id;
      });
    },
    { prefix: '/:id' },
  );
}

// ---------------- aviso do provedor (webhook) ----------------

export async function webhookRoutes(app: FastifyInstance) {
  app.post('/mercadopago', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const provider = app.payments;
    if (!provider) return reply.code(503).send({ ok: false });
    const v = provider.verifyNotification({ headers: req.headers, query: req.query as Record<string, unknown> });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const inserted = (
      await pool.query<{ id: string }>(
        `INSERT INTO payment_notifications (provider, dedupe_key, resource_id, payload, signature_valid) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (provider, dedupe_key) DO NOTHING RETURNING id`,
        [provider.name, v.dedupeKey.slice(0, 200), v.resourceId, JSON.stringify({ type: body.type ?? null, action: body.action ?? null }), v.valid],
      )
    ).rows[0];
    if (!v.valid) return reply.code(401).send({ ok: false });
    if (!inserted) return { ok: true, duplicate: true };
    if (body.type && body.type !== 'payment') {
      await pool.query('UPDATE payment_notifications SET processed_at = now(), error = $2 WHERE id = $1', [inserted.id, 'tipo ignorado']);
      return { ok: true };
    }
    try {
      const pay = (await pool.query<{ id: string }>('SELECT id FROM payments WHERE provider = $1 AND provider_payment_id = $2', [provider.name, v.resourceId])).rows[0];
      if (!pay) throw new Error('pagamento desconhecido');
      await syncPayment(provider, pay.id, v.resourceId!);
      await pool.query('UPDATE payment_notifications SET processed_at = now() WHERE id = $1', [inserted.id]);
    } catch (err) {
      await pool.query('UPDATE payment_notifications SET error = $2 WHERE id = $1', [inserted.id, (err as Error).message.slice(0, 300)]);
      // Pagamento ainda nao gravado (corrida com a criacao): a tela do pedido e a rotina de vencimento conferem depois.
    }
    return { ok: true };
  });
}

// ---------------- painel: pedidos ----------------

const listSchema = pageQuery.extend({
  status: z.enum([...ORDER_STATUS, 'open']).optional(),
  q: z.string().trim().max(100).optional(),
});

const NEXT: Record<string, string[]> = { paid: ['preparing'], preparing: ['ready'], ready: [] };

export async function adminOrderRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    requirePermission(req, 'orders.view');
    const q = listSchema.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status === 'open') where.push(`o.status IN ('paid', 'preparing', 'ready')`);
    else if (q.status) {
      params.push(q.status);
      where.push(`o.status = $${params.length}`);
    }
    if (q.q) {
      const n = Number(q.q.replace(/\D/g, ''));
      params.push(likePattern(q.q));
      where.push(`(o.buyer->>'name' ILIKE $${params.length} OR o.buyer->>'email' ILIKE $${params.length}${n ? ` OR o.number = ${Math.min(n, 2_000_000_000)}` : ''})`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM orders o ${w}`, params)).rows[0]!.n;
    const { rows } = await pool.query(
      `SELECT o.id, o.number, o.status, o.channel, o.buyer->>'name' AS buyer_name, o.payment_method, o.total_cents, o.invoice_status, o.has_backorder,
              o.shipping_snapshot->>'name' AS shipping_name, o.shipping_snapshot->>'kind' AS shipping_kind, o.created_at, o.paid_at, o.payment_due_at
       FROM orders o ${w} ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    );
    const counts = (await pool.query(`SELECT status, count(*)::int AS n FROM orders GROUP BY status`)).rows;
    return { orders: rows, total, page: q.page, pageSize: q.pageSize, counts };
  });

  app.get('/:id', async (req) => {
    requirePermission(req, 'orders.view');
    const { id } = idParams.parse(req.params);
    const order = await orderView(pool, id, { staff: true });
    const reservations = (
      await pool.query(
        `SELECT r.id, r.variant_id, v.sku, r.qty, r.backorder, r.status FROM stock_reservations r JOIN product_variants v ON v.id = r.variant_id
         WHERE r.source_type = 'order' AND r.source_id = $1 ORDER BY v.sku`,
        [id],
      )
    ).rows;
    return { order: { ...order, reservations } };
  });

  app.post('/:id/status', async (req) => {
    const auth = requirePermission(req, 'orders.manage');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ to: z.enum(['preparing', 'ready']), version: z.number().int(), note: z.string().trim().max(300).optional() }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const o = (await db.query<{ status: string; version: number }>('SELECT status, version FROM orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!o) throw notFound();
      if (o.version !== b.version) throw new AppError(409, 'VERSION_CONFLICT', 'O pedido foi alterado por outra pessoa. Recarregue a página.');
      if (!NEXT[o.status]?.includes(b.to)) throw new AppError(409, 'INVALID_TRANSITION', 'Esta mudança de situação não é permitida agora.');
      await db.query('UPDATE orders SET status = $2, updated_at = now(), version = version + 1 WHERE id = $1', [id, b.to]);
      await addEvent(db, id, b.to, b.note || null, auth.userId);
      await audit(db, { actorId: auth.userId, action: 'order.status', entity: 'order', entityId: id, before: { status: o.status }, after: { status: b.to }, ip: auth.ip });
      return { order: await orderView(db, id, { staff: true }) };
    });
  });

  app.post('/:id/cancel', async (req) => {
    const auth = requirePermission(req, 'orders.manage');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ reason: z.string().trim().min(3).max(300), version: z.number().int() }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const o = (await db.query<{ status: string; version: number; invoice_status: string }>('SELECT status, version, invoice_status FROM orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!o) throw notFound();
      if (o.version !== b.version) throw new AppError(409, 'VERSION_CONFLICT', 'O pedido foi alterado por outra pessoa. Recarregue a página.');
      if (!['pending_payment', 'paid', 'preparing', 'ready'].includes(o.status)) throw new AppError(409, 'INVALID_TRANSITION', 'Pedido já despachado ou cancelado.');
      // Nota emitida (ou em emissao) precisa ser cancelada antes, no modulo fiscal.
      if (o.invoice_status === 'authorized' || o.invoice_status === 'processing') {
        throw new AppError(409, 'INVOICE_ACTIVE', 'O pedido tem NF-e autorizada ou em processamento. Cancele a nota antes de cancelar o pedido.');
      }
      const wasPaid = o.status !== 'pending_payment';
      await db.query(`UPDATE orders SET status = 'canceled', canceled_at = now(), cancel_reason = $2, updated_at = now(), version = version + 1 WHERE id = $1`, [id, b.reason]);
      await db.query(`UPDATE payments SET status = 'canceled', updated_at = now() WHERE order_id = $1 AND status IN ('created', 'pending')`, [id]);
      const released = await releaseOrderReservations(db, auth.userId, id);
      await addEvent(db, id, 'canceled', wasPaid ? `${b.reason} — pedido pago: devolver o valor pelo painel do Mercado Pago.` : b.reason, auth.userId);
      await audit(db, { actorId: auth.userId, action: 'order.cancel', entity: 'order', entityId: id, before: { status: o.status }, after: { status: 'canceled', reason: b.reason, released }, ip: auth.ip });
      return { order: await orderView(db, id, { staff: true }), refundNeeded: wasPaid };
    });
  });

  /** Despacho: so com NF-e autorizada. Baixa o estoque consumindo as reservas do pedido. */
  app.post('/:id/dispatch', async (req) => {
    const auth = requirePermission(req, 'shipping.manage');
    const { id } = idParams.parse(req.params);
    const b = z
      .strictObject({
        version: z.number().int(),
        carrier: z.string().trim().max(80).optional().nullable(),
        trackingCode: z.string().trim().max(60).optional().nullable(),
        trackingUrl: z.url().max(300).optional().nullable(),
        volumes: z.number().int().min(1).max(999).optional().nullable(),
        weightG: z.number().int().min(1).max(10_000_000).optional().nullable(),
      })
      .parse(req.body);
    return tx(auth.userId, async (db) => {
      const o = (await db.query<{ status: string; version: number; invoice_status: string }>('SELECT status, version, invoice_status FROM orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!o) throw notFound();
      if (o.version !== b.version) throw new AppError(409, 'VERSION_CONFLICT', 'O pedido foi alterado por outra pessoa. Recarregue a página.');
      if (o.status !== 'ready') throw new AppError(409, 'INVALID_TRANSITION', 'Só pedidos separados (prontos) podem ser despachados.');
      if (o.invoice_status !== 'authorized' && o.invoice_status !== 'not_required') {
        throw new AppError(409, 'INVOICE_REQUIRED', 'Emita e autorize a NF-e antes de despachar a mercadoria.');
      }
      const res = (await db.query<{ id: string }>(`SELECT id FROM stock_reservations WHERE source_type = 'order' AND source_id = $1 AND status = 'active'`, [id])).rows;
      for (const r of res) await consumeReservation(db, auth.userId, r.id, { sourceType: 'order', sourceId: id });
      await db.query(
        `INSERT INTO shipments (order_id, carrier, tracking_code, tracking_url, volumes, weight_g, shipped_at, shipped_by) VALUES ($1, $2, $3, $4, $5, $6, now(), $7)`,
        [id, b.carrier || null, b.trackingCode || null, b.trackingUrl || null, b.volumes ?? null, b.weightG ?? null, auth.userId],
      );
      await db.query(`UPDATE orders SET status = 'shipped', updated_at = now(), version = version + 1 WHERE id = $1`, [id]);
      await addEvent(db, id, 'shipped', b.trackingCode ? `Código de rastreio ${b.trackingCode}` : null, auth.userId);
      await audit(db, { actorId: auth.userId, action: 'order.dispatch', entity: 'order', entityId: id, after: { carrier: b.carrier, trackingCode: b.trackingCode }, ip: auth.ip });
      return { order: await orderView(db, id, { staff: true }) };
    });
  });

  app.post('/:id/deliver', async (req) => {
    const auth = requirePermission(req, 'shipping.manage');
    const { id } = idParams.parse(req.params);
    const { version } = z.strictObject({ version: z.number().int() }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const o = (await db.query<{ status: string; version: number }>('SELECT status, version FROM orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!o) throw notFound();
      if (o.version !== version) throw new AppError(409, 'VERSION_CONFLICT', 'O pedido foi alterado por outra pessoa. Recarregue a página.');
      if (o.status !== 'shipped') throw new AppError(409, 'INVALID_TRANSITION', 'Só pedidos despachados podem ser marcados como entregues.');
      await db.query('UPDATE shipments SET delivered_at = now() WHERE order_id = $1', [id]);
      await db.query(`UPDATE orders SET status = 'delivered', updated_at = now(), version = version + 1 WHERE id = $1`, [id]);
      await addEvent(db, id, 'delivered', null, auth.userId);
      return { order: await orderView(db, id, { staff: true }) };
    });
  });
}

// ---------------- painel: formas de entrega ----------------

const cepRange = z
  .string()
  // Aceita "89460-000 a 89479-999", "89460000-89479999" ou um CEP so: conta os digitos.
  .transform((v) => {
    const d = v.replace(/\D/g, '');
    return d.length === 16 ? `${d.slice(0, 8)}-${d.slice(8)}` : d;
  })
  .pipe(z.string().regex(/^\d{8}(-\d{8})?$/, 'Faixa de CEP no formato 89460000-89479999.'))
  .refine((v) => {
    const [a, b] = v.split('-');
    return !b || a! <= b;
  }, 'Início da faixa maior que o fim.');

const shippingSchema = z
  .strictObject({
    name: z.string().trim().min(2).max(80),
    kind: z.enum(['pickup', 'delivery']),
    description: z.string().trim().max(300).optional().nullable(),
    cepRanges: z.array(cepRange).max(200).default([]),
    baseCents: z.number().int().min(0).max(100_000_000),
    perKgCents: z.number().int().min(0).max(10_000_000).default(0),
    freeAboveCents: z.number().int().min(1).max(1_000_000_000).optional().nullable(),
    maxWeightG: z.number().int().min(1).max(100_000_000).optional().nullable(),
    minDays: z.number().int().min(0).max(60),
    maxDays: z.number().int().min(0).max(60),
    active: z.boolean().default(true),
    position: z.number().int().min(0).max(1000).default(0),
  })
  .refine((v) => v.maxDays >= v.minDays, { message: 'Prazo máximo menor que o mínimo.', path: ['maxDays'] })
  .refine((v) => v.kind === 'pickup' || v.cepRanges.length > 0, { message: 'Entrega precisa de ao menos uma faixa de CEP.', path: ['cepRanges'] });

const SHIP_COLS = `id, name, kind, description, cep_ranges, base_cents, per_kg_cents, free_above_cents, max_weight_g, min_days, max_days, active, position`;

export async function shippingOptionRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    requirePermission(req, 'orders.view');
    return { options: (await pool.query(`SELECT ${SHIP_COLS} FROM shipping_options ORDER BY position, name`)).rows };
  });

  const save = async (req: FastifyRequest, id: string | null) => {
    const auth = requirePermission(req, 'settings.manage');
    const s = shippingSchema.parse(req.body);
    const params = [s.name, s.kind, s.description || null, s.kind === 'pickup' ? [] : s.cepRanges, s.baseCents, s.kind === 'pickup' ? 0 : s.perKgCents, s.freeAboveCents ?? null, s.maxWeightG ?? null, s.minDays, s.maxDays, s.active, s.position];
    return tx(auth.userId, async (db) => {
      const before = id ? (await db.query(`SELECT ${SHIP_COLS} FROM shipping_options WHERE id = $1 FOR UPDATE`, [id])).rows[0] : null;
      if (id && !before) throw notFound();
      const row = id
        ? (
            await db.query(
              `UPDATE shipping_options SET name = $2, kind = $3, description = $4, cep_ranges = $5, base_cents = $6, per_kg_cents = $7, free_above_cents = $8,
                 max_weight_g = $9, min_days = $10, max_days = $11, active = $12, position = $13 WHERE id = $1 RETURNING ${SHIP_COLS}`,
              [id, ...params],
            )
          ).rows[0]
        : (
            await db.query(
              `INSERT INTO shipping_options (name, kind, description, cep_ranges, base_cents, per_kg_cents, free_above_cents, max_weight_g, min_days, max_days, active, position)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING ${SHIP_COLS}`,
              params,
            )
          ).rows[0];
      await audit(db, { actorId: auth.userId, action: id ? 'shipping_option.update' : 'shipping_option.create', entity: 'shipping_option', entityId: row.id, before, after: row, ip: auth.ip });
      return { option: row };
    });
  };

  app.post('/', async (req, reply) => reply.code(201).send(await save(req, null)));
  app.put('/:id', async (req) => save(req, idParams.parse(req.params).id));
}

// ---------------- desenvolvimento: simular pagamento do provedor de teste ----------------

export async function fakePaymentRoutes(app: FastifyInstance) {
  if (isProduction || app.payments?.name !== 'fake') return;
  app.post('/:token/approve-pix', async (req) => {
    const { token } = z.object({ token: z.string().min(10).max(100) }).parse(req.params);
    const id = await orderByToken(pool, token);
    const p = (await pool.query<{ id: string; provider_payment_id: string }>(`SELECT id, provider_payment_id FROM payments WHERE order_id = $1 AND method = 'pix' AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, [id])).rows[0];
    if (!p) throw notFound();
    const fake = app.payments as unknown as { settle(id: string, s: 'approved'): void };
    fake.settle(p.provider_payment_id, 'approved');
    await syncPayment(app.payments!, p.id, p.provider_payment_id);
    return { order: await orderView(pool, id) };
  });
}
