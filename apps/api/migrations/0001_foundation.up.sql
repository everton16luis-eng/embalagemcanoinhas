-- Fundacao: equipe, permissoes, sessoes, limites e auditoria.
-- Empresa unica (o CNPJ da sede): nao ha multiempresa. A API conecta como loja_app,
-- que nao e dona das tabelas e so recebe os privilegios listados no fim de cada migration.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO loja_app;

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION '% nao permitido em %', TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation'; END $$;

-- Usuario da transacao, definido pela API com set_config('app.user_id', ..., true).
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- Busca sem acento e sem diferenca de maiusculas. IMMUTABLE para poder entrar em indice.
CREATE FUNCTION search_text(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT lower(public.unaccent('public.unaccent'::regdictionary, coalesce(t, ''))) $$;

-- Equipe da loja. Clientes da loja virtual ficam em outra tabela (Fase 4).
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            citext NOT NULL UNIQUE CHECK (length(email) <= 254),
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  role             text NOT NULL CHECK (role IN ('owner', 'manager', 'sales', 'stock', 'fiscal', 'shipping')),
  password_hash    text NOT NULL,
  is_active        boolean NOT NULL DEFAULT true,
  totp_secret_enc  text,
  totp_enabled     boolean NOT NULL DEFAULT false,
  totp_last_step   bigint,
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_permissions (
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  permission  text NOT NULL CHECK (permission ~ '^[a-z_]+\.[a-z_]+$'),
  granted     boolean NOT NULL,
  PRIMARY KEY (user_id, permission)
);

CREATE TABLE sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id),
  token_hash       text NOT NULL UNIQUE,
  idle_ttl         interval NOT NULL,
  idle_expires_at  timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  ip               text,
  user_agent       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Chaves sao hashes: nao guarda e-mail nem IP em claro.
CREATE TABLE auth_throttle (
  key           text PRIMARY KEY,
  failures      integer NOT NULL DEFAULT 0,
  window_start  timestamptz NOT NULL DEFAULT now(),
  locked_until  timestamptz
);

CREATE TABLE rate_limits (
  key       text PRIMARY KEY,
  hits      integer NOT NULL,
  reset_at  timestamptz NOT NULL
);

-- Trilha de auditoria somente inclusao. before/after guardam o estado quando a acao altera um registro.
CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    uuid REFERENCES users (id),
  action      text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  entity      text,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  metadata    jsonb NOT NULL DEFAULT '{}',
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity, entity_id, created_at DESC);
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Unicos caminhos que leem o hash da senha e o segredo do MFA: a API nao tem SELECT nessas colunas.
CREATE FUNCTION auth_find_user(p_email text)
RETURNS TABLE (id uuid, email text, name text, role text, is_active boolean, password_hash text, totp_enabled boolean, totp_secret_enc text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.email::text, u.name, u.role, u.is_active, u.password_hash, u.totp_enabled, u.totp_secret_enc
  FROM users u WHERE u.email = p_email::citext
$$;

CREATE FUNCTION auth_session_get(p_token_hash text)
RETURNS TABLE (session_id uuid, user_id uuid, email text, name text, role text, totp_enabled boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE sessions s SET last_seen_at = now(), idle_expires_at = now() + s.idle_ttl
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now() AND s.idle_expires_at > now()
    AND s.last_seen_at < now() - interval '1 minute';
  RETURN QUERY
  SELECT s.id, u.id, u.email::text, u.name, u.role, u.totp_enabled
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now() AND s.idle_expires_at > now() AND u.is_active;
END $$;

CREATE FUNCTION auth_reset_create(p_email text, p_token_hash text, p_ttl interval)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid; v_email text;
BEGIN
  SELECT u.id, u.email::text INTO v_id, v_email FROM users u WHERE u.email = p_email::citext AND u.is_active;
  IF v_id IS NULL THEN RETURN NULL; END IF;
  UPDATE password_reset_tokens SET used_at = now() WHERE user_id = v_id AND used_at IS NULL;
  INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (v_id, p_token_hash, now() + p_ttl);
  RETURN v_email;
END $$;

CREATE FUNCTION auth_reset_password(p_token_hash text, p_password_hash text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  UPDATE password_reset_tokens r SET used_at = now()
  WHERE r.token_hash = p_token_hash AND r.used_at IS NULL AND r.expires_at > now()
  RETURNING r.user_id INTO v_user;
  IF v_user IS NULL THEN RETURN NULL; END IF;
  UPDATE users SET password_hash = p_password_hash, updated_at = now() WHERE id = v_user;
  UPDATE sessions SET revoked_at = now() WHERE user_id = v_user AND revoked_at IS NULL;
  RETURN v_user;
END $$;

REVOKE ALL ON FUNCTION auth_find_user(text), auth_session_get(text), auth_reset_create(text, text, interval), auth_reset_password(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user(text), auth_session_get(text), auth_reset_create(text, text, interval), auth_reset_password(text, text),
  app_user_id(), search_text(text) TO loja_app;

-- password_hash e totp_secret_enc podem ser gravados, nunca lidos pela API.
GRANT SELECT (id, email, name, role, is_active, totp_enabled, totp_last_step, last_login_at, created_at, updated_at) ON users TO loja_app;
GRANT INSERT, UPDATE ON users TO loja_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_permissions TO loja_app;
GRANT SELECT, INSERT, UPDATE ON sessions TO loja_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_throttle, rate_limits TO loja_app;
GRANT SELECT, INSERT ON audit_logs TO loja_app;
