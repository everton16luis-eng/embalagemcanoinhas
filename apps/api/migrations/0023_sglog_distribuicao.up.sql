-- SGLog Fase 4: alocacao de estoque nos pedidos (docs/22-sglog-fase4-planejamento.md e docs/23-sglog-fase4.md).
-- Situacao logistica do pedido separada da comercial (D1), atendimentos por origem (deposito ou fornecedor),
-- alocacoes por item, historico imutavel das decisoes, reserva por deposito e por alocacao, trava do dropshipping
-- (D3) e conferencia C8 (reservado por deposito) e C9 (alocacao x reserva).
-- Nada do que existe muda de comportamento: orders.status e suas transicoes continuam iguais; o checkout continua
-- reservando no deposito padrao; vitrine, marketplaces, orcamentos, bot e relatorios continuam lendo o total.
-- Colunas novas com valor padrao constante (so metadado). O preenchimento toca so os pedidos pagos e as reservas
-- ativas.

-- Bloqueios, todos antes de qualquer alteracao, com a tecnica da 0020-0022: espera so o primeiro, pede os demais
-- com NOWAIT; ocupado, solta tudo, espera 20 ms e tenta de novo. Teto de 10 s.
--   orders                  ACCESS EXCLUSIVE     colunas novas, preenchimento e gatilhos (checkout e pagamento esperam)
--   stock_reservations      ACCESS EXCLUSIVE     colunas, indices e preenchimento do deposito
--   stock_reconciliations   ACCESS EXCLUSIVE     coluna e CHECK ampliado
--   warehouses              ACCESS EXCLUSIVE     prioridade de alocacao
--   order_items, suppliers, supplier_products, purchase_orders, product_variants, users
--                           SHARE ROW EXCLUSIVE  FKs novas (leitura continua)
SET LOCAL lock_timeout = '10s';
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '10 seconds'; tries integer := 0; waited numeric;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE orders IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE stock_reservations IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE stock_reconciliations IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE warehouses IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE order_items IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE suppliers IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE supplier_products IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE purchase_orders IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE product_variants IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF clock_timestamp() > deadline THEN
        RAISE EXCEPTION '0023: pedidos ou reservas ocupados por mais de 10 s (% tentativas); nada foi alterado, tente de novo', tries
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.02);
    END;
  END LOOP;
  waited := round(extract(epoch FROM clock_timestamp() - (deadline - interval '10 seconds')) * 1000);
  RAISE NOTICE '0023: bloqueios obtidos em % ms (% nova(s) tentativa(s))', waited, tries;
END $$;
SELECT set_config('sglog.t0', clock_timestamp()::text, true);

-- Pre-condicoes: o que a 0020-0022 deixou precisa estar intacto.
DO $$
BEGIN
  IF (SELECT count(*) FROM warehouses WHERE is_default) <> 1 THEN
    RAISE EXCEPTION '0023: era esperado exatamente um deposito padrao' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_reservations WHERE status = 'active' AND source_type = 'order'
             GROUP BY source_id, variant_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION '0023: ha pedido com mais de uma reserva ativa para a mesma variante' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Situacao logistica do pedido (D1). orders.status, o CHECK dele e as transicoes nao mudam.
ALTER TABLE orders
  ADD COLUMN logistics_status    text CONSTRAINT orders_logistics_status_check CHECK (logistics_status IN (
    'awaiting', 'analysis', 'processing', 'partially_shipped', 'shipped', 'partially_delivered', 'completed', 'canceled')),
  -- Motivo visivel da analise (falta, divisao, fornecedor, erro do motor).
  ADD COLUMN logistics_note      text CONSTRAINT orders_logistics_note_check CHECK (length(logistics_note) <= 500),
  ADD COLUMN logistics_version   integer NOT NULL DEFAULT 0,
  -- Pedido pago depois da 0023: so despacha com alocacao confirmada (D4-7). Os anteriores ficam isentos.
  ADD COLUMN allocation_required boolean NOT NULL DEFAULT false,
  -- Ultima passagem da rotina de alocacao (reparte a fila entre as rodadas).
  ADD COLUMN logistics_checked_at timestamptz;

-- Pedidos existentes (D4-8). Abertos e pagos entram na fila; os encerrados recebem a situacao equivalente.
UPDATE orders SET logistics_status = CASE status
    WHEN 'paid' THEN 'awaiting' WHEN 'preparing' THEN 'awaiting' WHEN 'ready' THEN 'awaiting'
    WHEN 'shipped' THEN 'shipped' WHEN 'delivered' THEN 'completed' WHEN 'canceled' THEN 'canceled' END
 WHERE status <> 'pending_payment' AND (status <> 'canceled' OR paid_at IS NOT NULL);
CREATE INDEX orders_logistics_queue_idx ON orders (logistics_status, paid_at) WHERE logistics_status IN ('awaiting', 'analysis', 'processing');

-- Prioridade do deposito na alocacao (D4-6): menor primeiro, depois do padrao.
ALTER TABLE warehouses ADD COLUMN allocation_priority integer NOT NULL DEFAULT 100
  CONSTRAINT warehouses_allocation_priority_check CHECK (allocation_priority BETWEEN 0 AND 999);

-- ---------------------------------------------------------------------------------------------------------------
-- Trava do dropshipping (D3): linha unica. Liberar exige quem validou o tratamento fiscal, quem liberou e quando.
CREATE TABLE logistics_settings (
  id                     boolean PRIMARY KEY DEFAULT true CHECK (id),
  dropship_status        text NOT NULL DEFAULT 'blocked' CHECK (dropship_status IN ('blocked', 'enabled')),
  fiscal_validator_name  text CHECK (length(fiscal_validator_name) BETWEEN 3 AND 120),
  validated_by           uuid REFERENCES users (id),
  validated_at           timestamptz,
  version                integer NOT NULL DEFAULT 0,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT logistics_settings_dropship_validated CHECK (
    dropship_status = 'blocked' OR (fiscal_validator_name IS NOT NULL AND validated_by IS NOT NULL AND validated_at IS NOT NULL))
);
INSERT INTO logistics_settings DEFAULT VALUES;

-- ---------------------------------------------------------------------------------------------------------------
-- Historico imutavel das decisoes de alocacao: entrada e saida do motor, escolha, motivo, autor.
CREATE TABLE allocation_decisions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id        uuid NOT NULL REFERENCES orders (id),
  kind            text NOT NULL CHECK (kind IN ('auto', 'manual', 'change', 'detach', 'analysis', 'shortage', 'order_canceled', 'shipped')),
  engine_version  text CHECK (length(engine_version) <= 20),
  input           jsonb,
  output          jsonb,
  chosen          jsonb,
  justification   text CHECK (length(justification) BETWEEN 3 AND 500),
  request_key     text UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  actor_id        uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT allocation_decisions_justified CHECK (kind NOT IN ('change', 'detach') OR justification IS NOT NULL)
);
CREATE INDEX allocation_decisions_order_idx ON allocation_decisions (order_id, id);
CREATE TRIGGER allocation_decisions_immutable BEFORE UPDATE OR DELETE ON allocation_decisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Atendimento: uma origem para parte do pedido.
--   stock              estoque proprio no deposito
--   purchase_to_order  encomenda: o fornecedor entrega no deposito (destino), e nos despachamos
--   dropship           o fornecedor despacha ao cliente (travado ate a validacao fiscal, D3)
CREATE TABLE fulfillments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders (id),
  source_kind        text NOT NULL CHECK (source_kind IN ('own', 'supplier')),
  mode               text NOT NULL CHECK (mode IN ('stock', 'purchase_to_order', 'dropship')),
  warehouse_id       uuid REFERENCES warehouses (id),
  supplier_id        uuid REFERENCES suppliers (id),
  purchase_order_id  uuid REFERENCES purchase_orders (id),
  status             text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'done', 'canceled')),
  origin_snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision_id        bigint NOT NULL REFERENCES allocation_decisions (id),
  cancel_reason      text CHECK (length(cancel_reason) BETWEEN 3 AND 500),
  created_by         uuid REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  closed_at          timestamptz,
  CONSTRAINT fulfillments_source CHECK (CASE mode
    WHEN 'stock'             THEN source_kind = 'own' AND warehouse_id IS NOT NULL AND supplier_id IS NULL
    WHEN 'purchase_to_order' THEN source_kind = 'supplier' AND warehouse_id IS NOT NULL AND supplier_id IS NOT NULL
    ELSE source_kind = 'supplier' AND warehouse_id IS NULL AND supplier_id IS NOT NULL END),
  CONSTRAINT fulfillments_closed CHECK ((status = 'confirmed') = (closed_at IS NULL)),
  CONSTRAINT fulfillments_cancel_reason CHECK ((status = 'canceled') = (cancel_reason IS NOT NULL))
);
CREATE INDEX fulfillments_order_idx ON fulfillments (order_id);
CREATE INDEX fulfillments_open_idx ON fulfillments (warehouse_id) WHERE status = 'confirmed';

-- Dropshipping travado no banco, alem da API e da tela.
CREATE FUNCTION fulfillments_dropship_lock() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (SELECT dropship_status FROM logistics_settings) IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'dropshipping bloqueado ate a validacao fiscal' USING ERRCODE = 'restrict_violation', CONSTRAINT = 'logistics_dropship_blocked';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fulfillments_dropship_lock BEFORE INSERT ON fulfillments FOR EACH ROW WHEN (NEW.mode = 'dropship')
  EXECUTE FUNCTION fulfillments_dropship_lock();

-- Alocacao: item do pedido x atendimento x quantidade (unidade base).
CREATE TABLE fulfillment_allocations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fulfillment_id       uuid NOT NULL REFERENCES fulfillments (id),
  order_id             uuid NOT NULL REFERENCES orders (id),
  order_item_id        uuid NOT NULL REFERENCES order_items (id),
  variant_id           uuid NOT NULL REFERENCES product_variants (id),
  base_qty             numeric(14,3) NOT NULL CHECK (base_qty > 0),
  -- Deposito da reserva (proprio ou destino da encomenda); nulo no dropshipping, que nao reserva.
  warehouse_id         uuid REFERENCES warehouses (id),
  supplier_product_id  uuid REFERENCES supplier_products (id),
  unit_cost_cents      numeric(16,4) CHECK (unit_cost_cents >= 0),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled')),
  created_by           uuid REFERENCES users (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  canceled_at          timestamptz,
  CONSTRAINT fulfillment_allocations_closed CHECK ((status = 'canceled') = (canceled_at IS NOT NULL))
);
CREATE INDEX fulfillment_allocations_fulfillment_idx ON fulfillment_allocations (fulfillment_id);
CREATE INDEX fulfillment_allocations_item_idx ON fulfillment_allocations (order_item_id) WHERE status = 'active';
CREATE INDEX fulfillment_allocations_order_idx ON fulfillment_allocations (order_id);

-- Teto por item: a soma das alocacoes ativas nunca passa da quantidade vendida; a variante e a do item.
CREATE FUNCTION fulfillment_allocations_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE it order_items; total numeric;
BEGIN
  IF NEW.status <> 'active' THEN RETURN NEW; END IF;
  SELECT * INTO it FROM order_items WHERE id = NEW.order_item_id;
  IF it.order_id <> NEW.order_id OR it.variant_id <> NEW.variant_id THEN
    RAISE EXCEPTION 'alocacao com pedido ou variante diferente do item' USING ERRCODE = 'check_violation', CONSTRAINT = 'fulfillment_allocations_item';
  END IF;
  SELECT coalesce(sum(base_qty), 0) INTO total FROM fulfillment_allocations
   WHERE order_item_id = NEW.order_item_id AND status = 'active' AND id <> NEW.id;
  IF total + NEW.base_qty > it.base_qty_per_pack * it.packs THEN
    RAISE EXCEPTION 'alocacao acima da quantidade vendida do item' USING ERRCODE = 'check_violation', CONSTRAINT = 'fulfillment_allocations_over';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fulfillment_allocations_check BEFORE INSERT OR UPDATE ON fulfillment_allocations FOR EACH ROW
  EXECUTE FUNCTION fulfillment_allocations_check();

-- ---------------------------------------------------------------------------------------------------------------
-- Reserva por deposito e por alocacao. Nulo = padrao (como no livro). As ativas recebem o padrao agora.
ALTER TABLE stock_reservations
  ADD COLUMN warehouse_id  uuid REFERENCES warehouses (id),
  ADD COLUMN allocation_id uuid REFERENCES fulfillment_allocations (id),
  ADD CONSTRAINT stock_reservations_allocation_source CHECK (allocation_id IS NULL OR source_type = 'order');
UPDATE stock_reservations SET warehouse_id = (SELECT id FROM warehouses WHERE is_default) WHERE status = 'active';
-- Uma reserva ativa por origem e variante, ou por alocacao (pedido dividido entre origens).
DROP INDEX stock_reservations_source_unique;
CREATE UNIQUE INDEX stock_reservations_source_unique ON stock_reservations
  (source_type, source_id, variant_id, coalesce(allocation_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status = 'active';
CREATE UNIQUE INDEX stock_reservations_allocation_unique ON stock_reservations (allocation_id) WHERE status = 'active' AND allocation_id IS NOT NULL;
CREATE INDEX stock_reservations_order_idx ON stock_reservations (source_id) WHERE status = 'active' AND source_type = 'order';

-- ---------------------------------------------------------------------------------------------------------------
-- Projecao dos marcos comerciais na situacao logistica (D1): pago -> aguardando alocacao; despachado; entregue;
-- cancelado. Fica no banco para valer em todos os caminhos (pagamento, marketplace, painel, rotinas) sem mudar o
-- codigo do pagamento. O motor nunca roda aqui.
CREATE FUNCTION orders_logistics_project() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
CREATE TRIGGER orders_logistics_project BEFORE INSERT OR UPDATE OF status ON orders FOR EACH ROW EXECUTE FUNCTION orders_logistics_project();

-- Pedido cancelado ou despachado: encerra os atendimentos abertos e registra no historico. As reservas sao
-- liberadas ou consumidas pela aplicacao na mesma transacao (como antes).
CREATE FUNCTION orders_logistics_close() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
CREATE TRIGGER orders_logistics_close AFTER UPDATE OF status ON orders FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('canceled', 'shipped'))
  EXECUTE FUNCTION orders_logistics_close();

-- ---------------------------------------------------------------------------------------------------------------
-- Conferencia ampliada.
--   C8 reservado de cada deposito = soma das reservas ativas daquele deposito (o padrao inclui a diferenca da abertura)
--   C9 atendimento confirmado com reserva (estoque e encomenda): alocacao ativa = reserva ativa dela, na mesma
--      quantidade e no mesmo deposito; e nenhuma reserva ativa aponta para alocacao encerrada
ALTER TABLE stock_reconciliations ADD COLUMN warehouse_id uuid;
ALTER TABLE stock_reconciliations DROP CONSTRAINT stock_reconciliations_check_code_check;
ALTER TABLE stock_reconciliations ADD CONSTRAINT stock_reconciliations_check_code_check
  CHECK (check_code IN ('run', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'));

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

-- ---------------------------------------------------------------------------------------------------------------
-- Privilegios minimos. Historico de decisoes so por inclusao; nada e apagado pela aplicacao.
GRANT SELECT, INSERT, UPDATE ON fulfillments, fulfillment_allocations TO loja_app;
GRANT SELECT, INSERT ON allocation_decisions TO loja_app;
GRANT SELECT, UPDATE ON logistics_settings TO loja_app;

-- Resumo para quem aplica.
DO $$
DECLARE ms numeric; n_wait integer; n_res integer; n_closed integer;
BEGIN
  ms := round(extract(epoch FROM clock_timestamp() - current_setting('sglog.t0')::timestamptz) * 1000);
  SELECT count(*) INTO n_wait FROM orders WHERE logistics_status = 'awaiting';
  SELECT count(*) INTO n_closed FROM orders WHERE logistics_status IN ('shipped', 'completed', 'canceled');
  SELECT count(*) INTO n_res FROM stock_reservations WHERE status = 'active';
  RAISE NOTICE '0023: pedidos e reservas bloqueados por % ms (ate aqui; o bloqueio termina no COMMIT)', ms;
  RAISE NOTICE '0023: % pedido(s) pago(s) em aberto aguardando alocacao, % encerrado(s) com situacao logistica, % reserva(s) ativa(s) no deposito padrao', n_wait, n_closed, n_res;
END $$;
