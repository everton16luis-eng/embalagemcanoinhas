-- SGLog Fase 5: remessas, separacao, conferencia e expedicao (docs/25-sglog-fase5-planejamento.md e
-- docs/26-sglog-fase5.md).
-- - Varias remessas por pedido (fim do UNIQUE em shipments.order_id). As remessas antigas viram 'legacy', com a
--   situacao tirada do que ja estava gravado (despachada ou entregue). O despacho antigo continua inserindo assim.
-- - Itens da remessa por alocacao, com o teto (soma das remessas abertas e despachadas <= alocacao) no banco.
-- - Historico imutavel da separacao e da conferencia (shipment_checks) e das mudancas de situacao (shipment_events).
-- - Remessas multiplas TRAVADAS (D5-4) ate a validacao fiscal; conferente diferente do separador opcional (D5-7).
-- - Projecao: despacho parcial nao encerra os atendimentos; o comercial continua projetado pelos gatilhos da 0023.
-- - Conferencia C9 passa a descontar o que ja foi despachado; C10 (baixa da remessa) e C11 (separacao x historico
--   e itens abertos x reserva).
-- Nada do que existe muda de comportamento: checkout, pagamento, NF-e, marketplaces e o despacho dos pedidos
-- antigos continuam iguais.

-- Bloqueios, tecnica da 0020-0023: espera so o primeiro, pede os demais com NOWAIT; ocupado, solta e tenta de novo.
--   shipments               ACCESS EXCLUSIVE     UNIQUE removido, colunas novas, preenchimento
--   whatsapp_messages       ACCESS EXCLUSIVE     unicidade por remessa
--   stock_reconciliations   ACCESS EXCLUSIVE     CHECKs ampliados
--   logistics_settings      ACCESS EXCLUSIVE     travas novas
--   orders, fulfillments, fulfillment_allocations, order_items, warehouses, product_variants, users
--                           SHARE ROW EXCLUSIVE  FKs novas e leitura consistente do preenchimento
SET LOCAL lock_timeout = '10s';
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '10 seconds'; tries integer := 0; waited numeric;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE orders IN SHARE ROW EXCLUSIVE MODE;
      LOCK TABLE shipments IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE whatsapp_messages IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE stock_reconciliations IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE logistics_settings IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE fulfillments IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE fulfillment_allocations IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE order_items IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE warehouses IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE product_variants IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF clock_timestamp() > deadline THEN
        RAISE EXCEPTION '0024: pedidos ou remessas ocupados por mais de 10 s (% tentativas); nada foi alterado, tente de novo', tries
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.02);
    END;
  END LOOP;
  waited := round(extract(epoch FROM clock_timestamp() - (deadline - interval '10 seconds')) * 1000);
  RAISE NOTICE '0024: bloqueios obtidos em % ms (% nova(s) tentativa(s))', waited, tries;
END $$;
SELECT set_config('sglog.t0', clock_timestamp()::text, true);

-- Pre-condicao: uma remessa por pedido (o UNIQUE da 0005 garante; conferido para relatar).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM shipments GROUP BY order_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION '0024: ha pedido com mais de uma remessa antes da migracao' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Remessas. As colunas com valor padrao constante descrevem as linhas antigas (e o despacho antigo, que continua
-- inserindo sem informar): kind 'legacy', situacao 'shipped'. As entregues sao ajustadas logo abaixo.
ALTER TABLE shipments DROP CONSTRAINT shipments_order_id_key;
ALTER TABLE shipments
  ADD COLUMN seq                integer NOT NULL DEFAULT 1 CONSTRAINT shipments_seq_check CHECK (seq BETWEEN 1 AND 999),
  ADD COLUMN kind               text NOT NULL DEFAULT 'legacy' CONSTRAINT shipments_kind_check CHECK (kind IN ('legacy', 'delivery', 'pickup', 'marketplace')),
  -- Fase 5 usa pending..delivered e canceled; in_transit/out_for_delivery ficam para a Fase 8 e
  -- delivery_failed/returned para a Fase 9 (D5-2).
  ADD COLUMN status             text NOT NULL DEFAULT 'shipped' CONSTRAINT shipments_status_check CHECK (status IN (
    'pending', 'picking', 'checking', 'packed', 'shipped', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'returned', 'canceled')),
  ADD COLUMN warehouse_id       uuid REFERENCES warehouses (id),
  -- Volumes da embalagem: [{ weightG, lengthMm, widthMm, heightMm }]. Os campos volumes e weight_g continuam (totais).
  ADD COLUMN packages           jsonb CONSTRAINT shipments_packages_check CHECK (packages IS NULL OR jsonb_typeof(packages) = 'array'),
  ADD COLUMN version            integer NOT NULL DEFAULT 0,
  ADD COLUMN picking_started_at timestamptz,
  ADD COLUMN checked_at         timestamptz,
  ADD COLUMN packed_at          timestamptz,
  ADD COLUMN canceled_at        timestamptz,
  ADD COLUMN cancel_reason      text CONSTRAINT shipments_cancel_reason_check CHECK (length(cancel_reason) BETWEEN 3 AND 500),
  ADD COLUMN created_by         uuid REFERENCES users (id),
  ADD COLUMN updated_at         timestamptz NOT NULL DEFAULT now();
UPDATE shipments SET status = 'delivered' WHERE delivered_at IS NOT NULL;
ALTER TABLE shipments
  ADD CONSTRAINT shipments_new_has_warehouse CHECK (kind = 'legacy' OR warehouse_id IS NOT NULL),
  ADD CONSTRAINT shipments_canceled CHECK ((status = 'canceled') = (canceled_at IS NOT NULL AND cancel_reason IS NOT NULL));
CREATE UNIQUE INDEX shipments_order_seq ON shipments (order_id, seq);
CREATE INDEX shipments_order_idx ON shipments (order_id);
CREATE INDEX shipments_open_idx ON shipments (warehouse_id, status, created_at) WHERE status IN ('pending', 'picking', 'checking', 'packed');

-- Itens: alocacao x quantidade. separado <= previsto; conferido <= separado (D5, ajustes 1 e 2).
CREATE TABLE shipment_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id    uuid NOT NULL REFERENCES shipments (id),
  allocation_id  uuid NOT NULL REFERENCES fulfillment_allocations (id),
  order_item_id  uuid NOT NULL REFERENCES order_items (id),
  variant_id     uuid NOT NULL REFERENCES product_variants (id),
  base_qty       numeric(14,3) NOT NULL CHECK (base_qty > 0),
  picked_qty     numeric(14,3) NOT NULL DEFAULT 0,
  checked_qty    numeric(14,3) NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipment_items_picked CHECK (picked_qty >= 0 AND picked_qty <= base_qty),
  CONSTRAINT shipment_items_checked CHECK (checked_qty >= 0 AND checked_qty <= picked_qty)
);
CREATE INDEX shipment_items_shipment_idx ON shipment_items (shipment_id);
CREATE INDEX shipment_items_allocation_idx ON shipment_items (allocation_id) WHERE status = 'active';

-- Teto: o que esta em remessa ativa (aberta ou despachada) nunca passa da alocacao; item e alocacao do mesmo pedido,
-- da mesma variante e do mesmo deposito da remessa. Trava a alocacao: duas remessas nao usam a mesma quantidade.
CREATE FUNCTION shipment_items_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a fulfillment_allocations; s shipments; total numeric;
BEGIN
  IF NEW.status <> 'active' THEN RETURN NEW; END IF;
  SELECT * INTO a FROM fulfillment_allocations WHERE id = NEW.allocation_id FOR UPDATE;
  SELECT * INTO s FROM shipments WHERE id = NEW.shipment_id;
  IF a.order_item_id <> NEW.order_item_id OR a.variant_id <> NEW.variant_id OR a.order_id <> s.order_id
     OR a.warehouse_id IS DISTINCT FROM s.warehouse_id THEN
    RAISE EXCEPTION 'item da remessa diferente da alocacao (pedido, item, variante ou deposito)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'shipment_items_allocation';
  END IF;
  IF TG_OP = 'INSERT' AND a.status <> 'active' THEN
    RAISE EXCEPTION 'alocacao encerrada nao entra em remessa' USING ERRCODE = 'check_violation', CONSTRAINT = 'shipment_items_allocation';
  END IF;
  SELECT coalesce(sum(i.base_qty), 0) INTO total FROM shipment_items i JOIN shipments x ON x.id = i.shipment_id
   WHERE i.allocation_id = NEW.allocation_id AND i.status = 'active' AND x.status <> 'canceled' AND i.id <> NEW.id;
  IF total + NEW.base_qty > a.base_qty THEN
    RAISE EXCEPTION 'remessas acima da quantidade alocada' USING ERRCODE = 'check_violation', CONSTRAINT = 'shipment_items_over';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shipment_items_check BEFORE INSERT OR UPDATE OF base_qty, status, allocation_id ON shipment_items FOR EACH ROW
  EXECUTE FUNCTION shipment_items_check();

-- Historico da separacao e da conferencia. Correcao e um novo registro (unpick, check_undo), nunca edicao.
--   pick / unpick           quantidade separada / devolvida ao lugar
--   check / check_undo      quantidade conferida / conferencia desfeita (erro operacional)
--   shortage                falta registrada na separacao
--   rejected                tentativa recusada (SKU de fora, acima do previsto); nao muda nada
CREATE TABLE shipment_checks (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id       uuid NOT NULL REFERENCES shipments (id),
  shipment_item_id  uuid REFERENCES shipment_items (id),
  kind              text NOT NULL CHECK (kind IN ('pick', 'unpick', 'check', 'check_undo', 'shortage', 'rejected')),
  sku_read          text CHECK (length(sku_read) <= 80),
  qty               numeric(14,3) NOT NULL CHECK (qty >= 0),
  result            text NOT NULL CHECK (result IN ('ok', 'over', 'wrong_sku', 'mismatch', 'shortage', 'corrected')),
  note              text CHECK (length(note) <= 300),
  -- Repeticao do mesmo registro (duplo clique, rede) nao conta duas vezes.
  request_key       text UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  actor_id          uuid REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipment_checks_item CHECK (kind = 'rejected' OR shipment_item_id IS NOT NULL),
  CONSTRAINT shipment_checks_note CHECK (kind NOT IN ('unpick', 'check_undo', 'shortage') OR note IS NOT NULL)
);
CREATE INDEX shipment_checks_shipment_idx ON shipment_checks (shipment_id, id);
CREATE INDEX shipment_checks_item_idx ON shipment_checks (shipment_item_id);
CREATE TRIGGER shipment_checks_immutable BEFORE UPDATE OR DELETE ON shipment_checks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Mudancas de situacao da remessa. request_key: repeticao de uma acao devolve o resultado sem agir de novo.
-- provider_event_id: rastreio do transportador (Fase 8) duplicado e ignorado.
CREATE TABLE shipment_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id        uuid NOT NULL REFERENCES shipments (id),
  from_status        text,
  to_status          text NOT NULL,
  action             text NOT NULL CHECK (length(action) BETWEEN 2 AND 40),
  source             text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'system', 'carrier', 'marketplace')),
  provider_event_id  text CHECK (length(provider_event_id) <= 120),
  request_key        text UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  note               text CHECK (length(note) <= 500),
  actor_id           uuid REFERENCES users (id),
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shipment_id, provider_event_id)
);
CREATE INDEX shipment_events_shipment_idx ON shipment_events (shipment_id, id);
CREATE TRIGGER shipment_events_immutable BEFORE UPDATE OR DELETE ON shipment_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- WhatsApp: um aviso por evento e remessa (R12). Pedido sem remessa (pago, pronto) continua com um por evento.
ALTER TABLE whatsapp_messages ADD COLUMN shipment_id uuid REFERENCES shipments (id);
ALTER TABLE whatsapp_messages DROP CONSTRAINT whatsapp_messages_order_id_event_key;
CREATE UNIQUE INDEX whatsapp_messages_order_event_shipment ON whatsapp_messages
  (order_id, event, coalesce(shipment_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------------------------------------------------------------------------------------------------------------
-- Travas e opcoes da expedicao.
--   multi_shipment_status  dividir o pedido em mais de uma remessa (entrega parcial). Bloqueado ate o contador
--                          validar o tratamento fiscal (D5-4), com o registro de quem validou, como o dropshipping.
--   distinct_checker       conferente diferente de quem separou (D5-7), desligado de inicio.
ALTER TABLE logistics_settings
  ADD COLUMN multi_shipment_status    text NOT NULL DEFAULT 'blocked' CONSTRAINT logistics_settings_multi_status_check CHECK (multi_shipment_status IN ('blocked', 'enabled')),
  ADD COLUMN multi_validator_name     text CONSTRAINT logistics_settings_multi_validator_check CHECK (length(multi_validator_name) BETWEEN 3 AND 120),
  ADD COLUMN multi_validated_by       uuid REFERENCES users (id),
  ADD COLUMN multi_validated_at       timestamptz,
  ADD COLUMN distinct_checker         boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT logistics_settings_multi_validated CHECK (
    multi_shipment_status = 'blocked' OR (multi_validator_name IS NOT NULL AND multi_validated_by IS NOT NULL AND multi_validated_at IS NOT NULL));

-- ---------------------------------------------------------------------------------------------------------------
-- Projecao (D5-5). Igual a 0023, com duas diferencas:
--   - despacho parcial: a aplicacao grava 'partially_shipped' junto com o comercial 'shipped' e o gatilho mantem;
--   - atendimentos so encerram no despacho quando nao ha remessa nova em aberto (a ultima remessa encerra pela
--     aplicacao). O despacho antigo (sem remessa nova) encerra como antes.
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
    NEW.logistics_status := CASE WHEN NEW.logistics_status IN ('partially_shipped', 'partially_delivered') THEN NEW.logistics_status ELSE 'shipped' END;
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
    -- Remessas abertas: canceladas junto (cancelamento no painel, no marketplace ou por prazo). O que ja estava
    -- separado fica registrado como devolvido ao lugar (so registro: a mercadoria nao saiu do deposito).
    INSERT INTO shipment_checks (shipment_id, shipment_item_id, kind, qty, result, note, actor_id)
    SELECT i.shipment_id, i.id, 'check_undo', i.checked_qty, 'corrected', 'Pedido cancelado', app_user_id()
      FROM shipment_items i JOIN shipments s ON s.id = i.shipment_id
     WHERE s.order_id = NEW.id AND s.status IN ('pending', 'picking', 'checking', 'packed') AND i.checked_qty > 0;
    INSERT INTO shipment_checks (shipment_id, shipment_item_id, kind, qty, result, note, actor_id)
    SELECT i.shipment_id, i.id, 'unpick', i.picked_qty, 'corrected', 'Pedido cancelado: devolver a mercadoria ao lugar', app_user_id()
      FROM shipment_items i JOIN shipments s ON s.id = i.shipment_id
     WHERE s.order_id = NEW.id AND s.status IN ('pending', 'picking', 'checking', 'packed') AND i.picked_qty > 0;
    UPDATE shipment_items i SET checked_qty = 0, picked_qty = 0
      FROM shipments s WHERE s.id = i.shipment_id AND s.order_id = NEW.id AND s.status IN ('pending', 'picking', 'checking', 'packed')
       AND (i.picked_qty > 0 OR i.checked_qty > 0);
    INSERT INTO shipment_events (shipment_id, from_status, to_status, action, source, note, actor_id)
    SELECT id, status, 'canceled', 'order_canceled', 'system', left('Pedido cancelado: ' || coalesce(NEW.cancel_reason, ''), 500), app_user_id()
      FROM shipments WHERE order_id = NEW.id AND status IN ('pending', 'picking', 'checking', 'packed');
    UPDATE shipments SET status = 'canceled', canceled_at = now(), updated_at = now(), version = version + 1,
           cancel_reason = left('Pedido cancelado: ' || coalesce(NEW.cancel_reason, 'sem motivo'), 500)
     WHERE order_id = NEW.id AND status IN ('pending', 'picking', 'checking', 'packed');
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
    IF EXISTS (SELECT 1 FROM shipments WHERE order_id = NEW.id AND kind <> 'legacy' AND status IN ('pending', 'picking', 'checking', 'packed')) THEN
      RETURN NULL;
    END IF;
    UPDATE fulfillments SET status = 'done', closed_at = now() WHERE order_id = NEW.id AND status = 'confirmed';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      INSERT INTO allocation_decisions (order_id, kind, chosen, actor_id) VALUES (NEW.id, 'shipped', jsonb_build_object('fulfillments', n), app_user_id());
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Pedidos ja alocados e ainda nao despachados ganham a remessa 'pending' (um deposito por pedido, D4-4). Pedido
-- antigo continua podendo sair pelo despacho antigo, que cancela a remessa pendente (docs/26 §3).
WITH alloc AS (
  SELECT o.id AS order_id, o.channel, o.shipping_snapshot->>'kind' AS ship_kind, a.id AS allocation_id, a.order_item_id, a.variant_id,
         a.base_qty, a.warehouse_id
  FROM orders o
  JOIN fulfillments f ON f.order_id = o.id AND f.status = 'confirmed' AND f.mode IN ('stock', 'purchase_to_order')
  JOIN fulfillment_allocations a ON a.fulfillment_id = f.id AND a.status = 'active'
  WHERE o.logistics_status = 'processing' AND o.status IN ('paid', 'preparing', 'ready')
),
ship AS (
  INSERT INTO shipments (order_id, seq, kind, status, warehouse_id, version)
  SELECT DISTINCT ON (order_id) order_id,
         coalesce((SELECT max(seq) FROM shipments s WHERE s.order_id = alloc.order_id), 0) + 1,
         CASE WHEN channel IN ('mercadolivre', 'shopee') THEN 'marketplace' WHEN ship_kind = 'pickup' THEN 'pickup' ELSE 'delivery' END,
         'pending', warehouse_id, 0
  FROM alloc ORDER BY order_id
  RETURNING id, order_id
),
items AS (
  INSERT INTO shipment_items (shipment_id, allocation_id, order_item_id, variant_id, base_qty)
  SELECT ship.id, alloc.allocation_id, alloc.order_item_id, alloc.variant_id, alloc.base_qty
  FROM alloc JOIN ship ON ship.order_id = alloc.order_id
  RETURNING shipment_id
)
INSERT INTO shipment_events (shipment_id, from_status, to_status, action, source, note)
SELECT id, NULL, 'pending', 'create', 'system', 'Remessa criada na implantação da Fase 5 (pedido já alocado)' FROM ship;

-- ---------------------------------------------------------------------------------------------------------------
-- Conferencia ampliada.
--   C9  alocacao ativa = reserva ativa dela, DESCONTADO o que ja foi despachado em remessa
--   C10 remessa despachada: soma dos itens = baixa (venda) registrada com o documento da remessa
--   C11 item de remessa: separado e conferido = historico; itens abertos de uma alocacao <= reserva ativa dela
ALTER TABLE stock_reconciliations DROP CONSTRAINT stock_reconciliations_check_code_check;
ALTER TABLE stock_reconciliations ADD CONSTRAINT stock_reconciliations_check_code_check
  CHECK (check_code IN ('run', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11'));
ALTER TABLE stock_reconciliations DROP CONSTRAINT stock_reconciliations_field_check;
ALTER TABLE stock_reconciliations ADD CONSTRAINT stock_reconciliations_field_check
  CHECK (field IN ('on_hand', 'reserved', 'blocked', 'damaged', 'in_transit', 'shipped', 'picked', 'checked'));

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

-- ---------------------------------------------------------------------------------------------------------------
-- Privilegios minimos: nada e apagado pela aplicacao; historicos so por inclusao.
GRANT SELECT, INSERT, UPDATE ON shipment_items TO loja_app;
GRANT SELECT, INSERT ON shipment_checks, shipment_events TO loja_app;

-- Resumo para quem aplica.
DO $$
DECLARE ms numeric; n_legacy integer; n_delivered integer; n_new integer;
BEGIN
  ms := round(extract(epoch FROM clock_timestamp() - current_setting('sglog.t0')::timestamptz) * 1000);
  SELECT count(*) INTO n_legacy FROM shipments WHERE kind = 'legacy';
  SELECT count(*) INTO n_delivered FROM shipments WHERE kind = 'legacy' AND status = 'delivered';
  SELECT count(*) INTO n_new FROM shipments WHERE kind <> 'legacy';
  RAISE NOTICE '0024: remessas bloqueadas por % ms (ate aqui; o bloqueio termina no COMMIT)', ms;
  RAISE NOTICE '0024: % remessa(s) antiga(s) (% entregue(s)), % remessa(s) pendente(s) criada(s) para pedido(s) ja alocado(s)', n_legacy, n_delivered, n_new;
END $$;
