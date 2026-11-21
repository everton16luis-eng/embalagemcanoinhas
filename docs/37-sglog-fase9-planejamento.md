# SGLog — Fase 9: planejamento (ocorrências, devoluções, logística reversa, trocas e devoluções ao fornecedor)

**Situação: proposta para análise. Nada implementado.** A base é `sglog/fase8` em `7a2f7bd`. Na VPS roda `d76ca4f`, com
a 0027 aplicada. A Fase 8 foi validada funcionalmente, com ressalvas, em 21/11/2026 (veja
[TESTES-PENDENTES.md](TESTES-PENDENTES.md)).

Continuam como estão nesta fase:
- `ALLOCATION_AUTO` desligado;
- dropshipping, remessas múltiplas e e-mail automático ao fornecedor bloqueados;
- compra real de etiqueta bloqueada e `SHIPPING_LABELS_ENABLED` desligado. **Isso inclui a etiqueta de logística
  reversa.**

Também não mudam:
- checkout, cobrança e o fluxo de pagamento do Mercado Pago;
- emissão e cancelamento de NF-e de venda;
- `invoice_status`;
- o fluxo de entrega dos marketplaces;
- as migrações 0020–0027.

**Princípio da fase:** a devolução física (mercadoria que volta), o reembolso financeiro (dinheiro que volta) e o
documento fiscal (nota de devolução ou entrada) são três registros separados. Cada um tem sua situação, seu
responsável e sua prova. Um não conclui o outro automaticamente.

## 1. Escopo original e o que as fases anteriores deixaram

### 1.1 O que o plano geral previa ([sglog-fase0-auditoria.md](sglog-fase0-auditoria.md) §5.9, §7 e §8)

| Item previsto | Detalhe |
|---|---|
| Migração | `0028_sglog_ocorrencias` (número livre: a 0027 ficou com o frete) |
| `logistic_occurrences` | Liga pedido, remessa, item e alocação. Tipos: `damaged`, `lost`, `late`, `refused`, `wrong_item`, `regret`, `exchange`, `refund`, `reverse`. Responsável: `company`, `supplier`, `carrier`, `customer` ou `undetermined`. Situação: `open`, `in_progress`, `resolved` ou `canceled`. Também `blocks_completion`, `resolution` e `version` |
| `occurrence_events` | Histórico imutável |
| `returns` / `return_items` | Devolução com `reverse_label_id`, `refund_ref` e `refund_cents`. O item tem condição (`good`/`damaged`), que vira o movimento `return` ou a quarentena |
| Regra do dinheiro | "O reembolso é **registro** do que foi feito no Mercado Pago. O SGLog não move dinheiro" |
| Permissão | `returns.manage` |
| Casos obrigatórios | 15 (devolução parcial: estoque bom ou avariado conforme a condição); passo 8 da homologação (uma ocorrência aberta impede a conclusão) |
| Módulo I | "Estados, responsabilidades e retorno ao estoque", complexidade média |

### 1.2 O que já existe e será reaproveitado

- **Saldos por depósito (Fase 3, 0022):** `on_hand`, `reserved`, `blocked`, `damaged` e `in_transit`. Os movimentos
  `block`/`unblock` levam do físico ao bloqueado e de volta, e `damage_hold`/`damage_release` fazem o mesmo com o
  avariado. `damage` dá baixa, saindo do físico ou do avariado. `return` soma ao físico; hoje só é usado à mão, em
  Estoque, com motivo. `reversal` estorna um movimento. Os movimentos são imutáveis e passam pela reconciliação.
- **Remessas (Fase 5, 0024):** as situações `delivery_failed` e `returned` já existem. A Fase 8 só **registra** esses
  eventos, e a remessa continua em transporte: "o tratamento é da Fase 9". Os itens da remessa ficam em
  `shipment_items`, com alocação, item do pedido, variante e `base_qty`.
- **Despacho anterior:** as remessas `legacy` não têm `shipment_items`. A devolução de pedido antigo precisa partir de
  `order_items`.
- **Pagamentos:** `payments.status` já recebe `refunded` e `charged_back` do Mercado Pago, e o pedido grava um evento.
  O cancelamento de pedido pago responde `refundNeeded` e escreve "devolver o valor pelo painel do Mercado Pago". Não
  existe valor reembolsado nem reembolso parcial.
- **NF-e:** `fiscal_documents.purpose` aceita só `'sale'`. O cancelamento já é recusado no pedido com nota autorizada
  (`INVOICE_ACTIVE`). Não há nota de devolução nem de entrada.
- **Compras (Fase 6):** pedido de compra e recebimento com divergência. Não existe devolução ao fornecedor.
- **Marketplaces:** Shopee `TO_RETURN` e `IN_CANCEL` caem em `other`. A devolução é conduzida pela plataforma.
- **Custos (Fase 8):** `shipment_costs` com ajuste e estorno. Lá dá para lançar o frete de volta de uma remessa.

## 2. Escopo proposto

### 2.1 Entra na Fase 9

1. **Ocorrências logísticas.** Registro do problema: avaria, extravio, atraso, recusa, item errado, arrependimento,
   pedido de troca ou falha na entrega. Cada uma tem:
   - tipo, responsável, situação e prazo;
   - histórico imutável e anexos (fotos, laudo da transportadora);
   - resolução descrita.
   Toda ocorrência aberta segura a conclusão logística do pedido.
2. **Abertura a partir do rastreio.** Os eventos `delivery_failed` e `returned` da Fase 8 passam a abrir uma
   ocorrência para uma pessoa tratar. A abertura é idempotente: um evento abre uma ocorrência só. Nada muda no
   estoque.
3. **Devolução de cliente (física).** Autorizada pela loja, com quantidade por item (devolução parcial). Situações:
   - autorizada e aguardando envio;
   - em trânsito de volta;
   - recebida;
   - conferida;
   - concluída;
   - cancelada.
   A mercadoria só volta ao estoque **na conferência**: nunca quando a devolução é criada e nunca pelo aviso da
   transportadora.
4. **Conferência com condição por unidade conferida.** Cada condição tem seu destino:

   | Condição | Destino |
   |---|---|
   | Boa | Estoque disponível |
   | Em análise | Quarentena |
   | Avariada | Saldo avariado |
   | Descartada | Baixa com motivo |
   | Não recebida, ou menos que o esperado | Divergência registrada, sem movimento |

   Cada linha aponta a quantidade e o depósito que recebeu.
5. **Quarentena e decisão posterior.** O que está em análise sai da quarentena de três formas:
   - liberado para venda;
   - marcado como avariado;
   - baixado;
   - sempre com motivo e quem decidiu.
6. **Logística reversa manual.** A devolução registra como a mercadoria volta:
   - código de postagem ou autorização reversa, transportadora e rastreio;
   - o cliente pode trazer na loja;
   - a coleta pode ser combinada.

   O custo do frete de volta é lançado como custo, sem compra pelo sistema.
7. **Troca.** É uma devolução mais um envio de reposição. O formato do envio depende da decisão D9-4.
8. **Recusa na entrega.** A remessa que volta sem ter sido entregue segue o mesmo recebimento e a mesma conferência.
   Entra no estoque só o que chegou e foi conferido.
9. **Registro de reembolso (financeiro).** Valor, forma (Mercado Pago, Pix manual, crédito, marketplace), referência
   externa, data, quem registrou e comprovante. **O sistema não move dinheiro.**
   - O reembolso pode existir sem devolução física, por exemplo no extravio.
   - A devolução física pode existir sem reembolso, por exemplo na troca.
   - A conferência com o `payments.status` = `refunded` do Mercado Pago aparece na tela e na reconciliação.
10. **Pendência fiscal.** A devolução de pedido com NF-e autorizada fica com a pendência "documento fiscal de devolução"
    até alguém registrar o documento, com chave, número e arquivo ou a justificativa de "não exigido". **Esta fase não
    emite nota** (decisão D9-6).
11. **Devolução ao fornecedor.** Mercadoria avariada, errada ou fora do pedido, com ligação ao pedido de compra ou ao
    recebimento. Situações: rascunho, enviada, aceita (crédito ou reposição), recusada e cancelada. O estoque sai do
    avariado, da quarentena ou do disponível quando a mercadoria é enviada. A pendência fiscal é a mesma do item 10:
    nota de devolução de compra.
12. **Conclusão do pedido.** A conclusão logística (`logistics_status = 'completed'`) passa a exigir que não haja
    ocorrência aberta. A devolução não muda `orders.status`: o pedido entregue continua entregue, e a devolução
    aparece como situação própria.
13. **Telas.** Em Logística, entram Ocorrências e Devoluções, cada uma com lista, filtros e detalhe. Também:
    - os blocos "Ocorrências" e "Devoluções" no pedido e na remessa;
    - a Quarentena em Estoque;
    - Devoluções ao fornecedor em Compras.

    Tudo responsivo, a 375 px e no desktop.
14. **Relatórios.** Devoluções por motivo, responsável, produto e fornecedor. Também:
    - reembolsos registrados contra pagamentos devolvidos;
    - custo do frete de volta;
    - perdas por avaria.
15. **Reconciliação.** Novas conferências (C14 em diante, §5) no bloco 5.1.

### 2.2 Não entra (fica para depois ou para a sua decisão)

- Reembolso automático pela API do Mercado Pago (D9-5).
- Emissão automática de NF-e de devolução ou entrada (D9-6).
- Etiqueta reversa comprada pelo sistema. Fica bloqueada, como a etiqueta de ida.
- Pedido de devolução feito pelo cliente no site (D9-8). Na Fase 9, só a loja registra; o cliente vê a situação.
- Devolução dentro dos marketplaces. O sistema só registra a chegada física, a conferência e o estoque (D9-9).
- E-mail automático ao fornecedor sobre a devolução. Continua bloqueado; o documento sai impresso ou em PDF.
- Rentabilidade final por pedido. É da Fase 10, que vai consumir os registros desta fase.

## 3. Regras

### 3.1 Ocorrências
- **R9-1.** Cada ocorrência pertence a um pedido. Remessa, item e alocação são opcionais, e o tipo e o responsável são
  obrigatórios. Se o responsável ainda não é conhecido, fica `undetermined`, e a ocorrência não pode ser resolvida
  assim.
- **R9-2.** As transições permitidas são `open → in_progress → resolved` e `open|in_progress → canceled`:
  - cancelar e resolver exigem texto;
  - reabrir cria evento (`resolved → in_progress`) e exige motivo;
  - tudo com `version` (409 em conflito) e `requestKey` (idempotência), como nas fases anteriores.
- **R9-3.** Os eventos das ocorrências e das devoluções são imutáveis: o gatilho recusa UPDATE e DELETE, como nos
  movimentos de estoque.
- **R9-4.** Toda ocorrência aberta impede `logistics_status = 'completed'`. Na `completed` já gravada, a ocorrência
  nova não reabre nada sozinha: fica visível no pedido e na lista.

### 3.2 Devolução física e estoque
- **R9-5.** A quantidade autorizada por item do pedido não passa da quantidade **despachada** menos o que já foi
  devolvido. Nas remessas novas, a conta usa `shipment_items`; no despacho anterior, `order_items`. A trava fica no
  banco, por gatilho, com bloqueio de linha.
- **R9-6.** A conferência é a **única** que movimenta estoque. Ela grava os movimentos no depósito que recebeu, na
  mesma transação:
  - **boa:** `return` (+físico);
  - **avariada:** `return` + `damage_hold` (físico → avariado), sem mudar a forma dos movimentos da 0022 (D9-2);
  - **quarentena:** `return` + `block` (físico → bloqueado), com origem `return_item`. Sair da quarentena usa `unblock`
    e, se for o caso, `damage_hold` ou `damage`;
  - **descartada:** `return` + `damage` (baixa), com motivo.
  Cada movimento guarda `source_type = 'return_item'` e o id da linha. A reconciliação confere um contra o outro.
- **R9-7.** O aviso `returned` da transportadora não movimenta estoque nem conclui a devolução. Só abre a ocorrência e
  deixa a devolução "em trânsito de volta".
- **R9-8.** Item de fornecedor enviado direto (dropshipping, que continua bloqueado) ou de marketplace só volta ao
  estoque da loja se chegar fisicamente a um depósito da loja. Se voltar para o fornecedor, vira devolução ao
  fornecedor sem movimento no nosso estoque.
- **R9-9.** O custo da unidade devolvida volta pelo custo da venda. Não entra no custo médio como compra nova (D9-3).
- **R9-10.** A conferência tem estorno (`reversal`) com motivo, igual ao do estoque. Ela nunca é editada.

### 3.3 Reembolso (financeiro)
- **R9-11.** O reembolso é **registro**: valor em centavos, forma, referência externa (id do reembolso no Mercado
  Pago, código do Pix, protocolo do marketplace), data em que foi feito e comprovante opcional. Ele não chama nenhum
  provedor.
- **R9-12.** A soma dos reembolsos de um pedido não passa do valor pago, conferido no banco. Reembolsos parciais são
  aceitos. O de frete aparece separado do de mercadoria.
- **R9-13.** O reembolso tem permissão própria (D9-7), com MFA como as ações de dinheiro. Ele não depende de a
  devolução estar concluída, mas a tela avisa quando é registrado antes da conferência.
- **R9-14.** Se o Mercado Pago marcar `refunded` e não houver registro, a tela do pedido e a reconciliação apontam a
  diferença. O contrário também: registro de reembolso pelo Mercado Pago sem `payments.status = 'refunded'`. O
  `charged_back` (contestação) abre uma ocorrência do tipo `refund`, com responsável `undetermined`.

### 3.4 Obrigações fiscais (preservadas)
- **R9-15.** A NF-e de venda autorizada **não é cancelada** pela devolução. O cancelamento continua só no módulo
  fiscal, no prazo legal e antes da circulação. A devolução depois da entrega pede documento de devolução ou entrada, e
  `invoice_status` não muda.
- **R9-16.** Quem emite o documento depende de quem compra:
  - **consumidor final ou não contribuinte:** em geral, a loja emite a nota de entrada referenciando a chave da venda;
  - **contribuinte (PJ):** em geral, o cliente emite a nota de devolução.

  A natureza, o CFOP e a tributação ficam **a validar com o contador**, como na Fase 5. O sistema não sugere CFOP.
- **R9-17.** A devolução de pedido com nota autorizada só conclui com o documento fiscal registrado ou com a
  justificativa de "não exigido", com quem registrou. O pedido sem nota (`not_required`, demonstração) segue sem a
  pendência.
- **R9-18.** A devolução ao fornecedor tem a mesma pendência: nota de devolução de compra, emitida pela loja, ou nota
  do fornecedor, conforme o caso.

### 3.5 Permissões e rastreabilidade
- **R9-19.** Permissões:
  - `occurrences.manage`: abrir e tratar ocorrências (logística e atendimento);
  - `returns.manage`: autorizar, receber e conferir devoluções; decidir a quarentena;
  - `refunds.record`: registrar reembolso, com MFA;
  - `purchases.manage`: devolução ao fornecedor (já existe);
  - o perfil de expedição recebe e confere, mas não autoriza a devolução nem registra reembolso.
- **R9-20.** Tudo passa pela auditoria, com antes e depois. As telas do cliente mostram só a situação e as datas da
  devolução: sem nome de funcionário, nota interna ou responsável.

### 3.6 Prazos (registro; a política é sua)
- **R9-21.** A ocorrência e a devolução guardam a data de entrega e a da solicitação. A tela mostra os prazos de
  referência (D9-10), mas **o sistema não recusa** fora do prazo, só avisa. A decisão é de uma pessoa.

## 4. Migração prevista: `0028_sglog_devolucoes`

O nome é sugestão. O plano geral chamava de `0028_sglog_ocorrencias`, e o número fica o mesmo. Tudo é aditivo: tabelas
novas, colunas opcionais e checagens ampliadas por `DROP/ADD CONSTRAINT` na própria 0028, sem editar as migrações
0020–0027.

| Objeto | Conteúdo |
|---|---|
| `logistic_occurrences` | Como no plano geral, mais `source` (`manual`, `tracking`, `payment`), `tracking_event_id` único (idempotência do item 2), `due_at`, `resolved_by/at`, `canceled_reason` e `request_key` |
| `occurrence_events` | Imutável: tipo, situação antes e depois, nota, autor e data |
| `occurrence_attachments` | Arquivo com sha256 e tamanho, no padrão de `fiscal_files` |
| `customer_returns` | Pedido, ocorrência, remessa de origem opcional, situação, forma de volta (`carrier`, `store_dropoff`, `pickup`), transportadora, rastreio, depósito de recebimento, `fiscal_status` (`required`, `registered`, `not_required`), dados do documento fiscal, `version` e `request_key` |
| `customer_return_items` | `order_item_id`, `shipment_item_id` opcional (NULL no despacho anterior), variante, quantidade autorizada e quantidade recebida. A trava R9-5 é um gatilho |
| `return_inspections` | Linha por condição: `good`, `quarantine`, `damaged`, `discarded` ou `missing`. Guarda quantidade, depósito, ids dos movimentos gerados, motivo e autor. Imutável, com estorno |
| `quarantine_decisions` | Saída da quarentena (`release`, `damaged`, `discard`), com movimentos e motivo |
| `return_events` | Imutável |
| `refund_records` | Pedido, devolução e ocorrência opcionais, valor, parte do frete, forma, referência externa, `refunded_at`, comprovante, autor e `request_key`. A soma é travada contra o pago (R9-12) |
| `supplier_returns` / `supplier_return_items` | Fornecedor, pedido de compra ou recebimento opcional, situação, motivo, origem do saldo (`damaged`, `blocked`, `on_hand`), resultado (`credit`, `replacement`, `refused`), valor do crédito e pendência fiscal |
| `stock_movements` | O `source_type` passa a aceitar `return_item`, `quarantine_decision` e `supplier_return_item`. O movimento novo `supplier_return` sai do físico, do bloqueado ou do avariado, e a forma é acrescentada no `bucket_shape` da 0028 |
| `fiscal_documents.purpose` | Só se D9-6 for "emitir pelo sistema": acrescentaria `return_entry`. Com "só registrar", **não muda** |
| `shipments` | Sem coluna nova. A reposição da troca segue a decisão D9-4 |
| Permissões | `occurrences.manage`, `returns.manage` e `refunds.record`, nos perfis conforme R9-19 |
| `logistics_settings` | Colunas para os prazos de referência da tela (D9-10) e a exigência do documento fiscal (padrão ligado) |

A `down` remove só o que a 0028 criou, e recusa se houver devolução, reembolso ou movimento com origem nova: o mesmo
padrão da 0027. O ensaio segue o roteiro da Fase 8: up, down e up no local, a suíte anterior com a 0028 aplicada e o
bloco de ensaio na VPS **feito por você**.

## 5. Reconciliação (novas conferências)

| Código | Conferência |
|---|---|
| C14 | Devolvido por item do pedido ≤ despachado (remessas novas e despacho anterior) |
| C15 | Cada conferência tem os movimentos correspondentes: soma, depósito e tipo batem. Nenhum movimento `return_item` fica sem conferência |
| C16 | O saldo bloqueado com origem quarentena bate com as linhas em quarentena ainda sem decisão |
| C17 | Soma dos reembolsos registrados ≤ pago, por pedido |
| C18 | Os reembolsos pelo Mercado Pago batem com `payments.status` (`refunded`) nos dois sentidos. A diferença aparece como aviso, sem bloquear |
| C19 | Devolução concluída de pedido com nota autorizada tem documento fiscal ou "não exigido" registrado |
| C20 | Pedido `completed` sem ocorrência aberta da época da conclusão |
| C21 | Devolução ao fornecedor enviada tem a saída correspondente no estoque |

C1–C13 continuam iguais.

## 6. Testes previstos

- **Caso 15:** devolução parcial: 2 de 5 boas, 1 avariada, 1 em quarentena e 1 faltando. Saldos, movimentos e C14–C16
  corretos.
- Devolução no despacho anterior, sem `shipment_items`, pelo `order_items`.
- Devolver mais que o despachado: recusado no banco, mesmo em duas transações ao mesmo tempo.
- Recusa na entrega: o aviso `returned` abre uma ocorrência só, mesmo repetido, sem movimento de estoque, até a
  conferência.
- **Passo 8 da homologação:** ocorrência aberta impede `completed`; resolvida, conclui.
- Quarentena: liberar, avariar e baixar, com estorno da conferência.
- Reembolso:
  - parcial e total;
  - recusa acima do pago;
  - sem permissão (403) e sem MFA;
  - divergência com o `refunded` do Mercado Pago, nos dois sentidos;
  - o reembolso não altera `payments` nem `orders.status`.
- Fiscal:
  - devolução de pedido com nota autorizada não conclui sem documento ou justificativa;
  - `invoice_status` e `fiscal_documents` intactos, conferidos antes e depois.
- Devolução ao fornecedor: saída do avariado, crédito e recusa, com a pendência fiscal.
- **Caso 16:** 403 em cada rota nova para os perfis sem a permissão, em tabela.
- **Caso 17:** `loja_app` não altera nem apaga eventos, conferências e reembolsos.
- Telas (e2e, desktop e 375 px):
  - listas, detalhe e conferência;
  - reembolso separado da devolução;
  - página do cliente sem dados internos.
- Suíte anterior (498) verde com a 0028 aplicada.

## 7. Riscos

| Risco | Efeito | Mitigação |
|---|---|---|
| Estoque voltar antes da mercadoria chegar | Vende o que não existe | R9-6/R9-7: só a conferência movimenta; o aviso da transportadora não |
| Confundir devolução com reembolso | Dinheiro devolvido sem a mercadoria, ou o contrário, sem ninguém ver | Registros separados (R9-11), avisos cruzados na tela e C17/C18 |
| Cancelar NF-e por engano ou mexer em `invoice_status` | Problema fiscal | R9-15: nada nesta fase toca a nota de venda; os testes conferem antes e depois |
| CFOP ou natureza errados no documento de devolução | Autuação | O sistema não sugere: só registra o que o contador definiu (D9-6) |
| Troca exigir uma segunda remessa | Choca com remessas múltiplas bloqueadas | D9-4 |
| Despacho anterior sem itens de remessa | A trava de quantidade não teria base | R9-5 usa `order_items` no `legacy`; teste próprio |
| Custo médio distorcido pela volta | Margem errada na Fase 10 | R9-9 e D9-3 |
| Quarentena esquecida | Saldo parado e invisível | Lista com idade, aviso por prazo e C16 |
| Marketplace conduzir a devolução fora do sistema | Estoque e reembolso sem registro | Só registro da chegada física; reembolso com forma "marketplace" (D9-9) |
| Chargeback tratado como reembolso | Conta errada | O `charged_back` abre uma ocorrência, não um reembolso (R9-14) |
| Volume de telas novas | Prazo | Entrega em duas etapas (§8) |

## 8. Ordem de entrega sugerida

1. **9a:** a 0028, ocorrências (manual e pelo rastreio), devolução de cliente com recebimento e conferência, quarentena
   e bloqueio da conclusão. Testes 15, 16, 17 e o passo 8.
2. **9b:** reembolso (registro), pendência fiscal, troca (conforme D9-4), devolução ao fornecedor, relatórios e
   C17–C21.

Cada etapa tem implantação própria, com roteiro (doc 39) e o bloco 5.1 ampliado, **executados por você**.

## 9. Decisões que precisam da sua aprovação

| # | Decisão | Proposta |
|---|---|---|
| **D9-1** | Escopo da fase e divisão em 9a/9b (§2 e §8) | Aprovar como está |
| **D9-2** | Como representar quarentena e avaria na volta | Quarentena = saldo **bloqueado**, com origem `return_item`; avaria = `damage_hold`. Os dois movimentos são gravados juntos, sem mudar a forma dos da 0022. Alternativa: um saldo novo de quarentena, com mais mudanças em 6 módulos |
| **D9-3** | Custo da unidade que volta | Volta pelo custo da venda e não mexe no custo médio. A avaria entra como perda na Fase 10 |
| **D9-4** | Troca | Pedido de reposição **separado**, valor zero ou diferença, ligado à devolução: mantém remessas múltiplas bloqueadas. Alternativa: segunda remessa no mesmo pedido, que exige liberar remessas múltiplas |
| **D9-5** | Reembolso | Só **registro**, com MFA. O dinheiro é devolvido por você no painel do Mercado Pago (ou Pix ou marketplace). Reembolso pela API fica para depois, com a sua autorização |
| **D9-6** | Documento fiscal da devolução | Só **registrar** (chave, número, arquivo ou "não exigido"), sem emitir pelo sistema nesta fase. Exige a orientação do contador sobre quem emite e com qual CFOP, para consumidor e para PJ |
| **D9-7** | Permissões | `occurrences.manage`, `returns.manage`, `refunds.record` (MFA) e `purchases.manage` como em R9-19. A expedição recebe e confere; não autoriza nem reembolsa |
| **D9-8** | Pedido de devolução pelo cliente no site | Fica fora nesta fase. O cliente vê só a situação; quem registra é a loja |
| **D9-9** | Marketplaces | Só registrar a chegada física, a conferência e o reembolso feito pela plataforma, sem ação nas APIs |
| **D9-10** | Prazos de referência | Mostrar 7 dias após a entrega para arrependimento na compra a distância e 90 dias para defeito em produto durável. O sistema só avisa, nunca recusa. **A política de trocas e devoluções é sua** e deve ser confirmada com o jurídico ou o contador |
| **D9-11** | Ocorrência pelo rastreio | `delivery_failed` e `returned` abrem uma ocorrência automaticamente, sem estoque e sem mensagem ao cliente |
| **D9-12** | Mensagem ao cliente sobre a devolução | Sem mensagem automática nesta fase. A tela mostra o texto para envio manual pelo WhatsApp |
| **D9-13** | Devolução ao fornecedor | Entra na 9b, só com documento impresso ou PDF, porque o e-mail automático segue bloqueado |

Depois da sua aprovação (ou das mudanças), começa a 9a. Até lá, nada desta fase é implementado.
