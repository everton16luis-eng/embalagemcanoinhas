# SGLog — Fase 7: abastecimento e comunicação com fornecedores

Implementação do plano aprovado em [31-sglog-fase7-planejamento.md](31-sglog-fase7-planejamento.md), com os ajustes da
aprovação: confirmação parcial em três casos, aumento de preço com aprovação própria, requisições idempotentes, prazos
distintos sem alerta retroativo e XML só como sugestão. Branch `sglog/fase7`, só no local. Implantação:
[33-sglog-fase7-implantacao.md](33-sglog-fase7-implantacao.md).

Nada nesta fase movimenta estoque nem muda custo médio. Separação, conferência e expedição (Fase 5) não mudam. Não há
estrutura paralela de `supplier_requests`: tudo gira em torno do pedido de compra da Fase 6.

## O que muda para quem usa

- **Pedido ao fornecedor.** Na compra aprovada, o painel "Pedido ao fornecedor" mostra a prévia do documento:
  - comprador;
  - fornecedor;
  - endereço de entrega do depósito;
  - itens, preços e totais;
  - mensagem.

  Se faltar dado obrigatório, a tela lista o que falta e não deixa gerar. Pode copiar o texto ou abrir a versão para
  imprimir e salvar em PDF. Depois de mandar pelo canal escolhido, "Registrar envio ao fornecedor" grava a versão. Os
  canais são impresso, PDF, WhatsApp, e-mail manual, telefone ou outro. O envio pode ser refeito ("Reenviar", nova
  versão). O botão "Marcar como enviado" da Fase 6 deu lugar a esse registro.
- **Confirmação do fornecedor.** Para cada item, registra-se um dos resultados abaixo, com preço e prazo:
  - confirmado;
  - entrega parcial (parte numa data, o restante em outra ou sem data);
  - redução definitiva da quantidade;
  - recusa.

  O histórico guarda todas as versões.
- **Aumento de preço.** Preço confirmado acima da tolerância fica "Aumento aguardando aprovação". Aprova quem tem
  `purchases.approve`, com MFA. Até a decisão, o recebimento dessa compra fica bloqueado.
- **Acompanhamento.** Registre cobranças ao fornecedor com a data do próximo retorno.
- **Logística → Abastecimento.** Mostra:
  - contadores por situação;
  - lista das compras;
  - o que está a caminho por produto;
  - encomendas afetadas (só o número do pedido);
  - desempenho dos fornecedores (30, 90 ou 180 dias).
- **Compras → Requisições.**
  - Quem precisa pede compra (produto, quantidade, depósito, motivo, data).
  - Encomendas de clientes sem compra viram requisição sozinhas.
  - O comprador marca as requisições abertas e gera um rascunho novo, ou acrescenta a um rascunho do mesmo fornecedor e
    depósito.
  - Também pode recusar, com motivo.
- **Recebimento pelo XML.** Com uma nota de entrada importada e ligada à compra, "Preencher pela nota" sugere as
  quantidades e os preços da nota. O operador confere e ajusta antes de receber.
- **Integrações.**
  - A Reposição mostra o que já está "em requisição" e desconta da necessidade.
  - O início do painel resume o abastecimento.
  - O detalhe logístico do pedido mostra a situação da compra vinculada.

## Regras

### Documento (D7-1, D7-2)

- `purchase_order_documents`: uma linha por envio, **imutável** (gatilho recusa UPDATE e DELETE). Cada linha guarda:
  - versão;
  - canal;
  - conteúdo estruturado e o texto enviado;
  - hash SHA-256 do conteúdo;
  - autor e data.
- Conteúdo:
  - comprador: razão social, CNPJ e endereço da empresa;
  - fornecedor: nome e documento;
  - entrega: depósito de destino e seu endereço;
  - itens (SKU, produto, embalagem, código do fornecedor, quantidade e preço), frete, despesas, total, previsão e
    mensagem.

  **Nenhum dado de cliente**, nem nas compras de encomenda.
- Obrigatórios: razão social e CNPJ da empresa, endereço de entrega e ao menos um item a pedir. O endereço de entrega
  é o do depósito de destino; no depósito padrão sem endereço, vale o da empresa. Faltando algum,
  `422 DOCUMENT_INCOMPLETE` com a lista em `details.missing`.
- O envio automático de e-mail fica **desligado**: o sistema só registra o que a equipe mandou.

### Confirmação (D7-3, D7-4, D7-5)

- `purchase_confirmations` e `purchase_confirmation_items`: versão por registro, imutável. A única mudança permitida é a
  decisão da aprovação, uma vez.
- O resultado vale sobre o **pendente** do item: pedido − recebido − cancelado.
  - **Confirmado**: nada é cancelado.
  - **Entrega parcial**: informa a parte e a data, e a data do restante (ou sem data). **Não cancela nada nem libera
    vínculos ou reservas.**
  - **Redução definitiva**: a diferença vai para `canceled_packs` do item.
  - **Recusa** (do item ou do pedido todo): todo o pendente vai para `canceled_packs`.
- Só a redução e a recusa liberam vínculos de encomendas que deixam de caber. A liberação vai da menor prioridade para
  a maior (pago mais recente primeiro), com pendência no pedido do cliente. Nenhum pedido é cancelado.
- Confirmação não muda custo médio nem cria movimento de estoque. O preço confirmado passa a ser o preço do item na
  compra; o custo real continua vindo da nota no recebimento (Fase 6).
- Tudo recebido ou cancelado, com algo recebido: a compra fecha como `received` (evento `closed_by_confirmation`). Tudo
  recusado sem nada recebido: a compra fica enviada com a confirmação "recusada", para cancelar.
- Receber sem confirmação continua possível (D7-3). A falta de confirmação aparece no acompanhamento.

### Aumento de preço (ajuste da aprovação)

- Referência: o preço original do item, o da primeira confirmação, antes de qualquer aumento. Acima da tolerância
  (`purchase_price_tolerance_pct`), a confirmação fica `pending_approval` e não se aplica até a decisão.
- Se o item já teve aumento aprovado, **qualquer** novo aumento pede nova aprovação.
- A aprovação exige:
  - `purchases.approve` e MFA;
  - a **versão** da confirmação e o **valor do aumento** que a tela mostrou (`CONFIRMATION_CHANGED` se não baterem).

  Ela grava os itens e os valores aprovados.
- Quem registrou não aprova (`SELF_APPROVAL`). O proprietário pode, com justificativa.
- Recusa da aprovação: a confirmação não se aplica, e a situação volta à da última confirmação aplicada.
- Recebimento bloqueado enquanto há aprovação pendente (`CONFIRMATION_APPROVAL_PENDING`).

### Prazos e situações (D7-8)

- Prazo para o fornecedor confirmar: **2 dias corridos** depois do envio, configurável de 1 a 30 em Compras → "Regras
  da compra".
- Situações, por compra enviada ou recebida em parte:

  | Situação | Quando |
  |---|---|
  | Aguardando confirmação | Enviada, sem confirmação, dentro do prazo |
  | Confirmação atrasada | Sem confirmação depois do prazo |
  | Aumento aguardando aprovação | Confirmação com aumento pendente |
  | Recusada pelo fornecedor | Tudo recusado |
  | Entrega prevista | Confirmada, com data de entrega futura |
  | Entrega atrasada | Data prometida (do item, senão da compra, senão a previsão) passou com saldo pendente |
  | Entrega sem previsão definida | Confirmada sem data, ou restante de parcial sem data |
  | Anterior ao acompanhamento | Enviada antes da 0026 |

- Na entrega parcial, a data de referência é a da parte até ela chegar e, depois, a do restante.
- As compras já enviadas antes da 0026 ficam "anteriores ao acompanhamento": **sem alerta retroativo**.

### Requisições (D7-6, D7-7)

- Permissão nova `purchases.request` para pedir: Estoquista, Logística, Gerente e Proprietário. Consolidar em compra,
  recusar e cancelar a de outra pessoa exigem `purchases.manage` (Comprador, Estoquista, Gerente e Proprietário). Quem
  pediu cancela a própria requisição manual.
- Todas as permissões são validadas na API.
- Situações: aberta → em compra → atendida, ou recusada ou cancelada. O histórico (`purchase_request_events`) é
  imutável.
- **Automática**: cada encomenda ativa de cliente (alocação "comprar para atender" com reserva aguardando mercadoria)
  sem vínculo suficiente vira **uma** requisição. As regras:
  - um índice único parcial garante uma só aberta ou em compra por encomenda;
  - a sincronização roda a cada 60 s, sob trava consultiva, e no botão "Atualizar encomendas";
  - ela é idempotente e segura em concorrência;
  - encomenda atendida ou desfeita fecha a requisição;
  - requisição recusada não é recriada.
- Pedido manual de um produto que já tem requisição de encomenda no depósito: `409 BACKORDER_REQUEST_EXISTS`. Só segue
  confirmando que é para estoque (`forStock`), sem duplicar.
- **Gerar compra**:
  - só de requisições abertas do mesmo depósito, que vira o destino da compra (`WAREHOUSE_MISMATCH`);
  - rascunho novo ou um rascunho existente do mesmo fornecedor e depósito (`ORDER_LOCKED` para outro estado);
  - arredonda para embalagens inteiras pela oferta do fornecedor (`NO_OFFER` sem oferta);
  - respeita o mínimo e o múltiplo com justificativa (`BELOW_MINIMUM`);
  - as requisições de encomenda viram vínculos da Fase 6 no mesmo item.
- Depois de gerada:
  - compra cancelada, ou item retirado do rascunho: a requisição volta a ficar aberta, com o evento `returned`;
  - compra recebida (encerrada): atendida.

  O gatilho da 0026 cobre o cancelamento e o recebimento, inclusive no código anterior.
- **Nunca gera compra sozinha.** A compra criada segue aprovação, envio e recebimento normais.

### XML (D7-11)

- `GET /purchase-orders/:id/receipt-suggestions?invoiceId=` lê a nota de entrada ligada e casa cada item com a compra.
  Devolve:
  - quantidade em embalagens;
  - preço por embalagem;
  - itens sem correspondência.
- Só sugere: não dá entrada, não muda custo e não aprova divergência. As conferências fiscal e de preço da Fase 6
  continuam no recebimento.

### Desempenho (D7-13)

- Por fornecedor, compras enviadas no período:
  - tempo até confirmar;
  - entregas no prazo e atrasadas;
  - prazo real médio;
  - itens reduzidos ou recusados;
  - aumentos de preço.
- O prazo sugerido é só referência: o cadastro do fornecedor não muda sozinho.

## API

| Rota | Permissão |
|---|---|
| `GET /admin/purchase-orders/:id/document` (prévia e faltantes) | `purchases.view` |
| `GET /admin/purchase-orders/:id/documents/:version` | `purchases.view` |
| `POST /admin/purchase-orders/:id/send` (`channel`, `message`, `note`) | `purchases.manage` |
| `POST /admin/purchase-orders/:id/documents` (reenviar) | `purchases.manage` |
| `POST /admin/purchase-orders/:id/confirmations` | `purchases.manage` |
| `POST /admin/purchase-orders/:id/confirmations/:cid/approve` e `/reject` | `purchases.approve` + MFA |
| `POST /admin/purchase-orders/:id/followup` | `purchases.manage` |
| `GET /admin/purchase-orders/:id/receipt-suggestions` | `purchases.receive` ou `purchases.manage` |
| `GET /admin/purchase-requests`, `GET /:id` | `purchases.view` ou `purchases.request` |
| `POST /admin/purchase-requests` | `purchases.request` |
| `POST /admin/purchase-requests/sync` | `purchases.manage` ou `purchases.request` |
| `POST /admin/purchase-requests/:id/cancel` | quem pediu ou `purchases.manage` |
| `POST /admin/purchase-requests/:id/reject`, `POST /convert` | `purchases.manage` |
| `GET /admin/supply/summary`, `/overview`, `/performance` | `purchases.view` ou `logistics.view` |

## Migração `0026_sglog_abastecimento`

- **Aditiva e compatível** com o código da Fase 6 (`5a07198`), inclusive na escrita:
  - colunas novas com padrão ou nulas;
  - tabelas novas;
  - CHECKs só ampliados.

  A suíte anterior passou inteira (451/451) contra o banco com a 0026.
- **Compras:**
  - `purchase_orders`: `sent_via`, `sent_document_version`, `supplier_ref`, `confirmation_status`, `confirmed_at`,
    `promised_at` e `followup_on`;
  - `purchase_order_items`: `canceled_packs`, `supplier_outcome`, `promised_at`, `partial_packs`,
    `partial_from_packs` e `rest_promised_at`; os preços original, confirmado e aprovado ficam nos itens da confirmação;
  - `logistics_settings.purchase_confirmation_days` (2) e `supplier_email_status` (`blocked`: e-mail ao fornecedor
    desligado).
- **Tabelas novas:**
  - `purchase_order_documents`;
  - `purchase_confirmations` e `purchase_confirmation_items`;
  - `purchase_requests` e `purchase_request_events`.
- O gatilho dos vínculos da Fase 6 passa a considerar o saldo cancelado. É zero no código anterior, que não cancela.
- Compras já enviadas ficam com `confirmation_status = 'none'` (anteriores ao acompanhamento).
- `stock_reconcile()` (C1–C13) não muda.
- **Reversão:** recusada se a Fase 7 já foi usada, e então nada muda. Contam como uso:
  - documento enviado, confirmação ou requisição;
  - envio, prazo ou contato registrado;
  - prazo de confirmação diferente de 2.
- **Ensaio** subir, descer e subir no banco local: esquema idêntico, dados anteriores idênticos e conferência sem
  divergência.
- As migrações 0020–0025 não mudaram.

## Travas que continuam

- `ALLOCATION_AUTO` desligado.
- Dropshipping e remessas múltiplas `blocked`.
- Checkout, pagamentos, NF-e de venda e marketplaces sem mudança.
- Nenhuma mensagem ao cliente nem ao fornecedor sai sozinha.

## Testes

- `apps/api/test/sglog-fase7.test.ts` (20 testes) cobre:
  - versões imutáveis do documento e bloqueio por dado faltante;
  - confirmação total, parcial (sem liberar vínculos), redução e recusa (liberando pela prioridade);
  - aumento de preço com MFA, versão, autoaprovação e novo aumento;
  - bloqueio do recebimento;
  - requisições automáticas idempotentes e concorrentes;
  - duplicidade manual × encomenda;
  - conversão (destino, vínculos e rastreio) e item retirado do rascunho;
  - prazos sem alerta retroativo;
  - situações e atrasos;
  - sugestão do XML sem movimento;
  - permissões;
  - conferência C1–C13 sem divergência e nenhum movimento de estoque.
- Suítes anteriores ajustadas só onde a Fase 7 muda o contrato:
  - envio exige documento completo;
  - papel Logística ganha `purchases.request`;
  - a reposição devolve `requested`.
- Telas: `tests/e2e/abastecimento.spec.ts` (Abastecimento, início, compra enviada e documento, requisições), desktop e
  375 px, sem rolagem lateral.
