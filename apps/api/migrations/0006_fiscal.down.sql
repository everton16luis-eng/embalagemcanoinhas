-- Desfaz a estrutura da Fase 5. So para desenvolvimento: com nota emitida, as tabelas fiscais recusam a remocao de linhas.
DROP TABLE IF EXISTS fiscal_webhook_notifications, fiscal_certificates, fiscal_files, fiscal_inutilizations, fiscal_document_events, fiscal_documents, fiscal_rules_history, fiscal_rules;
DROP FUNCTION IF EXISTS fiscal_documents_guard(), fiscal_rules_log(), fiscal_rules_guard();
ALTER TABLE orders DROP CONSTRAINT orders_invoice_status_check;
UPDATE orders SET invoice_status = 'pending' WHERE invoice_status IN ('processing', 'rejected', 'canceled');
ALTER TABLE orders ADD CONSTRAINT orders_invoice_status_check CHECK (invoice_status IN ('pending', 'authorized', 'not_required'));
ALTER TABLE fiscal_settings DROP COLUMN production_validator_name, DROP COLUMN emission_policy;
