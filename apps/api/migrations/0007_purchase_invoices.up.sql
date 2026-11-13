-- XML de NF-e de compra (fornecedor). Guardado para conferencia com o pedido de compra; nao movimenta estoque.
-- O recebimento continua manual no pedido de compra, com a chave da nota como referencia.
CREATE TABLE purchase_invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_key         text NOT NULL UNIQUE CHECK (access_key ~ '^[0-9]{44}$'),
  series             text NOT NULL CHECK (length(series) <= 3),
  number             text NOT NULL CHECK (length(number) <= 9),
  issued_at          timestamptz,
  supplier_document  text NOT NULL CHECK (supplier_document ~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$'),
  supplier_name      text NOT NULL CHECK (length(supplier_name) <= 150),
  recipient_document text,
  total_cents        bigint NOT NULL CHECK (total_cents >= 0),
  protocol_status    text CHECK (length(protocol_status) <= 5),
  items              jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  storage_key        text NOT NULL UNIQUE,
  sha256             text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  bytes              integer NOT NULL CHECK (bytes > 0),
  -- Vinculos feitos na conferencia (unicos campos que mudam).
  supplier_id        uuid REFERENCES suppliers (id),
  purchase_order_id  uuid REFERENCES purchase_orders (id),
  created_by         uuid NOT NULL REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_invoices_created_idx ON purchase_invoices (created_at DESC);
CREATE INDEX purchase_invoices_order_idx ON purchase_invoices (purchase_order_id);
CREATE TRIGGER purchase_invoices_no_delete BEFORE DELETE ON purchase_invoices FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

GRANT SELECT, INSERT ON purchase_invoices TO loja_app;
GRANT UPDATE (supplier_id, purchase_order_id) ON purchase_invoices TO loja_app;
