// SGLog Fase 7: abastecimento e comunicacao com fornecedores (docs/32-sglog-fase7.md).
// - Documento do pedido ao fornecedor (conteudo, texto e hash), sem dados de clientes.
// - Confirmacao do fornecedor: registro, aprovacao do aumento de preco e aplicacao na compra (sem estoque nem custo
//   medio: isso e do recebimento da Fase 6).
// - Requisicoes automaticas para encomendas sem compra (idempotentes).
// - Situacao do abastecimento (prazos) por compra.
import { createHash } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { currentCompany } from '../modules/company.js';
import { AppError } from './errors.js';

type Q = Db | typeof pool;

export const CHANNELS = ['printed', 'email', 'whatsapp', 'phone', 'portal', 'other'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_LABEL: Record<Channel, string> = {
  printed: 'impresso ou PDF',
  email: 'e-mail (enviado pela equipe)',
  whatsapp: 'WhatsApp (enviado pela equipe)',
  phone: 'telefone',
  portal: 'portal do fornecedor',
  other: 'outro',
};

const brl = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const qtyText = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const dateText = (d: string | null) => (d ? d.split('-').reverse().join('/') : null);

type Address = { street: string; number: string; complement: string | null; district: string; city: string; uf: string; cep: string };
const ADDRESS_FIELDS: [keyof Address, string][] = [
  ['cep', 'CEP'],
  ['street', 'rua'],
  ['number', 'número'],
  ['district', 'bairro'],
  ['city', 'cidade'],
  ['uf', 'UF'],
];
const missingAddress = (a: Record<string, unknown> | null) => ADDRESS_FIELDS.filter(([k]) => !a?.[k]).map(([, label]) => label);
const addressText = (a: Address) =>
  `${a.street}, ${a.number}${a.complement ? ` - ${a.complement}` : ''}, ${a.district}, ${a.city}/${a.uf}, CEP ${a.cep.slice(0, 5)}-${a.cep.slice(5)}`;
const pickAddress = (a: Record<string, any>): Address => ({
  street: a.street,
  number: a.number,
  complement: a.complement ?? null,
  district: a.district,
  city: a.city,
  uf: a.uf,
  cep: a.cep,
});
const cnpjText = (c: string) => (c.length === 14 ? `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}` : c);

export type PurchaseDocument = {
  schema: 1;
  purchaseNumber: number;
  generatedOn: string;
  buyer: { legalName: string; tradeName: string | null; cnpj: string; phone: string | null; email: string | null; address: Address | null };
  supplier: { name: string; document: string | null };
  deliverTo: { warehouse: string; address: Address; addressSource: 'warehouse' | 'company' };
  items: { line: number; sku: string; product: string; packaging: string; supplierCode: string | null; packs: number; packCostCents: number; subtotalCents: number }[];
  goodsCents: number;
  freightCents: number;
  otherCostsCents: number;
  totalCents: number;
  expectedAt: string | null;
  message: string | null;
};

/**
 * Monta o documento do pedido de compra a partir da compra atual. So dados da empresa, do deposito, do fornecedor e
 * dos itens: nada do pedido do cliente (nem na compra de encomenda). Faltando dado obrigatorio, devolve a lista.
 */
export async function buildDocument(db: Q, orderId: string, message: string | null = null): Promise<{ document: PurchaseDocument | null; text: string | null; missing: string[] }> {
  const o = (
    await db.query(
      `SELECT o.number, o.expected_at::text AS expected_at, o.freight_cents, o.other_costs_cents, o.supplier_id, s.name AS supplier_name, s.document AS supplier_document,
              w.name AS warehouse_name, w.is_default, w.cep, w.street, w.number AS wnumber, w.complement, w.district, w.city, w.uf, current_date::text AS today
       FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id JOIN warehouses w ON w.id = o.warehouse_id WHERE o.id = $1`,
      [orderId],
    )
  ).rows[0];
  if (!o) throw new AppError(404, 'NOT_FOUND', 'Pedido de compra não encontrado.');
  const items = (
    await db.query<{ sku: string; product: string; label: string; packs: string; pack_cost_cents: string; supplier_sku: string | null }>(
      `SELECT v.sku, p.name AS product, i.packaging_label AS label, (i.packs - i.canceled_packs)::text AS packs, i.pack_cost_cents::text,
              (SELECT sp.supplier_sku FROM supplier_products sp WHERE sp.supplier_id = $2 AND sp.packaging_id = i.packaging_id ORDER BY sp.active DESC LIMIT 1) AS supplier_sku
       FROM purchase_order_items i JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
       WHERE i.order_id = $1 AND i.packs - i.canceled_packs > 0 ORDER BY p.name, v.sku, i.base_qty_per_pack`,
      [orderId, o.supplier_id],
    )
  ).rows;
  const company = await currentCompany(db);
  const missing: string[] = [];
  if (!company?.legal_name) missing.push('Razão social da empresa (Empresa)');
  if (!company?.cnpj) missing.push('CNPJ da empresa (Empresa)');
  const wAddr = { cep: o.cep, street: o.street, number: o.wnumber, complement: o.complement, district: o.district, city: o.city, uf: o.uf };
  let deliverTo: PurchaseDocument['deliverTo'] | null = null;
  if (!missingAddress(wAddr).length) deliverTo = { warehouse: o.warehouse_name, address: pickAddress(wAddr), addressSource: 'warehouse' };
  else if (o.is_default && company && !missingAddress(company).length) deliverTo = { warehouse: o.warehouse_name, address: pickAddress(company), addressSource: 'company' };
  else {
    const what = missingAddress(wAddr).join(', ');
    missing.push(
      o.is_default
        ? `Endereço de entrega: complete o endereço do depósito "${o.warehouse_name}" (Depósitos) ou o endereço da empresa (Empresa). Falta: ${what}`
        : `Endereço do depósito de destino "${o.warehouse_name}" (Depósitos). Falta: ${what}`,
    );
  }
  if (!items.length) missing.push('Ao menos um item com quantidade a pedir');
  if (missing.length) return { document: null, text: null, missing };

  const lines = items.map((it, n) => {
    const packs = Number(it.packs);
    const cost = Number(it.pack_cost_cents);
    return { line: n + 1, sku: it.sku, product: it.product, packaging: it.label, supplierCode: it.supplier_sku, packs, packCostCents: cost, subtotalCents: Math.round(packs * cost) };
  });
  const goods = lines.reduce((a, l) => a + l.subtotalCents, 0);
  const document: PurchaseDocument = {
    schema: 1,
    purchaseNumber: o.number,
    generatedOn: o.today,
    buyer: {
      legalName: company.legal_name,
      tradeName: company.trade_name ?? null,
      cnpj: company.cnpj,
      phone: company.phone ?? null,
      email: company.email ?? null,
      address: missingAddress(company).length ? null : pickAddress(company),
    },
    supplier: { name: o.supplier_name, document: o.supplier_document ?? null },
    deliverTo: deliverTo!,
    items: lines,
    goodsCents: goods,
    freightCents: Number(o.freight_cents),
    otherCostsCents: Number(o.other_costs_cents),
    totalCents: goods + Number(o.freight_cents) + Number(o.other_costs_cents),
    expectedAt: o.expected_at,
    message,
  };
  return { document, text: documentText(document), missing: [] };
}

export function documentText(d: PurchaseDocument) {
  const out = [
    `Pedido de compra nº ${d.purchaseNumber} — ${d.buyer.tradeName ?? d.buyer.legalName}`,
    `${d.buyer.legalName} · CNPJ ${cnpjText(d.buyer.cnpj)}`,
    `Fornecedor: ${d.supplier.name}`,
    `Entregar em: ${d.deliverTo.warehouse} — ${addressText(d.deliverTo.address)}`,
  ];
  if (d.expectedAt) out.push(`Entrega desejada até: ${dateText(d.expectedAt)}`);
  out.push('', 'Itens:');
  for (const l of d.items) {
    out.push(`${l.line}. ${l.product} (${l.sku}) — ${l.packaging}${l.supplierCode ? ` · cód. fornecedor ${l.supplierCode}` : ''}: ${qtyText(l.packs)} × ${brl(l.packCostCents)} = ${brl(l.subtotalCents)}`);
  }
  out.push('', `Mercadoria: ${brl(d.goodsCents)}`);
  if (d.freightCents) out.push(`Frete: ${brl(d.freightCents)}`);
  if (d.otherCostsCents) out.push(`Outras despesas: ${brl(d.otherCostsCents)}`);
  out.push(`Total: ${brl(d.totalCents)}`);
  if (d.message) out.push('', d.message);
  out.push('', 'Por favor, confirme este pedido informando quantidades, preços e prazo de entrega de cada item.');
  const contact = [d.buyer.phone && `telefone ${d.buyer.phone}`, d.buyer.email && `e-mail ${d.buyer.email}`].filter(Boolean).join(', ');
  if (contact) out.push(`Contato: ${contact}.`);
  return out.join('\n');
}

export const documentHash = (d: PurchaseDocument, text: string) => createHash('sha256').update(JSON.stringify(d)).update('\n').update(text).digest('hex');

// ---------------------------------------------------------------------------------------------------------------
// Confirmacao do fornecedor.

export type ConfirmationItemInput = {
  itemId: string;
  outcome: 'confirmed' | 'partial' | 'reduced' | 'refused';
  packs?: string | number | null;
  packCostCents?: number | null;
  promisedAt?: string | null;
  restPromisedAt?: string | null;
  note?: string | null;
};
export type ConfirmationInput = {
  channel: Channel;
  supplierRef?: string | null;
  promisedAt?: string | null;
  note?: string | null;
  items: ConfirmationItemInput[];
};

type ItemRow = { id: string; packaging_label: string; packs: string; received_packs: string; canceled_packs: string; pack_cost_cents: string; base_qty_per_pack: string; pending: string };

async function lockItems(db: Db, orderId: string) {
  return (
    await db.query<ItemRow>(
      `SELECT id, packaging_label, packs::text, received_packs::text, canceled_packs::text, pack_cost_cents::text, base_qty_per_pack::text,
              (packs - received_packs - canceled_packs)::text AS pending
       FROM purchase_order_items WHERE order_id = $1 ORDER BY id FOR UPDATE`,
      [orderId],
    )
  ).rows;
}

const OUTCOME_LABEL = { confirmed: 'confirmado', partial: 'entrega parcial', reduced: 'quantidade reduzida', refused: 'recusado' } as const;

/**
 * Registra a confirmacao (nova versao). Sem aumento de preco acima da tolerancia, aplica na hora. Com aumento, fica
 * aguardando a aprovacao (MFA) e nada muda na compra alem da situacao (o recebimento fica travado). A compra ja deve
 * estar travada (FOR UPDATE) pelo chamador.
 */
export async function registerConfirmation(db: Db, actorId: string, orderId: string, input: ConfirmationInput) {
  const items = await lockItems(db, orderId);
  const byId = new Map(items.map((i) => [i.id, i]));
  const pendingItems = items.filter((i) => Number(i.pending) > 0);
  if (!pendingItems.length) throw new AppError(409, 'NOTHING_PENDING', 'A compra não tem saldo pendente para confirmar.');
  const seen = new Set<string>();
  for (const it of input.items) {
    const row = byId.get(it.itemId);
    if (!row) throw new AppError(422, 'INVALID_ITEM', 'Item não pertence a este pedido.');
    if (Number(row.pending) <= 0) throw new AppError(422, 'INVALID_ITEM', `"${row.packaging_label}" não tem saldo pendente.`);
    if (seen.has(it.itemId)) throw new AppError(422, 'DUPLICATE_ITEM', 'Item repetido na confirmação.');
    seen.add(it.itemId);
  }
  const missingItems = pendingItems.filter((i) => !seen.has(i.id));
  if (missingItems.length) {
    throw new AppError(422, 'CONFIRMATION_ITEMS_REQUIRED', 'Informe o resultado de cada item pendente.', { items: missingItems.map((i) => ({ itemId: i.id, label: i.packaging_label })) });
  }
  const tolerance = Number((await db.query<{ t: string }>('SELECT purchase_price_tolerance_pct::text AS t FROM logistics_settings')).rows[0]!.t);
  // Base da tolerancia: o preco do pedido antes da primeira confirmacao (aumentos pequenos em sequencia somam).
  // Item com aumento ja aprovado: qualquer aumento posterior precisa de nova aprovacao.
  const history = new Map(
    (
      await db.query<{ item_id: string; original: string; approved_increase: boolean }>(
        `SELECT ci.item_id, (array_agg(ci.ordered_pack_cost_cents ORDER BY c.version))[1]::text AS original,
                bool_or(c.status = 'applied' AND c.decided_by IS NOT NULL AND ci.confirmed_pack_cost_cents > ci.ordered_pack_cost_cents) AS approved_increase
         FROM purchase_confirmation_items ci JOIN purchase_confirmations c ON c.id = ci.confirmation_id
         WHERE c.order_id = $1 GROUP BY ci.item_id`,
        [orderId],
      )
    ).rows.map((r) => [r.item_id, r]),
  );
  let increase = 0;
  let needsApproval = false;
  let priceChanged = false;
  let structural = false;
  const lines = input.items.map((it) => {
    const row = byId.get(it.itemId)!;
    const pending = Number(row.pending);
    let packs: number;
    if (it.outcome === 'confirmed') {
      packs = it.packs == null ? pending : Number(it.packs);
      if (packs !== pending) throw new AppError(422, 'INVALID_QUANTITY', `"${row.packaging_label}": confirmado é tudo o que está pendente (${pending}). Para menos, use entrega parcial ou redução.`);
    } else if (it.outcome === 'refused') {
      packs = 0;
    } else {
      packs = Number(it.packs);
      if (!(packs > 0 && packs < pending)) {
        throw new AppError(422, 'INVALID_QUANTITY', `"${row.packaging_label}": informe uma quantidade maior que zero e menor que o pendente (${pending}).`);
      }
    }
    if (it.outcome !== 'partial' && it.restPromisedAt) throw new AppError(422, 'INVALID_DATE', 'Previsão do restante só vale para entrega parcial.');
    const current = Number(row.pack_cost_cents);
    // Recusado: nada vem, entao o preco nao muda.
    const cost = it.outcome === 'refused' ? current : (it.packCostCents ?? current);
    if (cost !== current) priceChanged = true;
    if (it.outcome === 'reduced' || it.outcome === 'refused') structural = true;
    if (cost > current) {
      const h = history.get(row.id);
      const base = h ? Number(h.original) : current;
      const pct = base > 0 ? ((cost - base) / base) * 100 : Infinity;
      if (pct > tolerance + 1e-9 || h?.approved_increase) needsApproval = true;
      // Valor a mais sobre o que ainda vem (reduzido: so a quantidade mantida).
      increase += Math.round((cost - current) * (it.outcome === 'reduced' ? packs : pending));
    }
    return { it, row, pending, packs, cost, current };
  });
  if ((structural || priceChanged) && !input.note && lines.some((l) => (l.it.outcome === 'reduced' || l.it.outcome === 'refused' || l.cost !== l.current) && !l.it.note)) {
    throw new AppError(422, 'NOTE_REQUIRED', 'Redução, recusa ou mudança de preço: informe o motivo (na confirmação ou no item).');
  }
  const outcome = lines.every((l) => l.it.outcome === 'refused')
    ? 'refused'
    : structural || priceChanged
      ? 'changed'
      : lines.some((l) => l.it.outcome === 'partial')
        ? 'partial'
        : 'confirmed';

  // Registro pendente anterior perde o efeito (o novo e o que vale).
  await db.query(`UPDATE purchase_confirmations SET status = 'superseded', decided_at = now() WHERE order_id = $1 AND status = 'pending_approval'`, [orderId]);
  const version = (await db.query<{ v: number }>('SELECT coalesce(max(version), 0)::int + 1 AS v FROM purchase_confirmations WHERE order_id = $1', [orderId])).rows[0]!.v;
  const conf = (
    await db.query<{ id: string }>(
      `INSERT INTO purchase_confirmations (order_id, version, outcome, channel, supplier_ref, promised_at, note, price_increase_cents, status, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [orderId, version, outcome, input.channel, input.supplierRef ?? null, input.promisedAt ?? null, input.note ?? null, increase, needsApproval ? 'pending_approval' : 'applied', actorId],
    )
  ).rows[0]!;
  for (const l of lines) {
    await db.query(
      `INSERT INTO purchase_confirmation_items (confirmation_id, item_id, outcome, pending_packs, confirmed_packs, ordered_pack_cost_cents, confirmed_pack_cost_cents, promised_at, rest_promised_at, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [conf.id, l.row.id, l.it.outcome, l.pending, l.packs, l.current, l.cost, l.it.promisedAt ?? null, l.it.outcome === 'partial' ? (l.it.restPromisedAt ?? null) : null, l.it.note ?? null],
    );
  }
  const summary = lines.map((l) => ({
    itemId: l.row.id,
    label: l.row.packaging_label,
    outcome: l.it.outcome,
    pendingPacks: l.pending,
    confirmedPacks: l.packs,
    fromCents: l.current,
    toCents: l.cost,
    promisedAt: l.it.promisedAt ?? null,
    restPromisedAt: l.it.restPromisedAt ?? null,
  }));
  const data = { confirmationId: conf.id, version, outcome, channel: input.channel, supplierRef: input.supplierRef ?? null, increaseCents: increase, items: summary };
  if (needsApproval) {
    await db.query(`UPDATE purchase_orders SET confirmation_status = 'pending_approval', version = version + 1, updated_at = now() WHERE id = $1`, [orderId]);
    await event(db, orderId, 'confirmation', actorId, input.note ?? null, { ...data, status: 'pending_approval' });
    return { confirmationId: conf.id, version, outcome, status: 'pending_approval' as const, increaseCents: increase, released: [], closed: false, summary };
  }
  await event(db, orderId, 'confirmation', actorId, input.note ?? null, { ...data, status: 'applied' });
  const applied = await applyConfirmation(db, actorId, orderId, conf.id);
  return { confirmationId: conf.id, version, outcome, status: 'applied' as const, increaseCents: increase, ...applied, summary };
}

async function event(db: Db, orderId: string, kind: string, actorId: string, note: string | null, data: Record<string, unknown>) {
  await db.query('INSERT INTO purchase_order_events (order_id, kind, note, data, actor_id) VALUES ($1, $2, $3, $4, $5)', [orderId, kind, note, JSON.stringify(data), actorId]);
}

/**
 * Aplica uma confirmacao na compra: prazos, preco (referencia para o recebimento), saldo cancelado (so reducao e
 * recusa) e liberacao dos vinculos de encomendas que deixam de caber. Entrega parcial nao cancela nem libera nada.
 * Nao mexe em estoque, reserva ou custo medio. Travas: compra (chamador) -> itens -> vinculos.
 */
export async function applyConfirmation(db: Db, actorId: string, orderId: string, confirmationId: string) {
  const conf = (await db.query('SELECT id, version, outcome, supplier_ref, promised_at::text AS promised_at FROM purchase_confirmations WHERE id = $1', [confirmationId])).rows[0];
  const lines = (
    await db.query<{ item_id: string; outcome: string; pending_packs: string; confirmed_packs: string; confirmed_pack_cost_cents: string; promised_at: string | null; rest_promised_at: string | null }>(
      `SELECT item_id, outcome, pending_packs::text, confirmed_packs::text, confirmed_pack_cost_cents::text, promised_at::text, rest_promised_at::text
       FROM purchase_confirmation_items WHERE confirmation_id = $1 ORDER BY item_id`,
      [confirmationId],
    )
  ).rows;
  const items = new Map((await lockItems(db, orderId)).map((i) => [i.id, i]));
  const released: { orderId: string; orderNumber: number; baseQty: string; item: string }[] = [];
  for (const l of lines) {
    const row = items.get(l.item_id)!;
    if (Number(row.pending) !== Number(l.pending_packs)) {
      throw new AppError(409, 'CONFIRMATION_STALE', 'A compra mudou desde o registro da confirmação (recebimento ou outra confirmação). Registre a confirmação de novo.');
    }
    const cancel = l.outcome === 'reduced' ? Number(l.pending_packs) - Number(l.confirmed_packs) : l.outcome === 'refused' ? Number(l.pending_packs) : 0;
    const partial = l.outcome === 'partial';
    await db.query(
      `UPDATE purchase_order_items SET canceled_packs = canceled_packs + $2::numeric, supplier_outcome = $3, promised_at = coalesce($4::date, $5::date),
         partial_packs = CASE WHEN $6 THEN $7::numeric END, partial_from_packs = CASE WHEN $6 THEN received_packs END,
         rest_promised_at = CASE WHEN $6 THEN $8::date END, pack_cost_cents = $9 WHERE id = $1`,
      [l.item_id, cancel, l.outcome, l.promised_at, conf.promised_at, partial, l.confirmed_packs, l.rest_promised_at, l.confirmed_pack_cost_cents],
    );
    if (cancel > 0) {
      const why = l.outcome === 'refused' ? `Fornecedor recusou o item (confirmação v${conf.version})` : `Fornecedor reduziu a quantidade (confirmação v${conf.version})`;
      released.push(...(await releaseLinks(db, actorId, orderId, l.item_id, why)).map((r) => ({ ...r, item: row.packaging_label })));
    }
  }
  const state = (
    await db.query<{ open: boolean; received: boolean }>(
      `SELECT bool_or(received_packs + canceled_packs < packs) AS open, bool_or(received_packs > 0) AS received FROM purchase_order_items WHERE order_id = $1`,
      [orderId],
    )
  ).rows[0]!;
  // Nada mais pendente e algo ja recebido: a compra se encerra (os gatilhos da Fase 6 e 7 fecham vinculos e requisicoes).
  const close = !state.open && state.received;
  await db.query(
    `UPDATE purchase_orders SET confirmation_status = $2, confirmed_at = now(), supplier_ref = coalesce($3, supplier_ref), promised_at = coalesce($4::date, promised_at),
       status = CASE WHEN $5 THEN 'received' ELSE status END, closed_at = CASE WHEN $5 THEN now() ELSE closed_at END, version = version + 1, updated_at = now() WHERE id = $1`,
    [orderId, conf.outcome, conf.supplier_ref, conf.promised_at, close],
  );
  if (close) await event(db, orderId, 'closed_by_confirmation', actorId, null, { confirmationId, version: conf.version });
  return { released, closed: close };
}

/**
 * Reducao ou recusa: os vinculos de encomendas ainda aguardando que nao cabem no que falta chegar sao desfeitos, a
 * partir da menor prioridade (pagamento mais recente). A encomenda volta para a fila e o pedido do cliente mostra a
 * pendencia; nada e cancelado no pedido. A requisicao automatica da encomenda volta a ficar aberta.
 */
async function releaseLinks(db: Db, actorId: string, orderId: string, itemId: string, reason: string) {
  const it = (await db.query<{ remaining: string }>('SELECT ((packs - received_packs - canceled_packs) * base_qty_per_pack)::text AS remaining FROM purchase_order_items WHERE id = $1', [itemId]))
    .rows[0]!;
  const links = (
    await db.query<{ id: string; allocation_id: string; order_id: string; order_number: number; base_qty: string }>(
      `SELECT l.id, l.allocation_id, l.order_id, o.number AS order_number, l.base_qty::text
       FROM purchase_order_links l JOIN orders o ON o.id = l.order_id
       WHERE l.purchase_order_item_id = $1 AND l.status = 'active'
         AND EXISTS (SELECT 1 FROM stock_reservations r WHERE r.allocation_id = l.allocation_id AND r.status = 'active' AND r.backorder)
       ORDER BY o.paid_at DESC NULLS FIRST, o.number DESC, l.id`,
      [itemId],
    )
  ).rows;
  let waiting = links.reduce((a, l) => a + Number(l.base_qty), 0);
  const remaining = Number(it.remaining);
  const out: { orderId: string; orderNumber: number; baseQty: string }[] = [];
  for (const l of links) {
    if (waiting <= remaining + 1e-9) break;
    await db.query(`UPDATE purchase_order_links SET status = 'canceled', closed_at = now(), cancel_reason = $2 WHERE id = $1`, [l.id, reason]);
    waiting -= Number(l.base_qty);
    out.push({ orderId: l.order_id, orderNumber: l.order_number, baseQty: l.base_qty });
    await db.query(
      `WITH r AS (
         UPDATE purchase_requests SET status = 'open', purchase_order_id = NULL, purchase_order_item_id = NULL, updated_at = now()
          WHERE allocation_id = $1 AND status = 'in_purchase' AND purchase_order_id = $2 RETURNING id)
       INSERT INTO purchase_request_events (request_id, kind, note, purchase_order_id, actor_id) SELECT id, 'returned', $3, $2, $4 FROM r`,
      [l.allocation_id, orderId, reason, actorId],
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Requisicoes automaticas para encomendas sem compra (idempotente; roda na rotina de 1 minuto e sob demanda).
// Uma por encomenda (indice unico parcial); recusada pelo comprador nao volta sozinha. Nao gera compra.

const SYNC_LOCK = 7_260_026; // pg_advisory_xact_lock: uma sincronizacao por vez

export async function syncBackorderRequests(db: Db) {
  await db.query('SELECT pg_advisory_xact_lock($1)', [SYNC_LOCK]);
  const awaiting = `EXISTS (SELECT 1 FROM fulfillment_allocations a JOIN fulfillments f ON f.id = a.fulfillment_id
                      WHERE a.id = q.allocation_id AND a.status = 'active' AND f.status = 'confirmed' AND f.mode = 'purchase_to_order'
                        AND EXISTS (SELECT 1 FROM stock_reservations r WHERE r.allocation_id = a.id AND r.status = 'active' AND r.backorder))`;
  const unlinked = `(SELECT a.base_qty - coalesce((SELECT sum(l.base_qty) FROM purchase_order_links l WHERE l.allocation_id = a.id AND l.status = 'active'), 0)
                       FROM fulfillment_allocations a WHERE a.id = q.allocation_id)`;
  const created = (
    await db.query<{ id: string }>(
      `WITH c AS (
         INSERT INTO purchase_requests (source, variant_id, warehouse_id, base_qty, reason, allocation_id, order_id)
         SELECT 'backorder', a.variant_id, a.warehouse_id, x.unlinked, 'Encomenda do pedido nº ' || o.number || ' sem compra vinculada', a.id, a.order_id
         FROM fulfillment_allocations a
         JOIN fulfillments f ON f.id = a.fulfillment_id AND f.status = 'confirmed' AND f.mode = 'purchase_to_order'
         JOIN orders o ON o.id = a.order_id
         CROSS JOIN LATERAL (SELECT a.base_qty - coalesce((SELECT sum(l.base_qty) FROM purchase_order_links l WHERE l.allocation_id = a.id AND l.status = 'active'), 0) AS unlinked) x
         WHERE a.status = 'active' AND x.unlinked > 0
           AND EXISTS (SELECT 1 FROM stock_reservations r WHERE r.allocation_id = a.id AND r.status = 'active' AND r.backorder)
           AND NOT EXISTS (SELECT 1 FROM purchase_requests q WHERE q.allocation_id = a.id AND q.status IN ('open', 'in_purchase', 'rejected'))
         ORDER BY a.id
         ON CONFLICT (allocation_id) WHERE status IN ('open', 'in_purchase') DO NOTHING
         RETURNING id)
       INSERT INTO purchase_request_events (request_id, kind, note) SELECT id, 'created', 'Requisição automática: encomenda sem compra vinculada' FROM c RETURNING request_id AS id`,
    )
  ).rows.length;
  // Aberta, mas a encomenda nao aguarda mais (atendida, desfeita ou pedido cancelado): cancelada.
  const canceled = (
    await db.query(
      `WITH t AS (SELECT q.id FROM purchase_requests q WHERE q.source = 'backorder' AND q.status = 'open' AND NOT ${awaiting} ORDER BY q.id FOR UPDATE),
       u AS (UPDATE purchase_requests q SET status = 'canceled', decision_note = 'Encomenda atendida, desfeita ou cancelada', updated_at = now() FROM t WHERE q.id = t.id RETURNING q.id)
       INSERT INTO purchase_request_events (request_id, kind, note) SELECT id, 'canceled', 'Encomenda atendida, desfeita ou cancelada' FROM u RETURNING request_id`,
    )
  ).rows.length;
  // Aberta e ja toda vinculada a uma compra (vinculo pela tela da compra): em compra, com a compra do vinculo.
  const linked = (
    await db.query(
      `WITH t AS (
         SELECT q.id, l.purchase_order_id, l.purchase_order_item_id FROM purchase_requests q
         CROSS JOIN LATERAL (SELECT purchase_order_id, purchase_order_item_id FROM purchase_order_links WHERE allocation_id = q.allocation_id AND status = 'active'
                             ORDER BY created_at DESC LIMIT 1) l
         WHERE q.source = 'backorder' AND q.status = 'open' AND ${awaiting} AND ${unlinked} <= 0 ORDER BY q.id FOR UPDATE OF q),
       u AS (
         UPDATE purchase_requests q SET status = 'in_purchase', updated_at = now(), purchase_order_id = t.purchase_order_id, purchase_order_item_id = t.purchase_order_item_id
           FROM t WHERE q.id = t.id RETURNING q.id, q.purchase_order_id)
       INSERT INTO purchase_request_events (request_id, kind, note, purchase_order_id) SELECT id, 'in_purchase', 'Encomenda vinculada a uma compra', purchase_order_id FROM u RETURNING request_id`,
    )
  ).rows.length;
  // Em compra, mas o vinculo caiu e a encomenda continua aguardando: volta a ficar aberta.
  const returned = (
    await db.query(
      `WITH t AS (SELECT q.id FROM purchase_requests q WHERE q.source = 'backorder' AND q.status = 'in_purchase' AND ${awaiting} AND ${unlinked} > 0
                    AND NOT EXISTS (SELECT 1 FROM purchase_order_links l WHERE l.allocation_id = q.allocation_id AND l.status = 'active') ORDER BY q.id FOR UPDATE),
       u AS (UPDATE purchase_requests q SET status = 'open', purchase_order_id = NULL, purchase_order_item_id = NULL, updated_at = now() FROM t WHERE q.id = t.id RETURNING q.id)
       INSERT INTO purchase_request_events (request_id, kind, note) SELECT id, 'returned', 'Vínculo com a compra desfeito: a encomenda continua sem compra' FROM u RETURNING request_id`,
    )
  ).rows.length;
  // Em compra e a encomenda ja foi atendida: atendida.
  const done = (
    await db.query(
      `WITH t AS (SELECT q.id FROM purchase_requests q WHERE q.source = 'backorder' AND q.status = 'in_purchase' AND NOT ${awaiting} ORDER BY q.id FOR UPDATE),
       u AS (UPDATE purchase_requests q SET status = 'done', updated_at = now() FROM t WHERE q.id = t.id RETURNING q.id)
       INSERT INTO purchase_request_events (request_id, kind, note) SELECT id, 'done', 'Encomenda atendida' FROM u RETURNING request_id`,
    )
  ).rows.length;
  return { created, canceled, linked, returned, done };
}

// ---------------------------------------------------------------------------------------------------------------
// Situacao do abastecimento (prazos). So compras enviadas acompanhadas pela Fase 7 geram alerta (D7-8): as
// anteriores (confirmation_status 'none') aparecem sem alerta.

export type SupplyCategory =
  | 'untracked'
  | 'awaiting_confirmation'
  | 'confirmation_late'
  | 'price_approval'
  | 'refused'
  | 'delivery_expected'
  | 'delivery_late'
  | 'no_date';

export const CATEGORY_LABEL: Record<SupplyCategory, string> = {
  untracked: 'Anterior ao acompanhamento',
  awaiting_confirmation: 'Aguardando confirmação',
  confirmation_late: 'Confirmação atrasada',
  price_approval: 'Aumento de preço aguardando aprovação',
  refused: 'Recusada pelo fornecedor',
  delivery_expected: 'Entrega prevista',
  delivery_late: 'Entrega atrasada',
  no_date: 'Entrega sem previsão definida',
};

export type SupplyItem = {
  item_id: string;
  order_id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  packaging_label: string;
  pending_packs: string;
  pending_base: string;
  ref_date: string | null;
  late: boolean;
};

export type SupplyOrder = {
  id: string;
  number: number;
  status: string;
  confirmation_status: string;
  supplier_id: string;
  supplier_name: string;
  warehouse_id: string;
  warehouse_name: string;
  sent_at: string | null;
  confirmation_due: string | null;
  expected_at: string | null;
  followup_on: string | null;
  category: SupplyCategory;
  ref_date: string | null;
  days_late: number | null;
  items: SupplyItem[];
};

/**
 * Compras enviadas ou recebidas em parte, com a data de referencia de cada item pendente:
 *   entrega parcial ainda nao chegou  -> prometida da parte
 *   entrega parcial ja chegou         -> previsao do restante (nula = sem previsao)
 *   demais                            -> prometida do item, senao a da confirmacao, senao a previsao da compra
 */
export async function supplyOrders(db: Q, f: { warehouseId?: string | null; orderIds?: string[] | null } = {}): Promise<SupplyOrder[]> {
  const orders = (
    await db.query(
      `SELECT o.id, o.number, o.status, o.confirmation_status, o.supplier_id, s.name AS supplier_name, o.warehouse_id, w.name AS warehouse_name, o.sent_at,
              CASE WHEN o.confirmation_status = 'awaiting' THEN o.sent_at + make_interval(days => ls.purchase_confirmation_days) END AS confirmation_due,
              (o.confirmation_status = 'awaiting' AND o.sent_at + make_interval(days => ls.purchase_confirmation_days) <= now()) AS confirmation_late,
              o.expected_at::text AS expected_at, o.followup_on::text AS followup_on, current_date::text AS today
       FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id JOIN warehouses w ON w.id = o.warehouse_id CROSS JOIN logistics_settings ls
       WHERE o.status IN ('sent', 'partial') AND ($1::uuid IS NULL OR o.warehouse_id = $1) AND ($2::uuid[] IS NULL OR o.id = ANY($2))
       ORDER BY o.number`,
      [f.warehouseId ?? null, f.orderIds ?? null],
    )
  ).rows;
  if (!orders.length) return [];
  const items = (
    await db.query<SupplyItem>(
      `SELECT i.id AS item_id, i.order_id, i.variant_id, v.sku, p.name AS product_name, i.packaging_label,
              (i.packs - i.received_packs - i.canceled_packs)::text AS pending_packs,
              ((i.packs - i.received_packs - i.canceled_packs) * i.base_qty_per_pack)::numeric(14,3)::text AS pending_base,
              (CASE WHEN i.partial_packs IS NOT NULL AND i.received_packs >= i.partial_from_packs + i.partial_packs THEN i.rest_promised_at
                    WHEN i.partial_packs IS NOT NULL THEN i.promised_at
                    ELSE coalesce(i.promised_at, o.promised_at, o.expected_at) END)::text AS ref_date,
              false AS late
       FROM purchase_order_items i JOIN purchase_orders o ON o.id = i.order_id JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
       WHERE i.order_id = ANY($1::uuid[]) AND i.packs - i.received_packs - i.canceled_packs > 0
       ORDER BY p.name, v.sku`,
      [orders.map((o) => o.id)],
    )
  ).rows;
  const today = orders[0].today as string;
  const byOrder = new Map<string, SupplyItem[]>();
  for (const it of items) {
    it.late = !!it.ref_date && it.ref_date < today;
    byOrder.set(it.order_id, [...(byOrder.get(it.order_id) ?? []), it]);
  }
  return orders.map((o) => {
    const its = byOrder.get(o.id) ?? [];
    const dated = its.filter((i) => i.ref_date).map((i) => i.ref_date!).sort();
    const late = its.filter((i) => i.late).map((i) => i.ref_date!).sort();
    let category: SupplyCategory;
    if (o.confirmation_status === 'none') category = 'untracked';
    else if (o.confirmation_status === 'awaiting') category = o.confirmation_late ? 'confirmation_late' : 'awaiting_confirmation';
    else if (o.confirmation_status === 'pending_approval') category = 'price_approval';
    else if (o.confirmation_status === 'refused') category = 'refused';
    else if (late.length) category = 'delivery_late';
    else if (its.some((i) => !i.ref_date)) category = 'no_date';
    else category = 'delivery_expected';
    const ref = category === 'delivery_late' ? late[0]! : (dated[0] ?? null);
    const daysLate = category === 'delivery_late' ? Math.round((Date.parse(today) - Date.parse(ref!)) / 86_400_000) : null;
    const { confirmation_late: _l, today: _t, ...rest } = o;
    return { ...rest, category, ref_date: ref, days_late: daysLate, items: its } as SupplyOrder;
  });
}

/** Contadores do abastecimento (painel inicial e Abastecimento). */
export async function supplyCounts(db: Q, warehouseId: string | null = null) {
  const orders = await supplyOrders(db, { warehouseId });
  const counts: Record<SupplyCategory, number> = {
    untracked: 0,
    awaiting_confirmation: 0,
    confirmation_late: 0,
    price_approval: 0,
    refused: 0,
    delivery_expected: 0,
    delivery_late: 0,
    no_date: 0,
  };
  for (const o of orders) counts[o.category]++;
  const r = (
    await db.query<{ open: number; backorders: number }>(
      `SELECT (SELECT count(*)::int FROM purchase_requests WHERE status = 'open' AND ($1::uuid IS NULL OR warehouse_id = $1)) AS open,
              (SELECT count(*)::int FROM fulfillment_allocations a JOIN fulfillments f ON f.id = a.fulfillment_id AND f.status = 'confirmed' AND f.mode = 'purchase_to_order'
                WHERE a.status = 'active' AND ($1::uuid IS NULL OR a.warehouse_id = $1)
                  AND EXISTS (SELECT 1 FROM stock_reservations r WHERE r.allocation_id = a.id AND r.status = 'active' AND r.backorder)
                  AND a.base_qty > coalesce((SELECT sum(l.base_qty) FROM purchase_order_links l WHERE l.allocation_id = a.id AND l.status = 'active'), 0)) AS backorders`,
      [warehouseId],
    )
  ).rows[0]!;
  return { ...counts, requestsOpen: r.open, backordersWithoutPurchase: r.backorders };
}
