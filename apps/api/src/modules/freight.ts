// SGLog Fase 8: fretes, etiquetas, rastreamento e custos logisticos (docs/34-sglog-fase8-planejamento.md e
// docs/35-sglog-fase8.md).
//
// - Cotacao da remessa embalada: origem no CEP do deposito da remessa, volumes medidos na embalagem (D8-4). A
//   cotacao guarda os volumes usados; mudou a embalagem, deixa de valer.
// - Etiqueta: preparada e BLOQUEADA (D8-3). labelGate() exige ao mesmo tempo SHIPPING_LABELS_ENABLED, um provedor que
//   compre etiqueta (o Melhor Envio nao compra nesta versao), label_status 'enabled' e um limite DEFINIDO. Uma
//   etiqueta ativa por remessa (indice unico). A compra roda na fila; resposta incerta vira 'uncertain' e so
//   reconciliando (provedor ou decisao registrada com MFA) libera nova compra. A etiqueta nao despacha nem baixa
//   estoque.
// - Rastreio: consulta periodica (tracking_poll_hours) e aviso assinado do transportador. A remessa so avanca
//   (despachada -> em transito -> saiu para entrega -> entregue); evento repetido e ignorado, atrasado so entra no
//   historico; falha na entrega e devolucao so ficam registradas (Fase 9).
// - Custos: frete cobrado (orders.freight_cents, rateado entre as remessas), cotado (cotacao escolhida) e pago
//   (lancamentos imutaveis: etiqueta, informado, ajuste, estorno). Sem lancamento o pago e desconhecido, nunca zero.
// - Marketplace e retirada nao cotam, nao compram etiqueta e nao sao rastreados aqui.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { sha256 } from '../lib/crypto.js';
import { AppError, notFound } from '../lib/errors.js';
import { idParams, isUniqueViolation, pageQuery } from '../lib/http.js';
import {
  CarrierError,
  carrierProvider,
  type CarrierProvider,
  type LabelRequest,
  type LabelResult,
  type TrackEvent,
  type TrackStatus,
  type Volume,
} from '../lib/carriers.js';
import { claimJobs, enqueueJob, finishJob, logCall, retryJob, safeError, type Job, type JobOutcome } from '../lib/integration-jobs.js';
import { requireAnyPermission, requirePermission, type Auth } from './auth.js';
import { lockShipment, projectOrder } from './shipments.js';

export const QUOTE_TTL_MIN = 120;
const ACTIVE_LABEL = ['requested', 'purchasing', 'uncertain', 'purchased', 'printed', 'cancel_requested'];
const TRACKED = ['shipped', 'in_transit', 'out_for_delivery'];
// Remessa com frete da loja: a de entrega, ou a do despacho anterior (legacy) de pedido da loja ou do balcao que nao
// seja retirada. Pedido de marketplace fica com o marketplace (rastreio, custo e entrega sao dele) e nunca entra aqui.
// Usa os apelidos s (shipments) e o (orders).
export const STORE_CARRIER_SQL = `(s.kind = 'delivery' OR (s.kind = 'legacy' AND o.channel IN ('store', 'sales_desk')
  AND NOT EXISTS (SELECT 1 FROM shipping_options so WHERE so.id = o.shipping_option_id AND so.kind = 'pickup')))`;
async function isStoreCarrier(db: Db | typeof pool, id: string) {
  return !!(await db.query(`SELECT 1 FROM shipments s JOIN orders o ON o.id = s.order_id WHERE s.id = $1 AND ${STORE_CARRIER_SQL}`, [id])).rows[0];
}
const RANK: Record<string, number> = { shipped: 1, in_transit: 2, out_for_delivery: 3, delivered: 4 };
const TARGET: Record<TrackStatus, string | null> = {
  posted: 'in_transit',
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  delivery_failed: null,
  returned: null,
  canceled: null,
  info: null,
};
const TRACK_LABEL: Record<TrackStatus, string> = {
  posted: 'postado',
  in_transit: 'em trânsito',
  out_for_delivery: 'saiu para entrega',
  delivered: 'entregue',
  delivery_failed: 'falha na entrega',
  returned: 'devolvido ao remetente',
  canceled: 'cancelado pelo transportador',
  info: 'atualização do transportador',
};
const STATUS_PT: Record<string, string> = {
  pending: 'pendente',
  picking: 'em separação',
  checking: 'em conferência',
  packed: 'embalada',
  shipped: 'despachada',
  in_transit: 'em trânsito',
  out_for_delivery: 'saiu para entrega',
  delivered: 'entregue',
  canceled: 'cancelada',
};

const key = z.string().min(8).max(100);

// ---------------------------------------------------------------------------------------------------------------
// Regras e trava da etiqueta

type FreightSettings = {
  label_status: 'blocked' | 'enabled';
  label_validator_name: string | null;
  label_validated_at: Date | null;
  label_max_cents: number | null;
  tracking_poll_hours: number;
  tracking_stale_days: number;
  version: number;
};

async function freightSettings(db: Db | typeof pool) {
  return (
    await db.query<FreightSettings>(
      'SELECT label_status, label_validator_name, label_validated_at, label_max_cents, tracking_poll_hours, tracking_stale_days, version FROM logistics_settings',
    )
  ).rows[0]!;
}

/**
 * Compra de etiqueta liberada? Todas as condicoes ao mesmo tempo; qualquer uma faltando, bloqueada. Limite nao
 * definido nunca vale como "sem limite".
 */
export async function labelGate(db: Db | typeof pool, provider: CarrierProvider | null = carrierProvider()) {
  const st = await freightSettings(db);
  const reasons: string[] = [];
  if (!config.SHIPPING_LABELS_ENABLED) reasons.push('A compra de etiqueta está desligada no servidor (SHIPPING_LABELS_ENABLED).');
  if (!provider) reasons.push('Nenhum provedor de frete configurado.');
  else if (!provider.capabilities.labels) reasons.push(`O provedor ${provider.name === 'melhorenvio' ? 'Melhor Envio' : provider.name} não compra etiqueta nesta versão do sistema.`);
  if (st.label_status !== 'enabled') reasons.push('A compra de etiqueta está bloqueada nas regras do frete.');
  if (st.label_max_cents === null) reasons.push('O limite por etiqueta não foi definido.');
  return { allowed: reasons.length === 0, reasons, maxCents: st.label_max_cents };
}

// ---------------------------------------------------------------------------------------------------------------
// Leitura da remessa para o frete

type FreightRow = {
  id: string;
  order_id: string;
  seq: number;
  kind: string;
  status: string;
  version: number;
  warehouse_id: string | null;
  packages: { weightG: number; lengthMm?: number; widthMm?: number; heightMm?: number }[] | null;
  quote_id: string | null;
  carrier_provider: string | null;
  carrier_service: string | null;
  tracking_code: string | null;
  order_number: number;
  invoice_status: string;
  freight_cents: number;
  ship_to: Record<string, string | null> | null;
  buyer: Record<string, string | null>;
  w_cep: string | null;
  w_street: string | null;
  w_number: string | null;
  w_complement: string | null;
  w_district: string | null;
  w_city: string | null;
  w_uf: string | null;
  w_name: string | null;
};

async function freightRow(db: Db | typeof pool, id: string) {
  const r = (
    await db.query<FreightRow>(
      `SELECT s.id, s.order_id, s.seq, s.kind, s.status, s.version, s.warehouse_id, s.packages, s.quote_id, s.carrier_provider, s.carrier_service, s.tracking_code,
              o.number AS order_number, o.invoice_status, o.freight_cents::int AS freight_cents, o.ship_to, o.buyer,
              w.cep AS w_cep, w.street AS w_street, w.number AS w_number, w.complement AS w_complement, w.district AS w_district, w.city AS w_city, w.uf AS w_uf, w.name AS w_name
       FROM shipments s JOIN orders o ON o.id = s.order_id LEFT JOIN warehouses w ON w.id = s.warehouse_id WHERE s.id = $1`,
      [id],
    )
  ).rows[0];
  if (!r) throw notFound();
  return r;
}

function measuredVolumes(r: FreightRow): Volume[] {
  const pk = r.packages ?? [];
  if (!pk.length) throw new AppError(409, 'PACKAGES_MISSING', 'A remessa não tem volumes registrados. Embale a remessa antes de cotar.');
  const missing = pk.map((p, i) => (!p.weightG || !p.lengthMm || !p.widthMm || !p.heightMm ? i + 1 : 0)).filter(Boolean);
  if (missing.length) {
    throw new AppError(409, 'PACKAGES_INCOMPLETE', `Volume(s) ${missing.join(', ')} sem peso ou medidas. Volte a remessa para a conferência e embale informando comprimento, largura e altura.`);
  }
  return pk.map((p) => ({ weightG: p.weightG, lengthMm: p.lengthMm!, widthMm: p.widthMm!, heightMm: p.heightMm! }));
}

function assertQuotable(r: FreightRow) {
  if (r.kind === 'pickup') throw new AppError(409, 'NOT_CARRIER_SHIPMENT', 'Retirada na loja não tem frete de transportadora.');
  if (r.kind === 'marketplace') throw new AppError(409, 'NOT_CARRIER_SHIPMENT', 'Frete e etiqueta de pedido de marketplace ficam com o marketplace.');
  if (r.kind !== 'delivery') throw new AppError(409, 'NOT_CARRIER_SHIPMENT', 'Remessa de pedido antigo: sem cotação pelo sistema.');
  if (r.status !== 'packed') throw new AppError(409, 'NOT_PACKED', `A remessa está ${STATUS_PT[r.status] ?? r.status}. Só a remessa embalada pode ser cotada.`, { status: r.status });
}

/** Valor dos itens da remessa (seguro), pela parte de cada item do pedido que esta nela. */
async function shipmentGoodsCents(db: Db | typeof pool, shipmentId: string) {
  const v = (
    await db.query<{ cents: string | null }>(
      `SELECT round(sum(oi.total_cents * i.base_qty / nullif(oi.base_qty_per_pack * oi.packs, 0)))::text AS cents
       FROM shipment_items i JOIN order_items oi ON oi.id = i.order_item_id WHERE i.shipment_id = $1 AND i.status = 'active'`,
      [shipmentId],
    )
  ).rows[0]?.cents;
  return Math.max(0, Number(v ?? 0));
}

/** Frete cobrado do cliente rateado entre as remessas vivas do pedido (resto na primeira). */
async function chargedShare(db: Db | typeof pool, orderId: string, shipmentId: string, freightCents: number) {
  const ids = (
    await db.query<{ id: string }>(`SELECT id FROM shipments WHERE order_id = $1 AND status <> 'canceled' AND kind IN ('delivery', 'legacy') ORDER BY seq`, [orderId])
  ).rows.map((r) => r.id);
  const n = ids.length || 1;
  const idx = ids.indexOf(shipmentId);
  const base = Math.floor(freightCents / n);
  return { cents: idx <= 0 ? freightCents - base * (n - 1) : base, split: n > 1, shipments: n };
}

const samePackages = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function costsOf(db: Db | typeof pool, shipmentId: string) {
  const entries = (
    await db.query<{ id: string; kind: string; amount_cents: number; label_id: string | null; note: string | null; created_at: Date; actor_name: string | null }>(
      `SELECT c.id::text, c.kind, c.amount_cents, c.label_id, c.note, c.created_at, u.name AS actor_name
       FROM shipment_freight_costs c LEFT JOIN users u ON u.id = c.actor_id WHERE c.shipment_id = $1 ORDER BY c.id`,
      [shipmentId],
    )
  ).rows;
  const paid = entries.filter((e) => e.kind !== 'refund');
  const refunds = entries.filter((e) => e.kind === 'refund');
  const pendingRefunds = (
    await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM shipping_labels WHERE shipment_id = $1 AND status = 'canceled' AND refund_status IN ('pending', 'unknown')`, [shipmentId])
  ).rows[0]!.n;
  const paidCents = paid.length ? paid.reduce((s, e) => s + e.amount_cents, 0) : null;
  const refundedCents = refunds.length ? refunds.reduce((s, e) => s + e.amount_cents, 0) : null;
  return {
    entries,
    // Desconhecido (null) quando nada foi lancado: nunca vira zero.
    paidCents,
    refundedCents,
    netCents: paidCents === null ? null : paidCents + (refundedCents ?? 0),
    pendingRefunds,
  };
}

export async function freightView(db: Db | typeof pool, id: string) {
  const r = await freightRow(db, id);
  const provider = carrierProvider();
  const gate = await labelGate(db, provider);
  const quotes = (
    await db.query(
      `SELECT q.id, q.batch_id, q.provider, q.service, q.service_name, q.company, q.price_cents, q.days, q.from_cep, q.to_cep, q.packages, q.insurance_cents,
              q.quoted_at, q.expires_at, q.expires_at <= now() AS expired, u.name AS quoted_by_name
       FROM shipping_quotes q LEFT JOIN users u ON u.id = q.quoted_by
       WHERE q.shipment_id = $1 AND (q.batch_id = (SELECT batch_id FROM shipping_quotes WHERE shipment_id = $1 ORDER BY quoted_at DESC, id LIMIT 1) OR q.id = $2)
       ORDER BY q.price_cents, q.days`,
      [id, r.quote_id],
    )
  ).rows.map((q) => ({ ...q, stale: !samePackages(q.packages, r.packages) }));
  const labels = (
    await db.query(
      `SELECT l.id, l.provider, l.service, l.status, l.external_id, l.protocol, l.tracking_code, l.quoted_cents, l.cost_cents, l.over_limit_reason, l.error,
              l.cancel_reason, l.refund_status, l.refund_cents, l.requested_at, l.purchased_at, l.canceled_at, l.version, u.name AS requested_by_name,
              coalesce((SELECT json_agg(json_build_object('from', e.from_status, 'to', e.to_status, 'source', e.source, 'note', e.note, 'at', e.created_at, 'actor', a.name) ORDER BY e.id)
                        FROM shipping_label_events e LEFT JOIN users a ON a.id = e.actor_id WHERE e.label_id = l.id), '[]') AS events
       FROM shipping_labels l LEFT JOIN users u ON u.id = l.requested_by WHERE l.shipment_id = $1 ORDER BY l.requested_at DESC`,
      [id],
    )
  ).rows;
  const tracking = (
    await db.query(
      `SELECT s.tracking_status, s.last_tracked_at, s.last_tracking_event_at, s.shipped_at, s.delivered_at, s.carrier, s.tracking_code, s.tracking_url FROM shipments s WHERE s.id = $1`,
      [id],
    )
  ).rows[0];
  const events = (
    await db.query(
      `SELECT e.id::text, e.from_status, e.to_status, e.action, e.source, e.note, e.occurred_at, u.name AS actor_name FROM shipment_events e
       LEFT JOIN users u ON u.id = e.actor_id WHERE e.shipment_id = $1 AND (e.action LIKE 'track\\_%' OR e.action IN ('dispatch', 'deliver', 'handover', 'quote_select'))
       ORDER BY e.occurred_at, e.id`,
      [id],
    )
  ).rows;
  const selected = quotes.find((q) => q.id === r.quote_id) ?? null;
  return {
    shipment: {
      id: r.id,
      orderId: r.order_id,
      orderNumber: r.order_number,
      seq: r.seq,
      kind: r.kind,
      status: r.status,
      version: r.version,
      invoiceStatus: r.invoice_status,
      packages: r.packages,
      carrierProvider: r.carrier_provider,
      carrierService: r.carrier_service,
      warehouseName: r.w_name,
      warehouseCep: r.w_cep,
      toCep: r.ship_to?.cep ?? null,
      storeCarrier: await isStoreCarrier(db, id),
    },
    provider: provider ? { name: provider.name, capabilities: provider.capabilities } : null,
    gate,
    charged: await chargedShare(db, r.order_id, r.id, r.freight_cents),
    quotes,
    selectedQuote: selected,
    labels,
    costs: await costsOf(db, id),
    tracking: { ...tracking, events },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Rastreio: aplicar um evento (consulta, aviso do transportador ou registro manual)

export type TrackingSource = { source: 'carrier' | 'manual'; actorId: string | null; requestKey?: string | null };

/**
 * Grava o evento no historico e, se for o caso, avanca a remessa. Nunca rebaixa: evento atrasado ou fora de ordem fica
 * so no historico. Duplicado (mesma chave do provedor) nao entra. Chamar dentro de tx.
 */
export async function applyTracking(db: Db, shipmentId: string, ev: TrackEvent, src: TrackingSource): Promise<'applied' | 'recorded' | 'duplicate'> {
  const { order, s } = await lockShipment(db, shipmentId);
  if (ev.key && (await db.query('SELECT 1 FROM shipment_events WHERE shipment_id = $1 AND provider_event_id = $2', [s.id, ev.key])).rows[0]) return 'duplicate';
  const cur = s.status;
  const target = TARGET[ev.status];
  let to = cur;
  const notes: string[] = [`Transportador: ${TRACK_LABEL[ev.status]}`];
  if (ev.description) notes.push(safeError(ev.description).slice(0, 200));
  const tracked = (await db.query<{ tracking_code: string | null }>('SELECT tracking_code FROM shipments WHERE id = $1', [s.id])).rows[0]!.tracking_code;
  if (ev.tracking && tracked && ev.tracking.toUpperCase() !== tracked.toUpperCase()) {
    notes.push(`código informado pelo transportador (${ev.tracking}) diferente do registrado (${tracked}): a situação não foi alterada`);
  } else if (target && RANK[cur] !== undefined && RANK[target]! > RANK[cur]!) {
    to = target;
  } else if (target && RANK[cur] === undefined) {
    notes.push(
      cur === 'packed' || cur === 'checking' || cur === 'picking' || cur === 'pending'
        ? `a remessa está ${STATUS_PT[cur]} no sistema: despache pela expedição (o estoque só baixa no despacho)`
        : `a remessa está ${STATUS_PT[cur] ?? cur}: a situação não foi alterada`,
    );
  } else if (target) {
    notes.push(`evento atrasado ou repetido: a remessa já está ${STATUS_PT[cur] ?? cur}`);
  } else if (ev.status === 'delivery_failed' || ev.status === 'returned') {
    notes.push('registrado para acompanhamento; o tratamento é feito na Fase 9');
  }
  const at = ev.at.getTime() > Date.now() ? new Date() : ev.at;
  const ins = await db.query(
    `INSERT INTO shipment_events (shipment_id, from_status, to_status, action, source, provider_event_id, request_key, note, actor_id, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (shipment_id, provider_event_id) DO NOTHING`,
    [s.id, cur, to, `track_${ev.status}`, src.source, ev.key, src.requestKey ?? null, notes.join('; ').slice(0, 500), src.actorId, at],
  );
  if (!ins.rowCount) return 'duplicate';
  await db.query(
    `UPDATE shipments SET tracking_status = CASE WHEN last_tracking_event_at IS NULL OR $2 >= last_tracking_event_at THEN $3 ELSE tracking_status END,
       last_tracking_event_at = greatest(coalesce(last_tracking_event_at, $2), $2) WHERE id = $1`,
    [s.id, at, ev.status],
  );
  if (to === cur) return 'recorded';
  await db.query(
    `UPDATE shipments SET status = $2, delivered_at = CASE WHEN $2 = 'delivered' THEN coalesce(delivered_at, $3) ELSE delivered_at END, version = version + 1, updated_at = now() WHERE id = $1`,
    [s.id, to, at],
  );
  if (to === 'delivered') await projectOrder(db, order, src.actorId, `Remessa nº ${s.seq} entregue (${src.source === 'carrier' ? 'transportador' : 'registro manual'})`);
  return 'applied';
}

// ---------------------------------------------------------------------------------------------------------------
// Etiquetas: historico e mudancas

type LabelRow = {
  id: string;
  shipment_id: string;
  quote_id: string;
  provider: 'melhorenvio' | 'fake';
  service: string;
  status: string;
  idempotency_key: string;
  external_id: string | null;
  tracking_code: string | null;
  quoted_cents: number;
  cost_cents: number | null;
  refund_status: string;
  version: number;
};
const LABEL_COLS = 'id, shipment_id, quote_id, provider, service, status, idempotency_key, external_id, tracking_code, quoted_cents, cost_cents, refund_status, version';

async function lockLabel(db: Db, id: string) {
  const l = (await db.query<LabelRow>(`SELECT ${LABEL_COLS} FROM shipping_labels WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!l) throw notFound();
  return l;
}

async function labelEvent(db: Db, l: { id: string; status: string }, to: string, source: 'manual' | 'system' | 'provider' | 'webhook', note: string | null, actorId: string | null) {
  await db.query(`INSERT INTO shipping_label_events (label_id, from_status, to_status, source, note, actor_id) VALUES ($1, $2, $3, $4, $5, $6)`, [
    l.id,
    l.status,
    to,
    source,
    note ? note.slice(0, 500) : null,
    actorId,
  ]);
}

async function setLabel(db: Db, l: LabelRow, to: string, source: 'manual' | 'system' | 'provider' | 'webhook', note: string | null, actorId: string | null, extra = '', params: unknown[] = []) {
  await db.query(`UPDATE shipping_labels SET status = $2, version = version + 1, updated_at = now()${extra} WHERE id = $1`, [l.id, to, ...params]);
  await labelEvent(db, l, to, source, note, actorId);
}

/** Etiqueta comprada: custo e rastreio do provedor gravados; a remessa fica com provedor, servico e codigo. */
async function markPurchased(db: Db, l: LabelRow, res: LabelResult, source: 'provider' | 'manual', note: string, actorId: string | null) {
  await setLabel(
    db,
    l,
    'purchased',
    source,
    note,
    actorId,
    ', external_id = $3, protocol = $4, tracking_code = $5, cost_cents = $6, purchased_at = now(), error = NULL',
    [res.externalId, res.protocol, res.trackingCode, res.costCents],
  );
  if (res.costCents) {
    await db.query(`INSERT INTO shipment_freight_costs (shipment_id, kind, amount_cents, label_id, note, actor_id) VALUES ($1, 'label', $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [
      l.shipment_id,
      res.costCents,
      l.id,
      'Custo da etiqueta informado pelo provedor',
      actorId,
    ]);
  }
  await db.query(
    `UPDATE shipments SET carrier_provider = $2, carrier_service = $3, tracking_code = coalesce(tracking_code, $4), version = version + 1, updated_at = now() WHERE id = $1`,
    [l.shipment_id, l.provider, l.service, res.trackingCode],
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Fila: tratadores

async function timed<T>(provider: string, operation: string, jobId: string | null, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const out = await fn();
    await logCall(pool, { jobId, provider, operation, ok: true, durationMs: Date.now() - t0, httpStatus: 200 });
    return out;
  } catch (err) {
    await logCall(pool, { jobId, provider, operation, ok: false, durationMs: Date.now() - t0, httpStatus: err instanceof CarrierError ? err.httpStatus : null, error: err });
    throw err;
  }
}

async function labelRequestFor(db: Db | typeof pool, l: LabelRow): Promise<LabelRequest> {
  const r = await freightRow(db, l.shipment_id);
  const q = (await db.query<{ packages: Volume[]; insurance_cents: number; from_cep: string; to_cep: string }>('SELECT packages, insurance_cents, from_cep, to_cep FROM shipping_quotes WHERE id = $1', [l.quote_id])).rows[0]!;
  const key = (await db.query<{ access_key: string | null }>(`SELECT access_key FROM fiscal_documents WHERE order_id = $1 AND status = 'authorized' ORDER BY created_at DESC LIMIT 1`, [r.order_id])).rows[0]?.access_key ?? null;
  const t = r.ship_to ?? {};
  return {
    idempotencyKey: l.idempotency_key,
    reference: `pedido ${r.order_number}-${r.seq}`,
    service: l.service,
    from: { cep: q.from_cep, street: r.w_street ?? '', number: r.w_number ?? '', complement: r.w_complement, district: r.w_district ?? '', city: r.w_city ?? '', uf: r.w_uf ?? '' },
    to: {
      cep: q.to_cep,
      street: t.street ?? '',
      number: t.number ?? '',
      complement: t.complement ?? null,
      district: t.district ?? '',
      city: t.city ?? '',
      uf: t.uf ?? '',
      name: t.recipient ?? r.buyer.name ?? '',
      phone: r.buyer.phone ?? null,
      document: r.buyer.document ?? null,
    },
    volumes: q.packages,
    insuranceCents: q.insurance_cents,
    invoiceKey: key,
  };
}

async function handleLabelPurchase(job: Job, provider: CarrierProvider | null): Promise<JobOutcome> {
  // 1. Confere e marca 'purchasing' ANTES de chamar o provedor. Achou 'purchasing' (queda no meio da chamada): pode
  //    ter cobrado, entao vira 'uncertain' e vai para a reconciliacao, nunca para uma nova compra.
  const step = await tx(null, async (db) => {
    const l = await lockLabel(db, job.ref_id);
    if (l.status === 'purchasing') {
      await setLabel(db, l, 'uncertain', 'system', 'A compra foi interrompida sem resposta do provedor: conferir antes de qualquer nova compra', null);
      await enqueueJob(db, { kind: 'label_reconcile', refId: l.id, key: `job:label_reconcile:${l.id}:1` });
      return { go: false as const, note: 'compra interrompida: etiqueta em reconciliação' };
    }
    if (l.status !== 'requested') return { go: false as const, note: `etiqueta ${l.status}: nada a comprar` };
    const gate = await labelGate(db, provider);
    if (!gate.allowed || !provider?.buyLabel || provider.name !== l.provider) {
      await setLabel(db, l, 'failed', 'system', `Compra não enviada: ${gate.reasons.join(' ') || 'provedor diferente do cotado'}`, null, ', error = $3', [
        safeError(gate.reasons.join(' ') || 'provedor diferente do cotado'),
      ]);
      return { go: false as const, note: 'compra bloqueada' };
    }
    await setLabel(db, l, 'purchasing', 'system', 'Compra enviada ao provedor', null);
    return { go: true as const, label: { ...l, status: 'purchasing' }, req: await labelRequestFor(db, l) };
  });
  if (!step.go) return { done: true, note: step.note };
  // 2. Chamada ao provedor, fora da transacao.
  let res: LabelResult;
  try {
    res = await timed(provider!.name, 'label_purchase', job.id, () => provider!.buyLabel!(step.req));
  } catch (err) {
    const rejected = err instanceof CarrierError && err.kind === 'rejected';
    await tx(null, async (db) => {
      const l = await lockLabel(db, step.label.id);
      if (l.status !== 'purchasing') return;
      if (rejected) {
        await setLabel(db, l, 'failed', 'provider', `Recusada pelo provedor: ${safeError(err)}`, null, ', error = $3', [safeError(err)]);
      } else {
        // Sem resposta clara (tempo esgotado, 5xx, queda): pode ter cobrado. Nada de nova compra ate reconciliar.
        await setLabel(db, l, 'uncertain', 'system', `Resposta incerta do provedor: ${safeError(err)}`, null, ', error = $3', [safeError(err)]);
        await enqueueJob(db, { kind: 'label_reconcile', refId: l.id, key: `job:label_reconcile:${l.id}:1` });
      }
    });
    return { done: true, note: rejected ? 'recusada pelo provedor' : 'resposta incerta: reconciliação agendada' };
  }
  await tx(null, async (db) => {
    const l = await lockLabel(db, step.label.id);
    if (l.status !== 'purchasing') return;
    await markPurchased(db, l, res, 'provider', 'Etiqueta comprada', null);
  });
  return { done: true };
}

async function handleLabelReconcile(job: Job, provider: CarrierProvider | null): Promise<JobOutcome> {
  const l = (await pool.query<LabelRow>(`SELECT ${LABEL_COLS} FROM shipping_labels WHERE id = $1`, [job.ref_id])).rows[0];
  if (!l || l.status !== 'uncertain') return { done: true, note: 'etiqueta já resolvida' };
  if (!provider?.findLabel || provider.name !== l.provider) return { dead: true, error: 'O provedor não permite conferir a compra: resolva manualmente no painel do transportador e registre o resultado.' };
  let found: Awaited<ReturnType<NonNullable<CarrierProvider['findLabel']>>>;
  try {
    found = await timed(provider.name, 'label_reconcile', job.id, () => provider.findLabel!({ idempotencyKey: l.idempotency_key, externalId: l.external_id }));
  } catch (err) {
    return { retry: true, error: `conferência da compra falhou: ${safeError(err)}` };
  }
  if (found === 'unknown') return { retry: true, error: 'o provedor ainda não confirmou se a compra existe' };
  await tx(null, async (db) => {
    const cur = await lockLabel(db, l.id);
    if (cur.status !== 'uncertain') return;
    if (found) await markPurchased(db, cur, found, 'provider', 'Reconciliação: a compra existe no provedor', null);
    else await setLabel(db, cur, 'failed', 'provider', 'Reconciliação: o provedor confirmou que a etiqueta não foi comprada', null);
  });
  return { done: true };
}

async function handleLabelCancel(job: Job, provider: CarrierProvider | null): Promise<JobOutcome> {
  const l = (await pool.query<LabelRow>(`SELECT ${LABEL_COLS} FROM shipping_labels WHERE id = $1`, [job.ref_id])).rows[0];
  if (!l || l.status !== 'cancel_requested') return { done: true, note: 'nada a cancelar' };
  if (!provider?.cancelLabel || provider.name !== l.provider || !l.external_id) return { dead: true, error: 'O provedor não permite cancelar pelo sistema: cancele no painel do transportador e registre o resultado.' };
  let res: Awaited<ReturnType<NonNullable<CarrierProvider['cancelLabel']>>>;
  try {
    res = await timed(provider.name, 'label_cancel', job.id, () => provider.cancelLabel!({ externalId: l.external_id! }));
  } catch (err) {
    return { retry: true, error: `cancelamento não confirmado: ${safeError(err)}` };
  }
  if (res.result === 'pending') return { retry: true, error: 'cancelamento aguardando confirmação do provedor', delayMinutes: 30 };
  await tx(null, async (db) => {
    const cur = await lockLabel(db, l.id);
    if (cur.status !== 'cancel_requested') return;
    if (res.result === 'refused') {
      const back = (await db.query<{ from_status: string }>(`SELECT from_status FROM shipping_label_events WHERE label_id = $1 AND to_status = 'cancel_requested' ORDER BY id DESC LIMIT 1`, [cur.id])).rows[0]?.from_status ?? 'purchased';
      await setLabel(db, cur, back, 'provider', `Cancelamento recusado pelo provedor: ${safeError(res.message ?? 'sem motivo')}`, null);
      return;
    }
    await setLabel(db, cur, 'canceled', 'provider', 'Cancelada pelo provedor', null, ', canceled_at = now(), refund_status = $3, refund_cents = $4', [
      res.refund,
      res.refund === 'refunded' ? res.refundCents ?? null : null,
    ]);
    if (res.refund === 'refunded' && res.refundCents) {
      await db.query(`INSERT INTO shipment_freight_costs (shipment_id, kind, amount_cents, label_id, note) VALUES ($1, 'refund', $2, $3, $4) ON CONFLICT DO NOTHING`, [
        cur.shipment_id,
        -Math.abs(res.refundCents),
        cur.id,
        'Estorno do cancelamento confirmado pelo provedor',
      ]);
    }
  });
  return { done: true };
}

/** Eventos de uma etiqueta: rastreio na remessa e cancelamento informado pelo transportador. */
async function applyLabelEvents(labelId: string, events: TrackEvent[], source: 'provider' | 'webhook') {
  let applied = 0;
  for (const ev of [...events].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    await tx(null, async (db) => {
      const l = await lockLabel(db, labelId);
      if (ev.status === 'canceled') {
        if (['purchased', 'printed', 'cancel_requested'].includes(l.status)) {
          await setLabel(db, l, 'canceled', source, 'O transportador informou a etiqueta como cancelada (estorno não confirmado)', null, `, canceled_at = now(), refund_status = 'unknown'`);
        }
      }
      const r = await applyTracking(db, l.shipment_id, ev, { source: 'carrier', actorId: null });
      if (r === 'applied') applied++;
    });
  }
  return applied;
}

async function handleTrackingPoll(job: Job, provider: CarrierProvider | null): Promise<JobOutcome> {
  const l = (
    await pool.query<LabelRow>(
      `SELECT ${LABEL_COLS} FROM shipping_labels WHERE shipment_id = $1 AND status IN ('purchased', 'printed', 'cancel_requested') AND external_id IS NOT NULL ORDER BY requested_at DESC LIMIT 1`,
      [job.ref_id],
    )
  ).rows[0];
  if (!l) return { done: true, note: 'remessa sem etiqueta rastreável' };
  if (!provider?.track || !provider.capabilities.track || provider.name !== l.provider) return { done: true, note: 'provedor sem rastreio' };
  let events: TrackEvent[];
  try {
    events = (await timed(provider.name, 'tracking', job.id, () => provider.track!([l.external_id!]))).get(l.external_id!) ?? [];
  } catch (err) {
    return { retry: true, error: `consulta de rastreio falhou: ${safeError(err)}` };
  }
  await applyLabelEvents(l.id, events, 'provider');
  await pool.query('UPDATE shipments SET last_tracked_at = now() WHERE id = $1', [job.ref_id]);
  return { done: true };
}

async function handleWebhook(job: Job, provider: CarrierProvider | null): Promise<JobOutcome> {
  const w = (
    await pool.query<{ id: string; provider: string; external_id: string | null; payload: { events?: { status: TrackStatus; at: string; key: string | null; tracking: string | null }[] }; status: string }>(
      'SELECT id::text, provider, external_id, payload, status FROM logistics_webhook_events WHERE id = $1',
      [job.ref_id],
    )
  ).rows[0];
  if (!w || w.status !== 'pending') return { done: true };
  const label = w.external_id
    ? (await pool.query<{ id: string }>('SELECT id FROM shipping_labels WHERE provider = $1 AND external_id = $2', [w.provider, w.external_id])).rows[0]
    : undefined;
  if (!label) {
    await pool.query(`UPDATE logistics_webhook_events SET status = 'ignored', error = 'etiqueta não encontrada', processed_at = now() WHERE id = $1`, [w.id]);
    return { done: true, note: 'aviso sem etiqueta correspondente' };
  }
  void provider;
  try {
    const events = (w.payload.events ?? []).map((e) => ({ ...e, at: new Date(e.at) }));
    await applyLabelEvents(label.id, events, 'webhook');
  } catch (err) {
    await pool.query(`UPDATE logistics_webhook_events SET error = $2 WHERE id = $1`, [w.id, safeError(err)]);
    return { retry: true, error: safeError(err) };
  }
  await pool.query(`UPDATE logistics_webhook_events SET status = 'processed', error = NULL, processed_at = now() WHERE id = $1`, [w.id]);
  return { done: true };
}

const HANDLERS: Record<Job['kind'], (job: Job, p: CarrierProvider | null) => Promise<JobOutcome>> = {
  label_purchase: handleLabelPurchase,
  label_reconcile: handleLabelReconcile,
  label_cancel: handleLabelCancel,
  tracking_poll: handleTrackingPoll,
  webhook_process: handleWebhook,
};

/** Remessas despachadas com etiqueta rastreavel e consulta vencida: uma tarefa por remessa e janela. */
export async function scheduleTracking(db: Db | typeof pool = pool, provider: CarrierProvider | null = carrierProvider()) {
  if (!provider?.track || !provider.capabilities.track) return 0;
  const st = await freightSettings(db);
  const due = (
    await db.query<{ id: string }>(
      `SELECT s.id FROM shipments s
       WHERE s.status = ANY($1::text[]) AND (s.last_tracked_at IS NULL OR s.last_tracked_at < now() - make_interval(hours => $2))
         AND EXISTS (SELECT 1 FROM shipping_labels l WHERE l.shipment_id = s.id AND l.provider = $3 AND l.external_id IS NOT NULL AND l.status IN ('purchased', 'printed', 'cancel_requested'))
       ORDER BY s.last_tracked_at NULLS FIRST LIMIT 200`,
      [TRACKED, st.tracking_poll_hours, provider.name],
    )
  ).rows;
  const bucket = Math.floor(Date.now() / (st.tracking_poll_hours * 3_600_000));
  let n = 0;
  for (const s of due) if (await enqueueJob(db, { kind: 'tracking_poll', refId: s.id, key: `job:tracking:${s.id}:${bucket}`, maxAttempts: 3 })) n++;
  return n;
}

/** Rotina de 60 s: agenda o rastreio e executa as tarefas vencidas (limite por rodada, abaixo do limite do provedor). */
export async function integrationTick(provider: CarrierProvider | null = carrierProvider(), limit = 20) {
  const scheduled = await scheduleTracking(pool, provider);
  const jobs = await claimJobs(limit);
  const result = { scheduled, done: 0, retried: 0, dead: 0 };
  for (const job of jobs) {
    let out: JobOutcome;
    try {
      out = await HANDLERS[job.kind](job, provider);
    } catch (err) {
      out = { retry: true, error: safeError(err) };
    }
    await finishJob(pool, job, out);
    if ('done' in out) result.done++;
    else if ('dead' in out || job.attempts >= job.max_attempts) result.dead++;
    else result.retried++;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Rotas: /api/v1/admin/freight

async function versionOf(db: Db, id: string, version: number) {
  const s = (await db.query<{ version: number }>('SELECT version FROM shipments WHERE id = $1', [id])).rows[0]!;
  if (s.version !== version) throw new AppError(409, 'VERSION_CONFLICT', 'A remessa foi alterada por outra pessoa. Recarregue a página.');
}

const monthStart = () => {
  const d = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  return `${d.slice(0, 8)}01`;
};
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

export async function freightReport(db: Db | typeof pool, from: string, to: string) {
  const rows = (
    await db.query<{
      shipment_id: string;
      order_id: string;
      order_number: number;
      seq: number;
      kind: string;
      status: string;
      shipped_at: Date;
      carrier: string | null;
      carrier_provider: string | null;
      carrier_service: string | null;
      freight_cents: number;
      quoted_cents: number | null;
      service_name: string | null;
      paid_cents: number | null;
      refunded_cents: number | null;
      pending_refunds: number;
      live: number;
      rank: number;
    }>(
      `SELECT s.id AS shipment_id, s.order_id, o.number AS order_number, s.seq, s.kind, s.status, s.shipped_at, s.carrier, s.carrier_provider, s.carrier_service,
              o.freight_cents::int AS freight_cents, q.price_cents AS quoted_cents, q.service_name,
              (SELECT sum(c.amount_cents)::int FROM shipment_freight_costs c WHERE c.shipment_id = s.id AND c.kind <> 'refund') AS paid_cents,
              (SELECT sum(c.amount_cents)::int FROM shipment_freight_costs c WHERE c.shipment_id = s.id AND c.kind = 'refund') AS refunded_cents,
              (SELECT count(*)::int FROM shipping_labels l WHERE l.shipment_id = s.id AND l.status = 'canceled' AND l.refund_status IN ('pending', 'unknown')) AS pending_refunds,
              (SELECT count(*)::int FROM shipments x WHERE x.order_id = s.order_id AND x.status <> 'canceled' AND x.kind IN ('delivery', 'legacy')) AS live,
              (SELECT count(*)::int FROM shipments x WHERE x.order_id = s.order_id AND x.status <> 'canceled' AND x.kind IN ('delivery', 'legacy') AND x.seq < s.seq) AS rank
       FROM shipments s JOIN orders o ON o.id = s.order_id LEFT JOIN shipping_quotes q ON q.id = s.quote_id
       WHERE ${STORE_CARRIER_SQL} AND s.status <> 'canceled' AND s.shipped_at IS NOT NULL
         AND (s.shipped_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1::date AND $2::date
       ORDER BY s.shipped_at, o.number, s.seq`,
      [from, to],
    )
  ).rows;
  const items = rows.map((r) => {
    const n = Math.max(1, r.live);
    const base = Math.floor(r.freight_cents / n);
    const charged = r.rank === 0 ? r.freight_cents - base * (n - 1) : base;
    const net = r.paid_cents === null ? null : r.paid_cents + (r.refunded_cents ?? 0);
    return {
      shipmentId: r.shipment_id,
      orderId: r.order_id,
      orderNumber: r.order_number,
      seq: r.seq,
      legacy: r.kind === 'legacy',
      status: r.status,
      shippedAt: r.shipped_at,
      carrier: r.carrier ?? r.service_name ?? null,
      provider: r.carrier_provider,
      service: r.carrier_service,
      chargedCents: charged,
      chargedSplit: n > 1,
      quotedCents: r.quoted_cents,
      paidCents: r.paid_cents,
      refundedCents: r.refunded_cents,
      netCents: net,
      pendingRefunds: r.pending_refunds,
      // Diferenca so com o pago conhecido.
      diffCents: net === null ? null : charged - net,
    };
  });
  const known = items.filter((i) => i.netCents !== null);
  const groups = new Map<string, { carrier: string; shipments: number; chargedCents: number; knownChargedCents: number; netCents: number; unknown: number }>();
  for (const i of items) {
    const k = i.carrier ?? 'Sem transportadora informada';
    const g = groups.get(k) ?? { carrier: k, shipments: 0, chargedCents: 0, knownChargedCents: 0, netCents: 0, unknown: 0 };
    g.shipments++;
    g.chargedCents += i.chargedCents;
    if (i.netCents === null) g.unknown++;
    else {
      g.netCents += i.netCents;
      g.knownChargedCents += i.chargedCents;
    }
    groups.set(k, g);
  }
  return {
    from,
    to,
    items,
    totals: {
      shipments: items.length,
      chargedCents: items.reduce((s, i) => s + i.chargedCents, 0),
      quotedCents: items.some((i) => i.quotedCents !== null) ? items.reduce((s, i) => s + (i.quotedCents ?? 0), 0) : null,
      quotedShipments: items.filter((i) => i.quotedCents !== null).length,
      // So o que tem custo conhecido entra na comparacao; o resto aparece como "sem custo informado".
      knownShipments: known.length,
      unknownShipments: items.length - known.length,
      knownChargedCents: known.reduce((s, i) => s + i.chargedCents, 0),
      netCents: known.length ? known.reduce((s, i) => s + i.netCents!, 0) : null,
      diffCents: known.length ? known.reduce((s, i) => s + i.diffCents!, 0) : null,
      pendingRefunds: items.reduce((s, i) => s + i.pendingRefunds, 0),
    },
    byCarrier: [...groups.values()].map((g) => ({ ...g, diffCents: g.shipments - g.unknown ? g.knownChargedCents - g.netCents : null })),
  };
}

export async function freightRoutes(app: FastifyInstance) {
  app.get('/overview', async (req) => {
    requirePermission(req, 'logistics.view');
    const provider = carrierProvider();
    const st = await freightSettings(pool);
    const c = (
      await pool.query(
        `SELECT
           (SELECT count(*)::int FROM shipments s WHERE s.kind = 'delivery' AND s.status = 'packed' AND s.quote_id IS NULL) AS to_quote,
           (SELECT count(*)::int FROM shipments s WHERE s.kind = 'delivery' AND s.status = 'packed' AND s.quote_id IS NOT NULL) AS quoted,
           (SELECT count(*)::int FROM shipments s JOIN orders o ON o.id = s.order_id WHERE ${STORE_CARRIER_SQL} AND s.status = ANY($1::text[])
              AND coalesce(s.last_tracking_event_at, s.shipped_at) < now() - make_interval(days => $2)) AS stale,
           (SELECT count(*)::int FROM shipments s JOIN orders o ON o.id = s.order_id WHERE ${STORE_CARRIER_SQL} AND s.shipped_at IS NOT NULL AND s.status <> 'canceled'
              AND s.shipped_at > now() - interval '90 days' AND NOT EXISTS (SELECT 1 FROM shipment_freight_costs c WHERE c.shipment_id = s.id)) AS without_cost,
           (SELECT count(*)::int FROM integration_jobs WHERE status = 'dead') AS jobs_dead,
           (SELECT count(*)::int FROM integration_jobs WHERE status IN ('pending', 'running') AND attempts > 0 AND last_error IS NOT NULL) AS jobs_retrying,
           (SELECT count(*)::int FROM integration_jobs WHERE status IN ('pending', 'running')) AS jobs_open,
           (SELECT count(*)::int FROM logistics_webhook_events WHERE status = 'pending') AS webhooks_pending`,
        [TRACKED, st.tracking_stale_days],
      )
    ).rows[0];
    const labels = (await pool.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM shipping_labels GROUP BY 1')).rows;
    return {
      provider: provider ? { name: provider.name, capabilities: provider.capabilities } : null,
      gate: await labelGate(pool, provider),
      settings: st,
      counts: c,
      labels: Object.fromEntries(labels.map((l) => [l.status, l.n])),
    };
  });

  app.get('/shipments', async (req) => {
    requirePermission(req, 'logistics.view');
    const q = pageQuery.extend({ view: z.enum(['to_quote', 'quoted', 'labels', 'stale', 'without_cost', 'tracking']).default('to_quote') }).parse(req.query);
    const st = await freightSettings(pool);
    // Cada lista recebe so os parametros que usa: parametro sobrando da erro no Postgres ("could not determine data type").
    const filters: Record<typeof q.view, (p: (v: unknown) => string) => string> = {
      to_quote: () => `s.kind = 'delivery' AND s.status = 'packed' AND s.quote_id IS NULL`,
      quoted: () => `s.kind = 'delivery' AND s.status = 'packed' AND s.quote_id IS NOT NULL`,
      labels: () => `EXISTS (SELECT 1 FROM shipping_labels l WHERE l.shipment_id = s.id)`,
      stale: (p) => `${STORE_CARRIER_SQL} AND s.status = ANY(${p(TRACKED)}::text[]) AND coalesce(s.last_tracking_event_at, s.shipped_at) < now() - make_interval(days => ${p(st.tracking_stale_days)}::int)`,
      without_cost: () => `${STORE_CARRIER_SQL} AND s.shipped_at IS NOT NULL AND s.status <> 'canceled' AND s.shipped_at > now() - interval '90 days'
                     AND NOT EXISTS (SELECT 1 FROM shipment_freight_costs c WHERE c.shipment_id = s.id)`,
      tracking: (p) => `${STORE_CARRIER_SQL} AND s.status = ANY(${p(TRACKED)}::text[])`,
    };
    const build = (first: unknown[]) => {
      const params = [...first];
      const where = filters[q.view]((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return { where, params };
    };
    const c = build([]);
    const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM shipments s JOIN orders o ON o.id = s.order_id WHERE ${c.where}`, c.params)).rows[0]!.n;
    const l = build([q.pageSize, (q.page - 1) * q.pageSize]);
    const { rows } = await pool.query(
      `SELECT s.id, s.seq, s.kind, s.status, s.version, s.carrier, s.tracking_code, s.shipped_at, s.packed_at, s.tracking_status, s.last_tracked_at, s.last_tracking_event_at,
              s.carrier_provider, s.carrier_service, o.number AS order_number, o.freight_cents::int AS freight_cents, w.name AS warehouse_name, q.price_cents AS quoted_cents, q.service_name,
              (SELECT l.status FROM shipping_labels l WHERE l.shipment_id = s.id ORDER BY l.requested_at DESC LIMIT 1) AS label_status,
              (SELECT sum(c.amount_cents)::int FROM shipment_freight_costs c WHERE c.shipment_id = s.id) AS net_cents
       FROM shipments s JOIN orders o ON o.id = s.order_id LEFT JOIN warehouses w ON w.id = s.warehouse_id LEFT JOIN shipping_quotes q ON q.id = s.quote_id
       WHERE ${l.where} ORDER BY coalesce(s.shipped_at, s.packed_at, s.created_at) DESC, o.number LIMIT $1 OFFSET $2`,
      l.params,
    );
    return { items: rows, total, page: q.page, pageSize: q.pageSize };
  });

  app.get('/shipments/:id', async (req) => {
    requirePermission(req, 'logistics.view');
    const { id } = idParams.parse(req.params);
    return { freight: await freightView(pool, id) };
  });

  // Cotacao da remessa embalada: deposito de origem e volumes medidos. Chamada ao provedor fora da transacao.
  app.post('/shipments/:id/quotes', async (req) => {
    const auth = requirePermission(req, 'shipping.manage');
    const { id } = idParams.parse(req.params);
    z.strictObject({}).parse(req.body ?? {});
    const r = await freightRow(pool, id);
    assertQuotable(r);
    const volumes = measuredVolumes(r);
    if (!r.w_cep) throw new AppError(409, 'WAREHOUSE_ADDRESS_MISSING', `Cadastre o CEP do depósito ${r.w_name ?? ''} antes de cotar o frete.`.replace('  ', ' '));
    const toCep = String(r.ship_to?.cep ?? '').replace(/\D/g, '');
    if (!/^\d{8}$/.test(toCep)) throw new AppError(409, 'DESTINATION_MISSING', 'O pedido não tem CEP de entrega.');
    const provider = carrierProvider();
    if (!provider) throw new AppError(503, 'CARRIER_UNAVAILABLE', 'Nenhum provedor de frete configurado.');
    const services = (await pool.query<{ carrier_service: string }>(`SELECT DISTINCT carrier_service FROM shipping_options WHERE kind = 'carrier' AND carrier_service IS NOT NULL`)).rows.map(
      (x) => x.carrier_service,
    );
    if (!services.length) throw new AppError(409, 'NO_CARRIER_SERVICES', 'Nenhuma forma de entrega por transportadora cadastrada (Entrega e frete).');
    const insurance = await shipmentGoodsCents(pool, id);
    const per = Math.floor(insurance / volumes.length);
    let quotes;
    try {
      quotes = await timed(provider.name, 'quote', null, () =>
        provider.quote({
          fromCep: r.w_cep!,
          toCep,
          services,
          items: volumes.map((v, i) => ({
            id: `volume-${i + 1}`,
            widthCm: Math.max(1, Math.ceil(v.widthMm / 10)),
            heightCm: Math.max(1, Math.ceil(v.heightMm / 10)),
            lengthCm: Math.max(1, Math.ceil(v.lengthMm / 10)),
            weightKg: Math.max(0.001, v.weightG / 1000),
            insuranceCents: i === 0 ? insurance - per * (volumes.length - 1) : per,
            quantity: 1,
          })),
        }),
      );
    } catch (err) {
      throw new AppError(502, 'CARRIER_UNAVAILABLE', `Não foi possível cotar agora: ${safeError(err)}`);
    }
    if (!quotes.length) throw new AppError(422, 'NO_QUOTES', 'O provedor não devolveu opções de frete para este trecho e estes volumes.');
    const batch = randomUUID();
    await tx(auth.userId, async (db) => {
      const { s } = await lockShipment(db, id);
      const cur = (await db.query<{ packages: unknown; status: string }>('SELECT packages, status FROM shipments WHERE id = $1', [s.id])).rows[0]!;
      if (cur.status !== 'packed' || !samePackages(cur.packages, r.packages)) {
        throw new AppError(409, 'VERSION_CONFLICT', 'A embalagem da remessa mudou durante a cotação. Cote de novo.');
      }
      for (const q of quotes) {
        await db.query(
          `INSERT INTO shipping_quotes (shipment_id, batch_id, provider, service, service_name, company, price_cents, days, from_cep, to_cep, packages, insurance_cents, quoted_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now() + make_interval(mins => $14))`,
          [id, batch, provider.name, q.service, q.name.slice(0, 120) || `Serviço ${q.service}`, q.company?.slice(0, 120) ?? null, q.priceCents, q.days, r.w_cep, toCep, JSON.stringify(volumes), insurance, auth.userId, QUOTE_TTL_MIN],
        );
      }
    });
    return { freight: await freightView(pool, id) };
  });

  // Escolher a cotacao: vira o servico da remessa. Cotacao vencida ou de outra embalagem nao vale.
  app.post('/shipments/:id/quote-selection', async (req) => {
    const auth = requirePermission(req, 'shipping.manage');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ quoteId: z.uuid(), version: z.number().int(), requestKey: key }).parse(req.body);
    if ((await pool.query('SELECT 1 FROM shipment_events WHERE request_key = $1', [b.requestKey])).rows[0]) return { replayed: true, freight: await freightView(pool, id) };
    try {
      await tx(auth.userId, async (db) => {
        const { s } = await lockShipment(db, id);
        await versionOf(db, s.id, b.version);
        const r = await freightRow(db, id);
        assertQuotable(r);
        const q = (await db.query<{ id: string; provider: string; service: string; service_name: string; price_cents: number; packages: unknown; expired: boolean }>(
          'SELECT id, provider, service, service_name, price_cents, packages, expires_at <= now() AS expired FROM shipping_quotes WHERE id = $1 AND shipment_id = $2',
          [b.quoteId, id],
        )).rows[0];
        if (!q) throw notFound();
        if (q.expired) throw new AppError(409, 'QUOTE_EXPIRED', 'A cotação venceu. Cote o frete de novo.');
        if (!samePackages(q.packages, r.packages)) throw new AppError(409, 'QUOTE_STALE', 'A cotação foi feita com outra embalagem. Cote o frete de novo.');
        if ((await db.query(`SELECT 1 FROM shipping_labels WHERE shipment_id = $1 AND status = ANY($2::text[])`, [id, ACTIVE_LABEL])).rows[0]) {
          throw new AppError(409, 'LABEL_ACTIVE', 'A remessa já tem etiqueta ativa. Cancele a etiqueta antes de trocar o serviço.');
        }
        await db.query(`UPDATE shipments SET quote_id = $2, carrier_provider = $3, carrier_service = $4, version = version + 1, updated_at = now() WHERE id = $1`, [id, q.id, q.provider, q.service]);
        await db.query(
          `INSERT INTO shipment_events (shipment_id, from_status, to_status, action, note, request_key, actor_id) VALUES ($1, $2, $2, 'quote_select', $3, $4, $5)`,
          [id, r.status, `Frete escolhido: ${q.service_name}, R$ ${(q.price_cents / 100).toFixed(2).replace('.', ',')}`.slice(0, 500), b.requestKey, auth.userId],
        );
      });
    } catch (err) {
      if (isUniqueViolation(err, 'shipment_events_request_key_key')) return { replayed: true, freight: await freightView(pool, id) };
      throw err;
    }
    return { replayed: false, freight: await freightView(pool, id) };
  });

  // Pedir etiqueta. Bloqueada no servidor enquanto labelGate nao liberar; mesmo liberada, so com MFA, NF-e autorizada,
  // cotacao vigente da embalagem atual, volumes completos e dentro do limite (ou justificativa).
  app.post('/shipments/:id/labels', async (req) => {
    const auth = requirePermission(req, 'shipping.labels');
    const { id } = idParams.parse(req.params);
    const b = z.strictObject({ version: z.number().int(), requestKey: key, overLimitReason: z.string().trim().min(10).max(300).optional() }).parse(req.body);
    const prior = (await pool.query<{ shipment_id: string }>('SELECT shipment_id FROM shipping_labels WHERE request_key = $1', [b.requestKey])).rows[0];
    if (prior) {
      if (prior.shipment_id !== id) throw new AppError(409, 'REQUEST_KEY_REUSED', 'Chave de requisição já usada em outra remessa.');
      return { replayed: true, freight: await freightView(pool, id) };
    }
    const gate = await labelGate(pool);
    if (!gate.allowed) throw new AppError(409, 'LABELS_BLOCKED', `Compra de etiqueta bloqueada. ${gate.reasons.join(' ')}`, { reasons: gate.reasons });
    try {
      await tx(auth.userId, async (db) => {
        const { order, s } = await lockShipment(db, id);
        await versionOf(db, s.id, b.version);
        const g = await labelGate(db);
        if (!g.allowed) throw new AppError(409, 'LABELS_BLOCKED', `Compra de etiqueta bloqueada. ${g.reasons.join(' ')}`, { reasons: g.reasons });
        const r = await freightRow(db, id);
        assertQuotable(r);
        measuredVolumes(r);
        if (order.invoice_status !== 'authorized') throw new AppError(409, 'INVOICE_REQUIRED', 'A etiqueta exige a NF-e autorizada do pedido.');
        const missingFrom = (['w_cep', 'w_street', 'w_number', 'w_district', 'w_city', 'w_uf'] as const).filter((k) => !r[k]);
        if (missingFrom.length) throw new AppError(409, 'WAREHOUSE_ADDRESS_MISSING', `Endereço do depósito ${r.w_name} incompleto. Complete o cadastro do depósito.`);
        const t = r.ship_to ?? {};
        if (!t.cep || !t.street || !t.number || !t.district || !t.city || !t.uf || !(t.recipient || r.buyer.name)) {
          throw new AppError(409, 'DESTINATION_MISSING', 'O endereço de entrega do pedido está incompleto.');
        }
        if (!r.quote_id) throw new AppError(409, 'QUOTE_REQUIRED', 'Cote o frete e escolha o serviço antes de pedir a etiqueta.');
        const q = (await db.query<{ provider: string; service: string; price_cents: number; packages: unknown; expired: boolean }>(
          'SELECT provider, service, price_cents, packages, expires_at <= now() AS expired FROM shipping_quotes WHERE id = $1',
          [r.quote_id],
        )).rows[0]!;
        if (q.expired) throw new AppError(409, 'QUOTE_EXPIRED', 'A cotação escolhida venceu. Cote o frete de novo.');
        if (!samePackages(q.packages, r.packages)) throw new AppError(409, 'QUOTE_STALE', 'A cotação foi feita com outra embalagem. Cote o frete de novo.');
        if (q.provider !== carrierProvider()?.name) throw new AppError(409, 'QUOTE_STALE', 'A cotação é de outro provedor. Cote o frete de novo.');
        if (q.price_cents > g.maxCents! && !b.overLimitReason) {
          throw new AppError(422, 'OVER_LABEL_LIMIT', `A etiqueta (R$ ${(q.price_cents / 100).toFixed(2).replace('.', ',')}) passa do limite por etiqueta. Informe a justificativa.`, {
            limitCents: g.maxCents,
          });
        }
        const active = (await db.query<{ id: string; status: string }>(`SELECT id, status FROM shipping_labels WHERE shipment_id = $1 AND status = ANY($2::text[])`, [id, ACTIVE_LABEL])).rows[0];
        if (active) throw new AppError(409, 'LABEL_ACTIVE', `A remessa já tem etiqueta (${active.status}). Uma remessa nunca gera duas compras.`);
        const n = (await db.query<{ n: number }>('SELECT count(*)::int + 1 AS n FROM shipping_labels WHERE shipment_id = $1', [id])).rows[0]!.n;
        const label = (
          await db.query<{ id: string; status: string }>(
            `INSERT INTO shipping_labels (shipment_id, quote_id, provider, service, idempotency_key, request_key, quoted_cents, over_limit_reason, requested_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, status`,
            [id, r.quote_id, q.provider, q.service, `label:${id}:${n}`, b.requestKey, q.price_cents, q.price_cents > g.maxCents! ? b.overLimitReason : null, auth.userId],
          )
        ).rows[0]!;
        await labelEvent(db, { id: label.id, status: '' }, 'requested', 'manual', b.overLimitReason ? `Acima do limite: ${b.overLimitReason}` : null, auth.userId);
        await enqueueJob(db, { kind: 'label_purchase', refId: label.id, key: `job:label_purchase:${label.id}`, createdBy: auth.userId, maxAttempts: 1 });
        await audit(db, { actorId: auth.userId, action: 'shipping.label_request', entity: 'shipment', entityId: id, after: { labelId: label.id, quotedCents: q.price_cents }, ip: auth.ip });
      });
    } catch (err) {
      if (isUniqueViolation(err, 'shipping_labels_request_key_key')) return { replayed: true, freight: await freightView(pool, id) };
      if (isUniqueViolation(err, 'shipping_labels_one_active')) throw new AppError(409, 'LABEL_ACTIVE', 'A remessa já tem etiqueta ativa. Uma remessa nunca gera duas compras.');
      throw err;
    }
    return { replayed: false, freight: await freightView(pool, id) };
  });

  const labelBody = z.strictObject({ version: z.number().int() });

  app.post('/labels/:id/print', async (req) => {
    const auth = requirePermission(req, 'shipping.manage');
    const { id } = idParams.parse(req.params);
    const b = labelBody.parse(req.body);
    const l = (await pool.query<LabelRow>(`SELECT ${LABEL_COLS} FROM shipping_labels WHERE id = $1`, [id])).rows[0];
    if (!l) throw notFound();
    if (l.version !== b.version) throw new AppError(409, 'VERSION_CONFLICT', 'A etiqueta mudou. Recarregue a página.');
    if (!['purchased', 'printed'].includes(l.status) || !l.external_id) throw new AppError(409, 'INVALID_TRANSITION', 'Só a etiqueta comprada pode ser impressa.');
    const provider = carrierProvider();
    if (!provider?.printLabel || provider.name !== l.provider) throw new AppError(409, 'NOT_SUPPORTED', 'Imprima a etiqueta pelo painel do transportador.');
    const out = await timed(provider.name, 'label_print', null, () => provider.printLabel!({ externalId: l.external_id! })).catch((err) => {
      throw new AppError(502, 'CARRIER_UNAVAILABLE', `Não foi possível obter a etiqueta: ${safeError(err)}`);
    });
    await tx(auth.userId, async (db) => {
      const cur = await lockLabel(db, id);
      if (cur.status === 'purchased') await setLabel(db, cur, 'printed', 'manual', 'Etiqueta impressa', auth.userId);
    });
    return { url: out.url, freight: await freightView(pool, l.shipment_id) };
  });

  // Cancelar a etiqueta: pedida antes do envio ao provedor, cancela aqui mesmo; comprada, pede ao provedor e aguarda.
  app.post('/labels/:id/cancel', async (req) => {
    const auth = requirePermission(req, 'shipping.labels');
    const { id } = idParams.parse(req.params);
    const b = labelBody.extend({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    const shipmentId = await tx(auth.userId, async (db) => {
      const l0 = (await db.query<{ shipment_id: string }>('SELECT shipment_id FROM shipping_labels WHERE id = $1', [id])).rows[0];
      if (!l0) throw notFound();
      const { s } = await lockShipment(db, l0.shipment_id);
      const l = await lockLabel(db, id);
      if (l.version !== b.version) throw new AppError(409, 'VERSION_CONFLICT', 'A etiqueta mudou. Recarregue a página.');
      if (l.status === 'requested') {
        await setLabel(db, l, 'canceled', 'manual', `Cancelada antes do envio ao provedor: ${b.reason}`, auth.userId, ', canceled_at = now(), cancel_reason = $3', [b.reason]);
        await db.query(`UPDATE integration_jobs SET status = 'canceled', finished_at = now(), updated_at = now() WHERE kind = 'label_purchase' AND ref_id = $1 AND status = 'pending'`, [l.id]);
      } else if (['purchased', 'printed'].includes(l.status)) {
        if (!['packed'].includes(s.status)) throw new AppError(409, 'LABEL_POSTED', 'A remessa já foi despachada: o cancelamento da etiqueta é feito com o transportador.');
        await setLabel(db, l, 'cancel_requested', 'manual', `Cancelamento pedido: ${b.reason}`, auth.userId, ', cancel_reason = $3', [b.reason]);
        await enqueueJob(db, { kind: 'label_cancel', refId: l.id, key: `job:label_cancel:${l.id}:${l.version + 1}`, createdBy: auth.userId, maxAttempts: 10 });
      } else if (l.status === 'uncertain' || l.status === 'purchasing') {
        throw new AppError(409, 'LABEL_UNCERTAIN', 'A compra desta etiqueta ainda não foi conferida no provedor. Resolva a reconciliação antes de cancelar.');
      } else {
        throw new AppError(409, 'INVALID_TRANSITION', `Etiqueta ${l.status}: nada a cancelar.`);
      }
      await audit(db, { actorId: auth.userId, action: 'shipping.label_cancel', entity: 'shipping_label', entityId: l.id, after: { reason: b.reason }, ip: auth.ip });
      return l.shipment_id;
    });
    return { freight: await freightView(pool, shipmentId) };
  });

  // Reconciliar de novo pelo provedor (etiqueta incerta).
  app.post('/labels/:id/reconcile', async (req) => {
    const auth = requirePermission(req, 'shipping.labels');
    const { id } = idParams.parse(req.params);
    labelBody.parse(req.body);
    const l = (await pool.query<LabelRow>(`SELECT ${LABEL_COLS} FROM shipping_labels WHERE id = $1`, [id])).rows[0];
    if (!l) throw notFound();
    if (l.status !== 'uncertain') throw new AppError(409, 'INVALID_TRANSITION', 'Só a etiqueta com compra incerta é reconciliada.');
    await enqueueJob(pool, { kind: 'label_reconcile', refId: l.id, key: `job:label_reconcile:${l.id}:${Date.now()}`, createdBy: auth.userId });
    return { freight: await freightView(pool, l.shipment_id) };
  });

  // Decisao registrada sobre uma compra incerta (conferida no painel do transportador). MFA.
  app.post('/labels/:id/resolve', async (req) => {
    const auth = requirePermission(req, 'shipping.labels');
    const { id } = idParams.parse(req.params);
    const b = labelBody
      .extend({
        outcome: z.enum(['not_purchased', 'purchased']),
        note: z.string().trim().min(10).max(300),
        externalId: z.string().trim().min(1).max(120).optional(),
        costCents: z.number().int().min(1).max(10_000_000).optional(),
        trackingCode: z.string().trim().max(60).optional(),
      })
      .refine((v) => v.outcome === 'not_purchased' || (v.externalId && v.costCents), 'Informe o identificador e o custo da etiqueta comprada.')
      .parse(req.body);
    const shipmentId = await tx(auth.userId, async (db) => {
      const l = await lockLabel(db, id);
      if (l.version !== b.version) throw new AppError(409, 'VERSION_CONFLICT', 'A etiqueta mudou. Recarregue a página.');
      if (l.status !== 'uncertain') throw new AppError(409, 'INVALID_TRANSITION', 'Só a etiqueta com compra incerta pode ser resolvida assim.');
      if (b.outcome === 'not_purchased') await setLabel(db, l, 'failed', 'manual', `Conferido: não comprada. ${b.note}`, auth.userId, ', error = NULL');
      else await markPurchased(db, l, { externalId: b.externalId!, protocol: null, trackingCode: b.trackingCode ?? null, costCents: b.costCents! }, 'manual', `Conferido: comprada. ${b.note}`, auth.userId);
      await db.query(`UPDATE integration_jobs SET status = 'canceled', finished_at = now(), updated_at = now() WHERE kind = 'label_reconcile' AND ref_id = $1 AND status IN ('pending', 'dead')`, [l.id]);
      await audit(db, { actorId: auth.userId, action: 'shipping.label_resolve', entity: 'shipping_label', entityId: l.id, after: { outcome: b.outcome, note: b.note }, ip: auth.ip });
      return l.shipment_id;
    });
    return { freight: await freightView(pool, shipmentId) };
  });

  // Estorno de etiqueta cancelada: so quando o provedor confirmar (nunca presumido).
  app.post('/labels/:id/refund', async (req) => {
    const auth = requirePermission(req, 'shipping.labels');
    const { id } = idParams.parse(req.params);
    const b = labelBody
      .extend({ status: z.enum(['refunded', 'denied']), amountCents: z.number().int().min(1).max(10_000_000).optional(), note: z.string().trim().min(3).max(300) })
      .refine((v) => v.status === 'denied' || v.amountCents, 'Informe o valor estornado.')
      .parse(req.body);
    const shipmentId = await tx(auth.userId, async (db) => {
      const l = await lockLabel(db, id);
      if (l.version !== b.version) throw new AppError(409, 'VERSION_CONFLICT', 'A etiqueta mudou. Recarregue a página.');
      if (l.status !== 'canceled' || !['pending', 'unknown'].includes(l.refund_status)) throw new AppError(409, 'INVALID_TRANSITION', 'Só a etiqueta cancelada com estorno pendente recebe este registro.');
      if (b.amountCents && l.cost_cents && b.amountCents > l.cost_cents) throw new AppError(422, 'REFUND_OVER_COST', 'O estorno passa do custo da etiqueta.');
      await db.query(`UPDATE shipping_labels SET refund_status = $2, refund_cents = $3, version = version + 1, updated_at = now() WHERE id = $1`, [l.id, b.status, b.amountCents ?? null]);
      await labelEvent(db, l, 'canceled', 'manual', b.status === 'refunded' ? `Estorno confirmado: ${b.note}` : `Estorno negado: ${b.note}`, auth.userId);
      if (b.status === 'refunded') {
        await db.query(`INSERT INTO shipment_freight_costs (shipment_id, kind, amount_cents, label_id, note, actor_id) VALUES ($1, 'refund', $2, $3, $4, $5)`, [
          l.shipment_id,
          -b.amountCents!,
          l.id,
          b.note,
          auth.userId,
        ]);
      }
      await audit(db, { actorId: auth.userId, action: 'shipping.label_refund', entity: 'shipping_label', entityId: l.id, after: { status: b.status, amountCents: b.amountCents }, ip: auth.ip });
      return l.shipment_id;
    });
    return { freight: await freightView(pool, shipmentId) };
  });

  // Custo pago a transportadora (etiqueta comprada fora), ajuste ou estorno. Imutavel: correcao e novo lancamento.
  app.post('/shipments/:id/costs', async (req) => {
    const auth = requirePermission(req, 'shipping.manage');
    const { id } = idParams.parse(req.params);
    const b = z
      .strictObject({ kind: z.enum(['manual', 'adjustment', 'refund']), amountCents: z.number().int().min(-10_000_000).max(10_000_000), note: z.string().trim().min(3).max(300).optional(), requestKey: key })
      .refine((v) => v.amountCents !== 0, 'O valor não pode ser zero.')
      .refine((v) => v.kind === 'adjustment' || v.amountCents > 0, 'Informe o valor positivo.')
      .refine((v) => v.kind === 'manual' || v.note, 'Informe o motivo.')
      .parse(req.body);
    if ((await pool.query('SELECT 1 FROM shipment_freight_costs WHERE request_key = $1', [b.requestKey])).rows[0]) return { replayed: true, freight: await freightView(pool, id) };
    try {
      await tx(auth.userId, async (db) => {
        // Bloqueio simples (o lockShipment da Fase 5 recusa o despacho anterior, que tambem recebe custo).
        const s = (await db.query<{ status: string }>('SELECT status FROM shipments WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!s) throw new AppError(404, 'NOT_FOUND', 'Remessa não encontrada.');
        if (!(await isStoreCarrier(db, id))) throw new AppError(409, 'NOT_CARRIER_SHIPMENT', 'Retirada e marketplace não têm custo de frete da loja.');
        if (s.status === 'canceled') throw new AppError(409, 'INVALID_TRANSITION', 'Remessa cancelada.');
        if (b.kind === 'manual' && (await db.query(`SELECT 1 FROM shipment_freight_costs WHERE shipment_id = $1 AND kind = 'label'`, [id])).rows[0]) {
          throw new AppError(409, 'COST_FROM_LABEL', 'O custo desta remessa veio da etiqueta. Use um ajuste para corrigir.');
        }
        await db.query(`INSERT INTO shipment_freight_costs (shipment_id, kind, amount_cents, note, request_key, actor_id) VALUES ($1, $2, $3, $4, $5, $6)`, [
          id,
          b.kind,
          b.kind === 'refund' ? -b.amountCents : b.amountCents,
          b.note ?? null,
          b.requestKey,
          auth.userId,
        ]);
        await audit(db, { actorId: auth.userId, action: 'shipping.freight_cost', entity: 'shipment', entityId: id, after: { kind: b.kind, amountCents: b.amountCents, note: b.note }, ip: auth.ip });
      });
    } catch (err) {
      if (isUniqueViolation(err, 'shipment_freight_costs_request_key_key')) return { replayed: true, freight: await freightView(pool, id) };
      if (isUniqueViolation(err, 'shipment_freight_costs_one_manual')) throw new AppError(409, 'COST_EXISTS', 'O custo desta remessa já foi informado. Use um ajuste para corrigir.');
      throw err;
    }
    return { replayed: false, freight: await freightView(pool, id) };
  });

  // Rastreio informado a mao (transportadora sem integracao). Mesmas regras: so avanca, falha so registra.
  app.post('/shipments/:id/tracking', async (req) => {
    const auth = requirePermission(req, 'shipping.manage');
    const { id } = idParams.parse(req.params);
    const b = z
      .strictObject({
        status: z.enum(['in_transit', 'out_for_delivery', 'delivery_failed', 'returned', 'info']),
        occurredAt: z.iso.datetime({ offset: true }).optional(),
        note: z.string().trim().min(3).max(200).optional(),
        requestKey: key,
      })
      .parse(req.body);
    if ((await pool.query('SELECT 1 FROM shipment_events WHERE request_key = $1', [b.requestKey])).rows[0]) return { replayed: true, freight: await freightView(pool, id) };
    let result: string;
    try {
      result = await tx(auth.userId, async (db) => {
        const r = await freightRow(db, id);
        if (!(await isStoreCarrier(db, id))) throw new AppError(409, 'NOT_CARRIER_SHIPMENT', 'Retirada e marketplace não têm rastreio pelo sistema.');
        if (!TRACKED.includes(r.status) && r.status !== 'delivered') throw new AppError(409, 'NOT_SHIPPED', 'Só a remessa despachada recebe rastreio.');
        const out = await applyTracking(db, id, { status: b.status, at: b.occurredAt ? new Date(b.occurredAt) : new Date(), key: null, tracking: null, description: b.note ?? null }, { source: 'manual', actorId: auth.userId, requestKey: b.requestKey });
        await audit(db, { actorId: auth.userId, action: 'shipment.tracking', entity: 'shipment', entityId: id, after: { status: b.status, result: out }, ip: auth.ip });
        return out;
      });
    } catch (err) {
      if (isUniqueViolation(err, 'shipment_events_request_key_key')) return { replayed: true, freight: await freightView(pool, id) };
      throw err;
    }
    return { replayed: false, result, freight: await freightView(pool, id) };
  });

  app.get('/jobs', async (req) => {
    requirePermission(req, 'logistics.view');
    const q = pageQuery.extend({ status: z.enum(['open', 'dead', 'done', 'all']).default('open') }).parse(req.query);
    const statuses = { open: ['pending', 'running'], dead: ['dead'], done: ['done', 'canceled'], all: ['pending', 'running', 'dead', 'done', 'canceled'] }[q.status];
    const { rows } = await pool.query(
      `SELECT j.id::text, j.kind, j.ref_id, j.status, j.attempts, j.max_attempts, j.next_run_at, j.last_error, j.created_at, j.updated_at, j.finished_at,
              (SELECT json_agg(json_build_object('operation', g.operation, 'httpStatus', g.http_status, 'durationMs', g.duration_ms, 'ok', g.ok, 'error', g.error, 'at', g.created_at) ORDER BY g.id DESC)
                 FROM (SELECT * FROM integration_logs g WHERE g.job_id = j.id ORDER BY g.id DESC LIMIT 5) g) AS logs
       FROM integration_jobs j WHERE j.status = ANY($1::text[]) ORDER BY j.updated_at DESC LIMIT $2 OFFSET $3`,
      [statuses, q.pageSize, (q.page - 1) * q.pageSize],
    );
    const total = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM integration_jobs WHERE status = ANY($1::text[])', [statuses])).rows[0]!.n;
    return { items: rows, total, page: q.page, pageSize: q.pageSize };
  });

  app.post('/jobs/:id/retry', async (req) => {
    const auth = requirePermission(req, 'logistics.manage');
    const id = z.object({ id: z.string().regex(/^\d{1,18}$/) }).parse(req.params).id;
    return tx(auth.userId, async (db) => {
      const job = await retryJob(db, id);
      if (!job) throw new AppError(409, 'INVALID_TRANSITION', 'Só a tarefa com falha definitiva pode ser reprocessada.');
      await audit(db, { actorId: auth.userId, action: 'integration.retry', entity: 'integration_job', after: { jobId: id, kind: job.kind, ref: job.ref_id }, ip: auth.ip });
      return { job };
    });
  });

  app.get('/report', async (req) => {
    requireAnyPermission(req, 'shipping.manage', 'reports.view');
    const q = z
      .object({ from: z.iso.date().default(monthStart), to: z.iso.date().default(today) })
      .refine((v) => v.from <= v.to, 'Período inválido.')
      .parse(req.query);
    return { report: await freightReport(pool, q.from, q.to) };
  });

  app.get('/settings', async (req) => {
    requireAnyPermission(req, 'logistics.view', 'settings.manage');
    const s = (
      await pool.query(
        `SELECT l.label_status, l.label_validator_name, l.label_validated_at, u.name AS label_validated_by_name, l.label_max_cents, l.tracking_poll_hours, l.tracking_stale_days, l.version
         FROM logistics_settings l LEFT JOIN users u ON u.id = l.label_validated_by`,
      )
    ).rows[0];
    return { settings: s, gate: await labelGate(pool) };
  });

  app.put('/settings/tracking', async (req) => {
    const auth = requirePermission(req, 'settings.manage');
    const b = z.strictObject({ pollHours: z.number().int().min(1).max(72), staleDays: z.number().int().min(1).max(60), version: z.number().int() }).parse(req.body);
    return tx(auth.userId, async (db) => {
      const before = (await db.query('SELECT tracking_poll_hours, tracking_stale_days, version FROM logistics_settings FOR UPDATE')).rows[0];
      if (before.version !== b.version) throw new AppError(409, 'VERSION_CONFLICT', 'A configuração mudou. Recarregue a página.');
      const after = (
        await db.query('UPDATE logistics_settings SET tracking_poll_hours = $1, tracking_stale_days = $2, version = version + 1, updated_at = now() RETURNING tracking_poll_hours, tracking_stale_days, version', [
          b.pollHours,
          b.staleDays,
        ])
      ).rows[0];
      await audit(db, { actorId: auth.userId, action: 'logistics.tracking_settings', entity: 'logistics_settings', before, after, ip: req.ip });
      return { settings: after };
    });
  });

  // Trava da compra de etiqueta. Bloquear sempre pode; liberar so com o servidor e o provedor permitindo, quem validou
  // e um limite definido. Nesta versao, com o Melhor Envio, liberar e recusado (o adaptador nao compra).
  app.put('/settings/labels', async (req) => {
    const auth = requirePermission(req, 'settings.manage');
    const b = z
      .strictObject({ status: z.enum(['blocked', 'enabled']), validatorName: z.string().trim().min(3).max(120).optional(), maxCents: z.number().int().min(1).max(10_000_000).optional(), version: z.number().int() })
      .refine((v) => v.status === 'blocked' || (v.validatorName && v.maxCents), 'Para liberar, informe quem validou e o limite por etiqueta.')
      .parse(req.body);
    return tx(auth.userId, async (db) => {
      const before = (await db.query('SELECT label_status, label_validator_name, label_validated_by, label_validated_at, label_max_cents, version FROM logistics_settings FOR UPDATE')).rows[0];
      if (before.version !== b.version) throw new AppError(409, 'VERSION_CONFLICT', 'A configuração mudou. Recarregue a página.');
      const enabled = b.status === 'enabled';
      if (enabled) {
        const p = carrierProvider();
        if (!config.SHIPPING_LABELS_ENABLED || !p?.capabilities.labels) {
          throw new AppError(409, 'LABELS_BLOCKED', 'A compra de etiqueta não pode ser liberada: o servidor ou o provedor não permitem compra nesta versão.');
        }
      }
      const after = (
        await db.query(
          `UPDATE logistics_settings SET label_status = $1, label_validator_name = $2, label_validated_by = $3, label_validated_at = CASE WHEN $4 THEN now() END,
             label_max_cents = $5, version = version + 1, updated_at = now()
           RETURNING label_status, label_validator_name, label_validated_by, label_validated_at, label_max_cents, version`,
          [b.status, enabled ? b.validatorName : null, enabled ? auth.userId : null, enabled, enabled ? b.maxCents : (b.maxCents ?? before.label_max_cents)],
        )
      ).rows[0];
      await audit(db, { actorId: auth.userId, action: 'logistics.labels', entity: 'logistics_settings', before, after, ip: req.ip });
      return { settings: after };
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Aviso do transportador: /api/v1/webhooks/carriers/:provider. So com assinatura valida; gravado antes de processar,
// deduplicado pelo corpo; responde rapido e processa na fila.

export async function carrierWebhookRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  app.post('/:provider', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { provider: name } = z.object({ provider: z.enum(['melhorenvio', 'fake']) }).parse(req.params);
    const provider = carrierProvider();
    const raw = typeof req.body === 'string' ? req.body : '';
    if (!provider || provider.name !== name || !provider.verifyWebhook || !provider.parseWebhook) return reply.code(404).send();
    if (!provider.verifyWebhook(raw, req.headers as Record<string, string | string[] | undefined>)) {
      await logCall(pool, { provider: name, operation: 'webhook_rejected', ok: false, httpStatus: 401, error: 'assinatura inválida' });
      return reply.code(401).send();
    }
    let parsed;
    try {
      parsed = provider.parseWebhook(JSON.parse(raw));
    } catch {
      parsed = null;
    }
    if (!parsed) return reply.code(200).send(); // assinado, mas sem nada que o sistema use
    const payload = { event: parsed.event, tracking: parsed.tracking, events: parsed.events.map((e) => ({ status: e.status, at: e.at.toISOString(), key: e.key, tracking: e.tracking })) };
    await tx(null, async (db) => {
      const row = (
        await db.query<{ id: string }>(
          `INSERT INTO logistics_webhook_events (provider, dedupe_key, event, external_id, payload) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (provider, dedupe_key) DO NOTHING RETURNING id::text`,
          [name, `sha256:${sha256(raw)}`, parsed.event.slice(0, 60), parsed.externalId?.slice(0, 120) ?? null, JSON.stringify(payload)],
        )
      ).rows[0];
      if (row) await enqueueJob(db, { kind: 'webhook_process', refId: row.id, key: `job:webhook:${row.id}` });
    });
    return reply.code(200).send();
  });
}
