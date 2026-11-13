import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config, isProduction } from './config.js';
import { pool } from './db/pool.js';
import { AppError } from './lib/errors.js';
import { PostgresRateLimitStore } from './lib/rate-limit-store.js';
import { auditRoutes } from './modules/audit.js';
import { authRoutes, COOKIE, loadAuth, type ResetNotifier } from './modules/auth.js';
import { categoryRoutes } from './modules/categories.js';
import { companyRoutes, fiscalSettingsRoutes, storeSettingsRoutes } from './modules/company.js';
import { productImageRoutes, publicImageRoutes } from './modules/images.js';
import { productRoutes } from './modules/products.js';
import { inventoryRoutes } from './modules/inventory.js';
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

export async function buildApp(opts: { notifier: ResetNotifier; routes?: { method: string; url: string }[]; rateLimitStore?: 'memory' | 'postgres' }) {
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

  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (SAFE_METHODS.has(req.method)) return;
    // CSRF: complementa o SameSite. Requisicao que altera dados precisa vir da origem da aplicacao.
    const origin = req.headers.origin;
    if (origin ? origin !== config.APP_ORIGIN : Boolean(req.cookies[COOKIE])) throw new AppError(403, 'INVALID_ORIGIN', 'Origem da requisição não permitida.');
  });
  app.addHook('preHandler', loadAuth);

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
  await app.register(storeSettingsRoutes, { prefix: '/api/v1/admin/store-settings' });
  await app.register(stockRoutes, { prefix: '/api/v1/admin/stock' });
  await app.register(stockReportRoutes, { prefix: '/api/v1/admin/stock-reports' });
  await app.register(inventoryRoutes, { prefix: '/api/v1/admin/inventory-counts' });
  await app.register(supplierRoutes, { prefix: '/api/v1/admin/suppliers' });
  await app.register(purchaseRoutes, { prefix: '/api/v1/admin/purchase-orders' });
  await app.register(publicImageRoutes, { prefix: '/api/v1/public' });
  return app;
}
