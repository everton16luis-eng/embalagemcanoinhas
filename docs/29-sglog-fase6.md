# SGLog — Fase 6: compras, recebimento e conversão de encomendas

Implementação do plano aprovado em [28-sglog-fase6-planejamento.md](28-sglog-fase6-planejamento.md), com os ajustes da
aprovação em D6-3, D6-5, D6-9 e D6-11. Branch `sglog/fase6`, só no local. Implantação:
[30-sglog-fase6-implantacao.md](30-sglog-fase6-implantacao.md).

## O que muda para quem usa

- **Compra com aprovação.** Ciclo: rascunho → aguardando aprovação → aprovado → enviado → recebido em parte → recebido
  (ou cancelado). "Marcar como enviado" só aparece depois da aprovação.
- **Finalidade e destino.** Cada compra diz se é reposição ou atendimento de encomendas, e o depósito de destino. O
  recebimento só entra nesse depósito.
- **Recebimento com divergências.** Para cada item: quantidade que chegou, parte recusada (vai para avariado ou
  bloqueado, nunca para o disponível), custo da embalagem na nota e falta frente à nota. Tudo fica registrado.
- **Pagamento informado.** O financeiro registra data, valor e referência do que foi pago ao fornecedor. É só registro:
  não movimenta dinheiro, não consulta banco e não aparece como pagamento confirmado.
- **Encomendas atendidas na chegada.** Ao receber, as encomendas de clientes pagas viram reserva firme, na ordem de
  pagamento, sempre inteiras. A vinculada à compra que chegou vai primeiro.
- **Logística → Encomendas.** Fila por depósito e produto, com reprocessamento (com prévia) e antecipação manual.
- **Pedido do cliente.** O detalhe logístico mostra a compra vinculada, a encomenda atendida e a pendência quando a compra
  foi encerrada com falta.

## Regras

### Aprovação (D6-3, D6-4)

- `logistics_settings.purchase_approval_min_cents`: compras com total (mercadoria + frete + despesas) **abaixo** do
  limite são aprovadas na hora, sem aprovador, com o motivo no histórico. Limite e tolerância ficam em Compras → "Regras
  da compra" (ver: quem vê compras; alterar: `settings.manage`, com MFA). Com o limite 0, toda compra passa pela
  aprovação. O valor de produção é decisão da empresa: a migração cria 0 e nada fixa outro valor. Limite e tolerância
  ficam em Compras → "Regras da compra": quem vê compras vê as regras; alterar exige `settings.manage`, com MFA.
- Quem criou a compra ou a enviou para aprovação não aprova. O proprietário pode, só com justificativa. A compra fica
  marcada (`approval_self`), e a ação vai para o histórico e para a auditoria (`purchases.approved_self`).
- Aprovar exige `purchases.approve` e a verificação em duas etapas ativa.
- Editar uma compra que aguarda aprovação ou já foi aprovada volta para rascunho (evento `back_to_draft`): a aprovação
  valia para o pedido anterior. Enviada: só a previsão e as observações mudam. Itens, valores, finalidade e destino só
  mudam cancelando e refazendo.
- Os itens são atualizados no lugar (o id fica), porque os vínculos apontam para eles. Item com vínculo não sai do
  pedido (`ITEM_LINKED`), e a quantidade não fica abaixo do que está vinculado (`LINKS_EXCEED`).

### Pagamento informado (D6-5)

- Permissão própria, `purchases.pay`: Financeiro, Gerente e Proprietário. O Financeiro não ganha `purchases.approve`.
- Grava `payment_informed_*` e o evento `payment_informed`, com `confirmedByProvider: false`. Não toca em `payments`,
  no checkout nem no Mercado Pago.

### Recebimento (D6-1, D6-6, D6-7, D6-12)

- Permissão `purchases.receive`: Estoquista, Logística, Gerente e Proprietário. **O Comprador deixou de receber.**
- Só no depósito de destino (`WRONG_WAREHOUSE`). O banco garante o mesmo:
  - `purchase_receipts` sem depósito usa o destino;
  - recebimento em depósito diferente do destino é recusado;
  - movimento de compra em depósito diferente do recebimento é recusado.
- Ordem das travas: compra → variantes (ordenadas, `lockVariants`) → reservas. O pedido do cliente nunca é travado
  aqui, então a ordem pedido → variantes da alocação e da remessa não se inverte.
- Entra tudo o que chegou fisicamente (movimento `receipt`, custo efetivo). O recusado sai na mesma transação com
  `block` ou `damage_hold`, com o motivo. `received_packs` conta o que o fornecedor entregou; `rejected_packs`, a parte
  recusada. Aceito = recebido − recusado.
- Preço da nota diferente do pedido acima da tolerância (`purchase_price_tolerance_pct`, padrão 0%): exige
  justificativa e cria divergência `price`. O custo médio usa o custo real da nota.
- Divergências (`purchase_receipt_issues`) são imutáveis: `quantity`, `quality`, `price` e `wrong_item`.
- Excedente continua recusado (`OVER_RECEIPT`). A chave de requisição impede entrada dupla.
- Qualquer erro no meio desfaz o recebimento inteiro: nenhum movimento, linha, divergência ou conversão fica pela
  metade.

### Vínculo encomenda × compra (D6-2)

- Liga uma alocação ativa "comprar para atender" a um item da compra: mesma variante, mesmo depósito, compra aberta,
  dentro dos tetos do item e da alocação (gatilho `purchase_order_links_check`, que trava o item e a alocação).
- Dá prioridade na chegada, sem exclusividade.
- Cai sozinho quando a alocação é cancelada (troca de origem, desfazer ou cancelamento do pedido), inclusive pelo
  código antigo, e
  quando a compra é encerrada ou cancelada.

### Conversão da encomenda (D6-9, D6-10, D6-11)

- Livre para encomendas = físico disponível do depósito − reservas firmes. Bloqueado e avariado não contam, e outro
  depósito não conta.
- Fila por depósito e variante, só de pedidos pagos e abertos: vinculadas à compra que chegou primeiro, depois a data de
  pagamento; desempate pelo número do pedido e pelo id da reserva.
- Converte só a reserva **inteira**. A primeira que não cabe interrompe a fila: sem conversão parcial e sem pular.
- A conversão grava `reservation_conversions` (imutável, uma por reserva) e muda `backorder` para falso na mesma
  transação, pelo gatilho. O total reservado não muda: a vitrine não vê diferença.
- Converter não despacha nem muda o pedido do cliente. Separação, NF-e e despacho seguem as regras da Fase 5. A
  liberação calculada da Fase 5 continua valendo para as encomendas ainda não convertidas.
- **Antecipação manual:**
  - exige `logistics.manage`, a verificação em duas etapas e justificativa de 10 caracteres ou mais;
  - converte uma encomenda fora da ordem, inteira, só se a mercadoria livre cobrir;
  - fica registrada como regra `manual`, com a posição e os pedidos que estavam à frente na auditoria.
- **Encomendas antigas:** a migração não converte nada. O reprocessamento (`logistics.manage`) mostra a prévia e, ao
  aplicar, converte pela mesma fila. Repetir a mesma chave não converte de novo.

### Compra encerrada com falta (D6-8)

- Encerrar o saldo ou cancelar a compra derruba os vínculos ativos. As encomendas voltam para a fila comum.
- A resposta e o evento `closed_short`/`canceled` listam as encomendas que ficaram pendentes.
- O pedido do cliente não é cancelado: o detalhe logístico mostra "Vínculo desfeito ... pendente".
- Não há gravação em `order_events` aqui, para não travar o pedido do cliente depois da compra.

## Permissões

| Permissão | Quem tem por padrão | MFA |
|---|---|---|
| `purchases.approve` | Gerente, Proprietário | Sim |
| `purchases.receive` | Estoquista, Logística, Gerente, Proprietário | Não |
| `purchases.pay` | Financeiro, Gerente, Proprietário | Não |
| antecipar encomenda (`logistics.manage`) | Logística, Gerente, Proprietário | Sim (conferido na rota) |

O Comprador continua com `purchases.manage`: cria, edita, envia para aprovação, vincula e marca como enviado.

## Migração `0025_sglog_compras`

Aditiva. As tabelas antigas não são reescritas.

- `purchase_orders`:
  - novas situações `pending_approval` e `approved`;
  - colunas de finalidade, destino, aprovação, pagamento informado e transporte;
  - as compras existentes ficam como reposição no depósito padrão. Com o gatilho
    `purchase_orders_default_warehouse`, o código antigo também grava o destino padrão.
- Tabelas novas:
  - `purchase_order_events` (imutável);
  - `purchase_receipt_issues` (imutável);
  - `purchase_order_links`;
  - `reservation_conversions` (imutável).
- Colunas novas:
  - `purchase_order_items.rejected_packs`;
  - `purchase_receipts.warehouse_id`, com o gatilho do destino;
  - `purchase_receipt_items`: recusado, destino e custo da nota.
- Configuração: `logistics_settings.purchase_approval_min_cents` (0) e `purchase_price_tolerance_pct` (0).
- Conciliação ampliada até a C13:
  - **C12:** cada recebimento × movimentos (entrada e recusa), e item da compra × linhas dos recebimentos;
  - **C13:** vínculos dentro dos tetos do item e da alocação, e reserva convertida que voltou a ser encomenda.
- `purchase_order_links.order_id` e `reservation_conversions.order_id` **não** têm chave estrangeira para `orders`. A
  FK pegaria a trava do pedido (KEY SHARE) depois das variantes e inverteria a ordem da alocação (risco de deadlock).
  Os gatilhos conferem o pedido pela alocação e pela reserva.
- **Down:** recusado se a Fase 6 já foi usada (compra aguardando ou aprovada, destino diferente do padrão, pagamento,
  transporte, evento, divergência, vínculo, conversão, recusa, custo da nota, configuração alterada, C12/C13
  registradas). Sem uso, desfaz tudo e restaura a função de conciliação da 0024.

### Compatibilidade com o código anterior (D6-13)

- A suíte inteira do código anterior (`01bdc7c`) rodou contra o banco com a 0025: **431/431**. Os únicos ajustes foram
  no helper de testes `resetCatalog`, que faz TRUNCATE e precisou listar as tabelas novas. Esse helper não existe em
  produção, e o `demo:reset` monta a lista de tabelas sozinho.
- Caminhos de escrita do código antigo com a 0025:
  - compra criada sem destino → gatilho preenche o depósito padrão;
  - recebimento sem depósito → destino;
  - movimento de entrada sem depósito → depósito do recebimento;
  - envio direto de rascunho para `sent` → aceito, pois os CHECKs novos só olham `pending_approval` e `approved`;
  - desfazer alocação → os vínculos caem pelo gatilho.
- Por isso, diferente da Fase 5, a API não precisa ficar parada durante a migração.

## Testes

- **API** (`apps/api/test/sglog-fase6.test.ts`, 20 testes), mais os ajustes de fluxo nas suítes antigas:
  - aprovação por limite, autoaprovação do proprietário, MFA, devolução e edição que volta a rascunho;
  - pagamento informado;
  - recebimento total e parcial, permissões por papel e destino (API e banco);
  - recusa para avariado e bloqueado;
  - preço com e sem tolerância;
  - falta e item errado;
  - falha no meio sem resíduo, e reenvio simultâneo idempotente;
  - fila por pagamento;
  - prioridade do vínculo e tetos;
  - parada na primeira que não cabe;
  - antecipação (permissão, MFA, justificativa, mercadoria, repetição);
  - dois recebimentos simultâneos sem conversão dupla;
  - outro depósito, bloqueado e avariado não convertem;
  - separação da encomenda convertida;
  - encerramento com falta e pendência no pedido do cliente;
  - encomenda antiga com prévia, reprocessamento e repetição;
  - desfazer a alocação cancela o vínculo;
  - C12 e C13.
- **Migração:**
  - up/down/up num banco novo migrado até a 0024: esquema idêntico depois do down e depois do segundo up;
  - dados legados iguais e conciliação sem divergência;
  - down recusado no banco de testes com uso da Fase 6, sem mudar nada;
  - up/down/up também no banco de desenvolvimento com a demonstração.
- **Telas** (`tests/e2e/compras.spec.ts`, desktop e 375 px), sem rolagem lateral e sem erro no console:
  - rascunho → envio para aprovação → aprovar sem MFA recusado na tela → cancelar;
  - formulário de recebimento com divergências;
  - Encomendas com prévia do reprocessamento;
  - filtro com as situações novas.

## Limites e riscos conhecidos

- **Reposição.** O cálculo "a caminho" da reposição conta só compras enviadas e em parte, como antes. Aprovadas ainda não
  enviadas não entram.
- **Recusado.** O que foi recusado fica em bloqueado ou avariado. A devolução ao fornecedor ou o descarte seguem pelos
  movimentos da Fase 3 (desbloquear, baixa de avaria). Não há fluxo de devolução ao fornecedor nesta fase.
- **Pagamento informado.** Não é conciliado com extrato. Integração financeira fica fora do escopo.
- **Antecipação e MFA.** A antecipação exige MFA na rota. Quem tem `logistics.manage` sem MFA vê o botão desativado.
- **Encomendas antigas.** Ficam como estão até alguém reprocessar: a liberação calculada da Fase 5 continua valendo
  para elas.
- **Mudança de comportamento.** O Comprador não recebe mais mercadoria (D6-1). Quem recebia com esse papel precisa do
  papel Estoquista ou Logística, ou da permissão individual `purchases.receive`.
