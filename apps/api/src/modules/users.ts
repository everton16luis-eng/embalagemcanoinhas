import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation } from '../lib/http.js';
import { effectivePermissions, PERMISSIONS, ROLES, roleDefaults } from '../lib/permissions.js';
import { ensureNotLastOwner, hashPassword, requirePermission } from './auth.js';

const roleSchema = z.enum(ROLES);
const overridesSchema = z.partialRecord(z.enum(PERMISSIONS), z.boolean()).optional();

/** Senha inicial aleatoria, mostrada uma unica vez para quem cadastrou. */
const temporaryPassword = () => `${randomBytes(9).toString('base64url')}7a`;

export async function userRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    requirePermission(req, 'users.view');
    const { rows } = await pool.query(
      'SELECT id, email, name, role, is_active, totp_enabled, last_login_at, created_at FROM users ORDER BY is_active DESC, name',
    );
    return { users: rows, roles: ROLES, permissions: PERMISSIONS };
  });

  app.get('/:id', async (req) => {
    requirePermission(req, 'users.view');
    const { id } = idParams.parse(req.params);
    const { rows } = await pool.query('SELECT id, email, name, role, is_active, totp_enabled, last_login_at, created_at FROM users WHERE id = $1', [id]);
    if (!rows[0]) throw notFound();
    const overrides = (await pool.query('SELECT permission, granted FROM user_permissions WHERE user_id = $1', [id])).rows;
    return { user: rows[0], overrides, effective: [...(await effectivePermissions(pool, id, rows[0].role))], defaults: [...roleDefaults(rows[0].role)] };
  });

  app.post('/', async (req, reply) => {
    const auth = requirePermission(req, 'users.manage');
    const body = z.strictObject({ email: z.email().max(254), name: z.string().trim().min(2).max(120), role: roleSchema }).parse(req.body);
    // So o proprietario cria outro proprietario.
    if (body.role === 'owner' && auth.role !== 'owner') throw forbidden();
    const password = temporaryPassword();
    const hash = await hashPassword(password);
    try {
      const user = await tx(auth.userId, async (db) => {
        const { rows } = await db.query('INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role', [body.email, body.name, body.role, hash]);
        await audit(db, { actorId: auth.userId, action: 'users.created', entity: 'user', entityId: rows[0].id, after: rows[0], ip: req.ip });
        return rows[0];
      });
      return reply.code(201).send({ user, temporaryPassword: password });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'EMAIL_IN_USE', 'Já existe um usuário com este e-mail.');
      throw err;
    }
  });

  /**
   * Nova senha temporaria para quem esqueceu (sem provedor de e-mail a recuperacao por link nao existe).
   * Opcionalmente desliga o MFA de quem perdeu o celular. Sessoes abertas caem na hora.
   */
  app.post('/:id/password-reset', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const auth = requirePermission(req, 'users.manage');
    const { id } = idParams.parse(req.params);
    const body = z.strictObject({ resetMfa: z.boolean().default(false) }).parse(req.body ?? {});
    if (id === auth.userId) throw new AppError(409, 'SELF_CHANGE', 'Para a sua própria senha, use Minha conta.');
    const password = temporaryPassword();
    const hash = await hashPassword(password);
    await tx(auth.userId, async (db) => {
      const target = (await db.query('SELECT id, role, is_active FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!target) throw notFound();
      if (target.role === 'owner' && auth.role !== 'owner') throw forbidden();
      if (!target.is_active) throw new AppError(409, 'USER_INACTIVE', 'Reative o usuário antes de gerar uma nova senha.');
      // So grava: o papel da API nao le password_hash nem totp_secret_enc.
      await db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [id, hash]);
      if (body.resetMfa) await db.query('UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL WHERE id = $1', [id]);
      await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      await audit(db, { actorId: auth.userId, action: 'users.password_reset', entity: 'user', entityId: id, metadata: { resetMfa: body.resetMfa }, ip: req.ip });
    });
    return { temporaryPassword: password };
  });

  app.patch('/:id', async (req) => {
    const auth = requirePermission(req, 'users.manage');
    const { id } = idParams.parse(req.params);
    const body = z
      .strictObject({ name: z.string().trim().min(2).max(120).optional(), role: roleSchema.optional(), isActive: z.boolean().optional(), overrides: overridesSchema })
      .parse(req.body);
    return tx(auth.userId, async (db) => {
      const { rows } = await db.query('SELECT id, email, name, role, is_active FROM users WHERE id = $1 FOR UPDATE', [id]);
      const before = rows[0];
      if (!before) throw notFound();
      // Ninguem altera o proprio papel, a propria situacao ou as proprias permissoes.
      if (id === auth.userId && (body.role !== undefined || body.isActive !== undefined || body.overrides !== undefined)) {
        throw new AppError(409, 'SELF_CHANGE', 'Você não pode alterar o próprio papel, situação ou permissões.');
      }
      // Proprietario so e alterado por proprietario, e ninguem promove a proprietario sem ser um.
      if ((before.role === 'owner' || body.role === 'owner') && auth.role !== 'owner') throw forbidden();
      if (before.role === 'owner' && ((body.role && body.role !== 'owner') || body.isActive === false)) await ensureNotLastOwner(db, id);

      const { rows: updated } = await db.query(
        `UPDATE users SET name = coalesce($2, name), role = coalesce($3, role), is_active = coalesce($4, is_active), updated_at = now()
         WHERE id = $1 RETURNING id, email, name, role, is_active`,
        [id, body.name ?? null, body.role ?? null, body.isActive ?? null],
      );
      if (body.overrides) {
        // Guarda so o que difere do padrao do papel.
        const defaults = roleDefaults(updated[0].role);
        await db.query('DELETE FROM user_permissions WHERE user_id = $1', [id]);
        for (const [permission, granted] of Object.entries(body.overrides)) {
          if (defaults.has(permission as never) !== granted) {
            await db.query('INSERT INTO user_permissions (user_id, permission, granted) VALUES ($1, $2, $3)', [id, permission, granted]);
          }
        }
      }
      // Desativado ou com papel trocado: as sessoes abertas caem na hora.
      if (body.isActive === false || (body.role && body.role !== before.role)) {
        await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      }
      await audit(db, { actorId: auth.userId, action: 'users.updated', entity: 'user', entityId: id, before, after: { ...updated[0], overrides: body.overrides }, ip: req.ip });
      return { user: updated[0] };
    });
  });
}
