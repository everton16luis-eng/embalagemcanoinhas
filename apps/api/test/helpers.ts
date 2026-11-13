import { randomBytes, randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { generate, generateSecret } from 'otplib';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { encrypt } from '../src/lib/crypto.js';
import type { FiscalProvider } from '../src/lib/fiscal.js';
import type { PaymentProvider } from '../src/lib/payments.js';
import { hashPassword } from '../src/modules/auth.js';

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
export const makeApp = (routes?: { method: string; url: string }[], payments: PaymentProvider | null = null, fiscal: FiscalProvider | null = null) =>
  buildApp({ notifier: async (email, token) => void sentResets.push({ email, token }), routes, payments, fiscal });

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
  // Movimentos e recebimentos sao imutaveis (gatilho por linha); no banco de teste o dono limpa com TRUNCATE.
  // Tabelas fiscais recusam TRUNCATE (guarda das notas); so no banco de teste o dono desliga a trava para limpar.
  await owner.query('ALTER TABLE fiscal_documents DISABLE TRIGGER fiscal_documents_no_truncate; ALTER TABLE fiscal_files DISABLE TRIGGER fiscal_files_no_truncate');
  await owner.query(
    'TRUNCATE quote_events, quote_items, quotes, purchase_invoices, fiscal_files, fiscal_document_events, fiscal_documents, fiscal_inutilizations, fiscal_webhook_notifications, fiscal_certificates, fiscal_rules_history, fiscal_rules, shipments, payment_notifications, payments, order_events, order_items, orders, cart_items, carts, customer_addresses, customer_sessions, customers, shipping_options, price_tiers, inventory_count_items, inventory_counts, purchase_receipt_items, purchase_receipts, purchase_order_items, purchase_orders, supplier_products, supplier_contacts, suppliers, stock_reservations, stock_movements, stock_balances',
  );
  await owner.query('ALTER TABLE fiscal_documents ENABLE TRIGGER fiscal_documents_no_truncate; ALTER TABLE fiscal_files ENABLE TRIGGER fiscal_files_no_truncate');
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
