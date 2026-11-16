import argon2 from 'argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { generateSecret, generateURI, verify as verifyTotp } from 'otplib';
import { z } from 'zod';
import { config, isProduction } from '../config.js';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { decrypt, encrypt, randomToken, sha256 } from '../lib/crypto.js';
import { AppError, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { effectivePermissions, MFA_REQUIRED, type Permission } from '../lib/permissions.js';

// Nome proprio do cookie: no desenvolvimento, outros sistemas tambem rodam em localhost.
export const COOKIE = isProduction ? '__Host-loja_sid' : 'loja_sid';
export const MAX_EMAIL_FAILURES = 5;
export const MAX_IP_FAILURES = 30;
const THROTTLE_WINDOW = '15 minutes';
const MFA_ISSUER = 'Loja - Painel';

export type Auth = {
  sessionId: string;
  userId: string;
  email: string;
  name: string;
  role: string;
  mfaEnabled: boolean;
  permissions: Set<Permission>;
  ip: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    auth: Auth | null;
  }
}

export type ResetNotifier = (email: string, token: string) => Promise<void>;

export const passwordSchema = z
  .string()
  .min(10, 'A senha deve ter ao menos 10 caracteres.')
  .max(128)
  .regex(/[A-Za-z]/, 'A senha deve conter letras.')
  .regex(/[0-9]/, 'A senha deve conter números.');

export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id });

const loginSchema = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(1).max(128),
  totp: z.string().regex(/^\d{6}$/).optional(),
});

// Mantem o tempo de resposta parecido quando o e-mail nao existe.
const dummyHash = hashPassword(randomToken());

export async function isLocked(keys: string[]) {
  const { rowCount } = await pool.query('SELECT 1 FROM auth_throttle WHERE key = ANY($1) AND locked_until > now()', [keys]);
  return Boolean(rowCount);
}

export async function registerFailure(key: string, limit: number) {
  await pool.query(
    `INSERT INTO auth_throttle AS t (key, failures) VALUES ($1, 1)
     ON CONFLICT (key) DO UPDATE SET
       failures = CASE WHEN t.window_start < now() - $3::interval THEN 1 ELSE t.failures + 1 END,
       window_start = CASE WHEN t.window_start < now() - $3::interval THEN now() ELSE t.window_start END,
       locked_until = CASE WHEN t.window_start >= now() - $3::interval AND t.failures + 1 >= $2 THEN now() + $3::interval ELSE t.locked_until END`,
    [key, limit, THROTTLE_WINDOW],
  );
}

/** Cada codigo vale uma unica vez: o passo do TOTP so pode avancar. */
async function consumeTotpStep(userId: string, delta: number) {
  const step = Math.floor(Date.now() / 30000) + delta;
  const { rowCount } = await pool.query('UPDATE users SET totp_last_step = $1 WHERE id = $2 AND (totp_last_step IS NULL OR totp_last_step < $1)', [step, userId]);
  return rowCount === 1;
}

async function createSession(db: Db, userId: string, req: FastifyRequest) {
  const token = randomToken();
  const { rows } = await db.query<{ expires_at: Date }>(
    `INSERT INTO sessions (user_id, token_hash, idle_ttl, idle_expires_at, expires_at, ip, user_agent)
     VALUES ($1, $2, '2 hours', now() + interval '2 hours', now() + interval '12 hours', $3, $4) RETURNING expires_at`,
    [userId, sha256(token), req.ip, req.headers['user-agent']?.slice(0, 300) ?? null],
  );
  return { token, expiresAt: rows[0]!.expires_at };
}

function setSessionCookie(reply: FastifyReply, token: string, expires: Date) {
  reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, secure: isProduction, sameSite: 'lax', expires });
}

export async function loadAuth(req: FastifyRequest) {
  req.auth = null;
  const token = req.cookies[COOKIE];
  if (!token) return;
  const { rows } = await pool.query('SELECT * FROM auth_session_get($1)', [sha256(token)]);
  const s = rows[0];
  if (!s) return;
  req.auth = {
    sessionId: s.session_id,
    userId: s.user_id,
    email: s.email,
    name: s.name,
    role: s.role,
    mfaEnabled: s.totp_enabled,
    permissions: await effectivePermissions(pool, s.user_id, s.role),
    ip: req.ip,
  };
}

export function requireAuth(req: FastifyRequest): Auth {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** Exige a permissao. As sensiveis (usuarios, empresa, fiscal, precos) exigem tambem o MFA ativo. */
export function requirePermission(req: FastifyRequest, permission: Permission): Auth {
  const auth = requireAuth(req);
  if (!auth.permissions.has(permission)) throw forbidden();
  if (MFA_REQUIRED.has(permission) && !auth.mfaEnabled) {
    throw new AppError(403, 'MFA_REQUIRED', 'Ative a verificação em duas etapas em Minha conta para continuar.');
  }
  return auth;
}

/** Exige ao menos uma das permissoes, conferida no servidor. Com MFA exigido em alguma delas, vale a mesma regra. */
export function requireAnyPermission(req: FastifyRequest, ...permissions: Permission[]): Auth {
  const auth = requireAuth(req);
  const held = permissions.filter((p) => auth.permissions.has(p));
  if (!held.length) throw forbidden();
  if (held.every((p) => MFA_REQUIRED.has(p)) && !auth.mfaEnabled) {
    throw new AppError(403, 'MFA_REQUIRED', 'Ative a verificação em duas etapas em Minha conta para continuar.');
  }
  return auth;
}

export async function authRoutes(app: FastifyInstance, opts: { notifier: ResetNotifier }) {
  const strict = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

  app.post('/login', strict(config.LOGIN_RATE_LIMIT), async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const emailKey = `email:${sha256(body.email.toLowerCase())}`;
    const ipKey = `ip:${sha256(req.ip)}`;
    if (await isLocked([emailKey, ipKey])) throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Muitas tentativas. Aguarde alguns minutos.');

    const { rows } = await pool.query('SELECT * FROM auth_find_user($1)', [body.email]);
    const user = rows[0];
    const passwordOk = await argon2.verify(user?.password_hash ?? (await dummyHash), body.password);

    let totpOk = true;
    if (user?.totp_enabled && passwordOk && user.is_active) {
      if (!body.totp) throw new AppError(401, 'MFA_CODE_REQUIRED', 'Informe o código de verificação.');
      const result = await verifyTotp({ secret: decrypt(user.totp_secret_enc), token: body.totp, epochTolerance: 30 });
      totpOk = result.valid && (await consumeTotpStep(user.id, result.delta ?? 0));
    }

    if (!user || !passwordOk || !user.is_active || !totpOk) {
      await registerFailure(emailKey, MAX_EMAIL_FAILURES);
      await registerFailure(ipKey, MAX_IP_FAILURES);
      if (user) await tx(null, (db) => audit(db, { actorId: user.id, action: 'auth.login_failed', ip: req.ip }));
      throw new AppError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
    }

    await pool.query('DELETE FROM auth_throttle WHERE key = $1', [emailKey]);
    const session = await tx(user.id, async (db) => {
      const created = await createSession(db, user.id, req);
      await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
      await audit(db, { actorId: user.id, action: 'auth.login', ip: req.ip });
      return created;
    });
    setSessionCookie(reply, session.token, session.expiresAt);
    return { user: { id: user.id, name: user.name, email: user.email, role: user.role } };
  });

  app.post('/logout', async (req, reply) => {
    const auth = requireAuth(req);
    await tx(auth.userId, async (db) => {
      await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [auth.sessionId]);
      await audit(db, { actorId: auth.userId, action: 'auth.logout', ip: req.ip });
    });
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', async (req) => {
    const auth = requireAuth(req);
    return {
      user: { id: auth.userId, name: auth.name, email: auth.email, role: auth.role, mfaEnabled: auth.mfaEnabled },
      permissions: [...auth.permissions],
    };
  });

  app.post('/password/change', strict(10), async (req) => {
    const auth = requireAuth(req);
    const body = z.strictObject({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }).parse(req.body);
    const { rows } = await pool.query('SELECT password_hash FROM auth_find_user($1)', [auth.email]);
    if (!rows[0] || !(await argon2.verify(rows[0].password_hash, body.currentPassword))) throw new AppError(400, 'INVALID_PASSWORD', 'Senha atual incorreta.');
    const hash = await hashPassword(body.newPassword);
    await tx(auth.userId, async (db) => {
      await db.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [hash, auth.userId]);
      await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [auth.userId, auth.sessionId]);
      await audit(db, { actorId: auth.userId, action: 'auth.password_changed', ip: req.ip });
    });
    return { ok: true };
  });

  // Resposta identica exista ou nao o e-mail: nao permite descobrir contas.
  app.post('/password/forgot', strict(5), async (req, reply) => {
    const { email } = z.strictObject({ email: z.email().max(254) }).parse(req.body);
    const token = randomToken();
    const { rows } = await pool.query<{ email: string | null }>(`SELECT auth_reset_create($1, $2, '30 minutes') AS email`, [email, sha256(token)]);
    // Sem esperar o envio: o tempo de resposta tambem nao revela se o e-mail existe.
    if (rows[0]?.email) void opts.notifier(rows[0].email, token).catch((err) => req.log.error({ err: (err as Error).message }, 'falha ao enviar a redefinicao de senha'));
    return reply.code(202).send({ ok: true });
  });

  app.post('/password/reset', strict(10), async (req) => {
    const body = z.strictObject({ token: z.string().min(20).max(100), newPassword: passwordSchema }).parse(req.body);
    const hash = await hashPassword(body.newPassword);
    const { rows } = await pool.query<{ user_id: string | null }>('SELECT auth_reset_password($1, $2) AS user_id', [sha256(body.token), hash]);
    const userId = rows[0]?.user_id;
    if (!userId) throw new AppError(400, 'INVALID_TOKEN', 'Link inválido ou expirado.');
    await tx(userId, (db) => audit(db, { actorId: userId, action: 'auth.password_reset', ip: req.ip }));
    return { ok: true };
  });

  app.get('/sessions', async (req) => {
    const auth = requireAuth(req);
    const { rows } = await pool.query(
      `SELECT id, ip, user_agent, created_at, last_seen_at FROM sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() AND idle_expires_at > now() ORDER BY last_seen_at DESC`,
      [auth.userId],
    );
    return { sessions: rows.map((s) => ({ ...s, current: s.id === auth.sessionId })) };
  });

  app.delete('/sessions/:id', async (req) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { rowCount } = await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [id, auth.userId]);
    if (!rowCount) throw notFound();
    return { ok: true };
  });

  app.post('/mfa/setup', strict(10), async (req) => {
    const auth = requireAuth(req);
    if (auth.mfaEnabled) throw new AppError(409, 'MFA_ALREADY_ENABLED', 'A verificação em duas etapas já está ativa.');
    const secret = generateSecret();
    await pool.query('UPDATE users SET totp_secret_enc = $1 WHERE id = $2', [encrypt(secret), auth.userId]);
    return { secret, uri: generateURI({ issuer: MFA_ISSUER, label: auth.email, secret }) };
  });

  app.post('/mfa/confirm', strict(10), async (req) => {
    const auth = requireAuth(req);
    const { code } = z.strictObject({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const { rows } = await pool.query('SELECT totp_secret_enc FROM auth_find_user($1)', [auth.email]);
    const encrypted = rows[0]?.totp_secret_enc;
    if (!encrypted) throw new AppError(400, 'MFA_NOT_STARTED', 'Inicie a configuração antes de confirmar.');
    const result = await verifyTotp({ secret: decrypt(encrypted), token: code, epochTolerance: 30 });
    if (!result.valid || !(await consumeTotpStep(auth.userId, result.delta ?? 0))) throw new AppError(400, 'INVALID_CODE', 'Código inválido.');
    await tx(auth.userId, async (db) => {
      await db.query('UPDATE users SET totp_enabled = true WHERE id = $1', [auth.userId]);
      await audit(db, { actorId: auth.userId, action: 'auth.mfa_enabled', ip: req.ip });
    });
    return { ok: true };
  });
}

/** Usado so por quem gerencia usuarios: o proprietario nao pode ficar sem acesso ao proprio sistema. */
export const ensureNotLastOwner = async (db: Db, userId: string) => {
  const { rows } = await db.query<{ n: string }>(`SELECT count(*) AS n FROM users WHERE role = 'owner' AND is_active AND id <> $1`, [userId]);
  if (Number(rows[0]!.n) === 0) throw new AppError(409, 'LAST_OWNER', 'O sistema precisa de ao menos um proprietário ativo.');
};
export { forbidden };
