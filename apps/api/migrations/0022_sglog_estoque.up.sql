-- SGLog Fase 3: estoque por deposito (docs/19-sglog-fase3-planejamento.md e docs/20-sglog-fase3.md).
-- Saldos separados por deposito (disponivel, reservado, bloqueado, avariado, em transito), transferencias em duas
-- etapas, bloqueio, avaria, estorno, solicitacao de ajuste com aprovacao, inventario por deposito, localizacao,
-- minimo e maximo por deposito e alertas.
-- Nada do que existe muda de comportamento: o vendavel continua on_hand - reserved em stock_balances (loja,
-- marketplaces, orcamentos, bot e relatorios), moveStock() continua o unico caminho da aplicacao e reserva,
-- venda e recebimento de compra continuam no deposito padrao (escolha de deposito: Fase 4).
-- O livro nao e reescrito: as colunas novas tem valor padrao constante (so metadado, sem reescrever a tabela).

-- Bloqueios, todos antes de qualquer alteracao, com a mesma tecnica da 0020: espera so o saldo (sem segurar nada),
-- pede as demais com NOWAIT; ocupada, solta tudo, espera 20 ms e tenta de novo. Teto de 10 s.
--   stock_balances           ACCESS EXCLUSIVE     colunas novas (a leitura da loja espera ate o COMMIT, < 1 s no ensaio)
--   stock_movements          ACCESS EXCLUSIVE     colunas, CHECKs e gatilho novos
--   stock_location_balances  ACCESS EXCLUSIVE     colunas novas
--   inventory_counts         ACCESS EXCLUSIVE     deposito da contagem e indice "uma aberta por deposito"
--   stock_reconciliations    ACCESS EXCLUSIVE     CHECKs ampliados
--   warehouses               SHARE ROW EXCLUSIVE  gatilho e FKs novos
--   product_variants, users  SHARE ROW EXCLUSIVE  FKs novas (leitura continua)
SET LOCAL lock_timeout = '10s';
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '10 seconds'; tries integer := 0; waited numeric;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE stock_balances IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE stock_movements IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE stock_location_balances IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE inventory_counts IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE stock_reconciliations IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE warehouses IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE product_variants IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF clock_timestamp() > deadline THEN
        RAISE EXCEPTION '0022: tabelas de estoque ocupadas por mais de 10 s (% tentativas); nada foi alterado, tente de novo', tries
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.02);
    END;
  END LOOP;
  waited := round(extract(epoch FROM clock_timestamp() - (deadline - interval '10 seconds')) * 1000);
  RAISE NOTICE '0022: bloqueios obtidos em % ms (% nova(s) tentativa(s))', waited, tries;
END $$;
SELECT set_config('sglog.t0', clock_timestamp()::text, true);

-- Pre-condicoes: o que a 0020 deixou precisa estar intacto.
DO $$
BEGIN
  IF (SELECT count(*) FROM warehouses WHERE is_default) <> 1 THEN
    RAISE EXCEPTION '0022: era esperado exatamente um deposito padrao' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (SELECT count(*) FROM inventory_counts WHERE status = 'open') > 1 THEN
    RAISE EXCEPTION '0022: ha mais de uma contagem de inventario aberta' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Saldos novos. Nascem em zero; total (stock_balances) = soma dos depositos, saldo por saldo.
ALTER TABLE stock_balances
  ADD COLUMN blocked    numeric(14,3) NOT NULL DEFAULT 0 CONSTRAINT stock_balances_blocked_check CHECK (blocked >= 0),
  ADD COLUMN damaged    numeric(14,3) NOT NULL DEFAULT 0 CONSTRAINT stock_balances_damaged_check CHECK (damaged >= 0),
  ADD COLUMN in_transit numeric(14,3) NOT NULL DEFAULT 0 CONSTRAINT stock_balances_in_transit_check CHECK (in_transit >= 0);
ALTER TABLE stock_location_balances
  ADD COLUMN blocked    numeric(14,3) NOT NULL DEFAULT 0 CONSTRAINT stock_location_balances_blocked_check CHECK (blocked >= 0),
  ADD COLUMN damaged    numeric(14,3) NOT NULL DEFAULT 0 CONSTRAINT stock_location_balances_damaged_check CHECK (damaged >= 0),
  ADD COLUMN in_transit numeric(14,3) NOT NULL DEFAULT 0 CONSTRAINT stock_location_balances_in_transit_check CHECK (in_transit >= 0);

-- ---------------------------------------------------------------------------------------------------------------
-- Transferencias em duas etapas (envio e recebimento). O em transito conta no deposito de destino.
CREATE SEQUENCE stock_transfer_number START 1;
CREATE TABLE stock_transfers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             integer NOT NULL UNIQUE DEFAULT nextval('stock_transfer_number'),
  from_warehouse_id  uuid NOT NULL REFERENCES warehouses (id),
  to_warehouse_id    uuid NOT NULL REFERENCES warehouses (id),
  status             text NOT NULL DEFAULT 'in_transit' CHECK (status IN ('in_transit', 'partial', 'received', 'closed_divergent', 'canceled')),
  notes              text CHECK (length(notes) <= 1000),
  document_ref       text CHECK (length(document_ref) <= 60),
  request_key        text NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  created_by         uuid NOT NULL REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  closed_at          timestamptz,
  CONSTRAINT stock_transfers_distinct CHECK (from_warehouse_id <> to_warehouse_id),
  CONSTRAINT stock_transfers_closed CHECK ((status IN ('in_transit', 'partial')) = (closed_at IS NULL))
);
ALTER SEQUENCE stock_transfer_number OWNED BY stock_transfers.number;
CREATE INDEX stock_transfers_open_idx ON stock_transfers (to_warehouse_id) WHERE status IN ('in_transit', 'partial');
CREATE INDEX stock_transfers_created_idx ON stock_transfers (created_at DESC);

CREATE TABLE stock_transfer_items (
  transfer_id   uuid NOT NULL REFERENCES stock_transfers (id),
  variant_id    uuid NOT NULL REFERENCES product_variants (id),
  qty_sent      numeric(14,3) NOT NULL CHECK (qty_sent > 0),
  qty_received  numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  qty_lost      numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty_lost >= 0),
  qty_returned  numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty_returned >= 0),
  PRIMARY KEY (transfer_id, variant_id),
  -- Nunca recebe, extravia ou devolve alem do enviado (recebimento duplicado e recusado pelo banco tambem).
  CONSTRAINT stock_transfer_items_not_over CHECK (qty_received + qty_lost + qty_returned <= qty_sent)
);
CREATE INDEX stock_transfer_items_variant_idx ON stock_transfer_items (variant_id);

-- Historico imutavel de cada evento: autor, data, quantidades por item e motivo.
CREATE TABLE stock_transfer_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id  uuid NOT NULL REFERENCES stock_transfers (id),
  kind         text NOT NULL CHECK (kind IN ('send', 'receive', 'loss', 'return', 'cancel')),
  items        jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) > 0),
  reason       text CHECK (length(reason) BETWEEN 3 AND 300),
  request_key  text UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  created_by   uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_transfer_events_reason CHECK (kind NOT IN ('loss', 'return', 'cancel') OR reason IS NOT NULL)
);
CREATE INDEX stock_transfer_events_transfer_idx ON stock_transfer_events (transfer_id, id);
CREATE TRIGGER stock_transfer_events_immutable BEFORE UPDATE OR DELETE ON stock_transfer_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- Livro: deltas e saldos resultantes dos saldos novos, ligacao com transferencia e estorno.
-- Cada linha afeta um unico deposito (warehouse_id; nulo = padrao). O envio de uma transferencia grava duas linhas.
ALTER TABLE stock_movements
  ADD COLUMN blocked_delta        numeric(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN damaged_delta        numeric(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN in_transit_delta     numeric(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN blocked_after        numeric(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN damaged_after        numeric(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN in_transit_after     numeric(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN counter_warehouse_id uuid REFERENCES warehouses (id),
  ADD COLUMN transfer_id          uuid REFERENCES stock_transfers (id),
  ADD COLUMN document_ref         text CONSTRAINT stock_movements_document_ref_check CHECK (length(document_ref) <= 60),
  ADD COLUMN reverses_id          bigint REFERENCES stock_movements (id);

-- Cada movimento so pode ser estornado uma vez.
CREATE UNIQUE INDEX stock_movements_reverses_unique ON stock_movements (reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX stock_movements_transfer_idx ON stock_movements (transfer_id) WHERE transfer_id IS NOT NULL;
CREATE INDEX stock_movements_warehouse_idx ON stock_movements (warehouse_id, variant_id, id DESC) WHERE warehouse_id IS NOT NULL;

ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_kind_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check CHECK (kind IN (
  'receipt', 'sale', 'return', 'loss', 'damage', 'adjustment', 'inventory', 'reserve', 'release',
  'transfer_out', 'transfer_in', 'transfer_loss', 'transfer_return', 'block', 'unblock', 'damage_hold', 'damage_release', 'reversal'));

ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_source_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_source_type_check
  CHECK (source_type IN ('purchase_receipt', 'order', 'cart', 'quote', 'inventory', 'manual', 'reservation', 'transfer', 'adjustment_request'));

ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_nonzero;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_nonzero
  CHECK (on_hand_delta <> 0 OR reserved_delta <> 0 OR blocked_delta <> 0 OR damaged_delta <> 0 OR in_transit_delta <> 0);

ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_reason;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_reason CHECK (
  kind NOT IN ('loss', 'damage', 'adjustment', 'block', 'unblock', 'damage_hold', 'damage_release', 'reversal', 'transfer_loss', 'transfer_return')
  OR reason IS NOT NULL);

-- Forma de cada tipo: qual saldo sai e qual entra. Os tipos antigos nao mexem nos saldos novos.
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_bucket_shape CHECK (CASE kind
  WHEN 'block'           THEN blocked_delta > 0 AND on_hand_delta = -blocked_delta AND reserved_delta = 0 AND damaged_delta = 0 AND in_transit_delta = 0
  WHEN 'unblock'         THEN blocked_delta < 0 AND on_hand_delta = -blocked_delta AND reserved_delta = 0 AND damaged_delta = 0 AND in_transit_delta = 0
  WHEN 'damage_hold'     THEN damaged_delta > 0 AND on_hand_delta = -damaged_delta AND reserved_delta = 0 AND blocked_delta = 0 AND in_transit_delta = 0
  WHEN 'damage_release'  THEN damaged_delta < 0 AND on_hand_delta = -damaged_delta AND reserved_delta = 0 AND blocked_delta = 0 AND in_transit_delta = 0
  WHEN 'damage'          THEN reserved_delta = 0 AND blocked_delta = 0 AND in_transit_delta = 0
                              AND ((on_hand_delta < 0 AND damaged_delta = 0) OR (damaged_delta < 0 AND on_hand_delta = 0))
  WHEN 'transfer_out'    THEN reserved_delta = 0 AND blocked_delta = 0 AND damaged_delta = 0
                              AND ((on_hand_delta < 0 AND in_transit_delta = 0) OR (in_transit_delta > 0 AND on_hand_delta = 0))
  WHEN 'transfer_in'     THEN in_transit_delta < 0 AND on_hand_delta = -in_transit_delta AND reserved_delta = 0 AND blocked_delta = 0 AND damaged_delta = 0
  WHEN 'transfer_loss'   THEN in_transit_delta < 0 AND on_hand_delta = 0 AND reserved_delta = 0 AND blocked_delta = 0 AND damaged_delta = 0
  WHEN 'transfer_return' THEN reserved_delta = 0 AND blocked_delta = 0 AND damaged_delta = 0
                              AND ((in_transit_delta < 0 AND on_hand_delta = 0) OR (on_hand_delta > 0 AND in_transit_delta = 0))
  WHEN 'reversal'        THEN reserved_delta = 0
  ELSE blocked_delta = 0 AND damaged_delta = 0 AND in_transit_delta = 0
END);

-- Transferencia: deposito explicito, outro deposito diferente e transferencia informada.
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_transfer CHECK (
  (kind NOT IN ('transfer_out', 'transfer_in', 'transfer_loss', 'transfer_return')
     OR (transfer_id IS NOT NULL AND warehouse_id IS NOT NULL AND counter_warehouse_id IS NOT NULL AND counter_warehouse_id <> warehouse_id))
  AND (transfer_id IS NULL OR kind IN ('transfer_out', 'transfer_in', 'transfer_loss', 'transfer_return', 'reversal')));
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_reversal CHECK ((kind = 'reversal') = (reverses_id IS NOT NULL));

-- Estorno: o original existe, e manual (ou de solicitacao aprovada) ou envio de transferencia, nao e estorno, e da
-- mesma variante e do mesmo deposito, e os deltas sao exatamente os opostos. Confere no banco, nao so na aplicacao.
CREATE FUNCTION stock_movements_reversal_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
CREATE TRIGGER stock_movements_reversal_check BEFORE INSERT ON stock_movements FOR EACH ROW WHEN (NEW.kind = 'reversal')
  EXECUTE FUNCTION stock_movements_reversal_check();

-- Gatilho da 0020, ampliado: aplica os cinco deltas no saldo do deposito da linha.
CREATE OR REPLACE FUNCTION stock_movements_location() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE wh uuid := coalesce(NEW.warehouse_id, (SELECT id FROM warehouses WHERE is_default));
BEGIN
  IF wh IS NULL THEN
    RAISE EXCEPTION 'nenhum deposito padrao cadastrado' USING ERRCODE = 'restrict_violation';
  END IF;
  -- UPDATE antes do INSERT: num INSERT ... ON CONFLICT o CHECK (>= 0) vale para a linha proposta. Sem disputa:
  -- moveStock ja bloqueou o saldo total da variante, entao so uma transacao por vez grava os depositos dela.
  UPDATE stock_location_balances
     SET on_hand = on_hand + NEW.on_hand_delta, reserved = reserved + NEW.reserved_delta,
         blocked = blocked + NEW.blocked_delta, damaged = damaged + NEW.damaged_delta, in_transit = in_transit + NEW.in_transit_delta,
         updated_at = now()
   WHERE warehouse_id = wh AND variant_id = NEW.variant_id;
  IF NOT FOUND THEN
    INSERT INTO stock_location_balances (warehouse_id, variant_id, on_hand, reserved, blocked, damaged, in_transit)
    VALUES (wh, NEW.variant_id, NEW.on_hand_delta, NEW.reserved_delta, NEW.blocked_delta, NEW.damaged_delta, NEW.in_transit_delta);
  END IF;
  RETURN NULL;
END $$;

-- Trava da 0020, ampliada: no COMMIT, o total precisa ser a soma dos depositos nos cinco saldos.
CREATE OR REPLACE FUNCTION stock_balances_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cur record; loc record;
BEGIN
  IF session_user <> 'loja_app' THEN RETURN NULL; END IF;
  SELECT on_hand, reserved, blocked, damaged, in_transit INTO cur FROM stock_balances WHERE variant_id = NEW.variant_id;
  SELECT coalesce(sum(on_hand), 0) AS on_hand, coalesce(sum(reserved), 0) AS reserved, coalesce(sum(blocked), 0) AS blocked,
         coalesce(sum(damaged), 0) AS damaged, coalesce(sum(in_transit), 0) AS in_transit
    INTO loc FROM stock_location_balances WHERE variant_id = NEW.variant_id;
  IF cur.on_hand <> loc.on_hand OR cur.reserved <> loc.reserved OR cur.blocked <> loc.blocked
     OR cur.damaged <> loc.damaged OR cur.in_transit <> loc.in_transit THEN
    RAISE EXCEPTION 'saldo alterado sem movimento de estoque' USING ERRCODE = 'restrict_violation', CONSTRAINT = 'stock_balances_requires_movement';
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Depositos: a aplicacao passa a cadastrar e alterar (permissao settings.manage na API). Sem DELETE: desativa.
-- Na Fase 3 o padrao nao muda (reservas e linhas antigas do livro estao ligadas a ele) e deposito com saldo,
-- transito ou inventario aberto nao pode ser desativado. Conferido aqui tambem, alem da API.
CREATE FUNCTION warehouses_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF session_user <> 'loja_app' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_default THEN
      RAISE EXCEPTION 'o deposito padrao nao pode ser trocado nesta fase' USING ERRCODE = 'restrict_violation', CONSTRAINT = 'warehouses_default_fixed';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.is_default IS DISTINCT FROM OLD.is_default OR NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'o codigo e o deposito padrao nao podem ser alterados' USING ERRCODE = 'restrict_violation', CONSTRAINT = 'warehouses_default_fixed';
  END IF;
  IF OLD.active AND NOT NEW.active AND (
       EXISTS (SELECT 1 FROM stock_location_balances WHERE warehouse_id = OLD.id
                AND (on_hand <> 0 OR reserved <> 0 OR blocked <> 0 OR damaged <> 0 OR in_transit <> 0))
    OR EXISTS (SELECT 1 FROM stock_transfers WHERE (from_warehouse_id = OLD.id OR to_warehouse_id = OLD.id) AND status IN ('in_transit', 'partial'))
    OR EXISTS (SELECT 1 FROM inventory_counts WHERE warehouse_id = OLD.id AND status = 'open')) THEN
    RAISE EXCEPTION 'deposito com saldo, transferencia pendente ou inventario aberto' USING ERRCODE = 'restrict_violation', CONSTRAINT = 'warehouses_in_use';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER warehouses_guard BEFORE INSERT OR UPDATE ON warehouses FOR EACH ROW EXECUTE FUNCTION warehouses_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- Localizacao, minimo e maximo por deposito. Tabela propria: o saldo por deposito so muda por movimento.
CREATE TABLE stock_location_settings (
  warehouse_id  uuid NOT NULL REFERENCES warehouses (id),
  variant_id    uuid NOT NULL REFERENCES product_variants (id),
  bin           text CHECK (length(bin) BETWEEN 1 AND 40),
  min_qty       numeric(14,3) CHECK (min_qty >= 0),
  max_qty       numeric(14,3) CHECK (max_qty > 0),
  updated_by    uuid REFERENCES users (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (warehouse_id, variant_id),
  CONSTRAINT stock_location_settings_range CHECK (max_qty IS NULL OR min_qty IS NULL OR max_qty >= min_qty)
);
CREATE INDEX stock_location_settings_variant_idx ON stock_location_settings (variant_id);

-- Alertas por deposito (D3-7). So leitura: o painel consulta; uma notificacao futura usa a mesma visao.
--   below_min: vendavel do deposito (on_hand - reserved) abaixo do minimo
--   above_max: disponivel + em transito para o deposito acima do maximo
CREATE VIEW stock_location_alerts AS
SELECT s.warehouse_id, s.variant_id, a.alert,
       coalesce(l.on_hand, 0) AS on_hand, coalesce(l.reserved, 0) AS reserved, coalesce(l.in_transit, 0) AS in_transit,
       coalesce(l.on_hand, 0) - coalesce(l.reserved, 0) AS available, s.min_qty, s.max_qty
FROM stock_location_settings s
JOIN warehouses w ON w.id = s.warehouse_id AND w.active
LEFT JOIN stock_location_balances l ON l.warehouse_id = s.warehouse_id AND l.variant_id = s.variant_id
CROSS JOIN LATERAL (
  SELECT 'below_min'::text AS alert WHERE s.min_qty IS NOT NULL AND coalesce(l.on_hand, 0) - coalesce(l.reserved, 0) < s.min_qty
  UNION ALL
  SELECT 'above_max' WHERE s.max_qty IS NOT NULL AND coalesce(l.on_hand, 0) + coalesce(l.in_transit, 0) > s.max_qty
) a;

-- ---------------------------------------------------------------------------------------------------------------
-- Solicitacao de ajuste (D3-2): quem tem stock.manage pede; quem tem stock.adjust (com MFA) aprova ou recusa.
-- Quem pede nao aprova a propria. A aprovacao grava o movimento na mesma transacao.
CREATE SEQUENCE stock_adjustment_request_number START 1;
CREATE TABLE stock_adjustment_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number         integer NOT NULL UNIQUE DEFAULT nextval('stock_adjustment_request_number'),
  warehouse_id   uuid NOT NULL REFERENCES warehouses (id),
  variant_id     uuid NOT NULL REFERENCES product_variants (id),
  kind           text NOT NULL CHECK (kind IN ('adjustment', 'loss', 'damage')),
  -- Ajuste com sinal; perda e avaria sempre positivas (sao saidas).
  qty            numeric(14,3) NOT NULL CHECK (qty <> 0),
  reason         text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'canceled')),
  request_key    text NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  requested_by   uuid NOT NULL REFERENCES users (id),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  decided_by     uuid REFERENCES users (id),
  decided_at     timestamptz,
  decision_note  text CHECK (length(decision_note) <= 300),
  movement_id    bigint REFERENCES stock_movements (id),
  CONSTRAINT stock_adjustment_requests_sign CHECK (kind = 'adjustment' OR qty > 0),
  CONSTRAINT stock_adjustment_requests_decided CHECK ((status = 'pending') = (decided_at IS NULL) AND (decided_at IS NULL) = (decided_by IS NULL)),
  CONSTRAINT stock_adjustment_requests_movement CHECK ((status = 'approved') = (movement_id IS NOT NULL)),
  CONSTRAINT stock_adjustment_requests_four_eyes CHECK (status NOT IN ('approved', 'rejected') OR decided_by <> requested_by)
);
CREATE INDEX stock_adjustment_requests_pending_idx ON stock_adjustment_requests (requested_at) WHERE status = 'pending';

-- ---------------------------------------------------------------------------------------------------------------
-- Inventario por deposito: as contagens existentes ficam no padrao; uma aberta por deposito.
ALTER TABLE inventory_counts ADD COLUMN warehouse_id uuid REFERENCES warehouses (id);
UPDATE inventory_counts SET warehouse_id = (SELECT id FROM warehouses WHERE is_default);
ALTER TABLE inventory_counts ALTER COLUMN warehouse_id SET NOT NULL;
DROP INDEX inventory_counts_one_open;
CREATE UNIQUE INDEX inventory_counts_one_open_per_warehouse ON inventory_counts (warehouse_id) WHERE status = 'open';
-- Contagem aberta sem deposito (codigo anterior a Fase 3, durante a troca de versao) vai para o padrao.
CREATE FUNCTION inventory_counts_default_warehouse() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.warehouse_id := coalesce(NEW.warehouse_id, (SELECT id FROM warehouses WHERE is_default));
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_counts_default_warehouse BEFORE INSERT ON inventory_counts FOR EACH ROW EXECUTE FUNCTION inventory_counts_default_warehouse();

-- ---------------------------------------------------------------------------------------------------------------
-- Conferencia (0020) ampliada aos saldos novos.
--   C1-C3 passam a valer para blocked, damaged e in_transit (abertura zero: nasceram aqui)
--   C6 em transito do total = soma do pendente das transferencias abertas
--   C7 estorno com deltas opostos aos do original
ALTER TABLE stock_reconciliations DROP CONSTRAINT stock_reconciliations_check_code_check;
ALTER TABLE stock_reconciliations ADD CONSTRAINT stock_reconciliations_check_code_check
  CHECK (check_code IN ('run', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'));
ALTER TABLE stock_reconciliations DROP CONSTRAINT stock_reconciliations_field_check;
ALTER TABLE stock_reconciliations ADD CONSTRAINT stock_reconciliations_field_check
  CHECK (field IN ('on_hand', 'reserved', 'blocked', 'damaged', 'in_transit'));

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

-- ---------------------------------------------------------------------------------------------------------------
-- Privilegios minimos. Saldos continuam so por movimento; historicos so por inclusao.
GRANT INSERT, UPDATE ON warehouses TO loja_app;
GRANT SELECT, INSERT, UPDATE ON stock_transfers, stock_transfer_items, stock_location_settings, stock_adjustment_requests TO loja_app;
GRANT SELECT, INSERT ON stock_transfer_events TO loja_app;
GRANT SELECT ON stock_location_alerts TO loja_app;
GRANT USAGE ON SEQUENCE stock_transfer_number, stock_adjustment_request_number TO loja_app;

-- Resumo para quem aplica.
DO $$
DECLARE ms numeric; n_wh integer; n_var integer; n_cnt integer;
BEGIN
  ms := round(extract(epoch FROM clock_timestamp() - current_setting('sglog.t0')::timestamptz) * 1000);
  SELECT count(*) INTO n_wh FROM warehouses;
  SELECT count(*) INTO n_var FROM stock_location_balances;
  SELECT count(*) INTO n_cnt FROM inventory_counts;
  RAISE NOTICE '0022: saldo de estoque bloqueado por % ms (ate aqui; o bloqueio termina no COMMIT)', ms;
  RAISE NOTICE '0022: % deposito(s), % linha(s) de saldo por deposito (saldos novos em zero), % contagem(ns) de inventario no deposito padrao', n_wh, n_var, n_cnt;
END $$;
