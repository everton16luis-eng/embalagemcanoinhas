-- SGLog Fase 8: fretes, etiquetas, rastreamento e custos logisticos (docs/34-sglog-fase8-planejamento.md e
-- docs/35-sglog-fase8.md).
-- - Cotacao da remessa embalada (shipping_quotes): origem no deposito, volumes medidos na embalagem, validade.
-- - Etiqueta (shipping_labels, historico imutavel em shipping_label_events): preparada e BLOQUEADA. Liberar exige,
--   ao mesmo tempo, SHIPPING_LABELS_ENABLED no .env, um provedor que compre etiqueta, label_status 'enabled' com quem
--   validou e um limite por etiqueta DEFINIDO (label_max_cents NULL = sem limite definido = bloqueado; nunca
--   "ilimitado"). Uma etiqueta ativa por remessa; resposta incerta do provedor fica 'uncertain' e impede nova compra
--   ate a reconciliacao.
-- - Remessa com etiqueta ativa nao pode ser cancelada (gatilho shipments_label_guard).
-- - Custos (shipment_freight_costs, imutavel): pago a transportadora, ajustes e estornos separados do frete cobrado
--   (orders.freight_cents) e da cotacao. Sem lancamento = custo desconhecido (nunca zero).
-- - Fila de integracoes (integration_jobs), log sem corpo nem dados pessoais (integration_logs) e avisos do
--   transportador (logistics_webhook_events, deduplicados).
--
-- D8-12: ADITIVA e compativel com o codigo anterior (e057df4), inclusive na escrita: colunas novas nulas ou com
-- padrao, tabelas novas e um gatilho que so age quando ha etiqueta ativa (o codigo anterior nunca cria etiqueta).
-- Sem carrier_providers: provedores e credenciais continuam no codigo e no .env. shipment_events nao muda (source
-- 'carrier' e provider_event_id existem desde a 0024). stock_reconcile() (C1-C13), reservas, checkout, pagamentos,
-- NF-e e marketplaces nao mudam.

-- Bloqueios, tecnica da 0020-0026: espera so o primeiro, pede os demais com NOWAIT; ocupado, solta e tenta de novo.
--   shipments            ACCESS EXCLUSIVE     colunas e gatilho novos
--   logistics_settings   ACCESS EXCLUSIVE     colunas novas
--   users                SHARE ROW EXCLUSIVE  FKs novas
SET LOCAL lock_timeout = '10s';
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '10 seconds'; tries integer := 0; waited numeric;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE shipments IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE logistics_settings IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF clock_timestamp() > deadline THEN
        RAISE EXCEPTION '0027: remessas ocupadas por mais de 10 s (% tentativas); nada foi alterado, tente de novo', tries
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.02);
    END;
  END LOOP;
  waited := round(extract(epoch FROM clock_timestamp() - (deadline - interval '10 seconds')) * 1000);
  RAISE NOTICE '0027: bloqueios obtidos em % ms (% nova(s) tentativa(s))', waited, tries;
END $$;
SELECT set_config('sglog.t0', clock_timestamp()::text, true);

-- ---------------------------------------------------------------------------------------------------------------
-- Regras do frete.
--   label_status         compra de etiqueta pelo sistema; 'blocked' ate a autorizacao expressa (D8-3)
--   label_max_cents      limite por etiqueta; NULL = nao definido, e sem limite definido nao ha compra
--   tracking_poll_hours  intervalo da consulta de rastreio (D8-5)
--   tracking_stale_days  rastreio parado ha N dias vira alerta interno
ALTER TABLE logistics_settings
  ADD COLUMN label_status         text NOT NULL DEFAULT 'blocked' CONSTRAINT logistics_settings_label_status_check CHECK (label_status IN ('blocked', 'enabled')),
  ADD COLUMN label_validator_name text CONSTRAINT logistics_settings_label_validator_check CHECK (length(label_validator_name) BETWEEN 3 AND 120),
  ADD COLUMN label_validated_by   uuid REFERENCES users (id),
  ADD COLUMN label_validated_at   timestamptz,
  ADD COLUMN label_max_cents      integer CONSTRAINT logistics_settings_label_max_check CHECK (label_max_cents BETWEEN 1 AND 10000000),
  ADD COLUMN tracking_poll_hours  integer NOT NULL DEFAULT 6 CONSTRAINT logistics_settings_tracking_poll_check CHECK (tracking_poll_hours BETWEEN 1 AND 72),
  ADD COLUMN tracking_stale_days  integer NOT NULL DEFAULT 5 CONSTRAINT logistics_settings_tracking_stale_check CHECK (tracking_stale_days BETWEEN 1 AND 60),
  ADD CONSTRAINT logistics_settings_label_validated CHECK (
    label_status = 'blocked' OR (label_validator_name IS NOT NULL AND label_validated_by IS NOT NULL AND label_validated_at IS NOT NULL AND label_max_cents IS NOT NULL));

-- ---------------------------------------------------------------------------------------------------------------
-- Cotacoes da remessa. Cada cotacao grava os volumes usados: mudou a embalagem, a cotacao deixa de valer.
CREATE TABLE shipping_quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id   uuid NOT NULL REFERENCES shipments (id),
  batch_id      uuid NOT NULL,
  provider      text NOT NULL CHECK (provider IN ('melhorenvio', 'fake')),
  service       text NOT NULL CHECK (service ~ '^[0-9A-Za-z_-]{1,20}$'),
  service_name  text NOT NULL CHECK (length(service_name) BETWEEN 1 AND 120),
  company       text CHECK (length(company) <= 120),
  price_cents   integer NOT NULL CHECK (price_cents > 0),
  days          integer NOT NULL CHECK (days BETWEEN 0 AND 365),
  from_cep      text NOT NULL CHECK (from_cep ~ '^[0-9]{8}$'),
  to_cep        text NOT NULL CHECK (to_cep ~ '^[0-9]{8}$'),
  packages      jsonb NOT NULL CHECK (jsonb_typeof(packages) = 'array'),
  insurance_cents integer NOT NULL CHECK (insurance_cents >= 0),
  quoted_by     uuid REFERENCES users (id),
  quoted_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  CHECK (expires_at > quoted_at)
);
CREATE INDEX shipping_quotes_shipment_idx ON shipping_quotes (shipment_id, quoted_at DESC);
CREATE TRIGGER shipping_quotes_immutable BEFORE UPDATE OR DELETE ON shipping_quotes FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Remessa: provedor e servico escolhidos (cotacao), consulta de rastreio.
--   carrier_provider  manual (transportadora sem integracao), melhorenvio ou fake
ALTER TABLE shipments
  ADD COLUMN carrier_provider  text CONSTRAINT shipments_carrier_provider_check CHECK (carrier_provider IN ('manual', 'melhorenvio', 'fake')),
  ADD COLUMN carrier_service   text CONSTRAINT shipments_carrier_service_check CHECK (carrier_service ~ '^[0-9A-Za-z_-]{1,20}$'),
  ADD COLUMN quote_id          uuid REFERENCES shipping_quotes (id),
  ADD COLUMN tracking_status   text CONSTRAINT shipments_tracking_status_check CHECK (length(tracking_status) <= 40),
  ADD COLUMN last_tracked_at   timestamptz,
  ADD COLUMN last_tracking_event_at timestamptz;

-- ---------------------------------------------------------------------------------------------------------------
-- Etiquetas.
--   requested          pedida; aguardando a fila
--   purchasing         compra enviada ao provedor (a fila grava antes de chamar)
--   uncertain          o provedor nao respondeu com clareza: pode ter cobrado. Nova compra so depois de reconciliar
--   purchased          comprada (custo e rastreio do provedor)
--   printed            impressa
--   cancel_requested   cancelamento pedido ao provedor, aguardando confirmacao
--   canceled           cancelada pelo provedor (o estorno segue refund_status)
--   failed             nao comprada (recusa do provedor ou reconciliacao sem compra)
-- refund_status: none, pending (aguardando o provedor), refunded, denied, unknown. Nunca presumido.
CREATE TABLE shipping_labels (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id      uuid NOT NULL REFERENCES shipments (id),
  quote_id         uuid NOT NULL REFERENCES shipping_quotes (id),
  provider         text NOT NULL CHECK (provider IN ('melhorenvio', 'fake')),
  service          text NOT NULL CHECK (service ~ '^[0-9A-Za-z_-]{1,20}$'),
  status           text NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested', 'purchasing', 'uncertain', 'purchased', 'printed', 'cancel_requested', 'canceled', 'failed')),
  idempotency_key  text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  request_key      text NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  external_id      text CHECK (length(external_id) BETWEEN 1 AND 120),
  protocol         text CHECK (length(protocol) <= 60),
  tracking_code    text CHECK (length(tracking_code) <= 60),
  quoted_cents     integer NOT NULL CHECK (quoted_cents > 0),
  cost_cents       integer CHECK (cost_cents > 0),
  over_limit_reason text CHECK (length(over_limit_reason) BETWEEN 10 AND 300),
  error            text CHECK (length(error) <= 500),
  cancel_reason    text CHECK (length(cancel_reason) BETWEEN 3 AND 300),
  refund_status    text NOT NULL DEFAULT 'none' CHECK (refund_status IN ('none', 'pending', 'refunded', 'denied', 'unknown')),
  refund_cents     integer CHECK (refund_cents > 0),
  requested_by     uuid REFERENCES users (id),
  requested_at     timestamptz NOT NULL DEFAULT now(),
  purchased_at     timestamptz,
  canceled_at      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 0,
  CONSTRAINT shipping_labels_purchased CHECK (status NOT IN ('purchased', 'printed', 'cancel_requested') OR (external_id IS NOT NULL AND purchased_at IS NOT NULL)),
  CONSTRAINT shipping_labels_canceled CHECK ((status = 'canceled') = (canceled_at IS NOT NULL))
);
-- Uma etiqueta ativa (que pode ter cobrado ou vai cobrar) por remessa.
CREATE UNIQUE INDEX shipping_labels_one_active ON shipping_labels (shipment_id) WHERE status NOT IN ('canceled', 'failed');
CREATE UNIQUE INDEX shipping_labels_external ON shipping_labels (provider, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE shipping_label_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label_id     uuid NOT NULL REFERENCES shipping_labels (id),
  from_status  text,
  to_status    text NOT NULL,
  source       text NOT NULL CHECK (source IN ('manual', 'system', 'provider', 'webhook')),
  note         text CHECK (length(note) <= 500),
  actor_id     uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shipping_label_events_label_idx ON shipping_label_events (label_id, id);
CREATE TRIGGER shipping_label_events_immutable BEFORE UPDATE OR DELETE ON shipping_label_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Remessa com etiqueta ativa: cancelar exige cancelar a etiqueta antes (D8-11). Vale para qualquer caminho
-- (painel, cancelamento do pedido, codigo anterior).
CREATE FUNCTION shipments_label_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status = 'canceled' AND OLD.status <> 'canceled'
     AND EXISTS (SELECT 1 FROM shipping_labels WHERE shipment_id = NEW.id AND status NOT IN ('canceled', 'failed')) THEN
    RAISE EXCEPTION 'remessa com etiqueta ativa: cancele a etiqueta antes' USING ERRCODE = 'check_violation', CONSTRAINT = 'shipments_label_active';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shipments_label_guard BEFORE UPDATE OF status ON shipments FOR EACH ROW EXECUTE FUNCTION shipments_label_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- Custos do frete da remessa (pago a transportadora). Imutavel: correcao e um novo lancamento.
--   label       custo da etiqueta comprada pelo sistema (> 0)
--   manual      custo informado (etiqueta comprada fora), um por remessa (> 0)
--   adjustment  ajuste posterior (taxa extra, correcao de peso), com motivo (positivo ou negativo, nunca zero)
--   refund      estorno confirmado (negativo), com motivo
CREATE TABLE shipment_freight_costs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id   uuid NOT NULL REFERENCES shipments (id),
  kind          text NOT NULL CHECK (kind IN ('label', 'manual', 'adjustment', 'refund')),
  amount_cents  integer NOT NULL CHECK (amount_cents <> 0 AND abs(amount_cents) <= 10000000),
  label_id      uuid REFERENCES shipping_labels (id),
  note          text CHECK (length(note) BETWEEN 3 AND 300),
  request_key   text UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  actor_id      uuid REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipment_freight_costs_sign CHECK (
    (kind IN ('label', 'manual') AND amount_cents > 0) OR (kind = 'refund' AND amount_cents < 0) OR kind = 'adjustment'),
  CONSTRAINT shipment_freight_costs_note CHECK (kind NOT IN ('adjustment', 'refund') OR note IS NOT NULL),
  CONSTRAINT shipment_freight_costs_label CHECK ((kind = 'label') = (label_id IS NOT NULL) OR kind = 'refund')
);
CREATE INDEX shipment_freight_costs_shipment_idx ON shipment_freight_costs (shipment_id);
CREATE UNIQUE INDEX shipment_freight_costs_one_manual ON shipment_freight_costs (shipment_id) WHERE kind = 'manual';
CREATE UNIQUE INDEX shipment_freight_costs_one_label ON shipment_freight_costs (label_id) WHERE kind = 'label';
CREATE UNIQUE INDEX shipment_freight_costs_one_refund ON shipment_freight_costs (label_id) WHERE kind = 'refund' AND label_id IS NOT NULL;
CREATE TRIGGER shipment_freight_costs_immutable BEFORE UPDATE OR DELETE ON shipment_freight_costs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- Fila de integracoes. Rotina de 60 s, FOR UPDATE SKIP LOCKED, novas tentativas espacadas, 'dead' depois do limite.
CREATE TABLE integration_jobs (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind             text NOT NULL CHECK (kind IN ('label_purchase', 'label_reconcile', 'label_cancel', 'tracking_poll', 'webhook_process')),
  ref_id           text NOT NULL CHECK (length(ref_id) BETWEEN 1 AND 120),
  idempotency_key  text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'dead', 'canceled')),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts     integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  next_run_at      timestamptz NOT NULL DEFAULT now(),
  locked_at        timestamptz,
  last_error       text CHECK (length(last_error) <= 500),
  created_by       uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);
CREATE INDEX integration_jobs_due_idx ON integration_jobs (next_run_at) WHERE status = 'pending';
CREATE INDEX integration_jobs_status_idx ON integration_jobs (status, updated_at DESC);

-- Log das chamadas: sem corpo, sem token, sem endereco nem documento.
CREATE TABLE integration_logs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id       bigint REFERENCES integration_jobs (id),
  provider     text NOT NULL CHECK (length(provider) BETWEEN 2 AND 30),
  operation    text NOT NULL CHECK (length(operation) BETWEEN 2 AND 40),
  http_status  integer,
  duration_ms  integer CHECK (duration_ms >= 0),
  ok           boolean NOT NULL,
  error        text CHECK (length(error) <= 500),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_logs_job_idx ON integration_logs (job_id);
CREATE INDEX integration_logs_created_idx ON integration_logs (created_at DESC);
CREATE TRIGGER integration_logs_immutable BEFORE UPDATE OR DELETE ON integration_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Avisos do transportador. So entram com assinatura valida; a carga guarda so os campos usados (sem dados pessoais).
CREATE TABLE logistics_webhook_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider      text NOT NULL CHECK (provider IN ('melhorenvio', 'fake')),
  dedupe_key    text NOT NULL CHECK (length(dedupe_key) BETWEEN 8 AND 160),
  event         text NOT NULL CHECK (length(event) BETWEEN 2 AND 60),
  external_id   text CHECK (length(external_id) <= 120),
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'ignored', 'failed')),
  error         text CHECK (length(error) <= 500),
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  UNIQUE (provider, dedupe_key)
);
CREATE INDEX logistics_webhook_events_pending_idx ON logistics_webhook_events (received_at) WHERE status = 'pending';

GRANT SELECT, INSERT ON shipping_quotes, shipping_label_events, shipment_freight_costs, integration_logs TO loja_app;
GRANT SELECT, INSERT, UPDATE ON shipping_labels, integration_jobs, logistics_webhook_events TO loja_app;

DO $$ BEGIN
  RAISE NOTICE '0027: concluida em % ms', round(extract(epoch FROM clock_timestamp() - current_setting('sglog.t0', true)::timestamptz) * 1000);
EXCEPTION WHEN others THEN NULL;
END $$;
