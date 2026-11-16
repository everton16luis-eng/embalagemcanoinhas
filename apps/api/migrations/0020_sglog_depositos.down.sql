-- Reverte a 0020 (SGLog Fase 1). Nao toca em nenhuma linha de stock_movements, stock_balances nem
-- stock_reservations: so remove o que a 0020 criou. O saldo por deposito e derivado do livro e se perde
-- (pode ser recalculado). Na Fase 1 nenhum codigo grava warehouse_id, entao a coluna removida so tem nulos.

SET LOCAL lock_timeout = '10s';

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

-- Mesma ordem de bloqueio da aplicacao: saldo total antes do livro.
LOCK TABLE stock_balances IN SHARE MODE;

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
