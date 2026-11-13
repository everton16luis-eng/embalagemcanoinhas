-- Fase 7: Mercado Livre e Shopee (docs/07-marketplaces.md).
ALTER TABLE orders DROP CONSTRAINT orders_channel_check;
ALTER TABLE orders ADD CONSTRAINT orders_channel_check CHECK (channel IN ('store', 'sales_desk', 'mercadolivre', 'shopee'));
ALTER TABLE orders DROP CONSTRAINT orders_payment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('pix', 'card', 'marketplace'));

-- Conta da loja autorizada no marketplace. Tokens cifrados com ENC_KEY; credenciais do aplicativo so no .env.
CREATE TABLE marketplace_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel            text NOT NULL CHECK (channel IN ('mercadolivre', 'shopee')),
  external_id        text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 40),
  name               text NOT NULL CHECK (length(name) <= 120),
  access_token_enc   text,
  refresh_token_enc  text,
  access_expires_at  timestamptz,
  refresh_expires_at timestamptz,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reauth_required', 'disconnected')),
  last_error         text CHECK (length(last_error) <= 500),
  connected_by       uuid NOT NULL REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_id)
);

-- Pedido de autorizacao em andamento (state contra CSRF e verificador PKCE). Uso unico, 15 minutos.
CREATE TABLE marketplace_oauth_states (
  state_hash        text PRIMARY KEY,
  channel           text NOT NULL CHECK (channel IN ('mercadolivre', 'shopee')),
  code_verifier_enc text,
  created_by        uuid NOT NULL REFERENCES users (id),
  expires_at        timestamptz NOT NULL,
  used_at           timestamptz
);

-- Anuncio (ou modelo) do marketplace ligado a uma embalagem de venda nossa.
CREATE TABLE marketplace_listings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES marketplace_accounts (id),
  external_item_id      text NOT NULL CHECK (length(external_item_id) BETWEEN 1 AND 40),
  -- '' = anuncio sem variacao (Shopee: model_id 0).
  external_variation_id text NOT NULL DEFAULT '' CHECK (length(external_variation_id) <= 40),
  packaging_id          uuid NOT NULL REFERENCES packagings (id),
  title                 text CHECK (length(title) <= 200),
  sync_stock            boolean NOT NULL DEFAULT true,
  active                boolean NOT NULL DEFAULT true,
  last_pushed_qty       integer,
  last_pushed_at        timestamptz,
  last_error            text CHECK (length(last_error) <= 500),
  created_by            uuid NOT NULL REFERENCES users (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_item_id, external_variation_id)
);
CREATE INDEX marketplace_listings_packaging_idx ON marketplace_listings (packaging_id);

-- Venda do marketplace. Uma linha por pedido de la; order_id quando importada para o nosso pedido.
CREATE TABLE marketplace_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES marketplace_accounts (id),
  external_order_id text NOT NULL CHECK (length(external_order_id) BETWEEN 1 AND 40),
  external_status   text,
  snapshot          jsonb,
  order_id          uuid UNIQUE REFERENCES orders (id),
  state             text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'imported', 'waiting', 'error', 'ignored', 'canceled')),
  last_error        text CHECK (length(last_error) <= 500),
  check_count       integer NOT NULL DEFAULT 0,
  next_check_at     timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_order_id)
);
CREATE INDEX marketplace_orders_due_idx ON marketplace_orders (next_check_at) WHERE state IN ('pending', 'waiting', 'error');

-- Avisos recebidos (so registro; a verdade vem da consulta).
CREATE TABLE marketplace_notifications (
  id          bigserial PRIMARY KEY,
  channel     text NOT NULL CHECK (channel IN ('mercadolivre', 'shopee')),
  external_id text,
  topic       text,
  resource    text CHECK (length(resource) <= 200),
  verified    boolean NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX marketplace_notifications_received_idx ON marketplace_notifications (received_at DESC);

CREATE TRIGGER marketplace_accounts_no_delete BEFORE DELETE ON marketplace_accounts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER marketplace_orders_no_delete BEFORE DELETE ON marketplace_orders FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER marketplace_notifications_immutable BEFORE UPDATE OR DELETE ON marketplace_notifications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

GRANT SELECT, INSERT, UPDATE ON marketplace_accounts, marketplace_listings, marketplace_orders, marketplace_oauth_states TO loja_app;
GRANT SELECT, INSERT ON marketplace_notifications TO loja_app;
GRANT USAGE ON SEQUENCE marketplace_notifications_id_seq TO loja_app;
