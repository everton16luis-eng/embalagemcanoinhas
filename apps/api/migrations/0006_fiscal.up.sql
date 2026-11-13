-- NF-e modelo 55 por provedor fiscal (ver docs/05-fiscal-nfe.md).
-- Nota autorizada nunca e apagada; cancelamento e carta de correcao sao eventos.

-- Politica de emissao: manual (botao no pedido) ou automatica ao confirmar o pagamento. Decisao do contador.
ALTER TABLE fiscal_settings ADD COLUMN emission_policy text NOT NULL DEFAULT 'manual' CHECK (emission_policy IN ('manual', 'on_paid'));
ALTER TABLE fiscal_settings ADD COLUMN production_validator_name text CHECK (length(production_validator_name) BETWEEN 2 AND 120);

-- Situacao da nota no pedido. A expedicao continua exigindo 'authorized' (ou 'not_required').
ALTER TABLE orders DROP CONSTRAINT orders_invoice_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_invoice_status_check
  CHECK (invoice_status IN ('pending', 'processing', 'authorized', 'rejected', 'canceled', 'not_required'));

-- Regra fiscal por operacao. Os codigos vem do contador; o sistema so confere o formato.
CREATE TABLE fiscal_rules (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  -- Destino dentro ou fora da UF do emitente; comprador pessoa fisica, empresa contribuinte de ICMS ou nao.
  destination                 text NOT NULL CHECK (destination IN ('internal', 'interstate')),
  buyer_kind                  text NOT NULL CHECK (buyer_kind IN ('pf', 'pj_contribuinte', 'pj_nao_contribuinte')),
  natureza_operacao           text NOT NULL CHECK (length(natureza_operacao) BETWEEN 2 AND 60),
  cfop                        text NOT NULL CHECK (cfop ~ '^[5-7][0-9]{3}$'),
  -- CST (2 digitos) ou CSOSN do Simples Nacional (3 digitos).
  icms_situacao_tributaria    text NOT NULL CHECK (icms_situacao_tributaria ~ '^[0-9]{2,3}$'),
  pis_situacao_tributaria     text NOT NULL CHECK (pis_situacao_tributaria ~ '^[0-9]{2}$'),
  cofins_situacao_tributaria  text NOT NULL CHECK (cofins_situacao_tributaria ~ '^[0-9]{2}$'),
  consumidor_final            boolean NOT NULL,
  -- Tabela da NF-e: 2 = operacao nao presencial pela internet.
  presenca_comprador          smallint NOT NULL CHECK (presenca_comprador BETWEEN 0 AND 9),
  -- Campos adicionais do provedor (ex.: IBS/CBS), exatamente como definidos com o contador.
  extra_fields                jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(extra_fields) = 'object'),
  item_extra_fields           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(item_extra_fields) = 'object'),
  notes                       text CHECK (length(notes) <= 2000),
  active                      boolean NOT NULL DEFAULT true,
  status                      text NOT NULL DEFAULT 'informed' CHECK (status IN ('informed', 'validated')),
  informed_by                 uuid REFERENCES users (id),
  informed_at                 timestamptz NOT NULL DEFAULT now(),
  validated_by                uuid REFERENCES users (id),
  validator_name              text CHECK (length(validator_name) <= 120),
  validated_at                timestamptz,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_rules_validated CHECK (status <> 'validated' OR (validated_by IS NOT NULL AND validated_at IS NOT NULL AND validator_name IS NOT NULL))
);
CREATE UNIQUE INDEX fiscal_rules_active_unique ON fiscal_rules (destination, buyer_kind) WHERE active;

-- Alterou qualquer codigo de uma regra validada: a validacao cai.
CREATE FUNCTION fiscal_rules_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.destination, NEW.buyer_kind, NEW.natureza_operacao, NEW.cfop, NEW.icms_situacao_tributaria, NEW.pis_situacao_tributaria,
      NEW.cofins_situacao_tributaria, NEW.consumidor_final, NEW.presenca_comprador, NEW.extra_fields, NEW.item_extra_fields)
     IS DISTINCT FROM
     (OLD.destination, OLD.buyer_kind, OLD.natureza_operacao, OLD.cfop, OLD.icms_situacao_tributaria, OLD.pis_situacao_tributaria,
      OLD.cofins_situacao_tributaria, OLD.consumidor_final, OLD.presenca_comprador, OLD.extra_fields, OLD.item_extra_fields)
     AND NEW.validated_at IS NOT DISTINCT FROM OLD.validated_at THEN
    NEW.status := 'informed';
    NEW.validated_by := NULL; NEW.validator_name := NULL; NEW.validated_at := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_rules_guard BEFORE UPDATE ON fiscal_rules FOR EACH ROW EXECUTE FUNCTION fiscal_rules_guard();
CREATE TRIGGER fiscal_rules_no_delete BEFORE DELETE ON fiscal_rules FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE fiscal_rules_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id     uuid NOT NULL REFERENCES fiscal_rules (id),
  snapshot    jsonb NOT NULL,
  changed_by  uuid REFERENCES users (id),
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fiscal_rules_history_immutable BEFORE UPDATE OR DELETE ON fiscal_rules_history FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION fiscal_rules_log() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO fiscal_rules_history (rule_id, snapshot, changed_by) VALUES (NEW.id, to_jsonb(NEW) - 'id', app_user_id());
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_rules_log AFTER INSERT OR UPDATE ON fiscal_rules FOR EACH ROW EXECUTE FUNCTION fiscal_rules_log();

-- Cada tentativa de emissao e uma linha. So uma ativa por pedido e finalidade.
CREATE TABLE fiscal_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES orders (id),
  purpose          text NOT NULL DEFAULT 'sale' CHECK (purpose IN ('sale')),
  provider         text NOT NULL CHECK (provider IN ('focusnfe', 'fake')),
  environment      text NOT NULL CHECK (environment IN ('homologacao', 'producao')),
  -- Referencia enviada ao provedor (idempotencia): reenviar a mesma ref nunca gera outra nota.
  ref              text NOT NULL UNIQUE CHECK (ref ~ '^[A-Za-z0-9_-]{4,50}$'),
  attempt          integer NOT NULL CHECK (attempt BETWEEN 1 AND 99),
  -- pending: criada, provedor ainda nao confirmou o recebimento.
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'authorized', 'rejected', 'canceled')),
  company_version  integer NOT NULL REFERENCES company_profiles (version),
  rule_id          uuid NOT NULL REFERENCES fiscal_rules (id),
  payload          jsonb NOT NULL,
  series           text CHECK (series ~ '^[0-9]{1,3}$'),
  number           text CHECK (number ~ '^[0-9]{1,9}$'),
  access_key       text UNIQUE CHECK (access_key ~ '^[0-9]{44}$'),
  sefaz_status     text CHECK (length(sefaz_status) <= 10),
  sefaz_message    text CHECK (length(sefaz_message) <= 2000),
  errors           jsonb,
  -- Caminhos de download informados pelo provedor (XML, DANFE, cancelamento).
  provider_files   jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(provider_files) = 'object'),
  authorized_at    timestamptz,
  canceled_at      timestamptz,
  cancel_reason    text CHECK (length(cancel_reason) BETWEEN 15 AND 255),
  check_count      integer NOT NULL DEFAULT 0,
  last_checked_at  timestamptz,
  created_by       uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_documents_authorized CHECK (status NOT IN ('authorized', 'canceled') OR (access_key IS NOT NULL AND number IS NOT NULL AND authorized_at IS NOT NULL)),
  CONSTRAINT fiscal_documents_canceled CHECK (status <> 'canceled' OR (canceled_at IS NOT NULL AND cancel_reason IS NOT NULL))
);
CREATE UNIQUE INDEX fiscal_documents_active ON fiscal_documents (order_id, purpose) WHERE status IN ('pending', 'processing', 'authorized');
CREATE INDEX fiscal_documents_order_idx ON fiscal_documents (order_id, created_at DESC);
CREATE INDEX fiscal_documents_open_idx ON fiscal_documents (last_checked_at NULLS FIRST) WHERE status IN ('pending', 'processing');
CREATE INDEX fiscal_documents_list_idx ON fiscal_documents (created_at DESC);

-- O que foi enviado nao muda; transicoes so para frente; autorizada so vira cancelada; nada e apagado.
CREATE FUNCTION fiscal_documents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'documento fiscal nao pode ser apagado' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.order_id, NEW.purpose, NEW.provider, NEW.environment, NEW.ref, NEW.attempt, NEW.company_version, NEW.rule_id, NEW.payload, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.order_id, OLD.purpose, OLD.provider, OLD.environment, OLD.ref, OLD.attempt, OLD.company_version, OLD.rule_id, OLD.payload, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'dados enviados do documento fiscal sao imutaveis' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('rejected', 'canceled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'documento fiscal % nao muda de situacao', OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'authorized' THEN
    IF NEW.status NOT IN ('authorized', 'canceled') THEN
      RAISE EXCEPTION 'nota autorizada so pode ser cancelada' USING ERRCODE = 'P0001';
    END IF;
    IF (NEW.access_key, NEW.number, NEW.series, NEW.authorized_at) IS DISTINCT FROM (OLD.access_key, OLD.number, OLD.series, OLD.authorized_at) THEN
      RAISE EXCEPTION 'dados da nota autorizada sao imutaveis' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_documents_guard BEFORE UPDATE OR DELETE ON fiscal_documents FOR EACH ROW EXECUTE FUNCTION fiscal_documents_guard();
CREATE TRIGGER fiscal_documents_no_truncate BEFORE TRUNCATE ON fiscal_documents FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TABLE fiscal_document_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id   uuid NOT NULL REFERENCES fiscal_documents (id),
  kind          text NOT NULL CHECK (kind IN ('created', 'submitted', 'status', 'submit_failed', 'cancel', 'cancel_failed', 'correction', 'correction_failed', 'webhook', 'file')),
  status        text,
  sefaz_status  text,
  message       text CHECK (length(message) <= 2000),
  data          jsonb NOT NULL DEFAULT '{}',
  actor_id      uuid REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fiscal_document_events_doc_idx ON fiscal_document_events (document_id, id);
CREATE TRIGGER fiscal_document_events_immutable BEFORE UPDATE OR DELETE ON fiscal_document_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Inutilizacao de faixa de numeracao (salto na sequencia). Registro imutavel do resultado.
CREATE TABLE fiscal_inutilizations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL,
  environment    text NOT NULL CHECK (environment IN ('homologacao', 'producao')),
  series         text NOT NULL CHECK (series ~ '^[0-9]{1,3}$'),
  number_start   integer NOT NULL CHECK (number_start BETWEEN 1 AND 999999999),
  number_end     integer NOT NULL CHECK (number_end BETWEEN 1 AND 999999999),
  justification  text NOT NULL CHECK (length(justification) BETWEEN 15 AND 255),
  status         text NOT NULL CHECK (status IN ('authorized', 'rejected')),
  protocol       text CHECK (length(protocol) <= 30),
  sefaz_status   text,
  sefaz_message  text CHECK (length(sefaz_message) <= 2000),
  created_by     uuid NOT NULL REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_inutilizations_range CHECK (number_end >= number_start AND number_end - number_start < 10000)
);
CREATE TRIGGER fiscal_inutilizations_immutable BEFORE UPDATE OR DELETE ON fiscal_inutilizations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Arquivos fiscais (guarda obrigatoria): conteudo no armazenamento, hash aqui. Imutavel.
CREATE TABLE fiscal_files (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       uuid REFERENCES fiscal_documents (id),
  inutilization_id  uuid REFERENCES fiscal_inutilizations (id),
  kind              text NOT NULL CHECK (kind IN ('nfe_xml', 'danfe_pdf', 'cancel_xml', 'cce_xml', 'cce_pdf', 'inut_xml')),
  sequence          integer NOT NULL DEFAULT 1,
  storage_key       text NOT NULL UNIQUE CHECK (storage_key ~ '^[0-9]{4}/[a-f0-9-]{36}\.(xml|pdf)$'),
  sha256            text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  bytes             integer NOT NULL CHECK (bytes > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_files_owner CHECK ((document_id IS NULL) <> (inutilization_id IS NULL))
);
CREATE UNIQUE INDEX fiscal_files_doc_kind ON fiscal_files (document_id, kind, sequence) WHERE document_id IS NOT NULL;
CREATE TRIGGER fiscal_files_immutable BEFORE UPDATE OR DELETE ON fiscal_files FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER fiscal_files_no_truncate BEFORE TRUNCATE ON fiscal_files FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Certificado A1: fica no provedor (que assina o XML). Aqui so metadados para o aviso de vencimento.
CREATE TABLE fiscal_certificates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holder_name   text NOT NULL CHECK (length(holder_name) BETWEEN 2 AND 150),
  cnpj          text NOT NULL CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  valid_from    date NOT NULL,
  valid_until   date NOT NULL,
  fingerprint   text CHECK (fingerprint ~ '^[A-Fa-f0-9:]{40,95}$'),
  notes         text CHECK (length(notes) <= 500),
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid NOT NULL REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_certificates_dates CHECK (valid_until > valid_from)
);
CREATE UNIQUE INDEX fiscal_certificates_active ON fiscal_certificates ((true)) WHERE active;

-- Avisos do provedor. So disparam uma consulta; a situacao vem sempre da API.
CREATE TABLE fiscal_webhook_notifications (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider     text NOT NULL,
  ref          text,
  auth_valid   boolean NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fiscal_webhook_notifications_ref_idx ON fiscal_webhook_notifications (ref);

GRANT SELECT, INSERT, UPDATE ON fiscal_rules, fiscal_documents TO loja_app;
GRANT SELECT, INSERT ON fiscal_rules_history, fiscal_document_events, fiscal_inutilizations, fiscal_files, fiscal_webhook_notifications TO loja_app;
GRANT SELECT, INSERT, UPDATE ON fiscal_certificates TO loja_app;
