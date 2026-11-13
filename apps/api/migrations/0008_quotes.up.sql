-- Fase 6: central comercial. Orcamento com precos congelados, link publico e conversao em pedido sem redigitar.
CREATE SEQUENCE quote_number START 1;

CREATE TABLE quotes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             integer NOT NULL UNIQUE DEFAULT nextval('quote_number'),
  -- Link publico do orcamento: derivado do id com a chave secreta do servidor; so o hash no banco.
  public_token_hash  text NOT NULL UNIQUE,
  request_key        text NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  -- open: valido ate valid_until; converted: virou pedido; canceled: desistencia. Vencido e calculado pela data.
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'converted', 'canceled')),
  -- Dados do cliente como informados no orcamento. Documento e e-mail podem faltar; o cliente completa ao aceitar.
  buyer              jsonb NOT NULL CHECK (jsonb_typeof(buyer) = 'object'),
  customer_id        uuid REFERENCES customers (id),
  ship_to            jsonb,
  shipping_option_id uuid REFERENCES shipping_options (id),
  shipping_snapshot  jsonb,
  subtotal_cents     bigint NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents     bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  freight_cents      bigint NOT NULL DEFAULT 0 CHECK (freight_cents >= 0),
  total_cents        bigint NOT NULL CHECK (total_cents > 0),
  notes              text CHECK (length(notes) <= 500),
  valid_until        date NOT NULL,
  order_id           uuid REFERENCES orders (id),
  conversions        integer NOT NULL DEFAULT 0 CHECK (conversions >= 0),
  shared_at          timestamptz,
  canceled_at        timestamptz,
  cancel_reason      text CHECK (length(cancel_reason) <= 300),
  created_by         uuid NOT NULL REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quotes_total CHECK (total_cents = subtotal_cents - discount_cents + freight_cents),
  CONSTRAINT quotes_ship CHECK ((shipping_option_id IS NULL) = (shipping_snapshot IS NULL))
);
ALTER SEQUENCE quote_number OWNED BY quotes.number;
CREATE INDEX quotes_status_idx ON quotes (status, created_at DESC);
CREATE INDEX quotes_order_idx ON quotes (order_id);

-- Itens com preco do momento do orcamento. Nao mudam: para alterar, faz-se outro orcamento.
CREATE TABLE quote_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id           uuid NOT NULL REFERENCES quotes (id),
  position           integer NOT NULL CHECK (position >= 0),
  variant_id         uuid NOT NULL REFERENCES product_variants (id),
  packaging_id       uuid NOT NULL REFERENCES packagings (id),
  sku                text NOT NULL,
  product_name       text NOT NULL,
  packaging_label    text NOT NULL,
  base_qty_per_pack  numeric(14,3) NOT NULL CHECK (base_qty_per_pack > 0),
  packs              integer NOT NULL CHECK (packs > 0),
  list_price_cents   bigint NOT NULL CHECK (list_price_cents >= 0),
  unit_price_cents   bigint NOT NULL CHECK (unit_price_cents >= 0),
  total_cents        bigint NOT NULL CHECK (total_cents = unit_price_cents * packs),
  made_to_order      boolean NOT NULL,
  lead_time_days     integer,
  UNIQUE (quote_id, packaging_id),
  UNIQUE (quote_id, position)
);
CREATE TRIGGER quote_items_immutable BEFORE UPDATE OR DELETE ON quote_items FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER quotes_no_delete BEFORE DELETE ON quotes FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE quote_events (
  id         bigserial PRIMARY KEY,
  quote_id   uuid NOT NULL REFERENCES quotes (id),
  kind       text NOT NULL CHECK (kind IN ('created', 'shared', 'converted', 'canceled', 'duplicated')),
  note       text CHECK (length(note) <= 300),
  actor_id   uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quote_events_quote_idx ON quote_events (quote_id, id);
CREATE TRIGGER quote_events_immutable BEFORE UPDATE OR DELETE ON quote_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

GRANT SELECT, INSERT ON quotes, quote_items, quote_events TO loja_app;
GRANT UPDATE (status, order_id, conversions, shared_at, canceled_at, cancel_reason, updated_at) ON quotes TO loja_app;
GRANT USAGE ON SEQUENCE quote_number, quote_events_id_seq TO loja_app;
