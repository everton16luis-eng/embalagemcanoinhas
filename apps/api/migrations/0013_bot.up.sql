-- Bot de atendimento no WhatsApp, etapa 1: menu (docs/10-bot-atendimento-proposta.md).

-- Mensagens interativas (botoes e lista). payload = o objeto "interactive" enviado.
ALTER TABLE whatsapp_messages DROP CONSTRAINT whatsapp_messages_kind_check;
ALTER TABLE whatsapp_messages ADD CONSTRAINT whatsapp_messages_kind_check CHECK (kind IN ('template', 'text', 'interactive'));
ALTER TABLE whatsapp_messages ADD COLUMN payload jsonb CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object'),
  ADD COLUMN source text NOT NULL DEFAULT 'system' CHECK (source IN ('system', 'agent', 'bot'));
UPDATE whatsapp_messages SET source = 'agent' WHERE kind = 'text';

-- Resposta a botao ou lista: id da opcao escolhida (o titulo vai em body).
ALTER TABLE whatsapp_inbound ADD COLUMN reply_id text CHECK (length(reply_id) <= 256);

-- Situacao de cada conversa: com o bot, com um atendente ou encerrada.
CREATE TABLE whatsapp_conversations (
  phone        text PRIMARY KEY CHECK (phone ~ '^\d{6,20}$'),
  state        text NOT NULL DEFAULT 'bot' CHECK (state IN ('bot', 'agent', 'closed')),
  step         text CHECK (length(step) <= 40),
  context      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(context) = 'object'),
  assigned_to  uuid REFERENCES users (id),
  agent_since  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Cada mensagem recebida e tratada pelo bot uma vez so.
CREATE TABLE bot_runs (
  inbound_id  bigint PRIMARY KEY REFERENCES whatsapp_inbound (id),
  outcome     text NOT NULL CHECK (length(outcome) <= 40),
  handled_at  timestamptz NOT NULL DEFAULT now()
);

-- Configuracao do bot: uma linha. Comeca desligado.
CREATE TABLE bot_settings (
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- off: ninguem; test: so os numeros de teste; all: todos os clientes.
  audience     text NOT NULL DEFAULT 'off' CHECK (audience IN ('off', 'test', 'all')),
  mode         text NOT NULL DEFAULT 'menu' CHECK (mode IN ('menu')),
  test_phones  text[] NOT NULL DEFAULT '{}' CHECK (cardinality(test_phones) <= 20),
  -- {"0": null, "1": {"open": "08:00", "close": "18:00"}, ...}; 0 = domingo. Vazio = sem aviso de horario.
  hours        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(hours) = 'object'),
  -- Textos alterados no painel; o que faltar usa o padrao do codigo.
  texts        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(texts) = 'object'),
  updated_by   uuid REFERENCES users (id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO bot_settings DEFAULT VALUES;

-- Chat de teste do painel: uma conversa simulada por usuario, sem WhatsApp.
CREATE TABLE bot_test_sessions (
  user_id     uuid PRIMARY KEY REFERENCES users (id),
  phone       text CHECK (phone ~ '^\d{10,15}$'),
  step        text CHECK (length(step) <= 40),
  context     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(context) = 'object'),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON whatsapp_conversations, bot_settings TO loja_app;
GRANT SELECT, INSERT ON bot_runs TO loja_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON bot_test_sessions TO loja_app;
