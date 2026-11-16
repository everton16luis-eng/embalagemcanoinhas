-- SGLog Fase 1: depositos, saldo por deposito, referencia de abertura e conferencia do estoque
-- (docs/sglog-fase0-auditoria.md §5.1 e §10; docs/15-sglog-fase1.md).
-- Nada do que existe muda de comportamento: o saldo total (stock_balances) continua sendo o que a loja,
-- os marketplaces e os relatorios leem, e moveStock() continua sendo o unico caminho da aplicacao.
-- O livro (stock_movements) nao e reescrito: as linhas antigas ficam com warehouse_id nulo (= deposito padrao).

-- Bloqueios, todos antes de qualquer alteracao, sem nunca esperar um segurando outro (sem deadlock com vendas).
-- A aplicacao pode tocar users (FK), stock_movements (idempotencia) ou product_variants ANTES do saldo, e
-- grava o saldo antes do livro. Por isso: espera so o saldo (sem segurar nada); as demais tabelas vem com
-- NOWAIT; se alguma estiver ocupada, a subtransacao desfaz e solta tudo, espera 20 ms e tenta de novo.
-- Teto de 10 s: depois disso a migration desiste e nada muda. O saldo fica bloqueado para gravacao ate o COMMIT.
--   stock_balances    SHARE ROW EXCLUSIVE  retrato consistente + CREATE TRIGGER (leitura da loja continua)
--   stock_movements   ACCESS EXCLUSIVE     ADD COLUMN e CREATE TRIGGER
--   product_variants  SHARE ROW EXCLUSIVE  FKs novas (leitura continua)
--   users             ACCESS EXCLUSIVE     troca do CHECK de papeis
SET LOCAL lock_timeout = '10s';
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '10 seconds'; tries integer := 0; waited numeric;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE stock_balances IN SHARE ROW EXCLUSIVE MODE;
      LOCK TABLE stock_movements IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE product_variants IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE users IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF clock_timestamp() > deadline THEN
        RAISE EXCEPTION '0020: tabelas de estoque ocupadas por mais de 10 s (% tentativas); nada foi alterado, tente de novo', tries
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.02);
    END;
  END LOOP;
  waited := round(extract(epoch FROM clock_timestamp() - (deadline - interval '10 seconds')) * 1000);
  RAISE NOTICE '0020: bloqueios obtidos em % ms (% nova(s) tentativa(s))', waited, tries;
END $$;
SELECT set_config('sglog.t0', clock_timestamp()::text, true);

-- Depositos. A Fase 1 cria so o padrao, sem endereco (informado pelo painel na Fase 3; nada inventado).
CREATE TABLE warehouses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{2,20}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  cep         text CHECK (cep ~ '^[0-9]{8}$'),
  street      text CHECK (length(street) BETWEEN 2 AND 120),
  number      text CHECK (length(number) BETWEEN 1 AND 20),
  complement  text CHECK (length(complement) <= 60),
  district    text CHECK (length(district) BETWEEN 2 AND 60),
  city        text CHECK (length(city) BETWEEN 2 AND 60),
  uf          text CHECK (uf ~ '^[A-Z]{2}$'),
  is_default  boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warehouses_default_active CHECK (NOT is_default OR active)
);
CREATE UNIQUE INDEX warehouses_one_default ON warehouses ((true)) WHERE is_default;
INSERT INTO warehouses (code, name, is_default) VALUES ('PRINCIPAL', 'Depósito principal', true);

-- Saldo por deposito. So o gatilho do livro grava aqui; a aplicacao so le.
CREATE TABLE stock_location_balances (
  warehouse_id  uuid NOT NULL REFERENCES warehouses (id),
  variant_id    uuid NOT NULL REFERENCES product_variants (id),
  on_hand       numeric(14,3) NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved      numeric(14,3) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (warehouse_id, variant_id)
);
CREATE INDEX stock_location_balances_variant_idx ON stock_location_balances (variant_id);

-- Carga inicial: tudo o que existe esta no deposito padrao.
INSERT INTO stock_location_balances (warehouse_id, variant_id, on_hand, reserved)
SELECT (SELECT id FROM warehouses WHERE is_default), b.variant_id, b.on_hand, b.reserved FROM stock_balances b;

-- Coluna nova sem valor padrao: nao reescreve nem altera nenhuma linha antiga do livro.
ALTER TABLE stock_movements ADD COLUMN warehouse_id uuid REFERENCES warehouses (id);

-- Todo movimento novo (qualquer caminho, inclusive o codigo atual) aplica os mesmos deltas no saldo do deposito.
CREATE FUNCTION stock_movements_location() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE wh uuid := coalesce(NEW.warehouse_id, (SELECT id FROM warehouses WHERE is_default));
BEGIN
  IF wh IS NULL THEN
    RAISE EXCEPTION 'nenhum deposito padrao cadastrado' USING ERRCODE = 'restrict_violation';
  END IF;
  -- UPDATE antes do INSERT: num INSERT ... ON CONFLICT o CHECK (>= 0) vale para a linha proposta, e uma saida
  -- (delta negativo) seria recusada antes de chegar ao UPDATE. Sem disputa: moveStock ja bloqueou o saldo total
  -- da variante, entao so uma transacao por vez grava o deposito dela.
  UPDATE stock_location_balances
     SET on_hand = on_hand + NEW.on_hand_delta, reserved = reserved + NEW.reserved_delta, updated_at = now()
   WHERE warehouse_id = wh AND variant_id = NEW.variant_id;
  IF NOT FOUND THEN
    INSERT INTO stock_location_balances (warehouse_id, variant_id, on_hand, reserved)
    VALUES (wh, NEW.variant_id, NEW.on_hand_delta, NEW.reserved_delta);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER stock_movements_location AFTER INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION stock_movements_location();

-- Saldo total alterado pela aplicacao sem movimento correspondente: recusado no fim da transacao.
-- moveStock grava saldo e movimento na mesma transacao, entao a soma dos depositos sempre bate no COMMIT.
-- So vale para o papel da aplicacao (loja_app); manutencao como dono do banco fica de fora e e apontada
-- pela conferencia (stock_reconcile).
CREATE FUNCTION stock_balances_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cur record; loc record;
BEGIN
  IF session_user <> 'loja_app' THEN RETURN NULL; END IF;
  SELECT on_hand, reserved INTO cur FROM stock_balances WHERE variant_id = NEW.variant_id;
  SELECT coalesce(sum(on_hand), 0) AS on_hand, coalesce(sum(reserved), 0) AS reserved INTO loc
    FROM stock_location_balances WHERE variant_id = NEW.variant_id;
  IF cur.on_hand <> loc.on_hand OR cur.reserved <> loc.reserved THEN
    RAISE EXCEPTION 'saldo alterado sem movimento de estoque' USING ERRCODE = 'restrict_violation', CONSTRAINT = 'stock_balances_requires_movement';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER stock_balances_requires_movement AFTER INSERT OR UPDATE ON stock_balances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stock_balances_guard();

-- Referencia de abertura: retrato imutavel do saldo e do livro no inicio do SGLog. Nao cria nem altera
-- movimento. A diferenca entre saldo e soma do livro que ja existia fica registrada aqui uma vez
-- (diferenca herdada) e nao volta a aparecer como divergencia. So variantes com linha de saldo: as demais
-- conferem pela soma dos proprios movimentos (abertura implicita zero, verificacao C5).
CREATE TABLE stock_opening_balances (
  variant_id           uuid PRIMARY KEY REFERENCES product_variants (id),
  warehouse_id         uuid NOT NULL REFERENCES warehouses (id),
  on_hand              numeric(14,3) NOT NULL,
  reserved             numeric(14,3) NOT NULL,
  -- Maior id do livro no instante da abertura (o mesmo em todas as linhas). Nulo: livro vazio.
  last_movement_id     bigint,
  ledger_on_hand       numeric(14,3) NOT NULL,
  ledger_reserved      numeric(14,3) NOT NULL,
  reservations_active  numeric(14,3) NOT NULL,
  taken_at             timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER stock_opening_balances_immutable BEFORE UPDATE OR DELETE ON stock_opening_balances FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Registra a abertura. Uso unico; so o dono do banco executa (migracao e testes).
CREATE FUNCTION stock_opening_capture() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer; last_id bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM stock_opening_balances) THEN
    RAISE EXCEPTION 'a abertura do estoque ja foi registrada' USING ERRCODE = 'restrict_violation';
  END IF;
  -- Nenhum movimento entra enquanto o retrato e tirado: todo movimento grava o saldo total antes.
  LOCK TABLE stock_balances IN SHARE MODE;
  SELECT max(id) INTO last_id FROM stock_movements;
  INSERT INTO stock_opening_balances (variant_id, warehouse_id, on_hand, reserved, last_movement_id, ledger_on_hand, ledger_reserved, reservations_active)
  SELECT b.variant_id, (SELECT id FROM warehouses WHERE is_default), b.on_hand, b.reserved, last_id,
         coalesce(m.on_hand, 0), coalesce(m.reserved, 0), coalesce(r.qty, 0)
  FROM stock_balances b
  LEFT JOIN (SELECT variant_id, sum(on_hand_delta) AS on_hand, sum(reserved_delta) AS reserved
             FROM stock_movements WHERE id <= coalesce(last_id, 0) GROUP BY variant_id) m ON m.variant_id = b.variant_id
  LEFT JOIN (SELECT variant_id, sum(qty) AS qty FROM stock_reservations WHERE status = 'active' GROUP BY variant_id) r ON r.variant_id = b.variant_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION stock_opening_capture() FROM PUBLIC;
SELECT stock_opening_capture();

-- Conferencias do estoque. Cada execucao grava uma linha 'run' (expected = variantes conferidas,
-- found = divergencias) e uma linha por divergencia. Somente inclusao.
CREATE TABLE stock_reconciliations (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id      uuid NOT NULL,
  check_code  text NOT NULL CHECK (check_code IN ('run', 'C1', 'C2', 'C3', 'C4', 'C5')),
  field       text CHECK (field IN ('on_hand', 'reserved')),
  variant_id  uuid,
  expected    numeric(16,3) NOT NULL,
  found       numeric(16,3) NOT NULL,
  created_by  uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_reconciliations_shape CHECK ((check_code = 'run') = (field IS NULL AND variant_id IS NULL))
);
CREATE INDEX stock_reconciliations_run_idx ON stock_reconciliations (run_id);
CREATE INDEX stock_reconciliations_created_idx ON stock_reconciliations (created_at DESC);
CREATE TRIGGER stock_reconciliations_immutable BEFORE UPDATE OR DELETE ON stock_reconciliations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- C1 saldo = abertura + movimentos posteriores      C2 saldo total = soma dos depositos
-- C3 saldo = saldo resultante do ultimo movimento    C4 reservado = reservas ativas (+ diferenca herdada)
-- C5 variante sem abertura: saldo = soma de todos os seus movimentos
-- Uma unica instrucao: todas as tabelas sao lidas no mesmo instante. Nao corrige nada.
CREATE FUNCTION stock_reconcile() RETURNS SETOF stock_reconciliations LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_run uuid := gen_random_uuid();
BEGIN
  WITH o AS (SELECT * FROM stock_opening_balances),
  mv AS (
    SELECT m.variant_id, sum(m.on_hand_delta) AS d_on, sum(m.reserved_delta) AS d_res, max(m.id) AS last_id
    FROM stock_movements m LEFT JOIN o ON o.variant_id = m.variant_id
    WHERE o.variant_id IS NULL OR m.id > coalesce(o.last_movement_id, 0)
    GROUP BY m.variant_id
  ),
  loc AS (SELECT l.variant_id, sum(l.on_hand) AS on_hand, sum(l.reserved) AS reserved FROM stock_location_balances l GROUP BY l.variant_id),
  res AS (SELECT r.variant_id, sum(r.qty) AS qty FROM stock_reservations r WHERE r.status = 'active' GROUP BY r.variant_id),
  vars AS (
    SELECT b.variant_id FROM stock_balances b UNION SELECT mv.variant_id FROM mv
    UNION SELECT o.variant_id FROM o UNION SELECT loc.variant_id FROM loc UNION SELECT res.variant_id FROM res
  ),
  base AS (
    SELECT v.variant_id, o.variant_id IS NOT NULL AS has_open,
           coalesce(b.on_hand, 0) AS b_on, coalesce(b.reserved, 0) AS b_res,
           coalesce(o.on_hand, 0) + coalesce(mv.d_on, 0) AS exp_on, coalesce(o.reserved, 0) + coalesce(mv.d_res, 0) AS exp_res,
           coalesce(loc.on_hand, 0) AS l_on, coalesce(loc.reserved, 0) AS l_res,
           lm.on_hand_after, lm.reserved_after,
           coalesce(res.qty, 0) + coalesce(o.reserved - o.reservations_active, 0) AS exp_res_c4
    FROM vars v
    LEFT JOIN stock_balances b ON b.variant_id = v.variant_id
    LEFT JOIN o ON o.variant_id = v.variant_id
    LEFT JOIN mv ON mv.variant_id = v.variant_id
    LEFT JOIN stock_movements lm ON lm.id = mv.last_id
    LEFT JOIN loc ON loc.variant_id = v.variant_id
    LEFT JOIN res ON res.variant_id = v.variant_id
  ),
  divs AS (
    SELECT CASE WHEN has_open THEN 'C1' ELSE 'C5' END AS code, 'on_hand' AS field, variant_id, exp_on AS expected, b_on AS found FROM base WHERE exp_on <> b_on
    UNION ALL SELECT CASE WHEN has_open THEN 'C1' ELSE 'C5' END, 'reserved', variant_id, exp_res, b_res FROM base WHERE exp_res <> b_res
    UNION ALL SELECT 'C2', 'on_hand', variant_id, b_on, l_on FROM base WHERE b_on <> l_on
    UNION ALL SELECT 'C2', 'reserved', variant_id, b_res, l_res FROM base WHERE b_res <> l_res
    UNION ALL SELECT 'C3', 'on_hand', variant_id, on_hand_after, b_on FROM base WHERE on_hand_after IS NOT NULL AND on_hand_after <> b_on
    UNION ALL SELECT 'C3', 'reserved', variant_id, reserved_after, b_res FROM base WHERE reserved_after IS NOT NULL AND reserved_after <> b_res
    UNION ALL SELECT 'C4', 'reserved', variant_id, exp_res_c4, b_res FROM base WHERE exp_res_c4 <> b_res
  ),
  ins AS (
    INSERT INTO stock_reconciliations (run_id, check_code, field, variant_id, expected, found, created_by)
    SELECT v_run, d.code, d.field, d.variant_id, d.expected, d.found, app_user_id() FROM divs d
    RETURNING 1
  )
  INSERT INTO stock_reconciliations (run_id, check_code, expected, found, created_by)
  SELECT v_run, 'run', (SELECT count(*) FROM base), (SELECT count(*) FROM ins), app_user_id();

  RETURN QUERY SELECT * FROM stock_reconciliations WHERE run_id = v_run ORDER BY id;
END $$;
REVOKE ALL ON FUNCTION stock_reconcile() FROM PUBLIC;

-- Papeis novos (docs/sglog-fase0-auditoria.md §10.3.1): gerente de logistica, comprador e financeiro.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('owner', 'manager', 'sales', 'stock', 'fiscal', 'shipping', 'logistics', 'buyer', 'finance'));

GRANT SELECT ON warehouses, stock_location_balances, stock_opening_balances, stock_reconciliations TO loja_app;
GRANT EXECUTE ON FUNCTION stock_reconcile() TO loja_app;

-- Resumo para quem aplica (o migrador mostra os avisos): tempo com o saldo bloqueado e diferenca herdada.
DO $$
DECLARE ms numeric; n_open integer; n_diff integer;
BEGIN
  ms := round(extract(epoch FROM clock_timestamp() - current_setting('sglog.t0')::timestamptz) * 1000);
  SELECT count(*), count(*) FILTER (WHERE ledger_on_hand <> on_hand OR ledger_reserved <> reserved OR reservations_active <> reserved)
    INTO n_open, n_diff FROM stock_opening_balances;
  RAISE NOTICE '0020: saldo de estoque bloqueado por % ms (ate aqui; o bloqueio termina no COMMIT)', ms;
  RAISE NOTICE '0020: abertura com % variante(s); % com diferenca herdada entre saldo, livro e reservas', n_open, n_diff;
END $$;
