-- Reverte a 0028 (SGLog Fase 9). Recusa, sem alterar nada, quando a Fase 9 ja foi usada: ocorrencia, devolucao,
-- conferencia, quarentena, movimento de devolucao, divergencia C14 em diante, pedido segurado por ocorrencia ou
-- politica de devolucao alterada. Apagar historico para voltar nao e opcao: nesse caso a volta e so do codigo (a 0028
-- e compativel com o codigo anterior).

SET LOCAL lock_timeout = '10s';
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '10 seconds'; tries integer := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE orders IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE stock_movements IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE stock_reconciliations IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE logistics_settings IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE order_events IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF clock_timestamp() > deadline THEN
        RAISE EXCEPTION 'Reversao da 0028: tabelas ocupadas por mais de 10 s (% tentativas); nada foi alterado, tente de novo', tries
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.02);
    END;
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM logistic_occurrences) OR EXISTS (SELECT 1 FROM customer_returns) THEN
    RAISE EXCEPTION 'Reversao da 0028 recusada: ha ocorrencia ou devolucao registrada.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM refund_records) OR EXISTS (SELECT 1 FROM return_fiscal_documents) OR EXISTS (SELECT 1 FROM supplier_returns)
     OR EXISTS (SELECT 1 FROM orders WHERE replacement_for_return_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Reversao da 0028 recusada: ha reembolso, documento fiscal de devolucao, pedido de reposicao ou devolucao ao fornecedor registrado.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_movements WHERE source_type IN ('customer_return', 'supplier_return') OR kind = 'supplier_return') THEN
    RAISE EXCEPTION 'Reversao da 0028 recusada: ha movimento de estoque de devolucao.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM orders WHERE logistics_status = 'on_hold') THEN
    RAISE EXCEPTION 'Reversao da 0028 recusada: ha pedido segurado por ocorrencia.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_reconciliations WHERE check_code IN ('C14', 'C15', 'C16', 'C17', 'C18', 'C19', 'C20', 'C21')
             OR field IN ('returned', 'inspected', 'quarantine', 'refunded', 'refund_record', 'fiscal', 'hold', 'supplier_returned') OR ref_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Reversao da 0028 recusada: ha divergencia C14-C21 registrada na conferencia.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM logistics_settings WHERE return_regret_days IS DISTINCT FROM 7 OR return_defect_days IS DISTINCT FROM 90
             OR return_defect_nondurable_days IS DISTINCT FROM 30 OR return_warranty_days IS NOT NULL OR return_policy_text IS NOT NULL) THEN
    RAISE EXCEPTION 'Reversao da 0028 recusada: a politica de devolucao foi alterada; volte ao padrao antes de reverter.' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

-- Conferencia da 0025.
CREATE OR REPLACE FUNCTION stock_reconcile() RETURNS SETOF stock_reconciliations LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_run uuid := gen_random_uuid(); dflt uuid := (SELECT id FROM warehouses WHERE is_default);
BEGIN
  WITH o AS (SELECT * FROM stock_opening_balances),
  mv AS (
    SELECT m.variant_id, sum(m.on_hand_delta) AS d_on, sum(m.reserved_delta) AS d_res, sum(m.blocked_delta) AS d_blk,
           sum(m.damaged_delta) AS d_dmg, sum(m.in_transit_delta) AS d_trn, max(m.id) AS last_id
    FROM stock_movements m LEFT JOIN o ON o.variant_id = m.variant_id
    WHERE o.variant_id IS NULL OR m.id > coalesce(o.last_movement_id, 0)
    GROUP BY m.variant_id
  ),
  loc AS (
    SELECT l.variant_id, sum(l.on_hand) AS on_hand, sum(l.reserved) AS reserved, sum(l.blocked) AS blocked,
           sum(l.damaged) AS damaged, sum(l.in_transit) AS in_transit
    FROM stock_location_balances l GROUP BY l.variant_id
  ),
  res AS (SELECT r.variant_id, sum(r.qty) AS qty FROM stock_reservations r WHERE r.status = 'active' GROUP BY r.variant_id),
  pend AS (
    SELECT i.variant_id, sum(i.qty_sent - i.qty_received - i.qty_lost - i.qty_returned) AS qty
    FROM stock_transfer_items i JOIN stock_transfers t ON t.id = i.transfer_id
    WHERE t.status IN ('in_transit', 'partial') GROUP BY i.variant_id
  ),
  vars AS (
    SELECT b.variant_id FROM stock_balances b UNION SELECT mv.variant_id FROM mv
    UNION SELECT o.variant_id FROM o UNION SELECT loc.variant_id FROM loc UNION SELECT res.variant_id FROM res
    UNION SELECT pend.variant_id FROM pend
  ),
  base AS (
    SELECT v.variant_id, o.variant_id IS NOT NULL AS has_open,
           coalesce(b.on_hand, 0) AS b_on, coalesce(b.reserved, 0) AS b_res,
           coalesce(b.blocked, 0) AS b_blk, coalesce(b.damaged, 0) AS b_dmg, coalesce(b.in_transit, 0) AS b_trn,
           coalesce(o.on_hand, 0) + coalesce(mv.d_on, 0) AS exp_on, coalesce(o.reserved, 0) + coalesce(mv.d_res, 0) AS exp_res,
           coalesce(mv.d_blk, 0) AS exp_blk, coalesce(mv.d_dmg, 0) AS exp_dmg, coalesce(mv.d_trn, 0) AS exp_trn,
           coalesce(loc.on_hand, 0) AS l_on, coalesce(loc.reserved, 0) AS l_res,
           coalesce(loc.blocked, 0) AS l_blk, coalesce(loc.damaged, 0) AS l_dmg, coalesce(loc.in_transit, 0) AS l_trn,
           lm.on_hand_after, lm.reserved_after, lm.blocked_after, lm.damaged_after, lm.in_transit_after,
           coalesce(res.qty, 0) + coalesce(o.reserved - o.reservations_active, 0) AS exp_res_c4,
           coalesce(pend.qty, 0) AS exp_trn_c6
    FROM vars v
    LEFT JOIN stock_balances b ON b.variant_id = v.variant_id
    LEFT JOIN o ON o.variant_id = v.variant_id
    LEFT JOIN mv ON mv.variant_id = v.variant_id
    LEFT JOIN stock_movements lm ON lm.id = mv.last_id
    LEFT JOIN loc ON loc.variant_id = v.variant_id
    LEFT JOIN res ON res.variant_id = v.variant_id
    LEFT JOIN pend ON pend.variant_id = v.variant_id
  ),
  rev AS (
    SELECT r.variant_id, f.field, -f.orig AS exp_v, f.got AS got_v
    FROM stock_movements r JOIN stock_movements m ON m.id = r.reverses_id
    CROSS JOIN LATERAL (VALUES ('on_hand', m.on_hand_delta, r.on_hand_delta), ('reserved', m.reserved_delta, r.reserved_delta),
                               ('blocked', m.blocked_delta, r.blocked_delta), ('damaged', m.damaged_delta, r.damaged_delta),
                               ('in_transit', m.in_transit_delta, r.in_transit_delta)) AS f(field, orig, got)
    WHERE r.kind = 'reversal' AND f.got <> -f.orig
  ),
  res_wh AS (
    SELECT coalesce(r.warehouse_id, dflt) AS warehouse_id, r.variant_id, sum(r.qty) AS qty
    FROM stock_reservations r WHERE r.status = 'active' GROUP BY 1, 2
  ),
  c8 AS (
    SELECT coalesce(l.warehouse_id, rw.warehouse_id) AS warehouse_id, coalesce(l.variant_id, rw.variant_id) AS variant_id,
           coalesce(rw.qty, 0) + CASE WHEN coalesce(l.warehouse_id, rw.warehouse_id) = dflt
                                      THEN coalesce((SELECT o.reserved - o.reservations_active FROM o WHERE o.variant_id = coalesce(l.variant_id, rw.variant_id)), 0)
                                      ELSE 0 END AS expected,
           coalesce(l.reserved, 0) AS got
    FROM stock_location_balances l FULL JOIN res_wh rw ON rw.warehouse_id = l.warehouse_id AND rw.variant_id = l.variant_id
  ),
  -- Ja despachado por alocacao (remessas novas que sairam do deposito).
  sent AS (
    SELECT i.allocation_id, sum(i.base_qty) AS qty
    FROM shipment_items i JOIN shipments s ON s.id = i.shipment_id
    WHERE i.status = 'active' AND s.status IN ('shipped', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'returned')
    GROUP BY i.allocation_id
  ),
  alloc AS (
    SELECT a.id, a.variant_id, a.warehouse_id, a.base_qty - coalesce(sent.qty, 0) AS qty
    FROM fulfillment_allocations a JOIN fulfillments f ON f.id = a.fulfillment_id LEFT JOIN sent ON sent.allocation_id = a.id
    WHERE a.status = 'active' AND f.status = 'confirmed' AND f.mode IN ('stock', 'purchase_to_order')
  ),
  c9 AS (
    SELECT coalesce(al.variant_id, r.variant_id) AS variant_id, coalesce(al.warehouse_id, r.warehouse_id) AS warehouse_id,
           coalesce(al.qty, 0) AS expected, coalesce(r.qty, 0) AS got
    FROM (SELECT * FROM alloc WHERE qty > 0) al
    FULL JOIN (SELECT * FROM stock_reservations WHERE status = 'active' AND allocation_id IS NOT NULL) r ON r.allocation_id = al.id
    WHERE al.id IS NULL OR r.id IS NULL OR r.qty <> al.qty OR r.warehouse_id IS DISTINCT FROM al.warehouse_id
  ),
  c10 AS (
    SELECT s.id AS shipment_id, i.variant_id, s.warehouse_id, sum(i.base_qty) AS expected,
           coalesce((SELECT -sum(m.on_hand_delta) FROM stock_movements m
                      WHERE m.kind = 'sale' AND m.document_ref = s.id::text AND m.variant_id = i.variant_id), 0) AS got
    FROM shipments s JOIN shipment_items i ON i.shipment_id = s.id AND i.status = 'active'
    WHERE s.kind <> 'legacy' AND s.status IN ('shipped', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'returned')
    GROUP BY s.id, i.variant_id, s.warehouse_id
  ),
  logs AS (
    SELECT c.shipment_item_id,
           sum(CASE c.kind WHEN 'pick' THEN c.qty WHEN 'unpick' THEN -c.qty ELSE 0 END) AS picked,
           sum(CASE c.kind WHEN 'check' THEN c.qty WHEN 'check_undo' THEN -c.qty ELSE 0 END) AS checked
    FROM shipment_checks c WHERE c.shipment_item_id IS NOT NULL GROUP BY c.shipment_item_id
  ),
  c11_log AS (
    SELECT i.variant_id, s.warehouse_id, f.field, f.exp_v, f.got_v
    FROM shipment_items i JOIN shipments s ON s.id = i.shipment_id LEFT JOIN logs l ON l.shipment_item_id = i.id
    CROSS JOIN LATERAL (VALUES ('picked', coalesce(l.picked, 0), i.picked_qty), ('checked', coalesce(l.checked, 0), i.checked_qty)) AS f(field, exp_v, got_v)
    WHERE s.kind <> 'legacy' AND f.exp_v <> f.got_v
  ),
  c11_res AS (
    SELECT i.allocation_id, min(i.variant_id::text)::uuid AS variant_id, min(s.warehouse_id::text)::uuid AS warehouse_id, sum(i.base_qty) AS open_qty,
           coalesce((SELECT sum(r.qty) FROM stock_reservations r WHERE r.allocation_id = i.allocation_id AND r.status = 'active'), 0) AS reserved
    FROM shipment_items i JOIN shipments s ON s.id = i.shipment_id
    WHERE i.status = 'active' AND s.status IN ('pending', 'picking', 'checking', 'packed')
    GROUP BY i.allocation_id
  ),
  -- C12: recebimento x movimentos (entrada e recusa) e item da compra x linhas dos recebimentos.
  rcpt AS (
    SELECT r.id::text AS receipt_id, coalesce(r.warehouse_id, dflt) AS warehouse_id, i.variant_id,
           sum(ri.base_qty) AS received, sum(ri.rejected_base_qty) AS rejected
    FROM purchase_receipts r JOIN purchase_receipt_items ri ON ri.receipt_id = r.id JOIN purchase_order_items i ON i.id = ri.item_id
    GROUP BY r.id, coalesce(r.warehouse_id, dflt), i.variant_id
  ),
  rcpt_mv AS (
    SELECT m.source_id AS receipt_id, m.variant_id,
           sum(m.on_hand_delta) FILTER (WHERE m.kind = 'receipt') AS received,
           sum(m.blocked_delta + m.damaged_delta) FILTER (WHERE m.kind IN ('block', 'damage_hold')) AS rejected
    FROM stock_movements m WHERE m.source_type = 'purchase_receipt' GROUP BY m.source_id, m.variant_id
  ),
  c12 AS (
    SELECT coalesce(rc.variant_id, mv.variant_id) AS variant_id, rc.warehouse_id, f.field, f.exp_v, f.got_v
    FROM rcpt rc FULL JOIN rcpt_mv mv ON mv.receipt_id = rc.receipt_id AND mv.variant_id = rc.variant_id
    CROSS JOIN LATERAL (VALUES ('received', coalesce(rc.received, 0), coalesce(mv.received, 0)),
                               ('rejected', coalesce(rc.rejected, 0), coalesce(mv.rejected, 0))) AS f(field, exp_v, got_v)
    WHERE f.exp_v <> f.got_v
  ),
  c12_item AS (
    SELECT i.variant_id, po.warehouse_id, f.field, f.exp_v, f.got_v
    FROM purchase_order_items i JOIN purchase_orders po ON po.id = i.order_id
    LEFT JOIN (SELECT item_id, sum(packs) AS packs, sum(rejected_packs) AS rej FROM purchase_receipt_items GROUP BY item_id) s ON s.item_id = i.id
    CROSS JOIN LATERAL (VALUES ('received', coalesce(s.packs, 0), i.received_packs), ('rejected', coalesce(s.rej, 0), i.rejected_packs)) AS f(field, exp_v, got_v)
    WHERE f.exp_v <> f.got_v
  ),
  -- C13: vinculos ativos dentro dos tetos; reserva convertida e ativa continua firme.
  c13_item AS (
    SELECT i.variant_id, po.warehouse_id, i.packs * i.base_qty_per_pack AS exp_v, sum(l.base_qty) AS got_v
    FROM purchase_order_links l JOIN purchase_order_items i ON i.id = l.purchase_order_item_id JOIN purchase_orders po ON po.id = i.order_id
    WHERE l.status = 'active' GROUP BY i.id, i.variant_id, po.warehouse_id, i.packs, i.base_qty_per_pack
    HAVING sum(l.base_qty) > i.packs * i.base_qty_per_pack
  ),
  c13_alloc AS (
    SELECT a.variant_id, a.warehouse_id, a.base_qty AS exp_v, sum(l.base_qty) AS got_v
    FROM purchase_order_links l JOIN fulfillment_allocations a ON a.id = l.allocation_id
    WHERE l.status = 'active' GROUP BY a.id, a.variant_id, a.warehouse_id, a.base_qty HAVING sum(l.base_qty) > a.base_qty
  ),
  c13_conv AS (
    SELECT c.variant_id, c.warehouse_id, c.qty AS exp_v, 0::numeric AS got_v
    FROM reservation_conversions c JOIN stock_reservations r ON r.id = c.reservation_id
    WHERE r.status = 'active' AND r.backorder
  ),
  divs AS (
    SELECT CASE WHEN has_open THEN 'C1' ELSE 'C5' END AS code, 'on_hand' AS field, variant_id, NULL::uuid AS warehouse_id, exp_on AS expected, b_on AS found FROM base WHERE exp_on <> b_on
    UNION ALL SELECT CASE WHEN has_open THEN 'C1' ELSE 'C5' END, 'reserved', variant_id, NULL, exp_res, b_res FROM base WHERE exp_res <> b_res
    UNION ALL SELECT CASE WHEN has_open THEN 'C1' ELSE 'C5' END, 'blocked', variant_id, NULL, exp_blk, b_blk FROM base WHERE exp_blk <> b_blk
    UNION ALL SELECT CASE WHEN has_open THEN 'C1' ELSE 'C5' END, 'damaged', variant_id, NULL, exp_dmg, b_dmg FROM base WHERE exp_dmg <> b_dmg
    UNION ALL SELECT CASE WHEN has_open THEN 'C1' ELSE 'C5' END, 'in_transit', variant_id, NULL, exp_trn, b_trn FROM base WHERE exp_trn <> b_trn
    UNION ALL SELECT 'C2', 'on_hand', variant_id, NULL, b_on, l_on FROM base WHERE b_on <> l_on
    UNION ALL SELECT 'C2', 'reserved', variant_id, NULL, b_res, l_res FROM base WHERE b_res <> l_res
    UNION ALL SELECT 'C2', 'blocked', variant_id, NULL, b_blk, l_blk FROM base WHERE b_blk <> l_blk
    UNION ALL SELECT 'C2', 'damaged', variant_id, NULL, b_dmg, l_dmg FROM base WHERE b_dmg <> l_dmg
    UNION ALL SELECT 'C2', 'in_transit', variant_id, NULL, b_trn, l_trn FROM base WHERE b_trn <> l_trn
    UNION ALL SELECT 'C3', 'on_hand', variant_id, NULL, on_hand_after, b_on FROM base WHERE on_hand_after IS NOT NULL AND on_hand_after <> b_on
    UNION ALL SELECT 'C3', 'reserved', variant_id, NULL, reserved_after, b_res FROM base WHERE reserved_after IS NOT NULL AND reserved_after <> b_res
    UNION ALL SELECT 'C3', 'blocked', variant_id, NULL, blocked_after, b_blk FROM base WHERE blocked_after IS NOT NULL AND blocked_after <> b_blk
    UNION ALL SELECT 'C3', 'damaged', variant_id, NULL, damaged_after, b_dmg FROM base WHERE damaged_after IS NOT NULL AND damaged_after <> b_dmg
    UNION ALL SELECT 'C3', 'in_transit', variant_id, NULL, in_transit_after, b_trn FROM base WHERE in_transit_after IS NOT NULL AND in_transit_after <> b_trn
    UNION ALL SELECT 'C4', 'reserved', variant_id, NULL, exp_res_c4, b_res FROM base WHERE exp_res_c4 <> b_res
    UNION ALL SELECT 'C6', 'in_transit', variant_id, NULL, exp_trn_c6, b_trn FROM base WHERE exp_trn_c6 <> b_trn
    UNION ALL SELECT 'C7', field, variant_id, NULL, exp_v, got_v FROM rev
    UNION ALL SELECT 'C8', 'reserved', variant_id, warehouse_id, expected, got FROM c8 WHERE expected <> got
    UNION ALL SELECT 'C9', 'reserved', variant_id, warehouse_id, expected, got FROM c9
    UNION ALL SELECT 'C10', 'shipped', variant_id, warehouse_id, expected, got FROM c10 WHERE expected <> got
    UNION ALL SELECT 'C11', field, variant_id, warehouse_id, exp_v, got_v FROM c11_log
    UNION ALL SELECT 'C11', 'reserved', variant_id, warehouse_id, open_qty, reserved FROM c11_res WHERE open_qty > reserved
    UNION ALL SELECT 'C12', field, variant_id, warehouse_id, exp_v, got_v FROM c12
    UNION ALL SELECT 'C12', field, variant_id, warehouse_id, exp_v, got_v FROM c12_item
    UNION ALL SELECT 'C13', 'linked', variant_id, warehouse_id, exp_v, got_v FROM c13_item
    UNION ALL SELECT 'C13', 'linked', variant_id, warehouse_id, exp_v, got_v FROM c13_alloc
    UNION ALL SELECT 'C13', 'converted', variant_id, warehouse_id, exp_v, got_v FROM c13_conv
  ),
  ins AS (
    INSERT INTO stock_reconciliations (run_id, check_code, field, variant_id, warehouse_id, expected, found, created_by)
    SELECT v_run, d.code, d.field, d.variant_id, d.warehouse_id, d.expected, d.found, app_user_id() FROM divs d
    RETURNING 1
  )
  INSERT INTO stock_reconciliations (run_id, check_code, expected, found, created_by)
  SELECT v_run, 'run', (SELECT count(*) FROM base), (SELECT count(*) FROM ins), app_user_id();

  RETURN QUERY SELECT * FROM stock_reconciliations WHERE run_id = v_run ORDER BY id;
END $$;
REVOKE ALL ON FUNCTION stock_reconcile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stock_reconcile() TO loja_app;

ALTER TABLE stock_reconciliations DROP CONSTRAINT stock_reconciliations_check_code_check;
ALTER TABLE stock_reconciliations ADD CONSTRAINT stock_reconciliations_check_code_check
  CHECK (check_code IN ('run', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12', 'C13'));
ALTER TABLE stock_reconciliations DROP CONSTRAINT stock_reconciliations_field_check;
ALTER TABLE stock_reconciliations ADD CONSTRAINT stock_reconciliations_field_check
  CHECK (field IN ('on_hand', 'reserved', 'blocked', 'damaged', 'in_transit', 'shipped', 'picked', 'checked', 'received', 'rejected', 'linked', 'converted'));
ALTER TABLE stock_reconciliations DROP COLUMN ref_id;

-- Estorno da 0022.
CREATE OR REPLACE FUNCTION stock_movements_reversal_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o stock_movements; dflt uuid := (SELECT id FROM warehouses WHERE is_default);
BEGIN
  SELECT * INTO o FROM stock_movements WHERE id = NEW.reverses_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'estorno de movimento inexistente' USING ERRCODE = 'restrict_violation', CONSTRAINT = 'stock_movements_reversal_target';
  END IF;
  IF o.kind = 'transfer_out' THEN
    IF NEW.transfer_id IS DISTINCT FROM o.transfer_id THEN
      RAISE EXCEPTION 'estorno de transferencia com outra transferencia' USING ERRCODE = 'restrict_violation', CONSTRAINT = 'stock_movements_reversal_target';
    END IF;
  ELSIF o.kind NOT IN ('adjustment', 'loss', 'damage', 'return', 'block', 'unblock', 'damage_hold', 'damage_release')
     OR o.source_type NOT IN ('manual', 'adjustment_request') THEN
    RAISE EXCEPTION 'movimento do tipo % nao pode ser estornado', o.kind USING ERRCODE = 'restrict_violation', CONSTRAINT = 'stock_movements_reversal_target';
  END IF;
  IF o.variant_id <> NEW.variant_id OR coalesce(o.warehouse_id, dflt) <> coalesce(NEW.warehouse_id, dflt)
     OR NEW.on_hand_delta <> -o.on_hand_delta OR NEW.reserved_delta <> -o.reserved_delta OR NEW.blocked_delta <> -o.blocked_delta
     OR NEW.damaged_delta <> -o.damaged_delta OR NEW.in_transit_delta <> -o.in_transit_delta THEN
    RAISE EXCEPTION 'estorno diferente do movimento original' USING ERRCODE = 'restrict_violation', CONSTRAINT = 'stock_movements_reversal_target';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_supplier_return;
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_kind_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check CHECK (kind IN (
  'receipt', 'sale', 'return', 'loss', 'damage', 'adjustment', 'inventory', 'reserve', 'release',
  'transfer_out', 'transfer_in', 'transfer_loss', 'transfer_return', 'block', 'unblock', 'damage_hold', 'damage_release', 'reversal'));
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_source_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_source_type_check
  CHECK (source_type IN ('purchase_receipt', 'order', 'cart', 'quote', 'inventory', 'manual', 'reservation', 'transfer', 'adjustment_request'));

DROP TRIGGER orders_occurrence_hold ON orders;
DROP FUNCTION orders_occurrence_hold();
ALTER TABLE orders DROP CONSTRAINT orders_logistics_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_logistics_status_check CHECK (logistics_status IN (
  'awaiting', 'analysis', 'processing', 'partially_shipped', 'shipped', 'partially_delivered', 'completed', 'canceled'));

DROP TABLE supplier_return_events;
DROP TABLE supplier_return_items;
DROP TABLE supplier_returns;
ALTER TABLE orders DROP CONSTRAINT orders_total_cents_check;
ALTER TABLE orders ADD CONSTRAINT orders_total_cents_check CHECK (total_cents > 0);
DROP INDEX orders_replacement_once;
ALTER TABLE orders DROP COLUMN replacement_for_return_id;
DROP TABLE return_fiscal_documents;
DROP TABLE refund_events;
DROP TABLE refund_records;
DROP FUNCTION refund_records_check();
DROP INDEX logistic_occurrences_payment_once;
ALTER TABLE order_events DROP COLUMN internal;
DROP TABLE return_events;
DROP TABLE quarantine_decisions;
DROP FUNCTION quarantine_decisions_check();
DROP TABLE return_inspections;
DROP FUNCTION return_inspections_check();
DROP TABLE customer_return_items;
DROP FUNCTION customer_return_items_check();
DROP FUNCTION order_item_out_qty(uuid, boolean);
DROP TABLE customer_returns;
DROP TABLE occurrence_events;
DROP TABLE logistic_occurrences;
ALTER TABLE logistics_settings DROP COLUMN return_regret_days, DROP COLUMN return_defect_days, DROP COLUMN return_defect_nondurable_days,
  DROP COLUMN return_warranty_days, DROP COLUMN return_policy_text, DROP COLUMN returns_since;
