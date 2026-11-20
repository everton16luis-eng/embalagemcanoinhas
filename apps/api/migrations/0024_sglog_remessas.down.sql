-- Reverte a 0024 (SGLog Fase 5). Recusa, sem alterar nada, quando alguma remessa nova ja passou da situacao
-- pendente (separacao, conferencia, despacho), quando ha historico de separacao/conferencia ou divergencia C10/C11
-- registrada: apagar historico para voltar nao e opcao (a volta, nesse caso, e so do codigo ou por backup com
-- autorizacao expressa). Remessas pendentes ou canceladas criadas pela Fase 5 sao removidas.

SET LOCAL lock_timeout = '10s';
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '10 seconds'; tries integer := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE orders IN SHARE ROW EXCLUSIVE MODE;
      LOCK TABLE shipments IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE whatsapp_messages IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE stock_reconciliations IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE logistics_settings IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF clock_timestamp() > deadline THEN
        RAISE EXCEPTION 'Reversao da 0024: tabelas ocupadas por mais de 10 s (% tentativas); nada foi alterado, tente de novo', tries
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.02);
    END;
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM shipments WHERE kind <> 'legacy' AND status NOT IN ('pending', 'canceled')) THEN
    RAISE EXCEPTION 'Reversao da 0024 recusada: ha remessa nova em separacao, conferencia ou ja despachada.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM shipment_checks) THEN
    RAISE EXCEPTION 'Reversao da 0024 recusada: ha historico de separacao ou conferencia.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_reconciliations WHERE check_code IN ('C10', 'C11') OR field IN ('shipped', 'picked', 'checked')) THEN
    RAISE EXCEPTION 'Reversao da 0024 recusada: ha divergencia C10/C11 registrada na conferencia.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM logistics_settings WHERE multi_shipment_status <> 'blocked') THEN
    RAISE EXCEPTION 'Reversao da 0024 recusada: remessas multiplas foram liberadas; bloqueie antes de reverter.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_messages w JOIN shipments s ON s.id = w.shipment_id WHERE s.kind <> 'legacy') THEN
    RAISE EXCEPTION 'Reversao da 0024 recusada: ha aviso de WhatsApp ligado a remessa nova.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM shipments WHERE kind = 'legacy' GROUP BY order_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Reversao da 0024 recusada: ha pedido com mais de uma remessa antiga.' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

-- Funcoes e CHECKs da 0023.
CREATE OR REPLACE FUNCTION orders_logistics_project() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'paid' THEN
      NEW.logistics_status := 'awaiting';
      NEW.allocation_required := true;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NEW.status = 'paid' AND NEW.logistics_status IS NULL THEN
    NEW.logistics_status := 'awaiting';
    NEW.allocation_required := true;
  ELSIF NEW.status = 'shipped' THEN
    NEW.logistics_status := 'shipped';
  ELSIF NEW.status = 'delivered' THEN
    NEW.logistics_status := 'completed';
  ELSIF NEW.status = 'canceled' AND NEW.logistics_status IS NOT NULL THEN
    NEW.logistics_status := 'canceled';
  ELSE
    RETURN NEW;
  END IF;
  NEW.logistics_note := NULL;
  NEW.logistics_version := OLD.logistics_version + 1;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION orders_logistics_close() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  IF NEW.status = 'canceled' THEN
    UPDATE fulfillment_allocations a SET status = 'canceled', canceled_at = now()
      FROM fulfillments f WHERE f.id = a.fulfillment_id AND f.order_id = NEW.id AND f.status = 'confirmed' AND a.status = 'active';
    UPDATE fulfillments SET status = 'canceled', closed_at = now(), cancel_reason = 'Pedido cancelado'
     WHERE order_id = NEW.id AND status = 'confirmed';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      INSERT INTO allocation_decisions (order_id, kind, chosen, actor_id)
      VALUES (NEW.id, 'order_canceled', jsonb_build_object('fulfillments', n, 'reason', NEW.cancel_reason), app_user_id());
    END IF;
  ELSIF NEW.status = 'shipped' THEN
    UPDATE fulfillments SET status = 'done', closed_at = now() WHERE order_id = NEW.id AND status = 'confirmed';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      INSERT INTO allocation_decisions (order_id, kind, chosen, actor_id) VALUES (NEW.id, 'shipped', jsonb_build_object('fulfillments', n), app_user_id());
    END IF;
  END IF;
  RETURN NULL;
END $$;

ALTER TABLE stock_reconciliations DROP CONSTRAINT stock_reconciliations_check_code_check;
ALTER TABLE stock_reconciliations ADD CONSTRAINT stock_reconciliations_check_code_check
  CHECK (check_code IN ('run', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'));
ALTER TABLE stock_reconciliations DROP CONSTRAINT stock_reconciliations_field_check;
ALTER TABLE stock_reconciliations ADD CONSTRAINT stock_reconciliations_field_check
  CHECK (field IN ('on_hand', 'reserved', 'blocked', 'damaged', 'in_transit'));

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
  -- C8: reservas ativas por deposito (nulo = padrao) contra o reservado do deposito. A diferenca herdada da abertura
  -- (reservado sem reserva ativa em 16/11/2026) pertence ao padrao.
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
  -- C9: alocacao com reserva x reserva da alocacao.
  alloc AS (
    SELECT a.id, a.variant_id, a.warehouse_id, a.base_qty
    FROM fulfillment_allocations a JOIN fulfillments f ON f.id = a.fulfillment_id
    WHERE a.status = 'active' AND f.status = 'confirmed' AND f.mode IN ('stock', 'purchase_to_order')
  ),
  c9 AS (
    SELECT coalesce(al.variant_id, r.variant_id) AS variant_id, coalesce(al.warehouse_id, r.warehouse_id) AS warehouse_id,
           coalesce(al.base_qty, 0) AS expected, coalesce(r.qty, 0) AS got
    FROM alloc al
    FULL JOIN (SELECT * FROM stock_reservations WHERE status = 'active' AND allocation_id IS NOT NULL) r ON r.allocation_id = al.id
    WHERE al.id IS NULL OR r.id IS NULL OR r.qty <> al.base_qty OR r.warehouse_id IS DISTINCT FROM al.warehouse_id
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

ALTER TABLE logistics_settings DROP CONSTRAINT logistics_settings_multi_validated,
  DROP COLUMN multi_shipment_status, DROP COLUMN multi_validator_name, DROP COLUMN multi_validated_by,
  DROP COLUMN multi_validated_at, DROP COLUMN distinct_checker;

DROP INDEX whatsapp_messages_order_event_shipment;
ALTER TABLE whatsapp_messages DROP COLUMN shipment_id;
ALTER TABLE whatsapp_messages ADD CONSTRAINT whatsapp_messages_order_id_event_key UNIQUE (order_id, event);

DROP TABLE shipment_events;
DROP TABLE shipment_checks;
DROP TABLE shipment_items;
DROP FUNCTION shipment_items_check();
DELETE FROM shipments WHERE kind <> 'legacy';

DROP INDEX shipments_open_idx;
DROP INDEX shipments_order_idx;
DROP INDEX shipments_order_seq;
ALTER TABLE shipments DROP CONSTRAINT shipments_new_has_warehouse, DROP CONSTRAINT shipments_canceled,
  DROP COLUMN seq, DROP COLUMN kind, DROP COLUMN status, DROP COLUMN warehouse_id, DROP COLUMN packages, DROP COLUMN version,
  DROP COLUMN picking_started_at, DROP COLUMN checked_at, DROP COLUMN packed_at, DROP COLUMN canceled_at,
  DROP COLUMN cancel_reason, DROP COLUMN created_by, DROP COLUMN updated_at;
ALTER TABLE shipments ADD CONSTRAINT shipments_order_id_key UNIQUE (order_id);
