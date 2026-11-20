# SGLog — Fase 4: distribuição e alocação dos pedidos

Implementa o planejamento aprovado em [22-sglog-fase4-planejamento.md](22-sglog-fase4-planejamento.md) (D4-1 a D4-14).
O roteiro da VPS está em [24-sglog-fase4-implantacao.md](24-sglog-fase4-implantacao.md).

## O que muda para quem usa

- **Menu Logística → Alocação.** É a fila dos pedidos pagos que ainda não sabem de onde sai a mercadoria. Os pedidos em
  análise aparecem primeiro, depois os que aguardam e por fim os já alocados.
- **Pedido → bloco "Alocação".** Mostra:
  - as opções do motor, com a recomendada marcada e o motivo;
  - o que cada depósito tem;
  - as reservas e o histórico.
- **Ações no bloco:**
  - **Confirmar.** A recomendada não pede motivo; outra opção pede.
  - **Trocar a origem.** Sempre pede motivo.
  - **Desfazer.** Pede motivo. A reserva continua com o pedido e ele vai para análise.
- **Despacho.** Pedido pago depois da atualização só despacha com a alocação confirmada. O erro é `ALLOCATION_REQUIRED`,
  e a tela já avisa antes. Pedido que estava em aberto na atualização continua despachando como antes, sem exigência.
- **Dropshipping.** Fica bloqueado. Só o proprietário ou o gerente com MFA (`settings.manage`) libera, informando quem
  validou o tratamento fiscal.

## Regras do motor (`lib/allocation.ts`, versão `f4.1`)

O motor é uma função pura e determinística: a mesma entrada dá sempre a mesma saída, inclusive os textos. Os
critérios, nesta ordem:

1. Estoque próprio antes de fornecedor (D4-4).
2. Um depósito próprio por pedido (D4-3).
3. Depósito que cobre o pedido inteiro, em ordem: o padrão primeiro, depois a prioridade cadastrada (menor primeiro),
   depois o código (D4-7). A prioridade é o campo `allocationPriority` do depósito, de 0 a 999, padrão 100.
4. Sem depósito que cubra tudo, o motor:
   - propõe o padrão com o que ele tiver e o resto por **encomenda** ao fornecedor recomendado pela escolha da Fase 2
     (custo, prazo, principal). A mercadoria chega no padrão, porque o recebimento de compra ainda é só no padrão
     (Fase 6);
   - sugere transferências.
5. **Marketplaces** (Mercado Livre, Shopee) usam só estoque próprio (D4-13).
6. **Dropshipping** só aparece com a trava liberada.
7. **Automático** só no caso simples: um depósito cobre tudo. O resto vai para análise com o motivo.

Cada decisão grava em `allocation_decisions`:

- a entrada avaliada: itens, depósitos, livre por depósito, ofertas, configurações (sem dados do cliente);
- a saída completa: critérios, depósitos avaliados, opções, excluídas, motivo da análise e sugestões;
- a escolha e a justificativa.

A tabela é imutável: nem a aplicação nem o dono do banco alteram ou apagam uma linha.

## Situação logística (`orders.logistics_status`)

É independente da situação comercial. É projetada por gatilho a partir dos marcos comerciais, sem tocar no código de
pagamento:

| Comercial | Logística |
|---|---|
| pago (`paid`, e também `preparing`/`ready` na migração) | `awaiting` (pago depois da 0023 também marca `allocation_required`) |
| despachado | `shipped` |
| entregue | `completed` |
| cancelado depois de pago | `canceled` |

A alocação muda a situação para:

- `processing` ao confirmar;
- `analysis` ao desfazer, quando falta mercadoria ou quando o motor não resolve sozinho.

Toda mudança incrementa `logistics_version`, e a tela usa esse número para recusar ação feita sobre dados velhos
(`VERSION_CONFLICT`).

## Integridade das reservas

- A reserva tem depósito (`stock_reservations.warehouse_id`) e, quando alocada, a alocação (`allocation_id`). As
  reservas ativas antigas passaram para o depósito padrão na migração.
- O checkout, os orçamentos e os marketplaces continuam reservando como antes: no padrão, conferindo o total.
- **Confirmar** é uma transação só, nesta ordem:
  1. trava o pedido (`FOR UPDATE`) e confere a versão;
  2. trava as variantes (mesma ordem do resto do estoque: total antes do depósito);
  3. recalcula o motor com os saldos já travados;
  4. grava a decisão, os atendimentos (`fulfillments`) e as alocações (`fulfillment_allocations`);
  5. troca as reservas.
- **A troca de reservas:**
  - Se a reserva já está no mesmo depósito e com a mesma quantidade, só é ligada à alocação, sem movimento.
  - Se não, a reserva do pedido é liberada e a da alocação é feita na mesma transação, com as variantes travadas.
    Nenhuma outra venda enxerga o intervalo.
  - A parte firme é reservada antes da encomenda.
- **Idempotência:**
  - `requestKey` é único em `allocation_decisions`.
  - Repetir a chamada, ou duas simultâneas com a mesma chave, devolve `{ replayed: true }` sem agir de novo.
  - Chamadas com chaves diferentes: a segunda recebe `VERSION_CONFLICT`.
- **Nunca há saldo negativo.** O depósito confere o livre (`INSUFFICIENT_STOCK` com o nome do depósito). A encomenda
  reserva além do físico (`backorder`), e o despacho só baixa quando a mercadoria chegou.
- **Desfazer** não libera nada para outra venda. Os atendimentos são encerrados, e a reserva fica com o pedido, no
  mesmo depósito e sem alocação. Várias reservas da mesma variante viram uma só.
- **Falta descoberta.** Uma saída que não é venda (contagem, perda, avaria) pode deixar o físico do depósito abaixo das
  reservas firmes de pedidos alocados. Nesse caso esses pedidos voltam para análise, com o motivo e uma decisão
  `shortage`. Nada é cancelado, liberado ou trocado sozinho.

## Pagamento e cancelamento

- O pagamento só torna o pedido elegível. A alocação roda fora da transação financeira (rotina ou painel), então um
  erro de alocação nunca desfaz um pagamento.
- O cancelamento pelo painel, pelo marketplace ou por vencimento continua usando a liberação de reservas de antes,
  que é idempotente. Um gatilho encerra os atendimentos e grava a decisão `order_canceled` uma vez só. Nada muda no
  estorno financeiro.
- Fica para fases futuras: cancelamento parcial com estorno, e devoluções (Fase 9).

## Rotina (`allocatePending`, a cada minuto)

- Pega os pedidos `awaiting`, cada um na sua transação, com `SKIP LOCKED`.
- **Desligada** (`ALLOCATION_AUTO` vazio ou `off`, o padrão):
  - os casos que precisam de pessoa vão para análise, com o motivo;
  - os casos simples continuam aguardando a confirmação manual e são reavaliados a cada 10 minutos.
- **Ligada** (`ALLOCATION_AUTO=on`): confirma também o caso simples, com a decisão `auto`. Ligar só depois da
  validação funcional (D4-2).
- Um erro num pedido o deixa em análise, com o motivo, e não afeta os outros.

## Permissões (D4-11)

| Papel | Ver alocação | Confirmar, trocar, desfazer |
|---|---|---|
| Proprietário, gerente | sim | sim |
| Gerente de logística | sim | sim |
| Estoquista, comprador, expedição, vendas | sim | não |
| Financeiro, fiscal | não | não |

O custo do fornecedor nas propostas só aparece para quem já vê custo (`suppliers.view` ou `purchases.view`).

## Conciliação

`stock_reconcile()` ganhou duas verificações:

- **C8:** as reservas ativas por depósito batem com o reservado de cada depósito. Reserva sem depósito conta no padrão,
  e a diferença herdada da abertura também.
- **C9:** cada alocação ativa (estoque ou encomenda) tem a sua reserva ativa, com a mesma quantidade e o mesmo
  depósito, e não sobra reserva apontando para alocação encerrada.

## Migração `0023_sglog_distribuicao`

- Não altera a 0020, a 0021 nem a 0022.
- Antes de mudar qualquer coisa, a 0023 confere duas condições: há um depósito padrão só, e nenhum pedido tem mais de
  uma reserva ativa por variante.
- Avisos esperados:
  - tempo de bloqueio;
  - quantidade de pedidos em aberto aguardando alocação;
  - quantidade de encerrados com situação logística;
  - quantidade de reservas passadas ao padrão.
- A reversão recusa em qualquer destes casos:
  - já há atendimento ou decisão;
  - há mais de uma reserva por variante;
  - há reserva fora do padrão;
  - há linha C8/C9 gravada.

## Testes

- `test/allocation.test.ts` testa o motor: ordem dos depósitos, caso automático, prioridade, análise, encomenda,
  marketplace, dropshipping e determinismo.
- `test/sglog-fase4.test.ts` faz a integração ponta a ponta:
  - elegibilidade e compatibilidade com pedido antigo;
  - reserva por depósito;
  - troca de depósito sem janela;
  - troca de origem com motivo;
  - desfazer;
  - um depósito por pedido;
  - concorrência, com confirmações simultâneas e pedidos disputando o mesmo saldo;
  - encomenda com despacho só depois da chegada;
  - trava do dropshipping no banco e na API;
  - marketplace só com estoque próprio;
  - cancelamentos duplicados, simultâneos e fora de ordem;
  - falta descoberta por contagem;
  - rotina desligada e ligada;
  - permissões e custo oculto;
  - imutabilidade do histórico;
  - conciliação C1–C9 zerada em cada etapa.
- Os testes antigos que despacham pedido novo passaram a confirmar a alocação antes (`allocateOrder` em
  `test/helpers.ts`).

## Limites conhecidos

- Pedido com itens em depósitos diferentes precisa de transferência antes, porque é um depósito por pedido nesta fase.
- A encomenda reserva no padrão. Comprar e receber continua no fluxo de compras: a alocação não cria pedido de compra
  sozinha.
- O dropshipping está modelado e travado. A emissão da nota de remessa por conta e ordem é assunto fiscal à parte.
