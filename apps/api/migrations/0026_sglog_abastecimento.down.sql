-- Reverte a 0026 (SGLog Fase 7). Recusa, sem alterar nada, quando a Fase 7 ja foi usada: documento enviado,
-- confirmacao do fornecedor, saldo cancelado, prazo, requisicao, contato registrado ou regra alterada. Apagar historico
-- para voltar nao e opcao: nesse caso a volta e so do codigo (a 0026 e compativel com o codigo anterior).

SET LOCAL lock_timeout = '10s';
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '10 seconds'; tries integer := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE purchase_orders IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE purchase_order_items IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE purchase_order_events IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE logistics_settings IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE purchase_order_links IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF clock_timestamp() > deadline THEN
        RAISE EXCEPTION 'Reversao da 0026: tabelas ocupadas por mais de 10 s (% tentativas); nada foi alterado, tente de novo', tries
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.02);
    END;
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM purchase_order_documents) OR EXISTS (SELECT 1 FROM purchase_confirmations) THEN
    RAISE EXCEPTION 'Reversao da 0026 recusada: ha documento enviado ou confirmacao do fornecedor registrada.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM purchase_requests) THEN
    RAISE EXCEPTION 'Reversao da 0026 recusada: ha requisicao de compra registrada.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM purchase_order_items WHERE canceled_packs <> 0 OR supplier_outcome IS NOT NULL OR promised_at IS NOT NULL OR partial_packs IS NOT NULL)
     OR EXISTS (SELECT 1 FROM purchase_orders WHERE confirmation_status <> 'none' OR sent_via IS NOT NULL OR supplier_ref IS NOT NULL
                OR promised_at IS NOT NULL OR followup_on IS NOT NULL)
     OR EXISTS (SELECT 1 FROM purchase_order_events WHERE kind IN ('document_resent', 'confirmation', 'confirmation_approved', 'confirmation_rejected',
                'closed_by_confirmation', 'followup', 'requests_added')) THEN
    RAISE EXCEPTION 'Reversao da 0026 recusada: ha compra com envio, confirmacao, prazo ou contato registrado pela Fase 7.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM logistics_settings WHERE purchase_confirmation_days <> 2) THEN
    RAISE EXCEPTION 'Reversao da 0026 recusada: o prazo de confirmacao foi alterado; volte para 2 dias antes de reverter.' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

ALTER TABLE logistics_settings DROP COLUMN purchase_confirmation_days, DROP COLUMN supplier_email_status;

DROP TRIGGER purchase_orders_requests ON purchase_orders;
DROP FUNCTION purchase_orders_requests();
DROP TABLE purchase_request_events;
DROP TABLE purchase_requests;

-- Gatilho dos vinculos da 0025.
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
  IF total + NEW.base_qty > it.packs * it.base_qty_per_pack THEN
    RAISE EXCEPTION 'vinculos acima da quantidade comprada' USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_order_links_over_item';
  END IF;
  SELECT coalesce(sum(base_qty), 0) INTO total FROM purchase_order_links WHERE allocation_id = NEW.allocation_id AND status = 'active' AND id <> NEW.id;
  IF total + NEW.base_qty > a.base_qty THEN
    RAISE EXCEPTION 'vinculos acima da quantidade encomendada' USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_order_links_over_allocation';
  END IF;
  RETURN NEW;
END $$;

DROP TABLE purchase_confirmation_items;
DROP TRIGGER purchase_confirmations_guard ON purchase_confirmations;
DROP TABLE purchase_confirmations;
DROP FUNCTION purchase_confirmations_guard();
DROP TABLE purchase_order_documents;

DROP INDEX purchase_orders_followup_idx;
ALTER TABLE purchase_order_events DROP CONSTRAINT purchase_order_events_note;
ALTER TABLE purchase_order_events ADD CONSTRAINT purchase_order_events_note
  CHECK (kind NOT IN ('approval_rejected', 'closed_short', 'canceled') OR note IS NOT NULL);
ALTER TABLE purchase_order_events DROP CONSTRAINT purchase_order_events_kind_check;
ALTER TABLE purchase_order_events ADD CONSTRAINT purchase_order_events_kind_check
  CHECK (kind IN ('submitted', 'approved', 'approval_rejected', 'back_to_draft', 'payment_informed', 'sent', 'shipping_updated', 'closed_short', 'canceled'));

ALTER TABLE purchase_order_items
  DROP CONSTRAINT purchase_order_items_partial,
  DROP CONSTRAINT purchase_order_items_canceled,
  DROP COLUMN rest_promised_at,
  DROP COLUMN partial_from_packs,
  DROP COLUMN partial_packs,
  DROP COLUMN promised_at,
  DROP COLUMN supplier_outcome,
  DROP COLUMN canceled_packs;

ALTER TABLE purchase_orders
  DROP COLUMN followup_on,
  DROP COLUMN promised_at,
  DROP COLUMN confirmed_at,
  DROP COLUMN confirmation_status,
  DROP COLUMN supplier_ref,
  DROP COLUMN sent_document_version,
  DROP COLUMN sent_via;
