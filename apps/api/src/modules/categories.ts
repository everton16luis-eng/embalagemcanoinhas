import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { slugify } from '../lib/br.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, isForeignKeyViolation, isUniqueViolation } from '../lib/http.js';
import { requirePermission } from './auth.js';

const body = z.strictObject({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().max(90).optional(),
  parentId: z.uuid().nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  position: z.number().int().min(0).max(9999).optional(),
  active: z.boolean().optional(),
});

/** Erros do banco traduzidos para quem esta na tela. */
function categoryError(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (isUniqueViolation(err, 'categories_slug_key')) throw new AppError(409, 'SLUG_IN_USE', 'Já existe uma categoria com este endereço (slug).');
  if (isUniqueViolation(err, 'categories_name_unique')) throw new AppError(409, 'NAME_IN_USE', 'Já existe uma categoria com este nome neste nível.');
  if (e.constraint === 'categories_cycle' || e.constraint === 'categories_not_self') throw new AppError(409, 'CATEGORY_CYCLE', 'Uma categoria não pode ficar dentro dela mesma.');
  if (e.constraint === 'categories_depth') throw new AppError(409, 'CATEGORY_DEPTH', 'Use no máximo 3 níveis de categoria.');
  if (isForeignKeyViolation(err)) throw new AppError(409, 'CATEGORY_IN_USE', 'Categoria inexistente ou com produtos e subcategorias vinculados.');
  throw err;
}

export async function categoryRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    requirePermission(req, 'catalog.view');
    const { rows } = await pool.query(
      `SELECT c.id, c.parent_id, c.name, c.slug, c.description, c.position, c.active,
              (SELECT count(*)::int FROM products p WHERE p.category_id = c.id) AS product_count
       FROM categories c ORDER BY c.position, c.name`,
    );
    return { categories: rows };
  });

  app.post('/', async (req, reply) => {
    const auth = requirePermission(req, 'catalog.manage');
    const b = body.parse(req.body);
    let slug = slugify(b.slug || b.name);
    if (!slug) throw new AppError(422, 'INVALID_SLUG', 'Informe um nome com letras ou números.');
    try {
      const category = await tx(auth.userId, async (db) => {
        const same = await db.query(
          `SELECT 1 FROM categories WHERE coalesce(parent_id, '00000000-0000-0000-0000-000000000000') = coalesce($1::uuid, '00000000-0000-0000-0000-000000000000') AND lower(name) = lower($2)`,
          [b.parentId ?? null, b.name],
        );
        if (same.rowCount) throw new AppError(409, 'NAME_IN_USE', 'Já existe uma categoria com este nome neste nível.');
        // Endereco gerado do nome: "Caixas" em duas categorias vira caixas e bolos-caixas.
        if (!b.slug && b.parentId && (await db.query('SELECT 1 FROM categories WHERE slug = $1', [slug])).rowCount) {
          const parent = (await db.query<{ slug: string }>('SELECT slug FROM categories WHERE id = $1', [b.parentId])).rows[0];
          if (parent) slug = `${parent.slug}-${slug}`.slice(0, 90).replace(/-+$/, '');
        }
        const { rows } = await db.query(
          `INSERT INTO categories (name, slug, parent_id, description, position, active) VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, parent_id, name, slug, description, position, active`,
          [b.name, slug, b.parentId ?? null, b.description ?? null, b.position ?? 0, b.active ?? true],
        );
        await audit(db, { actorId: auth.userId, action: 'categories.created', entity: 'category', entityId: rows[0].id, after: rows[0], ip: req.ip });
        return rows[0];
      });
      return reply.code(201).send({ category });
    } catch (err) {
      categoryError(err);
    }
  });

  app.patch('/:id', async (req) => {
    const auth = requirePermission(req, 'catalog.manage');
    const { id } = idParams.parse(req.params);
    const b = body.partial().parse(req.body);
    try {
      return await tx(auth.userId, async (db) => {
        const before = (await db.query('SELECT id, parent_id, name, slug, description, position, active FROM categories WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!before) throw notFound();
        const slug = b.slug !== undefined ? slugify(b.slug || b.name || before.name) : before.slug;
        const { rows } = await db.query(
          `UPDATE categories SET name = $2, slug = $3, parent_id = $4, description = $5, position = $6, active = $7, updated_at = now()
           WHERE id = $1 RETURNING id, parent_id, name, slug, description, position, active`,
          [
            id,
            b.name ?? before.name,
            slug,
            b.parentId === undefined ? before.parent_id : b.parentId,
            b.description === undefined ? before.description : b.description,
            b.position ?? before.position,
            b.active ?? before.active,
          ],
        );
        await audit(db, { actorId: auth.userId, action: 'categories.updated', entity: 'category', entityId: id, before, after: rows[0], ip: req.ip });
        return { category: rows[0] };
      });
    } catch (err) {
      categoryError(err);
    }
  });

  // So apaga categoria vazia; com produtos ou subcategorias, desative.
  app.delete('/:id', async (req) => {
    const auth = requirePermission(req, 'catalog.manage');
    const { id } = idParams.parse(req.params);
    try {
      return await tx(auth.userId, async (db) => {
        const { rows } = await db.query('DELETE FROM categories WHERE id = $1 RETURNING id, name, slug, parent_id', [id]);
        if (!rows[0]) throw notFound();
        await audit(db, { actorId: auth.userId, action: 'categories.deleted', entity: 'category', entityId: id, before: rows[0], ip: req.ip });
        return { ok: true };
      });
    } catch (err) {
      categoryError(err);
    }
  });
}
