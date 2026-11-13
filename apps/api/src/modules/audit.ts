import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { pageQuery } from '../lib/http.js';
import { requirePermission } from './auth.js';

export async function auditRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    requirePermission(req, 'audit.view');
    const q = pageQuery
      .extend({
        entity: z.string().regex(/^[a-z_]{2,40}$/).optional(),
        entityId: z.string().max(60).optional(),
        action: z.string().regex(/^[a-z_.]{2,60}$/).optional(),
      })
      .parse(req.query);
    const { rows } = await pool.query(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.before, a.after, a.metadata, a.ip, a.created_at, u.name AS actor_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
       WHERE ($1::text IS NULL OR a.entity = $1) AND ($2::text IS NULL OR a.entity_id = $2) AND ($3::text IS NULL OR a.action LIKE $3 || '%')
       ORDER BY a.id DESC LIMIT $4 OFFSET $5`,
      [q.entity ?? null, q.entityId ?? null, q.action ?? null, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { entries: rows, page: q.page, pageSize: q.pageSize };
  });
}
