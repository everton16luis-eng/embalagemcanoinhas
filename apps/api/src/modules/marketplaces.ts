import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { decrypt, encrypt, randomToken, sha256 } from '../lib/crypto.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation, likePattern } from '../lib/http.js';
import {
  CHANNEL_NAME,
  CHANNELS,
  MarketplaceAuthError,
  pkce,
  shopeePushUrl,
  ShopeeAdapter,
  type AccountAuth,
  type Channel,
  type MarketOrder,
  type MarketplaceAdapter,
  type Marketplaces,
} from '../lib/marketplaces.js';
import { requirePermission } from './auth.js';
import { addEvent, insertOrder, releaseOrderReservations, type OrderLine } from './orders.js';

declare module 'fastify' {
  interface FastifyInstance {
    marketplaces: Marketplaces;
  }
}

const channelSchema = z.enum(CHANNELS as [Channel, ...Channel[]]);
const errText = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 500);

// ---------------- tokens da conta ----------------

type AccountRow = {
  id: string;
  channel: Channel;
  external_id: string;
  status: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  access_expires_at: Date | null;
  refresh_expires_at: Date | null;
};
const ACCOUNT_SECRET_COLS = 'id, channel, external_id, status, access_token_enc, refresh_token_enc, access_expires_at, refresh_expires_at';

class AccountUnavailable extends Error {}

/**
 * Token de acesso valido. Renova antes de vencer com a linha da conta travada: o refresh token e de uso unico
 * nas duas plataformas, entao duas renovacoes ao mesmo tempo derrubariam a conta.
 */
export async function accessFor(adapter: MarketplaceAdapter, accountId: string, opts: { force?: boolean } = {}): Promise<AccountAuth> {
  const fresh = (a: AccountRow) => !opts.force && a.access_token_enc && a.access_expires_at && a.access_expires_at.getTime() > Date.now() + 10 * 60_000;
  const a = (await pool.query<AccountRow>(`SELECT ${ACCOUNT_SECRET_COLS} FROM marketplace_accounts WHERE id = $1`, [accountId])).rows[0];
  if (!a || a.status !== 'active') throw new AccountUnavailable('conta desconectada ou aguardando nova autorização');
  if (fresh(a)) return { externalId: a.external_id, accessToken: decrypt(a.access_token_enc!) };

  const outcome = await tx(null, async (db) => {
    const cur = (await db.query<AccountRow>(`SELECT ${ACCOUNT_SECRET_COLS} FROM marketplace_accounts WHERE id = $1 FOR UPDATE`, [accountId])).rows[0]!;
    if (cur.status !== 'active') return { error: new AccountUnavailable('conta desconectada ou aguardando nova autorização') };
    // Outra execucao renovou enquanto esperavamos a trava.
    if (fresh(cur) || (opts.force && cur.access_expires_at && a.access_expires_at && cur.access_expires_at > a.access_expires_at)) {
      return { auth: { externalId: cur.external_id, accessToken: decrypt(cur.access_token_enc!) } };
    }
    const expired = !cur.refresh_token_enc || (cur.refresh_expires_at && cur.refresh_expires_at.getTime() < Date.now());
    try {
      if (expired) throw new MarketplaceAuthError('autorização vencida');
      const t = await adapter.refresh({ externalId: cur.external_id, refreshToken: decrypt(cur.refresh_token_enc!) });
      await db.query(
        `UPDATE marketplace_accounts SET access_token_enc = $2, refresh_token_enc = $3, access_expires_at = $4, refresh_expires_at = $5, last_error = NULL, updated_at = now() WHERE id = $1`,
        [accountId, encrypt(t.accessToken), encrypt(t.refreshToken), t.accessExpiresAt, t.refreshExpiresAt],
      );
      return { auth: { externalId: cur.external_id, accessToken: t.accessToken } };
    } catch (err) {
      if (!(err instanceof MarketplaceAuthError)) {
        await db.query(`UPDATE marketplace_accounts SET last_error = $2, updated_at = now() WHERE id = $1`, [accountId, `Renovação do acesso: ${errText(err)}`]);
        return { error: err as Error };
      }
      await db.query(
        `UPDATE marketplace_accounts SET status = 'reauth_required', access_token_enc = NULL, refresh_token_enc = NULL, last_error = $2, updated_at = now() WHERE id = $1`,
        [accountId, `Autorize a conta de novo: ${errText(err)}`],
      );
      await audit(db, { actorId: null, action: 'marketplace.reauth_required', entity: 'marketplace_account', entityId: accountId, metadata: { reason: errText(err) } });
      return { error: err as Error };
    }
  });
  if ('error' in outcome) throw outcome.error;
  return outcome.auth!;
}

// ---------------- vendas ----------------

/** Coloca a venda na fila de consulta. O aviso nunca e a verdade: so dispara a consulta. */
export async function enqueueSale(db: Db | typeof pool, accountId: string, externalOrderId: string) {
  await db.query(
    `INSERT INTO marketplace_orders (account_id, external_order_id) VALUES ($1, $2)
     ON CONFLICT (account_id, external_order_id) DO UPDATE
       SET next_check_at = now(), updated_at = now(),
           state = CASE WHEN marketplace_orders.state = 'canceled' THEN 'canceled' ELSE 'pending' END`,
    [accountId, externalOrderId],
  );
}

type SaleRow = { id: string; account_id: string; external_order_id: string; order_id: string | null; state: string; check_count: number; created_at: Date; channel: Channel };

type LinkedRow = {
  packaging_id: string;
  base_qty: string;
  label: string;
  variant_id: string;
  sku: string;
  product_name: string;
  availability_mode: string;
  lead_time_days: number | null;
};

async function linesFor(db: Db, accountId: string, channel: Channel, sale: MarketOrder): Promise<OrderLine[]> {
  if (!sale.items.length) throw new AppError(409, 'SALE_WITHOUT_ITEMS', 'A venda veio sem itens.');
  const lines: OrderLine[] = [];
  for (const it of sale.items) {
    if (!Number.isInteger(it.quantity) || it.quantity < 1) throw new AppError(409, 'SALE_INVALID_QTY', `Quantidade inválida no anúncio ${it.itemId}.`);
    const l = (
      await db.query<LinkedRow>(
        `SELECT k.id AS packaging_id, k.base_qty, k.label, v.id AS variant_id, v.sku, p.name AS product_name, p.availability_mode, p.lead_time_days
         FROM marketplace_listings l JOIN packagings k ON k.id = l.packaging_id JOIN product_variants v ON v.id = k.variant_id JOIN products p ON p.id = v.product_id
         WHERE l.account_id = $1 AND l.external_item_id = $2 AND l.external_variation_id = $3 AND l.active`,
        [accountId, it.itemId, it.variationId],
      )
    ).rows[0];
    if (!l) {
      const what = `${it.itemId}${it.variationId ? ` (variação ${it.variationId})` : ''}${it.title ? ` — ${it.title.slice(0, 80)}` : ''}`;
      throw new AppError(409, 'LISTING_NOT_LINKED', `Anúncio ${what} sem vínculo com embalagem. Vincule em Marketplaces > Anúncios e a venda é importada na próxima rodada.`);
    }
    lines.push({
      variantId: l.variant_id,
      packagingId: l.packaging_id,
      sku: l.sku,
      productName: l.product_name,
      label: l.label,
      baseQty: l.base_qty,
      packs: it.quantity,
      // Preco da venda no marketplace (o comprador pagou este valor la).
      listPriceCents: it.unitPriceCents,
      unitPriceCents: it.unitPriceCents,
      totalCents: it.unitPriceCents * it.quantity,
      madeToOrder: l.availability_mode === 'made_to_order',
      leadTimeDays: l.lead_time_days,
    });
  }
  return lines;
}

async function importSale(db: Db, row: SaleRow, sale: MarketOrder) {
  const lines = await linesFor(db, row.account_id, row.channel, sale);
  const subtotal = lines.reduce((s, l) => s + l.totalCents, 0);
  if (subtotal <= 0) throw new AppError(409, 'SALE_ZERO_TOTAL', 'Venda com valor zero.');
  const name = CHANNEL_NAME[row.channel];
  const order = await insertOrder(
    db,
    {
      requestKey: `mkt:${row.channel}:${row.account_id}:${row.external_order_id}`,
      customerId: null,
      channel: row.channel,
      // Dados pessoais do comprador ficam no marketplace; a nota fiscal destes pedidos e conferida a mao (docs/07 §4).
      buyer: { name: `Comprador ${name}`, marketplace: row.channel, marketplaceOrderId: row.external_order_id },
      shipTo: null,
      shipping: { id: null, kind: 'marketplace', name: `Envio pelo ${name}`, priceCents: 0 },
      paymentMethod: 'marketplace',
      paid: true,
      subtotalCents: subtotal,
      discountCents: 0,
      freightCents: 0,
      notes: `Venda ${name} nº ${row.external_order_id}`,
      dueMinutes: 60,
      eventNote: `Venda importada do ${name} (nº ${row.external_order_id}, situação ${sale.rawStatus}).`,
    },
    lines,
  );
  await audit(db, { actorId: null, action: 'marketplace.import', entity: 'order', entityId: order.id, after: { channel: row.channel, externalOrderId: row.external_order_id, totalCents: subtotal } });
  return order;
}

/** Venda cancelada no marketplace: cancela o pedido e devolve o estoque, se ainda nao foi faturado nem despachado. */
async function cancelFromMarketplace(db: Db, orderId: string, channel: Channel, alreadyNoted: boolean) {
  const o = (await db.query<{ status: string; invoice_status: string }>('SELECT status, invoice_status FROM orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0]!;
  if (o.status === 'canceled') return;
  const name = CHANNEL_NAME[channel];
  if (['pending_payment', 'paid', 'preparing', 'ready'].includes(o.status) && !['authorized', 'processing'].includes(o.invoice_status)) {
    await db.query(`UPDATE orders SET status = 'canceled', canceled_at = now(), cancel_reason = $2, updated_at = now(), version = version + 1 WHERE id = $1`, [orderId, `Venda cancelada no ${name}`]);
    const released = await releaseOrderReservations(db, null, orderId);
    await addEvent(db, orderId, 'canceled', `Venda cancelada no ${name}. Estoque reservado devolvido.`);
    await audit(db, { actorId: null, action: 'marketplace.cancel', entity: 'order', entityId: orderId, before: { status: o.status }, after: { status: 'canceled', released } });
  } else if (!alreadyNoted) {
    await addEvent(db, orderId, o.status, `Venda cancelada no ${name}, mas o pedido já tem NF-e ou foi despachado: conferir devolução e nota.`);
  }
}

/** Aplica a situacao consultada. Roda com a linha travada: aviso repetido ou duas instancias nunca importam duas vezes. */
async function applySale(db: Db, rowId: string, sale: MarketOrder) {
  const row = (
    await db.query<SaleRow>(
      `SELECT mo.id, mo.account_id, mo.external_order_id, mo.order_id, mo.state, mo.check_count, mo.created_at, a.channel
       FROM marketplace_orders mo JOIN marketplace_accounts a ON a.id = mo.account_id WHERE mo.id = $1 FOR UPDATE OF mo`,
      [rowId],
    )
  ).rows[0]!;
  const snapshot = { status: sale.rawStatus, totalCents: sale.totalCents, items: sale.items };
  let state: string;
  let orderId = row.order_id;
  let nextCheck = 'now()';
  if (sale.status === 'canceled') {
    if (orderId) await cancelFromMarketplace(db, orderId, row.channel, row.state === 'canceled');
    state = 'canceled';
  } else if (sale.status === 'paid') {
    if (!orderId) orderId = (await importSale(db, row, sale)).id;
    state = 'imported';
  } else if (!orderId && row.created_at.getTime() < Date.now() - 30 * 86_400_000) {
    state = 'ignored'; // nunca foi paga em 30 dias
  } else {
    state = 'waiting';
    nextCheck = `now() + make_interval(mins => least(5 * ${Math.min(row.check_count + 1, 1000)}, 360))`;
  }
  await db.query(
    `UPDATE marketplace_orders SET external_status = $2, snapshot = $3, order_id = $4, state = $5, last_error = NULL, check_count = check_count + 1,
       next_check_at = ${nextCheck}, updated_at = now() WHERE id = $1`,
    [rowId, sale.rawStatus.slice(0, 40), JSON.stringify(snapshot), orderId, state],
  );
  return state;
}

async function markSaleError(rowId: string, message: string) {
  await pool.query(
    `UPDATE marketplace_orders SET state = CASE WHEN state = 'canceled' THEN state ELSE 'error' END, last_error = $2, check_count = check_count + 1,
       next_check_at = now() + make_interval(mins => least(10 * (check_count + 1), 360)), updated_at = now() WHERE id = $1`,
    [rowId, message.slice(0, 500)],
  );
}

/** Consulta a venda na plataforma e aplica. */
export async function syncSale(markets: Marketplaces, rowId: string) {
  const row = (
    await pool.query<{ account_id: string; external_order_id: string; channel: Channel }>(
      `SELECT mo.account_id, mo.external_order_id, a.channel FROM marketplace_orders mo JOIN marketplace_accounts a ON a.id = mo.account_id WHERE mo.id = $1`,
      [rowId],
    )
  ).rows[0];
  if (!row) throw notFound();
  const adapter = markets[row.channel];
  if (!adapter) {
    await markSaleError(rowId, `${CHANNEL_NAME[row.channel]} não configurado neste servidor.`);
    return 'error';
  }
  let sale: MarketOrder;
  try {
    const auth = await accessFor(adapter, row.account_id);
    sale = await adapter.getOrder(auth, row.external_order_id);
  } catch (err) {
    await markSaleError(rowId, `Consulta: ${errText(err)}`);
    return 'error';
  }
  try {
    return await tx(null, (db) => applySale(db, rowId, sale));
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    // Sem vinculo ou sem estoque: a venda existe la; fica na fila com o motivo ate alguem resolver.
    const msg = err.code === 'INSUFFICIENT_STOCK' ? `Estoque insuficiente: ${err.message} Dê entrada no estoque (ou cancele a venda no marketplace).` : err.message;
    await markSaleError(rowId, msg);
    return 'error';
  }
}

// ---------------- saldo dos anuncios ----------------

type PushRow = { id: string; account_id: string; channel: Channel; external_item_id: string; external_variation_id: string; qty: number; last_pushed_qty: number | null };

/** Envia o saldo (em embalagens) dos anuncios cujo valor mudou desde o ultimo envio. */
export async function pushStock(markets: Marketplaces, opts: { limit?: number; listingIds?: string[] } = {}) {
  const { rows } = await pool.query<PushRow>(
    `SELECT l.id, l.account_id, a.channel, l.external_item_id, l.external_variation_id,
            CASE WHEN k.active AND v.active AND p.status = 'active'
                 THEN greatest(floor((coalesce(b.on_hand, 0) - coalesce(b.reserved, 0)) / k.base_qty), 0)::int ELSE 0 END AS qty,
            l.last_pushed_qty
     FROM marketplace_listings l
     JOIN marketplace_accounts a ON a.id = l.account_id AND a.status = 'active'
     JOIN packagings k ON k.id = l.packaging_id JOIN product_variants v ON v.id = k.variant_id JOIN products p ON p.id = v.product_id
     LEFT JOIN stock_balances b ON b.variant_id = v.id
     WHERE l.active AND l.sync_stock AND p.availability_mode = 'stock' AND ($2::uuid[] IS NULL OR l.id = ANY($2))
     ORDER BY l.last_pushed_at NULLS FIRST LIMIT $1`,
    [opts.limit ?? 50, opts.listingIds ?? null],
  );
  // Envio manual (listingIds) manda sempre; a rotina so manda o que mudou.
  const due = rows.filter((r) => opts.listingIds || r.qty !== r.last_pushed_qty);
  let pushed = 0;
  let failed = 0;
  const auths = new Map<string, AccountAuth | Error>();
  for (const r of due) {
    const adapter = markets[r.channel];
    if (!adapter) continue;
    try {
      if (r.external_variation_id && !adapter.stockForVariations) throw new Error('Anúncio com variação no Mercado Livre: saldo atualizado à mão (ver docs/07).');
      if (!auths.has(r.account_id)) auths.set(r.account_id, await accessFor(adapter, r.account_id).catch((e: Error) => e));
      const auth = auths.get(r.account_id)!;
      if (auth instanceof Error) throw auth;
      await adapter.pushStock(auth, { itemId: r.external_item_id, variationId: r.external_variation_id }, r.qty);
      await pool.query(`UPDATE marketplace_listings SET last_pushed_qty = $2, last_pushed_at = now(), last_error = NULL, updated_at = now() WHERE id = $1`, [r.id, r.qty]);
      pushed++;
    } catch (err) {
      // last_pushed_at anda mesmo no erro: o anuncio vai para o fim da fila e nao trava os outros.
      await pool.query(`UPDATE marketplace_listings SET last_error = $2, last_pushed_at = now(), updated_at = now() WHERE id = $1`, [r.id, errText(err)]);
      failed++;
    }
  }
  return { pushed, failed };
}

// ---------------- rotina ----------------

/** Rodada periodica: renova tokens perto de vencer, consulta vendas pendentes e envia saldos. */
export async function marketplaceTick(markets: Marketplaces) {
  let refreshed = 0;
  const soon = (
    await pool.query<{ id: string; channel: Channel }>(
      `SELECT id, channel FROM marketplace_accounts WHERE status = 'active' AND (access_expires_at IS NULL OR access_expires_at < now() + interval '30 minutes') LIMIT 20`,
    )
  ).rows;
  for (const a of soon) {
    const adapter = markets[a.channel];
    if (!adapter) continue;
    if (await accessFor(adapter, a.id).then(() => true, () => false)) refreshed++;
  }
  const due = (
    await pool.query<{ id: string }>(
      `SELECT mo.id FROM marketplace_orders mo JOIN marketplace_accounts a ON a.id = mo.account_id AND a.status = 'active'
       WHERE mo.state IN ('pending', 'waiting', 'error') AND mo.next_check_at <= now() ORDER BY mo.next_check_at LIMIT 20`,
    )
  ).rows;
  const sales: Record<string, number> = {};
  for (const d of due) {
    const s = await syncSale(markets, d.id).catch(() => 'error');
    sales[s] = (sales[s] ?? 0) + 1;
  }
  const stock = await pushStock(markets);
  return { refreshed, sales, stock };
}

// ---------------- avisos (webhooks) ----------------

export async function marketplaceWebhookRoutes(app: FastifyInstance) {
  // Corpo cru: a assinatura da Shopee e calculada sobre os bytes recebidos.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  const limit = { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } };
  const parse = (raw: unknown): Record<string, any> => {
    try {
      const v = JSON.parse(String(raw ?? ''));
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  };
  const accountByExternal = async (channel: Channel, externalId: string) =>
    (await pool.query<{ id: string }>(`SELECT id FROM marketplace_accounts WHERE channel = $1 AND external_id = $2 AND status <> 'disconnected'`, [channel, externalId])).rows[0];

  // Mercado Livre: sem assinatura. So registra e agenda a consulta; responde 200 rapido (limite de 500 ms).
  app.post('/mercadolivre', limit, async (req, reply) => {
    const b = parse(req.body);
    const userId = /^\d{1,20}$/.test(String(b.user_id ?? '')) ? String(b.user_id) : null;
    const topic = typeof b.topic === 'string' ? b.topic.slice(0, 40) : null;
    const resource = typeof b.resource === 'string' ? b.resource.slice(0, 200) : null;
    await pool.query(`INSERT INTO marketplace_notifications (channel, external_id, topic, resource, verified) VALUES ('mercadolivre', $1, $2, $3, false)`, [userId, topic, resource]);
    const m = resource?.match(/^\/orders\/(\d{1,30})$/);
    if (topic === 'orders_v2' && m && userId) {
      const acc = await accountByExternal('mercadolivre', userId);
      if (acc) await enqueueSale(pool, acc.id, m[1]!);
    }
    return reply.code(200).send();
  });

  // Shopee: assinatura conferida sempre. Responde 2xx com corpo vazio.
  app.post('/shopee', limit, async (req, reply) => {
    const raw = typeof req.body === 'string' ? req.body : '';
    const adapter = app.marketplaces.shopee;
    const url = shopeePushUrl();
    const header = req.headers.authorization;
    const verified = Boolean(adapter && (adapter.fake || (adapter instanceof ShopeeAdapter && url && adapter.verifyPush(url, raw, typeof header === 'string' ? header : undefined))));
    const b = parse(raw);
    const shopId = /^\d{1,20}$/.test(String(b.shop_id ?? '')) ? String(b.shop_id) : null;
    const code = Number.isInteger(b.code) ? String(b.code) : null;
    const orderSn = typeof b.data?.ordersn === 'string' && /^[A-Za-z0-9]{1,40}$/.test(b.data.ordersn) ? b.data.ordersn : null;
    await pool.query(`INSERT INTO marketplace_notifications (channel, external_id, topic, resource, verified) VALUES ('shopee', $1, $2, $3, $4)`, [shopId, code, orderSn, verified]);
    if (!verified) return reply.code(401).send();
    // Codigo 3 = order_status_push.
    if (code === '3' && shopId && orderSn) {
      const acc = await accountByExternal('shopee', shopId);
      if (acc) await enqueueSale(pool, acc.id, orderSn);
    }
    return reply.code(204).send();
  });
}

// ---------------- painel ----------------

const ACCOUNT_COLS = `a.id, a.channel, a.external_id, a.name, a.status, a.last_error, a.access_expires_at, a.refresh_expires_at, a.created_at, a.updated_at,
  u.name AS connected_by_name`;

const listingBody = z.strictObject({
  accountId: z.uuid(),
  externalItemId: z.string().trim().regex(/^[A-Za-z0-9]{1,40}$/, 'Código do anúncio inválido.'),
  externalVariationId: z
    .string()
    .trim()
    .regex(/^[0-9]{0,30}$/, 'Código da variação inválido.')
    .optional()
    .transform((v) => (v && v !== '0' ? v : '')),
  packagingId: z.uuid(),
  title: z.string().trim().max(200).optional().nullable(),
  syncStock: z.boolean().default(true),
});

export async function marketplaceAdminRoutes(app: FastifyInstance) {
  const adapterOf = (channel: Channel) => {
    const a = app.marketplaces[channel];
    if (!a) throw new AppError(503, 'MARKETPLACE_UNAVAILABLE', `${CHANNEL_NAME[channel]} não está configurado neste servidor (credenciais do aplicativo no .env).`);
    return a;
  };

  app.get('/', async (req) => {
    requirePermission(req, 'marketplaces.manage');
    const accounts = (await pool.query(`SELECT ${ACCOUNT_COLS} FROM marketplace_accounts a JOIN users u ON u.id = a.connected_by ORDER BY a.channel, a.created_at`)).rows;
    const counts = (
      await pool.query(`SELECT mo.account_id, mo.state, count(*)::int AS n FROM marketplace_orders mo GROUP BY mo.account_id, mo.state`)
    ).rows;
    return {
      channels: CHANNELS.map((c) => ({ channel: c, name: CHANNEL_NAME[c], configured: Boolean(app.marketplaces[c]), fake: Boolean(app.marketplaces[c]?.fake) })),
      accounts,
      counts,
    };
  });

  /** Inicia a autorizacao: state de uso unico (e PKCE no ML) guardado so como hash/cifrado. */
  app.post('/connect', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const auth = requirePermission(req, 'marketplaces.manage');
    const { channel } = z.strictObject({ channel: channelSchema }).parse(req.body);
    const adapter = adapterOf(channel);
    const state = randomToken();
    const p = adapter.usesPkce ? pkce() : null;
    await pool.query(
      `INSERT INTO marketplace_oauth_states (state_hash, channel, code_verifier_enc, created_by, expires_at) VALUES ($1, $2, $3, $4, now() + interval '15 minutes')`,
      [sha256(state), channel, p ? encrypt(p.verifier) : null, auth.userId],
    );
    return { url: adapter.authorizeUrl(state, p?.challenge ?? null) };
  });

  /** Retorno da autorizacao (a pagina do painel repassa code, state e shop_id). */
  app.post('/callback', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const auth = requirePermission(req, 'marketplaces.manage');
    const b = z
      .strictObject({
        channel: channelSchema,
        code: z.string().min(4).max(500),
        state: z.string().min(20).max(200),
        shopId: z.string().regex(/^\d{1,20}$/).optional().nullable(),
      })
      .parse(req.body);
    const adapter = adapterOf(b.channel);
    // Consome o state antes de chamar a plataforma: repeticao do mesmo retorno nao troca o codigo duas vezes.
    const st = (
      await pool.query<{ code_verifier_enc: string | null; created_by: string; channel: string }>(
        `UPDATE marketplace_oauth_states SET used_at = now() WHERE state_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING code_verifier_enc, created_by, channel`,
        [sha256(b.state)],
      )
    ).rows[0];
    if (!st || st.channel !== b.channel || st.created_by !== auth.userId) throw new AppError(400, 'INVALID_STATE', 'Autorização expirada ou iniciada por outra pessoa. Clique em Conectar de novo.');
    let t;
    try {
      t = await adapter.exchangeCode({ code: b.code, codeVerifier: st.code_verifier_enc ? decrypt(st.code_verifier_enc) : null, shopId: b.shopId ?? null });
    } catch (err) {
      throw new AppError(502, 'MARKETPLACE_AUTH_FAILED', `${CHANNEL_NAME[b.channel]} recusou a autorização: ${errText(err)}`);
    }
    return tx(auth.userId, async (db) => {
      const { rows } = await db.query<{ id: string; inserted: boolean }>(
        `INSERT INTO marketplace_accounts (channel, external_id, name, access_token_enc, refresh_token_enc, access_expires_at, refresh_expires_at, connected_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (channel, external_id) DO UPDATE SET access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
           access_expires_at = EXCLUDED.access_expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at, status = 'active', last_error = NULL,
           connected_by = EXCLUDED.connected_by, updated_at = now()
         RETURNING id, (xmax = 0) AS inserted`,
        [b.channel, t.externalId, `${CHANNEL_NAME[b.channel]} ${t.externalId}`, encrypt(t.accessToken), encrypt(t.refreshToken), t.accessExpiresAt, t.refreshExpiresAt, auth.userId],
      );
      const acc = rows[0]!;
      await audit(db, { actorId: auth.userId, action: acc.inserted ? 'marketplace.connect' : 'marketplace.reconnect', entity: 'marketplace_account', entityId: acc.id, after: { channel: b.channel, externalId: t.externalId }, ip: auth.ip });
      return { account: (await db.query(`SELECT ${ACCOUNT_COLS} FROM marketplace_accounts a JOIN users u ON u.id = a.connected_by WHERE a.id = $1`, [acc.id])).rows[0] };
    });
  });

  app.patch('/accounts/:id', async (req) => {
    const auth = requirePermission(req, 'marketplaces.manage');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ name: z.string().trim().min(2).max(120) }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const before = (await db.query<{ name: string }>('SELECT name FROM marketplace_accounts WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw notFound();
      await db.query('UPDATE marketplace_accounts SET name = $2, updated_at = now() WHERE id = $1', [id, b.name]);
      await audit(db, { actorId: auth.userId, action: 'marketplace.rename', entity: 'marketplace_account', entityId: id, before, after: b, ip: auth.ip });
      return { ok: true };
    });
  });

  /** Desconecta: apaga os tokens daqui (a autorizacao tambem deve ser revogada no painel do marketplace). */
  app.post('/accounts/:id/disconnect', async (req) => {
    const auth = requirePermission(req, 'marketplaces.manage');
    const { id } = idParams.parse(req.params);
    return tx(auth.userId, async (db) => {
      const r = await db.query(
        `UPDATE marketplace_accounts SET status = 'disconnected', access_token_enc = NULL, refresh_token_enc = NULL, access_expires_at = NULL, updated_at = now() WHERE id = $1 RETURNING id`,
        [id],
      );
      if (!r.rowCount) throw notFound();
      await audit(db, { actorId: auth.userId, action: 'marketplace.disconnect', entity: 'marketplace_account', entityId: id, ip: auth.ip });
      return { ok: true };
    });
  });

  // ----- anuncios -----

  /** Embalagens de venda para vincular (nome, SKU ou codigo de barras). */
  app.get('/packagings', async (req) => {
    requirePermission(req, 'marketplaces.manage');
    const { q } = z.object({ q: z.string().trim().min(1).max(100) }).parse(req.query);
    const { rows } = await pool.query(
      `SELECT k.id, k.label, k.base_qty, k.price_cents, v.sku, p.name AS product_name, p.availability_mode,
              greatest(floor((coalesce(b.on_hand, 0) - coalesce(b.reserved, 0)) / k.base_qty), 0)::int AS packs_available
       FROM packagings k JOIN product_variants v ON v.id = k.variant_id JOIN products p ON p.id = v.product_id LEFT JOIN stock_balances b ON b.variant_id = v.id
       WHERE k.kind = 'sale' AND k.active AND v.active AND (p.name ILIKE $1 OR v.sku ILIKE $1 OR v.barcode = $2 OR k.barcode = $2)
       ORDER BY p.name, k.base_qty LIMIT 30`,
      [likePattern(q), q],
    );
    return { packagings: rows };
  });

  app.get('/listings', async (req) => {
    requirePermission(req, 'marketplaces.manage');
    const q = z.object({ accountId: z.uuid().optional() }).parse(req.query);
    const { rows } = await pool.query(
      `SELECT l.id, l.account_id, a.channel, a.name AS account_name, l.external_item_id, l.external_variation_id, l.title, l.sync_stock, l.active,
              l.last_pushed_qty, l.last_pushed_at, l.last_error, l.packaging_id, k.label AS packaging_label, k.base_qty, v.sku, p.name AS product_name,
              p.availability_mode,
              greatest(floor((coalesce(b.on_hand, 0) - coalesce(b.reserved, 0)) / k.base_qty), 0)::int AS packs_available
       FROM marketplace_listings l JOIN marketplace_accounts a ON a.id = l.account_id
       JOIN packagings k ON k.id = l.packaging_id JOIN product_variants v ON v.id = k.variant_id JOIN products p ON p.id = v.product_id
       LEFT JOIN stock_balances b ON b.variant_id = v.id
       WHERE ($1::uuid IS NULL OR l.account_id = $1) ORDER BY l.active DESC, p.name, k.base_qty`,
      [q.accountId ?? null],
    );
    return { listings: rows };
  });

  app.post('/listings', async (req, reply) => {
    const auth = requirePermission(req, 'marketplaces.manage');
    const b = listingBody.parse(req.body);
    return tx(auth.userId, async (db) => {
      const acc = (await db.query<{ channel: Channel }>(`SELECT channel FROM marketplace_accounts WHERE id = $1`, [b.accountId])).rows[0];
      if (!acc) throw notFound();
      const pk = (await db.query(`SELECT 1 FROM packagings WHERE id = $1 AND kind = 'sale' AND active`, [b.packagingId])).rows[0];
      if (!pk) throw new AppError(422, 'PACKAGING_INVALID', 'Escolha uma embalagem de venda ativa.');
      const adapter = app.marketplaces[acc.channel];
      // ML com variacao: saldo automatico desligado (docs/07 §4).
      const sync = b.syncStock && !(b.externalVariationId && acc.channel === 'mercadolivre' && !adapter?.stockForVariations);
      let id: string;
      try {
        id = (
          await db.query<{ id: string }>(
            `INSERT INTO marketplace_listings (account_id, external_item_id, external_variation_id, packaging_id, title, sync_stock, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [b.accountId, b.externalItemId, b.externalVariationId, b.packagingId, b.title || null, sync, auth.userId],
          )
        ).rows[0]!.id;
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError(409, 'LISTING_EXISTS', 'Este anúncio (e variação) já está vinculado.');
        throw err;
      }
      // Vendas paradas por falta de vinculo nesta conta: consulta de novo na proxima rodada.
      await db.query(`UPDATE marketplace_orders SET next_check_at = now() WHERE account_id = $1 AND state = 'error'`, [b.accountId]);
      await audit(db, { actorId: auth.userId, action: 'marketplace.listing_link', entity: 'marketplace_listing', entityId: id, after: { ...b, syncStock: sync }, ip: auth.ip });
      return reply.code(201).send({ id, syncStock: sync });
    });
  });

  app.patch('/listings/:id', async (req) => {
    const auth = requirePermission(req, 'marketplaces.manage');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ packagingId: z.uuid().optional(), syncStock: z.boolean().optional(), active: z.boolean().optional(), title: z.string().trim().max(200).optional().nullable() }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const cur = (
        await db.query<{ packaging_id: string; sync_stock: boolean; active: boolean; title: string | null; external_variation_id: string; channel: Channel; account_id: string }>(
          `SELECT l.packaging_id, l.sync_stock, l.active, l.title, l.external_variation_id, a.channel, l.account_id FROM marketplace_listings l JOIN marketplace_accounts a ON a.id = l.account_id WHERE l.id = $1 FOR UPDATE OF l`,
          [id],
        )
      ).rows[0];
      if (!cur) throw notFound();
      if (b.packagingId && !(await db.query(`SELECT 1 FROM packagings WHERE id = $1 AND kind = 'sale' AND active`, [b.packagingId])).rows[0]) {
        throw new AppError(422, 'PACKAGING_INVALID', 'Escolha uma embalagem de venda ativa.');
      }
      if (b.syncStock && cur.external_variation_id && !app.marketplaces[cur.channel]?.stockForVariations) {
        throw new AppError(409, 'SYNC_NOT_SUPPORTED', 'Anúncio com variação no Mercado Livre: o saldo é atualizado à mão no marketplace.');
      }
      const next = { packaging_id: b.packagingId ?? cur.packaging_id, sync_stock: b.syncStock ?? cur.sync_stock, active: b.active ?? cur.active, title: b.title === undefined ? cur.title : b.title || null };
      // Embalagem trocada: o proximo envio de saldo recalcula do zero.
      await db.query(
        `UPDATE marketplace_listings SET packaging_id = $2, sync_stock = $3, active = $4, title = $5, last_pushed_qty = CASE WHEN $6 THEN NULL ELSE last_pushed_qty END, updated_at = now() WHERE id = $1`,
        [id, next.packaging_id, next.sync_stock, next.active, next.title, next.packaging_id !== cur.packaging_id],
      );
      if (next.active) await db.query(`UPDATE marketplace_orders SET next_check_at = now() WHERE account_id = $1 AND state = 'error'`, [cur.account_id]);
      await audit(db, { actorId: auth.userId, action: 'marketplace.listing_update', entity: 'marketplace_listing', entityId: id, before: cur, after: next, ip: auth.ip });
      return { ok: true };
    });
  });

  // ----- vendas -----

  app.get('/orders', async (req) => {
    requirePermission(req, 'marketplaces.manage');
    const q = z.object({ state: z.enum(['pending', 'imported', 'waiting', 'error', 'ignored', 'canceled']).optional(), accountId: z.uuid().optional() }).parse(req.query);
    const { rows } = await pool.query(
      `SELECT mo.id, mo.account_id, a.channel, a.name AS account_name, mo.external_order_id, mo.external_status, mo.state, mo.last_error, mo.check_count,
              mo.next_check_at, mo.created_at, mo.updated_at, mo.order_id, o.number AS order_number, o.status AS order_status, o.total_cents,
              mo.snapshot->'totalCents' AS external_total_cents
       FROM marketplace_orders mo JOIN marketplace_accounts a ON a.id = mo.account_id LEFT JOIN orders o ON o.id = mo.order_id
       WHERE ($1::text IS NULL OR mo.state = $1) AND ($2::uuid IS NULL OR mo.account_id = $2)
       ORDER BY mo.created_at DESC LIMIT 200`,
      [q.state ?? null, q.accountId ?? null],
    );
    return { orders: rows };
  });

  /** Busca uma venda pelo numero (aviso perdido ou venda anterior a conexao). */
  app.post('/orders', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const auth = requirePermission(req, 'marketplaces.manage');
    const b = z.strictObject({ accountId: z.uuid(), externalOrderId: z.string().trim().regex(/^[A-Za-z0-9]{1,40}$/, 'Número da venda inválido.') }).parse(req.body);
    const acc = (await pool.query(`SELECT id FROM marketplace_accounts WHERE id = $1 AND status = 'active'`, [b.accountId])).rows[0];
    if (!acc) throw new AppError(409, 'ACCOUNT_INACTIVE', 'Conta desconectada ou aguardando nova autorização.');
    await enqueueSale(pool, b.accountId, b.externalOrderId);
    const row = (await pool.query<{ id: string }>(`SELECT id FROM marketplace_orders WHERE account_id = $1 AND external_order_id = $2`, [b.accountId, b.externalOrderId])).rows[0]!;
    const state = await syncSale(app.marketplaces, row.id);
    await tx(auth.userId, (db) => audit(db, { actorId: auth.userId, action: 'marketplace.order_fetch', entity: 'marketplace_order', entityId: row.id, after: { ...b, state }, ip: auth.ip }));
    return { id: row.id, state, order: (await pool.query(`SELECT state, last_error, order_id FROM marketplace_orders WHERE id = $1`, [row.id])).rows[0] };
  });

  app.post('/orders/:id/retry', async (req) => {
    requirePermission(req, 'marketplaces.manage');
    const { id } = idParams.parse(req.params);
    const r = (await pool.query(`SELECT 1 FROM marketplace_orders WHERE id = $1`, [id])).rows[0];
    if (!r) throw notFound();
    const state = await syncSale(app.marketplaces, id);
    return { state, order: (await pool.query(`SELECT state, last_error, order_id FROM marketplace_orders WHERE id = $1`, [id])).rows[0] };
  });

  /** Envia o saldo agora (todos os anuncios com envio automatico, ou um so). */
  app.post('/push-stock', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    requirePermission(req, 'marketplaces.manage');
    const b = z.strictObject({ listingId: z.uuid().optional() }).parse(req.body ?? {});
    return pushStock(app.marketplaces, b.listingId ? { listingIds: [b.listingId] } : { limit: 200 });
  });

  app.get('/notifications', async (req) => {
    requirePermission(req, 'marketplaces.manage');
    const { rows } = await pool.query(`SELECT id::text, channel, external_id, topic, resource, verified, received_at FROM marketplace_notifications ORDER BY id DESC LIMIT 50`);
    return { notifications: rows };
  });
}
