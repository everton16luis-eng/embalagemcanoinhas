# SGLog Fase 6: compras e recebimento por depósito (planejamento)

Situação: **planejamento, aguardando aprovação.** Nada foi implementado.

Base: `main` em `0695c56`, publicada e implantada na VPS de testes, com a 0024 aplicada. A Fase 5 está encerrada
funcionalmente (docs/26 e docs/27). As pendências fiscais e externas continuam em `docs/TESTES-PENDENTES.md`.

> **Numeração.** Em `docs/ACOMPANHAMENTO.md`, "Fase 6" é a Central comercial, de outra trilha. Este documento trata da
> **Fase 6 do SGLog** (docs/sglog-fase0-auditoria.md §5.6 e §7).

## 1. Escopo previsto no planejamento geral

| Fonte | O que ficou para a Fase 6 |
|---|---|
| sglog-fase0 §5.6 | Migração `0025_sglog_compras`: finalidade da compra (reposição × atendimento), aprovação, pagamento e rastreio da compra; `purchase_receipts.warehouse_id`; `purchase_receipt_issues` (divergências imutáveis); quantidade reprovada vai para avariado ou bloqueado, nunca para o disponível |
| sglog-fase0 §5.11 | Permissões `purchases.approve` (MFA) e `purchases.receive`, que separa o recebimento de `purchases.manage` |
| sglog-fase0 §8 | Caso obrigatório 10: dois recebimentos; o estoque entra só no que foi conferido; a divergência fica registrada |
| docs/22 e docs/23 | Até a Fase 6, a compra só entra no depósito padrão, e por isso a encomenda tem o padrão como destino |
| docs/25 §3.6 e docs/26 (D5-10) | A conversão definitiva da reserva de encomenda (`backorder` → firme) no recebimento, por ordem de pagamento. A Fase 5 só calcula a liberação |

Fora da Fase 6, como no plano geral:
- solicitação ao fornecedor (`supplier_requests`) e volumes: Fase 7;
- frete e etiqueta: Fase 8;
- devolução ao fornecedor, ocorrências e reembolso: Fase 9;
- margem e relatórios de custo: Fase 10.

## 2. Como funciona hoje

| Parte | Hoje | Lacuna |
|---|---|---|
| Pedido de compra (`purchases.ts`, 0004) | `draft → sent → partial/received`, ou `canceled`. Rateio de frete e despesas no custo. Mínimo e múltiplo com justificativa (Fase 2) | Sem finalidade, sem destino, sem aprovação, sem registro de pagamento nem de rastreio |
| Recebimento | Parcial, imutável, com `request_key`. Gera o movimento `receipt` com o custo efetivo. Recusa receber acima do pedido (`OVER_RECEIPT`) | Sempre no depósito padrão (`moveStock` sem depósito). Só registra a quantidade aceita: falta, avaria e preço diferente não ficam registrados |
| Permissão | `purchases.manage` cria, envia e **recebe** | O comprador dá entrada no estoque sozinho (limitação aceita na Fase 1) |
| Encomenda (Fase 4) | O atendimento `purchase_to_order` reserva no depósito de destino com `backorder = true`. A coluna `fulfillments.purchase_order_id` existe, mas **nunca é preenchida** | Não se sabe que compra atende que pedido |
| Liberação da encomenda (Fase 5, D5-10) | Calculada na separação: físico − reservas firmes precisa cobrir esta encomenda e as pagas antes dela (`AWAITING_GOODS`) | A reserva continua `backorder` para sempre. A fila é refeita a cada separação |
| Custo | `avg_cost_cents` (custo médio) por variante, atualizado no `receipt`. `purchase_receipt_items.unit_cost_cents` guarda o custo efetivo. Histórico do preço do fornecedor (Fase 2). A alocação copia o custo da oferta | Não há ligação de "este pedido de cliente foi atendido por esta compra e este recebimento" |
| XML de compra (`purchase_invoices`, 0007) | Guarda o XML e confere com o pedido de compra | Não alimenta o recebimento |

**Disponibilidade na vitrine.** A reserva de encomenda já entra em `reserved`. A mercadoria que chega não aparece
como disponível para outra venda enquanto cobre encomendas abertas (disponível = físico − reservado). A Fase 6
mantém isso: **a vitrine e o checkout não mudam.**

## 3. Regras de negócio propostas

### 3.1 Pedido de compra: finalidade, destino, aprovação, pagamento

- **Finalidade:**
  - `replenishment` (reposição do estoque);
  - `fulfillment` (encomenda de pedidos de clientes).
  - Os pedidos de compra antigos viram `replenishment`.
- **Destino:** `warehouse_id`, obrigatório.
  - Os antigos e os novos sem escolha usam o depósito padrão.
  - O destino só muda até o primeiro recebimento.
- **Aprovação (D6-3):**
  - `draft → pending_approval → approved → sent`. Quem aprova precisa de `purchases.approve`, com MFA.
  - Pedido de compra abaixo do limite configurado vai direto para `approved`. O limite padrão é proposto em D6-3.
  - Alterar um pedido aprovado o devolve para `draft`.
  - O pedido não aprova a si mesmo: quem criou não aprova (D6-4).
- **Pagamento:** só **registro**, como o reembolso da Fase 9. O SGLog não move dinheiro.
  - Campos: `paid_at`, `payment_ref` e observação.
  - Quem registra: D6-5.
- **Rastreio da compra:** transportadora e código, à mão. Só informativo.
- **Pedido de compra de encomenda:**
  - nasce da tela de alocação ou da fila de encomendas: "Gerar pedido de compra";
  - vem preenchido com as encomendas abertas daquele fornecedor no depósito;
  - cria os **vínculos** do §3.2.

### 3.2 Vínculo entre encomenda e compra

Tabela nova, `purchase_order_links`: item do pedido de compra × alocação de encomenda × quantidade.
- Mesma variante e mesmo depósito. A soma por item da compra não passa do pedido, e a soma por alocação não passa
  da alocação. Gatilhos garantem isso, como o teto da 0023.
- O vínculo é **prioridade**, não exclusividade: na chegada, a mercadoria vai primeiro para as encomendas
  vinculadas àquela compra; o que sobra segue a fila geral (§3.4).
- Trocar ou desfazer a alocação cancela o vínculo, com o motivo. A compra continua válida e vira reposição na prática.
- `fulfillments.purchase_order_id` passa a ser preenchido quando houver uma compra só, ou fica para exibição (D6-2).

### 3.3 Recebimento por depósito

- O recebimento entra no **destino do pedido de compra** (`purchase_receipts.warehouse_id`).
- Receber em outro depósito: D6-6. A proposta é recusar e pedir a correção do destino antes do primeiro recebimento,
  ou receber no destino e transferir (Fase 3).
- A permissão passa a ser `purchases.receive` (D6-1).
- **Linha a linha:**
  - quantidade que chegou;
  - quanto foi aceito e quanto foi recusado, com o motivo;
  - custo da nota, opcional (§3.5).
- **O que entra no estoque:**
  - **aceito:** movimento `receipt` no depósito, com custo. É o mesmo de hoje, mas no depósito;
  - **recusado por qualidade:** movimento de quarentena, que vai para o saldo **bloqueado**, ou de avaria, que vai
    para o **avariado**. Nunca vai para o disponível. A decisão (devolver ao fornecedor ou descartar) fica para a
    Fase 9; até lá, liberação ou perda pelas rotas da Fase 3;
  - **falta:** chegou menos do que a nota ou o pedido diz. Fica registrada como divergência. Nada entra no estoque.
- **Divergências** (`purchase_receipt_issues`, imutável):
  - tipo: `quantity`, `quality`, `price` ou `wrong_item`;
  - esperado, encontrado, quantidade, destino (`blocked`, `damaged` ou nenhum), nota, quem e quando.
- **Pedido de compra:**
  - `received_packs` conta o que o fornecedor entregou, aceito ou recusado (D6-7);
  - continua `partial` até completar ou ser encerrado.
  - Excedente continua recusado (`OVER_RECEIPT`), como hoje.
- **Encerrar com falta** (`/close`, que já existe): as encomendas vinculadas ao saldo que não vem perdem o vínculo.
  - Elas vão para a fila geral.
  - O pedido do cliente recebe aviso para a pessoa decidir (outra compra ou outra origem).
  - O pedido não muda de situação sozinho (D6-8).

### 3.4 Conversão da encomenda em reserva firme

Feita **na mesma transação do recebimento**, depois da entrada no estoque, por variante e depósito:

1. **Mercadoria livre para encomendas** = físico do depósito − reservas firmes − separado em aberto, como na Fase 5.
2. **Ordem:**
   - primeiro as encomendas **vinculadas a este pedido de compra**;
   - depois as demais encomendas ativas da variante no depósito;
   - em cada grupo, pela data de pagamento do pedido (`paid_at`), a mais antiga primeiro: é a regra D5-10, que vira
     definitiva.
3. **Converte a reserva inteira** quando a mercadoria livre a cobre (D6-9): `backorder` vira `false`.
   - Reserva que não é coberta por inteiro continua encomenda, e a fila para nela. A seguinte não passa na frente,
     para não inverter a prioridade.
   - Com as remessas múltiplas travadas, a reserva só ajuda inteira: o pedido sai numa remessa só.
4. **Registro imutável** em `reservation_conversions`: reserva, pedido, recebimento, quantidade, regra aplicada, quem
   e quando.
5. **Nada muda no pedido do cliente:** nem `orders.status`, nem `logistics_status`.
   - A remessa pendente da Fase 5 passa a mostrar "mercadoria chegou".
   - A separação da reserva firme segue o caminho normal da Fase 5, com a trava de físico.
   - O cálculo `AWAITING_GOODS` fica só para as encomendas antigas.
6. **Fora do recebimento:** "Reprocessar encomendas" (`logistics.manage`) roda a mesma conversão. Serve para estoque
   que chegou por ajuste, transferência ou devolução, e para as encomendas antigas (D6-10). Mostra antes o que vai
   converter.
7. **Prioridade manual (D6-11):** quem tem `logistics.manage` pode adiantar uma encomenda na fila, com justificativa
   e registro. Por padrão, só a data de pagamento.

### 3.5 Custo e rastreabilidade

- O custo efetivo do recebimento continua: embalagem + rateio de frete e despesas.
- **Preço da nota diferente do pedido de compra:**
  - informar o custo real na linha;
  - acima da tolerância (D6-12), exige justificativa e cria divergência `price`;
  - o custo médio usa o custo real.
- **Cadeia rastreável:** pedido do cliente → alocação → vínculo → item da compra → recebimento (com depósito e custo)
  → movimento `receipt` → conversão da reserva → remessa (Fase 5) → movimento `sale` no despacho.
- **Custo da alocação:** fica como foi copiado, como previsão. O custo realizado é o do recebimento. A margem por
  pedido fica para a Fase 10, que terá os dois.
- **XML de compra:** continua para conferência. Ao vincular, a tela de recebimento sugere as quantidades e o custo da
  nota, sempre conferidos pela pessoa. Não há entrada fiscal automática: **a NF-e de compra não muda.**

### 3.6 Ligação com a Fase 5

- **Separação:**
  - reserva convertida separa como estoque próprio;
  - encomenda ainda não convertida continua com `AWAITING_GOODS`, que fica como rede de segurança.
- **Trocar ou desfazer alocação:** as regras de `allocationLock` não mudam. Os vínculos da alocação desfeita são
  cancelados com o motivo.
- **Cancelamento do pedido do cliente:**
  - libera a reserva, como hoje;
  - o vínculo é cancelado;
  - a mercadoria que chegar fica livre ou converte a próxima da fila.
- **Expedição, NF-e de venda, remessas múltiplas e dropshipping:** sem mudança e travados como estão.
- **Marketplace:** sem impacto, porque só usa estoque próprio (D4 e `ownOnly`).
- **`ALLOCATION_AUTO`:** continua desligado. A conversão não aloca nada: só firma reservas que já existem.

## 4. Migração prevista: `0025_sglog_compras`

**Princípio (lição da 0024):** a 0025 deve ser **compatível com o código atual (`0695c56`)**. Só acrescenta;
coluna nova com padrão ou preenchida por gatilho; nada que o código antigo use é removido. Assim, se o código novo
falhar, a volta é **só de código**, sem desfazer a migração (D6-13).

```
purchase_orders
  + purpose text NOT NULL DEFAULT 'replenishment' CHECK (purpose IN ('replenishment','fulfillment'))
  + warehouse_id uuid REFERENCES warehouses  -- preenchido com o padrão; gatilho BEFORE INSERT completa o nulo
  status CHECK += 'pending_approval', 'approved'
  + approved_by, approved_at, approval_note
  + paid_at, payment_ref, payment_note       -- só registro
  + carrier, tracking_code
  CHECK: approved_* juntos; status 'approved'/'sent'/... depois da aprovação só com approved_at (exceto legados)

purchase_receipts
  + warehouse_id uuid REFERENCES warehouses
  -- tabela imutável: as linhas antigas NÃO são reescritas e ficam nulas (= depósito padrão), o mesmo
  -- precedente da 0020 em stock_movements; o gatilho BEFORE INSERT preenche as novas com o destino do
  -- pedido de compra quando o código antigo não informa

purchase_receipt_items
  + rejected_base_qty numeric(14,3) NOT NULL DEFAULT 0   -- recusado, fora do disponível
  + invoiced_unit_cost_cents numeric(16,4)               -- custo da nota, quando informado

purchase_receipt_issues (imutável)
  id, receipt_id, item_id, kind ('quantity','quality','price','wrong_item'), expected, found, qty,
  destination ('blocked','damaged','none'), note (3..500), actor_id, created_at

purchase_order_links
  id, purchase_order_item_id, allocation_id, base_qty > 0, status ('active','canceled'), cancel_reason,
  created_by, created_at, closed_at
  gatilhos: mesma variante e depósito; soma por item da compra ≤ pedido; soma por alocação ≤ alocação

reservation_conversions (imutável)
  id, reservation_id, order_id, receipt_id NULL (reprocessamento manual), qty, rule ('linked','queue','manual'),
  note, request_key UNIQUE, actor_id, created_at

reservation_priorities (imutável; a última vale)            -- só se D6-11 for aprovada
  reservation_id, position_hint, justification, actor_id, created_at

logistics_settings
  + purchase_approval_min_cents bigint NOT NULL DEFAULT 0   -- limite D6-3
  + purchase_price_tolerance_pct numeric(5,2) NOT NULL DEFAULT 0  -- tolerância D6-12

stock_reconcile(): C12 e C13
  C12  por recebimento: aceito = movimentos 'receipt'; recusado = movimentos para bloqueado/avariado
  C13  conversões: reserva convertida é firme e a soma convertida não passa da reserva; vínculo ativo não passa
       do item da compra nem da alocação

Permissões (código): purchases.approve (MFA) e purchases.receive.
```

**Bloqueios da migração:** os mesmos cuidados da 0021 e da 0023, com `LOCK ... NOWAIT` nas tabelas de compra. O tempo
esperado é de segundos, com poucas linhas de compra.

**Down:** remove tudo o que a 0025 criou. É recusado se já houver conversão, vínculo ou divergência registrados, ou
pedido de compra aprovado ou em `pending_approval`, como a 0024 faz com a expedição usada.

## 5. Implantação (o mesmo procedimento da Fase 5)

1. Conferência só de leitura:
   - pedidos de compra abertos;
   - recebimentos;
   - encomendas ativas por depósito;
   - encomendas antigas que o físico já cobre.
2. Backup verificado.
3. Ensaio da 0025 numa cópia (`migrate-rehearsal`), com C1–C13 e contagens antes e depois.
4. Parar a API → migrar → build → reiniciar.
   - Com a 0025 compatível, a ordem continua sendo a segura, mas a volta passa a ser só de código.
5. Bloco de conferência no estilo da 5.1:
   - última migration 0025;
   - travas ligadas;
   - C1–C13;
   - nenhuma conversão feita sozinha na migração.
6. Validação no navegador: compra de encomenda, aprovação, recebimento parcial com divergência, conversão e separação.
   Tudo em dados de teste da VPS, sem tocar nos pedidos demonstrativos que você quiser preservar.

**Encomendas antigas:** a migração não converte nada. A conversão das encomendas antigas é um passo seu, depois da
validação, pelo "Reprocessar encomendas" com prévia (D6-10).

## 6. Riscos

| # | Risco | Tratamento |
|---|---|---|
| R1 | **Deadlock:** a alocação trava pedido → variantes; o recebimento trava compra → variantes | A conversão só trava variantes e reservas e não toca em `orders`. Ordem fixa: compra → variantes (ordenadas) → reservas |
| R2 | **Duas conversões ao mesmo tempo** (dois recebimentos da mesma variante) | Trava da variante, a mesma da separação, e `request_key`. Teste de concorrência |
| R3 | **Prioridade invertida** por reserva parcial | Conversão só da reserva inteira, e a fila para na primeira não coberta (D6-9) |
| R4 | **Código antigo × banco novo** (como a 0024) | 0025 só acrescenta; teste explícito: a suíte da `0695c56` roda com a 0025 aplicada (D6-13) |
| R5 | **Comprador perde o recebimento** e trava a operação | Papéis padrão revisados (D6-1); exceção individual continua possível |
| R6 | **Aprovação atrasa a compra urgente** | Limite configurável (D6-3); o limite padrão é decisão sua |
| R7 | **Custo médio distorcido** por preço errado | Tolerância com justificativa (D6-12); divergência `price` registrada; estorno da Fase 3 |
| R8 | **Mercadoria recusada some do controle** | Vai para bloqueado ou avariado, com divergência; C12 confere |
| R9 | **Encomendas antigas** com mercadoria já no estoque | Continuam pelo cálculo da Fase 5 até o reprocessamento com prévia (D6-10) |
| R10 | **Tabelas imutáveis** recebendo coluna nova | As linhas antigas não são reescritas: coluna nula vale como o depósito padrão (precedente da 0020); ensaio na cópia |
| R11 | **Índice que falta** em `product_import_rows(product_id)` | Fora do escopo; a proposta de sessão separada continua (a migração pode entrar antes, como 0025, e a da Fase 6 vira 0026) |

## 7. Testes previstos (sem repetir os já aprovados)

- Compra:
  - finalidade e destino;
  - aprovação com MFA e limite;
  - quem criou não aprova;
  - alteração volta para rascunho;
  - registro de pagamento sem efeito em estoque.
- Recebimento:
  - por depósito;
  - parcial em duas vezes (caso 10 do plano geral);
  - recusa por qualidade vai para bloqueado ou avariado;
  - falta e preço diferente registrados;
  - excedente recusado;
  - `purchases.receive` separado de `purchases.manage`.
- Conversão:
  - vinculada primeiro;
  - fila por pagamento;
  - parcial não converte;
  - fila não pula;
  - concorrência entre dois recebimentos;
  - reprocessamento com prévia;
  - prioridade manual (se aprovada).
- Integração com a Fase 5:
  - reserva convertida separa como estoque;
  - não convertida segue com `AWAITING_GOODS`;
  - troca, desfazer e cancelamento cancelam os vínculos;
  - remessas múltiplas e dropshipping continuam travados.
- Banco:
  - C12 e C13 acusam divergência montada de propósito;
  - imutabilidade;
  - down recusado com dados.
- **Compatibilidade:** a suíte da `0695c56` com a 0025 aplicada (R4).
- Navegador (Playwright local):
  - telas de compra, aprovação e recebimento, a 375 px;
  - fila de encomendas.

## 8. Decisões que precisam da sua aprovação

| # | Decisão | Proposta |
|---|---|---|
| **D6-1** | Quem recebe mercadoria (`purchases.receive`) | `stock`, `logistics`, `manager` e `owner`. O `buyer` **deixa de receber** (separação entre quem compra e quem recebe) |
| **D6-2** | Ligação entre encomenda e compra | Tabela de vínculos (§3.2): várias compras por encomenda e vice-versa. O vínculo é prioridade, não exclusividade |
| **D6-3** | Aprovação de compra | Exigida a partir de um limite configurável. Proposta inicial: R$ 0 (toda compra é aprovada) na VPS de testes; o valor de produção é seu |
| **D6-4** | Quem cria não aprova | Sim. O `owner` pode aprovar a própria compra só com justificativa registrada |
| **D6-5** | Quem registra o pagamento da compra | `purchases.approve`. O `finance` continua só vendo |
| **D6-6** | Receber em depósito diferente do destino | Recusar. Corrigir o destino antes do primeiro recebimento, ou receber e transferir |
| **D6-7** | Recusado por qualidade conta como entregue no pedido de compra | Sim (o fornecedor entregou); fica em bloqueado ou avariado, com divergência |
| **D6-8** | Compra encerrada com falta | Desfaz os vínculos do saldo, avisa no pedido do cliente e não muda a situação sozinha |
| **D6-9** | Conversão parcial da reserva | Não: só a reserva inteira, e a fila para na primeira não coberta |
| **D6-10** | Encomendas antigas | A migração não converte; reprocessamento manual, com prévia, depois da validação |
| **D6-11** | Prioridade além da data de pagamento | Por padrão, só `paid_at`; adiantar manualmente com justificativa (`logistics.manage`). Aprovar ou deixar para depois |
| **D6-12** | Preço da nota diferente do pedido de compra | Tolerância configurável (padrão 0%); acima, justificativa e divergência `price`; o custo médio usa o preço real |
| **D6-13** | 0025 compatível com o código atual | Sim, como exigência: volta só de código; teste da suíte antiga com a 0025 |

Mantidos sem mudança: checkout, pagamentos, NF-e de venda, marketplaces, `ALLOCATION_AUTO` desligado, dropshipping e
remessas múltiplas travados, migrações 0020–0024 intactas.
