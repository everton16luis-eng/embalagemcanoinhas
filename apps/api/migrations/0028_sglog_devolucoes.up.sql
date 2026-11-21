-- SGLog Fase 9: ocorrencias, devolucoes, logistica reversa e trocas (docs/37-sglog-fase9-planejamento.md e
-- docs/38-sglog-fase9.md).
-- - Ocorrencias logisticas (logistic_occurrences, historico imutavel em occurrence_events). Ocorrencia aberta que
--   segura a conclusao impede logistics_status = 'completed': o pedido entregue fica 'on_hold' ate ela ser resolvida
--   ou cancelada. Avisos de falha na entrega e devolucao do rastreio abrem no maximo UMA ocorrencia por remessa e tipo
--   (indice unico): aviso repetido, atrasado ou fora de ordem so entra no historico. Nenhum aviso movimenta estoque.
-- - Devolucao do cliente (customer_returns, customer_return_items): autorizar NAO movimenta estoque. A soma das
--   devolucoes de um item do pedido nunca passa do despachado, e a devolucao (nao recusa) nunca passa do entregue,
--   contando as anteriores e as concorrentes (gatilho com o pedido travado). Pedido antigo (despacho anterior, sem
--   itens de remessa) usa o item do pedido.
-- - Conferencia (return_inspections, imutavel, com estorno por linha nova): unico passo que movimenta estoque, no
--   deposito que recebeu, na mesma transacao: boa = 'return'; quarentena = 'return' + 'block' (saldo bloqueado);
--   avariada = 'return' + 'damage_hold' (saldo avariado); descartada = 'return' + 'damage' (baixa); faltando = so
--   registro. Nada em quarentena ou avariado aparece como disponivel. Custo: a entrada volta pelo custo da venda
--   (avg_cost_after dos movimentos 'sale' do pedido e da variante), e o descarte entra sem custo e sai em seguida
--   (o custo medio nao muda). Detalhes em docs/38-sglog-fase9.md §3.
-- - Saida da quarentena (quarantine_decisions, imutavel): liberar ('unblock'), avariar ('unblock' + 'damage_hold')
--   ou baixar ('unblock' + 'damage'), com motivo.
-- - Estorno dos movimentos da devolucao: o gatilho de estorno da 0022 passa a aceitar a origem 'customer_return'.
-- - Conferencia do estoque ampliada: C14 (devolvido x despachado), C15 (conferido x movimentos), C16 (quarentena
--   aberta x saldo bloqueado).
--
-- ADITIVA e compativel com o codigo anterior (d76ca4f), inclusive na escrita: tabelas novas, colunas com padrao,
-- checagens ampliadas e um gatilho que so age quando ha ocorrencia (o codigo anterior nunca cria). Checkout,
-- pagamentos, NF-e, invoice_status, alocacao, expedicao, frete e marketplaces nao mudam.

-- Bloqueios, tecnica da 0020-0027: espera so o primeiro, pede os demais com NOWAIT; ocupado, solta e tenta de novo.
--   orders                 ACCESS EXCLUSIVE     checagem, coluna e gatilho novos
--   stock_movements        ACCESS EXCLUSIVE     checagens e gatilho de estorno
--   stock_reconciliations  ACCESS EXCLUSIVE     coluna e checagens
--   logistics_settings     ACCESS EXCLUSIVE     colunas novas
--   order_events           ACCESS EXCLUSIVE     coluna nova (internal)
--   demais                 SHARE ROW EXCLUSIVE  FKs novas
SET LOCAL lock_timeout = '10s';
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '10 seconds'; tries integer := 0; waited numeric;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE orders IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE stock_movements IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE stock_reconciliations IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE logistics_settings IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE order_events IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE shipments, shipment_items, shipment_events, order_items, warehouses, users, product_variants IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF clock_timestamp() > deadline THEN
        RAISE EXCEPTION '0028: pedidos ou estoque ocupados por mais de 10 s (% tentativas); nada foi alterado, tente de novo', tries
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.02);
    END;
  END LOOP;
  waited := round(extract(epoch FROM clock_timestamp() - (deadline - interval '10 seconds')) * 1000);
  RAISE NOTICE '0028: bloqueios obtidos em % ms (% nova(s) tentativa(s))', waited, tries;
END $$;
SELECT set_config('sglog.t0', clock_timestamp()::text, true);

-- ---------------------------------------------------------------------------------------------------------------
-- Politica de trocas e devolucoes da loja (D9-10): so referencia na tela. Nada e recusado por prazo.
--   return_regret_days            arrependimento (compra fora da loja fisica)
--   return_defect_days            defeito em produto duravel
--   return_defect_nondurable_days defeito em produto nao duravel
--   return_warranty_days          garantia contratual da loja (NULL = nao oferece)
--   return_policy_text            condicoes da loja (texto livre)
ALTER TABLE logistics_settings
  ADD COLUMN return_regret_days            integer DEFAULT 7 CONSTRAINT logistics_settings_return_regret_check CHECK (return_regret_days BETWEEN 0 AND 3650),
  ADD COLUMN return_defect_days            integer DEFAULT 90 CONSTRAINT logistics_settings_return_defect_check CHECK (return_defect_days BETWEEN 0 AND 3650),
  ADD COLUMN return_defect_nondurable_days integer DEFAULT 30 CONSTRAINT logistics_settings_return_nondurable_check CHECK (return_defect_nondurable_days BETWEEN 0 AND 3650),
  ADD COLUMN return_warranty_days          integer CONSTRAINT logistics_settings_return_warranty_check CHECK (return_warranty_days BETWEEN 0 AND 3650),
  ADD COLUMN return_policy_text            text CONSTRAINT logistics_settings_return_policy_check CHECK (length(return_policy_text) <= 2000);

-- ---------------------------------------------------------------------------------------------------------------
-- Ocorrencias.
CREATE TABLE logistic_occurrences (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  order_id           uuid NOT NULL REFERENCES orders (id),
  shipment_id        uuid REFERENCES shipments (id),
  order_item_id      uuid REFERENCES order_items (id),
  kind               text NOT NULL CHECK (kind IN ('damaged', 'lost', 'late', 'refused', 'wrong_item', 'regret', 'defect', 'exchange', 'refund',
                                                   'reverse', 'delivery_failed', 'other')),
  responsibility     text NOT NULL DEFAULT 'undetermined' CHECK (responsibility IN ('company', 'supplier', 'carrier', 'customer', 'undetermined')),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'canceled')),
  -- Origem: manual (painel), tracking (aviso de rastreio), payment (contestacao do pagamento).
  source             text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'tracking', 'payment')),
  tracking_event_id  bigint REFERENCES shipment_events (id),
  blocks_completion  boolean NOT NULL DEFAULT true,
  description        text NOT NULL CHECK (length(description) BETWEEN 3 AND 1000),
  resolution         text CHECK (length(resolution) BETWEEN 3 AND 1000),
  due_at             timestamptz,
  resolved_at        timestamptz,
  resolved_by        uuid REFERENCES users (id),
  canceled_reason    text CHECK (length(canceled_reason) BETWEEN 3 AND 300),
  created_by         uuid REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            integer NOT NULL DEFAULT 1,
  request_key        text UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  CONSTRAINT logistic_occurrences_resolved CHECK (status <> 'resolved' OR (resolution IS NOT NULL AND resolved_at IS NOT NULL AND responsibility <> 'undetermined')),
  CONSTRAINT logistic_occurrences_canceled CHECK ((status = 'canceled') = (canceled_reason IS NOT NULL)),
  CONSTRAINT logistic_occurrences_tracking_shipment CHECK (source <> 'tracking' OR (shipment_id IS NOT NULL AND tracking_event_id IS NOT NULL))
);
CREATE INDEX logistic_occurrences_order_idx ON logistic_occurrences (order_id);
CREATE INDEX logistic_occurrences_open_idx ON logistic_occurrences (status, created_at) WHERE status IN ('open', 'in_progress');
-- Um aviso de rastreio abre no maximo uma ocorrencia por remessa e tipo (D9-11).
CREATE UNIQUE INDEX logistic_occurrences_tracking_unique ON logistic_occurrences (shipment_id, kind) WHERE source = 'tracking';

CREATE TABLE occurrence_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurrence_id  uuid NOT NULL REFERENCES logistic_occurrences (id),
  action         text NOT NULL CHECK (action IN ('open', 'start', 'resolve', 'cancel', 'reopen', 'note', 'responsibility', 'tracking', 'payment', 'return')),
  from_status    text,
  to_status      text,
  note           text CHECK (length(note) <= 1000),
  request_key    text UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  actor_id       uuid REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX occurrence_events_occurrence_idx ON occurrence_events (occurrence_id, id);
CREATE TRIGGER occurrence_events_immutable BEFORE UPDATE OR DELETE ON occurrence_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- Devolucoes do cliente.
--   kind    return (devolucao depois da entrega), refusal (recusa ou volta sem entrega), exchange (devolucao com
--           pedido de reposicao, D9-4)
--   status  authorized -> in_transit -> received -> inspected -> completed; canceled antes de qualquer conferencia
CREATE TABLE customer_returns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  order_id              uuid NOT NULL REFERENCES orders (id),
  occurrence_id         uuid REFERENCES logistic_occurrences (id),
  shipment_id           uuid REFERENCES shipments (id),
  kind                  text NOT NULL CHECK (kind IN ('return', 'refusal', 'exchange')),
  reason                text NOT NULL CHECK (reason IN ('regret', 'defect', 'damaged', 'wrong_item', 'refused', 'not_delivered', 'warranty', 'other')),
  status                text NOT NULL DEFAULT 'authorized' CHECK (status IN ('authorized', 'in_transit', 'received', 'inspected', 'completed', 'canceled')),
  -- Logistica reversa manual: como volta (transportadora, entrega na loja ou coleta combinada).
  return_method         text NOT NULL CHECK (return_method IN ('carrier', 'store_dropoff', 'pickup')),
  carrier               text CHECK (length(carrier) <= 80),
  tracking_code         text CHECK (length(tracking_code) <= 60),
  reverse_code          text CHECK (length(reverse_code) <= 60),
  -- Custo do frete de volta pago pela loja, se informado (NULL = desconhecido; nunca zero por falta de dado).
  return_freight_cents  integer CHECK (return_freight_cents BETWEEN 0 AND 10000000),
  warehouse_id          uuid REFERENCES warehouses (id),
  -- NF-e de venda autorizada: a devolucao exige documento fiscal proprio ou dispensa justificada (R9-17).
  fiscal_required       boolean NOT NULL,
  requested_at          timestamptz NOT NULL DEFAULT now(),
  delivered_at          timestamptz,
  notes                 text CHECK (length(notes) <= 500),
  received_at           timestamptz,
  received_by           uuid REFERENCES users (id),
  inspected_at          timestamptz,
  completed_at          timestamptz,
  completed_by          uuid REFERENCES users (id),
  canceled_at           timestamptz,
  cancel_reason         text CHECK (length(cancel_reason) BETWEEN 3 AND 300),
  created_by            uuid REFERENCES users (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  version               integer NOT NULL DEFAULT 1,
  request_key           text NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  CONSTRAINT customer_returns_received CHECK (status IN ('authorized', 'in_transit', 'canceled') OR (warehouse_id IS NOT NULL AND received_at IS NOT NULL)),
  CONSTRAINT customer_returns_canceled CHECK ((status = 'canceled') = (canceled_at IS NOT NULL AND cancel_reason IS NOT NULL)),
  CONSTRAINT customer_returns_completed CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX customer_returns_order_idx ON customer_returns (order_id);
CREATE INDEX customer_returns_open_idx ON customer_returns (status, created_at) WHERE status NOT IN ('completed', 'canceled');

-- Itens autorizados. Imutaveis: mudar a devolucao e cancelar e abrir outra.
CREATE TABLE customer_return_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id         uuid NOT NULL REFERENCES customer_returns (id),
  order_item_id     uuid NOT NULL REFERENCES order_items (id),
  -- Remessa nova: o item da remessa de onde saiu. Despacho anterior: NULL (o pedido antigo nao tem itens de remessa).
  shipment_item_id  uuid REFERENCES shipment_items (id),
  variant_id        uuid NOT NULL REFERENCES product_variants (id),
  qty               numeric(14,3) NOT NULL CHECK (qty > 0),
  -- Custo historico da saida (D9-3): media ponderada do custo medio gravado nos movimentos 'sale' do pedido e da
  -- variante. NULL = sem venda registrada no estoque (entra pelo custo medio atual, sem mexer na media).
  unit_cost_cents   numeric(16,4) CHECK (unit_cost_cents >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (return_id, order_item_id)
);
CREATE INDEX customer_return_items_order_item_idx ON customer_return_items (order_item_id);
CREATE TRIGGER customer_return_items_immutable BEFORE UPDATE OR DELETE ON customer_return_items FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Quantidade que saiu (despachada) ou chegou ao cliente (entregue) de um item do pedido. Remessa nova: itens das
-- remessas que sairam; despacho anterior (sem remessa nova): o item inteiro quando o pedido saiu ou foi entregue.
CREATE FUNCTION order_item_out_qty(p_item uuid, p_delivered boolean) RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = oi.order_id AND s.kind <> 'legacy' AND s.status <> 'canceled') THEN
      coalesce((SELECT sum(si.base_qty) FROM shipment_items si JOIN shipments s ON s.id = si.shipment_id
                 WHERE si.order_item_id = oi.id AND si.status = 'active' AND s.kind <> 'legacy'
                   AND (s.status = 'delivered' OR (NOT p_delivered AND s.status IN ('shipped', 'in_transit', 'out_for_delivery', 'delivery_failed', 'returned')))), 0)
    WHEN o.status = 'delivered' OR (NOT p_delivered AND o.status = 'shipped') THEN oi.packs * oi.base_qty_per_pack
    ELSE 0 END
  FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id = p_item
$$;
REVOKE ALL ON FUNCTION order_item_out_qty(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION order_item_out_qty(uuid, boolean) TO loja_app;

-- Teto da devolucao, com o pedido travado (concorrentes esperam e contam a anterior).
CREATE FUNCTION customer_return_items_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r customer_returns; oi order_items; total numeric; after_delivery numeric;
BEGIN
  SELECT * INTO r FROM customer_returns WHERE id = NEW.return_id;
  SELECT * INTO oi FROM order_items WHERE id = NEW.order_item_id;
  IF oi.order_id IS DISTINCT FROM r.order_id THEN
    RAISE EXCEPTION 'item de outro pedido' USING ERRCODE = 'check_violation', CONSTRAINT = 'customer_return_items_order';
  END IF;
  IF oi.variant_id <> NEW.variant_id THEN
    RAISE EXCEPTION 'variante diferente do item do pedido' USING ERRCODE = 'check_violation', CONSTRAINT = 'customer_return_items_order';
  END IF;
  PERFORM 1 FROM orders WHERE id = r.order_id FOR UPDATE;
  SELECT coalesce(sum(i.qty), 0), coalesce(sum(i.qty) FILTER (WHERE x.kind <> 'refusal'), 0) INTO total, after_delivery
    FROM customer_return_items i JOIN customer_returns x ON x.id = i.return_id
   WHERE i.order_item_id = NEW.order_item_id AND x.status <> 'canceled';
  IF total > order_item_out_qty(NEW.order_item_id, false) THEN
    RAISE EXCEPTION 'devolucao acima do despachado' USING ERRCODE = 'check_violation', CONSTRAINT = 'customer_return_items_dispatched';
  END IF;
  IF after_delivery > order_item_out_qty(NEW.order_item_id, true) THEN
    RAISE EXCEPTION 'devolucao acima do entregue' USING ERRCODE = 'check_violation', CONSTRAINT = 'customer_return_items_delivered';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER customer_return_items_check AFTER INSERT ON customer_return_items FOR EACH ROW EXECUTE FUNCTION customer_return_items_check();

-- Conferencia. Linha por condicao; estorno e uma linha nova com reverses_id (a original nao muda).
CREATE TABLE return_inspections (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id        uuid NOT NULL REFERENCES customer_returns (id),
  return_item_id   uuid NOT NULL REFERENCES customer_return_items (id),
  condition        text NOT NULL CHECK (condition IN ('good', 'quarantine', 'damaged', 'discarded', 'missing')),
  qty              numeric(14,3) NOT NULL CHECK (qty > 0),
  warehouse_id     uuid REFERENCES warehouses (id),
  -- Custo por unidade base usado na entrada e de onde veio: 'sale' (custo da venda) ou 'current_avg' (sem venda
  -- registrada, ou descarte: entra e sai pelo custo medio, sem mexer nele).
  unit_cost_cents  numeric(16,4) CHECK (unit_cost_cents >= 0),
  cost_source      text CHECK (cost_source IN ('sale', 'current_avg')),
  movement_ids     bigint[] NOT NULL DEFAULT '{}',
  reverses_id      bigint UNIQUE REFERENCES return_inspections (id),
  reason           text CHECK (length(reason) BETWEEN 3 AND 300),
  actor_id         uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_inspections_stock CHECK ((condition = 'missing') = (warehouse_id IS NULL)),
  CONSTRAINT return_inspections_reason CHECK (condition NOT IN ('damaged', 'discarded') OR reason IS NOT NULL),
  CONSTRAINT return_inspections_reversal CHECK (reverses_id IS NULL OR reason IS NOT NULL)
);
CREATE INDEX return_inspections_item_idx ON return_inspections (return_item_id);
CREATE TRIGGER return_inspections_immutable BEFORE UPDATE OR DELETE ON return_inspections FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION return_inspections_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE it customer_return_items; o return_inspections; net numeric;
BEGIN
  SELECT * INTO it FROM customer_return_items WHERE id = NEW.return_item_id;
  IF it.return_id IS DISTINCT FROM NEW.return_id THEN
    RAISE EXCEPTION 'item de outra devolucao' USING ERRCODE = 'check_violation', CONSTRAINT = 'return_inspections_item';
  END IF;
  PERFORM 1 FROM customer_returns WHERE id = NEW.return_id FOR UPDATE;
  IF NEW.reverses_id IS NOT NULL THEN
    SELECT * INTO o FROM return_inspections WHERE id = NEW.reverses_id;
    IF o.reverses_id IS NOT NULL OR o.return_item_id <> NEW.return_item_id OR o.condition <> NEW.condition OR o.qty <> NEW.qty
       OR o.warehouse_id IS DISTINCT FROM NEW.warehouse_id THEN
      RAISE EXCEPTION 'estorno diferente da conferencia original' USING ERRCODE = 'check_violation', CONSTRAINT = 'return_inspections_reversal_target';
    END IF;
    IF EXISTS (SELECT 1 FROM quarantine_decisions WHERE inspection_id = o.id) THEN
      RAISE EXCEPTION 'quarentena com decisao nao pode ser estornada' USING ERRCODE = 'check_violation', CONSTRAINT = 'return_inspections_reversal_target';
    END IF;
    RETURN NEW;
  END IF;
  SELECT coalesce(sum(CASE WHEN reverses_id IS NULL THEN qty ELSE -qty END), 0) INTO net FROM return_inspections WHERE return_item_id = NEW.return_item_id;
  IF net > it.qty THEN
    RAISE EXCEPTION 'conferencia acima do autorizado' USING ERRCODE = 'check_violation', CONSTRAINT = 'return_inspections_qty';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER return_inspections_check AFTER INSERT ON return_inspections FOR EACH ROW EXECUTE FUNCTION return_inspections_check();

-- Saida da quarentena. Imutavel.
CREATE TABLE quarantine_decisions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inspection_id  bigint NOT NULL REFERENCES return_inspections (id),
  decision       text NOT NULL CHECK (decision IN ('release', 'damaged', 'discard')),
  qty            numeric(14,3) NOT NULL CHECK (qty > 0),
  reason         text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  movement_ids   bigint[] NOT NULL DEFAULT '{}',
  actor_id       uuid REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quarantine_decisions_inspection_idx ON quarantine_decisions (inspection_id);
CREATE TRIGGER quarantine_decisions_immutable BEFORE UPDATE OR DELETE ON quarantine_decisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION quarantine_decisions_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i return_inspections; decided numeric;
BEGIN
  SELECT * INTO i FROM return_inspections WHERE id = NEW.inspection_id;
  PERFORM 1 FROM customer_returns WHERE id = i.return_id FOR UPDATE;
  IF i.condition <> 'quarantine' OR i.reverses_id IS NOT NULL OR EXISTS (SELECT 1 FROM return_inspections WHERE reverses_id = i.id) THEN
    RAISE EXCEPTION 'linha fora da quarentena' USING ERRCODE = 'check_violation', CONSTRAINT = 'quarantine_decisions_target';
  END IF;
  SELECT coalesce(sum(qty), 0) INTO decided FROM quarantine_decisions WHERE inspection_id = i.id;
  IF decided > i.qty THEN
    RAISE EXCEPTION 'decisao acima do que esta em quarentena' USING ERRCODE = 'check_violation', CONSTRAINT = 'quarantine_decisions_qty';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER quarantine_decisions_check AFTER INSERT ON quarantine_decisions FOR EACH ROW EXECUTE FUNCTION quarantine_decisions_check();

CREATE TABLE return_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id    uuid NOT NULL REFERENCES customer_returns (id),
  action       text NOT NULL CHECK (action IN ('authorize', 'transit', 'receive', 'inspect', 'inspect_reverse', 'quarantine', 'complete', 'cancel', 'note', 'fiscal', 'exchange', 'refund')),
  from_status  text,
  to_status    text,
  note         text CHECK (length(note) <= 1000),
  request_key  text UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  actor_id     uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX return_events_return_idx ON return_events (return_id, id);
CREATE TRIGGER return_events_immutable BEFORE UPDATE OR DELETE ON return_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- Pedido: ocorrencia aberta que segura a conclusao (R9-4). Entregue com ocorrencia aberta fica 'on_hold'; a
-- aplicacao conclui quando a ultima for resolvida ou cancelada. Ocorrencia nova em pedido ja concluido nao reabre.
ALTER TABLE orders DROP CONSTRAINT orders_logistics_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_logistics_status_check CHECK (logistics_status IN (
  'awaiting', 'analysis', 'processing', 'partially_shipped', 'shipped', 'partially_delivered', 'completed', 'on_hold', 'canceled'));

CREATE FUNCTION orders_occurrence_hold() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM logistic_occurrences WHERE order_id = NEW.id AND blocks_completion AND status IN ('open', 'in_progress')) THEN
    NEW.logistics_status := 'on_hold';
    NEW.logistics_note := 'Ocorrência aberta: o pedido conclui quando ela for resolvida.';
  END IF;
  RETURN NEW;
END $$;
-- Depois de orders_logistics_project (ordem alfabetica dos gatilhos BEFORE).
CREATE TRIGGER orders_occurrence_hold BEFORE UPDATE ON orders FOR EACH ROW
  WHEN (NEW.logistics_status = 'completed' AND OLD.logistics_status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION orders_occurrence_hold();

-- ---------------------------------------------------------------------------------------------------------------
-- Historico do pedido: eventos internos (ocorrencia, devolucao, reembolso: deposito, valores, nomes) nao aparecem na
-- pagina do cliente. Padrao false: o codigo anterior continua gravando eventos publicos como antes.
ALTER TABLE order_events ADD COLUMN internal boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------------------------------------------
-- 9b. Ocorrencia aberta pelo pagamento (contestacao ou devolucao do valor no provedor): uma por pedido; so registro.
CREATE UNIQUE INDEX logistic_occurrences_payment_once ON logistic_occurrences (order_id) WHERE source = 'payment';
-- Inicio da conferencia financeira (C18): pagamentos devolvidos antes da Fase 9 nao contam.
ALTER TABLE logistics_settings ADD COLUMN returns_since timestamptz NOT NULL DEFAULT now();

-- ---------------------------------------------------------------------------------------------------------------
-- 9b. Reembolsos (D9-5): SO registro do que foi feito fora do sistema (provedor, banco, caixa, marketplace).
--   status  requested (solicitado) -> done (realizado, com referencia externa) -> confirmed (conferido no extrato
--           ou no provedor); requested|done -> canceled. Nada conclui sozinho: receber a mercadoria nao reembolsa.
--   A mesma operacao financeira (meio + referencia externa) nao entra duas vezes. A soma dos reembolsos nao
--   cancelados de um pedido nunca passa do total do pedido (gatilho com o pedido travado, contando os concorrentes).
--   Pedido de marketplace: so o meio 'marketplace' (registro do que a plataforma fez); loja propria, nunca esse meio.
CREATE TABLE refund_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  order_id      uuid NOT NULL REFERENCES orders(id),
  return_id     uuid REFERENCES customer_returns(id),
  occurrence_id uuid REFERENCES logistic_occurrences(id),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  method        text NOT NULL CHECK (method IN ('mercadopago', 'pix', 'bank_transfer', 'cash', 'card_reversal', 'marketplace', 'other')),
  external_ref  text CHECK (length(external_ref) BETWEEN 1 AND 120),
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'done', 'confirmed', 'canceled')),
  reason        text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  requested_by  uuid REFERENCES users(id),
  done_at       timestamptz,
  done_by       uuid REFERENCES users(id),
  confirmed_at  timestamptz,
  confirmed_by  uuid REFERENCES users(id),
  canceled_at   timestamptz,
  canceled_by   uuid REFERENCES users(id),
  cancel_reason text CHECK (length(cancel_reason) BETWEEN 3 AND 300),
  version       integer NOT NULL DEFAULT 1,
  request_key   text NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_records_ref CHECK (status IN ('requested', 'canceled') OR external_ref IS NOT NULL),
  CONSTRAINT refund_records_done CHECK (status NOT IN ('done', 'confirmed') OR done_at IS NOT NULL),
  CONSTRAINT refund_records_confirmed CHECK (status <> 'confirmed' OR confirmed_at IS NOT NULL),
  CONSTRAINT refund_records_canceled CHECK ((status = 'canceled') = (canceled_at IS NOT NULL AND cancel_reason IS NOT NULL))
);
CREATE INDEX refund_records_order ON refund_records (order_id);
CREATE UNIQUE INDEX refund_records_operation ON refund_records (method, external_ref) WHERE external_ref IS NOT NULL AND status <> 'canceled';

CREATE FUNCTION refund_records_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o record; total bigint;
BEGIN
  SELECT id, channel, total_cents INTO o FROM orders WHERE id = NEW.order_id FOR UPDATE;
  IF (o.channel IN ('mercadolivre', 'shopee')) <> (NEW.method = 'marketplace') THEN
    RAISE EXCEPTION 'meio de reembolso incompativel com o canal do pedido' USING ERRCODE = 'check_violation', CONSTRAINT = 'refund_records_method';
  END IF;
  SELECT coalesce(sum(amount_cents), 0) INTO total FROM refund_records WHERE order_id = NEW.order_id AND status <> 'canceled';
  IF total > o.total_cents THEN
    RAISE EXCEPTION 'reembolsos (%) passam do total do pedido (%)', total, o.total_cents USING ERRCODE = 'check_violation', CONSTRAINT = 'refund_records_total';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER refund_records_check AFTER INSERT OR UPDATE OF amount_cents, status, method ON refund_records
  FOR EACH ROW EXECUTE FUNCTION refund_records_check();

CREATE TABLE refund_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  refund_id   uuid NOT NULL REFERENCES refund_records(id),
  action      text NOT NULL CHECK (action IN ('request', 'done', 'confirm', 'cancel', 'note')),
  from_status text,
  to_status   text,
  note        text CHECK (length(note) <= 500),
  request_key text UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  actor_id    uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refund_events_refund ON refund_events (refund_id);

-- ---------------------------------------------------------------------------------------------------------------
-- 9b. Documento fiscal da devolucao: registro separado da NF-e da venda (que nao muda, nem o invoice_status).
--   document  referencia do documento emitido fora (chave de acesso ou numero e serie); nada de CFOP ou tributo aqui
--   waiver    nao exigencia, com justificativa de quem tem permissao fiscal
-- Imutavel: corrigir e registrar outro (o mais recente vale).
CREATE TABLE return_fiscal_documents (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id     uuid NOT NULL REFERENCES customer_returns(id),
  kind          text NOT NULL CHECK (kind IN ('document', 'waiver')),
  doc_type      text CHECK (doc_type IN ('customer_nfe', 'store_entry_nfe', 'other')),
  access_key    text CHECK (access_key ~ '^[0-9]{44}$'),
  doc_number    text CHECK (length(doc_number) BETWEEN 1 AND 20),
  series        text CHECK (length(series) BETWEEN 1 AND 5),
  issued_on     date,
  justification text CHECK (length(justification) BETWEEN 10 AND 1000),
  actor_id      uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_fiscal_documents_shape CHECK (
    (kind = 'document' AND doc_type IS NOT NULL AND (access_key IS NOT NULL OR doc_number IS NOT NULL))
    OR (kind = 'waiver' AND justification IS NOT NULL AND access_key IS NULL AND doc_number IS NULL))
);
CREATE INDEX return_fiscal_documents_return ON return_fiscal_documents (return_id);

-- ---------------------------------------------------------------------------------------------------------------
-- 9b. Troca (D9-4): pedido de reposicao separado, ligado a devolucao, sem cobranca (total zero, desconto integral).
-- Segue as regras de sempre: alocacao, NF-e autorizada (ou dispensada) antes do despacho, remessa unica.
ALTER TABLE orders ADD COLUMN replacement_for_return_id uuid REFERENCES customer_returns(id);
CREATE UNIQUE INDEX orders_replacement_once ON orders (replacement_for_return_id) WHERE replacement_for_return_id IS NOT NULL;
ALTER TABLE orders DROP CONSTRAINT orders_total_cents_check;
ALTER TABLE orders ADD CONSTRAINT orders_total_cents_check CHECK (total_cents > 0 OR (replacement_for_return_id IS NOT NULL AND total_cents = 0));

-- ---------------------------------------------------------------------------------------------------------------
-- 9b. Devolucao ao fornecedor: rascunho -> enviada (saida fisica confirmada: so ai o estoque sai) -> aceita | recusada
-- (a mercadoria volta: estorno dos movimentos); rascunho -> cancelada. Nenhum credito, reembolso ou abatimento
-- automatico; nenhum e-mail ao fornecedor.
CREATE TABLE supplier_returns (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  supplier_id        uuid NOT NULL REFERENCES suppliers(id),
  purchase_order_id  uuid REFERENCES purchase_orders(id),
  customer_return_id uuid REFERENCES customer_returns(id),
  warehouse_id       uuid NOT NULL REFERENCES warehouses(id),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'refused', 'canceled')),
  reason             text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  document_ref       text CHECK (length(document_ref) BETWEEN 1 AND 60),
  carrier            text CHECK (length(carrier) <= 80),
  tracking_code      text CHECK (length(tracking_code) <= 60),
  notes              text CHECK (length(notes) <= 1000),
  sent_at            timestamptz,
  sent_by            uuid REFERENCES users(id),
  closed_at          timestamptz,
  closed_by          uuid REFERENCES users(id),
  close_note         text CHECK (length(close_note) BETWEEN 3 AND 500),
  created_by         uuid REFERENCES users(id),
  version            integer NOT NULL DEFAULT 1,
  request_key        text NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_returns_sent CHECK (status IN ('draft', 'canceled') OR (sent_at IS NOT NULL AND document_ref IS NOT NULL)),
  CONSTRAINT supplier_returns_closed CHECK (status NOT IN ('accepted', 'refused', 'canceled') OR (closed_at IS NOT NULL AND close_note IS NOT NULL))
);
CREATE INDEX supplier_returns_supplier ON supplier_returns (supplier_id);

-- Itens: de qual saldo sai (livre, bloqueado ou avariado). Imutaveis: mudar e cancelar o rascunho e abrir outro.
CREATE TABLE supplier_return_items (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supplier_return_id uuid NOT NULL REFERENCES supplier_returns(id),
  variant_id         uuid NOT NULL REFERENCES product_variants(id),
  bucket             text NOT NULL CHECK (bucket IN ('on_hand', 'blocked', 'damaged')),
  qty                numeric(14, 3) NOT NULL CHECK (qty > 0),
  CONSTRAINT supplier_return_items_once UNIQUE (supplier_return_id, variant_id, bucket)
);

CREATE TABLE supplier_return_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supplier_return_id uuid NOT NULL REFERENCES supplier_returns(id),
  action             text NOT NULL CHECK (action IN ('create', 'send', 'accept', 'refuse', 'cancel', 'note')),
  from_status        text,
  to_status          text,
  note               text CHECK (length(note) <= 500),
  request_key        text UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  actor_id           uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_return_events_return ON supplier_return_events (supplier_return_id);

-- Historicos imutaveis da 9b.
CREATE TRIGGER refund_events_immutable BEFORE UPDATE OR DELETE ON refund_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER return_fiscal_documents_immutable BEFORE UPDATE OR DELETE ON return_fiscal_documents FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER supplier_return_items_immutable BEFORE UPDATE OR DELETE ON supplier_return_items FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER supplier_return_events_immutable BEFORE UPDATE OR DELETE ON supplier_return_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Estoque: saida 'supplier_return' (do livre; bloqueado e avariado passam antes por 'unblock' / 'damage_release' na
-- mesma transacao) e o estorno desses movimentos quando o fornecedor recusa.
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_kind_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check CHECK (kind IN (
  'receipt', 'sale', 'return', 'loss', 'damage', 'adjustment', 'inventory', 'reserve', 'release',
  'transfer_out', 'transfer_in', 'transfer_loss', 'transfer_return', 'block', 'unblock', 'damage_hold', 'damage_release', 'reversal',
  'supplier_return'));
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_supplier_return CHECK (kind <> 'supplier_return' OR (on_hand_delta < 0 AND source_type = 'supplier_return'));

-- ---------------------------------------------------------------------------------------------------------------
-- Estoque: origem 'customer_return' (conferencia e quarentena) e estorno desses movimentos.
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_source_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_source_type_check
  CHECK (source_type IN ('purchase_receipt', 'order', 'cart', 'quote', 'inventory', 'manual', 'reservation', 'transfer', 'adjustment_request', 'customer_return', 'supplier_return'));

CREATE OR REPLACE FUNCTION stock_movements_reversal_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
  ELSIF o.kind NOT IN ('adjustment', 'loss', 'damage', 'return', 'block', 'unblock', 'damage_hold', 'damage_release', 'supplier_return')
     OR o.source_type NOT IN ('manual', 'adjustment_request', 'customer_return', 'supplier_return') THEN
    RAISE EXCEPTION 'movimento do tipo % nao pode ser estornado', o.kind USING ERRCODE = 'restrict_violation', CONSTRAINT = 'stock_movements_reversal_target';
  END IF;
  IF o.variant_id <> NEW.variant_id OR coalesce(o.warehouse_id, dflt) <> coalesce(NEW.warehouse_id, dflt)
     OR NEW.on_hand_delta <> -o.on_hand_delta OR NEW.reserved_delta <> -o.reserved_delta OR NEW.blocked_delta <> -o.blocked_delta
     OR NEW.damaged_delta <> -o.damaged_delta OR NEW.in_transit_delta <> -o.in_transit_delta THEN
    RAISE EXCEPTION 'estorno diferente do movimento original' USING ERRCODE = 'restrict_violation', CONSTRAINT = 'stock_movements_reversal_target';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Conferencia ampliada.
--   C14 devolvido (devolucoes nao canceladas) <= despachado, por item do pedido
--   C15 conferido (boa, quarentena, avariada, descartada; menos estornos) = entradas 'return' da devolucao (menos estornos)
--   C16 quarentena aberta (conferida e sem decisao) <= saldo bloqueado do deposito
--   C17 reembolsos nao cancelados <= total do pedido (9b)
--   C18 pagamento devolvido no provedor (depois da Fase 9) tem reembolso registrado (9b)
--   C19 devolucao encerrada de pedido com NF-e autorizada tem documento fiscal ou dispensa (9b)
--   C20 pedido 'on_hold' tem ocorrencia aberta que segura a conclusao (9b)
--   C21 devolucao ao fornecedor enviada ou aceita = saidas 'supplier_return' (menos estornos), por item (9b)
-- ref_id: pedido da divergencia (a linha pode nao ter variante nas conferencias financeiras da 9b).
ALTER TABLE stock_reconciliations ADD COLUMN ref_id uuid;
ALTER TABLE stock_reconciliations DROP CONSTRAINT stock_reconciliations_check_code_check;
ALTER TABLE stock_reconciliations ADD CONSTRAINT stock_reconciliations_check_code_check
  CHECK (check_code IN ('run', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'C17', 'C18', 'C19', 'C20', 'C21'));
ALTER TABLE stock_reconciliations DROP CONSTRAINT stock_reconciliations_field_check;
ALTER TABLE stock_reconciliations ADD CONSTRAINT stock_reconciliations_field_check
  CHECK (field IN ('on_hand', 'reserved', 'blocked', 'damaged', 'in_transit', 'shipped', 'picked', 'checked', 'received', 'rejected', 'linked', 'converted',
                   'returned', 'inspected', 'quarantine', 'refunded', 'refund_record', 'fiscal', 'hold', 'supplier_returned'));

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
  -- C14: devolvido (devolucoes nao canceladas) x despachado, por item do pedido.
  c14 AS (
    SELECT ri.order_item_id, min(ri.variant_id::text)::uuid AS variant_id, min(r.order_id::text)::uuid AS order_id, sum(ri.qty) AS got_v,
           order_item_out_qty(ri.order_item_id, false) AS exp_v
    FROM customer_return_items ri JOIN customer_returns r ON r.id = ri.return_id
    WHERE r.status <> 'canceled' GROUP BY ri.order_item_id
  ),
  -- C15: conferido (sem 'faltando', menos estornos) x entradas 'return' da devolucao (menos estornos), por item.
  insp AS (
    SELECT i.return_item_id::text AS item, sum(CASE WHEN i.reverses_id IS NULL THEN i.qty ELSE -i.qty END) AS qty
    FROM return_inspections i WHERE i.condition <> 'missing' GROUP BY i.return_item_id
  ),
  insp_mv AS (
    SELECT m.source_id AS item, sum(m.on_hand_delta) AS qty
    FROM stock_movements m LEFT JOIN stock_movements o ON o.id = m.reverses_id
    WHERE m.source_type = 'customer_return' AND (m.kind = 'return' OR (m.kind = 'reversal' AND o.kind = 'return'))
    GROUP BY m.source_id
  ),
  c15 AS (
    SELECT ri.variant_id, r.warehouse_id, r.order_id, coalesce(insp.qty, 0) AS exp_v, coalesce(insp_mv.qty, 0) AS got_v
    FROM insp FULL JOIN insp_mv ON insp_mv.item = insp.item
    LEFT JOIN customer_return_items ri ON ri.id::text = coalesce(insp.item, insp_mv.item)
    LEFT JOIN customer_returns r ON r.id = ri.return_id
    WHERE coalesce(insp.qty, 0) <> coalesce(insp_mv.qty, 0)
  ),
  -- C16: quarentena aberta (conferida, sem estorno, menos decisoes) <= saldo bloqueado do deposito.
  quar AS (
    SELECT ri.variant_id, i.warehouse_id, sum(i.qty - coalesce((SELECT sum(d.qty) FROM quarantine_decisions d WHERE d.inspection_id = i.id), 0)) AS qty
    FROM return_inspections i JOIN customer_return_items ri ON ri.id = i.return_item_id
    WHERE i.condition = 'quarantine' AND i.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM return_inspections x WHERE x.reverses_id = i.id)
    GROUP BY ri.variant_id, i.warehouse_id
  ),
  c16 AS (
    SELECT q.variant_id, q.warehouse_id, q.qty AS exp_v, coalesce(l.blocked, 0) AS got_v
    FROM quar q LEFT JOIN stock_location_balances l ON l.warehouse_id = q.warehouse_id AND l.variant_id = q.variant_id
    WHERE q.qty > coalesce(l.blocked, 0)
  ),
  -- C17: reembolsos nao cancelados x total do pedido.
  c17 AS (
    SELECT o.id AS order_id, o.total_cents::numeric AS exp_v, sum(r.amount_cents)::numeric AS got_v
    FROM refund_records r JOIN orders o ON o.id = r.order_id WHERE r.status <> 'canceled'
    GROUP BY o.id, o.total_cents HAVING sum(r.amount_cents) > o.total_cents
  ),
  -- C18: pagamento devolvido depois da Fase 9 sem reembolso registrado.
  c18 AS (
    SELECT p.order_id, p.amount_cents::numeric AS exp_v, 0::numeric AS got_v
    FROM payments p WHERE p.status = 'refunded' AND p.updated_at >= (SELECT returns_since FROM logistics_settings)
      AND NOT EXISTS (SELECT 1 FROM refund_records r WHERE r.order_id = p.order_id AND r.status <> 'canceled')
  ),
  -- C19: devolucao encerrada que exigia documento fiscal e nao tem documento nem dispensa.
  c19 AS (
    SELECT r.order_id FROM customer_returns r
    WHERE r.status = 'completed' AND r.fiscal_required AND NOT EXISTS (SELECT 1 FROM return_fiscal_documents d WHERE d.return_id = r.id)
  ),
  -- C20: pedido segurado sem ocorrencia aberta que segure.
  c20 AS (
    SELECT o.id AS order_id FROM orders o WHERE o.logistics_status = 'on_hold'
      AND NOT EXISTS (SELECT 1 FROM logistic_occurrences x WHERE x.order_id = o.id AND x.blocks_completion AND x.status IN ('open', 'in_progress'))
  ),
  -- C21: devolucao ao fornecedor x saidas do estoque, por item.
  srt_mv AS (
    SELECT m.source_id AS item, -sum(m.on_hand_delta) AS qty
    FROM stock_movements m LEFT JOIN stock_movements o ON o.id = m.reverses_id
    WHERE m.source_type = 'supplier_return' AND (m.kind = 'supplier_return' OR (m.kind = 'reversal' AND o.kind = 'supplier_return'))
    GROUP BY m.source_id
  ),
  c21 AS (
    SELECT i.variant_id, s.warehouse_id, CASE WHEN s.status IN ('sent', 'accepted') THEN i.qty ELSE 0 END AS exp_v, coalesce(mv.qty, 0) AS got_v
    FROM supplier_return_items i JOIN supplier_returns s ON s.id = i.supplier_return_id LEFT JOIN srt_mv mv ON mv.item = i.id::text
    WHERE CASE WHEN s.status IN ('sent', 'accepted') THEN i.qty ELSE 0 END <> coalesce(mv.qty, 0)
  ),
  divs AS (
    SELECT CASE WHEN has_open THEN 'C1' ELSE 'C5' END AS code, 'on_hand' AS field, variant_id, NULL::uuid AS warehouse_id, exp_on AS expected, b_on AS found, NULL::uuid AS ref_id FROM base WHERE exp_on <> b_on
    UNION ALL SELECT CASE WHEN has_open THEN 'C1' ELSE 'C5' END, 'reserved', variant_id, NULL, exp_res, b_res, NULL FROM base WHERE exp_res <> b_res
    UNION ALL SELECT CASE WHEN has_open THEN 'C1' ELSE 'C5' END, 'blocked', variant_id, NULL, exp_blk, b_blk, NULL FROM base WHERE exp_blk <> b_blk
    UNION ALL SELECT CASE WHEN has_open THEN 'C1' ELSE 'C5' END, 'damaged', variant_id, NULL, exp_dmg, b_dmg, NULL FROM base WHERE exp_dmg <> b_dmg
    UNION ALL SELECT CASE WHEN has_open THEN 'C1' ELSE 'C5' END, 'in_transit', variant_id, NULL, exp_trn, b_trn, NULL FROM base WHERE exp_trn <> b_trn
    UNION ALL SELECT 'C2', 'on_hand', variant_id, NULL, b_on, l_on, NULL FROM base WHERE b_on <> l_on
    UNION ALL SELECT 'C2', 'reserved', variant_id, NULL, b_res, l_res, NULL FROM base WHERE b_res <> l_res
    UNION ALL SELECT 'C2', 'blocked', variant_id, NULL, b_blk, l_blk, NULL FROM base WHERE b_blk <> l_blk
    UNION ALL SELECT 'C2', 'damaged', variant_id, NULL, b_dmg, l_dmg, NULL FROM base WHERE b_dmg <> l_dmg
    UNION ALL SELECT 'C2', 'in_transit', variant_id, NULL, b_trn, l_trn, NULL FROM base WHERE b_trn <> l_trn
    UNION ALL SELECT 'C3', 'on_hand', variant_id, NULL, on_hand_after, b_on, NULL FROM base WHERE on_hand_after IS NOT NULL AND on_hand_after <> b_on
    UNION ALL SELECT 'C3', 'reserved', variant_id, NULL, reserved_after, b_res, NULL FROM base WHERE reserved_after IS NOT NULL AND reserved_after <> b_res
    UNION ALL SELECT 'C3', 'blocked', variant_id, NULL, blocked_after, b_blk, NULL FROM base WHERE blocked_after IS NOT NULL AND blocked_after <> b_blk
    UNION ALL SELECT 'C3', 'damaged', variant_id, NULL, damaged_after, b_dmg, NULL FROM base WHERE damaged_after IS NOT NULL AND damaged_after <> b_dmg
    UNION ALL SELECT 'C3', 'in_transit', variant_id, NULL, in_transit_after, b_trn, NULL FROM base WHERE in_transit_after IS NOT NULL AND in_transit_after <> b_trn
    UNION ALL SELECT 'C4', 'reserved', variant_id, NULL, exp_res_c4, b_res, NULL FROM base WHERE exp_res_c4 <> b_res
    UNION ALL SELECT 'C6', 'in_transit', variant_id, NULL, exp_trn_c6, b_trn, NULL FROM base WHERE exp_trn_c6 <> b_trn
    UNION ALL SELECT 'C7', field, variant_id, NULL, exp_v, got_v, NULL FROM rev
    UNION ALL SELECT 'C8', 'reserved', variant_id, warehouse_id, expected, got, NULL FROM c8 WHERE expected <> got
    UNION ALL SELECT 'C9', 'reserved', variant_id, warehouse_id, expected, got, NULL FROM c9
    UNION ALL SELECT 'C10', 'shipped', variant_id, warehouse_id, expected, got, NULL FROM c10 WHERE expected <> got
    UNION ALL SELECT 'C11', field, variant_id, warehouse_id, exp_v, got_v, NULL FROM c11_log
    UNION ALL SELECT 'C11', 'reserved', variant_id, warehouse_id, open_qty, reserved, NULL FROM c11_res WHERE open_qty > reserved
    UNION ALL SELECT 'C12', field, variant_id, warehouse_id, exp_v, got_v, NULL FROM c12
    UNION ALL SELECT 'C12', field, variant_id, warehouse_id, exp_v, got_v, NULL FROM c12_item
    UNION ALL SELECT 'C13', 'linked', variant_id, warehouse_id, exp_v, got_v, NULL FROM c13_item
    UNION ALL SELECT 'C13', 'linked', variant_id, warehouse_id, exp_v, got_v, NULL FROM c13_alloc
    UNION ALL SELECT 'C13', 'converted', variant_id, warehouse_id, exp_v, got_v, NULL FROM c13_conv
    UNION ALL SELECT 'C14', 'returned', variant_id, NULL, exp_v, got_v, order_id FROM c14 WHERE got_v > exp_v
    UNION ALL SELECT 'C15', 'inspected', variant_id, warehouse_id, exp_v, got_v, order_id FROM c15
    UNION ALL SELECT 'C16', 'quarantine', variant_id, warehouse_id, exp_v, got_v, NULL FROM c16
    UNION ALL SELECT 'C17', 'refunded', NULL, NULL, exp_v, got_v, order_id FROM c17
    UNION ALL SELECT 'C18', 'refund_record', NULL, NULL, exp_v, got_v, order_id FROM c18
    UNION ALL SELECT 'C19', 'fiscal', NULL, NULL, 1, 0, order_id FROM c19
    UNION ALL SELECT 'C20', 'hold', NULL, NULL, 1, 0, order_id FROM c20
    UNION ALL SELECT 'C21', 'supplier_returned', variant_id, warehouse_id, exp_v, got_v, NULL FROM c21
  ),
  ins AS (
    INSERT INTO stock_reconciliations (run_id, check_code, field, variant_id, warehouse_id, expected, found, created_by, ref_id)
    SELECT v_run, d.code, d.field, d.variant_id, d.warehouse_id, d.expected, d.found, app_user_id(), d.ref_id FROM divs d
    RETURNING 1
  )
  INSERT INTO stock_reconciliations (run_id, check_code, expected, found, created_by)
  SELECT v_run, 'run', (SELECT count(*) FROM base), (SELECT count(*) FROM ins), app_user_id();

  RETURN QUERY SELECT * FROM stock_reconciliations WHERE run_id = v_run ORDER BY id;
END $$;
REVOKE ALL ON FUNCTION stock_reconcile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stock_reconcile() TO loja_app;

-- ---------------------------------------------------------------------------------------------------------------
-- Privilegios minimos: historicos so por inclusao.
GRANT SELECT, INSERT ON occurrence_events, customer_return_items, return_inspections, quarantine_decisions, return_events TO loja_app;
GRANT SELECT, INSERT, UPDATE ON logistic_occurrences, customer_returns TO loja_app;
GRANT SELECT, INSERT ON refund_events, return_fiscal_documents, supplier_return_items, supplier_return_events TO loja_app;
GRANT SELECT, INSERT, UPDATE ON refund_records, supplier_returns TO loja_app;

-- Resumo para quem aplica.
DO $$
DECLARE ms numeric;
BEGIN
  ms := round(extract(epoch FROM clock_timestamp() - current_setting('sglog.t0')::timestamptz) * 1000);
  RAISE NOTICE '0028: pedidos e estoque bloqueados por % ms (ate aqui; o bloqueio termina no COMMIT)', ms;
  RAISE NOTICE '0028: % pedido(s) entregue(s) e % concluido(s) na logistica; nenhuma ocorrencia, devolucao, reembolso ou devolucao ao fornecedor existe ainda',
    (SELECT count(*) FROM orders WHERE status = 'delivered'), (SELECT count(*) FROM orders WHERE logistics_status = 'completed');
END $$;
