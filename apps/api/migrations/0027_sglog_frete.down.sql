-- Reverte a 0027 (SGLog Fase 8). Recusa, sem alterar nada, quando a Fase 8 ja foi usada: cotacao, etiqueta, custo,
-- tarefa na fila, aviso do transportador, rastreio automatico ou regra alterada. Apagar historico para voltar nao e
-- opcao: nesse caso a volta e so do codigo (a 0027 e compativel com o codigo anterior).

SET LOCAL lock_timeout = '10s';
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '10 seconds'; tries integer := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE shipments IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE logistics_settings IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF clock_timestamp() > deadline THEN
        RAISE EXCEPTION 'Reversao da 0027: tabelas ocupadas por mais de 10 s (% tentativas); nada foi alterado, tente de novo', tries
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.02);
    END;
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM shipping_quotes) OR EXISTS (SELECT 1 FROM shipping_labels) THEN
    RAISE EXCEPTION 'Reversao da 0027 recusada: ha cotacao ou etiqueta registrada.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM shipment_freight_costs) THEN
    RAISE EXCEPTION 'Reversao da 0027 recusada: ha custo de frete registrado.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM integration_jobs) OR EXISTS (SELECT 1 FROM logistics_webhook_events) THEN
    RAISE EXCEPTION 'Reversao da 0027 recusada: ha tarefa de integracao ou aviso do transportador registrado.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM shipments WHERE carrier_provider IS NOT NULL OR carrier_service IS NOT NULL OR tracking_status IS NOT NULL
             OR last_tracked_at IS NOT NULL OR last_tracking_event_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Reversao da 0027 recusada: ha remessa com transportadora ou rastreio registrado pela Fase 8.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM logistics_settings WHERE label_status <> 'blocked' OR label_max_cents IS NOT NULL OR tracking_poll_hours <> 6 OR tracking_stale_days <> 5) THEN
    RAISE EXCEPTION 'Reversao da 0027 recusada: as regras do frete foram alteradas; volte ao padrao antes de reverter.' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

DROP TRIGGER shipments_label_guard ON shipments;
DROP FUNCTION shipments_label_guard();
DROP TABLE logistics_webhook_events;
DROP TABLE integration_logs;
DROP TABLE integration_jobs;
DROP TABLE shipment_freight_costs;
DROP TABLE shipping_label_events;
DROP TABLE shipping_labels;
ALTER TABLE shipments DROP COLUMN carrier_provider, DROP COLUMN carrier_service, DROP COLUMN quote_id, DROP COLUMN tracking_status,
  DROP COLUMN last_tracked_at, DROP COLUMN last_tracking_event_at;
DROP TABLE shipping_quotes;
ALTER TABLE logistics_settings DROP CONSTRAINT logistics_settings_label_validated,
  DROP COLUMN label_status, DROP COLUMN label_validator_name, DROP COLUMN label_validated_by, DROP COLUMN label_validated_at,
  DROP COLUMN label_max_cents, DROP COLUMN tracking_poll_hours, DROP COLUMN tracking_stale_days;
