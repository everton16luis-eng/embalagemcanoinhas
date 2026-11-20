import { randomBytes, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { generate, generateSecret } from 'otplib';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { encrypt } from '../src/lib/crypto.js';
import type { FiscalProvider } from '../src/lib/fiscal.js';
import type { CarrierProvider } from '../src/lib/carriers.js';
import type { Marketplaces } from '../src/lib/marketplaces.js';
import type { WhatsAppProvider } from '../src/lib/whatsapp.js';
import type { AiProvider } from '../src/lib/gemini.js';
import type { TypebotProvider } from '../src/lib/typebot.js';
import type { PaymentProvider } from '../src/lib/payments.js';
import { hashPassword } from '../src/modules/auth.js';
import { ensureTestDatabase } from './env-guard.js';

export const ORIGIN = process.env.APP_ORIGIN!;
export const PASSWORD = 'Senha-de-teste-123';
export const COOKIE = 'loja_sid';

// Dono das tabelas: so prepara cenarios. O codigo testado conecta como loja_app.
export const owner = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_OWNER_USER,
  password: process.env.DB_OWNER_PASSWORD,
  database: process.env.DB_NAME_TEST,
  max: 2,
});

// Papel da aplicacao, para provar o que ele NAO consegue fazer.
export const appRole = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: 'loja_app',
  password: process.env.APP_DB_PASSWORD,
  database: process.env.DB_NAME_TEST,
  max: 2,
});

const passwordHash = hashPassword(PASSWORD);
export const uid = () => randomBytes(5).toString('hex');
export const randomIp = () => `10.${randomInt(255)}.${randomInt(255)}.${randomInt(255)}`;

export const sentResets: { email: string; token: string }[] = [];
export const makeApp = (
  routes?: { method: string; url: string }[],
  payments: PaymentProvider | null = null,
  fiscal: FiscalProvider | null = null,
  marketplaces: Marketplaces = { mercadolivre: null, shopee: null },
  extra: { whatsapp?: WhatsAppProvider | null; carrier?: CarrierProvider | null; ai?: AiProvider | null; typebot?: TypebotProvider | null } = {},
) => buildApp({ notifier: async (email, token) => void sentResets.push({ email, token }), routes, payments, fiscal, marketplaces, whatsapp: extra.whatsapp ?? null, carrier: extra.carrier ?? null, ai: extra.ai ?? null, typebot: extra.typebot ?? null });

export async function createUser(role: string, opts: { mfa?: boolean } = {}) {
  const email = `${role}-${uid()}@teste.local`;
  const secret = opts.mfa ? generateSecret() : null;
  const { rows } = await owner.query(
    `INSERT INTO users (email, name, role, password_hash, totp_enabled, totp_secret_enc) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [email, `Usuario ${role}`, role, await passwordHash, Boolean(secret), secret ? encrypt(secret) : null],
  );
  return { id: rows[0].id as string, email, secret };
}

type Payload = Record<string, unknown> | unknown[];
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export function client(app: FastifyInstance, ip = randomIp()) {
  let sid: string | undefined;
  const send = async (method: Method, url: string, payload?: Payload, headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method,
      url,
      remoteAddress: ip,
      headers: { origin: ORIGIN, ...headers },
      ...(sid ? { cookies: { [COOKIE]: sid } } : {}),
      ...(payload ? { payload: payload as Record<string, unknown> } : {}),
    });
    const cookie = res.cookies.find((c) => c.name === COOKIE);
    if (cookie) sid = cookie.value || undefined;
    return res;
  };
  return {
    send,
    get: (url: string) => send('GET', url),
    post: (url: string, body?: Payload) => send('POST', url, body ?? {}),
    put: (url: string, body: Payload) => send('PUT', url, body),
    patch: (url: string, body: Payload) => send('PATCH', url, body),
    del: (url: string) => send('DELETE', url),
    async login(user: { email: string; secret: string | null }) {
      const totp = user.secret ? await generate({ secret: user.secret }) : undefined;
      const res = await send('POST', '/api/v1/auth/login', { email: user.email, password: PASSWORD, ...(totp ? { totp } : {}) });
      if (res.statusCode !== 200) throw new Error(`login falhou: ${res.body}`);
      return res;
    },
    get sid() {
      return sid;
    },
  };
}

/** Usuario do papel, ja logado. */
export async function loggedAs(app: FastifyInstance, role: string, opts: { mfa?: boolean } = {}) {
  const user = await createUser(role, opts);
  const c = client(app);
  await c.login(user);
  return Object.assign(c, { user });
}

/** Limpa os dados entre arquivos de teste. A auditoria e somente inclusao e nao e apagada. */
export async function resetCatalog() {
  // Segunda trava (a primeira e o globalSetup): nada e apagado sem confirmar que o banco e o de testes.
  // DB_NAME e NODE_ENV aqui foram trocados pelo vitest.config; a conferencia usa os valores do arquivo .env.
  await ensureTestDatabase(process.env, parseEnv(readFileSync(new URL('../../../.env', import.meta.url), 'utf8')));
  // Movimentos, recebimentos, abertura e conferencias do estoque sao imutaveis (gatilho por linha, que o TRUNCATE nao
  // dispara); no banco de teste o dono limpa com TRUNCATE. warehouses fica: o deposito padrao vem da migration.
  // Tabelas fiscais e os historicos de fornecedor (0021) recusam TRUNCATE; so no banco de teste o dono desliga a trava para limpar.
  await owner.query('ALTER TABLE fiscal_documents DISABLE TRIGGER fiscal_documents_no_truncate; ALTER TABLE fiscal_files DISABLE TRIGGER fiscal_files_no_truncate; ALTER TABLE supplier_price_history DISABLE TRIGGER supplier_price_history_no_truncate; ALTER TABLE supplier_availability DISABLE TRIGGER supplier_availability_no_truncate');
  await owner.query(
    'TRUNCATE shipment_events, shipment_checks, shipment_items, allocation_decisions, fulfillment_allocations, fulfillments, ai_calls, bot_security_events, bot_runs, bot_pending_documents, bot_verify_failures, bot_test_sessions,whatsapp_conversations, whatsapp_messages, whatsapp_inbound,whatsapp_optouts, whatsapp_templates, shipping_quote_cache, marketplace_notifications, marketplace_orders, marketplace_listings, marketplace_oauth_states, marketplace_accounts, quote_events, quote_items, quotes, purchase_invoices, fiscal_files, fiscal_document_events, fiscal_documents, fiscal_inutilizations, fiscal_webhook_notifications, fiscal_certificates, fiscal_rules_history, fiscal_rules, shipments, payment_notifications, payments, order_events, order_items, orders, cart_items, carts, customer_addresses, customer_sessions, customers, shipping_options, price_tiers, inventory_count_items, inventory_counts, purchase_receipt_items, purchase_receipts, purchase_order_items, purchase_orders, supplier_price_history, supplier_availability, supplier_products, supplier_contacts, suppliers, stock_adjustment_requests, stock_location_settings, stock_transfer_events, stock_transfer_items, stock_transfers, stock_reservations, stock_reconciliations, stock_opening_balances, stock_location_balances, stock_movements, stock_balances',
  );
  await owner.query('ALTER TABLE fiscal_documents ENABLE TRIGGER fiscal_documents_no_truncate; ALTER TABLE fiscal_files ENABLE TRIGGER fiscal_files_no_truncate; ALTER TABLE supplier_price_history ENABLE TRIGGER supplier_price_history_no_truncate; ALTER TABLE supplier_availability ENABLE TRIGGER supplier_availability_no_truncate');
  // Depositos criados pelos testes (SGLog Fase 3); o padrao vem da migration e fica.
  await owner.query(`UPDATE logistics_settings SET dropship_status = 'blocked', fiscal_validator_name = NULL, validated_by = NULL, validated_at = NULL, version = 0,
    multi_shipment_status = 'blocked', multi_validator_name = NULL, multi_validated_by = NULL, multi_validated_at = NULL, distinct_checker = false`);
  await owner.query('DELETE FROM warehouses WHERE NOT is_default');
  await owner.query(`UPDATE warehouses SET name = 'Depósito principal', allocation_priority = 100, cep = NULL, street = NULL, number = NULL, complement = NULL, district = NULL, city = NULL, uf = NULL WHERE is_default`);
  await owner.query(`UPDATE bot_settings SET audience = 'off', mode = 'menu', ai_plan = 'free', ai_monthly_limit_usd = 10, ai_daily_per_phone = 20, typebot_public_id = NULL, test_phones = '{}', hours = '{}', texts = '{}'`);
  await owner.query(`UPDATE supplier_settings SET tie_tolerance_pct = 3, stale_quote_days = 90, availability_warning_days = 3`);
  await owner.query('DELETE FROM product_images; DELETE FROM packagings; DELETE FROM product_variants; DELETE FROM products; DELETE FROM categories');
}

export const productPayload = (overrides: Record<string, unknown> = {}) => {
  const sku = `CP-${uid()}`.toUpperCase();
  return {
    name: `Copo plástico 200 ml ${uid()}`,
    baseUnit: 'UN',
    status: 'active',
    variants: [
      {
        sku,
        packagings: [
          { kind: 'sale', label: 'Unidade', unitCode: 'UN', baseQty: '1', priceCents: 25 },
          { kind: 'sale', label: 'Pacote com 50', unitCode: 'PCT', baseQty: '50', priceCents: 1000, isDefault: true },
          { kind: 'purchase', label: 'Pacote do fornecedor com 100', unitCode: 'PCT', baseQty: '100' },
        ],
      },
    ],
    ...overrides,
  };
};

/**
 * SGLog Fase 4: confirma a alocacao recomendada do pedido (pedido pago so despacha com alocacao confirmada).
 * `c` precisa de logistics.allocate (proprietario, gerente ou gerente de logistica).
 */
export async function allocateOrder(c: ReturnType<typeof client>, orderId: string, extra: Record<string, unknown> = {}) {
  const d = await c.get(`/api/v1/admin/logistics/orders/${orderId}`);
  if (d.statusCode !== 200) throw new Error(`detalhe da alocacao: ${d.body}`);
  const body = d.json();
  const planKey = body.proposal?.recommended?.key;
  if (!planKey) throw new Error(`sem proposta recomendada: ${JSON.stringify(body.proposal)}`);
  const r = await c.post(`/api/v1/admin/logistics/orders/${orderId}/allocation`, {
    logisticsVersion: body.order.logistics_version,
    planKey,
    requestKey: `test-${randomBytes(6).toString('hex')}`,
    ...extra,
  });
  if (r.statusCode !== 200) throw new Error(`alocacao: ${r.body}`);
  return r.json();
}
