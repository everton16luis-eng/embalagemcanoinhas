-- SGLog Fase 7: abastecimento e comunicacao com fornecedores (docs/31-sglog-fase7-planejamento.md e
-- docs/32-sglog-fase7.md).
-- - Documento do pedido de compra: cada envio ao fornecedor grava uma versao imutavel (conteudo, texto, hash, canal,
--   autor e data). Sem dados de clientes.
-- - Confirmacao do fornecedor: versao imutavel por registro, com resultado por item (confirmado, entrega parcial,
--   reducao definitiva, recusa), preco e prazo. Aumento de preco acima da tolerancia aguarda aprovacao (MFA).
--   A confirmacao nao movimenta estoque nem custo medio.
-- - Reducao definitiva e recusa: saldo cancelado do item (canceled_packs). A pendencia do item passa a ser
--   pedido - recebido - cancelado. A entrega parcial nao cancela nada.
-- - Requisicoes internas de compra (manuais e automaticas para encomendas sem compra), com historico imutavel.
--
-- D7-12: ADITIVA e compativel com o codigo anterior (5a07198), inclusive na escrita: so colunas novas com padrao ou
-- nulas e tabelas novas; os tipos novos do historico so ampliam o CHECK. O gatilho dos vinculos passa a considerar o
-- saldo cancelado (zero no codigo anterior, que nao cancela). stock_reconcile() (C1-C13) nao muda.
-- Checkout, pagamento, NF-e de venda, marketplaces, remessas e as travas (ALLOCATION_AUTO, dropshipping, remessas
-- multiplas) nao mudam.

-- Bloqueios, tecnica da 0020-0025: espera so o primeiro, pede os demais com NOWAIT; ocupado, solta e tenta de novo.
--   purchase_orders, purchase_order_items, purchase_order_events, logistics_settings
--                                ACCESS EXCLUSIVE     colunas e CHECKs novos
--   purchase_order_links         SHARE ROW EXCLUSIVE  gatilho substituido (saldo cancelado)
--   fulfillment_allocations, product_variants, packagings, warehouses, users
--                                SHARE ROW EXCLUSIVE  FKs novas
SET LOCAL lock_timeout = '10s';
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '10 seconds'; tries integer := 0; waited numeric;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE purchase_orders IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE purchase_order_items IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE purchase_order_events IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE logistics_settings IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE purchase_order_links IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE fulfillment_allocations IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE product_variants IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE packagings IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE warehouses IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF clock_timestamp() > deadline THEN
        RAISE EXCEPTION '0026: compras ocupadas por mais de 10 s (% tentativas); nada foi alterado, tente de novo', tries
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.02);
    END;
  END LOOP;
  waited := round(extract(epoch FROM clock_timestamp() - (deadline - interval '10 seconds')) * 1000);
  RAISE NOTICE '0026: bloqueios obtidos em % ms (% nova(s) tentativa(s))', waited, tries;
END $$;
SELECT set_config('sglog.t0', clock_timestamp()::text, true);

-- ---------------------------------------------------------------------------------------------------------------
-- Pedido de compra: envio e confirmacao.
--   confirmation_status
--     none              compra anterior ao acompanhamento (ou enviada pelo codigo anterior): sem alerta retroativo
--     awaiting          enviada; aguardando a confirmacao do fornecedor
--     confirmed         confirmada como pedida
--     partial           entrega parcial confirmada; o restante continua pendente
--     changed           confirmada com alteracao (reducao, recusa de item ou preco)
--     refused           o fornecedor recusou tudo o que estava pendente
--     pending_approval  confirmacao com aumento de preco acima da tolerancia, aguardando aprovacao (recebimento travado)
ALTER TABLE purchase_orders
  ADD COLUMN sent_via               text CONSTRAINT purchase_orders_sent_via_check CHECK (sent_via IN ('printed', 'email', 'whatsapp', 'phone', 'portal', 'other')),
  ADD COLUMN sent_document_version  integer CONSTRAINT purchase_orders_sent_document_check CHECK (sent_document_version > 0),
  ADD COLUMN supplier_ref           text CONSTRAINT purchase_orders_supplier_ref_check CHECK (length(supplier_ref) BETWEEN 1 AND 60),
  ADD COLUMN confirmation_status    text NOT NULL DEFAULT 'none' CONSTRAINT purchase_orders_confirmation_status_check
    CHECK (confirmation_status IN ('none', 'awaiting', 'confirmed', 'partial', 'changed', 'refused', 'pending_approval')),
  ADD COLUMN confirmed_at           timestamptz,
  ADD COLUMN promised_at            date,
  -- Proxima cobranca combinada com o fornecedor (registro de contato).
  ADD COLUMN followup_on            date;

-- Item: resultado da confirmacao, prazo e saldo cancelado (reducao definitiva ou recusa).
--   Pendente do item = packs - received_packs - canceled_packs.
--   Entrega parcial: partial_packs chegam ate promised_at (contados a partir de partial_from_packs recebidos); o
--   restante continua pendente, com rest_promised_at (nulo = sem previsao).
ALTER TABLE purchase_order_items
  ADD COLUMN canceled_packs        numeric(12,3) NOT NULL DEFAULT 0,
  ADD COLUMN supplier_outcome      text CONSTRAINT purchase_order_items_supplier_outcome_check CHECK (supplier_outcome IN ('confirmed', 'partial', 'reduced', 'refused')),
  ADD COLUMN promised_at           date,
  ADD COLUMN partial_packs         numeric(12,3) CONSTRAINT purchase_order_items_partial_packs_check CHECK (partial_packs > 0),
  ADD COLUMN partial_from_packs    numeric(12,3) CONSTRAINT purchase_order_items_partial_from_check CHECK (partial_from_packs >= 0),
  ADD COLUMN rest_promised_at      date,
  ADD CONSTRAINT purchase_order_items_canceled CHECK (canceled_packs >= 0 AND received_packs + canceled_packs <= packs),
  ADD CONSTRAINT purchase_order_items_partial CHECK ((partial_packs IS NULL) = (partial_from_packs IS NULL));

-- Historico: tipos novos (so amplia; os antigos continuam validos).
ALTER TABLE purchase_order_events DROP CONSTRAINT purchase_order_events_kind_check;
ALTER TABLE purchase_order_events ADD CONSTRAINT purchase_order_events_kind_check
  CHECK (kind IN ('submitted', 'approved', 'approval_rejected', 'back_to_draft', 'payment_informed', 'sent', 'shipping_updated', 'closed_short', 'canceled',
                  'document_resent', 'confirmation', 'confirmation_approved', 'confirmation_rejected', 'closed_by_confirmation', 'followup', 'requests_added'));
ALTER TABLE purchase_order_events DROP CONSTRAINT purchase_order_events_note;
ALTER TABLE purchase_order_events ADD CONSTRAINT purchase_order_events_note
  CHECK (kind NOT IN ('approval_rejected', 'closed_short', 'canceled', 'confirmation_rejected', 'followup') OR note IS NOT NULL);

CREATE INDEX purchase_orders_followup_idx ON purchase_orders (confirmation_status) WHERE status IN ('sent', 'partial') AND confirmation_status <> 'none';

-- ---------------------------------------------------------------------------------------------------------------
-- Documento enviado ao fornecedor: uma linha por envio (versao 1, 2, ...), imutavel.
CREATE TABLE purchase_order_documents (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id      uuid NOT NULL REFERENCES purchase_orders (id),
  version       integer NOT NULL CHECK (version > 0),
  channel       text NOT NULL CHECK (channel IN ('printed', 'email', 'whatsapp', 'phone', 'portal', 'other')),
  content       jsonb NOT NULL,
  body_text     text NOT NULL CHECK (length(body_text) BETWEEN 1 AND 20000),
  content_hash  text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  note          text CHECK (length(note) BETWEEN 3 AND 500),
  actor_id      uuid NOT NULL REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_order_documents_version UNIQUE (order_id, version)
);
CREATE TRIGGER purchase_order_documents_immutable BEFORE UPDATE OR DELETE ON purchase_order_documents FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- Confirmacao do fornecedor: uma linha por registro (versao), com os itens. Imutavel, exceto a decisao da aprovacao
-- de preco (pending_approval -> applied, rejected ou superseded), uma unica vez.
--   applied           aplicada na compra (direto, ou depois de aprovada)
--   pending_approval  aumento de preco acima da tolerancia: nada aplicado ate a aprovacao
--   rejected          aumento recusado: nada aplicado
--   superseded        substituida por um registro mais novo antes da decisao
CREATE TABLE purchase_confirmations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL REFERENCES purchase_orders (id),
  version               integer NOT NULL CHECK (version > 0),
  outcome               text NOT NULL CHECK (outcome IN ('confirmed', 'partial', 'changed', 'refused')),
  channel               text NOT NULL CHECK (channel IN ('printed', 'email', 'whatsapp', 'phone', 'portal', 'other')),
  supplier_ref          text CHECK (length(supplier_ref) BETWEEN 1 AND 60),
  promised_at           date,
  note                  text CHECK (length(note) BETWEEN 3 AND 500),
  price_increase_cents  bigint NOT NULL DEFAULT 0 CHECK (price_increase_cents >= 0),
  status                text NOT NULL CHECK (status IN ('applied', 'pending_approval', 'rejected', 'superseded')),
  decided_by            uuid REFERENCES users (id),
  decided_at            timestamptz,
  decision_note         text CHECK (length(decision_note) BETWEEN 3 AND 500),
  decision_self         boolean NOT NULL DEFAULT false,
  actor_id              uuid NOT NULL REFERENCES users (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_confirmations_version UNIQUE (order_id, version),
  CONSTRAINT purchase_confirmations_pending CHECK (status <> 'pending_approval' OR (decided_by IS NULL AND decided_at IS NULL)),
  CONSTRAINT purchase_confirmations_rejected CHECK (status <> 'rejected' OR (decided_by IS NOT NULL AND decision_note IS NOT NULL)),
  CONSTRAINT purchase_confirmations_self CHECK (NOT decision_self OR (decided_by IS NOT NULL AND decision_note IS NOT NULL))
);
CREATE UNIQUE INDEX purchase_confirmations_one_pending ON purchase_confirmations (order_id) WHERE status = 'pending_approval';

CREATE FUNCTION purchase_confirmations_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'confirmacao do fornecedor e imutavel' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'pending_approval' OR NEW.status = 'pending_approval'
     OR (to_jsonb(NEW) - ARRAY['status', 'decided_by', 'decided_at', 'decision_note', 'decision_self'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'decided_by', 'decided_at', 'decision_note', 'decision_self']) THEN
    RAISE EXCEPTION 'confirmacao do fornecedor e imutavel (so a decisao da aprovacao, uma vez)' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_confirmations_guard BEFORE UPDATE OR DELETE ON purchase_confirmations FOR EACH ROW EXECUTE FUNCTION purchase_confirmations_guard();

-- Itens da confirmacao, sobre o PENDENTE do item no momento do registro (pedido - recebido - cancelado):
--   confirmed  tudo o que estava pendente (confirmed_packs = pending_packs)
--   partial    parte agora (0 < confirmed < pending); o restante continua pendente
--   reduced    reducao definitiva para confirmed_packs (0 < confirmed < pending); o restante e cancelado
--   refused    nada mais (confirmed = 0); todo o pendente e cancelado
CREATE TABLE purchase_confirmation_items (
  id                         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  confirmation_id            uuid NOT NULL REFERENCES purchase_confirmations (id),
  item_id                    uuid NOT NULL REFERENCES purchase_order_items (id),
  outcome                    text NOT NULL CHECK (outcome IN ('confirmed', 'partial', 'reduced', 'refused')),
  pending_packs              numeric(12,3) NOT NULL CHECK (pending_packs > 0),
  confirmed_packs            numeric(12,3) NOT NULL CHECK (confirmed_packs >= 0),
  ordered_pack_cost_cents    bigint NOT NULL CHECK (ordered_pack_cost_cents >= 0),
  confirmed_pack_cost_cents  bigint NOT NULL CHECK (confirmed_pack_cost_cents >= 0),
  promised_at                date,
  rest_promised_at           date,
  note                       text CHECK (length(note) BETWEEN 3 AND 500),
  CONSTRAINT purchase_confirmation_items_unique UNIQUE (confirmation_id, item_id),
  CONSTRAINT purchase_confirmation_items_qty CHECK (CASE outcome
    WHEN 'confirmed' THEN confirmed_packs = pending_packs
    WHEN 'refused'   THEN confirmed_packs = 0
    ELSE confirmed_packs > 0 AND confirmed_packs < pending_packs END),
  CONSTRAINT purchase_confirmation_items_rest CHECK (outcome = 'partial' OR rest_promised_at IS NULL)
);
CREATE INDEX purchase_confirmation_items_item_idx ON purchase_confirmation_items (item_id);
CREATE TRIGGER purchase_confirmation_items_immutable BEFORE UPDATE OR DELETE ON purchase_confirmation_items FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- Vinculos: o teto por item passa a ser o pedido menos o cancelado (reducao ou recusa do fornecedor). Sem cancelado,
-- e o mesmo de antes.
CREATE OR REPLACE FUNCTION purchase_order_links_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
  IF total + NEW.base_qty > (it.packs - it.canceled_packs) * it.base_qty_per_pack THEN
    RAISE EXCEPTION 'vinculos acima da quantidade comprada' USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_order_links_over_item';
  END IF;
  SELECT coalesce(sum(base_qty), 0) INTO total FROM purchase_order_links WHERE allocation_id = NEW.allocation_id AND status = 'active' AND id <> NEW.id;
  IF total + NEW.base_qty > a.base_qty THEN
    RAISE EXCEPTION 'vinculos acima da quantidade encomendada' USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_order_links_over_allocation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Requisicoes internas de compra.
--   manual     pedida por alguem da equipe (estoque, logistica, gerencia)
--   backorder  automatica: encomenda de cliente ainda sem compra vinculada (uma aberta por encomenda)
-- Situacao:
--   open         aguardando o comprador
--   in_purchase  ja esta num pedido de compra (ou a encomenda foi vinculada a uma compra)
--   done         a compra chegou (ou a encomenda foi atendida)
--   rejected     recusada pelo comprador, com motivo
--   canceled     cancelada (por quem pediu, ou a encomenda deixou de existir)
-- A requisicao nao reserva nem movimenta estoque e nao gera compra sozinha.
CREATE TABLE purchase_requests (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                  bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  source                  text NOT NULL CHECK (source IN ('manual', 'backorder')),
  variant_id              uuid NOT NULL REFERENCES product_variants (id),
  packaging_id            uuid REFERENCES packagings (id),
  warehouse_id            uuid NOT NULL REFERENCES warehouses (id),
  base_qty                numeric(14,3) NOT NULL CHECK (base_qty > 0),
  reason                  text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  needed_by               date,
  allocation_id           uuid REFERENCES fulfillment_allocations (id),
  -- Sem FK para orders (mesma razao de purchase_order_links: nao travar o pedido do cliente).
  order_id                uuid,
  status                  text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_purchase', 'done', 'rejected', 'canceled')),
  purchase_order_id       uuid REFERENCES purchase_orders (id),
  purchase_order_item_id  uuid REFERENCES purchase_order_items (id),
  decision_note           text CHECK (length(decision_note) BETWEEN 3 AND 500),
  requested_by            uuid REFERENCES users (id),
  decided_by              uuid REFERENCES users (id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_requests_source CHECK (CASE source
    WHEN 'backorder' THEN allocation_id IS NOT NULL AND order_id IS NOT NULL AND requested_by IS NULL
    ELSE allocation_id IS NULL AND order_id IS NULL AND requested_by IS NOT NULL END),
  CONSTRAINT purchase_requests_in_purchase CHECK (status <> 'in_purchase' OR purchase_order_id IS NOT NULL),
  CONSTRAINT purchase_requests_open CHECK (status <> 'open' OR (purchase_order_id IS NULL AND purchase_order_item_id IS NULL)),
  CONSTRAINT purchase_requests_rejected CHECK (status <> 'rejected' OR (decided_by IS NOT NULL AND decision_note IS NOT NULL))
);
-- Uma requisicao aberta (ou em compra) por encomenda; uma manual aberta por produto e deposito.
CREATE UNIQUE INDEX purchase_requests_one_per_allocation ON purchase_requests (allocation_id) WHERE status IN ('open', 'in_purchase');
CREATE UNIQUE INDEX purchase_requests_one_manual ON purchase_requests (variant_id, warehouse_id) WHERE status = 'open' AND source = 'manual';
CREATE INDEX purchase_requests_status_idx ON purchase_requests (status, warehouse_id);
CREATE INDEX purchase_requests_po_idx ON purchase_requests (purchase_order_id) WHERE purchase_order_id IS NOT NULL;

CREATE TABLE purchase_request_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id         uuid NOT NULL REFERENCES purchase_requests (id),
  kind               text NOT NULL CHECK (kind IN ('created', 'in_purchase', 'returned', 'done', 'rejected', 'canceled')),
  note               text CHECK (length(note) BETWEEN 3 AND 500),
  data               jsonb NOT NULL DEFAULT '{}'::jsonb,
  purchase_order_id  uuid REFERENCES purchase_orders (id),
  -- Nulo nas acoes automaticas (sistema).
  actor_id           uuid REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_request_events_request_idx ON purchase_request_events (request_id, id);
CREATE TRIGGER purchase_request_events_immutable BEFORE UPDATE OR DELETE ON purchase_request_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Compra cancelada: a requisicao volta para "aberta" (nao se perde). Compra recebida (encerrada): atendida. Vale
-- tambem para o codigo anterior, que nao conhece as requisicoes.
CREATE FUNCTION purchase_orders_requests() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status = 'canceled' THEN
    INSERT INTO purchase_request_events (request_id, kind, note, purchase_order_id, actor_id)
    SELECT id, 'returned', 'Compra cancelada: a requisição voltou a ficar aberta', NEW.id, NULL
      FROM purchase_requests WHERE purchase_order_id = NEW.id AND status = 'in_purchase';
    UPDATE purchase_requests SET status = 'open', purchase_order_id = NULL, purchase_order_item_id = NULL, updated_at = now()
     WHERE purchase_order_id = NEW.id AND status = 'in_purchase';
  ELSE
    INSERT INTO purchase_request_events (request_id, kind, note, purchase_order_id, actor_id)
    SELECT id, 'done', 'Compra recebida', NEW.id, NULL FROM purchase_requests WHERE purchase_order_id = NEW.id AND status = 'in_purchase';
    UPDATE purchase_requests SET status = 'done', updated_at = now() WHERE purchase_order_id = NEW.id AND status = 'in_purchase';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_orders_requests AFTER UPDATE OF status ON purchase_orders FOR EACH ROW
  WHEN (NEW.status IN ('received', 'canceled') AND OLD.status NOT IN ('received', 'canceled')) EXECUTE FUNCTION purchase_orders_requests();

-- ---------------------------------------------------------------------------------------------------------------
-- Regras do abastecimento. E-mail ao fornecedor bloqueado (D7-2): so a equipe envia, pelo canal dela.
ALTER TABLE logistics_settings
  ADD COLUMN purchase_confirmation_days integer NOT NULL DEFAULT 2
    CONSTRAINT logistics_settings_confirmation_days_check CHECK (purchase_confirmation_days BETWEEN 1 AND 30),
  ADD COLUMN supplier_email_status text NOT NULL DEFAULT 'blocked'
    CONSTRAINT logistics_settings_supplier_email_check CHECK (supplier_email_status IN ('blocked'));

-- ---------------------------------------------------------------------------------------------------------------
-- Privilegios minimos: historicos so por inclusao; a confirmacao so muda a decisao (o gatilho confere).
GRANT SELECT, INSERT ON purchase_order_documents, purchase_confirmation_items, purchase_request_events TO loja_app;
GRANT SELECT, INSERT, UPDATE ON purchase_confirmations, purchase_requests TO loja_app;

-- Resumo para quem aplica.
DO $$
DECLARE ms numeric; n_sent integer; n_backorder integer;
BEGIN
  ms := round(extract(epoch FROM clock_timestamp() - current_setting('sglog.t0')::timestamptz) * 1000);
  SELECT count(*) INTO n_sent FROM purchase_orders WHERE status IN ('sent', 'partial');
  SELECT count(*) INTO n_backorder FROM stock_reservations WHERE status = 'active' AND backorder;
  RAISE NOTICE '0026: compras bloqueadas por % ms (ate aqui; o bloqueio termina no COMMIT)', ms;
  RAISE NOTICE '0026: % compra(s) enviada(s) ficam como anteriores ao acompanhamento (sem alerta retroativo); % encomenda(s) ativa(s) podem gerar requisicao automatica', n_sent, n_backorder;
END $$;
