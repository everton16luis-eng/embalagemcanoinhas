REVOKE UPDATE (route) ON bot_runs FROM loja_app;
ALTER TABLE bot_runs DROP COLUMN route;
DROP INDEX ai_calls_turn_idx;
ALTER TABLE ai_calls DROP COLUMN first_in_turn;
