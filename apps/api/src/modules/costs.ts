// SGLog Fase 10a: configuracoes de custo, lancamentos de custos externos, importacao por planilha e conferencia
// C22-C24 (docs/41-sglog-fase10.md).
//
// - Configuracao (cost_settings): informar exige costs.settings (MFA); validar tributo estimado exige fiscal.validate
//   (o contador); as demais, costs.settings. Imutavel: corrigir e registrar outra versao; encerrar informa o fim.
// - Lancamento (order_cost_entries): costs.record (MFA). Imutavel; correcao por estorno com motivo. A mesma referencia
//   externa nao entra duas vezes e os tipos unicos tem um ativo por pedido (gatilho no banco, com trava por pedido).
// - Importacao: planilha CSV conferida antes (previa) e gravada inteira ou nada; o mesmo arquivo nao entra duas vezes.
// - Nada aqui movimenta dinheiro, chama provedor ou altera pedido, pagamento, NF-e ou estoque.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation, pageQuery } from '../lib/http.js';
import { CHANNELS, LINES_SQL, ordCte, orderMargin } from '../lib/costs.js';
import { requireAnyPermission, requirePermission } from './auth.js';

const key = z.string().min(8).max(100);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD.');
export const ENTRY_KINDS = ['payment_fee', 'marketplace_commission', 'marketplace_fee', 'marketplace_shipping', 'tax', 'other'] as const;
export const SETTING_KINDS = ['tax_rate', 'payment_fee', 'marketplace_fee', 'packaging'] as const;
const MARKETPLACES = ['mercadolivre', 'shopee'];

function checkError(err: unknown): never {
  const c = (err as { constraint?: string; code?: string }).constraint;
  if (c === 'order_cost_entries_single') throw new AppError(409, 'COST_ENTRY_EXISTS', 'Este pedido já tem um lançamento ativo deste tipo. Estorne o anterior antes de lançar outro.');
  if (c === 'order_cost_entries_ref') throw new AppError(409, 'COST_ENTRY_DUPLICATE', 'Esta referência externa já foi lançada (manual ou importada).');
  if (c === 'order_cost_entries_channel') throw new AppError(422, 'COST_ENTRY_CHANNEL', 'Tipo de custo incompatível com o canal do pedido.');
  if (c === 'order_cost_entries_reversal') throw new AppError(409, 'COST_ENTRY_REVERSAL', 'Estorno diferente do lançamento original.');
  if (c === 'cost_settings_overlap') throw new AppError(409, 'SETTING_OVERLAP', 'Já existe versão validada desta configuração no período. Encerre a anterior antes.');
  if (c === 'cost_settings_packaging_dims') throw new AppError(409, 'SETTING_DIMS', 'Outro tipo de embalagem validado tem as mesmas medidas no período.');
  if (c === 'cost_settings_transition' || c === 'cost_settings_immutable') throw new AppError(409, 'SETTING_TRANSITION', 'Esta configuração não pode mais ser alterada.');
  if ((err as { code?: string }).code === '23514') throw new AppError(422, 'INVALID_COST_SETTING', 'Combinação de campos inválida para este tipo de configuração.');
  throw err;
}

const SETTING_COLS = `s.*, ui.name AS informed_by_name, uv.name AS validated_by_name`;
const SETTING_FROM = `cost_settings s LEFT JOIN users ui ON ui.id = s.informed_by LEFT JOIN users uv ON uv.id = s.validated_by`;

async function settingView(db: Db | typeof pool, id: string) {
  const setting = (await db.query(`SELECT ${SETTING_COLS} FROM ${SETTING_FROM} WHERE s.id = $1`, [id])).rows[0];
  if (!setting) throw notFound();
  const events = (
    await db.query(`SELECT e.id, e.action, e.note, e.created_at, u.name AS actor_name FROM cost_setting_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.setting_id = $1 ORDER BY e.id`, [id])
  ).rows;
  return { setting, events };
}

const settingBody = z
  .strictObject({
    kind: z.enum(SETTING_KINDS),
    channel: z.enum(CHANNELS).nullable().optional(),
    paymentMethod: z.enum(['pix', 'card']).nullable().optional(),
    installments: z.number().int().min(1).max(24).nullable().optional(),
    packagingCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,29}$/).nullable().optional(),
    packagingName: z.string().trim().min(2).max(80).nullable().optional(),
    lengthMm: z.number().int().min(1).max(3000).nullable().optional(),
    widthMm: z.number().int().min(1).max(3000).nullable().optional(),
    heightMm: z.number().int().min(1).max(3000).nullable().optional(),
    ratePct: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Percentual com até 4 casas, ponto como separador.').nullable().optional(),
    fixedCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
    base: z.enum(['order_total', 'merchandise']).default('order_total'),
    validFrom: day,
    validTo: day.nullable().optional(),
    source: z.string().trim().min(3).max(200),
    note: z.string().trim().max(500).nullable().optional(),
    requestKey: key,
  })
  .refine((b) => b.ratePct != null || b.fixedCents != null, { message: 'Informe o percentual, o valor fixo ou os dois.', path: ['ratePct'] })
  .refine((b) => b.ratePct == null || Number(b.ratePct) <= 100, { message: 'Percentual acima de 100%.', path: ['ratePct'] })
  .refine((b) => !b.validTo || b.validTo > b.validFrom, { message: 'O fim da vigência é depois do início.', path: ['validTo'] });

const entryBody = z.strictObject({
  orderId: z.uuid().optional(),
  orderNumber: z.number().int().positive().optional(),
  kind: z.enum(ENTRY_KINDS),
  amountCents: z.number().int().min(0).max(1_000_000_000),
  occurredOn: day,
  externalRef: z.string().trim().min(1).max(120).nullable().optional(),
  note: z.string().trim().min(3).max(300).nullable().optional(),
  requestKey: key,
});

// ---------------------------------------------------------------------------------------------------------------
// Planilha (CSV): pedido;tipo;valor;data;referencia;observacao. Separador ';' ou ','; valor em reais (12,34 ou 12.34);
// data AAAA-MM-DD ou DD/MM/AAAA. Ate 5000 linhas.
const KIND_ALIASES: Record<string, (typeof ENTRY_KINDS)[number]> = {
  taxa_pagamento: 'payment_fee',
  payment_fee: 'payment_fee',
  comissao_marketplace: 'marketplace_commission',
  marketplace_commission: 'marketplace_commission',
  tarifa_marketplace: 'marketplace_fee',
  marketplace_fee: 'marketplace_fee',
  frete_marketplace: 'marketplace_shipping',
  marketplace_shipping: 'marketplace_shipping',
  tributo: 'tax',
  tax: 'tax',
  outro: 'other',
  other: 'other',
};
const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

function splitCsvLine(line: string, sep: string) {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export type ImportRow = {
  line: number;
  orderNumber: number | null;
  orderId: string | null;
  kind: string | null;
  amountCents: number | null;
  occurredOn: string | null;
  externalRef: string | null;
  note: string | null;
  errors: string[];
};

const parseMoney = (v: string) => {
  const t = v.replace(/\s|R\$/g, '');
  if (!/^\d{1,9}([.,]\d{1,2})?$/.test(t) && !/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) return null;
  const norm = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  return Math.round(Number(norm) * 100);
};
const parseDay = (v: string) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  const d = m ? `${m[3]}-${m[2]}-${m[1]}` : v;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T12:00:00Z`)) || new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) !== d) return null;
  return d;
};

export function parseCostCsv(content: string): { rows: ImportRow[]; error: string | null } {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return { rows: [], error: 'A planilha precisa do cabeçalho e de ao menos uma linha.' };
  if (lines.length > 5001) return { rows: [], error: 'Até 5000 linhas por planilha.' };
  const sep = lines[0]!.includes(';') ? ';' : ',';
  const header = splitCsvLine(lines[0]!, sep).map(strip);
  const col = (names: string[]) => header.findIndex((h) => names.includes(h));
  const idx = {
    order: col(['pedido', 'order', 'numero_pedido']),
    kind: col(['tipo', 'kind']),
    amount: col(['valor', 'amount']),
    date: col(['data', 'date']),
    ref: col(['referencia', 'reference', 'external_ref']),
    note: col(['observacao', 'note', 'obs']),
  };
  const missing = (['order', 'kind', 'amount', 'date'] as const).filter((k) => idx[k] < 0);
  if (missing.length) return { rows: [], error: 'Cabeçalho precisa das colunas pedido, tipo, valor e data (referencia e observacao são opcionais).' };
  const rows = lines.slice(1).map((l, i): ImportRow => {
    const c = splitCsvLine(l, sep);
    const errors: string[] = [];
    const num = Number(c[idx.order]);
    const orderNumber = Number.isInteger(num) && num > 0 ? num : null;
    if (!orderNumber) errors.push('número do pedido inválido');
    const kind = KIND_ALIASES[strip(c[idx.kind] ?? '')] ?? null;
    if (!kind) errors.push('tipo inválido');
    const amountCents = parseMoney(c[idx.amount] ?? '');
    if (amountCents === null) errors.push('valor inválido');
    const occurredOn = parseDay(c[idx.date] ?? '');
    if (!occurredOn) errors.push('data inválida');
    const externalRef = idx.ref >= 0 && c[idx.ref] ? c[idx.ref]!.slice(0, 120) : null;
    const note = idx.note >= 0 && c[idx.note] ? c[idx.note]!.slice(0, 300) : null;
    if (kind === 'other' && !externalRef) errors.push('tipo "outro" na planilha exige referência');
    if (note !== null && note.length < 3) errors.push('observação muito curta');
    return { line: i + 2, orderNumber, orderId: null, kind, amountCents, occurredOn, externalRef, note, errors };
  });
  return { rows, error: null };
}

/** Confere a planilha contra o banco e contra ela mesma. Nada e gravado. */
async function checkImport(db: Db | typeof pool, rows: ImportRow[]) {
  const numbers = [...new Set(rows.map((r) => r.orderNumber).filter((x): x is number => x !== null))];
  const orders = new Map(
    (await db.query<{ id: string; number: number; channel: string; status: string }>('SELECT id, number, channel, status FROM orders WHERE number = ANY($1::int[])', [numbers])).rows.map((o) => [o.number, o]),
  );
  const ids = [...orders.values()].map((o) => o.id);
  const active = (
    await db.query<{ order_id: string; kind: string; external_ref: string | null }>(
      `SELECT e.order_id, e.kind, e.external_ref FROM order_cost_entries e
       WHERE e.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM order_cost_entries r WHERE r.reverses_id = e.id)
         AND (e.order_id = ANY($1::uuid[]) OR (e.kind, e.external_ref) IN (SELECT k, ref FROM unnest($2::text[], $3::text[]) AS t(k, ref)))`,
      [ids, rows.map((r) => r.kind ?? ''), rows.map((r) => r.externalRef ?? '')],
    )
  ).rows;
  const singleTaken = new Set(active.filter((a) => a.kind !== 'other').map((a) => `${a.order_id}:${a.kind}`));
  const refTaken = new Set(active.filter((a) => a.external_ref).map((a) => `${a.kind}:${a.external_ref}`));
  const seenSingle = new Set<string>();
  const seenRef = new Set<string>();
  for (const r of rows) {
    const o = r.orderNumber ? orders.get(r.orderNumber) : undefined;
    if (r.orderNumber && !o) r.errors.push('pedido não encontrado');
    if (o) {
      r.orderId = o.id;
      const mkt = MARKETPLACES.includes(o.channel);
      if (r.kind?.startsWith('marketplace_') && !mkt) r.errors.push('custo de marketplace em pedido que não é de marketplace');
      if (r.kind === 'payment_fee' && mkt) r.errors.push('pedido de marketplace: use comissão ou tarifa do marketplace');
      if (r.kind && r.kind !== 'other') {
        const k = `${o.id}:${r.kind}`;
        if (singleTaken.has(k)) r.errors.push('o pedido já tem lançamento ativo deste tipo (manual ou importado)');
        else if (seenSingle.has(k)) r.errors.push('repetido na planilha (mesmo pedido e tipo)');
        seenSingle.add(k);
      }
    }
    if (r.kind && r.externalRef) {
      const k = `${r.kind}:${r.externalRef}`;
      if (refTaken.has(k)) r.errors.push('referência externa já lançada');
      else if (seenRef.has(k)) r.errors.push('referência repetida na planilha');
      seenRef.add(k);
    }
  }
  return rows;
}

const importBody = z.strictObject({ fileName: z.string().trim().min(1).max(200), content: z.string().min(1).max(2_000_000), requestKey: key.optional() });

// ---------------------------------------------------------------------------------------------------------------
// C24: margem do pedido pelo detalhe (soma das linhas) x pela agregacao dos relatorios, nos ultimos pedidos pagos.
// Ainda confere que nenhum componente desconhecido entrou com valor.
export async function marginReconcile(db: Db | typeof pool, sample = 300) {
  const params: unknown[] = [];
  const ord = ordCte({ from: '2000-01-01', to: '2999-12-31', basis: 'paid', demo: 'include', latest: sample }, params);
  const { rows } = await db.query(
    `WITH ${ord},${LINES_SQL},
     chk AS (
       SELECT l.order_id, coalesce(sum(l.amount) FILTER (WHERE l.nature IN ('effective', 'estimated')), 0) AS lines_sum,
              count(*) FILTER (WHERE l.nature = 'unknown' AND l.amount IS NOT NULL) AS unknown_valued
       FROM lines l GROUP BY l.order_id
     )
     SELECT 'C24' AS check_code, CASE WHEN c.unknown_valued > 0 THEN 'unknown_valued' ELSE 'sum' END AS field, p.order_id::text AS ref_id,
            p.margin::numeric AS expected, c.lines_sum::numeric AS found
     FROM per p JOIN chk c ON c.order_id = p.order_id
     WHERE p.margin <> c.lines_sum OR c.unknown_valued > 0
        OR p.margin <> p.revenue + p.cogs + p.logistics + p.fees + p.taxes + p.returns + p.other`,
    params,
  );
  const checked = (await db.query(`WITH ${ord} SELECT count(*)::int AS n FROM ord`, params)).rows[0].n as number;
  return { rows, checked };
}

export async function costReconcile(db: Db | typeof pool) {
  const sql = (await db.query('SELECT check_code, field, ref_id, expected, found FROM cost_reconcile()')).rows;
  const c24 = await marginReconcile(db);
  const divergences = [...sql, ...c24.rows];
  return { divergences, checkedOrders: c24.checked, codes: ['C22', 'C23', 'C24'] };
}

export async function costRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------------ configuracoes
  app.get('/settings', async (req) => {
    requireAnyPermission(req, 'costs.view', 'costs.settings', 'margins.view', 'fiscal.validate');
    const q = z
      .object({ kind: z.enum(SETTING_KINDS).optional(), status: z.enum(['informed', 'validated', 'canceled', 'current', 'all']).default('all') })
      .parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.kind) where.push(`s.kind = $${params.push(q.kind)}`);
    if (q.status === 'current') where.push(`s.status = 'validated' AND s.valid_from <= current_date AND (s.valid_to IS NULL OR current_date < s.valid_to)`);
    else if (q.status !== 'all') where.push(`s.status = $${params.push(q.status)}`);
    const items = (
      await pool.query(
        `SELECT ${SETTING_COLS} FROM ${SETTING_FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY s.kind, s.channel NULLS FIRST, s.payment_method NULLS FIRST, s.installments NULLS FIRST, s.packaging_code NULLS FIRST, s.valid_from DESC, s.number DESC`,
        params,
      )
    ).rows;
    const companyRegime = (await pool.query(`SELECT tax_regime FROM company_profiles ORDER BY created_at DESC LIMIT 1`).catch(() => ({ rows: [] }))).rows[0]?.tax_regime ?? null;
    return { items, taxRegime: companyRegime };
  });

  app.get('/settings/:id', async (req) => {
    requireAnyPermission(req, 'costs.view', 'costs.settings', 'margins.view', 'fiscal.validate');
    const { id } = idParams.parse(req.params);
    return settingView(pool, id);
  });

  app.post('/settings', async (req, reply) => {
    const auth = requirePermission(req, 'costs.settings');
    const b = settingBody.parse(req.body);
    const prior = (await pool.query<{ id: string }>('SELECT id FROM cost_settings WHERE request_key = $1', [b.requestKey])).rows[0];
    if (prior) return reply.code(200).send({ ...(await settingView(pool, prior.id)), replayed: true });
    try {
      const id = await tx(auth.userId, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO cost_settings (kind, channel, payment_method, installments, packaging_code, packaging_name, length_mm, width_mm, height_mm, rate_pct, fixed_cents, base,
                                      valid_from, valid_to, source, note, informed_by, request_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`,
          [
            b.kind, b.channel ?? null, b.paymentMethod ?? null, b.installments ?? null, b.packagingCode ?? null, b.packagingName ?? null,
            b.lengthMm ?? null, b.widthMm ?? null, b.heightMm ?? null, b.ratePct ?? null, b.fixedCents ?? null, b.base,
            b.validFrom, b.validTo ?? null, b.source, b.note ?? null, auth.userId, b.requestKey,
          ],
        );
        const id = rows[0]!.id;
        await db.query(`INSERT INTO cost_setting_events (setting_id, action, note, actor_id) VALUES ($1, 'inform', $2, $3)`, [id, b.source, auth.userId]);
        await audit(db, { actorId: auth.userId, action: 'costs.setting_informed', entity: 'cost_setting', entityId: id, after: b, ip: req.ip });
        return id;
      });
      return reply.code(201).send(await settingView(pool, id));
    } catch (err) {
      if (isUniqueViolation(err, 'cost_settings_request_key_key')) {
        const again = (await pool.query<{ id: string }>('SELECT id FROM cost_settings WHERE request_key = $1', [b.requestKey])).rows[0]!;
        return reply.code(200).send({ ...(await settingView(pool, again.id)), replayed: true });
      }
      checkError(err);
    }
  });

  const transition = (action: 'validate' | 'cancel' | 'end') =>
    app.post(`/settings/:id/${action}`, async (req) => {
      // Sessao e alguma permissao de configuracao antes de ler o corpo (401/403 antes de 400); a exata depende do tipo.
      requireAnyPermission(req, 'costs.settings', 'fiscal.validate');
      const { id } = idParams.parse(req.params);
      const b = z
        .strictObject({
          version: z.number().int().positive(),
          validatorName: z.string().trim().min(2).max(120).optional(),
          reason: z.string().trim().min(3).max(300).optional(),
          validTo: day.optional(),
        })
        .parse(req.body);
      const current = (await pool.query<{ kind: string }>('SELECT kind FROM cost_settings WHERE id = $1', [id])).rows[0];
      if (!current) throw notFound();
      // Tributo estimado: so o contador (fiscal.validate) valida. Demais: quem altera configuracao financeira.
      const auth =
        action === 'validate' && current.kind === 'tax_rate'
          ? requirePermission(req, 'fiscal.validate')
          : action === 'end' && current.kind === 'tax_rate'
            ? requireAnyPermission(req, 'fiscal.validate', 'costs.settings')
            : requirePermission(req, 'costs.settings');
      if (action === 'validate' && !b.validatorName) throw new AppError(422, 'VALIDATOR_REQUIRED', 'Informe o nome de quem validou.');
      if (action !== 'validate' && !b.reason) throw new AppError(422, 'REASON_REQUIRED', 'Informe o motivo.');
      if (action === 'end' && !b.validTo) throw new AppError(422, 'VALID_TO_REQUIRED', 'Informe o fim da vigência.');
      try {
        await tx(auth.userId, async (db) => {
          const before = (await db.query('SELECT *, valid_from::text AS vf FROM cost_settings WHERE id = $1 FOR UPDATE', [id])).rows[0];
          if (before.version !== b.version) throw new AppError(409, 'STALE_VERSION', 'A configuração mudou desde que você abriu. Atualize a tela.');
          if (action === 'validate' && before.status !== 'informed') throw new AppError(409, 'SETTING_TRANSITION', 'Só a configuração informada pode ser validada.');
          if (action === 'cancel' && before.status !== 'informed') throw new AppError(409, 'SETTING_TRANSITION', 'Só a configuração informada pode ser cancelada; a validada é encerrada.');
          if (action === 'end') {
            if (before.status !== 'validated' || before.valid_to) throw new AppError(409, 'SETTING_TRANSITION', 'Só a configuração validada e sem fim de vigência pode ser encerrada.');
            if (b.validTo! <= before.vf) throw new AppError(422, 'INVALID_VALID_TO', 'O fim da vigência é depois do início.');
          }
          const set =
            action === 'validate'
              ? `status = 'validated', validated_by = $3, validator_name = $4, validated_at = now()`
              : action === 'cancel'
                ? `status = 'canceled', canceled_by = $3, canceled_at = now(), cancel_reason = $4`
                : `valid_to = $5::date, ended_by = $3, ended_at = now(), end_reason = $4`;
          const after = (
            await db.query(`UPDATE cost_settings SET ${set}, version = version + 1, updated_at = now() WHERE id = $1 AND version = $2 RETURNING *`, [
              id,
              b.version,
              auth.userId,
              action === 'validate' ? b.validatorName : b.reason,
              ...(action === 'end' ? [b.validTo] : []),
            ])
          ).rows[0];
          await db.query(`INSERT INTO cost_setting_events (setting_id, action, note, actor_id) VALUES ($1, $2, $3, $4)`, [
            id,
            action,
            action === 'validate' ? `validado por ${b.validatorName}` : action === 'end' ? `fim em ${b.validTo}: ${b.reason}` : b.reason,
            auth.userId,
          ]);
          await audit(db, { actorId: auth.userId, action: `costs.setting_${action}`, entity: 'cost_setting', entityId: id, before, after, ip: req.ip });
        });
      } catch (err) {
        checkError(err);
      }
      return settingView(pool, id);
    });
  transition('validate');
  transition('cancel');
  transition('end');

  // ------------------------------------------------------------------ lancamentos
  const ENTRY_COLS = `e.id::text, e.order_id, o.number AS order_number, o.channel, e.kind, e.amount_cents, e.occurred_on, e.source, e.import_id, ci.number AS import_number,
    e.external_ref, e.note, e.reverses_id::text, e.reason, e.created_at, u.name AS actor_name,
    EXISTS (SELECT 1 FROM order_cost_entries r WHERE r.reverses_id = e.id) AS reversed`;
  const ENTRY_FROM = `order_cost_entries e JOIN orders o ON o.id = e.order_id LEFT JOIN users u ON u.id = e.actor_id LEFT JOIN cost_imports ci ON ci.id = e.import_id`;

  app.get('/entries', async (req) => {
    requireAnyPermission(req, 'costs.view', 'costs.record', 'margins.view');
    const q = pageQuery
      .extend({ order: z.coerce.number().int().positive().optional(), orderId: z.uuid().optional(), kind: z.enum(ENTRY_KINDS).optional(), importId: z.uuid().optional() })
      .parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.order) where.push(`o.number = $${params.push(q.order)}`);
    if (q.orderId) where.push(`e.order_id = $${params.push(q.orderId)}`);
    if (q.kind) where.push(`e.kind = $${params.push(q.kind)}`);
    if (q.importId) where.push(`e.import_id = $${params.push(q.importId)}`);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((await pool.query(`SELECT count(*) AS n FROM ${ENTRY_FROM} ${w}`, params)).rows[0].n);
    const items = (await pool.query(`SELECT ${ENTRY_COLS} FROM ${ENTRY_FROM} ${w} ORDER BY e.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, q.pageSize, (q.page - 1) * q.pageSize])).rows;
    return { items, total, page: q.page, pageSize: q.pageSize };
  });

  app.post('/entries', async (req, reply) => {
    const auth = requirePermission(req, 'costs.record');
    const b = entryBody.parse(req.body);
    if (!b.orderId && !b.orderNumber) throw new AppError(422, 'ORDER_REQUIRED', 'Informe o pedido.');
    if (b.kind === 'other' && !b.note) throw new AppError(422, 'NOTE_REQUIRED', 'Descreva o custo (observação).');
    const replay = async () => {
      const e = (await pool.query(`SELECT ${ENTRY_COLS} FROM ${ENTRY_FROM} WHERE e.request_key = $1`, [b.requestKey])).rows[0];
      return e ? reply.code(200).send({ entry: e, replayed: true }) : null;
    };
    const prior = await replay();
    if (prior) return prior;
    const order = (
      await pool.query<{ id: string; status: string }>(b.orderId ? 'SELECT id, status FROM orders WHERE id = $1' : 'SELECT id, status FROM orders WHERE number = $1', [b.orderId ?? b.orderNumber])
    ).rows[0];
    if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Pedido não encontrado.');
    try {
      const id = await tx(auth.userId, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO order_cost_entries (order_id, kind, amount_cents, occurred_on, source, external_ref, note, actor_id, request_key)
           VALUES ($1, $2, $3, $4, 'manual', $5, $6, $7, $8) RETURNING id::text`,
          [order.id, b.kind, b.amountCents, b.occurredOn, b.externalRef ?? null, b.note ?? null, auth.userId, b.requestKey],
        );
        await audit(db, { actorId: auth.userId, action: 'costs.entry_recorded', entity: 'order', entityId: order.id, after: { entryId: rows[0]!.id, ...b }, ip: req.ip });
        return rows[0]!.id;
      });
      return reply.code(201).send({ entry: (await pool.query(`SELECT ${ENTRY_COLS} FROM ${ENTRY_FROM} WHERE e.id = $1`, [id])).rows[0] });
    } catch (err) {
      if (isUniqueViolation(err, 'order_cost_entries_request_key_key')) return (await replay())!;
      checkError(err);
    }
  });

  app.post('/entries/:id/reverse', async (req, reply) => {
    const auth = requirePermission(req, 'costs.record');
    const id = z.object({ id: z.string().regex(/^\d{1,18}$/) }).parse(req.params).id;
    const b = z.strictObject({ reason: z.string().trim().min(3).max(300), requestKey: key }).parse(req.body);
    const prior = (await pool.query(`SELECT ${ENTRY_COLS} FROM ${ENTRY_FROM} WHERE e.request_key = $1`, [b.requestKey])).rows[0];
    if (prior) return reply.code(200).send({ entry: prior, replayed: true });
    try {
      const rid = await tx(auth.userId, async (db) => {
        const o = (await db.query('SELECT * FROM order_cost_entries WHERE id = $1', [id])).rows[0];
        if (!o) throw notFound();
        if (o.reverses_id) throw new AppError(409, 'COST_ENTRY_REVERSAL', 'Estorno não pode ser estornado.');
        if ((await db.query('SELECT 1 FROM order_cost_entries WHERE reverses_id = $1', [id])).rows[0]) throw new AppError(409, 'COST_ENTRY_REVERSED', 'Este lançamento já foi estornado.');
        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO order_cost_entries (order_id, kind, amount_cents, occurred_on, source, import_id, external_ref, reverses_id, reason, actor_id, request_key)
           VALUES ($1, $2, $3, current_date, $4, $5, NULL, $6, $7, $8, $9) RETURNING id::text`,
          [o.order_id, o.kind, -Number(o.amount_cents), o.source, o.import_id, id, b.reason, auth.userId, b.requestKey],
        );
        await audit(db, { actorId: auth.userId, action: 'costs.entry_reversed', entity: 'order', entityId: o.order_id, before: o, after: { entryId: rows[0]!.id, reason: b.reason }, ip: req.ip });
        return rows[0]!.id;
      });
      return reply.code(201).send({ entry: (await pool.query(`SELECT ${ENTRY_COLS} FROM ${ENTRY_FROM} WHERE e.id = $1`, [rid])).rows[0] });
    } catch (err) {
      if (isUniqueViolation(err, 'order_cost_entries_reverses_id_key')) throw new AppError(409, 'COST_ENTRY_REVERSED', 'Este lançamento já foi estornado.');
      if (isUniqueViolation(err, 'order_cost_entries_request_key_key')) {
        return reply.code(200).send({ entry: (await pool.query(`SELECT ${ENTRY_COLS} FROM ${ENTRY_FROM} WHERE e.request_key = $1`, [b.requestKey])).rows[0], replayed: true });
      }
      checkError(err);
    }
  });

  // ------------------------------------------------------------------ importacao
  app.post('/imports/preview', async (req) => {
    requirePermission(req, 'costs.record');
    const b = importBody.parse(req.body);
    const parsed = parseCostCsv(b.content);
    if (parsed.error) throw new AppError(422, 'INVALID_SHEET', parsed.error);
    const hash = createHash('sha256').update(b.content).digest('hex');
    const dup = (await pool.query<{ number: number }>('SELECT number FROM cost_imports WHERE content_hash = $1', [hash])).rows[0];
    const rows = await checkImport(pool, parsed.rows);
    return {
      fileName: b.fileName,
      alreadyImported: dup ? dup.number : null,
      rows,
      valid: rows.filter((r) => !r.errors.length).length,
      invalid: rows.filter((r) => r.errors.length).length,
      totalCents: rows.reduce((s, r) => s + (r.amountCents ?? 0), 0),
    };
  });

  app.post('/imports', async (req, reply) => {
    const auth = requirePermission(req, 'costs.record');
    const b = importBody.extend({ requestKey: key }).parse(req.body);
    const parsed = parseCostCsv(b.content);
    if (parsed.error) throw new AppError(422, 'INVALID_SHEET', parsed.error);
    const hash = createHash('sha256').update(b.content).digest('hex');
    const prior = (await pool.query<{ id: string; number: number; request_key: string }>('SELECT id, number, request_key FROM cost_imports WHERE content_hash = $1 OR request_key = $2', [hash, b.requestKey])).rows[0];
    if (prior?.request_key === b.requestKey) return reply.code(200).send({ import: prior, replayed: true });
    if (prior) throw new AppError(409, 'IMPORT_DUPLICATE', `Esta planilha já foi importada (importação nº ${prior.number}).`);
    try {
      const result = await tx(auth.userId, async (db) => {
        // Trava as linhas da conferencia: a planilha entra inteira ou nada.
        const rows = await checkImport(db, parsed.rows);
        const bad = rows.filter((r) => r.errors.length);
        if (bad.length) throw new AppError(422, 'INVALID_SHEET_ROWS', `${bad.length} linha(s) com erro. Corrija a planilha e confira de novo.`, { rows: bad });
        const total = rows.reduce((s, r) => s + r.amountCents!, 0);
        const imp = (
          await db.query<{ id: string; number: number }>(
            `INSERT INTO cost_imports (filename, content_hash, rows, total_cents, actor_id, request_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, number`,
            [b.fileName, hash, rows.length, total, auth.userId, b.requestKey],
          )
        ).rows[0]!;
        for (const r of rows) {
          await db.query(
            `INSERT INTO order_cost_entries (order_id, kind, amount_cents, occurred_on, source, import_id, external_ref, note, actor_id, request_key)
             VALUES ($1, $2, $3, $4, 'import', $5, $6, $7, $8, $9)`,
            [r.orderId, r.kind, r.amountCents, r.occurredOn, imp.id, r.externalRef, r.note, auth.userId, `imp-${imp.id}-${r.line}`],
          );
        }
        await audit(db, { actorId: auth.userId, action: 'costs.import', entity: 'cost_import', entityId: imp.id, after: { fileName: b.fileName, rows: rows.length, totalCents: total, hash }, ip: req.ip });
        return { ...imp, rows: rows.length, totalCents: total };
      });
      return reply.code(201).send({ import: result });
    } catch (err) {
      if (isUniqueViolation(err, 'cost_imports_content_hash_key')) throw new AppError(409, 'IMPORT_DUPLICATE', 'Esta planilha já foi importada.');
      if (isUniqueViolation(err, 'cost_imports_request_key_key')) return reply.code(200).send({ replayed: true });
      checkError(err);
    }
  });

  app.get('/imports', async (req) => {
    requireAnyPermission(req, 'costs.view', 'costs.record');
    const q = pageQuery.parse(req.query);
    const total = Number((await pool.query('SELECT count(*) AS n FROM cost_imports')).rows[0].n);
    const items = (
      await pool.query(
        `SELECT i.id, i.number, i.filename, i.rows, i.total_cents, i.created_at, u.name AS actor_name FROM cost_imports i LEFT JOIN users u ON u.id = i.actor_id ORDER BY i.number DESC LIMIT $1 OFFSET $2`,
        [q.pageSize, (q.page - 1) * q.pageSize],
      )
    ).rows;
    return { items, total, page: q.page, pageSize: q.pageSize };
  });

  // ------------------------------------------------------------------ margem do pedido (rastreabilidade)
  app.get('/orders/:id/margin', async (req) => {
    const auth = requirePermission(req, 'margins.view');
    const { id } = idParams.parse(req.params);
    const order = (await pool.query('SELECT id, number, channel, status, replacement_for_return_id FROM orders WHERE id = $1', [id])).rows[0];
    if (!order) throw notFound();
    const margin = await orderMargin(pool, id);
    const entries = (await pool.query(`SELECT ${ENTRY_COLS} FROM ${ENTRY_FROM} WHERE e.order_id = $1 ORDER BY e.id`, [id])).rows;
    return {
      order,
      // Fora da margem: pedido nao pago, cancelado ou de reposicao (o custo dele entra no pedido de origem).
      excluded: margin ? null : order.replacement_for_return_id ? 'replacement' : order.status === 'canceled' ? 'canceled' : 'not_paid',
      margin,
      entries,
      canRecord: auth.permissions.has('costs.record'),
    };
  });

  // ------------------------------------------------------------------ conferencia C22-C24
  app.get('/reconcile', async (req) => {
    const auth = requireAnyPermission(req, 'costs.view', 'margins.view');
    const r = await costReconcile(pool);
    await tx(auth.userId, (db) => audit(db, { actorId: auth.userId, action: 'costs.reconcile', metadata: { divergences: r.divergences.length, checkedOrders: r.checkedOrders }, ip: req.ip }));
    return r;
  });
}
