-- SGLog Fase 10a: custos, margem de contribuicao e rastreabilidade (docs/40-sglog-fase10-planejamento.md e
-- docs/41-sglog-fase10.md).
-- - Configuracoes de custo versionadas (cost_settings): aliquota estimada de tributos, taxa do meio de pagamento,
--   comissao e tarifa de referencia do marketplace e custo de embalagem (por tipo ou por volume). Fluxo "informado ->
--   validado" de fiscal_rules: so a versao validada entra no calculo, pela vigencia na data do fato. A linha e
--   imutavel: corrigir e registrar outra versao; encerrar e informar o fim da vigencia. Duas versoes validadas da
--   mesma chave nunca se sobrepoem (gatilho e C23).
-- - Lancamentos de custos externos do pedido (order_cost_entries): taxa do pagamento, comissao, tarifa e frete do
--   marketplace, tributo registrado e outros. Manual ou importado por planilha (cost_imports). Imutaveis; correcao por
--   estorno (linha nova com o valor oposto). A mesma referencia externa nao entra duas vezes, e os tipos unicos (taxa,
--   comissao, tarifa, frete do marketplace, tributo) tem no maximo um lancamento ativo por pedido: importar e depois
--   lancar a mao a mesma taxa e recusado (gatilho e C22).
-- - Conferencia dos custos (cost_reconcile): C22 lancamentos e C23 configuracoes. C24 (margem x componentes) roda na
--   aplicacao, que e quem calcula a margem. C1-C21 (stock_reconcile) nao mudam.
-- - Indices de leitura para os relatorios por periodo.
--
-- ADITIVA e compativel com o codigo anterior (d0f7a9b), inclusive na escrita: so tabelas, funcoes e indices novos.
-- Nenhuma linha, restricao, coluna ou gatilho existente muda. Checkout, pagamentos, NF-e, pedidos, estoque, expedicao,
-- frete e marketplaces nao mudam: a fase so le essas tabelas.

-- Bloqueios, tecnica da 0020-0028: espera so o primeiro, pede os demais com NOWAIT; ocupado, solta e tenta de novo.
--   orders, shipments, stock_movements  SHARE (indices novos; leitura continua, escrita espera o fim)
--   users                               SHARE ROW EXCLUSIVE (FKs novas)
SET LOCAL lock_timeout = '10s';
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '10 seconds'; tries integer := 0; waited numeric;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE orders IN SHARE MODE;
      LOCK TABLE shipments, stock_movements IN SHARE MODE NOWAIT;
      LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF clock_timestamp() > deadline THEN
        RAISE EXCEPTION '0029: pedidos ou estoque ocupados por mais de 10 s (% tentativas); nada foi alterado, tente de novo', tries
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.02);
    END;
  END LOOP;
  waited := round(extract(epoch FROM clock_timestamp() - (deadline - interval '10 seconds')) * 1000);
  RAISE NOTICE '0029: bloqueios obtidos em % ms (% nova(s) tentativa(s))', waited, tries;
END $$;
SELECT set_config('sglog.t0', clock_timestamp()::text, true);

-- ---------------------------------------------------------------------------------------------------------------
-- Configuracoes de custo.
--   kind            tax_rate (tributo estimado, % da base), payment_fee (meio de pagamento da loja), marketplace_fee
--                   (comissao e tarifa de referencia), packaging (custo por volume: generico ou por tipo de caixa)
--   chave           kind + channel + payment_method + installments + packaging_code (NULL = qualquer um); a mais
--                   especifica vence
--   vigencia        [valid_from, valid_to): a versao que vale e a da data do fato (pagamento, despacho)
--   status          informed -> validated | canceled; validated -> validated com valid_to (encerrada)
-- Tributo: so quem tem fiscal.validate (o contador) valida (a aplicacao confere). Nada aqui e valor fiscal.
CREATE TABLE cost_settings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  kind            text NOT NULL CHECK (kind IN ('tax_rate', 'payment_fee', 'marketplace_fee', 'packaging')),
  channel         text CHECK (channel IN ('store', 'sales_desk', 'mercadolivre', 'shopee')),
  payment_method  text CHECK (payment_method IN ('pix', 'card')),
  installments    integer CHECK (installments BETWEEN 1 AND 24),
  -- Embalagem por tipo: codigo e medidas internas da caixa (a remessa com as mesmas medidas, em qualquer ordem, e
  -- desse tipo). Sem codigo e sem medidas: custo generico por volume.
  packaging_code  text CHECK (packaging_code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'),
  packaging_name  text CHECK (length(packaging_name) BETWEEN 2 AND 80),
  length_mm       integer CHECK (length_mm BETWEEN 1 AND 3000),
  width_mm        integer CHECK (width_mm BETWEEN 1 AND 3000),
  height_mm       integer CHECK (height_mm BETWEEN 1 AND 3000),
  rate_pct        numeric(7,4) CHECK (rate_pct >= 0 AND rate_pct <= 100),
  fixed_cents     integer CHECK (fixed_cents BETWEEN 0 AND 10000000),
  -- Base do percentual: total do pedido (mercadoria - desconto + frete) ou so a mercadoria (sem o frete).
  base            text NOT NULL DEFAULT 'order_total' CHECK (base IN ('order_total', 'merchandise')),
  valid_from      date NOT NULL,
  valid_to        date,
  status          text NOT NULL DEFAULT 'informed' CHECK (status IN ('informed', 'validated', 'canceled')),
  -- De onde veio o valor (tabela do provedor, contrato, orientacao do contador).
  source          text NOT NULL CHECK (length(source) BETWEEN 3 AND 200),
  note            text CHECK (length(note) <= 500),
  informed_by     uuid REFERENCES users (id),
  informed_at     timestamptz NOT NULL DEFAULT now(),
  validated_by    uuid REFERENCES users (id),
  validator_name  text CHECK (length(validator_name) BETWEEN 2 AND 120),
  validated_at    timestamptz,
  canceled_by     uuid REFERENCES users (id),
  canceled_at     timestamptz,
  cancel_reason   text CHECK (length(cancel_reason) BETWEEN 3 AND 300),
  ended_by        uuid REFERENCES users (id),
  ended_at        timestamptz,
  end_reason      text CHECK (length(end_reason) BETWEEN 3 AND 300),
  version         integer NOT NULL DEFAULT 1,
  request_key     text NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cost_settings_period CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT cost_settings_value CHECK (rate_pct IS NOT NULL OR fixed_cents IS NOT NULL),
  CONSTRAINT cost_settings_validated CHECK (status <> 'validated' OR (validated_by IS NOT NULL AND validator_name IS NOT NULL AND validated_at IS NOT NULL)),
  CONSTRAINT cost_settings_canceled CHECK ((status = 'canceled') = (canceled_at IS NOT NULL AND cancel_reason IS NOT NULL)),
  CONSTRAINT cost_settings_ended CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CONSTRAINT cost_settings_dims CHECK ((length_mm IS NULL) = (width_mm IS NULL) AND (width_mm IS NULL) = (height_mm IS NULL)),
  CONSTRAINT cost_settings_shape CHECK (CASE kind
    WHEN 'tax_rate' THEN rate_pct IS NOT NULL AND fixed_cents IS NULL AND payment_method IS NULL AND installments IS NULL
                         AND packaging_code IS NULL AND length_mm IS NULL
    WHEN 'payment_fee' THEN (channel IS NULL OR channel IN ('store', 'sales_desk')) AND packaging_code IS NULL AND length_mm IS NULL
                         AND (installments IS NULL OR payment_method = 'card') AND base = 'order_total'
    WHEN 'marketplace_fee' THEN channel IN ('mercadolivre', 'shopee') AND payment_method IS NULL AND installments IS NULL
                         AND packaging_code IS NULL AND length_mm IS NULL AND base = 'order_total'
    WHEN 'packaging' THEN fixed_cents IS NOT NULL AND rate_pct IS NULL AND channel IS NULL AND payment_method IS NULL AND installments IS NULL
                         AND (packaging_code IS NULL) = (length_mm IS NULL) AND (packaging_code IS NULL OR packaging_name IS NOT NULL)
                         AND base = 'order_total'
  END)
);
CREATE INDEX cost_settings_lookup_idx ON cost_settings (kind, valid_from) WHERE status = 'validated';

-- Imutavel: so as transicoes de status e o fim da vigencia. Apagar, nunca.
CREATE FUNCTION cost_settings_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  moving text[] := ARRAY['status', 'validated_by', 'validator_name', 'validated_at', 'canceled_by', 'canceled_at', 'cancel_reason',
                         'valid_to', 'ended_by', 'ended_at', 'end_reason', 'version', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'configuracao de custo nao pode ser apagada' USING ERRCODE = 'check_violation', CONSTRAINT = 'cost_settings_immutable';
  END IF;
  IF (to_jsonb(OLD) - moving) <> (to_jsonb(NEW) - moving) THEN
    RAISE EXCEPTION 'configuracao de custo e imutavel: registre uma nova versao' USING ERRCODE = 'check_violation', CONSTRAINT = 'cost_settings_immutable';
  END IF;
  -- Validar ou cancelar a informada (a vigencia nao muda).
  IF OLD.status = 'informed' AND NEW.status IN ('validated', 'canceled') AND NEW.valid_to IS NOT DISTINCT FROM OLD.valid_to
     AND NEW.ended_at IS NULL THEN
    RETURN NEW;
  END IF;
  -- Encerrar a validada: so informa o fim (uma vez); a validacao nao muda.
  IF OLD.status = 'validated' AND NEW.status = 'validated' AND OLD.valid_to IS NULL AND NEW.valid_to IS NOT NULL AND NEW.ended_at IS NOT NULL
     AND NEW.validated_by = OLD.validated_by AND NEW.validator_name = OLD.validator_name AND NEW.validated_at = OLD.validated_at
     AND NEW.canceled_at IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'transicao nao permitida (% -> %)', OLD.status, NEW.status USING ERRCODE = 'check_violation', CONSTRAINT = 'cost_settings_transition';
END $$;
CREATE TRIGGER cost_settings_guard BEFORE UPDATE OR DELETE ON cost_settings FOR EACH ROW EXECUTE FUNCTION cost_settings_guard();

-- Duas versoes validadas da mesma chave nao se sobrepoem; dois tipos de caixa validados com as mesmas medidas, tambem
-- nao (a remessa seria de dois tipos). Serializado por tipo de configuracao.
CREATE FUNCTION cost_settings_overlap_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status <> 'validated' THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cost_settings:' || NEW.kind));
  IF EXISTS (
    SELECT 1 FROM cost_settings x
    WHERE x.id <> NEW.id AND x.status = 'validated' AND x.kind = NEW.kind
      AND x.channel IS NOT DISTINCT FROM NEW.channel AND x.payment_method IS NOT DISTINCT FROM NEW.payment_method
      AND x.installments IS NOT DISTINCT FROM NEW.installments AND x.packaging_code IS NOT DISTINCT FROM NEW.packaging_code
      AND daterange(x.valid_from, x.valid_to) && daterange(NEW.valid_from, NEW.valid_to)
  ) THEN
    RAISE EXCEPTION 'ja existe versao validada desta configuracao no periodo' USING ERRCODE = 'check_violation', CONSTRAINT = 'cost_settings_overlap';
  END IF;
  IF NEW.length_mm IS NOT NULL AND EXISTS (
    SELECT 1 FROM cost_settings x
    WHERE x.id <> NEW.id AND x.status = 'validated' AND x.kind = 'packaging' AND x.length_mm IS NOT NULL
      AND x.packaging_code <> NEW.packaging_code
      AND (SELECT array_agg(d ORDER BY d) FROM unnest(ARRAY[x.length_mm, x.width_mm, x.height_mm]) d)
        = (SELECT array_agg(d ORDER BY d) FROM unnest(ARRAY[NEW.length_mm, NEW.width_mm, NEW.height_mm]) d)
      AND daterange(x.valid_from, x.valid_to) && daterange(NEW.valid_from, NEW.valid_to)
  ) THEN
    RAISE EXCEPTION 'outro tipo de embalagem validado tem as mesmas medidas no periodo' USING ERRCODE = 'check_violation', CONSTRAINT = 'cost_settings_packaging_dims';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cost_settings_overlap_check AFTER INSERT OR UPDATE ON cost_settings FOR EACH ROW EXECUTE FUNCTION cost_settings_overlap_check();

CREATE TABLE cost_setting_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  setting_id  uuid NOT NULL REFERENCES cost_settings (id),
  action      text NOT NULL CHECK (action IN ('inform', 'validate', 'cancel', 'end')),
  note        text CHECK (length(note) <= 500),
  actor_id    uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cost_setting_events_setting_idx ON cost_setting_events (setting_id, id);
CREATE TRIGGER cost_setting_events_immutable BEFORE UPDATE OR DELETE ON cost_setting_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- Importacao de planilha de custos (CSV). O mesmo arquivo (hash do conteudo) nao entra duas vezes. Imutavel.
CREATE TABLE cost_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  filename      text CHECK (length(filename) <= 200),
  content_hash  text NOT NULL UNIQUE CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  rows          integer NOT NULL CHECK (rows > 0),
  total_cents   bigint NOT NULL,
  actor_id      uuid REFERENCES users (id),
  request_key   text NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER cost_imports_immutable BEFORE UPDATE OR DELETE ON cost_imports FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- Lancamentos de custos externos do pedido. Valor em centavos: o original >= 0 (zero = custo conhecido e nulo, ex.:
-- frete do marketplace sem cobranca ao vendedor); o estorno e o valor oposto do original, com motivo.
CREATE TABLE order_cost_entries (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id      uuid NOT NULL REFERENCES orders (id),
  kind          text NOT NULL CHECK (kind IN ('payment_fee', 'marketplace_commission', 'marketplace_fee', 'marketplace_shipping', 'tax', 'other')),
  amount_cents  bigint NOT NULL CHECK (abs(amount_cents) <= 1000000000),
  -- Data do fato (cobranca da taxa, repasse do marketplace, apuracao).
  occurred_on   date NOT NULL,
  source        text NOT NULL CHECK (source IN ('manual', 'import')),
  import_id     uuid REFERENCES cost_imports (id),
  external_ref  text CHECK (length(external_ref) BETWEEN 1 AND 120),
  note          text CHECK (length(note) BETWEEN 3 AND 300),
  reverses_id   bigint UNIQUE REFERENCES order_cost_entries (id),
  reason        text CHECK (length(reason) BETWEEN 3 AND 300),
  actor_id      uuid REFERENCES users (id),
  request_key   text NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_cost_entries_sign CHECK ((reverses_id IS NULL AND amount_cents >= 0) OR (reverses_id IS NOT NULL AND amount_cents <= 0 AND reason IS NOT NULL)),
  CONSTRAINT order_cost_entries_import CHECK ((source = 'import') = (import_id IS NOT NULL)),
  CONSTRAINT order_cost_entries_other CHECK (kind <> 'other' OR reverses_id IS NOT NULL OR note IS NOT NULL)
);
CREATE INDEX order_cost_entries_order_idx ON order_cost_entries (order_id, kind);
CREATE INDEX order_cost_entries_ref_idx ON order_cost_entries (kind, external_ref) WHERE external_ref IS NOT NULL;
CREATE TRIGGER order_cost_entries_immutable BEFORE UPDATE OR DELETE ON order_cost_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Coerencia do lancamento, serializada por pedido e por referencia externa (concorrentes esperam e contam o anterior).
--   estorno: do mesmo pedido e tipo, valor oposto, de um original (estorno de estorno, nao)
--   original: tipos de marketplace so em pedido de marketplace; taxa do pagamento so em pedido da loja; tipos unicos
--             com no maximo um ativo (nao estornado) por pedido; referencia externa ativa unica por tipo
CREATE FUNCTION order_cost_entries_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o order_cost_entries; ch text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('order_cost:' || NEW.order_id::text));
  IF NEW.reverses_id IS NOT NULL THEN
    SELECT * INTO o FROM order_cost_entries WHERE id = NEW.reverses_id;
    IF o.reverses_id IS NOT NULL OR o.order_id <> NEW.order_id OR o.kind <> NEW.kind OR NEW.amount_cents <> -o.amount_cents THEN
      RAISE EXCEPTION 'estorno diferente do lancamento original' USING ERRCODE = 'check_violation', CONSTRAINT = 'order_cost_entries_reversal';
    END IF;
    RETURN NULL;
  END IF;
  SELECT channel INTO ch FROM orders WHERE id = NEW.order_id;
  IF NEW.kind IN ('marketplace_commission', 'marketplace_fee', 'marketplace_shipping') AND ch NOT IN ('mercadolivre', 'shopee') THEN
    RAISE EXCEPTION 'custo de marketplace em pedido que nao e de marketplace' USING ERRCODE = 'check_violation', CONSTRAINT = 'order_cost_entries_channel';
  END IF;
  IF NEW.kind = 'payment_fee' AND ch IN ('mercadolivre', 'shopee') THEN
    RAISE EXCEPTION 'pedido de marketplace: a taxa entra como comissao ou tarifa do marketplace' USING ERRCODE = 'check_violation', CONSTRAINT = 'order_cost_entries_channel';
  END IF;
  IF NEW.kind <> 'other' AND EXISTS (
    SELECT 1 FROM order_cost_entries e WHERE e.order_id = NEW.order_id AND e.kind = NEW.kind AND e.id <> NEW.id AND e.reverses_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM order_cost_entries r WHERE r.reverses_id = e.id)
  ) THEN
    RAISE EXCEPTION 'ja existe lancamento ativo deste tipo no pedido (estorne antes de lancar outro)' USING ERRCODE = 'check_violation', CONSTRAINT = 'order_cost_entries_single';
  END IF;
  IF NEW.external_ref IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('order_cost_ref:' || NEW.kind || ':' || NEW.external_ref));
    IF EXISTS (
      SELECT 1 FROM order_cost_entries e WHERE e.kind = NEW.kind AND e.external_ref = NEW.external_ref AND e.id <> NEW.id AND e.reverses_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM order_cost_entries r WHERE r.reverses_id = e.id)
    ) THEN
      RAISE EXCEPTION 'referencia externa ja lancada' USING ERRCODE = 'check_violation', CONSTRAINT = 'order_cost_entries_ref';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER order_cost_entries_check AFTER INSERT ON order_cost_entries FOR EACH ROW EXECUTE FUNCTION order_cost_entries_check();

-- ---------------------------------------------------------------------------------------------------------------
-- Indices de leitura para os relatorios por periodo (pagamento, pedido, despacho) e para o custo da venda por pedido.
CREATE INDEX orders_paid_at_idx ON orders (paid_at) WHERE paid_at IS NOT NULL;
CREATE INDEX orders_created_at_idx ON orders (created_at);
CREATE INDEX shipments_shipped_at_idx ON shipments (shipped_at) WHERE shipped_at IS NOT NULL;
CREATE INDEX stock_movements_order_source_idx ON stock_movements (source_id) WHERE source_type = 'order';

-- ---------------------------------------------------------------------------------------------------------------
-- Conferencia dos custos. So leitura, nada e gravado (o resultado vai para a tela e para o roteiro de implantacao).
--   C22 lancamentos: estorno coerente com o original; liquido por pedido e tipo >= 0; no maximo um ativo por pedido
--       nos tipos unicos; referencia externa ativa unica; tipo compativel com o canal do pedido
--   C23 configuracoes: versoes validadas da mesma chave sem sobreposicao; tipos de caixa validados sem medidas iguais
CREATE FUNCTION cost_reconcile() RETURNS TABLE (check_code text, field text, ref_id text, expected numeric, found numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH active AS (
    SELECT e.* FROM order_cost_entries e
    WHERE e.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM order_cost_entries r WHERE r.reverses_id = e.id)
  )
  SELECT 'C22', 'reversal', e.id::text, -o.amount_cents::numeric, e.amount_cents::numeric
    FROM order_cost_entries e JOIN order_cost_entries o ON o.id = e.reverses_id
   WHERE o.reverses_id IS NOT NULL OR o.order_id <> e.order_id OR o.kind <> e.kind OR e.amount_cents <> -o.amount_cents
  UNION ALL
  SELECT 'C22', 'net', e.order_id::text || ':' || e.kind, 0, sum(e.amount_cents)::numeric
    FROM order_cost_entries e GROUP BY e.order_id, e.kind HAVING sum(e.amount_cents) < 0
  UNION ALL
  SELECT 'C22', 'single', a.order_id::text || ':' || a.kind, 1, count(*)::numeric
    FROM active a WHERE a.kind <> 'other' GROUP BY a.order_id, a.kind HAVING count(*) > 1
  UNION ALL
  SELECT 'C22', 'external_ref', a.kind || ':' || a.external_ref, 1, count(*)::numeric
    FROM active a WHERE a.external_ref IS NOT NULL GROUP BY a.kind, a.external_ref HAVING count(*) > 1
  UNION ALL
  SELECT 'C22', 'channel', a.id::text, 0, 1
    FROM active a JOIN orders o ON o.id = a.order_id
   WHERE (a.kind IN ('marketplace_commission', 'marketplace_fee', 'marketplace_shipping') AND o.channel NOT IN ('mercadolivre', 'shopee'))
      OR (a.kind = 'payment_fee' AND o.channel IN ('mercadolivre', 'shopee'))
  UNION ALL
  SELECT 'C23', 'overlap', x.id::text || ':' || y.id::text, 0, 1
    FROM cost_settings x JOIN cost_settings y ON y.id > x.id AND y.kind = x.kind
   WHERE x.status = 'validated' AND y.status = 'validated'
     AND x.channel IS NOT DISTINCT FROM y.channel AND x.payment_method IS NOT DISTINCT FROM y.payment_method
     AND x.installments IS NOT DISTINCT FROM y.installments AND x.packaging_code IS NOT DISTINCT FROM y.packaging_code
     AND daterange(x.valid_from, x.valid_to) && daterange(y.valid_from, y.valid_to)
  UNION ALL
  SELECT 'C23', 'packaging_dims', x.id::text || ':' || y.id::text, 0, 1
    FROM cost_settings x JOIN cost_settings y ON y.id > x.id AND y.kind = 'packaging'
   WHERE x.kind = 'packaging' AND x.status = 'validated' AND y.status = 'validated' AND x.length_mm IS NOT NULL AND y.length_mm IS NOT NULL
     AND x.packaging_code <> y.packaging_code
     AND (SELECT array_agg(d ORDER BY d) FROM unnest(ARRAY[x.length_mm, x.width_mm, x.height_mm]) d)
       = (SELECT array_agg(d ORDER BY d) FROM unnest(ARRAY[y.length_mm, y.width_mm, y.height_mm]) d)
     AND daterange(x.valid_from, x.valid_to) && daterange(y.valid_from, y.valid_to)
$$;
REVOKE ALL ON FUNCTION cost_reconcile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cost_reconcile() TO loja_app;

-- ---------------------------------------------------------------------------------------------------------------
-- Privilegios minimos: lancamentos, importacoes e historico so por inclusao; configuracao muda so pelo status (gatilho).
GRANT SELECT, INSERT ON order_cost_entries, cost_imports, cost_setting_events TO loja_app;
GRANT SELECT, INSERT, UPDATE ON cost_settings TO loja_app;

-- Resumo para quem aplica.
DO $$
DECLARE ms numeric;
BEGIN
  ms := round(extract(epoch FROM clock_timestamp() - current_setting('sglog.t0')::timestamptz) * 1000);
  RAISE NOTICE '0029: pedidos, remessas e estoque bloqueados para escrita por % ms (ate aqui; o bloqueio termina no COMMIT)', ms;
  RAISE NOTICE '0029: % pedido(s) pago(s) e % movimento(s) de venda no estoque; nenhuma configuracao de custo ou lancamento existe ainda',
    (SELECT count(*) FROM orders WHERE paid_at IS NOT NULL), (SELECT count(*) FROM stock_movements WHERE kind = 'sale');
END $$;
