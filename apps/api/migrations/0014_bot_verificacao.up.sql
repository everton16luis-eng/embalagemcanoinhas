-- Bot: confirmar pedido de outro telefone com o CPF/CNPJ da compra (docs/10, etapa 1).

-- Tentativas erradas, para limitar adivinhacao: por telefone (hash) e por numero de pedido. Sem o documento digitado.
CREATE TABLE bot_verify_failures (
  id            bigserial PRIMARY KEY,
  phone_hash    text NOT NULL,
  order_number  integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bot_verify_failures_phone_idx ON bot_verify_failures (phone_hash, created_at);
CREATE INDEX bot_verify_failures_order_idx ON bot_verify_failures (order_number, created_at);

-- Documento digitado pelo cliente, cifrado, so ate o bot conferir (a mensagem guardada fica com o texto oculto).
CREATE TABLE bot_pending_documents (
  inbound_id    bigint PRIMARY KEY REFERENCES whatsapp_inbound (id),
  document_enc  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON bot_verify_failures TO loja_app;
GRANT USAGE ON SEQUENCE bot_verify_failures_id_seq TO loja_app;
GRANT SELECT, INSERT, DELETE ON bot_pending_documents TO loja_app;
