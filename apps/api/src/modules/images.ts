import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, notFound } from '../lib/errors.js';
import { IMAGE_SIZES, MAX_IMAGE_BYTES, readImage, removeImage, storeImage, type ImageSize } from '../lib/images.js';
import { requirePermission } from './auth.js';

const MAX_IMAGES = 12;
// Processar imagem custa CPU: limite por sessao.
const uploadLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => req.cookies.loja_sid ?? req.ip } } };

const IMAGE_COLS = 'id, variant_id, file_key, width, height, alt, position, is_primary';
const tooMany = () => new AppError(409, 'TOO_MANY_IMAGES', `No máximo ${MAX_IMAGES} imagens por produto.`);

/** Le o unico arquivo do envio, com limite de tamanho; o tipo real e conferido depois, pelo conteudo. */
async function readUpload(req: FastifyRequest) {
  const file = await req.file({ limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });
  if (!file) throw new AppError(422, 'NO_FILE', 'Envie um arquivo de imagem.');
  const tooLarge = () => new AppError(413, 'FILE_TOO_LARGE', 'A imagem deve ter no máximo 8 MB.');
  const buf = await file.toBuffer().catch(() => {
    throw tooLarge();
  });
  // O plugin as vezes devolve o arquivo cortado no limite sem erro (depende de como os pedacos chegam pela rede):
  // sem esta conferencia, o JPEG cortado ia para o sharp e virava erro 500 (achado em 14/11/2026).
  if (file.file.truncated) throw tooLarge();
  return buf;
}

export async function productImageRoutes(app: FastifyInstance) {
  app.post('/:id/images', uploadLimit, async (req, reply) => {
    const auth = requirePermission(req, 'catalog.manage');
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const exists = await pool.query('SELECT count(*)::int AS n FROM product_images WHERE product_id = $1', [id]);
    const product = await pool.query('SELECT 1 FROM products WHERE id = $1', [id]);
    if (!product.rowCount) throw notFound();
    if (exists.rows[0].n >= MAX_IMAGES) throw tooMany();
    const stored = await storeImage(await readUpload(req));
    try {
      const image = await tx(auth.userId, async (db) => {
        // Trava o produto: dois envios ao mesmo tempo nao passam do limite.
        await db.query('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [id]);
        const count = (await db.query('SELECT count(*)::int AS n FROM product_images WHERE product_id = $1', [id])).rows[0].n as number;
        if (count >= MAX_IMAGES) throw tooMany();
        const first = count === 0;
        const { rows } = await db.query(
          `INSERT INTO product_images (product_id, file_key, width, height, bytes, position, is_primary)
           VALUES ($1, $2, $3, $4, $5, (SELECT coalesce(max(position) + 1, 0) FROM product_images WHERE product_id = $1), $6)
           RETURNING id, variant_id, file_key, width, height, alt, position, is_primary`,
          [id, stored.key, stored.width, stored.height, stored.bytes, first],
        );
        await audit(db, { actorId: auth.userId, action: 'products.image_added', entity: 'product', entityId: id, after: rows[0], ip: req.ip });
        return rows[0];
      });
      return reply.code(201).send({ image });
    } catch (err) {
      await removeImage(stored.key);
      throw err;
    }
  });

  // Ordem da galeria numa operacao so: a primeira da lista vira a principal (e a que a loja mostra primeiro).
  app.put('/:id/images/order', async (req) => {
    const auth = requirePermission(req, 'catalog.manage');
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { ids } = z.strictObject({ ids: z.array(z.uuid()).min(1).max(MAX_IMAGES) }).parse(req.body);
    return tx(auth.userId, async (db) => {
      await db.query('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [id]);
      const before = (await db.query(`SELECT ${IMAGE_COLS} FROM product_images WHERE product_id = $1 ORDER BY is_primary DESC, position`, [id])).rows;
      const current = new Set(before.map((r) => r.id as string));
      if (ids.length !== current.size || new Set(ids).size !== ids.length || ids.some((i) => !current.has(i))) {
        throw new AppError(409, 'IMAGES_CHANGED', 'As fotos deste produto mudaram. Recarregue a página e organize de novo.');
      }
      // O indice "uma principal por produto" e conferido linha a linha: primeiro desmarca, depois ordena.
      await db.query('UPDATE product_images SET is_primary = false WHERE product_id = $1 AND is_primary', [id]);
      await db.query(
        `UPDATE product_images i SET position = o.n - 1, is_primary = (o.n = 1)
           FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, n)
          WHERE i.id = o.id AND i.product_id = $1`,
        [id, ids],
      );
      const after = (await db.query(`SELECT ${IMAGE_COLS} FROM product_images WHERE product_id = $1 ORDER BY is_primary DESC, position`, [id])).rows;
      await audit(db, { actorId: auth.userId, action: 'products.images_reordered', entity: 'product', entityId: id, before: { ids: before.map((r) => r.id) }, after: { ids }, ip: req.ip });
      return { images: after };
    });
  });

  // Troca o arquivo de uma foto mantendo posicao, principal e texto alternativo.
  app.post('/:id/images/:imageId/file', uploadLimit, async (req) => {
    const auth = requirePermission(req, 'catalog.manage');
    const { id, imageId } = z.object({ id: z.uuid(), imageId: z.uuid() }).parse(req.params);
    const exists = await pool.query('SELECT 1 FROM product_images WHERE id = $1 AND product_id = $2', [imageId, id]);
    if (!exists.rowCount) throw notFound();
    const stored = await storeImage(await readUpload(req));
    let oldKey: string;
    let image: unknown;
    try {
      ({ oldKey, image } = await tx(auth.userId, async (db) => {
        const before = (await db.query(`SELECT ${IMAGE_COLS}, bytes FROM product_images WHERE id = $1 AND product_id = $2 FOR UPDATE`, [imageId, id])).rows[0];
        if (!before) throw notFound();
        const { rows } = await db.query(`UPDATE product_images SET file_key = $3, width = $4, height = $5, bytes = $6 WHERE id = $1 AND product_id = $2 RETURNING ${IMAGE_COLS}`, [
          imageId,
          id,
          stored.key,
          stored.width,
          stored.height,
          stored.bytes,
        ]);
        await audit(db, { actorId: auth.userId, action: 'products.image_replaced', entity: 'product', entityId: id, before, after: rows[0], ip: req.ip });
        return { oldKey: before.file_key as string, image: rows[0] };
      }));
    } catch (err) {
      await removeImage(stored.key);
      throw err;
    }
    // O arquivo antigo so sai depois que o banco ja aponta para o novo.
    await removeImage(oldKey);
    return { image };
  });

  app.patch('/:id/images/:imageId', async (req) => {
    const auth = requirePermission(req, 'catalog.manage');
    const { id, imageId } = z.object({ id: z.uuid(), imageId: z.uuid() }).parse(req.params);
    const b = z
      .strictObject({ alt: z.string().trim().max(200).nullable().optional(), isPrimary: z.literal(true).optional(), position: z.number().int().min(0).max(99).optional(), variantId: z.uuid().nullable().optional() })
      .parse(req.body);
    return tx(auth.userId, async (db) => {
      const before = (await db.query('SELECT * FROM product_images WHERE id = $1 AND product_id = $2 FOR UPDATE', [imageId, id])).rows[0];
      if (!before) throw notFound();
      if (b.variantId) {
        const ok = await db.query('SELECT 1 FROM product_variants WHERE id = $1 AND product_id = $2', [b.variantId, id]);
        if (!ok.rowCount) throw new AppError(422, 'INVALID_VARIANT', 'Variação não pertence a este produto.');
      }
      if (b.isPrimary) await db.query('UPDATE product_images SET is_primary = false WHERE product_id = $1 AND is_primary', [id]);
      const { rows } = await db.query(
        `UPDATE product_images SET alt = $3, is_primary = $4, position = $5, variant_id = $6 WHERE id = $1 AND product_id = $2
         RETURNING id, variant_id, file_key, width, height, alt, position, is_primary`,
        [imageId, id, b.alt === undefined ? before.alt : b.alt, b.isPrimary ?? before.is_primary, b.position ?? before.position, b.variantId === undefined ? before.variant_id : b.variantId],
      );
      await audit(db, { actorId: auth.userId, action: 'products.image_updated', entity: 'product', entityId: id, before, after: rows[0], ip: req.ip });
      return { image: rows[0] };
    });
  });

  app.delete('/:id/images/:imageId', async (req) => {
    const auth = requirePermission(req, 'catalog.manage');
    const { id, imageId } = z.object({ id: z.uuid(), imageId: z.uuid() }).parse(req.params);
    const removed = await tx(auth.userId, async (db) => {
      const { rows } = await db.query('DELETE FROM product_images WHERE id = $1 AND product_id = $2 RETURNING *', [imageId, id]);
      if (!rows[0]) throw notFound();
      // A proxima imagem vira a principal.
      if (rows[0].is_primary) {
        await db.query('UPDATE product_images SET is_primary = true WHERE id = (SELECT id FROM product_images WHERE product_id = $1 ORDER BY position LIMIT 1)', [id]);
      }
      await audit(db, { actorId: auth.userId, action: 'products.image_removed', entity: 'product', entityId: id, before: rows[0], ip: req.ip });
      return rows[0];
    });
    await removeImage(removed.file_key);
    return { ok: true };
  });
}

/** Imagens publicas da loja. Cache longo: a chave muda a cada envio. */
export async function publicImageRoutes(app: FastifyInstance) {
  app.get('/images/:key/:size', async (req, reply) => {
    const { key, size } = z.object({ key: z.string().regex(/^[a-f0-9-]{36}$/), size: z.string().regex(/^\d+\.webp$/) }).parse(req.params);
    const n = Number(size.replace('.webp', ''));
    if (!(IMAGE_SIZES as readonly number[]).includes(n)) throw notFound();
    const data = await readImage(key, n as ImageSize);
    if (!data) throw notFound();
    return reply.header('Content-Type', 'image/webp').header('Cache-Control', 'public, max-age=31536000, immutable').send(data);
  });
}
