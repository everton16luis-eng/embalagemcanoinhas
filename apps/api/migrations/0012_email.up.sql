-- E-mail da loja (docs/EMAIL.md): ajustes do envio, textos dos e-mails automaticos, historico de envios e o nome de
-- exibicao das caixas. Servidor, usuario e senha do SMTP ficam so no .env.

-- Linha unica. Nome do remetente (o endereco e sempre o do MAIL_FROM), Reply-To e textos personalizados por modelo.
CREATE TABLE email_settings (
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),
  sender_name  text CHECK (length(sender_name) <= 80),
  reply_to     citext CHECK (length(reply_to) <= 254),
  templates    jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(templates) = 'object'),
  updated_by   uuid REFERENCES users (id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO email_settings DEFAULT VALUES;

-- Cada envio. Nunca guarda o texto, links ou tokens; o destinatario fica reduzido ao dominio (***@gmail.com).
CREATE TABLE email_sends (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind ~ '^[a-z_]{2,40}$'),
  to_domain    text NOT NULL CHECK (length(to_domain) <= 300),
  subject      text NOT NULL CHECK (length(subject) <= 300),
  status       text NOT NULL CHECK (status IN ('sent', 'failed', 'not_configured')),
  error_code   text CHECK (length(error_code) <= 60),
  error_detail text CHECK (length(error_detail) <= 300),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_sends_created_idx ON email_sends (created_at DESC);
CREATE TRIGGER email_sends_immutable BEFORE UPDATE OR DELETE ON email_sends FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Nome de exibicao e observacao das caixas (o servidor de e-mail nao tem esses campos).
CREATE TABLE email_account_notes (
  address     citext PRIMARY KEY CHECK (length(address) <= 254),
  name        text NOT NULL DEFAULT '' CHECK (length(name) <= 80),
  note        text NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  created_by  uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, UPDATE ON email_settings TO loja_app;
GRANT SELECT, INSERT ON email_sends TO loja_app;
GRANT USAGE ON SEQUENCE email_sends_id_seq TO loja_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON email_account_notes TO loja_app;
