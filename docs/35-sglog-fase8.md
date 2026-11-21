# SGLog — Fase 8: fretes, etiquetas, rastreamento e custos logísticos

Implementação do plano aprovado em [34-sglog-fase8-planejamento.md](34-sglog-fase8-planejamento.md) (D8-1 a D8-12),
com os ajustes da aprovação. O branch é `sglog/fase8` e existe só no local. A implantação está em
[36-sglog-fase8-implantacao.md](36-sglog-fase8-implantacao.md).

**A compra real de etiqueta está bloqueada** no painel, na API e nas rotinas automáticas. Nenhum teste compra etiqueta
de verdade.

Esta fase não muda:
- checkout, pagamentos, NF-e e marketplaces (o fluxo de entrega deles também fica igual);
- estoque, reservas, alocação e o fluxo das remessas da Fase 5.

## O que muda para quem usa

- **Logística → Fretes** (menu novo). Tem estas listas:
  - remessas a cotar e cotadas;
  - rastreio parado (sem evento há mais de 5 dias, configurável);
  - despachadas sem custo informado (últimos 90 dias);
  - em transporte;
  - etiquetas.

  Também tem a fila de integrações, com o botão "Reprocessar", e o relatório **cobrado × cotado × pago** por período.
  No topo ficam o transportador configurado e o **motivo** do bloqueio da etiqueta.
- **Painel "Frete" na remessa.** Aparece na remessa de entrega embalada, despachada ou entregue:
  - cobrado do cliente, cotado e pago, separados. O cobrado é rateado quando o pedido tem mais de uma remessa;
  - **cotação** pelo depósito de origem e pelos volumes medidos na embalagem, com a escolha do serviço;
  - etiqueta sempre com o motivo do bloqueio, sem botão de compra enquanto a trava estiver fechada;
  - rastreio, com o histórico e o registro manual da situação informada pela transportadora;
  - custo pago, ajuste e estorno.
- **Despacho.** Ganhou o campo opcional "Custo pago à transportadora". Em branco, o custo fica **não informado**,
  nunca zero.
- **Pedido do cliente.** Mostra o histórico de rastreio de cada remessa: postada, em trânsito, saiu para entrega,
  entregue, tentativa sem sucesso, devolução. Não mostra nomes de funcionários nem observações internas.

## Regras

### Cotação (D8-4)

- Origem: o CEP do **depósito da remessa**. Destino: o CEP do pedido. Os volumes são os medidos na embalagem: peso
  sempre, medidas quando informadas.
- Cada cotação é imutável e vale 2 h. Ao reabrir a remessa e embalar de outro jeito, as cotações antigas ficam
  marcadas "de outra embalagem" e não podem ser escolhidas (`QUOTE_STALE`). Cotação vencida dá `QUOTE_EXPIRED`.
- Reabrir ou liberar a remessa limpa o serviço escolhido.
- A chamada ao provedor fica fora da transação, e o resultado é gravado depois.
- Sem transportador configurado, o painel informa que a cotação pelo sistema está indisponível. O frete manual no
  despacho continua igual.

### Etiqueta: trava e compra (D8-2, D8-3, D8-6, D8-7)

A compra só fica liberada com **todas** as condições abaixo. O painel e a API mostram cada uma que faltar.

1. `SHIPPING_LABELS_ENABLED=true` no `.env` (padrão `false`).
2. Um provedor que compre etiqueta. **O Melhor Envio não compra nesta versão** (veja a seção Melhor Envio).
3. Regra do frete `label_status = enabled`. Exige o nome de quem validou, o usuário e a data, gravados com auditoria.
4. **Limite por etiqueta definido.** `label_max_cents` vazio **bloqueia**. Ajuste da aprovação: R$ 0 não quer dizer
   "sem limite". A coluna aceita só de R$ 0,01 a R$ 100.000. Acima do limite, a compra é recusada
   (`OVER_LABEL_LIMIT`), a não ser que alguém registre um motivo.

O pedido de etiqueta também exige, nesta ordem:
- a versão atual da remessa embalada;
- volumes completos;
- NF-e **autorizada**;
- endereço do depósito e do destino;
- uma cotação escolhida, válida, da embalagem atual e do mesmo provedor.

Permissão `shipping.labels` **com MFA**, para proprietário, gerente e logística. A expedição cota e informa à mão, mas
não compra.

**Nunca duas compras por remessa:**
- índice único: uma etiqueta ativa por remessa;
- chave de idempotência `label:<remessa>:<n>`, enviada ao provedor;
- a tarefa marca `purchasing` **antes** de chamar o provedor. Se encontrar `purchasing` numa nova tentativa (queda no
  meio), não compra de novo: marca `uncertain` e agenda a conferência;
- resposta incerta (tempo esgotado, erro 5xx, rede) vira `uncertain`. Só uma recusa explícita do provedor vira
  `failed`;
- `uncertain` só sai pela conferência no provedor ou pela resolução manual, com motivo e MFA. Enquanto isso, nenhuma
  nova compra é feita.

**Cancelamento (D8-11):**
- a remessa com etiqueta ativa não é cancelada, reaberta nem liberada (`LABEL_ACTIVE`). O gatilho da 0027 garante isso
  também fora da API;
- primeiro se pede o cancelamento da etiqueta (`cancel_requested`), e o sistema espera a confirmação do provedor;
- o estorno fica `pending`, `refunded`, `denied` ou `unknown`, conforme o provedor responder. Nada é presumido;
- se o provedor recusar, a recusa fica registrada com motivo, e a etiqueta continua ativa.

### Fila de integrações

Tabela `integration_jobs`, com estes tipos: compra, conferência e cancelamento de etiqueta, consulta de rastreio e
aviso do transportador.

- Chave de idempotência única: a mesma tarefa não é criada duas vezes.
- A rotina de 60 s da API pega até 20 tarefas vencidas com `FOR UPDATE SKIP LOCKED`.
- Novas tentativas em 1, 5, 15, 60 e 180 min. Esgotadas as tentativas, a tarefa vira "Falhou" e pode ser
  reprocessada em Fretes, com a permissão `logistics.manage` e registro em auditoria.
- Uma tarefa "rodando" há mais de 10 min (queda do processo) volta para a fila. Os tratadores conferem o estado antes
  de agir.
- `integration_logs` guarda operação, código HTTP, duração e um erro resumido. O log não guarda corpo de requisição,
  token, CEP, telefone, documento nem e-mail: `safeError` troca esses dados por `[numero]` e `[e-mail]`.

### Rastreio (D8-5)

- **Consulta automática** a cada 6 h (configurável de 1 a 72 h), só nas remessas com etiqueta comprada pelo sistema
  naquele provedor. Sem etiqueta pelo sistema, o rastreio é **manual**, pelo painel.
- **Aviso do transportador:** `POST /api/v1/webhooks/carriers/melhorenvio`.
  - Só é aceito com a assinatura `X-ME-Signature` conferida (HMAC-SHA256 do corpo com o segredo do app). Sem
    `MELHOR_ENVIO_WEBHOOK_SECRET`, todo aviso é recusado.
  - Aviso inválido responde 401 e fica no log.
  - Aviso repetido (mesmo corpo) é descartado.
  - O aviso entra na fila. Quando não há etiqueta correspondente, fica "ignorado".
- **Idempotente:** cada evento do provedor tem uma chave (por exemplo `me:posted`). Evento repetido não grava nada.
- **Sem regressão:** a ordem é despachada < em trânsito < saiu para entrega < entregue. Um evento atrasado ou fora de
  ordem entra no histórico, mas não volta a situação. Nada do histórico é apagado.
- **Remessa errada:** quando o código de rastreio do evento é diferente do registrado, o evento fica no histórico com
  o aviso, e a situação não muda.
- Remessa ainda embalada: o evento fica registrado com a dica de despachar. O rastreio não despacha nem baixa estoque.
- Entregue: a remessa vai para "entregue" e o pedido é recalculado, como na entrega manual.
- **Falha na entrega e devolução** só ficam registradas. O tratamento é da Fase 9.

### Custos (D8-9)

- Razão imutável `shipment_freight_costs` com os tipos `label` (da etiqueta), `manual` (informado), `adjustment`
  (ajuste) e `refund` (estorno, negativo). Ajuste e estorno exigem motivo. Há um custo de etiqueta e um custo informado
  por remessa, no máximo. Quando existe etiqueta, o custo vem dela (`COST_FROM_LABEL`).
- **Pago = soma dos lançamentos.** Sem lançamento, o pago é `null` ("não informado"), **nunca zero**.
- Relatório, por data de despacho:
  - o cobrado é o frete do pedido rateado entre as remessas vivas, com a sobra na primeira;
  - a diferença cobrado − pago só considera as remessas com custo conhecido. As outras aparecem à parte, também por
    transportadora;
  - estornos pendentes aparecem como aviso.
- Sem margem nem rentabilidade (Fase 10).

## Melhor Envio

Documentação oficial conferida em 21/11/2026.

- **Implementado:**
  - cotação (`/me/shipment/calculate`). Os volumes medidos vão como `products` com quantidade 1, porque o esquema de
    `volumes` é inconsistente na documentação;
  - rastreio (`/me/shipment/tracking`). As datas sem fuso são lidas como horário de Brasília;
  - avisos com assinatura (`order.posted`, `delivered`, `cancelled`, `undelivered` etc.).
- **Não implementado de propósito:**
  - **compra de etiqueta.** Carrinho, checkout e geração **não têm chave de idempotência** na API, e as etiquetas não
    são buscáveis pela nossa chave. Uma resposta perdida poderia virar compra em dobro. O adaptador declara
    `labels: false` e `cancel: false`. O fluxo completo roda com o transportador simulado;
  - renovação do token: os parâmetros não estão documentados. O token vale 30 dias.
- Use o sandbox (`MELHOR_ENVIO_SANDBOX=true`) para testar. Mesmo com credenciais reais configuradas, nada financeiro
  liga sozinho: a trava continua fechada.

## API

Todas em `/api/v1/admin/freight`. Escrita com `requestKey` (idempotente) e a versão da remessa quando ela muda.

| Rota | Permissão |
|---|---|
| `GET /overview`, `/shipments?view=`, `/shipments/:id`, `/jobs?status=`, `/settings` | `logistics.view` |
| `GET /report?from&to` | `shipping.manage` ou `reports.view` |
| `POST /shipments/:id/quotes`, `/quote-selection`, `/costs`, `/tracking` | `shipping.manage` |
| `POST /shipments/:id/labels`, `/labels/:id/print`, `cancel`, `reconcile`, `resolve`, `refund` | `shipping.labels` + MFA |
| `POST /jobs/:id/retry` | `logistics.manage` |
| `PUT /settings/tracking`, `/settings/labels` | `settings.manage` (liberar a etiqueta é recusado enquanto o servidor ou o provedor não permitirem) |

Mudanças em rotas existentes:
- `POST /admin/shipments/:id/dispatch` aceita `freightCostCents`. Com etiqueta pelo sistema, exige a etiqueta
  comprada (`LABEL_PENDING`) e usa o código de rastreio dela.
- `reopen`, `release` e `cancel` recusam a remessa com etiqueta ativa (`LABEL_ACTIVE`).
- O pedido do cliente traz `timeline` em cada remessa.

## Migração `0027_sglog_frete`

Aditiva, compatível com o código anterior inclusive na escrita (D8-12). A suíte da versão anterior passou 471/471 com
a 0027 aplicada. O cadastro de transportadoras não foi recriado.

- `logistics_settings`:
  - trava e validação da etiqueta (`label_*`), com `label_max_cents` vazio por padrão;
  - `tracking_poll_hours` 6 e `tracking_stale_days` 5.
- `shipments`: `carrier_provider`, `carrier_service`, `quote_id`, `tracking_status`, `last_tracked_at` e
  `last_tracking_event_at`. Todas são anuláveis, e as remessas antigas ficam iguais.
- Tabelas novas:
  - `shipping_quotes` (imutável);
  - `shipping_labels` (uma ativa por remessa);
  - `shipping_label_events` (imutável);
  - `shipment_freight_costs` (imutável);
  - `integration_jobs`;
  - `integration_logs` (imutável);
  - `logistics_webhook_events`.
- Gatilho `shipments_label_guard`: remessa com etiqueta ativa não vai para cancelada.
- Bloqueio curto com nova tentativa, sem esperar mais de 10 s.

Ajustes em relação ao plano:
- não há `shipments.label_id`: a etiqueta aponta para a remessa;
- o custo é um razão (`shipment_freight_costs`), e não um campo `freight_cost_cents`, para separar pago, ajuste e
  estorno;
- a etiqueta do Melhor Envio fica desligada no adaptador.

A reversão (`down`) é recusada quando a Fase 8 já foi usada: cotação, etiqueta, custo, tarefa na fila, aviso, rastreio
automático ou regra alterada.

## Travas que continuam

- `ALLOCATION_AUTO` desligado.
- Dropshipping, remessas múltiplas e e-mail automático ao fornecedor `blocked`.
- Novos avisos ao cliente por WhatsApp (D8-8) ficam fora. O aviso de estoque mínimo pela fila (D8-10) também.

## Testes

- API: `apps/api/test/sglog-fase8.test.ts`, 24 testes:
  - cotação por depósito e com vários volumes;
  - cotação × custo real;
  - compra bloqueada;
  - idempotência e concorrência;
  - respostas incertas e conferência;
  - avisos inválidos, repetidos e fora de ordem;
  - reprocessamento da fila;
  - transições do rastreio;
  - cancelamento da etiqueta e estorno;
  - permissões e MFA;
  - remessas antigas;
  - relatório.

  A suíte completa passou 495/495. A migração foi testada em up, down e up no banco de testes.
- Navegador: `tests/e2e/fretes.spec.ts`, somente leitura, no desktop e a 375 px. As telas anteriores (expedição,
  abastecimento, compras, fluxo atual) foram repetidas.
