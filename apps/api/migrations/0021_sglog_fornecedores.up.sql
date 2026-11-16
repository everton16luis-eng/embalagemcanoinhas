-- SGLog Fase 2: gestao de fornecedores (docs/17-sglog-fase2-planejamento.md e docs/18-sglog-fase2.md).
-- Nada do que existe muda de comportamento para o codigo antigo: suppliers.active e supplier_products.active continuam
-- valendo e passam a ser sincronizados com a coluna nova status, nos dois sentidos, por gatilho.
-- Nao toca em estoque, pedidos de venda, checkout, pagamento, fiscal nem marketplaces.
-- A disponibilidade informada pelo fornecedor fica numa tabela propria, SEM nenhuma ligacao com stock_*.

-- Bloqueios, todos antes de qualquer alteracao, com a mesma tecnica da 0020: espera so a tabela principal (sem segurar
-- nada), pede as demais com NOWAIT e, se alguma estiver ocupada, solta tudo, espera 20 ms e tenta de novo. Teto de 10 s.
--   supplier_products     ACCESS EXCLUSIVE     colunas, gatilhos e indices novos
--   suppliers             ACCESS EXCLUSIVE     colunas e gatilhos novos; FK de contatos e ofertas trocada
--   supplier_contacts     ACCESS EXCLUSIVE     colunas novas; FK trocada
--   purchase_order_items  ACCESS EXCLUSIVE     colunas da excecao de minimo (so compras; venda nao usa)
--   product_variants      SHARE ROW EXCLUSIVE  FKs novas (leitura da loja continua)
--   users                 SHARE ROW EXCLUSIVE  FKs novas (leitura continua)
--   user_permissions      ROW EXCLUSIVE        copia das concessoes individuais
SET LOCAL lock_timeout = '10s';
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '10 seconds'; tries integer := 0; waited numeric;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE supplier_products IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE suppliers IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE supplier_contacts IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE purchase_order_items IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE product_variants IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE user_permissions IN ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF clock_timestamp() > deadline THEN
        RAISE EXCEPTION '0021: tabelas de fornecedores ocupadas por mais de 10 s (% tentativas); nada foi alterado, tente de novo', tries
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.02);
    END;
  END LOOP;
  waited := round(extract(epoch FROM clock_timestamp() - (deadline - interval '10 seconds')) * 1000);
  RAISE NOTICE '0021: bloqueios obtidos em % ms (% nova(s) tentativa(s))', waited, tries;
END $$;

-- 1. Pre-checagens dos codigos do fornecedor (D2-5). Nenhum codigo e alterado automaticamente: a NF-e de compra casa
--    o item pelo codigo exato. Com conflito, a migration para e nada muda. O relatorio completo, com o impacto nas
--    notas de compra importadas, sai de: node scripts/fornecedores-codigos.mjs (so leitura).
DO $$
DECLARE dup text; bad text;
BEGIN
  SELECT string_agg(format('%s (fornecedor %s, %s ofertas)', supplier_sku, supplier_id, n), '; ') INTO dup
  FROM (SELECT supplier_id, supplier_sku, count(*) AS n FROM supplier_products WHERE supplier_sku IS NOT NULL
        GROUP BY 1, 2 HAVING count(*) > 1 ORDER BY 1, 2 LIMIT 20) d;
  SELECT string_agg(format('oferta %s: "%s"', id, supplier_sku), '; ') INTO bad
  FROM (SELECT id, supplier_sku FROM supplier_products
        WHERE supplier_sku IS NOT NULL AND (btrim(supplier_sku) = '' OR supplier_sku <> btrim(supplier_sku))
        ORDER BY id LIMIT 20) b;
  IF dup IS NOT NULL OR bad IS NOT NULL THEN
    RAISE EXCEPTION '0021: codigos do fornecedor precisam de correcao antes da migration; nada foi alterado. Duplicados: %. Vazios ou com espaco nas pontas: %. Rode node scripts/fornecedores-codigos.mjs para o relatorio.',
      coalesce(dup, 'nenhum'), coalesce(bad, 'nenhum')
      USING ERRCODE = 'check_violation';
  END IF;
  -- Mesmo codigo com maiusculas diferentes no mesmo fornecedor: a NF-e trata como codigos diferentes, entao nao e
  -- conflito. So avisa, para a conferencia.
  SELECT string_agg(format('%s (fornecedor %s)', k, supplier_id), '; ') INTO dup
  FROM (SELECT supplier_id, lower(supplier_sku) AS k FROM supplier_products WHERE supplier_sku IS NOT NULL
        GROUP BY 1, 2 HAVING count(DISTINCT supplier_sku) > 1 ORDER BY 1, 2 LIMIT 20) c;
  IF dup IS NOT NULL THEN RAISE NOTICE '0021: aviso: codigos iguais exceto maiusculas: %', dup; END IF;
END $$;

-- 2. Fornecedor: endereco, prazos, devolucao, custos do pedido, situacao, arquivamento e versao.
ALTER TABLE suppliers
  ADD COLUMN cep                 text CHECK (cep ~ '^[0-9]{8}$'),
  ADD COLUMN street              text CHECK (length(street) <= 120),
  ADD COLUMN number              text CHECK (length(number) <= 20),
  ADD COLUMN complement          text CHECK (length(complement) <= 60),
  ADD COLUMN district            text CHECK (length(district) <= 60),
  ADD COLUMN prep_days           integer CHECK (prep_days BETWEEN 0 AND 180),
  ADD COLUMN delivery_days       integer CHECK (delivery_days BETWEEN 0 AND 180),
  ADD COLUMN return_policy       text CHECK (length(return_policy) <= 2000),
  ADD COLUMN return_days         integer CHECK (return_days BETWEEN 0 AND 365),
  -- Frete e despesas fixas por pedido. Nulo = desconhecido (nunca vale como zero na escolha); 0 = incluso.
  ADD COLUMN order_freight_cents bigint CHECK (order_freight_cents >= 0),
  ADD COLUMN order_extra_cents   bigint CHECK (order_extra_cents >= 0),
  -- So cadastro: nenhuma rota opera dropshipping ate a validacao fiscal e autorizacao especifica.
  ADD COLUMN dropship_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'blocked')),
  ADD COLUMN blocked_reason      text CHECK (length(blocked_reason) BETWEEN 3 AND 300),
  ADD COLUMN blocked_by          uuid REFERENCES users (id),
  ADD COLUMN blocked_at          timestamptz,
  ADD COLUMN archived_at         timestamptz,
  ADD COLUMN archived_by         uuid REFERENCES users (id),
  ADD COLUMN archive_reason      text CHECK (length(archive_reason) BETWEEN 3 AND 300),
  ADD COLUMN version             integer NOT NULL DEFAULT 1;
UPDATE suppliers SET status = 'inactive' WHERE NOT active;
ALTER TABLE suppliers
  ADD CONSTRAINT suppliers_blocked_reason CHECK ((status = 'blocked') = (blocked_reason IS NOT NULL AND blocked_at IS NOT NULL)),
  ADD CONSTRAINT suppliers_archived_reason CHECK ((archived_at IS NULL) = (archive_reason IS NULL)),
  ADD CONSTRAINT suppliers_archived_not_active CHECK (archived_at IS NULL OR status <> 'active');
CREATE INDEX suppliers_status_idx ON suppliers (status) WHERE archived_at IS NULL;

-- 3. Contatos: WhatsApp e contato principal.
ALTER TABLE supplier_contacts
  ADD COLUMN whatsapp    text CHECK (whatsapp ~ '^[0-9]{12,13}$'),
  ADD COLUMN is_primary  boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX supplier_contacts_one_primary ON supplier_contacts (supplier_id) WHERE is_primary;

-- 4. Oferta (fornecedor x embalagem de compra).
ALTER TABLE supplier_products
  ADD COLUMN variant_id            uuid REFERENCES product_variants (id),
  ADD COLUMN min_order_packs       numeric(12,3) CHECK (min_order_packs > 0),
  ADD COLUMN order_multiple_packs  numeric(12,3) CHECK (order_multiple_packs > 0),
  ADD COLUMN prep_days             integer CHECK (prep_days BETWEEN 0 AND 180),
  ADD COLUMN dropship_allowed      boolean NOT NULL DEFAULT false,
  ADD COLUMN is_primary            boolean NOT NULL DEFAULT false,
  ADD COLUMN status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  ADD COLUMN ended_at              timestamptz,
  ADD COLUMN ended_by              uuid REFERENCES users (id),
  ADD COLUMN end_reason            text CHECK (length(end_reason) <= 300),
  ADD COLUMN created_at            timestamptz,
  ADD COLUMN version               integer NOT NULL DEFAULT 1;
UPDATE supplier_products sp SET variant_id = k.variant_id, created_at = sp.updated_at,
  status = CASE WHEN sp.active THEN 'active' ELSE 'paused' END
FROM packagings k WHERE k.id = sp.packaging_id;
ALTER TABLE supplier_products
  ALTER COLUMN variant_id SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD CONSTRAINT supplier_products_sku_trimmed CHECK (supplier_sku IS NULL OR (supplier_sku <> '' AND supplier_sku = btrim(supplier_sku))),
  ADD CONSTRAINT supplier_products_primary_active CHECK (NOT is_primary OR status = 'active'),
  ADD CONSTRAINT supplier_products_ended CHECK ((status = 'ended') = (ended_at IS NOT NULL));
CREATE UNIQUE INDEX supplier_products_one_primary ON supplier_products (variant_id) WHERE is_primary;
CREATE UNIQUE INDEX supplier_products_sku_unique ON supplier_products (supplier_id, supplier_sku) WHERE supplier_sku IS NOT NULL;
CREATE INDEX supplier_products_variant_idx ON supplier_products (variant_id, status);

-- 5. Exclusao fisica impedida: contatos e ofertas nao somem junto com o fornecedor.
ALTER TABLE supplier_contacts DROP CONSTRAINT supplier_contacts_supplier_id_fkey,
  ADD CONSTRAINT supplier_contacts_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE RESTRICT;
ALTER TABLE supplier_products DROP CONSTRAINT supplier_products_supplier_id_fkey,
  ADD CONSTRAINT supplier_products_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE RESTRICT;

-- 6. Historico de custo (imutavel). Comeca nesta migration (D2-3): uma linha por oferta com o custo atual e origem
--    'migration'. Os custos anteriores continuam na auditoria; nenhum preco historico e inventado.
CREATE TABLE supplier_price_history (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supplier_product_id  uuid NOT NULL REFERENCES supplier_products (id),
  supplier_id          uuid NOT NULL REFERENCES suppliers (id),
  variant_id           uuid NOT NULL REFERENCES product_variants (id),
  old_cost_cents       bigint,
  new_cost_cents       bigint NOT NULL CHECK (new_cost_cents > 0),
  quoted_at            date NOT NULL,
  source               text NOT NULL CHECK (source IN ('manual', 'legacy_list', 'migration', 'invoice', 'system')),
  reason               text CHECK (length(reason) <= 300),
  changed_by           uuid REFERENCES users (id),
  changed_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_price_history_offer_idx ON supplier_price_history (supplier_product_id, changed_at DESC);
CREATE INDEX supplier_price_history_supplier_idx ON supplier_price_history (supplier_id, changed_at DESC);
CREATE TRIGGER supplier_price_history_immutable BEFORE UPDATE OR DELETE ON supplier_price_history FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER supplier_price_history_no_truncate BEFORE TRUNCATE ON supplier_price_history FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

INSERT INTO supplier_price_history (supplier_product_id, supplier_id, variant_id, old_cost_cents, new_cost_cents, quoted_at, source, changed_at)
SELECT id, supplier_id, variant_id, NULL, cost_cents, quoted_at, 'migration', now() FROM supplier_products ORDER BY created_at, id;

-- Origem e justificativa vem da transacao da API: set_config('sglog.cost_source' / 'sglog.cost_reason', ..., true).
-- Sem elas: 'manual' quando ha usuario na transacao, 'system' quando nao ha (seed, manutencao como dono).
CREATE FUNCTION supplier_products_price_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE src text := nullif(current_setting('sglog.cost_source', true), '');
BEGIN
  IF TG_OP = 'INSERT' OR NEW.cost_cents IS DISTINCT FROM OLD.cost_cents THEN
    INSERT INTO supplier_price_history (supplier_product_id, supplier_id, variant_id, old_cost_cents, new_cost_cents, quoted_at, source, reason, changed_by)
    VALUES (NEW.id, NEW.supplier_id, NEW.variant_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.cost_cents END, NEW.cost_cents, NEW.quoted_at,
            coalesce(src, CASE WHEN app_user_id() IS NULL THEN 'system' ELSE 'manual' END),
            nullif(current_setting('sglog.cost_reason', true), ''), app_user_id());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_products_price AFTER INSERT OR UPDATE OF cost_cents ON supplier_products FOR EACH ROW EXECUTE FUNCTION supplier_products_price_history();

-- 7. Disponibilidade informada pelo fornecedor (imutavel; vale a ultima por fornecedor x variante, D2-2).
--    Em unidade base. NAO e estoque da loja: nenhuma FK, gatilho ou visao leva isto a stock_*.
CREATE TABLE supplier_availability (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supplier_id    uuid NOT NULL REFERENCES suppliers (id),
  variant_id     uuid NOT NULL REFERENCES product_variants (id),
  available_qty  numeric(14,3) NOT NULL CHECK (available_qty >= 0),
  confirmed_at   timestamptz NOT NULL,
  valid_until    timestamptz NOT NULL,
  source         text NOT NULL CHECK (source IN ('manual', 'whatsapp', 'email', 'phone', 'api')),
  note           text CHECK (length(note) <= 300),
  created_by     uuid REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_availability_window CHECK (valid_until > confirmed_at)
);
CREATE INDEX supplier_availability_current_idx ON supplier_availability (supplier_id, variant_id, confirmed_at DESC, id DESC);
CREATE INDEX supplier_availability_variant_idx ON supplier_availability (variant_id);
CREATE TRIGGER supplier_availability_immutable BEFORE UPDATE OR DELETE ON supplier_availability FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER supplier_availability_no_truncate BEFORE TRUNCATE ON supplier_availability FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- 8. Parametros (linha unica, ajustaveis por settings.manage): empate tecnico de custo, cotacao antiga e aviso de
--    disponibilidade a vencer (D2-10).
CREATE TABLE supplier_settings (
  id                         boolean PRIMARY KEY DEFAULT true CHECK (id),
  tie_tolerance_pct          numeric(5,2) NOT NULL DEFAULT 3 CHECK (tie_tolerance_pct BETWEEN 0 AND 50),
  stale_quote_days           integer NOT NULL DEFAULT 90 CHECK (stale_quote_days BETWEEN 1 AND 3650),
  availability_warning_days  integer NOT NULL DEFAULT 3 CHECK (availability_warning_days BETWEEN 0 AND 90),
  version                    integer NOT NULL DEFAULT 1,
  updated_by                 uuid REFERENCES users (id),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
INSERT INTO supplier_settings DEFAULT VALUES;

-- 9. Compra abaixo do minimo ou fora do multiplo do fornecedor: avisa e, se a pessoa seguir, guarda a justificativa
--    (D2-11). min_order_packs e order_multiple_packs sao copia da oferta no momento do pedido.
ALTER TABLE purchase_order_items
  ADD COLUMN min_order_packs       numeric(12,3) CHECK (min_order_packs > 0),
  ADD COLUMN order_multiple_packs  numeric(12,3) CHECK (order_multiple_packs > 0),
  ADD COLUMN min_exception_reason  text CHECK (length(min_exception_reason) BETWEEN 3 AND 300);

-- 10. Gatilhos de sincronizacao e de integridade, criados depois do preenchimento.
-- Fornecedor: active <-> status. Mudar status recalcula active; mudar so active (codigo antigo) muda status.
-- Toda alteracao incrementa version (controle otimista; tambem pega gravacoes do codigo antigo).
CREATE FUNCTION suppliers_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT NEW.active AND NEW.status = 'active' THEN NEW.status := 'inactive'; END IF;
  ELSE
    IF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.active IS DISTINCT FROM OLD.active THEN
      IF NEW.active THEN
        IF OLD.archived_at IS NOT NULL THEN
          RAISE EXCEPTION 'Fornecedor arquivado: restaure antes de ativar' USING ERRCODE = 'check_violation';
        END IF;
        NEW.status := 'active';
      ELSIF OLD.status = 'active' THEN
        NEW.status := 'inactive';
      END IF;
    END IF;
    IF NEW.status <> 'blocked' THEN NEW.blocked_reason := NULL; NEW.blocked_by := NULL; NEW.blocked_at := NULL; END IF;
    NEW.version := OLD.version + 1;
    NEW.updated_at := now();
  END IF;
  NEW.active := NEW.status = 'active';
  RETURN NEW;
END $$;
CREATE TRIGGER suppliers_sync BEFORE INSERT OR UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION suppliers_sync();

-- Fornecedor que deixa de ser ativo perde a marca de principal das ofertas (nunca o contrario: D2-9).
CREATE FUNCTION suppliers_drop_primary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'active' AND OLD.status = 'active' THEN
    UPDATE supplier_products SET is_primary = false WHERE supplier_id = NEW.id AND is_primary;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER suppliers_drop_primary AFTER UPDATE OF status ON suppliers FOR EACH ROW EXECUTE FUNCTION suppliers_drop_primary();

-- Oferta: variante sempre a da embalagem; fornecedor e embalagem nao mudam; active <-> status; reativar oferta
-- encerrada so pela acao explicita (muda status, D2-7); principal so com fornecedor ativo.
CREATE FUNCTION supplier_products_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.supplier_id <> OLD.supplier_id OR NEW.packaging_id <> OLD.packaging_id) THEN
    RAISE EXCEPTION 'Fornecedor e embalagem da oferta nao mudam; encerre e crie outra' USING ERRCODE = 'check_violation';
  END IF;
  SELECT variant_id INTO NEW.variant_id FROM packagings WHERE id = NEW.packaging_id;
  IF TG_OP = 'INSERT' THEN
    IF NOT NEW.active AND NEW.status = 'active' THEN NEW.status := 'paused'; END IF;
  ELSE
    IF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.active IS DISTINCT FROM OLD.active THEN
      IF NEW.active THEN
        IF OLD.status = 'ended' THEN
          RAISE EXCEPTION 'Oferta encerrada: use a reativacao explicita' USING ERRCODE = 'check_violation';
        END IF;
        NEW.status := 'active';
      ELSIF OLD.status = 'active' THEN
        NEW.status := 'paused';
      END IF;
    END IF;
    NEW.version := OLD.version + 1;
    NEW.updated_at := now();
  END IF;
  IF NEW.status <> 'ended' THEN NEW.ended_at := NULL; NEW.ended_by := NULL; NEW.end_reason := NULL;
  ELSIF NEW.ended_at IS NULL THEN NEW.ended_at := now(); NEW.ended_by := app_user_id();
  END IF;
  IF NEW.status <> 'active' THEN NEW.is_primary := false; END IF;
  IF NEW.is_primary AND (TG_OP = 'INSERT' OR NOT OLD.is_primary)
     AND (SELECT status FROM suppliers WHERE id = NEW.supplier_id) <> 'active' THEN
    RAISE EXCEPTION 'Fornecedor principal precisa estar ativo' USING ERRCODE = 'check_violation';
  END IF;
  NEW.active := NEW.status = 'active';
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_products_sync BEFORE INSERT OR UPDATE ON supplier_products FOR EACH ROW EXECUTE FUNCTION supplier_products_sync();

-- 11. Visao de leitura das ofertas com as condicoes calculadas (telas, comparacao e a escolha do fornecedor).
--     prazo efetivo = preparacao (oferta ou fornecedor) + entrega; sem uma das partes, o prazo antigo da oferta ou do
--     fornecedor; sem nada, desconhecido (nulo). Disponibilidade = ultima confirmacao, vencida ou nao.
CREATE VIEW supplier_offer_terms AS
SELECT sp.id, sp.supplier_id, s.name AS supplier_name, s.status AS supplier_status, s.archived_at AS supplier_archived_at,
       s.blocked_reason AS supplier_blocked_reason, s.min_order_cents, s.order_freight_cents, s.order_extra_cents,
       s.dropship_enabled, sp.packaging_id, k.label AS packaging_label, k.base_qty, k.active AS packaging_active,
       sp.variant_id, v.sku, v.active AS variant_active, p.id AS product_id, p.name AS product_name, p.status AS product_status,
       p.base_unit, sp.supplier_sku, sp.cost_cents, round(sp.cost_cents / k.base_qty, 4) AS unit_cost_cents, sp.quoted_at,
       (current_date - sp.quoted_at) AS quote_age_days, sp.min_order_packs, sp.order_multiple_packs, sp.status, sp.is_primary,
       sp.dropship_allowed, sp.version,
       coalesce(sp.prep_days, s.prep_days) AS prep_days, s.delivery_days,
       CASE WHEN coalesce(sp.prep_days, s.prep_days) IS NOT NULL AND s.delivery_days IS NOT NULL
            THEN coalesce(sp.prep_days, s.prep_days) + s.delivery_days
            ELSE coalesce(sp.lead_time_days, s.lead_time_days) END AS lead_days,
       a.available_qty, a.confirmed_at AS availability_confirmed_at, a.valid_until AS availability_valid_until,
       a.source AS availability_source, (a.valid_until IS NOT NULL AND a.valid_until < now()) AS availability_expired
FROM supplier_products sp
JOIN suppliers s ON s.id = sp.supplier_id
JOIN packagings k ON k.id = sp.packaging_id
JOIN product_variants v ON v.id = sp.variant_id
JOIN products p ON p.id = v.product_id
LEFT JOIN LATERAL (
  SELECT x.available_qty, x.confirmed_at, x.valid_until, x.source FROM supplier_availability x
  WHERE x.supplier_id = sp.supplier_id AND x.variant_id = sp.variant_id ORDER BY x.confirmed_at DESC, x.id DESC LIMIT 1
) a ON true;

-- 12. Privilegios: o loja_app nao apaga fornecedor nem oferta; historicos so por gatilho ou so inclusao.
REVOKE DELETE ON suppliers, supplier_products FROM loja_app;
GRANT SELECT ON supplier_price_history, supplier_offer_terms TO loja_app;
GRANT SELECT, INSERT ON supplier_availability TO loja_app;
GRANT SELECT, UPDATE ON supplier_settings TO loja_app;

-- 13. Permissoes novas suppliers.view e suppliers.manage: as concessoes e revogacoes individuais de purchases.* sao
--     copiadas, para ninguem perder nem ganhar acesso por causa da troca. Nenhuma outra linha muda.
INSERT INTO user_permissions (user_id, permission, granted)
SELECT user_id, replace(permission, 'purchases.', 'suppliers.'), granted FROM user_permissions
WHERE permission IN ('purchases.view', 'purchases.manage')
ON CONFLICT (user_id, permission) DO NOTHING;

DO $$
DECLARE r record;
BEGIN
  SELECT (SELECT count(*) FROM suppliers WHERE status = 'active') AS ativos, (SELECT count(*) FROM suppliers WHERE status = 'inactive') AS inativos,
         (SELECT count(*) FROM supplier_products) AS ofertas, (SELECT count(*) FROM supplier_products WHERE status = 'active') AS ofertas_ativas,
         (SELECT count(*) FROM supplier_offer_terms WHERE lead_days IS NULL) AS sem_prazo,
         (SELECT count(*) FROM (SELECT variant_id FROM supplier_products WHERE status = 'active' GROUP BY 1 HAVING count(DISTINCT supplier_id) > 1) m) AS multi,
         (SELECT count(*) FROM user_permissions WHERE permission LIKE 'suppliers.%') AS perms
  INTO r;
  RAISE NOTICE '0021: % fornecedor(es) ativo(s), % inativo(s); % oferta(s), % ativa(s), % sem prazo; % variante(s) com mais de um fornecedor; % permissao(oes) individual(is) copiada(s)',
    r.ativos, r.inativos, r.ofertas, r.ofertas_ativas, r.sem_prazo, r.multi, r.perms;
END $$;
