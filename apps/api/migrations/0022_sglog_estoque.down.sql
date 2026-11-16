-- Reverte a 0022 (SGLog Fase 3). So remove o que a 0022 criou e devolve as funcoes, CHECKs e indice da 0004/0020.
-- Recusa, sem alterar nada, quando ja houve uso real dos recursos da fase: apagar historico para voltar nao e opcao
-- (nesse caso a volta e por backup, com autorizacao expressa).

SET LOCAL lock_timeout = '10s';
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '10 seconds'; tries integer := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE stock_balances IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE stock_movements IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE stock_location_balances IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE inventory_counts IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE stock_reconciliations IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE warehouses IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF clock_timestamp() > deadline THEN
        RAISE EXCEPTION 'Reversao da 0022: tabelas ocupadas por mais de 10 s (% tentativas); nada foi alterado, tente de novo', tries
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.02);
    END;
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM stock_movements WHERE kind IN ('transfer_out', 'transfer_in', 'transfer_loss', 'transfer_return', 'block', 'unblock', 'damage_hold', 'damage_release', 'reversal')
                                            OR source_type IN ('transfer', 'adjustment_request') OR document_ref IS NOT NULL
                                            OR blocked_delta <> 0 OR damaged_delta <> 0 OR in_transit_delta <> 0) THEN
    RAISE EXCEPTION 'Reversao da 0022 recusada: ha movimentos de estoque da Fase 3 (transferencia, bloqueio, avaria, estorno ou solicitacao).'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_location_balances WHERE blocked <> 0 OR damaged <> 0 OR in_transit <> 0)
     OR EXISTS (SELECT 1 FROM stock_balances WHERE blocked <> 0 OR damaged <> 0 OR in_transit <> 0) THEN
    RAISE EXCEPTION 'Reversao da 0022 recusada: ha saldo bloqueado, avariado ou em transito.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_transfers) OR EXISTS (SELECT 1 FROM stock_adjustment_requests) THEN
    RAISE EXCEPTION 'Reversao da 0022 recusada: ha transferencias ou solicitacoes de ajuste registradas.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM inventory_counts c JOIN warehouses w ON w.id = c.warehouse_id WHERE NOT w.is_default)
     OR (SELECT count(*) FROM inventory_counts WHERE status = 'open') > 1 THEN
    RAISE EXCEPTION 'Reversao da 0022 recusada: ha inventario em deposito que nao e o padrao.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_location_balances l JOIN warehouses w ON w.id = l.warehouse_id
             WHERE NOT w.is_default AND (l.on_hand <> 0 OR l.reserved <> 0)) THEN
    RAISE EXCEPTION 'Reversao da 0022 recusada: ha saldo em deposito que nao e o padrao.' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

-- Conferencia e CHECKs da 0020. Linhas antigas de conferencia com C6/C7 (imutaveis) ficam: o CHECK volta sem
-- revalidar o passado (NOT VALID), so vale para conferencias novas.
CREATE OR REPLACE FUNCTION stock_reconcile() RETURNS SETOF stock_reconciliations LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_run uuid := gen_random_uuid();
BEGIN
  WITH o AS (SELECT * FROM stock_opening_balances),
  mv AS (
    SELECT m.variant_id, sum(m.on_hand_delta) AS d_on, sum(m.reserved_delta) AS d_res, max(m.id) AS last_id
    FROM stock_movements m LEFT JOIN o ON o.variant_id = m.variant_id
    WHERE o.variant_id IS NULL OR m.id > coalesce(o.last_movement_id, 0)
    GROUP BY m.variant_id
  ),
  loc AS (SELECT l.variant_id, sum(l.on_hand) AS on_hand, sum(l.reserved) AS reserved FROM stock_location_balances l GROUP BY l.variant_id),
  res AS (SELECT r.variant_id, sum(r.qty) AS qty FROM stock_reservations r WHERE r.status = 'active' GROUP BY r.variant_id),
  vars AS (
    SELECT b.variant_id FROM stock_balances b UNION SELECT mv.variant_id FROM mv
    UNION SELECT o.variant_id FROM o UNION SELECT loc.variant_id FROM loc UNION SELECT res.variant_id FROM res
  ),
  base AS (
    SELECT v.variant_id, o.variant_id IS NOT NULL AS has_open,
           coalesce(b.on_hand, 0) AS b_on, coalesce(b.reserved, 0) AS b_res,
           coalesce(o.on_hand, 0) + coalesce(mv.d_on, 0) AS exp_on, coalesce(o.reserved, 0) + coalesce(mv.d_res, 0) AS exp_res,
           coalesce(loc.on_hand, 0) AS l_on, coalesce(loc.reserved, 0) AS l_res,
           lm.on_hand_after, lm.reserved_after,
           coalesce(res.qty, 0) + coalesce(o.reserved - o.reservations_active, 0) AS exp_res_c4
    FROM vars v
    LEFT JOIN stock_balances b ON b.variant_id = v.variant_id
    LEFT JOIN o ON o.variant_id = v.variant_id
    LEFT JOIN mv ON mv.variant_id = v.variant_id
    LEFT JOIN stock_movements lm ON lm.id = mv.last_id
    LEFT JOIN loc ON loc.variant_id = v.variant_id
    LEFT JOIN res ON res.variant_id = v.variant_id
  ),
  divs AS (
    SELECT CASE WHEN has_open THEN 'C1' ELSE 'C5' END AS code, 'on_hand' AS field, variant_id, exp_on AS expected, b_on AS found FROM base WHERE exp_on <> b_on
    UNION ALL SELECT CASE WHEN has_open THEN 'C1' ELSE 'C5' END, 'reserved', variant_id, exp_res, b_res FROM base WHERE exp_res <> b_res
    UNION ALL SELECT 'C2', 'on_hand', variant_id, b_on, l_on FROM base WHERE b_on <> l_on
    UNION ALL SELECT 'C2', 'reserved', variant_id, b_res, l_res FROM base WHERE b_res <> l_res
    UNION ALL SELECT 'C3', 'on_hand', variant_id, on_hand_after, b_on FROM base WHERE on_hand_after IS NOT NULL AND on_hand_after <> b_on
    UNION ALL SELECT 'C3', 'reserved', variant_id, reserved_after, b_res FROM base WHERE reserved_after IS NOT NULL AND reserved_after <> b_res
    UNION ALL SELECT 'C4', 'reserved', variant_id, exp_res_c4, b_res FROM base WHERE exp_res_c4 <> b_res
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

ALTER TABLE stock_reconciliations DROP CONSTRAINT stock_reconciliations_check_code_check;
ALTER TABLE stock_reconciliations ADD CONSTRAINT stock_reconciliations_check_code_check
  CHECK (check_code IN ('run', 'C1', 'C2', 'C3', 'C4', 'C5')) NOT VALID;
ALTER TABLE stock_reconciliations DROP CONSTRAINT stock_reconciliations_field_check;
ALTER TABLE stock_reconciliations ADD CONSTRAINT stock_reconciliations_field_check CHECK (field IN ('on_hand', 'reserved')) NOT VALID;

-- Inventario: volta a uma contagem aberta no sistema todo.
DROP TRIGGER inventory_counts_default_warehouse ON inventory_counts;
DROP FUNCTION inventory_counts_default_warehouse();
DROP INDEX inventory_counts_one_open_per_warehouse;
CREATE UNIQUE INDEX inventory_counts_one_open ON inventory_counts ((true)) WHERE status = 'open';
ALTER TABLE inventory_counts DROP COLUMN warehouse_id;

DROP TABLE stock_adjustment_requests;
DROP SEQUENCE IF EXISTS stock_adjustment_request_number;
DROP VIEW stock_location_alerts;
DROP TABLE stock_location_settings;

DROP TRIGGER warehouses_guard ON warehouses;
DROP FUNCTION warehouses_guard();
REVOKE INSERT, UPDATE ON warehouses FROM loja_app;

-- Gatilho e trava da 0020, como eram.
CREATE OR REPLACE FUNCTION stock_balances_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cur record; loc record;
BEGIN
  IF session_user <> 'loja_app' THEN RETURN NULL; END IF;
  SELECT on_hand, reserved INTO cur FROM stock_balances WHERE variant_id = NEW.variant_id;
  SELECT coalesce(sum(on_hand), 0) AS on_hand, coalesce(sum(reserved), 0) AS reserved INTO loc
    FROM stock_location_balances WHERE variant_id = NEW.variant_id;
  IF cur.on_hand <> loc.on_hand OR cur.reserved <> loc.reserved THEN
    RAISE EXCEPTION 'saldo alterado sem movimento de estoque' USING ERRCODE = 'restrict_violation', CONSTRAINT = 'stock_balances_requires_movement';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION stock_movements_location() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE wh uuid := coalesce(NEW.warehouse_id, (SELECT id FROM warehouses WHERE is_default));
BEGIN
  IF wh IS NULL THEN
    RAISE EXCEPTION 'nenhum deposito padrao cadastrado' USING ERRCODE = 'restrict_violation';
  END IF;
  UPDATE stock_location_balances
     SET on_hand = on_hand + NEW.on_hand_delta, reserved = reserved + NEW.reserved_delta, updated_at = now()
   WHERE warehouse_id = wh AND variant_id = NEW.variant_id;
  IF NOT FOUND THEN
    INSERT INTO stock_location_balances (warehouse_id, variant_id, on_hand, reserved)
    VALUES (wh, NEW.variant_id, NEW.on_hand_delta, NEW.reserved_delta);
  END IF;
  RETURN NULL;
END $$;

-- Livro: CHECKs da 0004 e colunas da 0022 (todas com valor padrao, sem uso: conferido acima).
DROP TRIGGER stock_movements_reversal_check ON stock_movements;
DROP FUNCTION stock_movements_reversal_check();
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_reversal;
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_transfer;
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_bucket_shape;
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_reason;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_reason CHECK (kind NOT IN ('loss', 'damage', 'adjustment') OR reason IS NOT NULL);
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_nonzero;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_nonzero CHECK (on_hand_delta <> 0 OR reserved_delta <> 0);
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_source_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_source_type_check
  CHECK (source_type IN ('purchase_receipt', 'order', 'cart', 'quote', 'inventory', 'manual', 'reservation'));
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_kind_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check
  CHECK (kind IN ('receipt', 'sale', 'return', 'loss', 'damage', 'adjustment', 'inventory', 'reserve', 'release'));
DROP INDEX stock_movements_reverses_unique;
DROP INDEX stock_movements_transfer_idx;
DROP INDEX stock_movements_warehouse_idx;
ALTER TABLE stock_movements
  DROP COLUMN reverses_id, DROP COLUMN document_ref, DROP COLUMN transfer_id, DROP COLUMN counter_warehouse_id,
  DROP COLUMN in_transit_after, DROP COLUMN damaged_after, DROP COLUMN blocked_after,
  DROP COLUMN in_transit_delta, DROP COLUMN damaged_delta, DROP COLUMN blocked_delta;

DROP TABLE stock_transfer_events;
DROP TABLE stock_transfer_items;
DROP TABLE stock_transfers;

ALTER TABLE stock_location_balances DROP COLUMN in_transit, DROP COLUMN damaged, DROP COLUMN blocked;
ALTER TABLE stock_balances DROP COLUMN in_transit, DROP COLUMN damaged, DROP COLUMN blocked;
