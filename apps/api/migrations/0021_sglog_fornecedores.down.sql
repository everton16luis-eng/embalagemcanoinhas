-- Reversao da 0021. Remove so o que a 0021 criou e devolve CASCADE e DELETE como antes.
-- Recusa, sem mudar nada, se a reversao fosse apagar informacao registrada depois da migration: nesse caso o caminho
-- e voltar so o codigo (o codigo antigo funciona com a 0021 aplicada; ver docs/18-sglog-fase2.md).
SET LOCAL lock_timeout = '10s';
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '10 seconds'; tries integer := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE supplier_products IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE suppliers IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE supplier_contacts IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE purchase_order_items IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE supplier_price_history IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE supplier_availability IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE supplier_settings IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE user_permissions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF clock_timestamp() > deadline THEN
        RAISE EXCEPTION '0021 down: tabelas de fornecedores ocupadas por mais de 10 s (% tentativas); nada foi alterado, tente de novo', tries
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.02);
    END;
  END LOOP;
END $$;

DO $$
DECLARE motivos text[] := '{}';
BEGIN
  IF EXISTS (SELECT 1 FROM suppliers WHERE status = 'blocked' OR archived_at IS NOT NULL) THEN
    motivos := array_append(motivos, 'ha fornecedor bloqueado ou arquivado'); END IF;
  IF EXISTS (SELECT 1 FROM suppliers WHERE cep IS NOT NULL OR street IS NOT NULL OR number IS NOT NULL OR complement IS NOT NULL
             OR district IS NOT NULL OR prep_days IS NOT NULL OR delivery_days IS NOT NULL OR return_policy IS NOT NULL
             OR return_days IS NOT NULL OR order_freight_cents IS NOT NULL OR order_extra_cents IS NOT NULL OR dropship_enabled) THEN
    motivos := array_append(motivos, 'ha endereco, prazo, devolucao, custo de pedido ou dropshipping preenchido em fornecedor'); END IF;
  IF EXISTS (SELECT 1 FROM supplier_contacts WHERE whatsapp IS NOT NULL OR is_primary) THEN
    motivos := array_append(motivos, 'ha WhatsApp ou contato principal preenchido'); END IF;
  IF EXISTS (SELECT 1 FROM supplier_products WHERE status = 'ended' OR is_primary OR min_order_packs IS NOT NULL
             OR order_multiple_packs IS NOT NULL OR prep_days IS NOT NULL OR dropship_allowed) THEN
    motivos := array_append(motivos, 'ha oferta encerrada, principal, ou com minimo, multiplo, preparo ou dropshipping preenchido'); END IF;
  IF EXISTS (SELECT 1 FROM supplier_price_history WHERE source <> 'migration') THEN
    motivos := array_append(motivos, 'ha historico de custo registrado depois da migration'); END IF;
  IF EXISTS (SELECT 1 FROM supplier_availability) THEN
    motivos := array_append(motivos, 'ha disponibilidade informada'); END IF;
  IF EXISTS (SELECT 1 FROM supplier_settings WHERE version > 1) THEN
    motivos := array_append(motivos, 'os parametros de fornecedores foram alterados'); END IF;
  IF EXISTS (SELECT 1 FROM purchase_order_items WHERE min_order_packs IS NOT NULL OR order_multiple_packs IS NOT NULL OR min_exception_reason IS NOT NULL) THEN
    motivos := array_append(motivos, 'ha item de pedido de compra com minimo ou justificativa registrados'); END IF;
  -- suppliers.* que nao sejam copia exata de purchases.* foram concedidas depois da migration.
  IF EXISTS (SELECT 1 FROM user_permissions s WHERE s.permission LIKE 'suppliers.%' AND NOT EXISTS (
               SELECT 1 FROM user_permissions p WHERE p.user_id = s.user_id
               AND p.permission = replace(s.permission, 'suppliers.', 'purchases.') AND p.granted = s.granted)) THEN
    motivos := array_append(motivos, 'ha permissao individual de fornecedores diferente da de compras'); END IF;
  IF cardinality(motivos) > 0 THEN
    RAISE EXCEPTION '0021 down recusado, nada foi alterado: %. Volte so o codigo (a 0021 e compativel com o codigo antigo).', array_to_string(motivos, '; ')
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

DELETE FROM user_permissions WHERE permission IN ('suppliers.view', 'suppliers.manage');

REVOKE ALL ON supplier_price_history, supplier_offer_terms, supplier_availability, supplier_settings FROM loja_app;
GRANT DELETE ON suppliers, supplier_products TO loja_app;

DROP VIEW supplier_offer_terms;
DROP TRIGGER supplier_products_sync ON supplier_products;
DROP TRIGGER supplier_products_price ON supplier_products;
DROP TRIGGER suppliers_drop_primary ON suppliers;
DROP TRIGGER suppliers_sync ON suppliers;
DROP FUNCTION supplier_products_sync();
DROP FUNCTION supplier_products_price_history();
DROP FUNCTION suppliers_drop_primary();
DROP FUNCTION suppliers_sync();

DROP TABLE supplier_settings;
DROP TABLE supplier_availability;
DROP TABLE supplier_price_history;

ALTER TABLE purchase_order_items DROP COLUMN min_order_packs, DROP COLUMN order_multiple_packs, DROP COLUMN min_exception_reason;

ALTER TABLE supplier_products DROP CONSTRAINT supplier_products_supplier_id_fkey,
  ADD CONSTRAINT supplier_products_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE CASCADE;
ALTER TABLE supplier_contacts DROP CONSTRAINT supplier_contacts_supplier_id_fkey,
  ADD CONSTRAINT supplier_contacts_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE CASCADE;

DROP INDEX supplier_products_variant_idx;
DROP INDEX supplier_products_sku_unique;
DROP INDEX supplier_products_one_primary;
ALTER TABLE supplier_products DROP CONSTRAINT supplier_products_sku_trimmed, DROP COLUMN variant_id, DROP COLUMN min_order_packs, DROP COLUMN order_multiple_packs, DROP COLUMN prep_days,
  DROP COLUMN dropship_allowed, DROP COLUMN is_primary, DROP COLUMN status, DROP COLUMN ended_at, DROP COLUMN ended_by,
  DROP COLUMN end_reason, DROP COLUMN created_at, DROP COLUMN version;

DROP INDEX supplier_contacts_one_primary;
ALTER TABLE supplier_contacts DROP COLUMN whatsapp, DROP COLUMN is_primary;

DROP INDEX suppliers_status_idx;
ALTER TABLE suppliers DROP COLUMN cep, DROP COLUMN street, DROP COLUMN number, DROP COLUMN complement, DROP COLUMN district,
  DROP COLUMN prep_days, DROP COLUMN delivery_days, DROP COLUMN return_policy, DROP COLUMN return_days, DROP COLUMN order_freight_cents,
  DROP COLUMN order_extra_cents, DROP COLUMN dropship_enabled, DROP COLUMN status, DROP COLUMN blocked_reason, DROP COLUMN blocked_by,
  DROP COLUMN blocked_at, DROP COLUMN archived_at, DROP COLUMN archived_by, DROP COLUMN archive_reason, DROP COLUMN version;
