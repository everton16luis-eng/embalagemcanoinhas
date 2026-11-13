-- Loja: faixas de preco por quantidade, clientes, carrinho, frete, pedidos e pagamentos.

-- Preco por embalagem a partir de N embalagens. Abaixo da primeira faixa vale o preco da embalagem.
CREATE TABLE price_tiers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  packaging_id  uuid NOT NULL REFERENCES packagings (id) ON DELETE CASCADE,
  min_packs     integer NOT NULL CHECK (min_packs >= 2 AND min_packs <= 100000),
  price_cents   bigint NOT NULL CHECK (price_cents > 0),
  UNIQUE (packaging_id, min_packs)
);

-- Clientes da loja. Conta e opcional: pedido de visitante guarda os dados no proprio pedido.
CREATE TABLE customers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL CHECK (kind IN ('pf', 'pj')),
  name                text NOT NULL CHECK (length(name) BETWEEN 2 AND 150),
  email               citext NOT NULL UNIQUE CHECK (length(email) <= 254),
  phone               text CHECK (phone ~ '^[0-9]{10,13}$'),
  document            text CHECK (document ~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$'),
  state_registration  text CHECK (length(state_registration) <= 20),
  password_hash       text NOT NULL,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customer_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES customers (id),
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customer_addresses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  label        text CHECK (length(label) <= 40),
  recipient    text NOT NULL CHECK (length(recipient) BETWEEN 2 AND 120),
  cep          text NOT NULL CHECK (cep ~ '^[0-9]{8}$'),
  street       text NOT NULL CHECK (length(street) BETWEEN 2 AND 120),
  number       text NOT NULL CHECK (length(number) BETWEEN 1 AND 20),
  complement   text CHECK (length(complement) <= 60),
  district     text NOT NULL CHECK (length(district) BETWEEN 2 AND 60),
  city         text NOT NULL CHECK (length(city) BETWEEN 2 AND 60),
  uf           text NOT NULL CHECK (uf ~ '^[A-Z]{2}$'),
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customer_addresses_default ON customer_addresses (customer_id) WHERE is_default;

-- Login do cliente: a API nao le o hash da senha diretamente.
CREATE FUNCTION customer_login_lookup(p_email text) RETURNS TABLE (id uuid, password_hash text, is_active boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.password_hash, c.is_active FROM customers c WHERE c.email = p_email::citext
$$;
REVOKE ALL ON FUNCTION customer_login_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_login_lookup(text) TO loja_app;

-- Carrinho identificado por cookie aleatorio (so o hash fica no banco).
CREATE TABLE carts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  customer_id  uuid REFERENCES customers (id),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'converted')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cart_items (
  cart_id       uuid NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  packaging_id  uuid NOT NULL REFERENCES packagings (id),
  packs         integer NOT NULL CHECK (packs BETWEEN 1 AND 100000),
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cart_id, packaging_id)
);

-- Opcoes de entrega cadastradas pela loja: retirada ou entrega por faixa de CEP e peso.
CREATE TABLE shipping_options (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  kind              text NOT NULL CHECK (kind IN ('pickup', 'delivery')),
  description       text CHECK (length(description) <= 300),
  -- Faixas "89460000-89479999". Vazio em entrega = nao atende ninguem.
  cep_ranges        text[] NOT NULL DEFAULT '{}' CHECK (cep_ranges <@ ARRAY[]::text[] OR array_length(cep_ranges, 1) <= 200),
  base_cents        bigint NOT NULL DEFAULT 0 CHECK (base_cents >= 0),
  per_kg_cents      bigint NOT NULL DEFAULT 0 CHECK (per_kg_cents >= 0),
  free_above_cents  bigint CHECK (free_above_cents > 0),
  max_weight_g      integer CHECK (max_weight_g > 0),
  min_days          integer NOT NULL DEFAULT 1 CHECK (min_days BETWEEN 0 AND 60),
  max_days          integer NOT NULL DEFAULT 3 CHECK (max_days BETWEEN 0 AND 60),
  active            boolean NOT NULL DEFAULT true,
  position          integer NOT NULL DEFAULT 0,
  CONSTRAINT shipping_options_days CHECK (max_days >= min_days)
);

CREATE SEQUENCE order_number START 1001;
CREATE TABLE orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             integer NOT NULL UNIQUE DEFAULT nextval('order_number'),
  -- Link de acompanhamento do pedido (visitante); so o hash no banco.
  public_token_hash  text NOT NULL UNIQUE,
  request_key        text NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  customer_id        uuid REFERENCES customers (id),
  channel            text NOT NULL DEFAULT 'store' CHECK (channel IN ('store', 'sales_desk')),
  status             text NOT NULL DEFAULT 'pending_payment'
                     CHECK (status IN ('pending_payment', 'paid', 'preparing', 'ready', 'shipped', 'delivered', 'canceled')),
  -- Copia dos dados no momento da compra (emissao da nota usa estes dados).
  buyer              jsonb NOT NULL,
  ship_to            jsonb,
  shipping_option_id uuid REFERENCES shipping_options (id),
  shipping_snapshot  jsonb NOT NULL,
  payment_method     text NOT NULL CHECK (payment_method IN ('pix', 'card')),
  subtotal_cents     bigint NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents     bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  freight_cents      bigint NOT NULL DEFAULT 0 CHECK (freight_cents >= 0),
  total_cents        bigint NOT NULL CHECK (total_cents > 0),
  notes              text CHECK (length(notes) <= 500),
  -- Expedicao so com NF-e autorizada (Fase 5 grava 'authorized').
  invoice_status     text NOT NULL DEFAULT 'pending' CHECK (invoice_status IN ('pending', 'authorized', 'not_required')),
  has_backorder      boolean NOT NULL DEFAULT false,
  payment_due_at     timestamptz NOT NULL,
  paid_at            timestamptz,
  canceled_at        timestamptz,
  cancel_reason      text CHECK (length(cancel_reason) <= 300),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            integer NOT NULL DEFAULT 1,
  CONSTRAINT orders_total CHECK (total_cents = subtotal_cents - discount_cents + freight_cents)
);
ALTER SEQUENCE order_number OWNED BY orders.number;
CREATE INDEX orders_status_idx ON orders (status, created_at DESC);
CREATE INDEX orders_customer_idx ON orders (customer_id, created_at DESC);
CREATE INDEX orders_due_idx ON orders (payment_due_at) WHERE status = 'pending_payment';

CREATE TABLE order_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders (id),
  variant_id         uuid NOT NULL REFERENCES product_variants (id),
  packaging_id       uuid NOT NULL REFERENCES packagings (id),
  sku                text NOT NULL,
  product_name       text NOT NULL,
  packaging_label    text NOT NULL,
  base_qty_per_pack  numeric(14,3) NOT NULL CHECK (base_qty_per_pack > 0),
  packs              integer NOT NULL CHECK (packs > 0),
  list_price_cents   bigint NOT NULL CHECK (list_price_cents > 0),
  unit_price_cents   bigint NOT NULL CHECK (unit_price_cents > 0),
  total_cents        bigint NOT NULL CHECK (total_cents > 0),
  made_to_order      boolean NOT NULL DEFAULT false,
  lead_time_days     integer,
  CONSTRAINT order_items_total CHECK (total_cents = unit_price_cents * packs)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE TRIGGER order_items_immutable BEFORE UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Historico de situacoes do pedido. Somente inclusao.
CREATE TABLE order_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders (id),
  status      text NOT NULL,
  note        text CHECK (length(note) <= 500),
  actor_id    uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events (order_id, id);
CREATE TRIGGER order_events_immutable BEFORE UPDATE OR DELETE ON order_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id             uuid NOT NULL REFERENCES orders (id),
  provider             text NOT NULL CHECK (provider IN ('mercadopago', 'fake')),
  method               text NOT NULL CHECK (method IN ('pix', 'card')),
  -- Enviada ao provedor: repeticao do pedido nao cria segunda cobranca.
  idempotency_key      text NOT NULL UNIQUE,
  provider_payment_id  text,
  status               text NOT NULL DEFAULT 'created'
                       CHECK (status IN ('created', 'pending', 'approved', 'rejected', 'canceled', 'refunded', 'charged_back', 'error')),
  status_detail        text,
  amount_cents         bigint NOT NULL CHECK (amount_cents > 0),
  -- Pix: copia e cola e QR (base64) para mostrar ao cliente. Nunca dados de cartao.
  pix_qr_code          text,
  pix_qr_base64        text,
  pix_expires_at       timestamptz,
  card_last_four       text CHECK (card_last_four ~ '^[0-9]{4}$'),
  card_brand           text,
  installments         integer,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id)
);
CREATE INDEX payments_order_idx ON payments (order_id, created_at DESC);

-- Notificacoes recebidas do provedor. A mesma notificacao repetida nao e processada duas vezes.
CREATE TABLE payment_notifications (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider         text NOT NULL,
  dedupe_key       text NOT NULL,
  resource_id      text,
  payload          jsonb NOT NULL,
  signature_valid  boolean NOT NULL,
  processed_at     timestamptz,
  error            text,
  received_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, dedupe_key)
);

CREATE TABLE shipments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL UNIQUE REFERENCES orders (id),
  carrier       text CHECK (length(carrier) <= 80),
  tracking_code text CHECK (length(tracking_code) <= 60),
  tracking_url  text CHECK (length(tracking_url) <= 300),
  volumes       integer CHECK (volumes > 0),
  weight_g      integer CHECK (weight_g > 0),
  shipped_at    timestamptz,
  delivered_at  timestamptz,
  shipped_by    uuid REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON price_tiers, cart_items, customer_addresses, shipping_options TO loja_app;
GRANT SELECT (id, kind, name, email, phone, document, state_registration, is_active, created_at, updated_at) ON customers TO loja_app;
GRANT INSERT, UPDATE ON customers TO loja_app;
GRANT SELECT, INSERT, UPDATE ON customer_sessions, carts, orders, payments, payment_notifications, shipments TO loja_app;
GRANT SELECT, INSERT ON order_items, order_events TO loja_app;
GRANT USAGE ON SEQUENCE order_number TO loja_app;
