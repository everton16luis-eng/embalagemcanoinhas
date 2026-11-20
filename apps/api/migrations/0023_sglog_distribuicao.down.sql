-- Reverte a 0023 (SGLog Fase 4). So remove o que a 0023 criou e devolve a conferencia, o CHECK e o indice da
-- 0004/0022. Recusa, sem alterar nada, quando ja houve alocacao real: apagar historico para voltar nao e opcao
-- (nesse caso a volta e so do codigo, ou por backup com autorizacao expressa).

SET LOCAL lock_timeout = '10s';
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '10 seconds'; tries integer := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE orders IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE stock_reservations IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE stock_reconciliations IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE warehouses IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF clock_timestamp() > deadline THEN
        RAISE EXCEPTION 'Reversao da 0023: tabelas ocupadas por mais de 10 s (% tentativas); nada foi alterado, tente de novo', tries
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.02);
    END;
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM fulfillments) OR EXISTS (SELECT 1 FROM allocation_decisions) THEN
    RAISE EXCEPTION 'Reversao da 0023 recusada: ja ha alocacoes ou decisoes de alocacao registradas.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_reservations WHERE status = 'active' AND source_type = 'order'
             GROUP BY source_id, variant_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Reversao da 0023 recusada: ha pedido com mais de uma reserva ativa para a mesma variante.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_reservations WHERE status = 'active' AND warehouse_id IS DISTINCT FROM (SELECT id FROM warehouses WHERE is_default)) THEN
    RAISE EXCEPTION 'Reversao da 0023 recusada: ha reserva ativa fora do deposito padrao.' USING ERRCODE = 'restrict_violation';
  END IF;
  -- O historico da conferencia e imutavel: divergencia C8/C9 ja registrada impede voltar o CHECK.
  IF EXISTS (SELECT 1 FROM stock_reconciliations WHERE check_code IN ('C8', 'C9')) THEN
    RAISE EXCEPTION 'Reversao da 0023 recusada: ha divergencia C8/C9 registrada na conferencia.' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

DROP TRIGGER orders_logistics_close ON orders;
DROP TRIGGER orders_logistics_project ON orders;
DROP FUNCTION orders_logistics_close();
DROP FUNCTION orders_logistics_project();

DROP INDEX stock_reservations_order_idx;
DROP INDEX stock_reservations_allocation_unique;
DROP INDEX stock_reservations_source_unique;
CREATE UNIQUE INDEX stock_reservations_source_unique ON stock_reservations (source_type, source_id, variant_id) WHERE status = 'active';
ALTER TABLE stock_reservations DROP CONSTRAINT stock_reservations_allocation_source, DROP COLUMN allocation_id, DROP COLUMN warehouse_id;

DROP TABLE fulfillment_allocations;
DROP FUNCTION fulfillment_allocations_check();
DROP TABLE fulfillments;
DROP FUNCTION fulfillments_dropship_lock();
DROP TABLE allocation_decisions;
DROP TABLE logistics_settings;

ALTER TABLE warehouses DROP COLUMN allocation_priority;
DROP INDEX orders_logistics_queue_idx;
ALTER TABLE orders DROP COLUMN logistics_checked_at, DROP COLUMN allocation_required, DROP COLUMN logistics_version, DROP COLUMN logistics_note, DROP COLUMN logistics_status;

-- Conferencia da 0022 (sem C8 e C9). A coluna warehouse_id sai antes, para a funcao voltar ao tipo de linha anterior.
ALTER TABLE stock_reconciliations DROP COLUMN warehouse_id;
ALTER TABLE stock_reconciliations DROP CONSTRAINT stock_reconciliations_check_code_check;
ALTER TABLE stock_reconciliations ADD CONSTRAINT stock_reconciliations_check_code_check
  CHECK (check_code IN ('run', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'));

CREATE OR REPLACE FUNCTION stock_reconcile() RETURNS SETOF stock_reconciliations LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_run uuid := gen_random_uuid();
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
  divs AS (
    SELECT CASE WHEN has_open THEN 'C1' ELSE 'C5' END AS code, 'on_hand' AS field, variant_id, exp_on AS expected, b_on AS found FROM base WHERE exp_on <> b_on
    UNION ALL SELECT CASE WHEN has_open THEN 'C1' ELSE 'C5' END, 'reserved', variant_id, exp_res, b_res FROM base WHERE exp_res <> b_res
    UNION ALL SELECT CASE WHEN has_open THEN 'C1' ELSE 'C5' END, 'blocked', variant_id, exp_blk, b_blk FROM base WHERE exp_blk <> b_blk
    UNION ALL SELECT CASE WHEN has_open THEN 'C1' ELSE 'C5' END, 'damaged', variant_id, exp_dmg, b_dmg FROM base WHERE exp_dmg <> b_dmg
    UNION ALL SELECT CASE WHEN has_open THEN 'C1' ELSE 'C5' END, 'in_transit', variant_id, exp_trn, b_trn FROM base WHERE exp_trn <> b_trn
    UNION ALL SELECT 'C2', 'on_hand', variant_id, b_on, l_on FROM base WHERE b_on <> l_on
    UNION ALL SELECT 'C2', 'reserved', variant_id, b_res, l_res FROM base WHERE b_res <> l_res
    UNION ALL SELECT 'C2', 'blocked', variant_id, b_blk, l_blk FROM base WHERE b_blk <> l_blk
    UNION ALL SELECT 'C2', 'damaged', variant_id, b_dmg, l_dmg FROM base WHERE b_dmg <> l_dmg
    UNION ALL SELECT 'C2', 'in_transit', variant_id, b_trn, l_trn FROM base WHERE b_trn <> l_trn
    UNION ALL SELECT 'C3', 'on_hand', variant_id, on_hand_after, b_on FROM base WHERE on_hand_after IS NOT NULL AND on_hand_after <> b_on
    UNION ALL SELECT 'C3', 'reserved', variant_id, reserved_after, b_res FROM base WHERE reserved_after IS NOT NULL AND reserved_after <> b_res
    UNION ALL SELECT 'C3', 'blocked', variant_id, blocked_after, b_blk FROM base WHERE blocked_after IS NOT NULL AND blocked_after <> b_blk
    UNION ALL SELECT 'C3', 'damaged', variant_id, damaged_after, b_dmg FROM base WHERE damaged_after IS NOT NULL AND damaged_after <> b_dmg
    UNION ALL SELECT 'C3', 'in_transit', variant_id, in_transit_after, b_trn FROM base WHERE in_transit_after IS NOT NULL AND in_transit_after <> b_trn
    UNION ALL SELECT 'C4', 'reserved', variant_id, exp_res_c4, b_res FROM base WHERE exp_res_c4 <> b_res
    UNION ALL SELECT 'C6', 'in_transit', variant_id, exp_trn_c6, b_trn FROM base WHERE exp_trn_c6 <> b_trn
    UNION ALL SELECT 'C7', field, variant_id, exp_v, got_v FROM rev
  ),
  ins AS (
    INSERT INTO stock_reconciliations (run_id, check_code, field, variant_id, expected, found, created_by)
    SELECT v_run, d.code, d.field, d.variant_id, d.expected, d.found, app_user_id() FROM divs d
    RETURNING 1
  )
  INSERT INTO stock_reconciliations (run_id, check_code, expected, found, created_by)
  SELECT v_run, 'run', (SELECT count(*) FROM base), (SELECT count(*) FROM ins), app_user_id();

  RETURN QUERY SELECT * FROM stock_reconciliations WHERE run_id = v_run ORDER BY id;
END $$;
REVOKE ALL ON FUNCTION stock_reconcile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stock_reconcile() TO loja_app;
