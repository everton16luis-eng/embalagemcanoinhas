// SGLog Fase 9 (docs/38-sglog-fase9.md): regras compartilhadas de ocorrencias e devolucoes.
import type { Db } from '../db/pool.js';

export const OCCURRENCE_KINDS = ['damaged', 'lost', 'late', 'refused', 'wrong_item', 'regret', 'defect', 'exchange', 'refund', 'reverse', 'delivery_failed', 'other'] as const;
export const RESPONSIBILITIES = ['company', 'supplier', 'carrier', 'customer', 'undetermined'] as const;
export const OPEN_OCCURRENCE = ['open', 'in_progress'] as const;

/**
 * Pedido entregue segurado por ocorrencia ('on_hold'): conclui quando nao sobra ocorrencia aberta que segure a
 * conclusao. O gatilho orders_occurrence_hold confere de novo no banco.
 */
export async function releaseHold(db: Db, orderId: string) {
  await db.query(
    `UPDATE orders SET logistics_status = 'completed', logistics_note = NULL, logistics_version = logistics_version + 1, updated_at = now(), version = version + 1
     WHERE id = $1 AND logistics_status = 'on_hold' AND status = 'delivered'
       AND NOT EXISTS (SELECT 1 FROM logistic_occurrences WHERE order_id = $1 AND blocks_completion AND status IN ('open', 'in_progress'))`,
    [orderId],
  );
}

/**
 * Aviso de rastreio (falha na entrega ou devolucao ao remetente, D9-11): abre no maximo uma ocorrencia por remessa e
 * tipo. Repetido, atrasado ou fora de ordem so entra no historico da ocorrencia que ja existe. Nunca movimenta
 * estoque, nunca registra reembolso e nunca toca a NF-e. Chamar na transacao do evento, com a remessa travada.
 */
export async function trackingOccurrence(db: Db, e: { orderId: string; shipmentId: string; status: 'delivery_failed' | 'returned'; eventId: string; note: string }) {
  const kind = e.status === 'delivery_failed' ? 'delivery_failed' : 'refused';
  const description = e.status === 'delivery_failed' ? 'Falha na entrega informada pelo rastreio.' : 'Mercadoria devolvida ao remetente, informada pelo rastreio.';
  const ins = await db.query<{ id: string }>(
    `INSERT INTO logistic_occurrences (order_id, shipment_id, kind, source, tracking_event_id, description)
     VALUES ($1, $2, $3, 'tracking', $4, $5)
     ON CONFLICT (shipment_id, kind) WHERE source = 'tracking' DO NOTHING RETURNING id`,
    [e.orderId, e.shipmentId, kind, e.eventId, description],
  );
  if (ins.rows[0]) {
    await db.query(`INSERT INTO occurrence_events (occurrence_id, action, to_status, note) VALUES ($1, 'open', 'open', $2)`, [ins.rows[0].id, e.note.slice(0, 1000)]);
    return { occurrenceId: ins.rows[0].id, opened: true };
  }
  const cur = (await db.query<{ id: string; status: string }>(`SELECT id, status FROM logistic_occurrences WHERE shipment_id = $1 AND kind = $2 AND source = 'tracking'`, [e.shipmentId, kind])).rows[0]!;
  await db.query(`INSERT INTO occurrence_events (occurrence_id, action, from_status, to_status, note) VALUES ($1, 'tracking', $2, $2, $3)`, [
    cur.id,
    cur.status,
    `Novo aviso do rastreio (não abre outra ocorrência): ${e.note}`.slice(0, 1000),
  ]);
  return { occurrenceId: cur.id, opened: false };
}

/**
 * Pagamento devolvido ou contestado no provedor (Fase 9b): abre no maximo UMA ocorrencia de reembolso por pedido
 * (indice unico); aviso repetido so entra no historico. Nao segura a conclusao, nao registra reembolso, nao mexe no
 * estoque nem na NF-e: o reembolso e registrado por quem tem refunds.record, depois de conferir.
 */
export async function paymentOccurrence(db: Db, orderId: string, status: 'refunded' | 'charged_back') {
  const description = status === 'refunded' ? 'Pagamento devolvido ao cliente no provedor: conferir e registrar o reembolso.' : 'Contestação (chargeback) aberta pelo cliente no provedor.';
  const ins = await db.query<{ id: string }>(
    `INSERT INTO logistic_occurrences (order_id, kind, source, description, blocks_completion)
     VALUES ($1, 'refund', 'payment', $2, false)
     ON CONFLICT (order_id) WHERE source = 'payment' DO NOTHING RETURNING id`,
    [orderId, description],
  );
  if (ins.rows[0]) {
    await db.query(`INSERT INTO occurrence_events (occurrence_id, action, to_status, note) VALUES ($1, 'open', 'open', $2)`, [ins.rows[0].id, description]);
    return { occurrenceId: ins.rows[0].id, opened: true };
  }
  const cur = (await db.query<{ id: string; status: string }>(`SELECT id, status FROM logistic_occurrences WHERE order_id = $1 AND source = 'payment'`, [orderId])).rows[0]!;
  await db.query(`INSERT INTO occurrence_events (occurrence_id, action, from_status, to_status, note) VALUES ($1, 'payment', $2, $2, $3)`, [cur.id, cur.status, `Novo aviso do pagamento: ${description}`]);
  return { occurrenceId: cur.id, opened: false };
}

/**
 * Custo historico da saida (D9-3): media ponderada do custo medio gravado nos movimentos de venda do pedido e da
 * variante (a venda nao muda a media, entao avg_cost_after e o custo com que a mercadoria saiu). Sem venda
 * registrada, ou venda com custo zero (estoque que entrou sem custo, ou seja, custo desconhecido): null. A entrada usa
 * o custo medio atual e nao mexe nele, em vez de puxar a media para baixo com um zero que nao e custo.
 */
export async function saleUnitCost(db: Db, orderId: string, variantId: string): Promise<string | null> {
  const r = (
    await db.query<{ cost: string | null }>(
      `SELECT CASE WHEN sum(-on_hand_delta) > 0 THEN round(sum(-on_hand_delta * avg_cost_after) / sum(-on_hand_delta), 4)::text END AS cost
       FROM stock_movements WHERE kind = 'sale' AND source_type = 'order' AND source_id = $1 AND variant_id = $2 AND on_hand_delta < 0`,
      [orderId, variantId],
    )
  ).rows[0];
  return r?.cost && Number(r.cost) > 0 ? r.cost : null;
}
