import argon2 from 'argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isProduction } from '../config.js';
import { pool, tx, type Db } from '../db/pool.js';
import { isValidCnpj, isValidCpf, normalizeCnpj, onlyDigits } from '../lib/br.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { AppError, notFound, unauthorized } from '../lib/errors.js';
import { idParams, isUniqueViolation } from '../lib/http.js';
import { hashPassword, passwordSchema } from './auth.js';
import { CART_COOKIE } from './storefront.js';

/** Sessao do cliente da loja. Separada da sessao da equipe: nome, tabela e regras proprias. */
export const CUSTOMER_COOKIE = isProduction ? '__Host-loja_cliente' : 'loja_cliente';
const SESSION_DAYS = 30;

export type Customer = { id: string; name: string; email: string; kind: 'pf' | 'pj' };

declare module 'fastify' {
  interface FastifyRequest {
    customer: Customer | null;
  }
}

export async function loadCustomer(req: FastifyRequest) {
  req.customer = null;
  const token = req.cookies[CUSTOMER_COOKIE];
  if (!token || token.length > 100) return;
  const { rows } = await pool.query<Customer>(
    `SELECT c.id, c.name, c.email, c.kind FROM customer_sessions s JOIN customers c ON c.id = s.customer_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND c.is_active`,
    [sha256(token)],
  );
  req.customer = rows[0] ?? null;
}

export function requireCustomer(req: FastifyRequest) {
  if (!req.customer) throw unauthorized();
  return req.customer;
}

// ---------- validacoes compartilhadas com o checkout ----------

const phone = z
  .string()
  .transform(onlyDigits)
  .pipe(z.string().regex(/^\d{10,13}$/, 'Telefone com DDD.'));

/** CPF (pessoa fisica) ou CNPJ numerico/alfanumerico (pessoa juridica), com digito conferido. */
export const documentFor = (kind: 'pf' | 'pj', raw: string) => {
  if (kind === 'pf') {
    const v = onlyDigits(raw);
    return isValidCpf(v) ? v : null;
  }
  const v = normalizeCnpj(raw);
  return isValidCnpj(v) ? v : null;
};

export const personSchema = z.strictObject({
  kind: z.enum(['pf', 'pj']),
  name: z.string().trim().min(2).max(150),
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  phone,
  document: z.string().trim().max(20),
  stateRegistration: z.string().trim().max(20).optional().nullable(),
});

export const addressSchema = z.strictObject({
  label: z.string().trim().max(40).optional().nullable(),
  recipient: z.string().trim().min(2).max(120),
  cep: z
    .string()
    .transform(onlyDigits)
    .pipe(z.string().regex(/^\d{8}$/, 'CEP com 8 números.')),
  street: z.string().trim().min(2).max(120),
  number: z.string().trim().min(1).max(20),
  complement: z.string().trim().max(60).optional().nullable(),
  district: z.string().trim().min(2).max(60),
  city: z.string().trim().min(2).max(60),
  uf: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'UF com 2 letras.'),
});
export type Address = z.infer<typeof addressSchema>;

const registerSchema = personSchema.extend({ document: z.string().trim().max(20).optional().nullable(), password: passwordSchema });

const loginSchema = z.strictObject({ email: z.email().max(254), password: z.string().min(1).max(128) });

const dummyHash = hashPassword(randomToken());

async function startSession(db: Db, req: FastifyRequest, reply: FastifyReply, customerId: string) {
  const token = randomToken();
  await db.query(`INSERT INTO customer_sessions (customer_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`, [
    customerId,
    sha256(token),
    SESSION_DAYS,
  ]);
  reply.setCookie(CUSTOMER_COOKIE, token, { path: '/', httpOnly: true, secure: isProduction, sameSite: 'lax', maxAge: SESSION_DAYS * 86_400 });
  // O carrinho aberto como visitante passa a ser do cliente.
  const cart = req.cookies[CART_COOKIE];
  if (cart && cart.length <= 100) await db.query(`UPDATE carts SET customer_id = $2 WHERE token_hash = $1 AND status = 'active'`, [sha256(cart), customerId]);
}

const ADDRESS_COLS = 'id, label, recipient, cep, street, number, complement, district, city, uf, is_default';

export async function customerRoutes(app: FastifyInstance) {
  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/register', strict, async (req, reply) => {
    const b = registerSchema.parse(req.body);
    let document: string | null = null;
    if (b.document) {
      document = documentFor(b.kind, b.document);
      if (!document) throw new AppError(400, 'INVALID_DOCUMENT', b.kind === 'pf' ? 'CPF inválido.' : 'CNPJ inválido.');
    }
    const hash = await hashPassword(b.password);
    return tx(null, async (db) => {
      try {
        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO customers (kind, name, email, phone, document, state_registration, password_hash) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [b.kind, b.name, b.email, b.phone, document, b.stateRegistration || null, hash],
        );
        await startSession(db, req, reply, rows[0]!.id);
        return reply.code(201).send({ customer: { id: rows[0]!.id, name: b.name, email: b.email, kind: b.kind } });
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError(409, 'EMAIL_TAKEN', 'Já existe cadastro com este e-mail. Entre com sua senha.');
        throw err;
      }
    });
  });

  app.post('/login', strict, async (req, reply) => {
    const b = loginSchema.parse(req.body);
    const row = (await pool.query<{ id: string; password_hash: string; is_active: boolean }>('SELECT * FROM customer_login_lookup($1)', [b.email])).rows[0];
    const ok = await argon2.verify(row?.password_hash ?? (await dummyHash), b.password);
    if (!row || !ok || !row.is_active) throw new AppError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha incorretos.');
    await tx(null, (db) => startSession(db, req, reply, row.id));
    await loadCustomerById(req, row.id);
    return { customer: req.customer };
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies[CUSTOMER_COOKIE];
    if (token) await pool.query('UPDATE customer_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(token)]);
    reply.clearCookie(CUSTOMER_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', async (req) => {
    const c = requireCustomer(req);
    const profile = (await pool.query('SELECT id, kind, name, email, phone, document, state_registration FROM customers WHERE id = $1', [c.id])).rows[0];
    const addresses = (await pool.query(`SELECT ${ADDRESS_COLS} FROM customer_addresses WHERE customer_id = $1 ORDER BY is_default DESC, created_at`, [c.id])).rows;
    return { customer: profile, addresses };
  });

  app.patch('/me', async (req) => {
    const c = requireCustomer(req);
    const b = z
      .strictObject({ name: z.string().trim().min(2).max(150), phone, document: z.string().trim().max(20).optional().nullable(), stateRegistration: z.string().trim().max(20).optional().nullable() })
      .parse(req.body);
    let document: string | null = null;
    if (b.document) {
      document = documentFor(c.kind, b.document);
      if (!document) throw new AppError(400, 'INVALID_DOCUMENT', c.kind === 'pf' ? 'CPF inválido.' : 'CNPJ inválido.');
    }
    await pool.query('UPDATE customers SET name = $2, phone = $3, document = $4, state_registration = $5, updated_at = now() WHERE id = $1', [
      c.id,
      b.name,
      b.phone,
      document,
      b.stateRegistration || null,
    ]);
    return { ok: true };
  });

  app.post('/addresses', async (req, reply) => {
    const c = requireCustomer(req);
    const a = addressSchema.extend({ isDefault: z.boolean().default(false) }).parse(req.body);
    return tx(null, async (db) => {
      const count = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM customer_addresses WHERE customer_id = $1', [c.id])).rows[0]!.n;
      if (count >= 20) throw new AppError(422, 'TOO_MANY_ADDRESSES', 'Limite de 20 endereços.');
      const makeDefault = a.isDefault || count === 0;
      if (makeDefault) await db.query('UPDATE customer_addresses SET is_default = false WHERE customer_id = $1 AND is_default', [c.id]);
      const { rows } = await db.query(
        `INSERT INTO customer_addresses (customer_id, label, recipient, cep, street, number, complement, district, city, uf, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${ADDRESS_COLS}`,
        [c.id, a.label || null, a.recipient, a.cep, a.street, a.number, a.complement || null, a.district, a.city, a.uf, makeDefault],
      );
      return reply.code(201).send({ address: rows[0] });
    });
  });

  app.put('/addresses/:id', async (req) => {
    const c = requireCustomer(req);
    const { id } = idParams.parse(req.params);
    const a = addressSchema.extend({ isDefault: z.boolean().default(false) }).parse(req.body);
    return tx(null, async (db) => {
      if (a.isDefault) await db.query('UPDATE customer_addresses SET is_default = false WHERE customer_id = $1 AND is_default AND id <> $2', [c.id, id]);
      const { rows } = await db.query(
        `UPDATE customer_addresses SET label = $3, recipient = $4, cep = $5, street = $6, number = $7, complement = $8, district = $9, city = $10, uf = $11,
           is_default = is_default OR $12
         WHERE id = $1 AND customer_id = $2 RETURNING ${ADDRESS_COLS}`,
        [id, c.id, a.label || null, a.recipient, a.cep, a.street, a.number, a.complement || null, a.district, a.city, a.uf, a.isDefault],
      );
      if (!rows[0]) throw notFound();
      return { address: rows[0] };
    });
  });

  app.delete('/addresses/:id', async (req) => {
    const c = requireCustomer(req);
    const { id } = idParams.parse(req.params);
    const r = await pool.query('DELETE FROM customer_addresses WHERE id = $1 AND customer_id = $2', [id, c.id]);
    if (!r.rowCount) throw notFound();
    return { ok: true };
  });

  app.get('/orders', async (req) => {
    const c = requireCustomer(req);
    const { rows } = await pool.query(
      `SELECT o.id, o.number, o.status, o.payment_method, o.total_cents, o.created_at, o.invoice_status,
              (SELECT count(*)::int FROM order_items i WHERE i.order_id = o.id) AS item_count
       FROM orders o WHERE o.customer_id = $1 ORDER BY o.created_at DESC LIMIT 100`,
      [c.id],
    );
    return { orders: rows };
  });
}

async function loadCustomerById(req: FastifyRequest, id: string) {
  req.customer = (await pool.query<Customer>('SELECT id, name, email, kind FROM customers WHERE id = $1', [id])).rows[0] ?? null;
}
