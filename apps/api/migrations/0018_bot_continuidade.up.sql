-- Continuidade da conversa do bot (docs/13-seguranca-ia-bot.md, secao 4.8).

-- Os limites diario e de rajada contam mensagens do cliente, nao chamadas a API: uma resposta do consultor faz ate
-- 4 chamadas (buscas + resposta). As linhas antigas ficam como primeira chamada (conta a mais, nunca a menos).
ALTER TABLE ai_calls ADD COLUMN first_in_turn boolean NOT NULL DEFAULT true;
CREATE INDEX ai_calls_turn_idx ON ai_calls (who_hash, created_at) WHERE first_in_turn;

-- Qual caminho respondeu cada mensagem (menu, ia, ia_falha, typebot, atendente...). Sem texto e sem telefone.
ALTER TABLE bot_runs ADD COLUMN route text CHECK (length(route) <= 40);
GRANT UPDATE (route) ON bot_runs TO loja_app;
