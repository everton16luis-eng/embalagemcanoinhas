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

Ordem de bloqueio: a migration faz `LOCK TABLE stock_balances IN SHARE MODE` antes de tudo, na mesma ordem da
aplicação (saldo total antes do livro), por isso não há deadlock com vendas em andamento. O `lock_timeout` é de 10 s:
se não conseguir o bloqueio nesse prazo, a migration desiste e desfaz tudo. A migration imprime dois avisos: o tempo
de bloqueio até ali e o resultado da abertura (variantes e diferença herdada).

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

### Ensaio local com dados realistas

O ensaio foi feito num banco local `loja_semente`, que fica igual à produção antes da Fase 1: schema até a 0019 e o
seed de demonstração com 102 produtos, 213 variantes, 449 pedidos e 3.012 movimentos. Depois o banco foi apagado.

| Ensaio | Resultado |
|---|---|
| `backup` + `migrate-rehearsal` (cópia restaurada) | 0020 em 740 ms; **saldo bloqueado 140 ms**; abertura de 204 variantes, **0 diferença herdada**; C1–C5: 0 divergência |
| Migration com 6 vendas simultâneas pelo `loja_app` | 999 ms; bloqueio de 120 a 167 ms; **maior espera de uma venda: 159 a 209 ms**; 1.693 a 1.895 vendas durante o ensaio, nenhuma falhou; 0 divergência depois |
| Reversão com dados (down → up) | down 499 ms, up 580 ms; hash do livro, dos saldos e das reservas **idêntico** antes, depois do down e depois do up; 0 divergência |
| `demo:reset` e `demo:seed` com a 0020 | depósito padrão mantido; conferência sem divergência depois de cada um |
| Venda segurando o bloqueio por mais de 10 s | a migration desistiu (`55P03 lock_not_available`) e desfez tudo; o banco ficou na 0019 |

O último caso aconteceu por um defeito do primeiro script de ensaio, que congelava a venda no meio da transação. Ele
prova a saída segura: a migration nunca fica pendurada segurando as vendas.

As 9 variantes sem linha de saldo no seed ficaram fora da abertura e conferem por C5.

## Reversão (procedimento exato)

A reversão só remove o que a 0020 criou. Ela **não toca** em nenhuma linha de `stock_movements`, `stock_balances`
nem `stock_reservations`, como o ensaio provou pelo hash. Ela se recusa a rodar se:

- algum usuário tiver papel `logistics`, `buyer` ou `finance`. Antes, troque o papel deles no painel.
- algum movimento tiver `warehouse_id` gravado. Isso não acontece na Fase 1.

Passos no servidor, como `loja`, com a 0020 sendo a última migration aplicada:

1. `npm run backup` e `npm run backup:verify -- backups/<pasta nova>`.
2. Voltar o código para a versão anterior à Fase 1 (o commit antes desta fase). O código da Fase 1 funciona sem a 0020,
   exceto os papéis novos, mas o esperado é voltar os dois juntos.
3. `npm run migrate -- down`. Isso reverte **só a última** migration; confira na saída que foi
   `down: 0020_sglog_depositos`.
4. `npm run build -w apps/api && npm run build -w apps/web` e `sudo systemctl restart loja-api loja-web`.
5. Conferir `/ready`, o painel e o estoque de um produto.

O que se perde: o saldo por depósito (é derivado do livro e pode ser recalculado), a referência de abertura e o
histórico de conferências. Ao reaplicar a 0020, uma nova abertura é tirada.

## Implantação (não executada — aguarda autorização expressa)

Pré-condições:

- conferir no servidor que a última migration aplicada é a `0019_importacao_produtos`, consultando
  `schema_migrations`;
- espaço em disco para um backup e uma cópia temporária.

1. `npm run backup` e `npm run backup:restore-test -- backups/<pasta nova>`.
2. `git pull` e `npm ci`.
3. **Ensaio na cópia do servidor**: `npm run backup:migrate-rehearsal -- backups/<pasta nova>`. Ele restaura num banco
   temporário (`loja_ensaio`), aplica a 0020 nele, mostra o tempo de bloqueio, a diferença herdada (quantidade,
   valor pelo custo médio, até 20 SKUs) e a conferência, e apaga o banco temporário. Ele usa `RESTORE_ADMIN_USER` e
   `RESTORE_ADMIN_PASSWORD`, como o `restore-test`. **Não continuar se der divergência ou se o bloqueio passar de 2 s.**
   Se houver diferença herdada, avaliar antes os SKUs listados.
4. `npm run migrate` em horário de pouco movimento. Guardar os dois avisos `0020:` da saída.
5. `npm run build -w apps/api && npm run build -w apps/web` e `sudo systemctl restart loja-api loja-web`.
6. Conferir:
   - `/ready`;
   - o painel;
   - um pedido de teste;
   - como dono do banco: `SELECT check_code, field, variant_id, expected, found FROM stock_reconcile();`. Deve
     sair só a linha `run`, com `found = 0`.

## Riscos restantes

- **Manutenção como dono do banco** continua podendo mudar saldo sem movimento. A trava vale só para o `loja_app`;
  nesse caso a conferência aponta (C1/C2/C3/C5), mas não impede. É intencional, para não quebrar manutenção e seed.
- **A conferência não roda sozinha.** Na Fase 1 ela é executada à mão (ou pelos testes). Agendamento e tela ficam para
  uma fase seguinte.
- **Bloqueio durante a migration.** No ensaio local ficou em 120 a 167 ms, com 213 variantes. Em produção depende do
  tamanho real, que será medido pelo `migrate-rehearsal` no servidor. O teto é de 10 s, e aí ela desiste sozinha.
- **Diferença herdada em produção** ainda não é conhecida: o ensaio no servidor (passo 3) mostra a lista antes da
  migration real.
- **Bancos de testes locais antigos** sem a marca fazem a suíte se recusar a rodar até `npm run migrate:test`. É o
  comportamento esperado.
- **`loja_dev` local** não foi migrado para a 0020 nesta fase, para não interferir com a outra sessão de testes.
  Rode `npm run migrate` quando quiser.
- **TRUNCATE ignora os gatilhos de imutabilidade.** Isso já valia para as tabelas imutáveis anteriores. Só o dono do
  banco pode executar TRUNCATE; o `loja_app` não pode.
