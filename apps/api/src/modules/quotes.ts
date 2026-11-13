import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { keyedHash, sha256 } from '../lib/crypto.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, likePattern, pageQuery } from '../lib/http.js';
import { cartWeight, priceLines, type CartLine } from '../lib/pricing.js';
import { requirePermission } from './auth.js';
import { addressSchema, documentFor, personSchema } from './customers.js';
import { insertOrder, orderView, publicToken as orderToken } from './orders.js';
import { quoteShipping, type ShippingQuote } from './storefront.js';

type Q = Db | typeof pool;

/** Link publico do orcamento: derivado do id com a chave do servidor (nao fica em texto no banco). */
export const quoteToken = (id: string) => keyedHash(`quote-link:${id}`);

// Dados do cliente no orcamento: nome e telefone bastam; o resto o cliente completa ao aceitar.
const quoteBuyer = z.strictObject({
  kind: z.enum(['pf', 'pj']).default('pf'),
  name: z.string().trim().min(2).max(150),
  phone: personSchema.shape.phone,
  email: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase())
    .optional()
    .nullable(),
  document: z.string().trim().max(20).optional().nullable(),
  stateRegistration: z.string().trim().max(20).optional().nullable(),
});
type QuoteBuyer = z.infer<typeof quoteBuyer>;

const itemsSchema = z
  .array(z.strictObject({ packagingId: z.uuid(), packs: z.number().int().min(1).max(100_000) }))
  .min(1)
  .max(100)
  .refine((items) => new Set(items.map((i) => i.packagingId)).size === items.length, 'Embalagem repetida no orçamento.');

const createSchema = z.strictObject({
  requestKey: z.string().min(8).max(100),
  buyer: quoteBuyer,
  items: itemsSchema,
  shippingOptionId: z.uuid().optional().nullable(),
  address: addressSchema.optional().nullable(),
  discountCents: z.number().int().min(0).default(0),
  notes: z.string().trim().max(500).optional().nullable(),
  validDays: z.number().int().min(1).max(30).default(7),
});

// Ao converter: forma de pagamento e o que faltou no orcamento (documento, e-mail, entrega).
const convertSchema = z.strictObject({
  paymentMethod: z.enum(['pix', 'card']),
  buyer: z
    .strictObject({
      email: z.email().max(254).optional().nullable(),
      document: z.string().trim().max(20).optional().nullable(),
      stateRegistration: z.string().trim().max(20).optional().nullable(),
      kind: z.enum(['pf', 'pj']).optional(),
    })
    .optional(),
  shippingOptionId: z.uuid().optional().nullable(),
  address: addressSchema.optional().nullable(),
});

const missingBuyer = (b: QuoteBuyer) => [...(!b.email ? ['email'] : []), ...(!b.document || !documentFor(b.kind, b.document) ? ['document'] : [])];

function checkDocument(b: { kind: 'pf' | 'pj'; document?: string | null }) {
  if (!b.document) return null;
  const d = documentFor(b.kind, b.document);
  if (!d) throw new AppError(400, 'INVALID_DOCUMENT', b.kind === 'pf' ? 'CPF inválido.' : 'CNPJ inválido.');
  return d;
}

/** Itens com preco e disponibilidade de agora. Produto fora da loja nao entra no orcamento. */
async function pricedItems(db: Q, items: { packagingId: string; packs: number }[]) {
  const lines = await priceLines(db, items);
  const bad = items.filter((i) => !lines.some((l) => l.packagingId === i.packagingId && l.status !== 'unavailable'));
  if (bad.length) throw new AppError(422, 'ITEM_UNAVAILABLE', 'Há item fora de venda no orçamento.', { packagingIds: bad.map((b) => b.packagingId) });
  return lines;
}

async function shippingFor(db: Q, lines: CartLine[], subtotal: number, optionId: string | null | undefined, address: z.infer<typeof addressSchema> | null | undefined) {
  if (!optionId) return null;
  const w = cartWeight(lines);
  const options = await quoteShipping(db, address?.cep ?? null, subtotal, w.grams, w.missing.length > 0);
  const ship = options.find((o) => o.id === optionId);
  if (!ship && !address) {
    const kind = (await db.query<{ kind: string }>('SELECT kind FROM shipping_options WHERE id = $1 AND active', [optionId])).rows[0]?.kind;
    if (kind === 'delivery') throw new AppError(400, 'ADDRESS_REQUIRED', 'Informe o endereço de entrega.');
  }
  if (!ship) throw new AppError(422, 'SHIPPING_UNAVAILABLE', 'Esta forma de entrega não atende o endereço informado.');
  if (ship.kind === 'delivery' && !address) throw new AppError(400, 'ADDRESS_REQUIRED', 'Informe o endereço de entrega.');
  return ship;
}

const QUOTE_COLS = `q.id, q.number, q.status, q.buyer, q.customer_id, q.ship_to, q.shipping_option_id, q.shipping_snapshot, q.subtotal_cents, q.discount_cents, q.freight_cents,
  q.total_cents, q.notes, q.valid_until::text AS valid_until, q.order_id, q.conversions, q.shared_at, q.canceled_at, q.cancel_reason, q.created_at, q.updated_at,
  q.valid_until < (now() AT TIME ZONE 'America/Sao_Paulo')::date AS expired`;

export async function quoteView(db: Q, id: string) {
  const q = (
    await db.query(
      `SELECT ${QUOTE_COLS}, u.name AS created_by_name, o.number AS order_number, o.status AS order_status
       FROM quotes q JOIN users u ON u.id = q.created_by LEFT JOIN orders o ON o.id = q.order_id WHERE q.id = $1`,
      [id],
    )
  ).rows[0];
  if (!q) throw notFound();
  const items = (
    await db.query(
      `SELECT qi.id, qi.variant_id, qi.packaging_id, qi.sku, qi.product_name, qi.packaging_label, qi.base_qty_per_pack, qi.packs, qi.list_price_cents, qi.unit_price_cents,
              qi.total_cents, qi.made_to_order, qi.lead_time_days, p.slug
       FROM quote_items qi JOIN product_variants v ON v.id = qi.variant_id JOIN products p ON p.id = v.product_id WHERE qi.quote_id = $1 ORDER BY qi.position`,
      [id],
    )
  ).rows;
  const events = (
    await db.query('SELECT e.kind, e.note, e.created_at, u.name AS actor_name FROM quote_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.quote_id = $1 ORDER BY e.id', [id])
  ).rows;
  return { ...q, items, events, token: quoteToken(q.id), missing: missingBuyer(q.buyer) };
}

/** O que o cliente ve pelo link: sem telefone, e-mail ou documento, so o que falta preencher. */
async function publicQuoteView(db: Q, id: string) {
  const q = await quoteView(db, id);
  return {
    number: q.number,
    status: q.status,
    expired: q.expired,
    validUntil: q.valid_until,
    buyerName: q.buyer.name,
    buyerKind: q.buyer.kind,
    missing: q.missing,
    shipping: q.shipping_snapshot ? { id: q.shipping_snapshot.id, name: q.shipping_snapshot.name, kind: q.shipping_snapshot.kind, minDays: q.shipping_snapshot.minDays, maxDays: q.shipping_snapshot.maxDays } : null,
    hasAddress: Boolean(q.ship_to),
    subtotalCents: q.subtotal_cents,
    discountCents: q.discount_cents,
    freightCents: q.freight_cents,
    totalCents: q.total_cents,
    notes: q.notes,
    items: q.items.map((i: Record<string, unknown>) => ({
      sku: i.sku,
      productName: i.product_name,
      packagingLabel: i.packaging_label,
      packs: i.packs,
      unitPriceCents: i.unit_price_cents,
      listPriceCents: i.list_price_cents,
      totalCents: i.total_cents,
      madeToOrder: i.made_to_order,
      leadTimeDays: i.lead_time_days,
      slug: i.slug,
    })),
    orderToken: q.order_id && q.order_status !== 'canceled' ? orderToken(`quote:${q.id}:${q.conversions}`) : null,
  };
}

async function addQuoteEvent(db: Db, quoteId: string, kind: string, note: string | null, actorId: string | null) {
  await db.query('INSERT INTO quote_events (quote_id, kind, note, actor_id) VALUES ($1, $2, $3, $4)', [quoteId, kind, note, actorId]);
}

type CreateInput = z.infer<typeof createSchema>;

async function createQuote(db: Db, b: CreateInput, actorId: string, canDiscount: boolean, eventNote: string | null = null) {
  const prior = (await db.query<{ id: string }>('SELECT id FROM quotes WHERE request_key = $1', [b.requestKey])).rows[0];
  if (prior) return { id: prior.id, replay: true };
  const document = checkDocument(b.buyer);
  if (b.discountCents && !canDiscount) throw new AppError(403, 'DISCOUNT_FORBIDDEN', 'Desconto no orçamento exige a permissão de preços.');
  const lines = await pricedItems(db, b.items);
  const subtotal = lines.reduce((s, l) => s + l.totalCents, 0);
  if (b.discountCents >= subtotal) throw new AppError(422, 'DISCOUNT_TOO_HIGH', 'O desconto precisa ser menor que o total dos itens.');
  const ship = await shippingFor(db, lines, subtotal, b.shippingOptionId, b.address);
  const freight = ship?.priceCents ?? 0;
  const buyer = { ...b.buyer, document, email: b.buyer.email || null, stateRegistration: b.buyer.stateRegistration || null };
  const customer = buyer.email ? (await db.query<{ id: string }>('SELECT id FROM customers WHERE email = $1 AND is_active', [buyer.email])).rows[0] : undefined;
  const id = randomUUID();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO quotes (id, public_token_hash, request_key, buyer, customer_id, ship_to, shipping_option_id, shipping_snapshot, subtotal_cents, discount_cents, freight_cents,
                         total_cents, notes, valid_until, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, (now() AT TIME ZONE 'America/Sao_Paulo')::date + $14::int, $15)
     ON CONFLICT (request_key) DO NOTHING RETURNING id`,
    [
      id,
      sha256(quoteToken(id)),
      b.requestKey,
      JSON.stringify(buyer),
      customer?.id ?? null,
      ship?.kind === 'delivery' ? JSON.stringify(b.address) : null,
      ship?.id ?? null,
      ship ? JSON.stringify(ship) : null,
      subtotal,
      b.discountCents,
      freight,
      subtotal - b.discountCents + freight,
      b.notes || null,
      b.validDays,
      actorId,
    ],
  );
  if (!rows[0]) return { id: (await db.query<{ id: string }>('SELECT id FROM quotes WHERE request_key = $1', [b.requestKey])).rows[0]!.id, replay: true };
  let pos = 0;
  for (const l of lines) {
    await db.query(
      `INSERT INTO quote_items (quote_id, position, variant_id, packaging_id, sku, product_name, packaging_label, base_qty_per_pack, packs, list_price_cents, unit_price_cents, total_cents,
                                made_to_order, lead_time_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [id, pos++, l.variantId, l.packagingId, l.sku, l.productName, l.label, l.baseQty, l.packs, l.listPriceCents, l.unitPriceCents, l.totalCents, l.madeToOrder, l.leadTimeDays],
    );
  }
  await addQuoteEvent(db, id, 'created', eventNote, actorId);
  await audit(db, { actorId, action: 'sales.quote_created', entity: 'quote', entityId: id, after: { totalCents: subtotal - b.discountCents + freight, discountCents: b.discountCents } });
  return { id, replay: false };
}

/**
 * Orcamento -> pedido com os precos do orcamento (validos ate a data). A chave do pedido vem do orcamento e da
 * tentativa: repetir a conversao devolve o mesmo pedido; se o pedido anterior foi cancelado (prazo de pagamento),
 * a conversao seguinte cria outro.
 */
export async function convertQuote(db: Db, quoteId: string, b: z.infer<typeof convertSchema>, actorId: string | null) {
  const q = (await db.query(`SELECT q.*, q.valid_until < (now() AT TIME ZONE 'America/Sao_Paulo')::date AS expired FROM quotes q WHERE q.id = $1 FOR UPDATE`, [quoteId])).rows[0];
  if (!q) throw notFound();
  if (q.status === 'canceled') throw new AppError(409, 'QUOTE_CANCELED', 'Este orçamento foi cancelado.');
  // Dados completados numa conversao anterior (pedido cancelado) valem de novo: o cliente nao redigita.
  let prev: Partial<QuoteBuyer> = {};
  if (q.order_id) {
    const o = (await db.query<{ status: string; buyer: QuoteBuyer }>('SELECT status, buyer FROM orders WHERE id = $1', [q.order_id])).rows[0]!;
    if (o.status !== 'canceled') return { orderId: q.order_id as string, requestKey: `quote:${q.id}:${q.conversions}`, replay: true };
    prev = o.buyer;
  }
  if (q.expired) throw new AppError(409, 'QUOTE_EXPIRED', 'Este orçamento venceu. Peça um novo orçamento com os preços atuais.');

  // Os dados do orcamento prevalecem; o que vem agora so preenche o que faltou.
  const saved = q.buyer as QuoteBuyer;
  const kind = saved.document ? saved.kind : (b.buyer?.kind ?? prev.kind ?? saved.kind);
  const merged = {
    kind,
    name: saved.name,
    phone: saved.phone,
    email: saved.email || b.buyer?.email || prev.email || '',
    document: saved.document || b.buyer?.document || prev.document || '',
    stateRegistration: saved.stateRegistration || b.buyer?.stateRegistration || prev.stateRegistration || null,
  };
  const parsed = personSchema.safeParse(merged);
  if (!parsed.success) throw new AppError(400, 'BUYER_INCOMPLETE', 'Complete os dados do comprador (e-mail e CPF/CNPJ) para gerar o pedido.');
  const document = documentFor(parsed.data.kind, parsed.data.document);
  if (!document) throw new AppError(400, 'INVALID_DOCUMENT', parsed.data.kind === 'pf' ? 'CPF inválido.' : 'CNPJ inválido.');

  const items = (
    await db.query<{ variant_id: string; packaging_id: string; sku: string; product_name: string; packaging_label: string; base_qty_per_pack: string; packs: number; list_price_cents: string; unit_price_cents: string; total_cents: string; made_to_order: boolean; lead_time_days: number | null }>(
      'SELECT * FROM quote_items WHERE quote_id = $1 ORDER BY position',
      [q.id],
    )
  ).rows;
  // Disponibilidade e de agora; o preco e o do orcamento.
  const now = await priceLines(db, items.map((i) => ({ packagingId: i.packaging_id, packs: i.packs })));
  const blocking = items
    .filter((i) => {
      const l = now.find((n) => n.packagingId === i.packaging_id);
      return !l || l.status !== 'ok';
    })
    .map((i) => i.sku);
  if (blocking.length) throw new AppError(409, 'QUOTE_BLOCKED', 'Alguns itens do orçamento não estão mais disponíveis. Faça um novo orçamento.', { blocking });

  let ship: ShippingQuote | null = q.shipping_snapshot;
  let shipTo = q.ship_to;
  let freight = Number(q.freight_cents);
  if (!ship) {
    const s = await shippingFor(db, now, Number(q.subtotal_cents), b.shippingOptionId, b.address);
    if (!s) throw new AppError(400, 'SHIPPING_REQUIRED', 'Escolha a forma de entrega.');
    ship = s;
    shipTo = s.kind === 'delivery' ? b.address : null;
    freight = s.priceCents;
  }

  // Prazo de pagamento: ate o fim do dia de validade (minimo 1 hora, maximo 24 horas).
  const due = (
    await db.query<{ m: number }>(
      `SELECT greatest(60, least(1440, ceil(extract(epoch FROM (($1::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo') - now()) / 60)))::int AS m`,
      [q.valid_until],
    )
  ).rows[0]!.m;
  const attempt = q.conversions + 1;
  const requestKey = `quote:${q.id}:${attempt}`;
  const order = await insertOrder(
    db,
    {
      requestKey,
      customerId: q.customer_id,
      channel: 'sales_desk',
      buyer: { ...parsed.data, document, stateRegistration: parsed.data.stateRegistration || null },
      shipTo,
      shipping: ship,
      paymentMethod: b.paymentMethod,
      subtotalCents: Number(q.subtotal_cents),
      discountCents: Number(q.discount_cents),
      freightCents: freight,
      notes: q.notes,
      dueMinutes: due,
      eventNote: `Pedido criado a partir do orçamento Nº ${q.number}`,
    },
    items.map((i) => ({
      variantId: i.variant_id,
      packagingId: i.packaging_id,
      sku: i.sku,
      productName: i.product_name,
      label: i.packaging_label,
      baseQty: i.base_qty_per_pack,
      packs: i.packs,
      listPriceCents: Number(i.list_price_cents),
      unitPriceCents: Number(i.unit_price_cents),
      totalCents: Number(i.total_cents),
      madeToOrder: i.made_to_order,
      leadTimeDays: i.lead_time_days,
    })),
  );
  await db.query(`UPDATE quotes SET status = 'converted', order_id = $2, conversions = $3, updated_at = now() WHERE id = $1`, [q.id, order.id, attempt]);
  await addQuoteEvent(db, q.id, 'converted', `Pedido Nº ${order.number}${actorId ? '' : ' (aceito pelo cliente)'}`, actorId);
  return { orderId: order.id, requestKey, replay: false };
}

const listSchema = pageQuery.extend({ status: z.enum(['open', 'converted', 'canceled', 'expired']).optional(), q: z.string().trim().max(100).optional() });

export async function salesDeskRoutes(app: FastifyInstance) {
  /** Busca rapida do balcao: nome, SKU ou codigo de barras, com preco, faixas e saldo disponivel. */
  app.get('/search', async (req) => {
    requirePermission(req, 'sales_desk.use');
    const { q } = z.object({ q: z.string().trim().min(1).max(100) }).parse(req.query);
    const digits = /^\d{8,14}$/.test(q) ? q : null;
    const { rows } = await pool.query(
      `SELECT k.id AS packaging_id, k.label, k.base_qty, k.price_cents, v.id AS variant_id, v.sku, v.attributes, p.id AS product_id, p.name, p.slug, p.base_unit,
              p.availability_mode, p.lead_time_days,
              coalesce((SELECT json_agg(json_build_object('minPacks', t.min_packs, 'priceCents', t.price_cents) ORDER BY t.min_packs) FROM price_tiers t WHERE t.packaging_id = k.id), '[]') AS tiers,
              (SELECT im.file_key FROM product_images im WHERE im.product_id = p.id ORDER BY im.is_primary DESC, im.position LIMIT 1) AS image_key,
              (coalesce(b.on_hand, 0) - coalesce(b.reserved, 0))::numeric(14,3)::text AS available,
              floor((coalesce(b.on_hand, 0) - coalesce(b.reserved, 0)) / k.base_qty)::int AS packs_available
       FROM packagings k JOIN product_variants v ON v.id = k.variant_id JOIN products p ON p.id = v.product_id LEFT JOIN stock_balances b ON b.variant_id = v.id
       WHERE k.kind = 'sale' AND k.active AND v.active AND p.status = 'active' AND k.price_cents IS NOT NULL
         AND (p.name ILIKE $1 OR v.sku ILIKE $1 OR ($2::text IS NOT NULL AND (v.barcode = $2 OR k.barcode = $2)))
       ORDER BY ($2::text IS NOT NULL AND (v.barcode = $2 OR k.barcode = $2)) DESC, p.name, v.sku, k.base_qty LIMIT 40`,
      [likePattern(q), digits],
    );
    return { results: rows, storeUrl: config.APP_ORIGIN };
  });

  app.get('/quotes', async (req) => {
    requirePermission(req, 'sales_desk.use');
    const f = listSchema.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.status === 'expired') where.push(`q.status = 'open' AND q.valid_until < (now() AT TIME ZONE 'America/Sao_Paulo')::date`);
    else if (f.status === 'open') where.push(`q.status = 'open' AND q.valid_until >= (now() AT TIME ZONE 'America/Sao_Paulo')::date`);
    else if (f.status) {
      params.push(f.status);
      where.push(`q.status = $${params.length}`);
    }
    if (f.q) {
      params.push(likePattern(f.q));
      where.push(`(q.buyer->>'name' ILIKE $${params.length} OR q.buyer->>'phone' ILIKE $${params.length} OR q.number::text = $${params.length + 1})`);
      params.push(f.q);
    }
    params.push(f.pageSize, (f.page - 1) * f.pageSize);
    const { rows } = await pool.query(
      `SELECT ${QUOTE_COLS}, (SELECT count(*)::int FROM quote_items qi WHERE qi.quote_id = q.id) AS item_count, o.number AS order_number, o.status AS order_status
       FROM quotes q LEFT JOIN orders o ON o.id = q.order_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY q.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: rows };
  });

  app.post('/quotes', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = requirePermission(req, 'sales_desk.use');
    const b = createSchema.parse(req.body);
    const canDiscount = b.discountCents > 0 ? Boolean(requirePermission(req, 'prices.manage')) : false;
    const r = await tx(auth.userId, (db) => createQuote(db, b, auth.userId, canDiscount));
    return reply.code(r.replay ? 200 : 201).send({ quote: await quoteView(pool, r.id), replay: r.replay });
  });

  app.get('/quotes/:id', async (req) => {
    requirePermission(req, 'sales_desk.use');
    return { quote: await quoteView(pool, idParams.parse(req.params).id) };
  });

  /** Registro de que o link foi compartilhado (o envio em si e feito pela pessoa, no WhatsApp dela). */
  app.post('/quotes/:id/shared', async (req) => {
    const auth = requirePermission(req, 'sales_desk.use');
    const { id } = idParams.parse(req.params);
    const { channel } = z.strictObject({ channel: z.enum(['whatsapp', 'link']) }).parse(req.body);
    await tx(auth.userId, async (db) => {
      const r = await db.query('UPDATE quotes SET shared_at = coalesce(shared_at, now()), updated_at = now() WHERE id = $1 RETURNING id', [id]);
      if (!r.rowCount) throw notFound();
      await addQuoteEvent(db, id, 'shared', channel === 'whatsapp' ? 'Link aberto no WhatsApp' : 'Link copiado', auth.userId);
    });
    return { quote: await quoteView(pool, id) };
  });

  app.post('/quotes/:id/cancel', async (req) => {
    const auth = requirePermission(req, 'sales_desk.use');
    const { id } = idParams.parse(req.params);
    const { reason } = z.strictObject({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    await tx(auth.userId, async (db) => {
      const q = (await db.query<{ status: string }>('SELECT status FROM quotes WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!q) throw notFound();
      if (q.status !== 'open') throw new AppError(409, 'QUOTE_NOT_OPEN', 'Só orçamento em aberto pode ser cancelado.');
      await db.query(`UPDATE quotes SET status = 'canceled', canceled_at = now(), cancel_reason = $2, updated_at = now() WHERE id = $1`, [id, reason]);
      await addQuoteEvent(db, id, 'canceled', reason, auth.userId);
      await audit(db, { actorId: auth.userId, action: 'sales.quote_canceled', entity: 'quote', entityId: id, after: { reason } });
    });
    return { quote: await quoteView(pool, id) };
  });

  /** Novo orcamento com os mesmos itens e cliente, com os precos e o frete de agora. */
  app.post('/quotes/:id/duplicate', async (req, reply) => {
    const auth = requirePermission(req, 'sales_desk.use');
    const { id } = idParams.parse(req.params);
    const { requestKey, validDays } = z.strictObject({ requestKey: z.string().min(8).max(100), validDays: z.number().int().min(1).max(30).default(7) }).parse(req.body);
    const r = await tx(auth.userId, async (db) => {
      const src = await quoteView(db, id);
      const out = await createQuote(
        db,
        {
          requestKey,
          buyer: src.buyer,
          items: src.items.map((i: { packaging_id: string; packs: number }) => ({ packagingId: i.packaging_id, packs: i.packs })),
          shippingOptionId: src.shipping_option_id,
          address: src.ship_to,
          discountCents: 0,
          notes: src.notes,
          validDays,
        },
        auth.userId,
        false,
        `Cópia do orçamento Nº ${src.number}`,
      );
      if (!out.replay) await addQuoteEvent(db, id, 'duplicated', 'Novo orçamento com preços atuais', auth.userId);
      return out;
    });
    return reply.code(r.replay ? 200 : 201).send({ quote: await quoteView(pool, r.id), replay: r.replay });
  });

  app.post('/quotes/:id/convert', async (req, reply) => {
    const auth = requirePermission(req, 'sales_desk.use');
    if (!app.payments) throw new AppError(503, 'PAYMENT_UNAVAILABLE', 'Pagamento online desligado: o pedido não teria como ser pago.');
    const { id } = idParams.parse(req.params);
    const b = convertSchema.parse(req.body);
    const r = await tx(auth.userId, (db) => convertQuote(db, id, b, auth.userId));
    return reply
      .code(r.replay ? 200 : 201)
      .send({ order: await orderView(pool, r.orderId, { staff: true }), orderToken: orderToken(r.requestKey), quote: await quoteView(pool, id), replay: r.replay });
  });
}

async function quoteByToken(token: string) {
  if (token.length > 100) throw notFound();
  const row = (await pool.query<{ id: string }>('SELECT id FROM quotes WHERE public_token_hash = $1', [sha256(token)])).rows[0];
  if (!row) throw notFound();
  return row.id;
}

/** Link publico do orcamento: o cliente ve, completa o que falta e aceita, sem redigitar os itens. */
export async function publicQuoteRoutes(app: FastifyInstance) {
  const limit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const tokenOf = (req: FastifyRequest) => z.object({ token: z.string().min(10).max(100) }).parse(req.params).token;

  app.get('/:token', limit, async (req) => {
    const id = await quoteByToken(tokenOf(req));
    return { quote: await publicQuoteView(pool, id) };
  });

  /** Formas de entrega para o orcamento sem frete definido, calculadas com os itens dele (nao com o carrinho). */
  app.get('/:token/shipping', limit, async (req) => {
    const id = await quoteByToken(tokenOf(req));
    const { cep } = z
      .object({ cep: z.string().transform((v) => v.replace(/\D/g, '')).pipe(z.string().regex(/^\d{8}$/, 'CEP com 8 números.')).optional() })
      .parse(req.query);
    const q = (await pool.query<{ subtotal_cents: string }>('SELECT subtotal_cents FROM quotes WHERE id = $1', [id])).rows[0]!;
    const items = (await pool.query<{ packaging_id: string; packs: number }>('SELECT packaging_id, packs FROM quote_items WHERE quote_id = $1', [id])).rows;
    const w = cartWeight(await priceLines(pool, items.map((i) => ({ packagingId: i.packaging_id, packs: i.packs }))));
    return { options: await quoteShipping(pool, cep ?? null, Number(q.subtotal_cents), w.grams, w.missing.length > 0) };
  });

  app.post('/:token/accept', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!app.payments) throw new AppError(503, 'PAYMENT_UNAVAILABLE', 'Pagamento online indisponível no momento. Fale com a loja pelo WhatsApp para concluir a compra.');
    const id = await quoteByToken(tokenOf(req));
    const b = convertSchema.parse(req.body);
    const r = await tx(null, (db) => convertQuote(db, id, b, null));
    return reply.code(r.replay ? 200 : 201).send({ orderToken: orderToken(r.requestKey), replay: r.replay });
  });
}
