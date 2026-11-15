-- Importacao de produtos em massa por planilha .xlsx (docs/14-importacao-produtos.md).
-- A analise grava as linhas lidas sem criar nada no catalogo. So a confirmacao do administrador cria
-- categorias e produtos, em lotes, cada lote numa transacao. O SKU continua unico pela restricao
-- product_variants_sku_key (citext, sem diferenca de maiusculas), criada na 0002.

CREATE TABLE product_imports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name           text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  file_sha256         text NOT NULL CHECK (file_sha256 ~ '^[a-f0-9]{64}$'),
  file_bytes          integer NOT NULL CHECK (file_bytes > 0),
  -- analyzed: aguardando revisao; importing: confirmado, lotes em andamento; done: terminado; canceled: descartado.
  status              text NOT NULL DEFAULT 'analyzed' CHECK (status IN ('analyzed', 'importing', 'done', 'canceled')),
  -- Decisao do administrador para cada categoria que nao existe: {"chave": {"action": "map", "categoryId": "..."} | {"action": "create"}}.
  category_decisions  jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(category_decisions) = 'object'),
  -- Avisos do arquivo inteiro (colunas ignoradas, arquivo ja importado antes).
  warnings            jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(warnings) = 'array'),
  totals              jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(totals) = 'object'),
  -- Categorias da planilha que nao existem, com a decisao atual (recalculado a cada analise).
  pending_categories  jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(pending_categories) = 'array'),
  created_by          uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  confirmed_by        uuid REFERENCES users (id),
  confirmed_at        timestamptz,
  finished_at         timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_imports_confirmed CHECK (status IN ('analyzed', 'canceled') OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL))
);
CREATE INDEX product_imports_created_idx ON product_imports (created_at DESC);
CREATE INDEX product_imports_sha_idx ON product_imports (file_sha256);

CREATE TABLE product_import_rows (
  import_id      uuid NOT NULL REFERENCES product_imports (id) ON DELETE CASCADE,
  -- Linha da planilha (a 1 e o cabecalho; a 2 e a orientacao do modelo).
  row_number     integer NOT NULL CHECK (row_number >= 2),
  -- Valores lidos, ja sanitizados, como texto. Correcoes feitas na tela alteram este campo.
  raw            jsonb NOT NULL CHECK (jsonb_typeof(raw) = 'object'),
  -- Celulas que tinham formula: o conteudo foi descartado, nunca calculado.
  formula_fields text[] NOT NULL DEFAULT '{}',
  data           jsonb,
  status         text NOT NULL CHECK (status IN ('new', 'existing', 'duplicate', 'error', 'incomplete', 'category')),
  issues         jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(issues) = 'array'),
  matches        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(matches) = 'array'),
  category_key   text,
  -- Possivel duplicado: o administrador aprova (cadastra mesmo assim) ou ignora.
  decision       text CHECK (decision IN ('approve', 'skip')),
  sku            text CHECK (length(sku) <= 40),
  sku_generated  boolean NOT NULL DEFAULT false,
  -- Preenchidos na confirmacao. pending: na fila do proximo lote.
  result         text CHECK (result IN ('pending', 'imported', 'skipped', 'failed')),
  result_reason  text CHECK (length(result_reason) <= 300),
  product_id     uuid REFERENCES products (id) ON DELETE SET NULL,
  processed_at   timestamptz,
  PRIMARY KEY (import_id, row_number)
);
CREATE INDEX product_import_rows_pending_idx ON product_import_rows (import_id, row_number) WHERE result = 'pending';

GRANT SELECT, INSERT, UPDATE ON product_imports, product_import_rows TO loja_app;
