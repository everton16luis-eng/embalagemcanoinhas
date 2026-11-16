# SGLog Fase 1 — roteiro de implantação

Roteiro preparado em 16/11/2026, depois do envio ao GitHub (`cac8397..b5ff9f2`). **Nada aqui foi executado.**
Cada etapa termina num ponto de parada. Cole a saída na conversa e espere a resposta antes de seguir. A etapa A
(0019) e a etapa E (0020 em produção) só rodam com autorização expressa, cada uma separada.

Código auditado: `b5ff9f2`. Detalhes da fase, riscos e reversão da 0020: [15-sglog-fase1.md](15-sglog-fase1.md).

Onde rodar: no servidor, como o usuário da loja, na pasta do sistema.

```bash
sudo -u loja -H bash
```

```bash
cd /srv/loja-embalagens
```

O banco de produção é o cluster próprio da loja (porta 54330, `.local/pgdata`), e não o PostgreSQL do sistema. As
consultas abaixo usam o próprio `.env`, sem mostrar senha.

## Etapa 0 — Diagnóstico (só leitura)

Não altera nada. O `git fetch` só atualiza a cópia local das referências do GitHub.

```bash
git status -sb && git log -1 --format='em uso: %h %ci %s'
```

```bash
git fetch origin && git log --oneline HEAD..b5ff9f2
```

```bash
systemctl show loja-api loja-web -p Id -p ActiveState -p ActiveEnterTimestamp && curl -s http://127.0.0.1:4010/ready; echo
```

```bash
df -h /srv && du -sh .local/pgdata backups
```

Estado do banco, numa transação somente leitura:

```bash
node - <<'EOF'
process.loadEnvFile('.env');
const pg = require('pg');
const c = new pg.Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_OWNER_USER, password: process.env.DB_OWNER_PASSWORD, database: process.env.DB_NAME });
(async () => {
  await c.connect();
  await c.query('BEGIN READ ONLY');
  const q = async (s) => (await c.query(s)).rows;
  const show = (t, v) => console.log(t + ': ' + JSON.stringify(v));
  show('banco', (await q("SELECT current_database() AS banco, pg_size_pretty(pg_database_size(current_database())) AS tamanho"))[0]);
  show('ultimas migrations', await q("SELECT name, to_char(applied_at, 'YYYY-MM-DD HH24:MI') AS em FROM schema_migrations ORDER BY name DESC LIMIT 3"));
  show('estoque', (await q("SELECT (SELECT count(*) FROM product_variants)::int AS variantes, (SELECT count(*) FROM stock_balances)::int AS com_saldo, (SELECT count(*) FROM stock_movements)::int AS movimentos"))[0]);
  show('reservas ativas', (await q("SELECT count(*)::int AS n, coalesce(sum(qty), 0)::text AS qtd FROM stock_reservations WHERE status = 'active'"))[0]);
  show('pedidos por situacao', await q("SELECT status, count(*)::int AS n FROM orders GROUP BY 1 ORDER BY 1"));
  show('usuarios ativos por papel', await q("SELECT role, count(*)::int AS n FROM users WHERE is_active GROUP BY 1 ORDER BY 1"));
  show('previa da diferenca herdada', (await q(`SELECT count(*)::int AS variantes, coalesce(sum(abs(b.on_hand - coalesce(m.on_hand, 0))), 0)::text AS fisico
    FROM stock_balances b
    LEFT JOIN (SELECT variant_id, sum(on_hand_delta) AS on_hand, sum(reserved_delta) AS reserved FROM stock_movements GROUP BY 1) m USING (variant_id)
    LEFT JOIN (SELECT variant_id, sum(qty) AS qty FROM stock_reservations WHERE status = 'active' GROUP BY 1) r USING (variant_id)
    WHERE b.on_hand <> coalesce(m.on_hand, 0) OR b.reserved <> coalesce(m.reserved, 0) OR b.reserved <> coalesce(r.qty, 0)`))[0]);
  await c.query('ROLLBACK');
  await c.end();
})().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
EOF
```

**Parar e trazer a saída.** O que decide o caminho:

| Resultado | Próximo passo |
|---|---|
| `git status` com arquivo alterado no servidor, ou fora do ramo `main` | Parar: precisa de orientação antes de qualquer atualização |
| Pasta sem git (cópia) | Parar: o roteiro muda |
| Última migration `0019_importacao_produtos` | Etapa B |
| Última migration `0018_bot_continuidade` | Etapa A (0019 separada), só com autorização |
| Qualquer outra | Parar |
| Disco livre menor que 3× o tamanho de `.local/pgdata` | Parar: backup e cópia temporária não cabem com folga |

A "prévia da diferença herdada" é só uma estimativa: o número oficial sai do ensaio (etapa C).

## Etapa A — 0019 separada (só se a produção estiver na 0018, com autorização específica)

Leva o código até `cac8397`: o último commit antes do SGLog, que já tem a 0019 e a importação de produtos.
Esse commit **não** tem a 0020, então o `migrate` aplica só a 0019.

1. Ver exatamente o que entra:

   ```bash
   git log --oneline HEAD..cac8397
   ```

2. Backup e teste de restauração:

   ```bash
   npm run backup
   ```

   ```bash
   npm run backup:restore-test -- backups/<pasta nova>
   ```

3. Anotar a versão em uso e avançar só até `cac8397` (`--ff-only`: recusa se o histórico divergir):

   ```bash
   git rev-parse HEAD > ~/antes-0019.txt && git merge --ff-only cac8397 && npm ci
   ```

4. Aplicar a migration. A saída deve terminar em `up: 0019_importacao_produtos`, sem 0020:

   ```bash
   npm run migrate
   ```

5. Build e reinício:

   ```bash
   npm run build -w apps/api && npm run build -w apps/web
   ```

   Como administrador:

   ```bash
   sudo systemctl restart loja-api loja-web
   ```

6. Validar: `/ready`, painel, a tela **Produtos → Importar** abre e o modelo baixa (roteiro completo em
   [14-importacao-produtos.md](14-importacao-produtos.md)). Repetir a consulta da etapa 0.

   **Parar e trazer a saída.** Se algo falhar: `git checkout --detach $(cat ~/antes-0019.txt)`, `npm ci`, build e
   restart. Depois, para voltar a atualizar: `git checkout main`. A 0019 pode ficar, porque só acrescenta.

## Etapa B — Backup novo e teste de restauração em banco isolado

Feito logo antes do ensaio, para o ensaio usar dados atuais.

```bash
npm run backup
```

```bash
npm run backup:restore-test -- backups/<pasta nova>
```

O `restore-test` restaura num banco temporário (`loja_restore_xxxx`), compara com o manifesto e o apaga.
**Parar** se não terminar com tudo conferido.

## Etapa C — Ensaio da 0020 na cópia (não toca na produção)

O ensaio precisa do código `b5ff9f2`, mas a pasta em produção continua como está. Usa uma pasta de trabalho
separada (`git worktree`), que reaproveita os `node_modules`, o `.env` e as credenciais do cluster por link. Nada é
copiado nem alterado na pasta do sistema, e os serviços não são tocados.

```bash
git worktree add --detach /srv/loja/ensaio-sglog b5ff9f2
```

```bash
cd /srv/loja/ensaio-sglog && ln -s /srv/loja-embalagens/node_modules node_modules && ln -s /srv/loja-embalagens/.env .env && mkdir .local && ln -s /srv/loja-embalagens/.local/credentials.json .local/credentials.json && { [ ! -d /srv/loja-embalagens/apps/api/node_modules ] || ln -s /srv/loja-embalagens/apps/api/node_modules apps/api/node_modules; }
```

Rodar em horário de pouco movimento, porque a restauração usa disco e CPU do servidor:

```bash
node scripts/backup.mjs migrate-rehearsal /srv/loja-embalagens/backups/<pasta da etapa B>
```

O ensaio restaura a cópia em `loja_ensaio`, aplica a 0020 só nela, mostra os avisos e a diferença herdada, roda a
conferência e apaga `loja_ensaio`. Ele se recusa a rodar se `DB_NAME` for `loja_ensaio`.

Limpeza: remove só os links, sem barra no fim e sem `-r`, e depois a pasta de trabalho.

```bash
cd /srv/loja-embalagens && rm /srv/loja/ensaio-sglog/node_modules /srv/loja/ensaio-sglog/.env /srv/loja/ensaio-sglog/.local/credentials.json && { [ ! -L /srv/loja/ensaio-sglog/apps/api/node_modules ] || rm /srv/loja/ensaio-sglog/apps/api/node_modules; } && rmdir /srv/loja/ensaio-sglog/.local && git worktree remove /srv/loja/ensaio-sglog && git worktree list
```

## Etapa D — Resultados e ponto de parada obrigatório

Trazer a saída inteira do ensaio. Eu apresento:

- **Bloqueio**: `0020: bloqueios obtidos em X ms (N nova(s) tentativa(s))` e `saldo de estoque bloqueado por Y ms`;
- **Diferença herdada**: variantes, quantidade, valor a custo médio e até 20 SKUs;
- **Conferência**: variantes conferidas e divergências.

**Interromper** (nada é aplicado em produção) se qualquer um acontecer:

- o ensaio terminar com `FALHOU` ou erro;
- alguma contagem de tabela mudar;
- a conferência mostrar divergência;
- a cópia não estiver na 0019 antes do ensaio;
- o ensaio aplicar outra migration além da 0020;
- os bloqueios precisarem de mais de 1 s ou de mais de 50 tentativas;
- o saldo ficar bloqueado por mais de 2 s;
- a diferença herdada aparecer (qualquer valor acima de zero): ela é analisada antes, SKU por SKU, e você decide se
  aceita registrar como está ou se acerta antes por ajuste com movimento;
- o resultado diferir muito da prévia da etapa 0.

**Depois da etapa D: aguardar autorização expressa** para a etapa E.

## Etapa E — Aplicar a 0020 (só com autorização expressa)

Em horário de pouco movimento:

1. Backup do momento:

   ```bash
   npm run backup
   ```

   ```bash
   npm run backup:verify -- backups/<pasta nova>
   ```

2. Anotar a versão em uso e avançar exatamente até o commit auditado:

   ```bash
   git rev-parse HEAD > ~/antes-sglog-fase1.txt && git merge --ff-only b5ff9f2 && npm ci
   ```

3. Aplicar a migração. Guardar os 3 avisos `0020:`. Se aparecer `tabelas de estoque ocupadas`, nada mudou: repetir
   depois.

   ```bash
   npm run migrate
   ```

4. Build:

   ```bash
   npm run build -w apps/api && npm run build -w apps/web
   ```

5. Reinício. Como administrador:

   ```bash
   sudo systemctl restart loja-api loja-web
   ```

Entre os passos 3 e 5 a loja segue no ar com o código antigo, que funciona com a 0020 (provado na suíte e nos ensaios).

## Etapa F — Validação depois da 0020

```bash
curl -s http://127.0.0.1:4010/ready; echo; systemctl is-active loja-api loja-web; journalctl -u loja-api -n 30 --no-pager
```

Banco: última migration, depósito padrão, saldo total igual à soma por depósito, abertura e conferência. A conferência
grava uma linha de registro em `stock_reconciliations`; isso é o esperado.

```bash
node - <<'EOF'
process.loadEnvFile('.env');
const pg = require('pg');
const c = new pg.Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_OWNER_USER, password: process.env.DB_OWNER_PASSWORD, database: process.env.DB_NAME });
(async () => {
  await c.connect();
  const q = async (s) => (await c.query(s)).rows;
  const fail = [];
  const last = (await q('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1'))[0].name;
  console.log('ultima migration: ' + last);
  if (last !== '0020_sglog_depositos') fail.push('ultima migration nao e a 0020');
  const wh = await q('SELECT code, is_default, active FROM warehouses ORDER BY code');
  console.log('depositos: ' + JSON.stringify(wh));
  if (wh.length !== 1 || wh[0].code !== 'PRINCIPAL' || !wh[0].is_default) fail.push('deposito padrao diferente do esperado');
  const s = (await q('SELECT (SELECT coalesce(sum(on_hand), 0) FROM stock_balances)::text AS total, (SELECT coalesce(sum(on_hand), 0) FROM stock_location_balances)::text AS depositos, (SELECT coalesce(sum(reserved), 0) FROM stock_balances)::text AS reservado_total, (SELECT coalesce(sum(reserved), 0) FROM stock_location_balances)::text AS reservado_depositos'))[0];
  console.log('saldos: ' + JSON.stringify(s));
  if (s.total !== s.depositos || s.reservado_total !== s.reservado_depositos) fail.push('saldo total diferente da soma dos depositos');
  const o = (await q('SELECT count(*)::int AS variantes, count(*) FILTER (WHERE ledger_on_hand <> on_hand OR ledger_reserved <> reserved OR reservations_active <> reserved)::int AS com_diferenca_herdada, min(taken_at)::text AS em FROM stock_opening_balances'))[0];
  console.log('abertura: ' + JSON.stringify(o));
  const r = await q('SELECT check_code, field, variant_id, expected::text, found::text FROM stock_reconcile()');
  const run = r.find((x) => x.check_code === 'run');
  const divs = r.filter((x) => x.check_code !== 'run');
  console.log('conferencia: ' + Number(run.expected) + ' variante(s), ' + divs.length + ' divergencia(s)');
  for (const d of divs.slice(0, 20)) console.log('  ' + JSON.stringify(d));
  if (divs.length) fail.push(divs.length + ' divergencia(s) na conferencia');
  console.log(fail.length ? 'RESULTADO: PARAR - ' + fail.join('; ') : 'RESULTADO: OK');
  await c.end();
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
EOF
```

Depois, no navegador:

- loja: um produto no carrinho, com o estoque exibido;
- painel: estoque de um produto; um ajuste pequeno com motivo e o ajuste desfeito; repetir o bloco acima;
- um usuário de cada papel novo, conferindo as telas permitidas e as recusadas.

Se for preciso reverter a 0020, esses usuários precisam antes trocar de papel.

O número de variantes da abertura deve bater com o do ensaio, salvo produtos criados entre o ensaio e a etapa E.
Diferença herdada que não apareceu no ensaio: **parar** e trazer a saída.

## Reversão

Ver [15-sglog-fase1.md §Plano de reversão](15-sglog-fase1.md#plano-de-reversão). Resumo:

| Quando falhou | O que fazer |
|---|---|
| Etapas 0 a D | Nada a desfazer na produção. Se a pasta de trabalho do ensaio ficou, aplicar a limpeza da etapa C. |
| Erro no `migrate` (etapa E) | A transação desfaz sozinha. Voltar o código: `git checkout --detach $(cat ~/antes-sglog-fase1.txt)` e `npm ci`. |
| Erro de build ou de serviço | Voltar só o código (acima), build e restart. A 0020 pode ficar. |
| Problema da própria 0020 | `npm run migrate -- down` (backup antes), voltar o código, build e restart. |

Restaurar backup só em banco novo e só com sua autorização. Nunca restaurar por cima do banco original.
