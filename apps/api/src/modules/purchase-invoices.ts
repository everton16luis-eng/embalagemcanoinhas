import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, notFound } from '../lib/errors.js';
import { saveFiscalFile, sendFiscalFile } from '../lib/fiscal-files.js';
import { MAX_XML_BYTES, parsePurchaseNfe, type PurchaseItem } from '../lib/nfe-xml.js';
import { requirePermission } from './auth.js';
import { currentCompany } from './company.js';

type Q = Db | typeof pool;
const idParams = z.object({ id: z.uuid() });

type Match = { packagingId: string; label: string; productName: string; sku: string; by: 'supplier_sku' | 'gtin' };

/**
 * Conferencia da nota de compra: fornecedor pelo CNPJ, itens pelo codigo do fornecedor ou pelo codigo de barras,
 * e, com pedido vinculado, quantidade e preco comparados item a item. So aponta divergencias; quem decide e a pessoa.
 */
export async function conference(db: Q, inv: Record<string, any>) {
  const supplier =
    (
      await db.query<{ id: string; name: string }>('SELECT id, name FROM suppliers WHERE id = $1 OR (document = $2 AND $1::uuid IS NULL) ORDER BY id = $1 DESC NULLS LAST LIMIT 1', [
        inv.supplier_id,
        inv.supplier_document,
      ])
    ).rows[0] ?? null;
  const company = await currentCompany(db);
  const warnings: string[] = [];
  if (!supplier) warnings.push('Fornecedor não cadastrado com este CNPJ.');
  if (company?.cnpj && inv.recipient_document && inv.recipient_document !== company.cnpj) warnings.push('O destinatário da nota não é o CNPJ da empresa.');
  if (inv.protocol_status !== '100') warnings.push(inv.protocol_status ? `Protocolo da SEFAZ com situação ${inv.protocol_status} (100 = autorizada).` : 'O XML não traz o protocolo de autorização (peça ao fornecedor o XML completo).');

  const orderItems = inv.purchase_order_id
    ? (
        await db.query<{ id: string; packaging_id: string; packaging_label: string; packs: string; pack_cost_cents: string; received_packs: string }>(
          'SELECT id, packaging_id, packaging_label, packs, pack_cost_cents, received_packs FROM purchase_order_items WHERE order_id = $1',
          [inv.purchase_order_id],
        )
      ).rows
    : [];
  const used = new Set<string>();

  const items = [];
  for (const it of inv.items as PurchaseItem[]) {
    let match: Match | null = null;
    if (supplier && it.code) {
      match =
        (
          await db.query<Match>(
            `SELECT k.id AS "packagingId", k.label, p.name AS "productName", v.sku, 'supplier_sku' AS by
             FROM supplier_products sp JOIN packagings k ON k.id = sp.packaging_id JOIN product_variants v ON v.id = k.variant_id JOIN products p ON p.id = v.product_id
             WHERE sp.supplier_id = $1 AND sp.supplier_sku = $2 LIMIT 1`,
            [supplier.id, it.code],
          )
        ).rows[0] ?? null;
    }
    if (!match && it.gtin) {
      match =
        (
          await db.query<Match>(
            `SELECT k.id AS "packagingId", k.label, p.name AS "productName", v.sku, 'gtin' AS by
             FROM packagings k JOIN product_variants v ON v.id = k.variant_id JOIN products p ON p.id = v.product_id
             WHERE k.barcode = $1 OR (v.barcode = $1 AND k.kind = 'purchase') ORDER BY (k.barcode = $1) DESC LIMIT 1`,
            [it.gtin],
          )
        ).rows[0] ?? null;
    }
    const divergences: string[] = [];
    let order = null;
    if (!match) divergences.push('Sem correspondência no cadastro (cadastre o código do fornecedor na oferta ou o código de barras na embalagem).');
    else if (inv.purchase_order_id) {
      const oi = orderItems.find((o) => o.packaging_id === match!.packagingId);
      if (!oi) divergences.push('Item não está no pedido de compra.');
      else {
        used.add(oi.id);
        order = { itemId: oi.id, packs: oi.packs, packCostCents: oi.pack_cost_cents, receivedPacks: oi.received_packs };
        if (Number(it.qty) !== Number(oi.packs) - Number(oi.received_packs)) divergences.push(`Quantidade: nota ${Number(it.qty)}, pendente no pedido ${Number(oi.packs) - Number(oi.received_packs)}.`);
        if (Math.abs(Number(it.unitValue) * 100 - Number(oi.pack_cost_cents)) >= 1) divergences.push(`Preço: nota R$ ${Number(it.unitValue).toFixed(2)}, pedido R$ ${(Number(oi.pack_cost_cents) / 100).toFixed(2)}.`);
      }
    }
    items.push({ ...it, match, order, divergences });
  }
  const missing = orderItems.filter((o) => !used.has(o.id) && Number(o.received_packs) < Number(o.packs)).map((o) => ({ itemId: o.id, label: o.packaging_label, pending: String(Number(o.packs) - Number(o.received_packs)) }));
  return { supplier, warnings, items, missingFromInvoice: missing, ok: !warnings.length && !missing.length && items.every((i) => !i.divergences.length) };
}

const view = async (db: Q, id: string) => {
  const inv = (
    await db.query(
      `SELECT i.*, po.number AS purchase_order_number, u.name AS created_by_name FROM purchase_invoices i
       LEFT JOIN purchase_orders po ON po.id = i.purchase_order_id JOIN users u ON u.id = i.created_by WHERE i.id = $1`,
      [id],
    )
  ).rows[0];
  if (!inv) throw notFound();
  const { storage_key: _k, ...rest } = inv;
  return { invoice: rest, conference: await conference(db, inv) };
};

export async function purchaseInvoiceRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    requirePermission(req, 'purchases.view');
    const { rows } = await pool.query(
      `SELECT i.id, i.access_key, i.series, i.number, i.issued_at, i.supplier_name, i.supplier_document, i.total_cents, i.protocol_status, i.created_at,
              i.purchase_order_id, po.number AS purchase_order_number, jsonb_array_length(i.items) AS item_count
       FROM purchase_invoices i LEFT JOIN purchase_orders po ON po.id = i.purchase_order_id ORDER BY i.created_at DESC LIMIT 100`,
    );
    return { invoices: rows };
  });

  app.get('/:id', async (req) => {
    requirePermission(req, 'purchases.view');
    return view(pool, idParams.parse(req.params).id);
  });

  app.get('/:id/xml', async (req, reply) => {
    requirePermission(req, 'purchases.view');
    const { id } = idParams.parse(req.params);
    const f = (await pool.query('SELECT storage_key, sha256, number FROM purchase_invoices WHERE id = $1', [id])).rows[0];
    if (!f) throw notFound();
    return sendFiscalFile(reply, { ...f, kind: 'nfe_xml', sequence: 1 }, `compra-nfe-${f.number}`);
  });

  /** Envio do XML. A mesma nota enviada de novo devolve a importacao existente. */
  app.post('/', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = requirePermission(req, 'purchases.manage');
    const file = await req.file({ limits: { fileSize: MAX_XML_BYTES, files: 1 } });
    if (!file) throw new AppError(400, 'FILE_REQUIRED', 'Envie o arquivo XML da nota.');
    const buf = await file.toBuffer().catch(() => {
      throw new AppError(413, 'TOO_LARGE', 'Arquivo grande demais.');
    });
    const nfe = parsePurchaseNfe(buf);
    const existing = (await pool.query<{ id: string }>('SELECT id FROM purchase_invoices WHERE access_key = $1', [nfe.accessKey])).rows[0];
    if (existing) return reply.code(200).send({ ...(await view(pool, existing.id)), duplicate: true });
    const saved = await saveFiscalFile(buf, 'nfe_xml');
    const id = await tx(auth.userId, async (db) => {
      const supplier = (await db.query<{ id: string }>('SELECT id FROM suppliers WHERE document = $1', [nfe.supplier.document])).rows[0];
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO purchase_invoices (access_key, series, number, issued_at, supplier_document, supplier_name, recipient_document, total_cents, protocol_status, items,
           storage_key, sha256, bytes, supplier_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (access_key) DO NOTHING RETURNING id`,
        [
          nfe.accessKey,
          nfe.series,
          nfe.number,
          nfe.issuedAt || null,
          nfe.supplier.document,
          nfe.supplier.name,
          nfe.recipientDocument,
          nfe.totalCents,
          nfe.protocolStatus,
          JSON.stringify(nfe.items),
          saved.key,
          saved.sha256,
          saved.bytes,
          supplier?.id ?? null,
          auth.userId,
        ],
      );
      if (!rows[0]) return (await db.query<{ id: string }>('SELECT id FROM purchase_invoices WHERE access_key = $1', [nfe.accessKey])).rows[0]!.id;
      await audit(db, { actorId: auth.userId, action: 'purchases.invoice_imported', entity: 'purchase_invoice', entityId: rows[0].id, after: { accessKey: nfe.accessKey, supplier: nfe.supplier.document }, ip: req.ip });
      return rows[0].id;
    });
    return reply.code(201).send(await view(pool, id));
  });

  /** Vincula a nota a um pedido de compra do mesmo fornecedor para conferir item a item. */
  app.post('/:id/link', async (req) => {
    const auth = requirePermission(req, 'purchases.manage');
    const { id } = idParams.parse(req.params);
    const { purchaseOrderId } = z.strictObject({ purchaseOrderId: z.uuid().nullable() }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const inv = (await db.query('SELECT id, supplier_document, supplier_id FROM purchase_invoices WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!inv) throw notFound();
      let supplierId = inv.supplier_id;
      if (purchaseOrderId) {
        const po = (await db.query<{ supplier_id: string; document: string | null }>('SELECT po.supplier_id, s.document FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1', [purchaseOrderId])).rows[0];
        if (!po) throw notFound();
        if (po.document !== inv.supplier_document) throw new AppError(422, 'SUPPLIER_MISMATCH', 'O pedido de compra é de outro fornecedor (CNPJ diferente do emitente da nota).');
        supplierId = po.supplier_id;
      }
      await db.query('UPDATE purchase_invoices SET purchase_order_id = $2, supplier_id = $3 WHERE id = $1', [id, purchaseOrderId, supplierId]);
      await audit(db, { actorId: auth.userId, action: 'purchases.invoice_linked', entity: 'purchase_invoice', entityId: id, after: { purchaseOrderId }, ip: req.ip });
      return view(db, id);
    });
  });
}
