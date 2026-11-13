-- Dados da empresa (CNPJ da sede, estabelecimento emissor), configuracao fiscal e marca da loja.
-- Nada vem preenchido: todos os campos comecam vazios e o assistente mostra o que falta.

-- Cada gravacao cria uma versao nova; nenhuma e alterada ou apagada.
-- A NF-e (Fase 5) guarda a versao usada, e o historico das notas ja emitidas nunca muda.
CREATE TABLE company_profiles (
  version                 integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  legal_name              text CHECK (length(legal_name) BETWEEN 2 AND 150),
  trade_name              text CHECK (length(trade_name) BETWEEN 2 AND 150),
  -- CNPJ numerico ou alfanumerico (a partir de julho de 2026), sem pontuacao.
  cnpj                    text CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  state_registration      text CHECK (state_registration ~ '^[0-9]{2,14}$'),
  municipal_registration  text CHECK (length(municipal_registration) BETWEEN 1 AND 20),
  street                  text CHECK (length(street) BETWEEN 2 AND 120),
  number                  text CHECK (length(number) BETWEEN 1 AND 20),
  complement              text CHECK (length(complement) <= 60),
  district                text CHECK (length(district) BETWEEN 2 AND 60),
  city                    text CHECK (length(city) BETWEEN 2 AND 60),
  city_ibge               text CHECK (city_ibge ~ '^[0-9]{7}$'),
  uf                      text CHECK (uf ~ '^[A-Z]{2}$'),
  cep                     text CHECK (cep ~ '^[0-9]{8}$'),
  phone                   text CHECK (phone ~ '^[0-9]{10,13}$'),
  email                   citext CHECK (length(email) <= 254),
  cnae_main               text CHECK (cnae_main ~ '^[0-9]{7}$'),
  cnaes_secondary         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(cnaes_secondary) <= 99),
  tax_regime              text CHECK (tax_regime IN ('mei', 'simples_nacional', 'simples_excesso_sublimite', 'lucro_presumido', 'lucro_real')),
  accountant_name         text CHECK (length(accountant_name) BETWEEN 2 AND 120),
  accountant_crc          text CHECK (length(accountant_crc) BETWEEN 3 AND 30),
  accountant_firm         text CHECK (length(accountant_firm) BETWEEN 2 AND 150),
  accountant_email        citext CHECK (length(accountant_email) <= 254),
  accountant_phone        text CHECK (accountant_phone ~ '^[0-9]{10,13}$'),
  change_note             text CHECK (length(change_note) <= 300),
  created_by              uuid NOT NULL REFERENCES users (id),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER company_profiles_immutable BEFORE UPDATE OR DELETE ON company_profiles FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Configuracao fiscal: uma linha. Comeca em homologacao e sem provedor.
CREATE TABLE fiscal_settings (
  id                     boolean PRIMARY KEY DEFAULT true CHECK (id),
  environment            text NOT NULL DEFAULT 'homologacao' CHECK (environment IN ('homologacao', 'producao')),
  nfe_series             integer CHECK (nfe_series BETWEEN 0 AND 999),
  nfe_next_number        bigint CHECK (nfe_next_number BETWEEN 1 AND 999999999),
  accreditation_status   text NOT NULL DEFAULT 'not_started' CHECK (accreditation_status IN ('not_started', 'in_progress', 'accredited')),
  accreditation_notes    text CHECK (length(accreditation_notes) <= 1000),
  provider               text CHECK (provider ~ '^[a-z0-9_]{2,30}$'),
  -- Liberacao de producao: so depois da homologacao validada (Fase 5). Registra quem liberou.
  production_released_by uuid REFERENCES users (id),
  production_released_at timestamptz,
  updated_by             uuid REFERENCES users (id),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_settings_production CHECK (environment = 'homologacao' OR (production_released_by IS NOT NULL AND production_released_at IS NOT NULL))
);
INSERT INTO fiscal_settings DEFAULT VALUES;

-- Marca e textos da loja: tudo configuravel. Nome e dominio ainda nao foram definidos.
CREATE TABLE store_settings (
  id               boolean PRIMARY KEY DEFAULT true CHECK (id),
  store_name       text CHECK (length(store_name) BETWEEN 2 AND 60),
  tagline          text CHECK (length(tagline) <= 120),
  domain           text CHECK (domain ~ '^[a-z0-9.-]{3,253}$'),
  logo_key         text CHECK (logo_key ~ '^[a-f0-9-]{36}$'),
  colors           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(colors) = 'object'),
  whatsapp_number  text CHECK (whatsapp_number ~ '^[0-9]{12,13}$'),
  support_email    citext CHECK (length(support_email) <= 254),
  -- Textos institucionais: sobre, trocas e devolucoes, privacidade, entrega.
  pages            jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(pages) = 'object'),
  updated_by       uuid REFERENCES users (id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
INSERT INTO store_settings DEFAULT VALUES;

GRANT SELECT, INSERT ON company_profiles TO loja_app;
GRANT SELECT, UPDATE ON fiscal_settings, store_settings TO loja_app;
