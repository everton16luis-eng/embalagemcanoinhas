-- Seguranca da IA do bot (docs/13-seguranca-ia-bot.md).

-- Eventos de seguranca: tentativas de manipulacao, ferramentas negadas, respostas barradas, limites.
-- LGPD (minimizacao): nao guarda o texto da mensagem nem o telefone; quem conversa vai como hash (o mesmo de ai_calls).
CREATE TABLE bot_security_events (
  id          bigserial PRIMARY KEY,
  who_hash    text NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('whatsapp', 'teste')),
  -- Mensagem recebida que disparou o evento (so no WhatsApp).
  inbound_id  bigint,
  categories  text[] NOT NULL DEFAULT '{}',
  protection  text NOT NULL CHECK (protection IN ('input_guard', 'tool_guard', 'output_guard', 'model_filter', 'rate_limit', 'cooldown', 'indirect_guard')),
  tool        text CHECK (length(tool) <= 60),
  outcome     text NOT NULL CHECK (outcome IN ('blocked', 'flagged', 'redacted', 'denied', 'limited')),
  score       smallint NOT NULL DEFAULT 0,
  rules       text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bot_security_events_who_idx ON bot_security_events (who_hash, created_at);
CREATE INDEX bot_security_events_created_idx ON bot_security_events (created_at);
CREATE INDEX bot_security_events_inbound_idx ON bot_security_events (inbound_id) WHERE inbound_id IS NOT NULL;

GRANT SELECT, INSERT, DELETE ON bot_security_events TO loja_app;
GRANT USAGE ON SEQUENCE bot_security_events_id_seq TO loja_app;

-- Motivo de termino da resposta do Gemini (finishReason / promptFeedback.blockReason).
ALTER TABLE ai_calls ADD COLUMN finish_reason text CHECK (length(finish_reason) <= 40);
