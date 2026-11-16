# SGLog — Fase 4: planejamento (alocação de estoque nos pedidos)

Data: 16/11/2026. **Situação: proposta para análise. Nada foi implementado.**

Base:

- [sglog-fase0-auditoria.md](sglog-fase0-auditoria.md): D1–D4, §3 (itens 3, 4 e 6), §4 (R2–R6, R13), §5.4, §5.11, §6.1
  e §7, mais os 18 casos da §8;
- o que as Fases 1 a 3 deixaram no código: `0020`–`0022`, `lib/stock.ts`, `lib/supplier-choice.ts`,
  `modules/orders.ts`, `modules/marketplaces.ts`, `modules/quotes.ts`.

## 1. Escopo previsto no plano geral e o que você priorizou

### 1.1 O plano geral (§7)

| Fase | Entrega prevista |
|---|---|
| **4** | Motor de distribuição (`lib/allocation.ts`, puro e com testes unitários), `orders.logistics_status`, atendimentos e alocações, tela de comparação e confirmação, troca de origem com justificativa, trava de dropshipping (D3). Migração `0023_sglog_distribuicao` |
| 5 | Gancho no pagamento, **reservas por alocação**, remessas múltiplas, **cancelamento parcial e total**, projeção para `orders.status`, página do cliente por remessa, Playwright |
| 9 | Ocorrências e **devoluções** |

Pelo plano, a Fase 4 só decide e registra. Quem mexe nas reservas e no despacho é a Fase 5.

### 1.2 Suas prioridades contra o plano

| # | Prioridade | No plano | Proposta |
|---|---|---|---|
| 1 | Alocação por depósito | Fase 4 | Fase 4 |
| 2 | Estoque próprio × fornecedor | Fase 4 (motor) | Fase 4. Encomenda ao fornecedor liberada; dropshipping modelado e travado (D3) |
| 3 | Pedido com várias origens | Fases 4 e 5 | Fase 4 registra e reserva várias origens. **Despachar de vários lugares** depende de remessas múltiplas (Fase 5) |
| 4 | Reservas corretas | Fase 5 | **Trazer para a Fase 4.** Alocar sem mover a reserva deixaria a decisão só no papel e a reserva no lugar errado |
| 5 | Preservar checkout, pagamento, pedido, NF-e e marketplaces | todas | Nenhum desses fluxos muda de contrato (§5) |
| 6 | Falta, cancelamento e devolução | Fases 5 e 9 | Falta e cancelamento (total e da alocação) na Fase 4. Cancelamento parcial com estorno e devolução ficam fora (D4-9, D4-10) |
| 7 | Rastreabilidade | Fase 4 | Fase 4: registro imutável de cada decisão, com a entrada e a saída do motor |

**Resumo:** a Fase 4 proposta é o plano original **mais** a reserva por alocação, o cancelamento da alocação e o
tratamento de falta. As remessas múltiplas continuam na Fase 5, e a devolução continua na Fase 9 (D4-1).

## 2. O que já existe e será reaproveitado

| Peça | De onde | Uso na Fase 4 |
|---|---|---|
| `warehouses`, `stock_location_balances` com 5 saldos | Fases 1 e 3 | Saldo livre por depósito, que é a entrada do motor |
| `moveStock()` com `warehouseId` | Fase 3 | Reserva, liberação e baixa passam a informar o depósito |
| `reserve` / `releaseReservation` / `consumeReservation` | 0004 | Ganham depósito e alocação; a regra de concorrência (linha da variante travada) não muda |
| `stock_reservations` (origem única enquanto ativa) | 0004 | Ganha `warehouse_id` e `allocation_id`; a unicidade passa a incluir a alocação |
| `stock_reconcile()` C1–C7 | Fases 1 e 3 | Ganha C8 (reservado por depósito) e C9 (alocação × reserva) |
| `chooseSupplier()` com contexto `fulfillment` | Fase 2 (RT9) | Escolha do fornecedor por item, sem reescrever |
| `supplier_offer_terms`, disponibilidade com validade, `dropship_enabled` / `dropship_allowed` | Fase 2 | Entradas do motor; o dropshipping continua só cadastro até a trava ser liberada |
| `purchase_orders` e recebimento | 0007 | Encomenda ao fornecedor pode apontar para um pedido de compra |
| Transferência em duas etapas | Fase 3 | Resolve a falta num depósito trazendo de outro |
| `insertOrder`, `applyPayment`, `/cancel`, `/dispatch` | 0005 | Pontos de ligação; o contrato de cada um continua igual (§5) |
| `audit()`, `order_events`, `forbid_mutation`, `version` | todas | Rastreabilidade e edição concorrente |
| Padrão de travas da 0020–0022 e `migrate-rehearsal` | Fases 1–3 | Mesma técnica e mesmo ensaio em cópia |
| Rotinas com `SKIP LOCKED` em lote (`expireReservations`) | 0004 | Alocação automática fora da transação do pagamento |

## 3. Regras de negócio

### 3.1 Conceitos

- **Atendimento** (`fulfillment`): uma origem para parte do pedido. Pode ser um depósito próprio ou um fornecedor.
- **Alocação**: item do pedido × atendimento × quantidade em unidade base.
- **Modos de fornecedor:**
  - **encomenda**: o fornecedor entrega no **nosso** depósito, e nós despachamos. Fiscalmente é compra e depois
    venda, como hoje, sem nada novo.
  - **dropshipping**: o fornecedor despacha direto ao cliente. Fica **travado** até o contador validar (D3).
- **Situação logística** (`orders.logistics_status`, D1), separada de `orders.status`, que não muda:

| Situação | Quando |
|---|---|
| nula | Pedido aguardando pagamento ou cancelado antes de pagar |
| `awaiting` | Pago, ainda sem alocação |
| `analysis` | Precisa de decisão humana: falta, divisão, fornecedor, disponibilidade vencida ou falta descoberta depois |
| `processing` | Alocação confirmada e reservas no lugar |
| `shipped` / `completed` | Projetadas do despacho e da entrega atuais |
| `canceled` | Pedido cancelado |
| `partially_shipped` / `partially_delivered` | Reservadas para a Fase 5 (remessas múltiplas); a Fase 4 não as usa |

### 3.2 Regras

1. **Checkout não muda.** O pedido continua reservando o pedido inteiro no depósito padrão no momento da compra, com
   as mesmas recusas (`INSUFFICIENT_STOCK`) e o mesmo `backorder` dos produtos sob encomenda.
2. **Aloca-se só pedido pago.** Pedido aguardando pagamento fica como hoje. O cancelamento por prazo vencido libera
   as reservas como hoje.
3. **O pagamento não roda o motor.** A transação do pagamento só grava `logistics_status = 'awaiting'`. Uma rotina
   em lote, depois, faz a alocação automática. Um erro do motor nunca desfaz um pagamento (D4-3).
4. **Estoque próprio antes de fornecedor** (D2). O motor nunca troca estoque livre por fornecedor sozinho.
5. **Automático só no caso simples** (D4-3): um depósito ativo cobre o pedido inteiro, sem fornecedor e sem
   disponibilidade vencida. Qualquer outro caso vai para `analysis` e espera uma pessoa.
6. **Um depósito próprio por pedido nesta fase** (D4-4). Se nenhum depósito cobre tudo, o motor propõe:
   - transferir para o que tem mais;
   - completar com encomenda ao fornecedor;
   - ou as duas coisas.
   
   A divisão entre dois depósitos próprios, com duas remessas, vem com a Fase 5.
7. **Troca da reserva sem janela.** Confirmar uma alocação libera a reserva do pedido e cria as reservas por
   alocação **na mesma transação**, com a variante travada. Nenhuma outra venda enxerga a unidade solta no meio.
   - Quando o depósito não muda (o caso comum), a reserva é **reaproveitada no lugar**: ganha `allocation_id`, sem
     movimento novo no livro.
8. **Encomenda ao fornecedor** reserva com `backorder` no **depósito de destino**, como o sob encomenda faz hoje.
   - A mercadoria que chegar pela compra já está reservada para o pedido e não é vendida a outro cliente.
   - O despacho só baixa quando o físico existir (regra atual de `consumeReservation`).
   - Até a Fase 6, o recebimento de compra entra só no depósito padrão. Por isso o destino da encomenda é o padrão
     nesta fase.
9. **Dropshipping travado** (D3) por `logistics_settings.dropship_status = 'blocked'`.
   - O motor mostra a opção como "indisponível: aguarda validação fiscal".
   - A API recusa confirmar com `DROPSHIP_BLOCKED`.
   - Liberar exige `settings.manage` com MFA e o nome de quem validou (CHECK no banco).
10. **Disponibilidade vencida** nunca entra no automático. Ela aparece marcada e exige confirmação com justificativa.
11. **Teto por item.** A soma das alocações ativas de um item nunca passa de `packs × base_qty_per_pack` (gatilho).
12. **Alteração com justificativa.** Trocar a origem ou cancelar uma alocação exige motivo. A decisão anterior fica no
    histórico, e as reservas são trocadas na mesma transação (regra 7).
13. **Falta descoberta depois** (inventário, perda ou avaria que deixa reserva descoberta):
    - o pedido volta para `analysis` com o motivo;
    - nada é cancelado sozinho;
    - a fila de alocação mostra o pedido no topo.
14. **Cancelamento total** (rota atual, marketplace ou prazo vencido) libera **todas** as reservas do pedido, de
    qualquer depósito. Atendimentos e alocações passam para `canceled`, e a situação logística também.
15. **Despacho** (rota atual, uma remessa por pedido):
    - consome cada reserva no depósito dela;
    - pedido novo só despacha com alocação confirmada (D4-7);
    - a regra "só com NF-e autorizada" não muda.
16. **Marketplaces** (D4, D4-13): o pedido entra pago e passa pela mesma alocação, só com estoque próprio. Frete e
    etiqueta continuam com o marketplace.
17. **Vitrine, marketplaces, orçamentos, bot e relatórios** continuam lendo o total `on_hand − reserved` de
    `stock_balances`, sem mudança (D2).
    - A alocação resolve a ressalva da Fase 3: a mercadoria em outro depósito passa a poder atender a venda, levada
      pela alocação ou por transferência.
18. **Histórico imutável.** Toda decisão (automática, manual, troca ou cancelamento) grava uma linha em
    `allocation_decisions`, que o `loja_app` não altera nem apaga.

## 4. Proposta técnica

### 4.1 Motor: `lib/allocation.ts` (puro, sem banco)

`allocate(order, stock, offers, settings) → { proposal, alternatives, excluded, automatic, reasons }`

**Entrada:**

- itens do pedido, com a necessidade em unidade base;
- saldo **livre** por depósito ativo (`on_hand − reserved`), devolvendo a reserva do próprio pedido para não se
  contar como concorrente;
- ofertas por variante (`supplier_offer_terms`);
- trava de dropshipping;
- versão do motor.

**Passos:**

1. **Depósito único que cobre tudo.** Ordem: depósito padrão, depois `warehouses.allocation_priority` (D4-6), depois o
   código.
2. **Sem depósito único.**
   - Sugere o depósito com maior cobertura, mais transferência do que falta, se outro depósito tiver.
   - Para o que ainda faltar, sugere encomenda pelo `chooseSupplier` (contexto `purchase`, com prazo).
3. **Dropshipping.** Só aparece com a trava liberada, `dropship_allowed` e disponibilidade vigente (contexto
   `fulfillment`, já existente).
4. **Saída.** Cada opção vem com custo (custo médio do próprio, custo da oferta), prazo, excedente e motivos legíveis.
   `automatic = true` só no caso da regra 5.

O motor é testado por tabela de casos, como `supplier-choice.test.ts`. A saída é guardada inteira no histórico.

### 4.2 Banco: `0023_sglog_distribuicao` (aditiva, uma transação)

```
orders + logistics_status text NULL CHECK (8 estados de §3.1)        -- D1
warehouses + allocation_priority int NOT NULL DEFAULT 100            -- D4-6

logistics_settings (linha única)                                     -- D3
  dropship_status ('blocked','enabled') DEFAULT 'blocked',
  fiscal_validator_name, validated_by, validated_at, version
  CHECK: 'enabled' exige validador, autor e data

fulfillments
  id, order_id, source_kind ('own','supplier'), mode ('stock','purchase_to_order','dropship'),
  warehouse_id NULL, supplier_id NULL, purchase_order_id NULL,
  status ('proposed','confirmed','done','canceled'),
  origin_snapshot jsonb, created_by, confirmed_by, confirmed_at, canceled_reason, version
  CHECK coerência origem × modo × warehouse/supplier

fulfillment_allocations
  id, fulfillment_id, order_item_id, variant_id, base_qty > 0,
  warehouse_id (destino da reserva), supplier_product_id NULL,
  unit_cost_cents numeric(16,4) (cópia), status ('active','canceled'), created_by, created_at
  gatilho: soma ativa por item ≤ packs × base_qty_per_pack

allocation_decisions (imutável, forbid_mutation)
  id bigint, order_id, kind ('auto','manual','change','cancel','shortage','order_canceled'),
  engine_version, input jsonb, output jsonb, chosen jsonb, justification, actor_id, created_at

stock_reservations + warehouse_id NULL (nulo = padrão, como no livro) + allocation_id NULL
  unicidade ativa: (source_type, source_id, variant_id, coalesce(allocation_id))
  linhas ativas atuais: warehouse_id = padrão (preenchido na migração)

stock_reconcile():
  C8 reservado por depósito = soma das reservas ativas daquele depósito
  C9 alocação própria ativa ⇔ reserva ativa da mesma quantidade
```

- **Pedidos existentes** (D4-8): `paid`, `preparing` e `ready` recebem `awaiting`; `shipped` recebe `shipped`;
  `delivered` recebe `completed`; `canceled` recebe `canceled`. `pending_payment` fica nulo. `status` não muda.
- **Travas.** O mesmo padrão da 0020–0022: espera `stock_balances`, `NOWAIT` com nova tentativa a cada 20 ms e teto
  de 10 s. Desta vez `orders` também é travada, para a coluna nova e o preenchimento. O ensaio mede o tempo.
- **`.down.sql`**: só remove o que a 0023 criou. Ele recusa se já houver alocação real, como na Fase 3.
- **Número.** `0023` é o próximo hoje. Se outra entrega criar migração antes, as duas são renumeradas juntas.

### 4.3 Integração com o que existe

| Ponto | Mudança | Contrato |
|---|---|---|
| `insertOrder` (checkout, orçamento, marketplace) | Grava `warehouse_id` padrão na reserva; pedido que nasce pago (marketplace) recebe `awaiting` | Igual |
| `applyPayment` | Uma linha a mais: `logistics_status = 'awaiting'` | Igual; o motor não roda aqui |
| Rotina nova `allocatePending` (no mesmo `setInterval` das outras) | Pega pedidos `awaiting` com `SKIP LOCKED`, em lote; caso simples confirma, o resto vai para `analysis` | — |
| `reserve` / `release` / `consume` | Recebem e respeitam o depósito da reserva | Mesmas recusas |
| `/orders/:id/cancel`, `cancelFromMarketplace`, cancelamento por prazo | Também cancelam atendimentos e alocações e gravam a decisão | Mesmas respostas |
| `/orders/:id/dispatch` | Consome por depósito; pedido novo exige `processing` (D4-7) | Mesmo corpo; erro novo `ALLOCATION_REQUIRED` |
| `/orders/:id/deliver` | Grava `completed` | Igual |
| Inventário, perda e avaria com reserva descoberta | Marcam os pedidos afetados como `analysis` | Igual |

### 4.4 API nova (`/api/v1/admin/logistics`)

| Rota | Permissão |
|---|---|
| `GET /allocation-queue`: fila por situação logística, paginada | `logistics.view` |
| `GET /orders/:id/allocation`: proposta do motor, alternativas, excluídas, atendimentos atuais, histórico | `logistics.view` |
| `POST /orders/:id/allocation`: confirmar a proposta ou uma alternativa (`version`, justificativa quando exigida, `requestKey`) | `logistics.allocate` |
| `POST /fulfillments/:id/cancel`: cancelar um atendimento, com motivo; o pedido volta para `analysis` | `logistics.allocate` |
| `GET/PUT /settings/dropship`: ver a trava; liberar com validador | ver: `logistics.view`; liberar: `settings.manage` (MFA) |

### 4.5 Painel

- **LOGÍSTICA → Alocação** (`/painel/logistica/alocacao`):
  - fila com abas "Em análise", "Aguardando" e "Em atendimento";
  - motivo em destaque.
- **Pedido** (`/painel/pedidos/:id`), bloco "Atendimento":
  - situação logística;
  - origem de cada item;
  - comparação de custo e prazo;
  - botões "Confirmar" e "Trocar origem" (com motivo);
  - histórico de decisões.
- **Configurações → Dropshipping**: mostra "Bloqueado até validação fiscal" e quem liberou, se liberar.
- Mesmo visual e mesmas regras de 375 px das telas da Fase 3.

### 4.6 Permissões

| Papel | `logistics.view` | `logistics.allocate` |
|---|---|---|
| owner, manager | ✔ | ✔ |
| logistics | ✔ | ✔ |
| shipping, sales | ✔ | — |
| stock, buyer, finance, fiscal | ✔ / — (D4-11) | — |

`logistics.allocate` **sem MFA** (operação do dia a dia). Liberar o dropshipping exige MFA.

## 5. Preservação do que existe (prioridade 5)

| Fluxo | Garantia | Como se prova |
|---|---|---|
| Checkout | Mesma rota, mesmo corpo, mesmas recusas; reserva no padrão | Testes atuais do checkout sem mudança + teste novo do `warehouse_id` |
| Pagamento (Pix, cartão, webhook) | Só grava `awaiting`; o motor roda fora | Testes atuais + teste "motor com erro não desfaz pagamento" |
| Pedido (`orders.status`) | CHECK e transições intactos (D1) | Testes atuais de transição |
| NF-e | Uma nota por pedido; despacho só com nota autorizada; encomenda é compra + venda (sem regra fiscal nova) | Testes atuais do fiscal |
| Dropshipping | Nenhuma operação real até a validação (D3) | Teste: confirmar com trava fechada → `DROPSHIP_BLOCKED` |
| Marketplaces | Importação, cancelamento e sincronização de saldo iguais; só estoque próprio | Testes atuais + cancelamento depois da alocação |
| Orçamentos | Reservas `quote` continuam no padrão; virar pedido segue o fluxo normal | Testes atuais |
| Vitrine e bot | Leem o total, como hoje | Testes atuais |

## 6. Testes

- **Motor** (`allocation.test.ts`, tabela de casos): casos 1–7 da §8 do plano geral:
  - só próprio;
  - só fornecedor;
  - duas origens;
  - divisão próprio + fornecedor;
  - dois fornecedores;
  - falta;
  - disponibilidade vencida.
- **Integração** (`sglog-fase4.test.ts`):
  - reserva concorrente (caso 8): duas confirmações simultâneas na mesma variante, e só uma passa;
  - cancelamento de atendimento (caso 9): libera a reserva, o pedido segue, e a decisão fica gravada;
  - cancelamento total depois da alocação, pelo painel, pelo marketplace e por prazo;
  - despacho consumindo no depósito certo, e `ALLOCATION_REQUIRED` em pedido novo sem alocação;
  - falta descoberta no inventário leva o pedido para `analysis`;
  - troca no lugar sem movimento novo; troca de depósito com liberação e reserva na mesma transação;
  - trava de dropshipping, no banco e na API;
  - permissões por papel (caso 16);
  - `loja_app` não altera `allocation_decisions` (caso 17);
  - conferência C1–C9 com 0 divergência ao fim de cada cenário;
  - pedidos antigos depois da 0023: situação preenchida e despacho legado funcionando.
- **Regressão.** Os 381 testes atuais passam sem mudança.
- **Migração.** `up`, `down` e `up` em `loja_test`; ensaio na cópia do servidor antes da produção.

## 7. Implantação prevista (quando autorizada, só você executa)

Mesmo roteiro da Fase 3, num documento próprio:

1. conferência rápida;
2. backup e verificação;
3. código sem build e ensaio da 0023 na cópia;
4. backup do instante, migração, build e reinício como root;
5. etapa F estendida com C8 e C9;
6. validação no navegador, só com o que for novo.

Antes do ensaio, a rotina de alocação nasce **desligada** por variável de ambiente
(`ALLOCATION_AUTO=off`). Você liga depois de conferir a fila pela primeira vez (D4-3).

## 8. Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| Trava em `orders` durante a 0023 | Checkout e pagamento esperam alguns ms | Coluna sem valor padrão (só metadado), preenchimento em lote pequeno, teto de 10 s, ensaio mede o tempo, fora do pico |
| Troca de reserva abrir janela para venda dupla | Venda da mesma unidade | Liberação e reserva na mesma transação com a variante travada; teste de concorrência |
| Motor com erro travar o pagamento | Pedido pago sem confirmação | O motor roda fora da transação do pagamento; erro deixa o pedido em `analysis` |
| Pedidos antigos sem alocação no despacho | Despacho bloqueado | `ALLOCATION_REQUIRED` só para pedidos pagos depois da 0023; os antigos passam pela rotina ou pelo caminho legado |
| Reserva `backorder` da encomenda inflar o reservado | Vendável de outros clientes cai | Comportamento atual do sob encomenda; fica no depósito de destino e aparece na fila |
| Dropshipping usado sem validação fiscal | Problema fiscal | Trava no banco (CHECK), na API e na tela; liberação com MFA e nome do validador |
| Divisão entre depósitos sem remessas múltiplas | Despacho de dois lugares | Fase 4 limita a um depósito próprio por pedido (D4-4) |
| Sessões paralelas criando migração | Número repetido | Conferir `apps/api/migrations` antes de criar a 0023; renumerar junto |
| Conferência mais lenta com C8 e C9 | Etapa F demora mais | Mesmas agregações por variante; medido no ensaio |

## 9. Decisões que precisam da sua aprovação

| # | Decisão | Recomendação |
|---|---|---|
| **D4-1** | Escopo: trazer para a Fase 4 a **reserva por alocação**, o **cancelamento da alocação** e o **tratamento de falta**, que o plano punha na Fase 5 | **Sim.** Remessas múltiplas, página do cliente por remessa e Playwright continuam na Fase 5; devolução na Fase 9 |
| **D4-2** | Momento: alocar **só depois do pagamento**, com o checkout inalterado | **Sim** |
| **D4-3** | Alocação automática no caso simples (um depósito cobre tudo), por rotina fora do pagamento, nascendo desligada | **Sim.** Você liga depois da primeira conferência |
| **D4-4** | Um depósito próprio por pedido nesta fase (mais encomenda ao fornecedor) | **Sim.** A divisão entre depósitos próprios vem com as remessas múltiplas |
| **D4-5** | Fornecedor: **encomenda** liberada (entrega no nosso depósito); **dropshipping** modelado e travado (D3) | **Sim** |
| **D4-6** | Critério do depósito: cobre tudo → padrão → `allocation_priority` → código. Frete por origem só na Fase 8 | **Sim** |
| **D4-7** | Pedido pago depois da 0023 só despacha com alocação confirmada | **Sim**. Os antigos ficam isentos |
| **D4-8** | Pedidos abertos existentes entram como `awaiting` e passam pela rotina; a reserva é reaproveitada no lugar, sem movimento | **Sim** |
| **D4-9** | Cancelamento **parcial comercial** (tirar item, mudar valor, estornar) fora da Fase 4. Fica só o cancelamento logístico da alocação e o cancelamento total, como hoje | **Sim.** Mexe em pagamento, NF-e e itens imutáveis; merece fase própria |
| **D4-10** | Devolução (depois do despacho) continua na Fase 9. A Fase 4 só garante o registro do depósito de saída de cada unidade | **Sim** |
| **D4-11** | `logistics.view` para estoquista, comprador e financeiro | **Sim para estoquista e comprador**, não para financeiro |
| **D4-12** | Troca do depósito padrão (adiada na Fase 3) | **Fora da Fase 4.** O livro antigo usa "nulo = padrão"; trocar o padrão mudaria o sentido do histórico. Precisa de solução própria |
| **D4-13** | Marketplaces: só estoque próprio; faltou, vai para análise | **Sim** |
| **D4-14** | Nome da migração e da branch: `0023_sglog_distribuicao`, branch `sglog/fase4` a partir da `main` | **Sim** |

## 10. Fora da Fase 4

| Fica para | O quê |
|---|---|
| Fase 5 | Remessas múltiplas, `partially_shipped` / `partially_delivered`, página do cliente por remessa, aviso de WhatsApp por remessa, Playwright |
| Fase 6 | Recebimento de compra por depósito (a encomenda usa o recebimento atual, no padrão, até lá) |
| Fase 7 | Solicitação formal ao fornecedor (gerar, imprimir, confirmar) |
| Fase 8 | Frete por origem e escolha de depósito por custo de frete |
| Fase 9 | Devolução e ocorrências |
| Sem fase | Cancelamento parcial comercial (D4-9) e troca do depósito padrão (D4-12) |

Nada desta fase é implementado, integrado, enviado ou implantado sem sua autorização expressa.
