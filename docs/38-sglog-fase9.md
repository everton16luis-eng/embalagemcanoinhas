# SGLog — Fase 9: ocorrências, devoluções e logística reversa

Implementação do plano aprovado em [37-sglog-fase9-planejamento.md](37-sglog-fase9-planejamento.md), com os ajustes da
aprovação em D9-3, D9-4, D9-5, D9-10 e D9-11. O branch é `sglog/fase9` e existe só no local:
- `d454b30` — **9a**: ocorrências, devoluções, recebimento, conferência e quarentena;
- `8bd11c7` — **9b**: reembolsos, documento fiscal, troca, devolução ao fornecedor e C17–C21.

A implantação está em [39-sglog-fase9-implantacao.md](39-sglog-fase9-implantacao.md). A migração é uma só, a
`0028_sglog_devolucoes`, ampliada na 9b antes de qualquer implantação.

Esta fase **não muda**:
- checkout, pagamentos, marketplaces e o fluxo de entrega deles;
- a NF-e de venda e o `invoice_status` (nada nesta fase cancela ou altera nota);
- reservas, alocação (com `ALLOCATION_AUTO` desligado), remessas e expedição da Fase 5, fretes da Fase 8.

Continuam bloqueados: dropshipping, remessas múltiplas, compra real de etiqueta (`SHIPPING_LABELS_ENABLED` desligado)
e e-mail automático ao fornecedor.

## O que muda para quem usa

- **Logística → Ocorrências.** Lista por situação e tipo, e o detalhe com histórico permanente. Tipos: avaria,
  extravio, atraso, recusa, item errado, arrependimento, defeito, troca, reembolso e outros. Responsável: loja,
  transportadora, cliente, fornecedor, marketplace ou "a definir" (não resolve assim).
- **Logística → Devoluções.** Abas:
  - **Lista** por situação (autorizada, em trânsito, recebida, conferida, concluída, cancelada);
  - **Quarentena**, com a idade de cada linha e as decisões (liberar, avariar, baixar);
  - **Reembolsos**, a fila de registros solicitados e realizados ainda não confirmados;
  - **Relatório** do período: devoluções por tipo e condição, ocorrências, reembolsos, devoluções ao fornecedor e
    pendências (fiscal, quarentena, reembolso);
  - **Política**, com os prazos de referência (só informam).
- **Detalhe da devolução.** Itens autorizados e recebidos, conferência por condição, estorno da conferência, painel
  "Documento fiscal" (documento ou dispensa), painel "Reposição" (na troca) e painel "Reembolsos".
- **Pedido no painel.** Painel "Ocorrências e devoluções" (abrir ocorrência, autorizar devolução com os limites por
  item) e painel "Reembolsos". O pedido de reposição mostra a devolução de origem.
- **Logística → Devol. ao fornecedor** (menu novo, para quem vê compras). Rascunho, envio, aceite, recusa e
  cancelamento.
- **Página do pedido do cliente.** Mostra só a situação de cada devolução (número, tipo, situação, datas). Notas
  internas, valores de reembolso, depósito e nomes de funcionários não aparecem: os eventos da Fase 9 no pedido são
  gravados como internos (`order_events.internal`).

## Regras

### Ocorrências
- Pertencem a um pedido; remessa e item são opcionais. Transições `open → in_progress → resolved` e
  `open|in_progress → canceled`; reabrir exige motivo. Tudo com `version` (409) e `requestKey` (idempotência).
- **Ocorrência aberta que segura a conclusão** impede `logistics_status = 'completed'`: o pedido entregue fica
  `on_hold` até ela ser resolvida ou cancelada. A ocorrência aberta depois da conclusão não reabre nada.
- **Pelo rastreio (D9-11):** `delivery_failed` e `returned` abrem uma ocorrência por remessa, idempotente (o mesmo aviso
  repetido não cria outra). Nenhum evento de rastreio movimenta estoque, reembolsa ou toca documento fiscal.
- **Pelo pagamento:** quando o provedor marca `refunded` ou `charged_back` num pedido já pago, abre uma ocorrência do
  tipo reembolso, uma só por pedido, sem segurar a conclusão. Não registra reembolso nenhum.

### Devolução física e estoque
- Tipos: devolução, recusa na entrega e troca. Total ou parcial, por item.
- **Limite por item:** autorizado ≤ despachado (remessas novas: `shipment_items`; despacho anterior: `order_items`),
  contando as devoluções anteriores e as concorrentes. A trava é um gatilho no banco, com o pedido travado; duas
  autorizações ao mesmo tempo não passam do limite.
- **Autorizar, marcar em trânsito e receber não movimentam estoque.** Só a conferência movimenta, no depósito que
  recebeu, na mesma transação:

  | Condição | Movimentos |
  |---|---|
  | boa | `return` (entra no físico) |
  | quarentena | `return` + `block` (físico → bloqueado) |
  | avariada | `return` + `damage_hold` (físico → avariado), com motivo |
  | descartada | `return` + `damage` (baixa), com motivo |
  | faltando | nenhum (só registro) |

- A conferência é imutável; corrige-se por **estorno** com motivo, que gera os movimentos inversos. Quarentena com
  decisão não pode ser estornada.
- **Quarentena:** liberar (`unblock`), avariar (`unblock` + `damage_hold`) ou baixar (`unblock` + `damage`). A decisão
  nunca passa do que está em quarentena.
- Movimentos imutáveis, com `source_type` da devolução e o id da linha, e idempotentes por `requestKey`.

### Custo da unidade devolvida (D9-3)
- Boa, quarentena e avariada entram pelo **custo histórico da venda**: o `avg_cost_after` gravado nos movimentos de
  saída do pedido para aquela variante. O custo médio é recalculado com essa entrada (a mesma regra das demais
  entradas), sem tratar a volta como compra nova a preço atual.
- Sem custo de venda conhecido (zero ou ausente, por exemplo pedido anterior ao custo médio), a entrada usa o **custo
  médio atual**, e o médio não muda.
- Descartada entra sem custo e sai em seguida (baixa).

### Prazos (D9-10)
Arrependimento e defeito têm prazos de referência configuráveis na aba Política. A tela avisa quando a solicitação
passa do prazo, mas **nenhum pedido é recusado por prazo**. A política é da loja.

### Reembolso (D9-5)
- **Só registro.** Nenhum provedor é chamado; o dinheiro é devolvido fora do sistema (Mercado Pago, Pix,
  transferência, dinheiro, estorno no cartão ou pela plataforma do marketplace).
- Permissão própria `refunds.record`, **com MFA**. Registra valor, forma, referência externa, responsável, data e
  justificativa.
- Situações separadas: **solicitado** → **realizado** (exige a referência externa) → **confirmado**; cancelamento com
  motivo. Nada passa de situação sozinho: receber ou conferir a mercadoria não reembolsa.
- **Sem duplicidade:** o mesmo `requestKey` devolve o mesmo registro; a mesma operação (forma + referência externa) não
  entra duas vezes.
- **Teto:** a soma dos reembolsos não cancelados nunca passa do total do pedido. Gatilho no banco com o pedido travado,
  inclusive em registros simultâneos.
- **Marketplace:** pedido de marketplace só aceita a forma "marketplace" (registro do que a plataforma fez), e pedido
  da loja não aceita essa forma.
- O registro não altera `payments`, `orders.status` nem a NF-e.

### Documento fiscal da devolução
- O documento é **separado** da venda: chave de acesso (44 dígitos), número, série e data do documento emitido fora do
  sistema (NF-e do cliente, nota de entrada da loja ou outro). A NF-e de venda não é cancelada, e `invoice_status` não
  muda.
- Alternativa: **dispensa justificada**, só com `fiscal.manage` (MFA).
- A devolução de pedido com nota autorizada aparece como **pendência fiscal** até ter documento ou dispensa (C19). O
  sistema não sugere natureza nem CFOP: isso é do contador.

### Troca (D9-4)
- Na devolução do tipo troca, "Criar pedido de reposição" gera um **pedido separado**, ligado à devolução
  (`replacement_for_return_id`), um só por troca:
  - mesmo canal e mesmos itens/preços, com desconto igual ao subtotal, frete zero e **total zero**; marcado como pago,
    **sem cobrança nova** (nenhum pagamento é criado);
  - pacotes = quantidade devolvida ÷ unidades por pacote; quantidade quebrada é recusada (`REPLACEMENT_PACKS`);
  - não vale para marketplace (`MARKETPLACE_EXCHANGE`).
- A reposição segue o fluxo normal: alocação manual, remessa única (a trava de remessas múltiplas continua), NF-e e
  expedição pelas regras de sempre. Ela **fica fora da emissão automática de NF-e** e só despacha com a nota resolvida
  pelo fluxo fiscal existente.

### Devolução ao fornecedor (9b)
- Permissão `purchases.manage`; ver: `purchases.view`, `returns.manage` ou `stock.view`.
- **Rascunho** não mexe no estoque. Cada item diz de onde sai: livre, bloqueado ou avariado.
- **Enviar** = saída física confirmada, com o documento enviado obrigatório (transportadora e rastreio opcionais). Só
  então o estoque sai (`supplier_return`); bloqueado e avariado são liberados na mesma transação. Sem saldo, recusa
  (`INSUFFICIENT_STOCK`).
- **Aceita** encerra, sem crédito, abatimento ou e-mail automático. **Recusada** (a mercadoria voltou) estorna as
  saídas para o saldo de origem.

## Permissões

| Permissão | Para quê | MFA | Perfis |
|---|---|---|---|
| `occurrences.manage` | abrir e tratar ocorrências | não | gerente, logística |
| `returns.manage` | autorizar devoluções, conferir, decidir quarentena, registrar documento fiscal, criar reposição | não | gerente, logística |
| `returns.receive` | receber e conferir | não | gerente, logística (expedição) |
| `refunds.record` | registrar e atualizar reembolsos | **sim** | gerente, financeiro |
| `fiscal.manage` | dispensa do documento fiscal | **sim** | (já existente) |
| `purchases.manage` | devolução ao fornecedor | não | (já existente) |

## Conferência do estoque (C14–C21)

C1–C13 não mudaram. A `stock_reconcile()` ganhou:

| Código | Conferência |
|---|---|
| C14 | devolvido (devoluções não canceladas) ≤ despachado, por item do pedido |
| C15 | conferido (menos estornos) = entradas `return` da devolução (menos estornos), por item |
| C16 | quarentena aberta ≤ saldo bloqueado do depósito |
| C17 | soma dos reembolsos não cancelados ≤ total do pedido |
| C18 | pagamento marcado como devolvido pelo provedor depois da implantação, sem registro de reembolso |
| C19 | devolução concluída de pedido com nota autorizada, sem documento nem dispensa |
| C20 | pedido `on_hold` sem ocorrência aberta que segure |
| C21 | devolução ao fornecedor enviada ou aceita = saídas `supplier_return` (menos estornos), por item |

C18 só olha pagamentos alterados depois de `logistics_settings.returns_since` (o momento da migração), para não
acusar devoluções antigas feitas antes da Fase 9.

## Migração 0028

Aditiva e compatível com o código anterior. Não edita as migrações 0020–0027.
- **Tabelas novas:** `logistic_occurrences`, `occurrence_events`, `customer_returns`, `customer_return_items`,
  `return_inspections`, `quarantine_decisions`, `return_events`, `refund_records`, `refund_events`,
  `return_fiscal_documents`, `supplier_returns`, `supplier_return_items`, `supplier_return_events`. Eventos,
  conferências, decisões, documentos e itens são imutáveis (gatilho `forbid_mutation`).
- **Colunas novas:** `orders.replacement_for_return_id` (única), `order_events.internal` (padrão `false`),
  configurações de prazo e `returns_since` em `logistics_settings`.
- **Checagens ampliadas:** `orders.logistics_status` aceita `on_hold`; `orders_total_cents_check` aceita total zero só
  para reposição; `stock_movements` aceita `supplier_return` e as origens novas; a função de estorno aceita os
  movimentos novos.
- **Bloqueios:** `orders`, `stock_movements`, `stock_reconciliations`, `logistics_settings` e `order_events` em modo
  exclusivo, e leitura protegida em remessas, itens, depósitos, usuários e variantes; até 10 s de espera, com aviso
  `0028: bloqueios obtidos em … ms`.
- **Down:** remove só o que a 0028 criou e **recusa** se houver ocorrência, devolução, reembolso, documento,
  devolução ao fornecedor, pedido de reposição, movimento de estoque de devolução, pedido `on_hold`, divergência
  C14–C21 registrada ou política de prazos alterada. A conferência ganhou a coluna `stock_reconciliations.ref_id`
  (registro de origem da divergência).

## Riscos conhecidos

- **Natureza fiscal da reposição.** O pedido de reposição tem total zero. A emissão manual da NF-e segue as regras
  existentes, mas a natureza da operação (remessa em troca, CFOP) precisa da orientação do contador antes do uso real.
  A tela avisa.
- O pedido de reposição copia a forma de pagamento do original só como informação; nenhum pagamento é criado.
- C18 depende de `payments.updated_at`: uma atualização posterior de um pagamento já devolvido antes da migração pode
  gerar um aviso a ser conferido.
- Dados reais de devolução ainda não foram exercitados nas telas de detalhe pelo e2e (o banco de demonstração não tem
  devoluções); as regras estão cobertas na suíte da API.
