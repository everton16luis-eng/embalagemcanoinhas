// SGLog Fase 3: cadastro de depositos (D3-5). So dono e gerente (settings.manage, com MFA) cadastram e alteram;
// quem ve estoque consulta. Sem exclusao: deposito se desativa, e so sem saldo, transito ou inventario aberto.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation } from '../lib/http.js';
import { requirePermission } from './auth.js';

const opt = (schema: z.ZodString) =>
  z
    .union([schema, z.literal('')])
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

const body = z.strictObject({
  name: z.string().trim().min(2).max(80),
  cep: opt(z.string().trim().regex(/^\d{8}$/, 'CEP com 8 números.')),
  street: opt(z.string().trim().min(2).max(120)),
  number: opt(z.string().trim().min(1).max(20)),
  complement: opt(z.string().trim().max(60)),
  district: opt(z.string().trim().min(2).max(60)),
  city: opt(z.string().trim().min(2).max(60)),
  uf: opt(z.string().trim().regex(/^[A-Z]{2}$/, 'UF com 2 letras maiúsculas.')),
  active: z.boolean().optional(),
});
const createBody = body.extend({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/, 'Código com 2 a 20 letras, números, - ou _.') });

const COLS = 'id, code, name, cep, street, number, complement, district, city, uf, is_default, active, created_at, updated_at';

export async function warehouseRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    requirePermission(req, 'stock.view');
    const { rows } = await pool.query(
      `SELECT ${COLS.split(', ').map((c) => `w.${c}`).join(', ')},
              coalesce(s.on_hand, 0)::numeric(14,3) AS on_hand, coalesce(s.reserved, 0)::numeric(14,3) AS reserved,
              coalesce(s.blocked, 0)::numeric(14,3) AS blocked, coalesce(s.damaged, 0)::numeric(14,3) AS damaged,
              coalesce(s.in_transit, 0)::numeric(14,3) AS in_transit, coalesce(s.variants, 0)::int AS variants,
              (SELECT count(*)::int FROM stock_location_alerts a WHERE a.warehouse_id = w.id) AS alerts,
              (SELECT count(*)::int FROM stock_transfers t WHERE t.to_warehouse_id = w.id AND t.status IN ('in_transit', 'partial')) AS incoming
       FROM warehouses w
       LEFT JOIN (SELECT warehouse_id, sum(on_hand) AS on_hand, sum(reserved) AS reserved, sum(blocked) AS blocked, sum(damaged) AS damaged,
                         sum(in_transit) AS in_transit, count(*) FILTER (WHERE on_hand + blocked + damaged + in_transit > 0) AS variants
                  FROM stock_location_balances GROUP BY warehouse_id) s ON s.warehouse_id = w.id
       ORDER BY w.is_default DESC, w.active DESC, w.name`,
    );
    return { items: rows };
  });

  app.get('/:id', async (req) => {
    requirePermission(req, 'stock.view');
    const { id } = idParams.parse(req.params);
    const w = (await pool.query(`SELECT ${COLS} FROM warehouses WHERE id = $1`, [id])).rows[0];
    if (!w) throw notFound();
    return { warehouse: w };
  });

  app.post('/', async (req, reply) => {
    const auth = requirePermission(req, 'settings.manage');
    const b = createBody.parse(req.body);
    try {
      const warehouse = await tx(auth.userId, async (db) => {
        const w = (
          await db.query(
            `INSERT INTO warehouses (code, name, cep, street, number, complement, district, city, uf, active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10, true)) RETURNING ${COLS}`,
            [b.code, b.name, b.cep, b.street, b.number, b.complement, b.district, b.city, b.uf, b.active ?? null],
          )
        ).rows[0];
        await audit(db, { actorId: auth.userId, action: 'warehouse.created', entity: 'warehouse', entityId: w.id, after: w, ip: req.ip });
        return w;
      });
      return reply.code(201).send({ warehouse });
    } catch (err) {
      if (isUniqueViolation(err, 'warehouses_code_key')) throw new AppError(409, 'CODE_TAKEN', 'Já existe um depósito com este código.');
      throw err;
    }
  });

  app.put('/:id', async (req) => {
    const auth = requirePermission(req, 'settings.manage');
    const { id } = idParams.parse(req.params);
    const b = body.parse(req.body);
    return tx(auth.userId, async (db) => {
      const before = (await db.query(`SELECT ${COLS} FROM warehouses WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!before) throw notFound();
      if (before.is_default && b.active === false) throw new AppError(409, 'DEFAULT_WAREHOUSE', 'O depósito padrão não pode ser desativado.');
      try {
        const after = (
          await db.query(
            `UPDATE warehouses SET name = $2, cep = $3, street = $4, number = $5, complement = $6, district = $7, city = $8, uf = $9,
               active = coalesce($10, active), updated_at = now() WHERE id = $1 RETURNING ${COLS}`,
            [id, b.name, b.cep, b.street, b.number, b.complement, b.district, b.city, b.uf, b.active ?? null],
          )
        ).rows[0];
        await audit(db, { actorId: auth.userId, action: 'warehouse.updated', entity: 'warehouse', entityId: id, before, after, ip: req.ip });
        return { warehouse: after };
      } catch (err) {
        if ((err as { constraint?: string }).constraint === 'warehouses_in_use') {
          throw new AppError(409, 'WAREHOUSE_IN_USE', 'Este depósito tem saldo, transferência pendente ou inventário aberto. Zere o saldo e encerre o que estiver aberto antes de desativar.');
        }
        throw err;
      }
    });
  });
}
