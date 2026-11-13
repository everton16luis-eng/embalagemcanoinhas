import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { normalizeCnpj } from '../lib/br.js';
import { AppError, notFound } from '../lib/errors.js';
import { saveFiscalFile, sendFiscalFile } from '../lib/fiscal-files.js';
import { FiscalTransportError, type EventResult, type FileKind, type FiscalEnvironment, type FiscalProvider, type FiscalResult } from '../lib/fiscal.js';
import { buildNfePayload, REGIME, RESERVED_FIELDS, RESERVED_ITEM_FIELDS, type NfeAddress, type NfeInput } from '../lib/nfe-payload.js';
import { requirePermission } from './auth.js';
import { currentCompany } from './company.js';

declare module 'fastify' {
  interface FastifyInstance {
    fiscal: FiscalProvider | null;
  }
}

type Q = Db | typeof pool;
type Issue = { code: string; message: string; productId?: string };
type DocRow = {
  id: string;
  order_id: string;
  provider: string;
  environment: FiscalEnvironment;
  ref: string;
  status: 'pending' | 'processing' | 'authorized' | 'rejected' | 'canceled';
  payload: Record<string, unknown>;
  provider_files: Partial<Record<FileKind, string>>;
  number: string | null;
};

const idParams = z.object({ id: z.uuid() });
const EMITTABLE = ['paid', 'preparing', 'ready'];

const COMPANY_FIELDS: [string, string][] = [
  ['legal_name', 'razão social'],
  ['cnpj', 'CNPJ'],
  ['state_registration', 'inscrição estadual'],
  ['street', 'rua'],
  ['number', 'número'],
  ['district', 'bairro'],
  ['city', 'cidade'],
  ['city_ibge', 'código IBGE do município'],
  ['uf', 'UF'],
  ['cep', 'CEP'],
  ['tax_regime', 'regime tributário'],
];

const fiscalUnavailable = () => new AppError(503, 'FISCAL_UNAVAILABLE', 'Provedor fiscal não configurado.');

async function orderNote(db: Db, orderId: string, note: string, actorId: string | null) {
  await db.query(`INSERT INTO order_events (order_id, status, note, actor_id) VALUES ($1, 'invoice', $2, $3)`, [orderId, note.slice(0, 500), actorId]);
}

async function setInvoiceStatus(db: Db, orderId: string, status: string) {
  await db.query('UPDATE orders SET invoice_status = $2, updated_at = now(), version = version + 1 WHERE id = $1 AND invoice_status <> $2', [orderId, status]);
}

async function docEvent(db: Db, documentId: string, e: { kind: string; status?: string | null; sefazStatus?: string | null; message?: string | null; data?: unknown; actorId?: string | null }) {
  await db.query(`INSERT INTO fiscal_document_events (document_id, kind, status, sefaz_status, message, data, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    documentId,
    e.kind,
    e.status ?? null,
    e.sefazStatus ?? null,
    e.message ? e.message.slice(0, 2000) : null,
    JSON.stringify(e.data ?? {}),
    e.actorId ?? null,
  ]);
}

// ---------------- conferencia antes da emissao ----------------

/** Endereco do destinatario: o de entrega; na retirada, o principal do cliente. */
async function buyerAddress(db: Q, order: { ship_to: NfeAddress | null; customer_id: string | null }): Promise<NfeAddress | null> {
  if (order.ship_to) return order.ship_to;
  if (!order.customer_id) return null;
  const a = (
    await db.query('SELECT street, number, complement, district, city, uf, cep FROM customer_addresses WHERE customer_id = $1 ORDER BY is_default DESC, created_at LIMIT 1', [order.customer_id])
  ).rows[0];
  return a ?? null;
}

export async function emissionContext(db: Q, provider: FiscalProvider | null, orderId: string) {
  const settings = (await db.query('SELECT * FROM fiscal_settings')).rows[0];
  const company = await currentCompany(db);
  const order = (await db.query('SELECT * FROM orders WHERE id = $1', [orderId])).rows[0];
  if (!order) throw notFound();
  const items = (
    await db.query(
      `SELECT oi.sku, oi.product_name, oi.packaging_label, oi.packs, oi.unit_price_cents, oi.total_cents, oi.base_qty_per_pack, pk.unit_code,
              p.id AS product_id, f.ncm, f.origin, f.tax_unit, f.tax_unit_qty, coalesce(f.status, 'pending') AS fiscal_status
       FROM order_items oi
       JOIN packagings pk ON pk.id = oi.packaging_id
       JOIN product_variants v ON v.id = oi.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN product_fiscal f ON f.product_id = p.id
       WHERE oi.order_id = $1 ORDER BY oi.sku`,
      [orderId],
    )
  ).rows;

  const issues: Issue[] = [];
  const env = settings.environment as FiscalEnvironment;
  if (!provider) issues.push({ code: 'NO_PROVIDER', message: 'Provedor fiscal não configurado no servidor.' });
  else if (!provider.configured(env)) issues.push({ code: 'PROVIDER_ENV', message: `Sem credencial do provedor fiscal para ${env === 'producao' ? 'produção' : 'homologação'}.` });
  if (!EMITTABLE.includes(order.status)) issues.push({ code: 'ORDER_STATUS', message: 'A nota é emitida para pedido pago e ainda não despachado.' });

  const missing = COMPANY_FIELDS.filter(([k]) => !company?.[k]).map(([, label]) => label);
  if (missing.length) issues.push({ code: 'COMPANY_INCOMPLETE', message: `Dados da empresa incompletos: ${missing.join(', ')}.` });
  if (company?.tax_regime && !REGIME[company.tax_regime]) issues.push({ code: 'REGIME_UNSUPPORTED', message: 'Regime tributário sem mapeamento confirmado para a NF-e (MEI). Confirme com o contador.' });

  const address = await buyerAddress(db, order);
  if (!address) issues.push({ code: 'BUYER_ADDRESS', message: 'Pedido sem endereço do destinatário. Cadastre um endereço na conta do cliente.' });
  const buyer = order.buyer as { kind: 'pf' | 'pj'; name: string; document: string | null; stateRegistration: string | null; phone: string | null; email: string | null };
  if (!buyer.document) issues.push({ code: 'BUYER_DOCUMENT', message: 'Pedido sem CPF ou CNPJ do comprador.' });

  const destination = address && company?.uf ? (address.uf === company.uf ? 'internal' : 'interstate') : null;
  const buyerKind = buyer.kind === 'pf' ? 'pf' : buyer.stateRegistration ? 'pj_contribuinte' : 'pj_nao_contribuinte';
  const rule = destination ? (await db.query('SELECT * FROM fiscal_rules WHERE active AND destination = $1 AND buyer_kind = $2', [destination, buyerKind])).rows[0] : null;
  if (destination && !rule) issues.push({ code: 'RULE_MISSING', message: `Sem regra fiscal para venda ${destination === 'internal' ? 'dentro do estado' : 'para outro estado'} a ${BUYER_LABEL[buyerKind]}.` });
  else if (rule && rule.status !== 'validated') issues.push({ code: 'RULE_NOT_VALIDATED', message: `A regra fiscal "${rule.name}" ainda não foi validada pelo contador.` });

  for (const i of items) {
    if (i.fiscal_status !== 'validated') issues.push({ code: 'PRODUCT_FISCAL', productId: i.product_id, message: `${i.product_name}: cadastro fiscal (NCM, origem) não validado pelo contador.` });
  }

  if (issues.length) return { issues, environment: env } as const;
  const input: NfeInput = {
    environment: env,
    issuedAt: new Date(),
    company,
    rule,
    destination: destination!,
    buyer: { kind: buyer.kind, name: buyer.name, document: buyer.document!, stateRegistration: buyer.stateRegistration ?? null, phone: buyer.phone ?? null, email: buyer.email ?? null },
    address: address!,
    shippingKind: order.shipping_snapshot?.kind === 'delivery' ? 'delivery' : 'pickup',
    paymentMethod: order.payment_method,
    subtotalCents: Number(order.subtotal_cents),
    discountCents: Number(order.discount_cents),
    freightCents: Number(order.freight_cents),
    totalCents: Number(order.total_cents),
    items: items.map((i) => ({
      sku: i.sku,
      description: `${i.product_name} - ${i.packaging_label}`,
      unitCode: i.unit_code,
      packs: i.packs,
      unitPriceCents: Number(i.unit_price_cents),
      totalCents: Number(i.total_cents),
      baseQtyPerPack: i.base_qty_per_pack,
      ncm: i.ncm,
      origin: i.origin,
      taxUnit: i.tax_unit,
      taxUnitQty: i.tax_unit_qty,
    })),
  };
  return { issues, environment: env, input, rule, company, order } as const;
}

const BUYER_LABEL: Record<string, string> = { pf: 'pessoa física', pj_contribuinte: 'empresa contribuinte de ICMS', pj_nao_contribuinte: 'empresa não contribuinte' };

// ---------------- emissao e acompanhamento ----------------

const loadDoc = async (db: Q, id: string, lock = false) =>
  (await db.query<DocRow>(`SELECT id, order_id, provider, environment, ref, status, payload, provider_files, number FROM fiscal_documents WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];

/**
 * Grava a situacao vinda do provedor. Trava o pedido antes do documento (mesma ordem da emissao).
 * Situacao repetida nao gera efeito; transicao invalida fica so no historico.
 */
export async function applyResult(docId: string, r: FiscalResult, kind: 'submitted' | 'status' | 'webhook', actorId: string | null = null) {
  return tx(actorId, async (db) => {
    const head = await loadDoc(db, docId);
    if (!head) throw notFound();
    await db.query('SELECT 1 FROM orders WHERE id = $1 FOR UPDATE', [head.order_id]);
    const doc = (await loadDoc(db, docId, true))!;
    await db.query('UPDATE fiscal_documents SET check_count = check_count + 1, last_checked_at = now() WHERE id = $1', [docId]);
    const open = doc.status === 'pending' || doc.status === 'processing';
    const files = { ...doc.provider_files, ...r.files };
    let changed = false;

    if (r.status === 'processing' && open) {
      if (doc.status === 'pending') await db.query(`UPDATE fiscal_documents SET status = 'processing' WHERE id = $1`, [docId]);
      changed = doc.status === 'pending';
    } else if (r.status === 'authorized' && open) {
      await db.query(
        `UPDATE fiscal_documents SET status = 'authorized', access_key = $2, number = $3, series = $4, sefaz_status = $5, sefaz_message = $6, provider_files = $7, authorized_at = now(), errors = NULL WHERE id = $1`,
        [docId, r.accessKey, r.number, r.series, r.sefazStatus, r.sefazMessage, JSON.stringify(files)],
      );
      await setInvoiceStatus(db, doc.order_id, 'authorized');
      await orderNote(db, doc.order_id, `NF-e nº ${r.number} (série ${r.series}) autorizada${doc.environment === 'homologacao' ? ' em homologação, sem valor fiscal' : ''}.`, actorId);
      changed = true;
    } else if (r.status === 'rejected' && open) {
      await db.query(`UPDATE fiscal_documents SET status = 'rejected', sefaz_status = $2, sefaz_message = $3, errors = $4 WHERE id = $1`, [
        docId,
        r.sefazStatus,
        r.sefazMessage,
        JSON.stringify(r.errors),
      ]);
      await setInvoiceStatus(db, doc.order_id, 'rejected');
      await orderNote(db, doc.order_id, `NF-e rejeitada: ${r.sefazMessage ?? r.errors.map((e) => e.message).join('; ')}`.slice(0, 500), actorId);
      changed = true;
    } else if (r.status === 'canceled' && doc.status === 'authorized') {
      // Cancelada fora da loja (painel do provedor): registra para nao divergir.
      await db.query(`UPDATE fiscal_documents SET status = 'canceled', canceled_at = now(), cancel_reason = $2, provider_files = $3 WHERE id = $1`, [
        docId,
        'Cancelamento registrado no provedor fiscal.',
        JSON.stringify(files),
      ]);
      await setInvoiceStatus(db, doc.order_id, 'canceled');
      await orderNote(db, doc.order_id, `NF-e nº ${doc.number} cancelada no provedor fiscal.`, actorId);
      changed = true;
    } else if (JSON.stringify(files) !== JSON.stringify(doc.provider_files)) {
      await db.query('UPDATE fiscal_documents SET provider_files = $2 WHERE id = $1', [docId, JSON.stringify(files)]);
    }
    if (changed || kind !== 'status') {
      await docEvent(db, docId, { kind, status: r.status, sefazStatus: r.sefazStatus, message: r.sefazMessage, data: r.errors.length ? { errors: r.errors } : {}, actorId });
    }
    return changed;
  });
}

async function storeOne(provider: FiscalProvider, env: FiscalEnvironment, owner: { documentId?: string; inutilizationId?: string }, kind: FileKind, sequence: number, path: string) {
  const buf = await provider.download(env, path);
  const saved = await saveFiscalFile(buf, kind);
  await tx(null, async (db) => {
    await db.query(
      `INSERT INTO fiscal_files (document_id, inutilization_id, kind, sequence, storage_key, sha256, bytes) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (document_id, kind, sequence) WHERE document_id IS NOT NULL DO NOTHING`,
      [owner.documentId ?? null, owner.inutilizationId ?? null, kind, sequence, saved.key, saved.sha256, saved.bytes],
    );
    if (owner.documentId) await docEvent(db, owner.documentId, { kind: 'file', message: kind, data: { sha256: saved.sha256, bytes: saved.bytes, sequence } });
  });
}

/** Baixa o que o provedor informou e ainda nao esta guardado. Falha de um arquivo nao impede os outros. */
export async function storeFiles(provider: FiscalProvider, docId: string) {
  const doc = await loadDoc(pool, docId);
  if (!doc) return [];
  const have = new Set((await pool.query<{ kind: string }>('SELECT kind FROM fiscal_files WHERE document_id = $1 AND sequence = 1', [docId])).rows.map((r) => r.kind));
  const failures: string[] = [];
  for (const kind of ['nfe_xml', 'danfe_pdf', 'cancel_xml'] as const) {
    const path = doc.provider_files[kind];
    if (!path || have.has(kind)) continue;
    try {
      await storeOne(provider, doc.environment, { documentId: docId }, kind, 1, path);
    } catch (err) {
      failures.push(`${kind}: ${(err as Error).message}`);
    }
  }
  return failures;
}

async function submit(provider: FiscalProvider, doc: DocRow, actorId: string | null) {
  try {
    const r = await provider.emit(doc.environment, doc.ref, doc.payload);
    await applyResult(doc.id, r, 'submitted', actorId);
    if (r.status === 'authorized') await storeFiles(provider, doc.id);
    return null;
  } catch (err) {
    if (!(err instanceof FiscalTransportError)) throw err;
    // Nao se sabe se o provedor recebeu: fica pendente e a rotina consulta pela ref antes de reenviar.
    await tx(actorId, (db) => docEvent(db, doc.id, { kind: 'submit_failed', message: err.message, actorId }));
    return err.message;
  }
}

/** Consulta a situacao no provedor. Pendente que o provedor nao conhece e reenviado com a mesma ref. */
export async function syncDocument(provider: FiscalProvider, docId: string, kind: 'status' | 'webhook' = 'status') {
  const doc = await loadDoc(pool, docId);
  if (!doc) throw notFound();
  if (doc.provider !== provider.name) return { error: 'Documento emitido por outro provedor.' };
  if (doc.status === 'pending' || doc.status === 'processing') {
    let r: FiscalResult;
    try {
      r = await provider.get(doc.environment, doc.ref);
    } catch (err) {
      if (!(err instanceof FiscalTransportError)) throw err;
      await pool.query('UPDATE fiscal_documents SET check_count = check_count + 1, last_checked_at = now() WHERE id = $1', [docId]);
      return { error: err.message };
    }
    if (r.status === 'not_found') {
      if (doc.status === 'pending') return { error: await submit(provider, doc, null) };
      await pool.query('UPDATE fiscal_documents SET check_count = check_count + 1, last_checked_at = now() WHERE id = $1', [docId]);
      return { error: 'O provedor não encontrou a nota.' };
    }
    await applyResult(docId, r, kind);
  } else if (kind === 'webhook' && doc.status === 'authorized') {
    // Aviso de nota ja autorizada: confere se foi cancelada fora da loja.
    try {
      await applyResult(docId, await provider.get(doc.environment, doc.ref), kind);
    } catch (err) {
      if (!(err instanceof FiscalTransportError)) throw err;
    }
  }
  const failures = await storeFiles(provider, docId);
  return { error: failures.length ? failures.join('; ') : null };
}

/**
 * Emite a NF-e do pedido. Idempotente: com nota ativa (pendente, em processamento ou autorizada), devolve a mesma.
 * O documento e criado e o pedido marcado antes de chamar o provedor; dois cliques nao geram duas notas.
 */
export async function emitForOrder(provider: FiscalProvider | null, orderId: string, actorId: string | null, ip?: string) {
  const prep = await tx(actorId, async (db) => {
    const locked = (await db.query('SELECT number FROM orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
    if (!locked) throw notFound();
    const active = (await db.query<DocRow>(`SELECT id FROM fiscal_documents WHERE order_id = $1 AND purpose = 'sale' AND status IN ('pending', 'processing', 'authorized')`, [orderId])).rows[0];
    if (active) return { docId: active.id, created: false };
    const ctx = await emissionContext(db, provider, orderId);
    if (ctx.issues.length || !ctx.input) throw new AppError(422, 'FISCAL_NOT_READY', 'A nota ainda não pode ser emitida. Veja os itens pendentes.', { issues: ctx.issues });
    const attempt = Number((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM fiscal_documents WHERE order_id = $1', [orderId])).rows[0]!.n) + 1;
    const ref = `${ctx.environment === 'producao' ? 'p' : 'h'}${locked.number}-${attempt}-${randomBytes(3).toString('hex')}`;
    const payload = buildNfePayload(ctx.input);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO fiscal_documents (order_id, provider, environment, ref, attempt, company_version, rule_id, payload, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [orderId, provider!.name, ctx.environment, ref, attempt, ctx.company.version, ctx.rule.id, JSON.stringify(payload), actorId],
    );
    await docEvent(db, rows[0]!.id, { kind: 'created', status: 'pending', message: `Tentativa ${attempt}`, actorId });
    await setInvoiceStatus(db, orderId, 'processing');
    await audit(db, { actorId, action: 'fiscal.nfe_emit', entity: 'order', entityId: orderId, after: { ref, attempt, environment: ctx.environment }, ip });
    return { docId: rows[0]!.id, created: true };
  });
  let warning: string | null = null;
  if (prep.created) warning = await submit(provider!, (await loadDoc(pool, prep.docId))!, actorId);
  return { ...prep, warning };
}

/** Rotina de 1 minuto: acompanha notas em aberto, baixa arquivos faltantes e, se configurado, emite ao pagar. */
export async function fiscalTick(provider: FiscalProvider | null, limit = 20) {
  if (!provider) return { synced: 0, emitted: 0 };
  // Espera crescente entre consultas: 30 s por tentativa, no maximo 30 min.
  const open = (
    await pool.query<{ id: string }>(
      `SELECT id FROM fiscal_documents WHERE status IN ('pending', 'processing') AND provider = $1
         AND (last_checked_at IS NULL OR last_checked_at < now() - make_interval(secs => least(30 * greatest(check_count, 1), 1800)))
       ORDER BY last_checked_at NULLS FIRST LIMIT $2`,
      [provider.name, limit],
    )
  ).rows;
  const missingFiles = (
    await pool.query<{ id: string }>(
      `SELECT d.id FROM fiscal_documents d WHERE d.status IN ('authorized', 'canceled') AND d.provider = $1 AND d.updated_at > now() - interval '7 days'
         AND NOT EXISTS (SELECT 1 FROM fiscal_files f WHERE f.document_id = d.id AND f.kind = 'nfe_xml') LIMIT 10`,
      [provider.name],
    )
  ).rows;
  let synced = 0;
  for (const d of [...open, ...missingFiles]) {
    await syncDocument(provider, d.id).catch(() => null);
    synced += 1;
  }
  let emitted = 0;
  const policy = (await pool.query<{ emission_policy: string }>('SELECT emission_policy FROM fiscal_settings')).rows[0]?.emission_policy;
  if (policy === 'on_paid') {
    const due = (
      await pool.query<{ id: string }>(
        `SELECT o.id FROM orders o WHERE o.status IN ('paid', 'preparing', 'ready') AND o.invoice_status = 'pending' AND o.paid_at > now() - interval '30 days'
         ORDER BY o.paid_at LIMIT 10`,
      )
    ).rows;
    for (const o of due) {
      const r = await emitForOrder(provider, o.id, null).catch(() => null);
      if (r?.created) emitted += 1;
    }
  }
  return { synced, emitted };
}

// ---------------- cancelamento, carta de correcao, inutilizacao ----------------

async function cancelDocument(provider: FiscalProvider, docId: string, reason: string, actorId: string, ip: string) {
  const doc = await loadDoc(pool, docId);
  if (!doc) throw notFound();
  if (doc.status !== 'authorized') throw new AppError(409, 'NOT_AUTHORIZED', 'Só nota autorizada pode ser cancelada.');
  let r: EventResult;
  try {
    r = await provider.cancel(doc.environment, doc.ref, reason);
  } catch (err) {
    if (err instanceof FiscalTransportError) throw new AppError(502, 'FISCAL_PROVIDER_ERROR', err.message);
    throw err;
  }
  await tx(actorId, async (db) => {
    await db.query('SELECT 1 FROM orders WHERE id = $1 FOR UPDATE', [doc.order_id]);
    const cur = (await loadDoc(db, docId, true))!;
    if (!r.ok) {
      await docEvent(db, docId, { kind: 'cancel_failed', sefazStatus: r.sefazStatus, message: r.sefazMessage, data: { reason, errors: r.errors }, actorId });
      return;
    }
    if (cur.status === 'authorized') {
      await db.query(`UPDATE fiscal_documents SET status = 'canceled', canceled_at = now(), cancel_reason = $2, provider_files = $3 WHERE id = $1`, [
        docId,
        reason,
        JSON.stringify({ ...cur.provider_files, ...r.files }),
      ]);
      await setInvoiceStatus(db, doc.order_id, 'canceled');
      await orderNote(db, doc.order_id, `NF-e nº ${doc.number} cancelada: ${reason}`, actorId);
    }
    await docEvent(db, docId, { kind: 'cancel', status: 'canceled', sefazStatus: r.sefazStatus, message: r.sefazMessage, data: { reason }, actorId });
    await audit(db, { actorId, action: 'fiscal.nfe_cancel', entity: 'fiscal_document', entityId: docId, after: { reason }, ip });
  });
  if (!r.ok) throw new AppError(422, 'CANCEL_REJECTED', `Cancelamento não aceito: ${r.sefazMessage ?? r.errors.map((e) => e.message).join('; ')}`);
  await storeFiles(provider, docId);
}

async function correctDocument(provider: FiscalProvider, docId: string, text: string, actorId: string, ip: string) {
  const doc = await loadDoc(pool, docId);
  if (!doc) throw notFound();
  if (doc.status !== 'authorized') throw new AppError(409, 'NOT_AUTHORIZED', 'Carta de correção só para nota autorizada.');
  const done = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM fiscal_document_events WHERE document_id = $1 AND kind = 'correction'`, [docId])).rows[0]!.n;
  if (done >= 20) throw new AppError(422, 'CORRECTION_LIMIT', 'Limite de 20 cartas de correção para esta nota.');
  let r: EventResult;
  try {
    r = await provider.correct(doc.environment, doc.ref, text);
  } catch (err) {
    if (err instanceof FiscalTransportError) throw new AppError(502, 'FISCAL_PROVIDER_ERROR', err.message);
    throw err;
  }
  const sequence = r.sequence ?? done + 1;
  await tx(actorId, async (db) => {
    await docEvent(db, docId, { kind: r.ok ? 'correction' : 'correction_failed', sefazStatus: r.sefazStatus, message: r.sefazMessage, data: { text, sequence, errors: r.errors }, actorId });
    if (r.ok) await audit(db, { actorId, action: 'fiscal.nfe_correction', entity: 'fiscal_document', entityId: docId, after: { text, sequence }, ip });
  });
  if (!r.ok) throw new AppError(422, 'CORRECTION_REJECTED', `Carta de correção não aceita: ${r.sefazMessage ?? r.errors.map((e) => e.message).join('; ')}`);
  for (const [kind, path] of Object.entries(r.files) as [FileKind, string][]) {
    await storeOne(provider, doc.environment, { documentId: docId }, kind, sequence, path).catch(() => null);
  }
  return sequence;
}

// ---------------- validacao de regra e certificado ----------------

const extraFields = (reserved: Set<string>) =>
  z
    .record(z.string().regex(/^[a-z][a-z0-9_]{1,60}$/, 'Nome de campo do provedor: minúsculas, números e _.'), z.union([z.string().max(200), z.number(), z.boolean()]))
    .default({})
    .refine((o) => Object.keys(o).length <= 40, 'No máximo 40 campos adicionais.')
    .refine((o) => !Object.keys(o).some((k) => reserved.has(k)), 'Campo adicional não pode substituir um campo montado pela loja.');

const ruleSchema = z.strictObject({
  name: z.string().trim().min(2).max(80),
  destination: z.enum(['internal', 'interstate']),
  buyerKind: z.enum(['pf', 'pj_contribuinte', 'pj_nao_contribuinte']),
  naturezaOperacao: z.string().trim().min(2).max(60),
  cfop: z.string().trim().regex(/^[5-7]\d{3}$/, 'CFOP de saída: 4 dígitos começando por 5, 6 ou 7.'),
  icmsSituacaoTributaria: z.string().trim().regex(/^\d{2,3}$/, 'CST (2 dígitos) ou CSOSN (3 dígitos).'),
  pisSituacaoTributaria: z.string().trim().regex(/^\d{2}$/, 'CST do PIS: 2 dígitos.'),
  cofinsSituacaoTributaria: z.string().trim().regex(/^\d{2}$/, 'CST da COFINS: 2 dígitos.'),
  consumidorFinal: z.boolean(),
  presencaComprador: z.number().int().min(0).max(9),
  extraFields: extraFields(RESERVED_FIELDS),
  itemExtraFields: extraFields(RESERVED_ITEM_FIELDS),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const ruleValues = (r: z.infer<typeof ruleSchema>) => [
  r.name,
  r.destination,
  r.buyerKind,
  r.naturezaOperacao,
  r.cfop,
  r.icmsSituacaoTributaria,
  r.pisSituacaoTributaria,
  r.cofinsSituacaoTributaria,
  r.consumidorFinal,
  r.presencaComprador,
  JSON.stringify(r.extraFields),
  JSON.stringify(r.itemExtraFields),
  r.notes ?? null,
];

/** Dias ate o vencimento do certificado e o nivel do aviso (30, 15 e 7 dias). */
export function certificateAlert(validUntil: string | Date, now = new Date()) {
  // Coluna date chega do pg como Date na meia-noite local; vale o dia inteiro em Brasilia.
  const ymd =
    typeof validUntil === 'string'
      ? validUntil.slice(0, 10)
      : `${validUntil.getFullYear()}-${String(validUntil.getMonth() + 1).padStart(2, '0')}-${String(validUntil.getDate()).padStart(2, '0')}`;
  const end = new Date(`${ymd}T23:59:59-03:00`);
  const days = Math.floor((end.getTime() - now.getTime()) / 86_400_000);
  const level = days < 0 ? 'expired' : days <= 7 ? 'd7' : days <= 15 ? 'd15' : days <= 30 ? 'd30' : 'ok';
  return { days, level };
}

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505';

// ---------------- rotas do painel ----------------

export async function fiscalRoutes(app: FastifyInstance) {
  const provider = () => {
    if (!app.fiscal) throw fiscalUnavailable();
    return app.fiscal;
  };

  app.get('/overview', async (req) => {
    requirePermission(req, 'fiscal.view');
    const settings = (await pool.query('SELECT * FROM fiscal_settings')).rows[0];
    const cert = (await pool.query('SELECT id, holder_name, cnpj, valid_from, valid_until, fingerprint, notes, created_at FROM fiscal_certificates WHERE active')).rows[0] ?? null;
    const counts = Object.fromEntries((await pool.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM fiscal_documents GROUP BY status')).rows.map((r) => [r.status, r.n]));
    const rules = (await pool.query<{ total: number; validated: number }>(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'validated')::int AS validated FROM fiscal_rules WHERE active`)).rows[0];
    const products = (
      await pool.query<{ pending: number }>(`SELECT count(*)::int AS pending FROM products p LEFT JOIN product_fiscal f ON f.product_id = p.id WHERE p.status = 'active' AND coalesce(f.status, 'pending') <> 'validated'`)
    ).rows[0];
    const homologAuthorized = (await pool.query(`SELECT 1 FROM fiscal_documents WHERE environment = 'homologacao' AND status IN ('authorized', 'canceled') LIMIT 1`)).rowCount;
    const awaitingInvoice = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM orders WHERE status IN ('paid', 'preparing', 'ready') AND invoice_status IN ('pending', 'rejected')`)).rows[0]!.n;
    const p = app.fiscal;
    return {
      settings,
      provider: p ? { name: p.name, homologacao: p.configured('homologacao'), producao: p.configured('producao') } : null,
      certificate: cert ? { ...cert, alert: certificateAlert(cert.valid_until) } : null,
      documents: counts,
      rules,
      productsPendingValidation: products!.pending,
      awaitingInvoice,
      productionChecklist: {
        accredited: settings.accreditation_status === 'accredited',
        homologationAuthorized: Boolean(homologAuthorized),
        productionCredential: Boolean(p?.configured('producao')),
        released: Boolean(settings.production_released_at),
      },
    };
  });

  // ---- regras fiscais ----
  app.get('/rules', async (req) => {
    requirePermission(req, 'fiscal.view');
    const { rows } = await pool.query(
      `SELECT r.*, ui.name AS informed_by_name FROM fiscal_rules r LEFT JOIN users ui ON ui.id = r.informed_by ORDER BY r.active DESC, r.destination, r.buyer_kind, r.updated_at DESC`,
    );
    return { rules: rows };
  });

  app.post('/rules', async (req, reply) => {
    const auth = requirePermission(req, 'fiscal.manage');
    const r = ruleSchema.parse(req.body);
    return tx(auth.userId, async (db) => {
      try {
        const { rows } = await db.query(
          `INSERT INTO fiscal_rules (name, destination, buyer_kind, natureza_operacao, cfop, icms_situacao_tributaria, pis_situacao_tributaria, cofins_situacao_tributaria,
             consumidor_final, presenca_comprador, extra_fields, item_extra_fields, notes, informed_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
          [...ruleValues(r), auth.userId],
        );
        await audit(db, { actorId: auth.userId, action: 'fiscal.rule_created', entity: 'fiscal_rule', entityId: rows[0].id, after: rows[0], ip: req.ip });
        return reply.code(201).send({ rule: rows[0] });
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError(409, 'RULE_EXISTS', 'Já existe regra ativa para esta operação. Edite a existente ou desative-a.');
        throw err;
      }
    });
  });

  app.put('/rules/:id', async (req) => {
    const auth = requirePermission(req, 'fiscal.manage');
    const { id } = idParams.parse(req.params);
    const r = ruleSchema.parse(req.body);
    return tx(auth.userId, async (db) => {
      const before = (await db.query('SELECT * FROM fiscal_rules WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw notFound();
      if (!before.active) throw new AppError(409, 'RULE_INACTIVE', 'Regra desativada não é editada. Crie outra.');
      try {
        const { rows } = await db.query(
          `UPDATE fiscal_rules SET name = $1, destination = $2, buyer_kind = $3, natureza_operacao = $4, cfop = $5, icms_situacao_tributaria = $6,
             pis_situacao_tributaria = $7, cofins_situacao_tributaria = $8, consumidor_final = $9, presenca_comprador = $10, extra_fields = $11,
             item_extra_fields = $12, notes = $13, informed_by = $14, informed_at = now()
           WHERE id = $15 RETURNING *`,
          [...ruleValues(r), auth.userId, id],
        );
        await audit(db, { actorId: auth.userId, action: 'fiscal.rule_updated', entity: 'fiscal_rule', entityId: id, before, after: rows[0], ip: req.ip });
        return { rule: rows[0] };
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError(409, 'RULE_EXISTS', 'Já existe regra ativa para esta operação.');
        throw err;
      }
    });
  });

  app.post('/rules/:id/validate', async (req) => {
    const auth = requirePermission(req, 'fiscal.validate');
    const { id } = idParams.parse(req.params);
    const { validatorName } = z.strictObject({ validatorName: z.string().trim().min(2).max(120) }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const before = (await db.query('SELECT * FROM fiscal_rules WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw notFound();
      if (!before.active) throw new AppError(409, 'RULE_INACTIVE', 'Regra desativada.');
      const { rows } = await db.query(`UPDATE fiscal_rules SET status = 'validated', validated_by = $2, validator_name = $3, validated_at = now() WHERE id = $1 RETURNING *`, [
        id,
        auth.userId,
        validatorName,
      ]);
      await audit(db, { actorId: auth.userId, action: 'fiscal.rule_validated', entity: 'fiscal_rule', entityId: id, before, after: rows[0], ip: req.ip });
      return { rule: rows[0] };
    });
  });

  app.post('/rules/:id/deactivate', async (req) => {
    const auth = requirePermission(req, 'fiscal.manage');
    const { id } = idParams.parse(req.params);
    return tx(auth.userId, async (db) => {
      const { rows } = await db.query('UPDATE fiscal_rules SET active = false WHERE id = $1 AND active RETURNING *', [id]);
      if (!rows[0]) throw notFound();
      await audit(db, { actorId: auth.userId, action: 'fiscal.rule_deactivated', entity: 'fiscal_rule', entityId: id, ip: req.ip });
      return { rule: rows[0] };
    });
  });

  app.get('/rules/:id/history', async (req) => {
    requirePermission(req, 'fiscal.view');
    const { id } = idParams.parse(req.params);
    const { rows } = await pool.query(
      `SELECT h.snapshot, h.changed_at, u.name AS changed_by FROM fiscal_rules_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.rule_id = $1 ORDER BY h.id DESC LIMIT 100`,
      [id],
    );
    return { history: rows };
  });

  // ---- notas do pedido ----
  app.get('/orders/:id', async (req) => {
    requirePermission(req, 'fiscal.view');
    const { id } = idParams.parse(req.params);
    const ctx = await emissionContext(pool, app.fiscal, id);
    const documents = (
      await pool.query(
        `SELECT id, ref, attempt, status, environment, number, series, access_key, sefaz_status, sefaz_message, errors, authorized_at, canceled_at, cancel_reason, created_at
         FROM fiscal_documents WHERE order_id = $1 ORDER BY created_at DESC`,
        [id],
      )
    ).rows;
    return { issues: ctx.issues, environment: ctx.environment, ready: ctx.issues.length === 0, documents };
  });

  app.post('/orders/:id/emit', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = requirePermission(req, 'fiscal.manage');
    const { id } = idParams.parse(req.params);
    const r = await emitForOrder(provider(), id, auth.userId, req.ip);
    const document = (await pool.query('SELECT id, ref, status, environment, number, series, access_key, sefaz_status, sefaz_message, errors FROM fiscal_documents WHERE id = $1', [r.docId])).rows[0];
    return reply.code(r.created ? 201 : 200).send({ document, created: r.created, warning: r.warning });
  });

  // ---- documentos ----
  app.get('/documents', async (req) => {
    requirePermission(req, 'fiscal.view');
    const q = z
      .object({
        status: z.enum(['pending', 'processing', 'authorized', 'rejected', 'canceled']).optional(),
        q: z.string().trim().max(60).optional(),
        page: z.coerce.number().int().min(1).max(1000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(req.query);
    const n = q.q && /^\d{1,9}$/.test(q.q) ? q.q : null;
    const { rows } = await pool.query(
      `SELECT d.id, d.status, d.environment, d.number, d.series, d.access_key, d.ref, d.sefaz_message, d.created_at, d.authorized_at,
              o.id AS order_id, o.number AS order_number, o.buyer->>'name' AS buyer_name, o.total_cents, count(*) OVER () AS total
       FROM fiscal_documents d JOIN orders o ON o.id = d.order_id
       WHERE ($1::text IS NULL OR d.status = $1)
         AND ($2::text IS NULL OR d.number = $2 OR o.number::text = $2 OR d.access_key = $3 OR o.buyer->>'name' ILIKE '%' || $3 || '%')
       ORDER BY d.created_at DESC LIMIT $4 OFFSET $5`,
      [q.status ?? null, n, q.q ? q.q.replace(/[%_]/g, '') : null, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { documents: rows.map(({ total: _t, ...r }) => r), total: Number(rows[0]?.total ?? 0), page: q.page, pageSize: q.pageSize };
  });

  app.get('/documents/:id', async (req) => {
    requirePermission(req, 'fiscal.view');
    const { id } = idParams.parse(req.params);
    const document = (
      await pool.query(
        `SELECT d.*, o.number AS order_number, o.buyer->>'name' AS buyer_name, u.name AS created_by_name
         FROM fiscal_documents d JOIN orders o ON o.id = d.order_id LEFT JOIN users u ON u.id = d.created_by WHERE d.id = $1`,
        [id],
      )
    ).rows[0];
    if (!document) throw notFound();
    const events = (
      await pool.query(
        `SELECT e.kind, e.status, e.sefaz_status, e.message, e.data, e.created_at, u.name AS actor_name FROM fiscal_document_events e LEFT JOIN users u ON u.id = e.actor_id
         WHERE e.document_id = $1 ORDER BY e.id`,
        [id],
      )
    ).rows;
    const files = (await pool.query('SELECT id, kind, sequence, sha256, bytes, created_at FROM fiscal_files WHERE document_id = $1 ORDER BY created_at', [id])).rows;
    return { document, events, files };
  });

  app.post('/documents/:id/sync', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    requirePermission(req, 'fiscal.manage');
    const { id } = idParams.parse(req.params);
    const r = await syncDocument(provider(), id);
    const document = (await pool.query('SELECT id, status, number, series, access_key, sefaz_status, sefaz_message, errors FROM fiscal_documents WHERE id = $1', [id])).rows[0];
    return { document, warning: r.error };
  });

  app.post('/documents/:id/cancel', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const auth = requirePermission(req, 'fiscal.manage');
    const { id } = idParams.parse(req.params);
    const { reason } = z.strictObject({ reason: z.string().trim().min(15, 'Justificativa: ao menos 15 caracteres.').max(255) }).parse(req.body);
    await cancelDocument(provider(), id, reason, auth.userId, req.ip);
    return { document: (await pool.query('SELECT id, status, canceled_at, cancel_reason FROM fiscal_documents WHERE id = $1', [id])).rows[0] };
  });

  app.post('/documents/:id/correction', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const auth = requirePermission(req, 'fiscal.manage');
    const { id } = idParams.parse(req.params);
    const { text } = z.strictObject({ text: z.string().trim().min(15, 'Correção: ao menos 15 caracteres.').max(1000) }).parse(req.body);
    return { sequence: await correctDocument(provider(), id, text, auth.userId, req.ip) };
  });

  app.get('/files/:id', async (req, reply) => {
    requirePermission(req, 'fiscal.view');
    const { id } = idParams.parse(req.params);
    const f = (
      await pool.query(
        `SELECT f.storage_key, f.sha256, f.kind, f.sequence, coalesce(d.number, d.ref, i.series || '-' || i.number_start) AS label
         FROM fiscal_files f LEFT JOIN fiscal_documents d ON d.id = f.document_id LEFT JOIN fiscal_inutilizations i ON i.id = f.inutilization_id WHERE f.id = $1`,
        [id],
      )
    ).rows[0];
    if (!f) throw notFound();
    return sendFiscalFile(reply, f, `nfe-${f.label}-${f.kind}${f.sequence > 1 ? `-${f.sequence}` : ''}`);
  });

  // ---- inutilizacao ----
  app.get('/inutilizations', async (req) => {
    requirePermission(req, 'fiscal.view');
    const { rows } = await pool.query(
      `SELECT i.*, u.name AS created_by_name, (SELECT f.id FROM fiscal_files f WHERE f.inutilization_id = i.id LIMIT 1) AS file_id
       FROM fiscal_inutilizations i JOIN users u ON u.id = i.created_by ORDER BY i.created_at DESC LIMIT 100`,
    );
    return { inutilizations: rows };
  });

  app.post('/inutilizations', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = requirePermission(req, 'fiscal.manage');
    const b = z
      .strictObject({
        series: z.string().trim().regex(/^\d{1,3}$/),
        start: z.number().int().min(1).max(999_999_999),
        end: z.number().int().min(1).max(999_999_999),
        justification: z.string().trim().min(15, 'Justificativa: ao menos 15 caracteres.').max(255),
      })
      .refine((v) => v.end >= v.start && v.end - v.start < 10_000, { message: 'Faixa inválida.', path: ['end'] })
      .parse(req.body);
    const p = provider();
    const settings = (await pool.query('SELECT environment FROM fiscal_settings')).rows[0];
    const company = await currentCompany(pool);
    if (!company?.cnpj) throw new AppError(422, 'COMPANY_INCOMPLETE', 'Cadastre o CNPJ da empresa.');
    if (!p.configured(settings.environment)) throw new AppError(422, 'PROVIDER_ENV', 'Sem credencial do provedor para o ambiente atual.');
    // Faixa que contem nota da loja nao pode ser inutilizada.
    const used = (
      await pool.query(`SELECT 1 FROM fiscal_documents WHERE environment = $1 AND series = $2 AND number::bigint BETWEEN $3 AND $4 LIMIT 1`, [settings.environment, String(Number(b.series)), b.start, b.end])
    ).rowCount;
    if (used) throw new AppError(409, 'RANGE_USED', 'A faixa contém número de nota já emitida pela loja.');
    let r: EventResult;
    try {
      r = await p.inutilize(settings.environment, { cnpj: normalizeCnpj(company.cnpj), series: b.series, start: b.start, end: b.end, justification: b.justification });
    } catch (err) {
      if (err instanceof FiscalTransportError) throw new AppError(502, 'FISCAL_PROVIDER_ERROR', err.message);
      throw err;
    }
    const row = await tx(auth.userId, async (db) => {
      const { rows } = await db.query(
        `INSERT INTO fiscal_inutilizations (provider, environment, series, number_start, number_end, justification, status, protocol, sefaz_status, sefaz_message, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [p.name, settings.environment, b.series, b.start, b.end, b.justification, r.ok ? 'authorized' : 'rejected', r.protocol ?? null, r.sefazStatus, r.sefazMessage, auth.userId],
      );
      await audit(db, { actorId: auth.userId, action: 'fiscal.inutilization', entity: 'fiscal_inutilization', entityId: rows[0].id, after: rows[0], ip: req.ip });
      return rows[0];
    });
    if (r.ok && r.files.inut_xml) await storeOne(p, settings.environment, { inutilizationId: row.id }, 'inut_xml', 1, r.files.inut_xml).catch(() => null);
    return reply.code(r.ok ? 201 : 422).send({ inutilization: row, ...(r.ok ? {} : { error: { code: 'INUTILIZATION_REJECTED', message: r.sefazMessage ?? 'Inutilização não aceita.' } }) });
  });

  // ---- certificado (metadados) ----
  app.get('/certificates', async (req) => {
    requirePermission(req, 'fiscal.view');
    const { rows } = await pool.query('SELECT c.*, u.name AS created_by_name FROM fiscal_certificates c JOIN users u ON u.id = c.created_by ORDER BY c.created_at DESC LIMIT 50');
    return { certificates: rows.map((c) => ({ ...c, alert: certificateAlert(c.valid_until) })) };
  });

  app.post('/certificates', async (req, reply) => {
    const auth = requirePermission(req, 'fiscal.manage');
    const b = z
      .strictObject({
        holderName: z.string().trim().min(2).max(150),
        cnpj: z.string().trim().transform(normalizeCnpj).pipe(z.string().regex(/^[0-9A-Z]{12}\d{2}$/, 'CNPJ inválido.')),
        validFrom: z.iso.date(),
        validUntil: z.iso.date(),
        fingerprint: z.string().trim().regex(/^[A-Fa-f0-9:]{40,95}$/).nullable().optional(),
        notes: z.string().trim().max(500).nullable().optional(),
      })
      .refine((v) => v.validUntil > v.validFrom, { message: 'Validade final antes da inicial.', path: ['validUntil'] })
      .parse(req.body);
    return tx(auth.userId, async (db) => {
      await db.query('UPDATE fiscal_certificates SET active = false WHERE active');
      const { rows } = await db.query(
        `INSERT INTO fiscal_certificates (holder_name, cnpj, valid_from, valid_until, fingerprint, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [b.holderName, b.cnpj, b.validFrom, b.validUntil, b.fingerprint ?? null, b.notes ?? null, auth.userId],
      );
      await audit(db, { actorId: auth.userId, action: 'fiscal.certificate_registered', entity: 'fiscal_certificate', entityId: rows[0].id, after: rows[0], ip: req.ip });
      return reply.code(201).send({ certificate: { ...rows[0], alert: certificateAlert(rows[0].valid_until) } });
    });
  });

  // ---- liberacao de producao ----
  app.post('/production-release', async (req) => {
    const auth = requirePermission(req, 'fiscal.validate');
    const { validatorName } = z.strictObject({ validatorName: z.string().trim().min(2).max(120), confirm: z.literal(true) }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const before = (await db.query('SELECT * FROM fiscal_settings FOR UPDATE')).rows[0];
      if (before.production_released_at) throw new AppError(409, 'ALREADY_RELEASED', 'Produção já liberada.');
      const missing: string[] = [];
      if (before.accreditation_status !== 'accredited') missing.push('credenciamento na SEFAZ concluído');
      if (!(await db.query(`SELECT 1 FROM fiscal_documents WHERE environment = 'homologacao' AND status IN ('authorized', 'canceled') LIMIT 1`)).rowCount) {
        missing.push('ao menos uma nota autorizada em homologação');
      }
      if (!app.fiscal?.configured('producao')) missing.push('credencial de produção do provedor no servidor');
      if (missing.length) throw new AppError(409, 'PRODUCTION_REQUIREMENTS', `Falta: ${missing.join('; ')}.`, { missing });
      const { rows } = await db.query(
        `UPDATE fiscal_settings SET production_released_by = $1, production_released_at = now(), production_validator_name = $2, updated_by = $1, updated_at = now() RETURNING *`,
        [auth.userId, validatorName],
      );
      await audit(db, { actorId: auth.userId, action: 'fiscal.production_released', entity: 'fiscal_settings', before, after: rows[0], ip: req.ip });
      return { settings: rows[0] };
    });
  });
}

// ---------------- aviso do provedor ----------------

export async function fiscalWebhookRoutes(app: FastifyInstance) {
  app.post('/', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = app.fiscal;
    if (!p) return reply.code(503).send({ error: { code: 'FISCAL_UNAVAILABLE', message: 'Provedor fiscal não configurado.' } });
    const valid = p.verifyWebhook(req.headers);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const ref = typeof body.ref === 'string' && /^[A-Za-z0-9_-]{4,50}$/.test(body.ref) ? body.ref : null;
    // So a ref e a situacao ficam registradas; dados do destinatario nao sao copiados do aviso.
    await pool.query('INSERT INTO fiscal_webhook_notifications (provider, ref, auth_valid, payload) VALUES ($1, $2, $3, $4)', [
      p.name,
      ref,
      valid,
      JSON.stringify({ status: typeof body.status === 'string' ? body.status.slice(0, 40) : null }),
    ]);
    if (!valid) return reply.code(401).send({ error: { code: 'INVALID_SIGNATURE', message: 'Aviso não autenticado.' } });
    const doc = ref ? (await pool.query<{ id: string }>('SELECT id FROM fiscal_documents WHERE ref = $1', [ref])).rows[0] : null;
    // A situacao vem sempre da consulta ao provedor, nunca do corpo do aviso.
    if (doc) await syncDocument(p, doc.id, 'webhook').catch((err) => req.log.error(err, 'falha ao consultar nota avisada'));
    return { ok: true };
  });
}
