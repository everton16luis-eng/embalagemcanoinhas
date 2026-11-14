-- Bot, etapa 2: IA (Gemini) nas respostas (docs/10-bot-atendimento-proposta.md, secao 4.4).

-- menu: so regras; ai: a IA responde o texto livre; menu_ai: menu primeiro e IA quando o menu nao entende.
ALTER TABLE bot_settings DROP CONSTRAINT bot_settings_mode_check;
ALTER TABLE bot_settings ADD CONSTRAINT bot_settings_mode_check CHECK (mode IN ('menu', 'ai', 'menu_ai'));
-- free: chave gratuita, a IA so atende o chat de teste e os numeros de teste. paid: atende todos.
ALTER TABLE bot_settings ADD COLUMN ai_plan text NOT NULL DEFAULT 'free' CHECK (ai_plan IN ('free', 'paid')),
  ADD COLUMN ai_monthly_limit_usd numeric(8,2) NOT NULL DEFAULT 10 CHECK (ai_monthly_limit_usd BETWEEN 0 AND 1000),
  ADD COLUMN ai_daily_per_phone integer NOT NULL DEFAULT 20 CHECK (ai_daily_per_phone BETWEEN 1 AND 200);

-- Historico do chat de teste (no WhatsApp ele vem das mensagens guardadas).
ALTER TABLE bot_test_sessions ADD COLUMN history jsonb NOT NULL DEFAULT '[]';

-- Cada chamada a IA: tokens e custo estimado. Sem o texto da conversa; quem conversa vai so como hash.
CREATE TABLE ai_calls (
  id             bigserial PRIMARY KEY,
  who_hash       text NOT NULL,
  model          text NOT NULL CHECK (length(model) <= 80),
  input_tokens   integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens  integer NOT NULL CHECK (output_tokens >= 0),
  cost_usd       numeric(12,6) NOT NULL CHECK (cost_usd >= 0),
  ok             boolean NOT NULL,
  error          text CHECK (length(error) <= 300),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_calls_created_idx ON ai_calls (created_at);
CREATE INDEX ai_calls_who_idx ON ai_calls (who_hash, created_at);

GRANT SELECT, INSERT ON ai_calls TO loja_app;
GRANT USAGE ON SEQUENCE ai_calls_id_seq TO loja_app;
