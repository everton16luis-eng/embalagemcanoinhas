-- Fase 8: WhatsApp Cloud API e transportadoras por API (docs/08-whatsapp-transportadoras-relatorios.md).

-- Opt-in do cliente para avisos do pedido pelo WhatsApp (texto exato aceito e quando).
ALTER TABLE orders ADD COLUMN whatsapp_optin_at timestamptz, ADD COLUMN whatsapp_optin_text text CHECK (length(whatsapp_optin_text) <= 300);

-- Modelo aprovado no WhatsApp Manager para cada evento do pedido.
CREATE TABLE whatsapp_templates (
  event       text PRIMARY KEY CHECK (event IN ('order_paid', 'order_ready', 'order_shipped')),
  name        text NOT NULL CHECK (name ~ '^[a-z0-9_]+$' AND length(name) <= 512),
  language    text NOT NULL DEFAULT 'pt_BR' CHECK (language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  active      boolean NOT NULL DEFAULT true,
  updated_by  uuid NOT NULL REFERENCES users (id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Fila de envio. Uma mensagem por (pedido, evento): repetir o evento nao duplica.
CREATE TABLE whatsapp_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid REFERENCES orders (id),
  event           text CHECK (event IN ('order_paid', 'order_ready', 'order_shipped')),
  kind            text NOT NULL CHECK (kind IN ('template', 'text')),
  to_phone        text NOT NULL CHECK (to_phone ~ '^\d{10,15}$'),
  template_name   text,
  language        text,
  params          jsonb,
  body            text CHECK (length(body) <= 4096),
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'canceled')),
  wamid           text UNIQUE,
  error           text CHECK (length(error) <= 500),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_messages_kind CHECK ((kind = 'template') = (template_name IS NOT NULL)),
  UNIQUE (order_id, event)
);
CREATE INDEX whatsapp_messages_due_idx ON whatsapp_messages (next_attempt_at) WHERE status = 'queued';
CREATE INDEX whatsapp_messages_phone_idx ON whatsapp_messages (to_phone, created_at DESC);

-- Mensagens recebidas (deduplicadas pelo id do WhatsApp). Somente inclusao.
CREATE TABLE whatsapp_inbound (
  id           bigserial PRIMARY KEY,
  wamid        text NOT NULL UNIQUE CHECK (length(wamid) <= 200),
  from_phone   text NOT NULL CHECK (from_phone ~ '^\d{6,20}$'),
  profile_name text CHECK (length(profile_name) <= 200),
  type         text NOT NULL CHECK (length(type) <= 40),
  body         text CHECK (length(body) <= 4096),
  sent_at      timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_inbound_phone_idx ON whatsapp_inbound (from_phone, sent_at DESC);

-- Quem pediu para parar (hash com chave do numero; nao guarda o numero em claro).
CREATE TABLE whatsapp_optouts (
  phone_hash text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER whatsapp_inbound_immutable BEFORE UPDATE OR DELETE ON whatsapp_inbound FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER whatsapp_messages_no_delete BEFORE DELETE ON whatsapp_messages FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Transportadora: forma de entrega cotada no provedor (servico do provedor + dias de separacao).
ALTER TABLE shipping_options DROP CONSTRAINT shipping_options_kind_check;
ALTER TABLE shipping_options ADD CONSTRAINT shipping_options_kind_check CHECK (kind IN ('pickup', 'delivery', 'carrier'));
ALTER TABLE shipping_options ADD COLUMN carrier_service text CHECK (carrier_service ~ '^[0-9]{1,10}$'),
  ADD COLUMN handling_days integer NOT NULL DEFAULT 0 CHECK (handling_days BETWEEN 0 AND 30),
  ADD CONSTRAINT shipping_options_carrier CHECK ((kind = 'carrier') = (carrier_service IS NOT NULL));

-- Cotacao guardada por 30 min: o checkout cobra o preco que o cliente viu sem chamar o provedor de novo.
CREATE TABLE shipping_quote_cache (
  key        text PRIMARY KEY,
  quotes     jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);

GRANT SELECT, INSERT, UPDATE ON whatsapp_templates, whatsapp_messages TO loja_app;
GRANT SELECT, INSERT ON whatsapp_inbound, whatsapp_optouts TO loja_app;
GRANT USAGE ON SEQUENCE whatsapp_inbound_id_seq TO loja_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON shipping_quote_cache TO loja_app;
