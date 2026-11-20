# SGLog — Fase 5: remessas, separação, conferência e expedição

Implementada na branch `sglog/fase5` (local, sem merge, push ou implantação), a partir de `55cc51d`. Planejamento e
decisões D5-1 a D5-13: [25-sglog-fase5-planejamento.md](25-sglog-fase5-planejamento.md). Esta página registra o que
foi feito e as regras como ficaram no código.

## O que muda para quem usa

- **Logística → Expedição** (menu novo): fila das remessas com contadores (a separar, em separação, em conferência,
  embaladas), abas por situação, busca por pedido, cliente ou rastreio, e selos de pendência (pedido em análise,
  encomenda, aguardando NF-e).
- **Tela da remessa:** etapas (a separar → separação → conferência → embalada → despachada → entregue), itens na ordem
  do endereço no depósito, separação item a item com "falta", conferência por SKU (o campo aceita leitor de código de
  barras que age como teclado), volumes com peso e medidas, despacho e entrega. As ações críticas pedem um segundo
  clique de confirmação. O histórico junta separação, conferência e mudanças de situação, com usuário e horário.
- **Pedido no painel:** o painel "Remessas" mostra cada remessa. Num pedido novo, os botões manuais "Iniciar
  separação", "Pronto", "Despachar" e "Entregue" dão lugar a "Abrir na Expedição".
- **Conta do cliente:** com mais de uma remessa nova, cada entrega aparece com o seu rastreio. Com uma só, a página
  continua igual.
- **Pedidos antigos** (sem alocação obrigatória) continuam com os botões e o despacho de antes.

## Ciclo da remessa

| Situação | Quem passa para a próxima | O que acontece com o estoque |
|---|---|---|
| `pending` (a separar) | Iniciar separação (`shipping.pick`) | nada |
| `picking` | Separar item a item; concluir separação | nada: só registra o separado |
| `checking` | Conferir por SKU até bater; concluir | nada |
| `packed` | Embalar (volumes) | nada |
| `shipped` | Despachar (`shipping.manage`), com NF-e autorizada ou dispensada | baixa só a quantidade da remessa, consumindo a reserva |
| `delivered` | Marcar entregue (`shipping.manage`) | nada |

Também existem `in_transit`, `out_for_delivery`, `delivery_failed` e `returned` no banco, para a Fase 8 (frete). Nesta
fase nenhuma tela usa esses estados.

**Retirada na loja:** o despacho é a entrega no balcão ("Entregar ao cliente"). A remessa vai de `packed` a
`shipped` e `delivered` na mesma transação. O WhatsApp "pedido pronto" sai na embalagem; o "pedido enviado" não sai.

**Voltar etapa:** "Voltar para a conferência" (da embalagem), "Voltar para a separação" (da conferência) e "Liberar
para pendente" desfazem por registros novos. Nada é apagado.

## Regras (ajustes da aprovação)

**Separação (ajuste 1).** Separar não baixa estoque nem libera reserva. Cada separação confere:
- a remessa precisa ser da alocação confirmada e o item, da remessa;
- o total separado do item não passa do previsto nem da reserva ativa da alocação (`OVER_RESERVATION`);
- o físico do depósito cobre o separado em todas as remessas abertas mais o novo (`INSUFFICIENT_PHYSICAL`). Assim
  duas separações não usam a mesma quantidade.

Tudo roda sob trava da variante, na ordem pedido → remessa → variantes.

**Falta na separação.** O separador informa quanto achou. A remessa volta a `pending`, o pedido vai para `analysis`
com a nota da falta e a divergência fica registrada para análise. O estoque não muda. Quem resolve é a alocação
(trocar origem, encomenda ou cancelar), como na Fase 4.

**Conferência (ajuste 2).** Cada leitura grava SKU, quantidade, usuário, horário e resultado em `shipment_checks`,
tabela imutável. O sistema:
- recusa conferir acima do separado (`OVER_EXPECTED`);
- recusa SKU fora da remessa (`WRONG_SKU`);
- registra a tentativa recusada no histórico.

Erro operacional se corrige com "Desfazer conferência" (`check_undo`), que é um registro novo. O conferente diferente
do separador é configurável em Expedição → Regras e começa desligado (D5-7).

**Troca de origem e desfazer alocação (ajuste 3).** Com remessa em separação, conferência ou embalada, ou com
quantidade separada, trocar ou desfazer a alocação é recusado (`SHIPMENT_IN_PROGRESS`). Antes é preciso liberar a
remessa para pendente e devolver a mercadoria ao lugar. O cancelamento do pedido também recusa com mercadoria
separada (`GOODS_PICKED`). Reserva de mercadoria fisicamente separada nunca é liberada para outro pedido.

**Despacho (ajuste 4).** Uma transação com:
- trava do pedido, da remessa e das variantes;
- `version` da remessa;
- `requestKey`: a mesma chave devolve o mesmo resultado sem agir de novo.

Consome só a quantidade da remessa (`consumeReservation` com o documento da remessa). As validações de NF-e e
pagamento são as mesmas do despacho antigo (`INVOICE_REQUIRED`), sem atalho. Dois despachos ao mesmo tempo: um passa
e o outro recebe conflito. Os testes conferem isso.

**Remessas múltiplas (ajuste 5).** O banco já aceita várias remessas por pedido (`seq`). A divisão fica travada
(`MULTI_SHIPMENT_BLOCKED`) até alguém com `settings.manage` (MFA) liberar em Expedição → Regras. A liberação exige o
nome de quem validou o tratamento fiscal e fica registrada com o usuário e a data. Nenhuma regra de emissão de NF-e
para entrega parcial foi criada: com a trava liberada, o despacho de cada remessa continua exigindo a NF-e do pedido
como hoje. Um depósito por pedido nesta fase.

**Encomenda: regra provisória de prioridade (ajuste 6).** A reserva de encomenda continua `backorder` depois do
recebimento. A Fase 6 faz a conversão definitiva; esta fase não converte nada. A liberação para separar é calculada
na hora, sob trava da variante:

1. Mercadoria disponível para encomendas no depósito = físico − reservas firmes.
2. As encomendas ativas da variante no depósito ficam em fila por data de pagamento do pedido (`paid_at`, a mais
   antiga primeiro).
3. Uma encomenda só pode ser separada quando a mercadoria disponível cobre a soma dela com as que estão antes na
   fila. Senão: `AWAITING_GOODS`, com o que chegou e o que falta.
4. A trava de físico da separação vale também aqui. A mesma mercadoria não vai para duas encomendas: a segunda da
   fila só libera quando sobra para as duas.

## Situação do pedido (projeção, D5-5)

As remessas novas decidem `orders.status` e `orders.logistics_status` por uma função só (`projectOrder`):

| Remessas | `orders.status` | `logistics_status` |
|---|---|---|
| alguma em separação ou adiante | `preparing` | sem mudança |
| todas embaladas | `ready` | sem mudança |
| parte despachada e parte aberta | `shipped` | `partially_shipped` |
| todas despachadas | `shipped` | `shipped` |
| parte entregue | `shipped` | `partially_delivered` |
| todas entregues | `delivered` | `completed` |

O `/status` manual recusa (`SHIPMENT_DRIVEN`) quando o pedido é novo ou quando a remessa já saiu de `pending`.

## Compatibilidade (ajuste 7)

- **Pedidos antigos:**
  - a migração cria uma remessa `legacy` para cada despacho existente;
  - o despacho antigo (`/orders/:id/dispatch`) continua para pedido sem alocação obrigatória: cancela a remessa nova
    ainda pendente, se houver, e grava uma `legacy` com o próximo `seq`;
  - um pedido novo com alocação própria ou por encomenda recebe `USE_SHIPMENT` e precisa passar pela Expedição.
- **Checkout e pagamento:** sem mudança. O Playwright cria o pedido com Pix simulado e não paga.
- **NF-e:** sem mudança. O despacho exige a mesma situação da nota.
- **Marketplaces:** cancelamento vindo do marketplace segue `cancelFromMarketplace`. A remessa aberta é cancelada
  junto pelo gatilho da 0024.
- **WhatsApp e bot:**
  - `whatsapp_messages` ganhou `shipment_id`, com unicidade por (pedido, evento, remessa); duas remessas mandam dois
    "enviado" e a mesma remessa não manda duas vezes;
  - o bot lê o rastreio da última remessa despachada;
  - pedido continua um só (nenhuma remessa cria pedido).
- **Fases 1–4:** reservas, alocação e conciliação mantidas. `ALLOCATION_AUTO` continua desligado.

## Permissões

| Ação | Permissão | Papéis |
|---|---|---|
| Ver expedição e remessas | `logistics.view` | como antes |
| Separar, conferir, embalar | `shipping.pick` (nova) | estoquista, expedição, logística, gerente, proprietário |
| Criar, dividir, liberar e cancelar remessa | `logistics.manage` (nova) | logística, gerente, proprietário |
| Despachar e marcar entregue | `shipping.manage` (como hoje) | expedição, logística, gerente, proprietário |
| Liberar remessas múltiplas e exigir conferente distinto | `settings.manage` com MFA | proprietário, gerente |

Diferença em relação ao planejamento: o estoquista não ganhou `shipping.manage`, que também despacha. Ganhou a
permissão nova `shipping.pick`, só para separar, conferir e embalar.

## Migração `0024_sglog_remessas`

Aditiva, numa transação. As migrações 0020–0023 não foram alteradas.

- **`shipments`:**
  - sai o `UNIQUE (order_id)`;
  - entram `seq`, `kind`, `status`, `warehouse_id`, `packages`, `version`, horários e motivo do cancelamento.
- **Tabelas novas:**
  - `shipment_items`, com gatilho que impede passar da alocação;
  - `shipment_checks` e `shipment_events`, imutáveis e com `request_key` única.
- **`logistics_settings`:** trava de remessas múltiplas (`blocked`) e conferente distinto (desligado).
- **Funções:**
  - `orders_logistics_close` cancela as remessas abertas quando o pedido é cancelado e registra a devolução ao lugar
    do que estava separado;
  - `stock_reconcile` ganha C10 (baixa da remessa = itens despachados) e C11 (separado e conferido = histórico;
    itens abertos ≤ reserva). C9 desconta o que já foi despachado.
- **Dados existentes:**
  - cada despacho antigo vira uma remessa `legacy`, com a situação atual (`shipped` ou `delivered`);
  - pedido com alocação confirmada em `processing` ganha uma remessa `pending`. Na VPS, isso deve valer para os
    pedidos de demonstração com alocação aberta (por exemplo, nº 1421 e nº 1426): eles aparecem em "A separar";
  - nada é apagado.
- **Volta (`down`):** recusa se já houver uso real (remessa além de `pending`, conferência, C10/C11, trava liberada,
  WhatsApp de remessa nova, mais de uma remessa antiga por pedido). Sem uso, volta as funções e restrições da 0023.

Ensaio local no `loja_dev`, com a demonstração anterior à 0024 (447 pedidos):
- 401 remessas antigas (395 entregues, 6 despachadas) e 2 pendentes criadas;
- conciliação vazia;
- `down` e `up` de novo sem erro.

## Testes

- **API:** `apps/api/test/sglog-fase5.test.ts` cobre:
  - separação, conferência, embalagem, despacho e entrega;
  - concorrência no despacho e na separação;
  - idempotência por `requestKey`;
  - falta na separação;
  - cancelamento com e sem mercadoria separada;
  - remessas múltiplas travadas e liberadas;
  - prioridade de encomenda por `paid_at`;
  - permissões;
  - C10 e C11.

  Os testes antigos de pedido, alocação, WhatsApp, bot e marketplace foram ajustados para o despacho por remessa e
  continuam passando.
- **Playwright** (`tests/e2e`, `npm run e2e`):
  - `fluxo-atual.spec.ts` registra vitrine → produto → carrinho → checkout com retirada e Pix simulado, até a tela
    do pedido, sem pagar, e abre a lista e o detalhe de pedidos no painel;
  - `expedicao.spec.ts` confere a fila, as abas, a busca vazia, as regras travadas, a remessa aberta, a entregue e o
    erro de remessa inexistente;
  - cada teste roda em desktop e em 375 px, conferindo também que a página não rola para o lado.
  - Ver [../tests/e2e/README.md](../tests/e2e/README.md).

## Limites e riscos conhecidos

- **NF-e não configurada:** pedido novo com NF-e exigida não despacha. A remessa para em "Embalada", com o aviso
  "Aguardando NF-e". É o comportamento de hoje, mantido.
- **Remessas múltiplas:** só a estrutura e a divisão estão prontas. A emissão de NF-e para entrega parcial depende do
  contador e não foi implementada.
- **Encomenda:** a prioridade por `paid_at` é provisória. Na Fase 6 a reserva passa a firme no recebimento.
- **Mercadoria separada em pedido cancelado:** o cancelamento pelo painel recusa enquanto houver separado. Já o
  cancelamento vindo do marketplace cancela as remessas e registra "devolver a mercadoria
  ao lugar". Alguém precisa guardar fisicamente.
- **Estados de transporte** (`in_transit`, `delivery_failed` e outros) ficam sem tela até a Fase 8.
- **Playwright:** `npm ci` na VPS instala o pacote (dependência de desenvolvimento, sem navegador). Ele não entra no
  build nem roda no servidor.
