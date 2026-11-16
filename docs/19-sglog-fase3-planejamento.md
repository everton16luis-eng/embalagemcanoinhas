# SGLog — Fase 3: planejamento (estoque por depósito)

Data: 16/11/2026. **Situação: proposta para análise. Nada foi implementado.**

Base: [sglog-fase0-auditoria.md](sglog-fase0-auditoria.md) §3, §4 (R7–R10), §5.3, §5.11, §6.0 e §7, mais o que as Fases
1 e 2 deixaram no código (`0020`, `0021`, `lib/stock.ts`, `modules/stock.ts`, `modules/inventory.ts`).

## 1. Escopo previsto no plano geral

A Fase 3 depende só da Fase 1 e prepara a Fase 4 (motor de distribuição). Pelo plano (§7), ela entrega:

- `moveStock` com depósito e saldos separados (bloqueado, avariado, em trânsito);
- transferência entre depósitos, bloqueio, quarentena e estorno;
- inventário por depósito;
- mínimo e máximo por depósito, com alertas;
- conferência (`stock_reconcile`) cobrindo os saldos novos;
- telas, incluindo o cadastro de depósitos com endereço (adiado desde a Fase 1);
- o menu LOGÍSTICA, adiado na Fase 2 (D2-8).

Migração única: `0022_sglog_estoque` (§6.0). Permissões novas: `stock.transfer` e `stock.adjust` (MFA) (§5.11).

**Fora da Fase 3:**

| Fica para | O quê |
|---|---|
| Fase 4 | Reserva por alocação, `logistics_status`, escolha de depósito no pedido |
| Fase 6 | Recebimento de compra por depósito |
| Fase 9 | Devolução |

Checkout, pagamentos, fiscal, pedidos, marketplaces e vitrine não mudam.

## 2. O que já existe e será reaproveitado

| Peça atual | Uso na Fase 3 |
|---|---|
| `warehouses` (só `PRINCIPAL`, padrão, sem endereço) | Ganha cadastro pelo painel; `loja_app` passa a gravar |
| `stock_location_balances` (`on_hand`, `reserved`) mantida pelo gatilho `stock_movements_location` | Ganha os saldos novos; o mesmo gatilho aplica os deltas novos |
| `stock_movements.warehouse_id` (nulo = padrão) | Passa a ser gravado por `moveStock`; as linhas antigas não mudam (R7) |
| Trava `stock_balances_requires_movement` | Estendida aos saldos novos |
| `moveStock()`, o único caminho que altera saldo | Recebe `warehouseId` opcional; sem ele, continua no padrão. Os 4 chamadores atuais (ajuste, inventário, compra, importação) seguem iguais |
| `stock_reconcile()` (C1–C5) e `stock_reconciliations` | C1–C3 passam a cobrir os saldos novos; entram C6 e C7 (§3.4) |
| `inventory_counts` (uma aberta no sistema todo) | Uma aberta por depósito (R10) |
| `products.min_stock` + `stock-reports` + `/painel/reposicao` | Continua como mínimo geral; o mínimo do depósito vale onde existir |
| `requirePermission`, `MFA_REQUIRED`, `audit()` | Permissões novas e ações `stock.*` na auditoria |
| Telas `/painel/estoque` e `/painel/inventario`, `components/stock.tsx`, `ui.tsx` | Filtro e colunas por depósito, no mesmo visual |
| Padrão de bloqueios da 0020/0021 (`NOWAIT`, nova tentativa, teto de 10 s) e `migrate-rehearsal` | Mesma técnica e mesmo ensaio em cópia antes da produção |

## 3. Proposta técnica

### 3.1 Banco: `0022_sglog_estoque` (aditiva, uma transação)

**`stock_location_balances`.** Colunas novas:

- `blocked`, `damaged`, `in_transit`, todas `numeric(14,3)` ≥ 0 e com valor padrão 0;
- `bin` (localização no depósito, texto livre);
- `min_qty` e `max_qty`, anuláveis, com `max ≥ min`.

**`stock_balances`.** Recebe os mesmos 3 saldos, com padrão 0. Ver decisão D3-4.

- **Por que no total também:** a trava de saldo e a conferência C2 continuam simples (total = soma dos depósitos, saldo
  por saldo). O custo médio passa a ponderar todo o físico próprio (`on_hand + blocked + damaged + in_transit`), e não
  só o vendável.
- **Disponível para venda não muda:** continua `on_hand - reserved`. Vitrine, marketplaces, orçamentos, bot e
  relatórios não são tocados. Mercadoria bloqueada, avariada ou em trânsito sai de `on_hand` e, portanto, deixa de
  ser vendável, que é o efeito desejado.

**`stock_movements`.** Colunas novas:

- `blocked_delta`, `damaged_delta` e `in_transit_delta`, com padrão 0;
- `counter_warehouse_id` (o outro depósito numa transferência);
- `transfer_id` (uuid que liga as duas pernas de uma transferência);
- `document_ref` (texto);
- `reverses_id`, que referencia `stock_movements`, com índice único: cada movimento só pode ser estornado uma vez.

Os tipos de movimento novos (`kind`) são:

| Tipo | Efeito |
|---|---|
| `transfer_out` | Origem: `on_hand` −q. Destino: `in_transit` +q |
| `transfer_in` | Destino: `in_transit` −q e `on_hand` +q |
| `block` / `unblock` | `on_hand` ↔ `blocked` |
| `quarantine` / `release_quarantine` | `on_hand` ↔ `damaged` |
| `damage` | Continua como baixa (R9) |
| `reversal` | Deltas opostos aos do movimento estornado |

Os CHECKs novos são:

- o estorno exige `reverses_id` e motivo;
- a transferência exige `counter_warehouse_id` diferente do depósito e `transfer_id`;
- o bloqueio, a quarentena e o estorno exigem motivo.

As linhas antigas recebem padrão 0 nas colunas novas. Desde o PostgreSQL 11, isso é só metadado e não reescreve a
tabela. O CHECK de `kind` é trocado com `NOT VALID` e validado em seguida, sem alterar nenhuma linha.

**Demais tabelas.**

- **`stock_reservations.warehouse_id`:** anulável; nulo = padrão. Na Fase 3 nenhuma reserva nova escolhe depósito: o
  checkout continua reservando no padrão, e a escolha vem com a alocação na Fase 4.
- **`inventory_counts.warehouse_id`:** as contagens existentes são preenchidas com o padrão. O índice
  `inventory_counts_one_open` é trocado por um único índice por `warehouse_id`.
- **Privilégios:**
  - `warehouses`: `loja_app` ganha INSERT e UPDATE (sem DELETE; depósito se desativa);
  - `stock_location_balances`: `loja_app` ganha UPDATE só em `bin`, `min_qty` e `max_qty`, por GRANT de coluna;
  - os saldos continuam só por movimento.
- **Gatilho `stock_movements_location`:** aplica também os 3 deltas novos e, na transferência, a perna do outro
  depósito.
- **Trava de saldo:** compara os 5 saldos.

**`stock_reconcile()`** passa a cobrir os saldos novos (detalhe na §3.4).

**Volta atrás (`.down.sql`).**

- Remove só o que a 0022 criou.
- Se já houver movimento com os tipos novos, ou saldo bloqueado, avariado ou em trânsito diferente de zero, a volta
  **recusa** e explica. Apagar histórico para voltar não é opção.

### 3.2 API

**`lib/stock.ts`**

- `moveStock(db, actor, { …, warehouseId?, blockedDelta?, damagedDelta?, inTransitDelta?, counterWarehouseId?, transferId?, documentRef?, reversesId? })`.
- A ordem de bloqueio continua total → depósito, como hoje (R8).
- Saída maior que o saldo **do depósito** vira `INSUFFICIENT_STOCK`, com o depósito na mensagem. O erro 23514 que
  vem do gatilho passa a ser traduzido como o do total.
- Funções novas: `transferStock`, `blockStock`/`unblockStock`, `quarantineStock`/`releaseQuarantine` e
  `reverseMovement`.
  - Cada uma faz uma transação, com `request_key` para não duplicar no duplo clique, como o ajuste já faz.
- **Estorno:**
  - Só para movimentos manuais: `adjustment`, `loss`, `damage`, `inventory`, `block`/`unblock`, `quarantine`/`release_quarantine` e `transfer_*`.
  - Venda, reserva, liberação e recebimento de compra **não** se estornam por aqui: têm fluxo próprio (pedido;
    compra, na Fase 6).
  - Estornar uma perna de transferência estorna as duas. Se a mercadoria já chegou, o estorno devolve a mercadoria à
    origem.

**Rotas novas**, no mesmo prefixo de hoje:

| Rota | Permissão |
|---|---|
| `GET/POST/PUT /warehouses` | ver: `stock.view`; gravar: `settings.manage` (ver D3-5) |
| `POST /stock/transfers` (envia) e `POST /stock/transfers/:id/receive` (recebe, total ou parcial) | `stock.transfer` |
| `GET /stock/transfers?status=in_transit` | `stock.view` |
| `POST /stock/movements` com `kind` `block`, `unblock`, `quarantine` ou `release_quarantine` | `stock.manage` |
| `POST /stock/movements` com `adjustment`, `loss` ou `damage` | `stock.adjust` (ver D3-2) |
| `POST /stock/movements/:id/reverse` | `stock.adjust` |
| `PUT /stock/locations/:warehouseId/:variantId` (`bin`, `min_qty`, `max_qty`) | `stock.manage` |
| `GET /stock/alerts` (abaixo do mínimo ou acima do máximo, por depósito; paginado) | `stock.view` |

- **Leituras atuais:** `GET /stock` e `GET /stock/variants/:id` ganham o filtro `warehouseId` e o detalhe por depósito.
  Sem o filtro, a resposta continua igual à de hoje, então quem já usa não quebra.
- **Inventário:** `POST /inventory` recebe `warehouseId`, com o padrão quando omitido. O fechamento lança o movimento
  `inventory` no depósito da contagem.
- **Auditoria:** cada ação grava `audit()` (`stock.transfer`, `stock.block`, `stock.reverse`, `warehouse.update`…).

### 3.3 Painel

**Menu LOGÍSTICA (D2-8).** Agrupa telas já existentes:

- Estoque, Inventário, Compras, Reposição e Fornecedores;
- mais **Depósitos** e **Transferências**, que são novas.

As URLs atuais não mudam, só a posição no menu. O filtro por permissão em `shell.tsx` continua o mesmo.

**Telas novas e alteradas.**

- **Depósitos** (`/painel/depositos`): lista e ficha com código, nome, endereço, ativo e padrão.
  - Para desativar, todos os saldos do depósito precisam estar zerados.
  - Para trocar o padrão, é preciso confirmar.
- **Estoque:**
  - seletor de depósito ("Todos" = comportamento de hoje);
  - colunas Bloqueado, Avariado e Em trânsito, mostradas só quando houver valor;
  - na ficha da variante, uma tabela por depósito, com localização e mín/máx editáveis e os botões Transferir,
    Bloquear, Quarentena e Estornar.
  - Cada botão aparece só para quem tem a permissão; a recusa no servidor continua valendo.
- **Transferências:** em trânsito e recebidas, com o botão Receber.
- **Inventário:** a contagem nova pede o depósito. Com um depósito só, ele vem preenchido.
- **Reposição:** passa a mostrar os alertas por depósito ao lado da sugestão por giro.

**Celular.** Mesmo padrão das tabelas atuais. A conferência em 375 px entra nos testes da fase.

### 3.4 Conferência e testes

**Conferência (`stock_reconcile`).**

- C1–C3 passam a valer também para `blocked`, `damaged` e `in_transit`. A abertura vale 0 para eles: nasceram em zero
  na 0022.
- **C6:** cada `transfer_id` tem exatamente uma saída. A entrada é igual ou menor que a saída, e a diferença está em
  trânsito.
- **C7:** um estorno tem o mesmo depósito e a mesma variante que o original, com deltas opostos.
- Como hoje, a conferência não corrige nada.

**Testes (`sglog-fase3.test.ts`).** Cobrem, entre outros, os casos 6, 8, 16 e 17 da auditoria:

- transferência com e sem saldo na origem; recebimento parcial;
- duas transferências simultâneas da mesma variante, sem saldo negativo em nenhum depósito;
- bloqueio, quarentena e liberação; o disponível da vitrine cai e volta;
- estorno único (o segundo é recusado) e estorno de transferência;
- inventário aberto em dois depósitos ao mesmo tempo; um segundo no mesmo depósito é recusado;
- alertas de mínimo e máximo;
- tabela de 403 por papel em cada rota nova; MFA em `stock.adjust`;
- `loja_app` sem UPDATE de saldo direto e sem UPDATE/DELETE no livro;
- `stock_reconcile` com 0 divergência ao fim de todos os cenários;
- **regressão:** checkout, compra, importação e inventário antigos continuam lançando no padrão. A suíte inteira (361
  hoje) deve continuar verde.

**Implantação.** Mesmo roteiro das fases anteriores, executado por você:

1. relatório prévio, só leitura;
2. backup;
3. `migrate-rehearsal` com a 0022;
4. migração;
5. etapa F, ampliada aos saldos novos;
6. testes no navegador.

### 3.5 Entregas internas (commits locais na branch `sglog/fase3`)

1. 0022 + `lib/stock.ts` + conferência + testes de banco.
2. Depósitos (API + tela) e permissões novas.
3. Transferência, bloqueio, quarentena e estorno (API + telas).
4. Inventário por depósito, mín/máx, alertas e menu LOGÍSTICA.
5. Documentação (`20-sglog-fase3.md`), roteiro de implantação e ensaio local de carga e bloqueios, como na 0020.

## 4. Riscos

| Risco | Mitigação |
|---|---|
| ALTER em `stock_movements` e `stock_balances`, que a loja usa o tempo todo | Mesmo esquema de bloqueios da 0020 (`NOWAIT`, nova tentativa, teto de 10 s); colunas com padrão constante, sem reescrever a tabela; ensaio na cópia mede o tempo |
| O custo médio passa a ponderar todo o físico próprio | Muda o custo só em entradas futuras e só quando houver bloqueado, avariado ou em trânsito, que hoje não existem. Testado e documentado |
| Exigir MFA para ajuste pode travar quem lança ajuste hoje sem MFA | Decisão D3-2 antes de codificar |
| Reserva fica no padrão mesmo com mercadoria em outro depósito | Aceitável enquanto houver um depósito físico; a escolha vem na Fase 4. Se você cadastrar um segundo depósito com saldo, a separação ainda sai pelo padrão; a tela avisa |
| Volta da 0022 depois do uso | `.down.sql` recusa com saldo ou movimento novo; reversão por backup só com sua autorização |

## 5. Decisões que preciso de você antes de implementar

| # | Pergunta | Minha recomendação |
|---|---|---|
| D3-1 | A empresa tem hoje mais de um local físico (loja, galpão)? | Se não, a Fase 3 entrega a estrutura, mas o uso real fica no `PRINCIPAL`; o cadastro do endereço dele é o primeiro uso |
| D3-2 | `stock.adjust` (ajuste, perda, avaria, estorno) passa a exigir MFA? Quais papéis o recebem? | Sim, MFA. Recebem `owner`, `manager` e `logistics`. O papel `stock` perde o ajuste manual (mantém inventário, bloqueio e quarentena). Antes, conferir quem desses usuários já tem MFA ativo |
| D3-3 | Transferência em duas etapas (envia → em trânsito → recebe) ou imediata? | Duas etapas, com o botão "Receber agora" na mesma tela para transferência no mesmo prédio |
| D3-4 | Os saldos bloqueado, avariado e em trânsito também no total (`stock_balances`)? | Sim (motivos na §3.1) |
| D3-5 | Quem cadastra depósitos? | `settings.manage` (dono e gerente), porque endereço e depósito padrão afetam frete e fiscal nas próximas fases |
| D3-6 | Menu LOGÍSTICA agora, movendo Estoque, Inventário, Compras, Reposição e Fornecedores para dentro dele? | Sim, sem mudar as URLs |
| D3-7 | Alertas de mínimo e máximo: só no painel, ou também por e-mail/WhatsApp? | Só no painel nesta fase; aviso ativo depois, com a fila de integrações (Fase 8) |
