-- SGLog Fase 6: compras, recebimento por deposito e conversao das encomendas (docs/28-sglog-fase6-planejamento.md e
-- docs/29-sglog-fase6.md).
-- - Compra com finalidade (reposicao x encomenda), deposito de destino, aprovacao (limite configuravel), pagamento
--   INFORMADO (so registro: nao e pagamento confirmado por provedor) e rastreio.
-- - Recebimento no deposito de destino: quantidade fisica, quantidade recusada (vai para bloqueado ou avariado) e
--   divergencias imutaveis (falta, qualidade, preco, item errado).
-- - Vinculo encomenda x compra (prioridade, sem exclusividade) e conversao da reserva de encomenda em firme, com
--   historico imutavel e uma conversao por reserva.
-- - Conferencia C12 (recebimento x movimentos) e C13 (vinculos e conversoes).
--
-- D6-13: ADITIVA e compativel com o codigo anterior (0695c56). Nada do que o codigo antigo usa e removido ou passa a
-- ser exigido: colunas novas tem padrao ou sao preenchidas por gatilho (deposito da compra e do recebimento e o
-- deposito do movimento de entrada). A volta, se preciso, e so do codigo.
-- Checkout, pagamento, NF-e, marketplaces, remessas e as travas (ALLOCATION_AUTO, dropshipping, remessas multiplas)
-- nao mudam.

-- Bloqueios, tecnica da 0020-0024: espera so o primeiro, pede os demais com NOWAIT; ocupado, solta e tenta de novo.
--   purchase_orders, purchase_order_items, purchase_receipts, purchase_receipt_items
--                           ACCESS EXCLUSIVE     colunas, CHECKs e gatilhos novos
--   stock_reconciliations   ACCESS EXCLUSIVE     CHECKs ampliados
--   logistics_settings      ACCESS EXCLUSIVE     limite de aprovacao e tolerancia de preco
--   stock_movements         SHARE ROW EXCLUSIVE  gatilho novo (deposito da entrada de compra)
--   fulfillment_allocations SHARE ROW EXCLUSIVE  gatilho novo (encerra vinculos)
--   stock_reservations, warehouses, users
--                           SHARE ROW EXCLUSIVE  FKs novas
SET LOCAL lock_timeout = '10s';
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '10 seconds'; tries integer := 0; waited numeric;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE purchase_orders IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE purchase_order_items IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE purchase_receipts IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE purchase_receipt_items IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE stock_reconciliations IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE logistics_settings IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE stock_movements IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE fulfillment_allocations IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE stock_reservations IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE warehouses IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF clock_timestamp() > deadline THEN
        RAISE EXCEPTION '0025: compras ou estoque ocupados por mais de 10 s (% tentativas); nada foi alterado, tente de novo', tries
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.02);
    END;
  END LOOP;
  waited := round(extract(epoch FROM clock_timestamp() - (deadline - interval '10 seconds')) * 1000);
  RAISE NOTICE '0025: bloqueios obtidos em % ms (% nova(s) tentativa(s))', waited, tries;
END $$;
SELECT set_config('sglog.t0', clock_timestamp()::text, true);

-- ---------------------------------------------------------------------------------------------------------------
-- Pedido de compra.
ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_status_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_check
  CHECK (status IN ('draft', 'pending_approval', 'approved', 'sent', 'partial', 'received', 'canceled'));
ALTER TABLE purchase_orders
  ADD COLUMN purpose                        text NOT NULL DEFAULT 'replenishment'
    CONSTRAINT purchase_orders_purpose_check CHECK (purpose IN ('replenishment', 'fulfillment')),
  -- Destino. As compras antigas e o codigo antigo (que nao informa) ficam no deposito padrao (gatilho abaixo).
  ADD COLUMN warehouse_id                   uuid REFERENCES warehouses (id),
  ADD COLUMN submitted_by                   uuid REFERENCES users (id),
  ADD COLUMN submitted_at                   timestamptz,
  ADD COLUMN approved_by                    uuid REFERENCES users (id),
  ADD COLUMN approved_at                    timestamptz,
  -- Aprovacao pelo proprio autor (so o proprietario, com justificativa, D6-4).
  ADD COLUMN approval_self                  boolean NOT NULL DEFAULT false,
  ADD COLUMN approval_note                  text CONSTRAINT purchase_orders_approval_note_check CHECK (length(approval_note) BETWEEN 3 AND 500),
  -- Pagamento INFORMADO pela equipe (D6-5). Nao e confirmacao de provedor e nao move dinheiro.
  ADD COLUMN payment_informed_on            date,
  ADD COLUMN payment_informed_amount_cents  bigint CONSTRAINT purchase_orders_payment_amount_check CHECK (payment_informed_amount_cents >= 0),
  ADD COLUMN payment_informed_ref           text CONSTRAINT purchase_orders_payment_ref_check CHECK (length(payment_informed_ref) <= 120),
  ADD COLUMN payment_informed_by            uuid REFERENCES users (id),
  ADD COLUMN payment_informed_at            timestamptz,
  ADD COLUMN carrier                        text CONSTRAINT purchase_orders_carrier_check CHECK (length(carrier) <= 80),
  ADD COLUMN tracking_code                  text CONSTRAINT purchase_orders_tracking_check CHECK (length(tracking_code) <= 60),
  -- Abaixo do limite (D6-3) a aprovacao e automatica: data sem aprovador, com a nota do motivo.
  ADD CONSTRAINT purchase_orders_approved CHECK (approved_by IS NULL OR approved_at IS NOT NULL),
  ADD CONSTRAINT purchase_orders_approval_self CHECK (NOT approval_self OR (approved_by IS NOT NULL AND approval_note IS NOT NULL)),
  ADD CONSTRAINT purchase_orders_payment_informed CHECK ((payment_informed_at IS NULL) = (payment_informed_by IS NULL)
    AND (payment_informed_at IS NULL OR payment_informed_on IS NOT NULL)),
  ADD CONSTRAINT purchase_orders_pending CHECK (status <> 'pending_approval' OR submitted_at IS NOT NULL),
  ADD CONSTRAINT purchase_orders_approved_status CHECK (status <> 'approved' OR approved_at IS NOT NULL);
UPDATE purchase_orders SET warehouse_id = (SELECT id FROM warehouses WHERE is_default);

CREATE FUNCTION purchase_orders_default_warehouse() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.warehouse_id IS NULL THEN NEW.warehouse_id := (SELECT id FROM warehouses WHERE is_default); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_orders_default_warehouse BEFORE INSERT ON purchase_orders FOR EACH ROW EXECUTE FUNCTION purchase_orders_default_warehouse();
ALTER TABLE purchase_orders ALTER COLUMN warehouse_id SET NOT NULL;
CREATE INDEX purchase_orders_open_idx ON purchase_orders (warehouse_id, status) WHERE status IN ('pending_approval', 'approved', 'sent', 'partial');

-- Historico imutavel do pedido de compra (D6: aprovacao, pagamento informado, envio, rastreio, encerramento).
CREATE TABLE purchase_order_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES purchase_orders (id),
  kind        text NOT NULL CHECK (kind IN ('submitted', 'approved', 'approval_rejected', 'back_to_draft', 'payment_informed', 'sent',
                                            'shipping_updated', 'closed_short', 'canceled')),
  note        text CHECK (length(note) BETWEEN 3 AND 500),
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id    uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_order_events_note CHECK (kind NOT IN ('approval_rejected', 'closed_short', 'canceled') OR note IS NOT NULL)
);
CREATE INDEX purchase_order_events_order_idx ON purchase_order_events (order_id, id);
CREATE TRIGGER purchase_order_events_immutable BEFORE UPDATE OR DELETE ON purchase_order_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Recebido fisicamente (received_packs, como hoje) x recusado (rejected_packs, parte do recebido). Aceito = diferenca.
ALTER TABLE purchase_order_items
  ADD COLUMN rejected_packs numeric(12,3) NOT NULL DEFAULT 0,
  ADD CONSTRAINT purchase_order_items_rejected CHECK (rejected_packs >= 0 AND rejected_packs <= received_packs);

-- ---------------------------------------------------------------------------------------------------------------
-- Recebimento. As linhas antigas nao sao reescritas (tabelas imutaveis): deposito nulo = deposito padrao, como na 0020.
ALTER TABLE purchase_receipts ADD COLUMN warehouse_id uuid REFERENCES warehouses (id);

-- D6-6: o recebimento entra no destino da compra. Sem deposito informado (codigo antigo), usa o destino.
CREATE FUNCTION purchase_receipts_warehouse() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE dest uuid := (SELECT warehouse_id FROM purchase_orders WHERE id = NEW.order_id);
BEGIN
  IF NEW.warehouse_id IS NULL THEN NEW.warehouse_id := dest; END IF;
  IF NEW.warehouse_id IS DISTINCT FROM dest THEN
    RAISE EXCEPTION 'recebimento em deposito diferente do destino da compra' USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_receipts_destination';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_receipts_warehouse BEFORE INSERT ON purchase_receipts FOR EACH ROW EXECUTE FUNCTION purchase_receipts_warehouse();

-- Compatibilidade: o codigo antigo da entrada sem deposito (= padrao). A entrada de um recebimento vai para o
-- deposito do recebimento, mesmo quando o movimento nao informa. Nunca para outro deposito.
CREATE FUNCTION stock_movements_receipt_warehouse() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE wh uuid;
BEGIN
  SELECT warehouse_id INTO wh FROM purchase_receipts WHERE id::text = NEW.source_id;
  IF NEW.warehouse_id IS NULL THEN
    NEW.warehouse_id := wh;
  ELSIF wh IS NOT NULL AND NEW.warehouse_id <> wh THEN
    RAISE EXCEPTION 'entrada de compra em deposito diferente do recebimento' USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_movements_receipt_warehouse';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_movements_receipt_warehouse BEFORE INSERT ON stock_movements FOR EACH ROW
  WHEN (NEW.source_type = 'purchase_receipt') EXECUTE FUNCTION stock_movements_receipt_warehouse();

-- Linha do recebimento: packs e base_qty continuam sendo o que chegou fisicamente (o codigo antigo grava assim e nao
-- recusa nada). Recusado: parte do que chegou, fora do disponivel (bloqueado ou avariado). Custo da nota opcional.
ALTER TABLE purchase_receipt_items
  ADD COLUMN rejected_packs            numeric(12,3) NOT NULL DEFAULT 0,
  ADD COLUMN rejected_base_qty         numeric(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN rejected_destination      text CONSTRAINT purchase_receipt_items_rejected_destination_check CHECK (rejected_destination IN ('blocked', 'damaged')),
  ADD COLUMN invoiced_pack_cost_cents  numeric(16,4) CONSTRAINT purchase_receipt_items_invoiced_check CHECK (invoiced_pack_cost_cents >= 0),
  ADD CONSTRAINT purchase_receipt_items_rejected CHECK (rejected_base_qty >= 0 AND rejected_base_qty <= base_qty
    AND rejected_packs >= 0 AND rejected_packs <= packs AND (rejected_base_qty = 0) = (rejected_destination IS NULL));

-- Divergencias do recebimento: imutaveis. Correcao e outro registro.
--   quantity    chegou menos (ou mais) do que a nota ou o pedido diz
--   quality     recusado por qualidade (vai para bloqueado ou avariado)
--   price       custo da nota diferente do pedido acima da tolerancia
--   wrong_item  item diferente do pedido (nao entra; registro)
CREATE TABLE purchase_receipt_issues (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id   uuid NOT NULL REFERENCES purchase_receipts (id),
  item_id      uuid NOT NULL REFERENCES purchase_order_items (id),
  kind         text NOT NULL CHECK (kind IN ('quantity', 'quality', 'price', 'wrong_item')),
  expected     numeric(16,4),
  found        numeric(16,4),
  qty          numeric(14,3) CHECK (qty > 0),
  destination  text CHECK (destination IN ('blocked', 'damaged')),
  note         text NOT NULL CHECK (length(note) BETWEEN 3 AND 500),
  actor_id     uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_receipt_issues_quality CHECK ((kind = 'quality') = (destination IS NOT NULL AND qty IS NOT NULL))
);
CREATE INDEX purchase_receipt_issues_receipt_idx ON purchase_receipt_issues (receipt_id);
CREATE INDEX purchase_receipt_issues_item_idx ON purchase_receipt_issues (item_id);
CREATE TRIGGER purchase_receipt_issues_immutable BEFORE UPDATE OR DELETE ON purchase_receipt_issues FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- Vinculo encomenda x compra (D6-2): prioridade na chegada, sem exclusividade.
CREATE TABLE purchase_order_links (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_item_id  uuid NOT NULL REFERENCES purchase_order_items (id),
  purchase_order_id       uuid NOT NULL REFERENCES purchase_orders (id),
  allocation_id           uuid NOT NULL REFERENCES fulfillment_allocations (id),
  -- Sem FK para orders: a FK travaria o pedido (KEY SHARE) depois da alocacao, ordem inversa da alocacao (deadlock).
  -- O gatilho confere que o pedido e o da alocacao.
  order_id                uuid NOT NULL,
  base_qty                numeric(14,3) NOT NULL CHECK (base_qty > 0),
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled')),
  cancel_reason           text CHECK (length(cancel_reason) BETWEEN 3 AND 500),
  created_by              uuid NOT NULL REFERENCES users (id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  closed_at               timestamptz,
  CONSTRAINT purchase_order_links_closed CHECK ((status = 'canceled') = (closed_at IS NOT NULL AND cancel_reason IS NOT NULL))
);
CREATE UNIQUE INDEX purchase_order_links_active ON purchase_order_links (purchase_order_item_id, allocation_id) WHERE status = 'active';
CREATE INDEX purchase_order_links_allocation_idx ON purchase_order_links (allocation_id) WHERE status = 'active';
CREATE INDEX purchase_order_links_po_idx ON purchase_order_links (purchase_order_id);

-- Mesma variante e mesmo deposito; compra aberta; encomenda ativa e confirmada; tetos por item da compra e por
-- alocacao. Trava o item da compra e a alocacao (dois vinculos simultaneos nao passam do teto).
CREATE FUNCTION purchase_order_links_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE it purchase_order_items; po purchase_orders; a fulfillment_allocations; f fulfillments; total numeric;
BEGIN
  IF NEW.status <> 'active' THEN RETURN NEW; END IF;
  SELECT * INTO it FROM purchase_order_items WHERE id = NEW.purchase_order_item_id FOR UPDATE;
  SELECT * INTO po FROM purchase_orders WHERE id = it.order_id;
  SELECT * INTO a FROM fulfillment_allocations WHERE id = NEW.allocation_id FOR UPDATE;
  SELECT * INTO f FROM fulfillments WHERE id = a.fulfillment_id;
  IF NEW.purchase_order_id <> po.id OR NEW.order_id <> a.order_id OR it.variant_id <> a.variant_id OR po.warehouse_id IS DISTINCT FROM a.warehouse_id THEN
    RAISE EXCEPTION 'vinculo com compra, pedido, variante ou deposito diferente' USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_order_links_match';
  END IF;
  IF TG_OP = 'INSERT' AND (po.status IN ('received', 'canceled') OR a.status <> 'active' OR f.status <> 'confirmed' OR f.mode <> 'purchase_to_order') THEN
    RAISE EXCEPTION 'vinculo so entre compra aberta e encomenda ativa' USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_order_links_open';
  END IF;
  SELECT coalesce(sum(base_qty), 0) INTO total FROM purchase_order_links WHERE purchase_order_item_id = NEW.purchase_order_item_id AND status = 'active' AND id <> NEW.id;
  IF total + NEW.base_qty > it.packs * it.base_qty_per_pack THEN
    RAISE EXCEPTION 'vinculos acima da quantidade comprada' USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_order_links_over_item';
  END IF;
  SELECT coalesce(sum(base_qty), 0) INTO total FROM purchase_order_links WHERE allocation_id = NEW.allocation_id AND status = 'active' AND id <> NEW.id;
  IF total + NEW.base_qty > a.base_qty THEN
    RAISE EXCEPTION 'vinculos acima da quantidade encomendada' USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_order_links_over_allocation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_order_links_check BEFORE INSERT OR UPDATE ON purchase_order_links FOR EACH ROW EXECUTE FUNCTION purchase_order_links_check();

-- Alocacao encerrada (troca, desfazer, cancelamento, despacho): os vinculos dela caem junto. Vale tambem para o
-- codigo antigo, que nao conhece os vinculos.
CREATE FUNCTION fulfillment_allocations_unlink() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE purchase_order_links SET status = 'canceled', closed_at = now(), cancel_reason = 'Alocação encerrada (troca, desfazer ou cancelamento do pedido)'
   WHERE allocation_id = NEW.id AND status = 'active';
  RETURN NEW;
END $$;
CREATE TRIGGER fulfillment_allocations_unlink AFTER UPDATE OF status ON fulfillment_allocations FOR EACH ROW
  WHEN (NEW.status = 'canceled' AND OLD.status = 'active') EXECUTE FUNCTION fulfillment_allocations_unlink();

-- Compra encerrada ou cancelada: os vinculos ativos caem (D6-8). O aviso no pedido do cliente e da API.
CREATE FUNCTION purchase_orders_unlink() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE purchase_order_links SET status = 'canceled', closed_at = now(),
         cancel_reason = CASE NEW.status WHEN 'canceled' THEN 'Compra cancelada' ELSE 'Compra encerrada' END
   WHERE purchase_order_id = NEW.id AND status = 'active';
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_orders_unlink AFTER UPDATE OF status ON purchase_orders FOR EACH ROW
  WHEN (NEW.status IN ('received', 'canceled') AND OLD.status NOT IN ('received', 'canceled')) EXECUTE FUNCTION purchase_orders_unlink();

-- ---------------------------------------------------------------------------------------------------------------
-- Conversao da encomenda em reserva firme (D6-9): uma por reserva (UNIQUE), sempre da reserva inteira.
--   linked     pela compra vinculada, no recebimento
--   queue      pela fila (data de pagamento), no recebimento
--   reprocess  pela fila, no reprocessamento manual (encomendas antigas, mercadoria que chegou por outro caminho)
--   manual     antecipacao fora da fila, com justificativa (D6-9 e D6-11)
CREATE TABLE reservation_conversions (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reservation_id     uuid NOT NULL UNIQUE REFERENCES stock_reservations (id),
  order_id           uuid NOT NULL,  -- sem FK: mesma razao de purchase_order_links; o gatilho confere com a reserva
  variant_id         uuid NOT NULL REFERENCES product_variants (id),
  warehouse_id       uuid NOT NULL REFERENCES warehouses (id),
  qty                numeric(14,3) NOT NULL CHECK (qty > 0),
  rule               text NOT NULL CHECK (rule IN ('linked', 'queue', 'reprocess', 'manual')),
  receipt_id         uuid REFERENCES purchase_receipts (id),
  purchase_order_id  uuid REFERENCES purchase_orders (id),
  justification      text CHECK (length(justification) BETWEEN 3 AND 500),
  request_key        text CHECK (length(request_key) BETWEEN 8 AND 100),
  actor_id           uuid REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_conversions_manual CHECK (rule <> 'manual' OR (justification IS NOT NULL AND actor_id IS NOT NULL)),
  CONSTRAINT reservation_conversions_receipt CHECK ((rule IN ('linked', 'queue')) = (receipt_id IS NOT NULL))
);
CREATE INDEX reservation_conversions_order_idx ON reservation_conversions (order_id);
CREATE INDEX reservation_conversions_key_idx ON reservation_conversions (request_key) WHERE request_key IS NOT NULL;
CREATE TRIGGER reservation_conversions_immutable BEFORE UPDATE OR DELETE ON reservation_conversions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- A conversao so vale para a reserva ativa de encomenda, inteira, do pedido e deposito informados, e e o unico jeito de
-- a encomenda virar firme depois de criada: muda backorder na mesma transacao (o gatilho confere).
CREATE FUNCTION reservation_conversions_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r stock_reservations;
BEGIN
  SELECT * INTO r FROM stock_reservations WHERE id = NEW.reservation_id FOR UPDATE;
  IF r.status <> 'active' OR NOT r.backorder OR r.source_type <> 'order' OR r.source_id <> NEW.order_id::text
     OR r.variant_id <> NEW.variant_id OR coalesce(r.warehouse_id, (SELECT id FROM warehouses WHERE is_default)) <> NEW.warehouse_id
     OR r.qty <> NEW.qty THEN
    RAISE EXCEPTION 'conversao so da reserva de encomenda ativa, inteira' USING ERRCODE = 'check_violation', CONSTRAINT = 'reservation_conversions_target';
  END IF;
  UPDATE stock_reservations SET backorder = false WHERE id = NEW.reservation_id;
  RETURN NEW;
END $$;
CREATE TRIGGER reservation_conversions_check BEFORE INSERT ON reservation_conversions FOR EACH ROW EXECUTE FUNCTION reservation_conversions_check();

-- ---------------------------------------------------------------------------------------------------------------
-- Regras da compra (D6-3 e D6-12). Limite 0: toda compra passa por aprovacao. Valor de producao e decisao da empresa.
ALTER TABLE logistics_settings
  ADD COLUMN purchase_approval_min_cents  bigint NOT NULL DEFAULT 0 CONSTRAINT logistics_settings_purchase_approval_check CHECK (purchase_approval_min_cents >= 0),
  ADD COLUMN purchase_price_tolerance_pct numeric(5,2) NOT NULL DEFAULT 0
    CONSTRAINT logistics_settings_price_tolerance_check CHECK (purchase_price_tolerance_pct BETWEEN 0 AND 100);

-- ---------------------------------------------------------------------------------------------------------------
-- Conferencia ampliada.
--   C12 recebimento: recebido fisicamente = entrada (receipt) do recebimento; recusado = bloqueio ou avaria com o
--       documento do recebimento; recebido e recusado do item da compra = soma das linhas dos recebimentos
--   C13 vinculos ativos <= item da compra e <= alocacao; reserva convertida ativa e firme, com a mesma quantidade
ALTER TABLE stock_reconciliations DROP CONSTRAINT stock_reconciliations_check_code_check;
ALTER TABLE stock_reconciliations ADD CONSTRAINT stock_reconciliations_check_code_check
  CHECK (check_code IN ('run', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12', 'C13'));
ALTER TABLE stock_reconciliations DROP CONSTRAINT stock_reconciliations_field_check;
ALTER TABLE stock_reconciliations ADD CONSTRAINT stock_reconciliations_field_check
  CHECK (field IN ('on_hand', 'reserved', 'blocked', 'damaged', 'in_transit', 'shipped', 'picked', 'checked', 'received', 'rejected', 'linked', 'converted'));

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

-- ---------------------------------------------------------------------------------------------------------------
-- Privilegios minimos: nada e apagado pela aplicacao; historicos so por inclusao.
GRANT SELECT, INSERT ON purchase_order_events, purchase_receipt_issues, reservation_conversions TO loja_app;
GRANT SELECT, INSERT, UPDATE ON purchase_order_links TO loja_app;

-- Resumo para quem aplica.
DO $$
DECLARE ms numeric; n_open integer; n_backorder integer; n_covered integer;
BEGIN
  ms := round(extract(epoch FROM clock_timestamp() - current_setting('sglog.t0')::timestamptz) * 1000);
  SELECT count(*) INTO n_open FROM purchase_orders WHERE status IN ('draft', 'sent', 'partial');
  SELECT count(*) INTO n_backorder FROM stock_reservations WHERE status = 'active' AND backorder;
  RAISE NOTICE '0025: compras bloqueadas por % ms (ate aqui; o bloqueio termina no COMMIT)', ms;
  RAISE NOTICE '0025: % compra(s) em aberto (rascunho, enviada ou parcial) ficam como reposicao no deposito padrao; % encomenda(s) ativa(s) NAO convertida(s) (D6-10)', n_open, n_backorder;
END $$;
