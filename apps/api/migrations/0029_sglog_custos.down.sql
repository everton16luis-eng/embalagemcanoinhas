-- Reverte a 0029 (SGLog Fase 10a). Recusa, sem alterar nada, quando a Fase 10 ja foi usada: configuracao de custo,
-- lancamento ou importacao registrados. Apagar historico financeiro para voltar nao e opcao: nesse caso a volta e so
-- do codigo (a 0029 e compativel com o codigo anterior).

SET LOCAL lock_timeout = '10s';
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '10 seconds'; tries integer := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE orders IN SHARE MODE;
      LOCK TABLE shipments, stock_movements IN SHARE MODE NOWAIT;
      LOCK TABLE cost_settings, cost_setting_events, cost_imports, order_cost_entries IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF clock_timestamp() > deadline THEN
        RAISE EXCEPTION 'Reversao da 0029: tabelas ocupadas por mais de 10 s (% tentativas); nada foi alterado, tente de novo', tries
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.02);
    END;
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cost_settings) OR EXISTS (SELECT 1 FROM order_cost_entries) OR EXISTS (SELECT 1 FROM cost_imports) THEN
    RAISE EXCEPTION 'Reversao da 0029 recusada: ha configuracao de custo, lancamento ou importacao registrados.' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

DROP FUNCTION cost_reconcile();
DROP INDEX stock_movements_order_source_idx;
DROP INDEX shipments_shipped_at_idx;
DROP INDEX orders_created_at_idx;
DROP INDEX orders_paid_at_idx;
DROP TABLE order_cost_entries;
DROP FUNCTION order_cost_entries_check();
DROP TABLE cost_imports;
DROP TABLE cost_setting_events;
DROP TABLE cost_settings;
DROP FUNCTION cost_settings_overlap_check();
DROP FUNCTION cost_settings_guard();
