-- Reverte a 0020 (SGLog Fase 1). Nao toca em nenhuma linha de stock_movements, stock_balances nem
-- stock_reservations: so remove o que a 0020 criou. O saldo por deposito e derivado do livro e se perde
-- (pode ser recalculado). Na Fase 1 nenhum codigo grava warehouse_id, entao a coluna removida so tem nulos.

SET LOCAL lock_timeout = '10s';

-- Bloqueios antes de tudo, sem esperar um segurando outro (mesma tecnica da 0020 up: espera so o saldo,
-- as demais com NOWAIT; ocupada, solta tudo e tenta de novo em 20 ms; teto de 10 s). DROP TRIGGER, DROP COLUMN
-- e a remocao das FKs exigem ACCESS EXCLUSIVE: a loja fica sem ler saldo e variantes durante a reversao (< 1 s).
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '10 seconds'; tries integer := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE stock_balances IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE stock_movements IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE product_variants IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE users IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF clock_timestamp() > deadline THEN
        RAISE EXCEPTION 'Reversao da 0020: tabelas ocupadas por mais de 10 s (% tentativas); nada foi alterado, tente de novo', tries
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.02);
    END;
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE role IN ('logistics', 'buyer', 'finance')) THEN
    RAISE EXCEPTION 'Reversao da 0020 recusada: existem usuarios com papel logistics, buyer ou finance. Troque o papel deles antes.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_movements WHERE warehouse_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Reversao da 0020 recusada: ha movimentos de estoque gravados com deposito; a reversao apagaria essa informacao.'
      USING ERRCODE = 'restrict_violation';
  END IF;
END $$;


ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'manager', 'sales', 'stock', 'fiscal', 'shipping'));

DROP TRIGGER stock_balances_requires_movement ON stock_balances;
DROP TRIGGER stock_movements_location ON stock_movements;
DROP FUNCTION stock_reconcile();
DROP FUNCTION stock_opening_capture();
DROP FUNCTION stock_balances_guard();
DROP FUNCTION stock_movements_location();
DROP TABLE stock_reconciliations;
DROP TABLE stock_opening_balances;
DROP TABLE stock_location_balances;
ALTER TABLE stock_movements DROP COLUMN warehouse_id;
DROP TABLE warehouses;
