-- Catalogo: categorias, produtos, variacoes (SKU), embalagens de venda e de compra, imagens e dados fiscais.
-- O estoque (Fase 3) e sempre contado na UNIDADE BASE do produto. Cada embalagem diz quantas
-- unidades base contem: comprar 1 pacote de 100 entra +100; vender 5 unidades sai -5.

CREATE TABLE categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id    uuid REFERENCES categories (id),
  name         text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  slug         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 90),
  description  text CHECK (length(description) <= 2000),
  position     integer NOT NULL DEFAULT 0,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categories_not_self CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE UNIQUE INDEX categories_name_unique ON categories (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

-- Arvore sem ciclo e com no maximo 3 niveis (categoria > subcategoria > subcategoria).
CREATE FUNCTION categories_check_tree() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE depth int := 1; cur uuid := NEW.parent_id;
BEGIN
  WHILE cur IS NOT NULL LOOP
    IF cur = NEW.id THEN RAISE EXCEPTION 'categoria nao pode ficar dentro de si mesma' USING ERRCODE = 'check_violation', CONSTRAINT = 'categories_cycle'; END IF;
    depth := depth + 1;
    IF depth > 3 THEN RAISE EXCEPTION 'no maximo 3 niveis de categoria' USING ERRCODE = 'check_violation', CONSTRAINT = 'categories_depth'; END IF;
    SELECT parent_id INTO cur FROM categories WHERE id = cur;
  END LOOP;
  -- Quem recebe filhos tambem conta: mover uma categoria com filhos nao pode passar de 3 niveis.
  IF TG_OP = 'UPDATE' AND EXISTS (
    WITH RECURSIVE sub AS (SELECT id, 1 AS lvl FROM categories WHERE parent_id = NEW.id UNION ALL SELECT c.id, s.lvl + 1 FROM categories c JOIN sub s ON c.parent_id = s.id)
    SELECT 1 FROM sub WHERE depth + lvl > 3) THEN
    RAISE EXCEPTION 'no maximo 3 niveis de categoria' USING ERRCODE = 'check_violation', CONSTRAINT = 'categories_depth';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER categories_tree BEFORE INSERT OR UPDATE OF parent_id ON categories FOR EACH ROW EXECUTE FUNCTION categories_check_tree();

-- Unidades comerciais. Codigos genericos de unidade; nao sao dados da empresa.
CREATE TABLE units (
  code            text PRIMARY KEY CHECK (code ~ '^[A-Z0-9]{1,6}$'),
  name            text NOT NULL,
  allows_fraction boolean NOT NULL DEFAULT false
);
INSERT INTO units (code, name, allows_fraction) VALUES
  ('UN', 'Unidade', false), ('PCT', 'Pacote', false), ('CX', 'Caixa', false), ('FD', 'Fardo', false),
  ('DZ', 'Dúzia', false), ('CJ', 'Conjunto', false), ('KIT', 'Kit', false), ('PAR', 'Par', false),
  ('RL', 'Rolo', false), ('FL', 'Folha', false), ('KG', 'Quilograma', true), ('G', 'Grama', true),
  ('L', 'Litro', true), ('ML', 'Mililitro', true), ('M', 'Metro', true);

CREATE TABLE products (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id        uuid REFERENCES categories (id),
  name               text NOT NULL CHECK (length(name) BETWEEN 2 AND 150),
  slug               text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 160),
  summary            text CHECK (length(summary) <= 300),
  description        text CHECK (length(description) <= 10000),
  brand              text CHECK (length(brand) <= 80),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive')),
  base_unit          text NOT NULL REFERENCES units (code),
  -- Giro: orienta a reposicao (Fase 3). Nulo ate haver historico ou decisao do administrador.
  turnover           text CHECK (turnover IN ('high', 'medium', 'low')),
  -- Sob encomenda: a loja mostra a condicao e o prazo antes de finalizar a compra.
  availability_mode  text NOT NULL DEFAULT 'stock' CHECK (availability_mode IN ('stock', 'made_to_order')),
  lead_time_days     integer CHECK (lead_time_days BETWEEN 1 AND 180),
  min_stock          numeric(14,3) NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  -- Ficha tecnica: lista de {label, value}.
  specs              jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(specs) = 'array'),
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  search_doc         text GENERATED ALWAYS AS (search_text(name || ' ' || coalesce(summary, '') || ' ' || coalesce(brand, ''))) STORED
);
CREATE INDEX products_search_idx ON products USING gin (search_doc gin_trgm_ops);
CREATE INDEX products_category_idx ON products (category_id);

-- Variacao vendavel. Produto sem variacoes tem exatamente uma.
CREATE TABLE product_variants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  sku         citext NOT NULL UNIQUE CHECK (sku ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$'),
  barcode     text UNIQUE CHECK (barcode ~ '^(\d{8}|\d{12,14})$'),
  -- Atributos da variacao: {"Cor": "Branco", "Tamanho": "15 cm"}.
  attributes  jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(attributes) = 'object'),
  active      boolean NOT NULL DEFAULT true,
  position    integer NOT NULL DEFAULT 0,
  -- Peso e medidas da unidade base, para o frete (Fase 4).
  weight_g    integer CHECK (weight_g > 0),
  length_mm   integer CHECK (length_mm > 0),
  width_mm    integer CHECK (width_mm > 0),
  height_mm   integer CHECK (height_mm > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_variants_product_idx ON product_variants (product_id);

-- Embalagens: como a variacao e vendida (unidade, pacote, caixa) e como e comprada do fornecedor.
CREATE TABLE packagings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id   uuid NOT NULL REFERENCES product_variants (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('sale', 'purchase')),
  label        text NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  unit_code    text NOT NULL REFERENCES units (code),
  -- Quantas unidades base cabem nesta embalagem.
  base_qty     numeric(14,3) NOT NULL CHECK (base_qty > 0),
  price_cents  bigint CHECK (price_cents > 0),
  barcode      text UNIQUE CHECK (barcode ~ '^(\d{8}|\d{12,14})$'),
  is_default   boolean NOT NULL DEFAULT false,
  active       boolean NOT NULL DEFAULT true,
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- Venda sempre tem preco publico; a compra tem custo por fornecedor (Fase 3), nao preco.
  CONSTRAINT packagings_price CHECK ((kind = 'sale') = (price_cents IS NOT NULL))
);
CREATE UNIQUE INDEX packagings_qty_unique ON packagings (variant_id, kind, base_qty) WHERE active;
CREATE UNIQUE INDEX packagings_default_unique ON packagings (variant_id, kind) WHERE is_default AND active;

-- Historico de precos: todo preco gravado, com autor. Somente inclusao.
CREATE TABLE price_history (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  packaging_id     uuid NOT NULL REFERENCES packagings (id) ON DELETE CASCADE,
  old_price_cents  bigint,
  new_price_cents  bigint NOT NULL,
  changed_by       uuid REFERENCES users (id),
  changed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX price_history_packaging_idx ON price_history (packaging_id, changed_at DESC);
CREATE TRIGGER price_history_immutable BEFORE UPDATE ON price_history FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- SECURITY DEFINER: a API so le o historico; quem grava e o gatilho.
CREATE FUNCTION packagings_price_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.price_cents IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.price_cents IS DISTINCT FROM OLD.price_cents) THEN
    INSERT INTO price_history (packaging_id, old_price_cents, new_price_cents, changed_by)
    VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.price_cents END, NEW.price_cents, app_user_id());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER packagings_price AFTER INSERT OR UPDATE OF price_cents ON packagings FOR EACH ROW EXECUTE FUNCTION packagings_price_history();

CREATE TABLE product_images (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  variant_id  uuid REFERENCES product_variants (id) ON DELETE SET NULL,
  file_key    text NOT NULL UNIQUE CHECK (file_key ~ '^[a-f0-9-]{36}$'),
  width       integer NOT NULL,
  height      integer NOT NULL,
  bytes       integer NOT NULL,
  alt         text CHECK (length(alt) <= 200),
  position    integer NOT NULL DEFAULT 0,
  is_primary  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_images_primary_unique ON product_images (product_id) WHERE is_primary;

-- Classificacao fiscal do produto. Quem informa e quem valida ficam registrados.
-- O sistema aponta campos ausentes e formatos invalidos; o enquadramento e do contador.
CREATE TABLE product_fiscal (
  product_id      uuid PRIMARY KEY REFERENCES products (id) ON DELETE CASCADE,
  ncm             text CHECK (ncm ~ '^\d{8}$'),
  cest            text CHECK (cest ~ '^\d{7}$'),
  -- Origem da mercadoria (0 a 8), conforme a tabela da NF-e.
  origin          smallint CHECK (origin BETWEEN 0 AND 8),
  -- Unidade tributavel e quantas unidades base ela contem.
  tax_unit        text CHECK (tax_unit ~ '^[A-Z0-9]{1,6}$'),
  tax_unit_qty    numeric(14,4) CHECK (tax_unit_qty > 0),
  notes           text CHECK (length(notes) <= 2000),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'informed', 'validated')),
  informed_by     uuid REFERENCES users (id),
  informed_at     timestamptz,
  validated_by    uuid REFERENCES users (id),
  validator_name  text CHECK (length(validator_name) <= 120),
  validated_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_fiscal_validated CHECK (status <> 'validated' OR (validated_by IS NOT NULL AND validated_at IS NOT NULL AND validator_name IS NOT NULL AND ncm IS NOT NULL AND origin IS NOT NULL))
);

-- Mudou um campo fiscal de um produto validado: a validacao cai, e o contador precisa validar de novo.
CREATE FUNCTION product_fiscal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.ncm, NEW.cest, NEW.origin, NEW.tax_unit, NEW.tax_unit_qty) IS DISTINCT FROM (OLD.ncm, OLD.cest, OLD.origin, OLD.tax_unit, OLD.tax_unit_qty)
     AND NEW.validated_at IS NOT DISTINCT FROM OLD.validated_at THEN
    NEW.status := CASE WHEN NEW.ncm IS NULL THEN 'pending' ELSE 'informed' END;
    NEW.validated_by := NULL; NEW.validator_name := NULL; NEW.validated_at := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER product_fiscal_guard BEFORE UPDATE ON product_fiscal FOR EACH ROW EXECUTE FUNCTION product_fiscal_guard();

CREATE TABLE product_fiscal_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id  uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  snapshot    jsonb NOT NULL,
  changed_by  uuid REFERENCES users (id),
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER product_fiscal_history_immutable BEFORE UPDATE ON product_fiscal_history FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION product_fiscal_log() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO product_fiscal_history (product_id, snapshot, changed_by)
  VALUES (NEW.product_id, to_jsonb(NEW) - 'product_id', app_user_id());
  RETURN NEW;
END $$;
CREATE TRIGGER product_fiscal_log AFTER INSERT OR UPDATE ON product_fiscal FOR EACH ROW EXECUTE FUNCTION product_fiscal_log();

GRANT SELECT ON units TO loja_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON categories, products, product_variants, packagings, product_images TO loja_app;
GRANT SELECT, INSERT, UPDATE ON product_fiscal TO loja_app;
GRANT SELECT ON price_history, product_fiscal_history TO loja_app;
