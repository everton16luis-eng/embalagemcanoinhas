import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config, isProduction } from './config.js';
import { pool } from './db/pool.js';
import { AppError } from './lib/errors.js';
import { fiscalProviderFromConfig, type FiscalProvider } from './lib/fiscal.js';
import { FakeProvider, providerFromConfig, type PaymentProvider } from './lib/payments.js';
import { PostgresRateLimitStore } from './lib/rate-limit-store.js';
import { auditRoutes } from './modules/audit.js';
import { authRoutes, COOKIE, loadAuth, type ResetNotifier } from './modules/auth.js';
import { categoryRoutes } from './modules/categories.js';
import { CUSTOMER_COOKIE, customerRoutes, loadCustomer } from './modules/customers.js';
import { adminOrderRoutes, checkoutRoutes, customerOrderRoutes, fakePaymentRoutes, publicOrderRoutes, shippingOptionRoutes, webhookRoutes } from './modules/orders.js';
import { CART_COOKIE, cartRoutes, catalogRoutes, shippingQuoteRoutes } from './modules/storefront.js';
import { companyRoutes, fiscalSettingsRoutes, storeSettingsRoutes } from './modules/company.js';
import { fiscalRoutes, fiscalWebhookRoutes } from './modules/fiscal.js';
import { productImageRoutes, publicImageRoutes } from './modules/images.js';
import { productRoutes } from './modules/products.js';
import { inventoryRoutes } from './modules/inventory.js';
import { purchaseInvoiceRoutes } from './modules/purchase-invoices.js';
import { purchaseRoutes } from './modules/purchases.js';
import { setupRoutes } from './modules/setup.js';
import { stockReportRoutes } from './modules/stock-reports.js';
import { stockRoutes } from './modules/stock.js';
import { supplierRoutes } from './modules/suppliers.js';
import { userRoutes } from './modules/users.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DB_DOWN_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', '57P01', '57P02', '57P03', '53300', '08006', '08001', '3D000', '28P01', '28000']);
const isDbDown = (err: Error & { code?: string }) => DB_DOWN_CODES.has(err.code ?? '') || /timeout exceeded when trying to connect|Connection terminated/i.test(err.message);

/** Confia so nos ultimos proxies: o que o cliente escreveu no X-Forwarded-For fica de fora. */
const trustedHops = (hops: number) => (hops ? (_addr: string, hop: number) => hop < hops : false);

/** Provedor de pagamento: o configurado (Mercado Pago), o simulado so fora de producao, ou nenhum. */
export const defaultPaymentProvider = () => providerFromConfig() ?? (config.PAYMENT_FAKE && !isProduction ? new FakeProvider() : null);

export async function buildApp(opts: {
  notifier: ResetNotifier;
  routes?: { method: string; url: string }[];
  rateLimitStore?: 'memory' | 'postgres';
  payments?: PaymentProvider | null;
  fiscal?: FiscalProvider | null;
}) {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'] },
    trustProxy: trustedHops(config.TRUST_PROXY),
    bodyLimit: 1024 * 1024,
  });

  // Inventario de rotas usado pelos testes de seguranca: rota nova entra na varredura sozinha.
  if (opts.routes) {
    app.addHook('onRoute', (route) => {
      if (route.url.length > 1 && route.url.endsWith('/')) return;
      for (const method of [route.method].flat()) if (method !== 'HEAD' && method !== 'OPTIONS') opts.routes!.push({ method, url: route.url });
    });
  }

  await app.register(helmet);
  await app.register(cookie);
  await app.register(multipart);
  const shared = (opts.rateLimitStore ?? config.RATE_LIMIT_STORE ?? (isProduction ? 'postgres' : 'memory')) === 'postgres';
  await app.register(rateLimit, { global: false, ...(shared ? { store: PostgresRateLimitStore as never, skipOnError: true } : {}) });

  app.decorateRequest('auth', null);
  app.decorateRequest('customer', null);
  app.decorate('payments', opts.payments === undefined ? defaultPaymentProvider() : opts.payments);
  app.decorate('fiscal', opts.fiscal === undefined ? fiscalProviderFromConfig() : opts.fiscal);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (SAFE_METHODS.has(req.method)) return;
    // CSRF: complementa o SameSite. Requisicao que altera dados precisa vir da origem da aplicacao.
    // Avisos dos provedores (pagamento e fiscal) vem de fora e sao conferidos por assinatura ou header proprio.
    if (req.url.startsWith('/api/v1/webhooks/')) return;
    const origin = req.headers.origin;
    const hasSession = Boolean(req.cookies[COOKIE] || req.cookies[CUSTOMER_COOKIE] || req.cookies[CART_COOKIE]);
    if (origin ? origin !== config.APP_ORIGIN : hasSession) throw new AppError(403, 'INVALID_ORIGIN', 'Origem da requisição não permitida.');
  });
  app.addHook('preHandler', loadAuth);
  app.addHook('preHandler', loadCustomer);

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, ...(err.details === undefined ? {} : { details: err.details }) } });
    }
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Dados inválidos.', issues } });
    }
    if (err.statusCode && err.statusCode < 500) {
      if (err.statusCode === 429) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Muitas tentativas. Aguarde um minuto e tente novamente.' } });
      if (err.statusCode === 413) return reply.code(413).send({ error: { code: 'TOO_LARGE', message: 'Arquivo ou envio grande demais.' } });
      return reply.code(err.statusCode).send({ error: { code: 'BAD_REQUEST', message: 'Requisição não aceita.' } });
    }
    req.log.error(err);
    if (isDbDown(err)) return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Serviço indisponível no momento. Tente novamente em instantes.' } });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno. Tente novamente.' } });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } }));

  app.get('/health', async () => ({ ok: true }));
  app.get('/ready', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  await app.register(authRoutes, { prefix: '/api/v1/auth', notifier: opts.notifier });
  await app.register(setupRoutes, { prefix: '/api/v1/admin/setup' });
  await app.register(userRoutes, { prefix: '/api/v1/admin/users' });
  await app.register(auditRoutes, { prefix: '/api/v1/admin/audit' });
  await app.register(categoryRoutes, { prefix: '/api/v1/admin/categories' });
  await app.register(productRoutes, { prefix: '/api/v1/admin/products' });
  await app.register(productImageRoutes, { prefix: '/api/v1/admin/products' });
  await app.register(companyRoutes, { prefix: '/api/v1/admin/company' });
  await app.register(fiscalSettingsRoutes, { prefix: '/api/v1/admin/fiscal/settings' });
  await app.register(fiscalRoutes, { prefix: '/api/v1/admin/fiscal' });
  await app.register(storeSettingsRoutes, { prefix: '/api/v1/admin/store-settings' });
  await app.register(stockRoutes, { prefix: '/api/v1/admin/stock' });
  await app.register(stockReportRoutes, { prefix: '/api/v1/admin/stock-reports' });
  await app.register(inventoryRoutes, { prefix: '/api/v1/admin/inventory-counts' });
  await app.register(supplierRoutes, { prefix: '/api/v1/admin/suppliers' });
  await app.register(purchaseRoutes, { prefix: '/api/v1/admin/purchase-orders' });
  await app.register(purchaseInvoiceRoutes, { prefix: '/api/v1/admin/purchase-invoices' });
  await app.register(publicImageRoutes, { prefix: '/api/v1/public' });
  await app.register(catalogRoutes, { prefix: '/api/v1/public/catalog' });
  await app.register(cartRoutes, { prefix: '/api/v1/public/cart' });
  await app.register(shippingQuoteRoutes, { prefix: '/api/v1/public/shipping' });
  await app.register(checkoutRoutes, { prefix: '/api/v1/public/checkout' });
  await app.register(publicOrderRoutes, { prefix: '/api/v1/public/orders' });
  await app.register(fakePaymentRoutes, { prefix: '/api/v1/public/dev-payments' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(customerOrderRoutes, { prefix: '/api/v1/customer/orders' });
  await app.register(webhookRoutes, { prefix: '/api/v1/webhooks' });
  await app.register(fiscalWebhookRoutes, { prefix: '/api/v1/webhooks/fiscal' });
  await app.register(adminOrderRoutes, { prefix: '/api/v1/admin/orders' });
  await app.register(shippingOptionRoutes, { prefix: '/api/v1/admin/shipping-options' });
  return app;
}
