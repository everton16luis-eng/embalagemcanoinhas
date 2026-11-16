# SGLog — Fase 1: depósitos, saldo por depósito, abertura e conferência

Escopo autorizado em 16/11/2026 (ver [sglog-fase0-auditoria.md](sglog-fase0-auditoria.md) §10). Feito e testado só em
ambiente local isolado. **Nada foi implantado nem migrado em produção.**

## O que mudou

| Item | Onde |
|---|---|
| Migration `0020_sglog_depositos` (up e down) | `apps/api/migrations/` |
| Papéis `logistics`, `buyer`, `finance` e permissões padrão | `apps/api/src/lib/permissions.ts`, `apps/web/src/lib/format.ts` |
| Marca de banco de testes gravada por `migrate:test`; avisos da migration na tela | `apps/api/src/db/migrate.ts` |
| Trava contra rodar testes fora do banco de testes | `apps/api/test/env-guard.ts`, `global-setup.ts`, `helpers.ts`, `vitest.config.ts` |
| Reset de demonstração preserva o depósito padrão | `apps/api/src/db/demo.ts` (`KEEP`) |
| Ensaio de migration numa cópia restaurada | `scripts/backup.mjs migrate-rehearsal`, `npm run backup:migrate-rehearsal` |
| Ensaio local com carga, deadlock e reversão (só no cluster local) | `scripts/ensaio-0020-local.mjs` |
| Testes da fase (17) | `apps/api/test/sglog-fase1.test.ts` |

Checkout, pagamentos, emissão fiscal, pedidos, marketplaces, vitrine e cadastro de produtos **não foram alterados**.
`moveStock()` continua sendo o único caminho da aplicação para mexer no saldo, e o saldo total (`stock_balances`)
continua sendo o que a loja, os marketplaces e os relatórios leem.

## Banco (0020)

- **`warehouses`**: tabela de depósitos. A migration cria só o `PRINCIPAL` ("Depósito principal"), padrão e ativo,
  **sem endereço**, porque o endereço será informado no painel na Fase 3 e nada é inventado aqui. Um índice único
  parcial garante um único depósito padrão.
- **`stock_location_balances`**: saldo por depósito, com `on_hand` e `reserved` ≥ 0. A carga inicial copia
  `stock_balances` inteiro para o depósito padrão, de modo que o saldo total não muda.
- **`stock_movements.warehouse_id`**: coluna nova e nula, sem valor padrão, para que nenhuma linha antiga do livro
  seja reescrita. Nulo significa depósito padrão. Na Fase 1 nenhum código grava essa coluna.
- **Gatilho `stock_movements_location`**: depois de cada movimento novo, vindo de qualquer caminho, aplica os mesmos
  deltas no saldo do depósito. O gatilho faz UPDATE e, se a linha ainda não existir, INSERT. Ele não usa
  `INSERT … ON CONFLICT`, porque nesse comando o CHECK ≥ 0 vale para a linha proposta e recusaria toda saída.
- **Trava de saldo sem movimento**: `stock_balances_requires_movement` é um gatilho de restrição adiado até o COMMIT.
  Se o papel `loja_app` terminar uma transação com o saldo total diferente da soma dos depósitos, a transação é
  recusada (erro `23001`, restrição `stock_balances_requires_movement`).
  - Como o depósito só muda por movimento, isso significa: **a aplicação não consegue mudar saldo sem gravar o
    movimento**.
  - Linha de saldo zerada, como o código cria hoje, e mudança de custo médio continuam permitidas.
  - O dono do banco (manutenção, seed de demonstração) não é bloqueado. O que ele fizer por fora aparece na conferência.
- **`stock_opening_balances`** é a referência de abertura, imutável. Guarda um retrato de cada variante com linha de
  saldo no instante da migration:
  - saldo e reservado;
  - soma do livro até `last_movement_id`;
  - reservas ativas.

  Ela não cria nem altera nenhum movimento. A diferença que já existia entre saldo e livro (a **diferença herdada**)
  fica registrada aqui uma única vez e não volta a aparecer como divergência. `stock_opening_capture()` é de uso
  único e só o dono executa.
- **`stock_reconciliations`** (imutável) e **`stock_reconcile()`**: a conferência roda numa única instrução, com
  todas as tabelas lidas no mesmo instante. Ela grava uma linha `run` (variantes conferidas e quantidade de
  divergências) e uma linha por divergência, e não corrige nada. O papel `loja_app` pode executá-la.

  | Código | Confere |
  |---|---|
  | C1 | saldo = abertura + movimentos posteriores à abertura |
  | C2 | saldo total = soma dos depósitos |
  | C3 | saldo = saldo resultante (`*_after`) do último movimento |
  | C4 | reservado = reservas ativas + diferença herdada de reserva |
  | C5 | variante sem abertura (sem linha de saldo na abertura, ou criada depois): saldo = soma de todos os seus movimentos |

- **Papéis**: o CHECK `users_role_check` passa a aceitar `logistics`, `buyer` e `finance`.
- **Privilégios**: `loja_app` só lê as 4 tabelas novas e executa `stock_reconcile()`. Não grava em nenhuma delas e
  não executa `stock_opening_capture()`.

**Bloqueios (sem deadlock).** A migration altera quatro tabelas que a aplicação usa: `stock_balances`,
`stock_movements` (coluna e gatilho), `product_variants` (FKs novas) e `users` (CHECK de papéis). A aplicação pode
tocar `users`, o livro ou as variantes **antes** do saldo. Exemplos:

- a idempotência do ajuste lê o livro antes do `moveStock`;
- pedidos e orçamentos gravam com FK para `users` antes de reservar.

Por isso a 0020 pega todos os bloqueios antes de alterar qualquer coisa, sem nunca esperar um lock segurando outro:

1. Espera só o saldo, sem segurar nada.
2. Pede as outras três tabelas com `NOWAIT`.
3. Se alguma estiver ocupada, a subtransação desfaz e solta tudo; a migration espera 20 ms e tenta de novo, com teto
   de 10 s. Passado o teto, ela desiste e nada muda.

A reversão usa a mesma técnica e só confere usuários e movimentos depois de ter os bloqueios.

A migration imprime três avisos:

- o tempo para obter os bloqueios e o número de novas tentativas;
- o tempo com o saldo bloqueado;
- o resultado da abertura (variantes e diferença herdada).

Durante a migration a loja continua lendo saldo e variantes; quem grava estoque espera até o COMMIT. Na reversão, até
a leitura espera (ACCESS EXCLUSIVE), por menos de 1 s.

## Papéis novos (menor privilégio)

| Papel | Rótulo | Permissões padrão |
|---|---|---|
| `logistics` | Gerente de logística | catalog.view, stock.view, stock.manage, purchases.view, orders.view, shipping.manage |
| `buyer` | Comprador | catalog.view, stock.view, purchases.view, purchases.manage |
| `finance` | Financeiro | orders.view, purchases.view, reports.view |

Os testes provam o efeito real:

- **Logística**: despacha, mas não muda a situação comercial, não cancela, não vê faturamento, fornecedores nem
  usuários.
- **Comprador**: cadastra fornecedor, faz pedido de compra e recebe mercadoria, mas não vê pedidos de clientes nem
  lança ajuste de estoque.
- **Financeiro**: vê pedidos e faturamento, mas não mexe em estoque, compras nem cancelamentos.

O proprietário cria os três papéis; o gerente continua sem poder criar proprietário; papel desconhecido é recusado (400).

## Travas dos testes

Os testes apagam tabelas. Antes de qualquer conexão ou limpeza, a suíte (no `globalSetup`) e o `resetCatalog`
recusam rodar quando:

1. o `.env` tem `NODE_ENV=production`;
2. `DB_NAME_TEST` está vazio, não termina em `_test`, é `loja_prod` ou é igual a `DB_NAME`;
3. o banco conectado não é o esperado;
4. o banco **não tem a marca de banco de testes**. A marca é o comentário que só `npm run migrate:test` grava, e esse
   comando recusa banco que não termina em `_test` ou que é igual a `DB_NAME`.

Assim, mesmo um banco de produção com outro nome, apontado por engano em `DB_NAME_TEST`, é recusado.

Quem já tem banco de testes local precisa rodar `npm run migrate:test` uma vez para gravar a marca.

**Limpeza e imutabilidade.** A limpeza dos testes usa `TRUNCATE … RESTART IDENTITY CASCADE`. O TRUNCATE não dispara
os gatilhos de linha `forbid_mutation`, então funciona com as tabelas imutáveis, e as chaves estrangeiras são
respeitadas pelo CASCADE e pela ordem da lista. `warehouses` não é apagada, para o depósito padrão continuar
existindo. Fora dos testes, ninguém apaga nem altera linha da abertura ou das conferências: o teste prova que o dono
recebe `23001` ao tentar. O `demo:reset` apaga tudo o que não é de proprietários por desenho (inclusive abertura e
conferências) e mantém o depósito padrão. Depois do reset, as variantes conferem por C5.

## Testes e resultados

| Verificação | Resultado |
|---|---|
| Suíte completa | **304/304** (21 arquivos): as 287 anteriores sem alteração + 17 novas |
| Typecheck api e web | sem erros |
| `loja_test`: up → down → up (várias vezes) | OK; bloqueio de 82 a 216 ms |
| `loja_test` com a versão final: down → up → down → up | OK; bloqueios em 1 ms, saldo bloqueado ~125 ms |
| `build` da API e `next build` da web com os 7 commits anteriores | OK |

Os testes novos cobrem:

- **Depósito padrão**: único, sem endereço; um segundo padrão é recusado.
- **Saldo por depósito**: entrada, perda, avaria, devolução, ajuste, reserva, liberação e baixa; pedido real
  (checkout, cartão de teste, preparo, despacho); 10 reservas simultâneas para 5 vagas; INSUFFICIENT_STOCK inalterado.
- **Saldo sem movimento**: UPDATE ou INSERT direto pelo `loja_app` recusado; manutenção pelo dono apontada como
  C2, C3 e C5 e gravada.
- **Privilégios**: `loja_app` recebe `42501` em toda gravação nas tabelas novas e na captura; as conferências são
  imutáveis até para o dono.
- **Abertura**: captura durante 24 operações simultâneas, consistente e sem criar movimento; segunda captura recusada.
  A diferença herdada não vira divergência. Variante sem linha de saldo na abertura e variante criada depois conferem
  por C5. Divergência nova gera C1 e C3; reserva mexida por fora gera C4.
- **Papéis**: os 3 papéis, com o efeito real das permissões nas rotas.
- **Travas do ambiente de testes**: unitárias e a marca do banco.

### Ensaios locais com dados realistas

Os ensaios rodaram num banco local `loja_semente`, que fica igual à produção antes da Fase 1: schema até a 0019 e o
seed de demonstração com 102 produtos, 213 variantes (9 sem linha de saldo), 449 pedidos, 3.012 movimentos e
**73 reservas ativas**. Entre os pedidos, **30 estavam em andamento** (aguardando pagamento, pago, em preparo,
pronto, enviado). Havia 7 usuários com 6 papéis existentes. O banco é apagado no fim de cada ensaio.

Para reproduzir: `node scripts/ensaio-0020-local.mjs create`, depois `deadlock up`, `load` etc. Ele só roda no
cluster local.

| Ensaio | Resultado (versão final da 0020) |
|---|---|
| `backup` + `migrate-rehearsal` (cópia restaurada) | 0020 em 821 ms; bloqueios em 1 ms; **saldo bloqueado 143 ms**; abertura de 204 variantes, **0 diferença herdada**; C1–C5: 0 divergência |
| Migration com 6 vendas simultâneas pelo `loja_app` | **1.674 vendas durante o ensaio, nenhuma falhou**; maior espera de uma venda 229 ms; saldo bloqueado 166 ms; 0 divergência depois |
| Deadlock: venda toca `users`, o livro ou variantes antes do saldo, durante a 0020 (up e down) | **6/6 sem deadlock**; venda espera 11 a 33 ms; migration conclui |
| Reversão com dados (down → up) | down 803 ms, up 869 ms; hash do livro, dos saldos e das reservas **idêntico**; 0 divergência |
| Reversão com usuário `buyer` | recusada; nada muda (0020 continua aplicada, abertura intacta) |
| Reservas ativas na abertura | reservado (13.127) = reservas ativas (13.127) nas 204 variantes |
| `demo:reset` e `demo:seed` com a 0020 | depósito padrão mantido; conferência sem divergência depois de cada um |
| Venda segurando o saldo por mais de 10 s | a migration desiste (`55P03`) e desfaz tudo; o banco fica na 0019 |

## Auditoria de prontidão (16/11/2026)

Feita antes de pedir a implantação.

**Falha encontrada e corrigida.** A primeira versão da 0020 bloqueava só o saldo no início e pegava `users`, o livro e
as variantes no meio da execução. O ensaio de deadlock reproduziu o problema nos 3 cenários: `deadlock detected`.
Nesses testes a vítima foi a migration, que desfez tudo. Com outro momento de chegada a vítima pode ser a venda, e o
cliente veria erro no checkout. A versão final usa a técnica de bloqueio descrita em
[Banco (0020)](#banco-0020): 6/6 cenários sem deadlock, mais carga, reversão e cópia restaurada refeitos.

Também conferido:

- **Commit sem segredo.** Nenhuma senha, token, chave, `.env`, `.local/`, dump ou backup no commit nem rastreado pelo
  git. A única senha nos testes é a de teste que já existia em `helpers.ts`.
- **Escritas no saldo.** Só `lib/stock.ts`, além da linha zerada do inventário. Nenhum processo da aplicação conecta
  como dono do banco. O papel da aplicação é fixo (`APP_DB_USER` = `loja_app` em `config.ts`), então a trava vale em
  produção. `loja_app` não tem TRUNCATE em nenhuma das 84 tabelas.
- **Transações.** O migrador aplica cada migration numa transação própria (`BEGIN`/`COMMIT`; `ROLLBACK` no erro), e
  o `SET LOCAL lock_timeout` vale. Com 0019 e 0020 pendentes, cada uma é atômica.
- **Trava dos testes de ponta a ponta.** O vitest foi rodado de verdade contra bancos descartáveis e abortou antes de
  qualquer teste nos 4 casos: banco `_test` sem marca, nome fora do padrão, `NODE_ENV=production`, `DB_NAME_TEST`
  igual a `DB_NAME`. Os bancos continuaram vazios. O `migrate:test` também recusou os dois casos de nome.
- **Compatibilidade.** Os 7 commits locais anteriores mexem só na web, na documentação e em `backup.mjs`, sem
  migration. A 0019 já está no GitHub. `build` da API e da web (`next build`) passam com tudo junto. O código antigo
  funciona com a 0020 aplicada, e o novo funciona sem ela (exceto os papéis novos), então a janela entre migrar e
  reiniciar é segura.

## Checklist de implantação (não executar sem autorização expressa)

Antes, no computador:

- [ ] Autorização para **enviar ao GitHub** os 11 commits locais (os 7 anteriores e os 4 do SGLog). O servidor
      atualiza por `git pull`.

No servidor, como `loja`, em `/srv/loja-embalagens`, em horário de pouco movimento:

1. [ ] Anotar a versão em uso, para a reversão: `git rev-parse HEAD > ~/antes-sglog-fase1.txt`.
2. [ ] Ver as migrations aplicadas:
       `sudo -u postgres psql -d loja_prod -Atc "SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 3"`.
       Se a última for a 0018, a 0019 (importação de produtos) também vai entrar nesta implantação. Ela já está no
       código publicado; ver [14-importacao-produtos.md](14-importacao-produtos.md).
3. [ ] `df -h /srv` com espaço para um backup e uma cópia temporária do banco.
4. [ ] `npm run backup` e `npm run backup:restore-test -- backups/<pasta nova>`.
5. [ ] `git pull` e `npm ci`.
6. [ ] `npm run backup:migrate-rehearsal -- backups/<pasta nova>`. **Parar** se:
       - houver divergência;
       - os bloqueios precisarem de muitas tentativas;
       - o saldo ficar bloqueado por mais de 2 s;
       - a diferença herdada listar SKUs que você não reconhece.
7. [ ] `npm run migrate`. Guardar os 3 avisos `0020:`. Se sair `tabelas de estoque ocupadas`, nada mudou: repetir.
8. [ ] `npm run build -w apps/api` e `npm run build -w apps/web`.
9. [ ] Como administrador: `sudo systemctl restart loja-api loja-web`.

## Checklist de validação depois da implantação

- [ ] `curl -s http://127.0.0.1:4010/ready` e `systemctl status loja-api loja-web` sem erro;
      `journalctl -u loja-api -n 50` sem erro novo.
- [ ] Migrations: `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1` dá `0020_sglog_depositos`.
- [ ] Conferência como dono do banco:
      `sudo -u postgres psql -d loja_prod -c "SELECT check_code, field, variant_id, expected, found FROM stock_reconcile()"`.
      Deve sair só a linha `run`, com `found = 0`.
- [ ] Depósito: `SELECT code, is_default FROM warehouses` dá só `PRINCIPAL | t`. Saldo total igual à soma por depósito:
      `SELECT (SELECT sum(on_hand) FROM stock_balances) = (SELECT sum(on_hand) FROM stock_location_balances)`.
- [ ] Loja: abrir um produto, pôr no carrinho, conferir o estoque exibido.
- [ ] Painel: estoque de um produto, um ajuste pequeno com motivo, e o ajuste desfeito; depois repetir a conferência.
- [ ] Um pedido de teste completo (pagamento de teste, preparo, despacho), se o provedor de teste estiver ativo.
- [ ] Criar um usuário de cada papel novo e conferir as telas permitidas e as recusadas. Para reverter a 0020 depois,
      esses usuários precisam trocar de papel ou ser desativados com outro papel.
- [ ] Marcar em [TESTES-PENDENTES.md](TESTES-PENDENTES.md).

## Plano de reversão

Decidir pelo que falhou:

| O que falhou | O que fazer |
|---|---|
| Ensaio (passo 6) | Nada a desfazer: o banco real não foi tocado. Voltar o código (`git checkout $(cat ~/antes-sglog-fase1.txt)` e `npm ci`) ou só não seguir. |
| `npm run migrate` deu erro | A transação desfez a migration com erro (as anteriores, se houver, ficam). Ler o erro; os serviços continuam no código antigo. Voltar o código como acima se não for continuar. |
| Build ou serviço com erro, com a 0020 aplicada | Voltar só o código: `git checkout $(cat ~/antes-sglog-fase1.txt)`, `npm ci`, build e restart. **A 0020 pode ficar**: o código antigo funciona com ela (a suíte e o ensaio rodaram assim). |
| Problema da própria 0020 (conferência com divergência nova, erro de estoque) | Reverter a 0020 (abaixo). |
| Dado perdido ou corrompido (não esperado: a 0020 não altera linha antiga) | Restauração do backup do passo 4 em **banco novo** e troca só com sua autorização ([BACKUP.md](BACKUP.md) §Restauração de verdade). Nunca restaurar por cima do banco original. |

### Reversão da 0020 (procedimento exato)

A reversão só remove o que a 0020 criou. Ela **não toca** em nenhuma linha de `stock_movements`, `stock_balances`
nem `stock_reservations`, como o ensaio provou pelo hash. Ela se recusa a rodar, sem mudar nada, se:

- algum usuário tiver papel `logistics`, `buyer` ou `finance`. Antes, troque o papel deles no painel.
- algum movimento tiver `warehouse_id` gravado. Isso não acontece na Fase 1.

Passos no servidor, como `loja`, com a 0020 sendo a **última** migration aplicada:

1. `npm run backup` e `npm run backup:verify -- backups/<pasta nova>`.
2. `npm run migrate -- down`. Isso reverte **só a última** migration; confira na saída `down: 0020_sglog_depositos`.
   Se sair `tabelas ocupadas`, nada mudou: repetir.
3. Voltar o código: `git checkout $(cat ~/antes-sglog-fase1.txt)`, `npm ci`,
   `npm run build -w apps/api && npm run build -w apps/web` e `sudo systemctl restart loja-api loja-web`.
4. Conferir `/ready`, o painel e o estoque de um produto.
   `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1` deve dar `0019_importacao_produtos`.

O `git checkout` de uma versão deixa o repositório sem ramo ("detached HEAD"). Para voltar a atualizar depois:
`git checkout main` e o roteiro normal.

O que se perde: o saldo por depósito (derivado do livro, recalculado ao reaplicar), a referência de abertura e o
histórico de conferências. Ao reaplicar a 0020, uma nova abertura é tirada.

## Riscos restantes

| Risco | Gravidade | Tratamento |
|---|---|---|
| Diferença herdada em produção ainda desconhecida | Média | O passo 6 mostra quantidade, valor e SKUs antes da migration real; você decide se aceita ou acerta antes, com movimento |
| Tempo de bloqueio em produção ainda não medido | Baixa | Local: 143 a 168 ms com 213 variantes. O passo 6 mede com o tamanho real; teto de 10 s com desistência limpa |
| Manutenção como dono do banco ainda muda saldo sem movimento | Baixa | Intencional (seed, manutenção); a conferência aponta (C1/C2/C3/C5) |
| A conferência não roda sozinha | Baixa | Na Fase 1 é manual; agendamento e tela ficam para fase seguinte |
| `next build` sobrescreve o `.next` com o `loja-web` no ar | Baixa (já existia) | Mesmo procedimento das implantações anteriores; o restart vem logo depois |
| Reversão bloqueia a leitura de saldo e variantes | Baixa | Menos de 1 s; só se a reversão for necessária |
| Bancos de testes locais antigos sem a marca | Baixa | A suíte se recusa até `npm run migrate:test`; comportamento esperado |
| TRUNCATE ignora os gatilhos de imutabilidade | Baixa (já existia) | Só o dono do banco pode; `loja_app` não tem TRUNCATE em nenhuma tabela |
| `loja_dev` local não migrado para a 0020 | Nenhuma em produção | Não migrei para não interferir na outra sessão de testes; `npm run migrate` quando quiser |
