# SGLog — Fase 10: custos, margem de contribuição e gestão

Implementação do planejamento [40-sglog-fase10-planejamento.md](40-sglog-fase10-planejamento.md), com os ajustes
aprovados em 21/11/2026. Implantação em [42-sglog-fase10-implantacao.md](42-sglog-fase10-implantacao.md).

- **10a — base financeira** (`3a2f9a5`):
  - migração `0029_sglog_custos`;
  - configurações de custo versionadas;
  - lançamentos de custos externos (manual e planilha, com estorno);
  - margem de contribuição por pedido, com a origem de cada valor;
  - conferência C22–C24.
- **10b — gestão:**
  - Painel Gestão;
  - rentabilidade por pedido, produto, categoria, canal, fornecedor e UF;
  - custos logísticos;
  - desempenho de fornecedores;
  - indicadores;
  - CSV.

Nada nesta fase movimenta dinheiro, chama provedor ou altera checkout, pagamento, NF-e, pedido, estoque, despacho,
marketplace ou o relatório de vendas existente. Todas as telas da 10b são de leitura.

## 1. Regras

- **Só margem de contribuição, nunca lucro líquido.** A margem de contribuição é a receita menos os custos variáveis
  do pedido. Despesas fixas (aluguel, salários, sistemas) não entram. Todas as telas e o CSV dizem isso.
- **Cada valor tem natureza:**
  - **efetivo:** valor registrado (baixa do estoque, frete pago, lançamento, reembolso confirmado);
  - **estimado:** calculado por uma regra configurada e validada, ou por um custo médio que não é o da baixa;
  - **desconhecido:** sem registro e sem regra aplicável. Fica **sem valor** (`NULL`), nunca zero;
  - **informativo:** mostrado para rastreabilidade, fora da conta (reembolso apenas solicitado, devolução descartada).
- **Desconhecido não vira zero.**
  - O pedido com ao menos um componente desconhecido fica **parcial**, com a lista do que falta.
  - Os totais somam só efetivos e estimados. Por isso a margem de um pedido parcial fica **maior** que a real, e as
    telas avisam.
  - Os cartões de grupo (custos logísticos, taxas, tributos) marcam "parcial" quando falta componente do grupo.
- **Cobertura:**
  - pedidos completos sobre pedidos do recorte, e receita dos completos sobre a receita do recorte;
  - o painel mostra também a margem % só dos pedidos completos.
- **Recorte:**
  - entram os pedidos pagos (`paid`, `preparing`, `ready`, `shipped`, `delivered`);
  - não entram o pedido cancelado, o não pago e o **pedido de reposição da troca**. A reposição não é venda: o custo dela
    entra na margem do pedido de origem, como `exchange_cogs`. Hoje nunca aparece, porque a emissão e o despacho da
    reposição seguem bloqueados.
- **Demonstração:**
  - pedido de demonstração é o do comprador `@demo.invalid` ou o de conta de marketplace `DEMO-*`;
  - fornecedor de demonstração é o que tem `(demonstração)` no nome;
  - o filtro tem três opções: incluir (padrão, com aviso), excluir e só demonstração.

## 2. Fórmula usada

Por pedido (`lib/costs.ts`, `LINES_SQL`). Os custos entram com sinal negativo:

```
margem de contribuição = Σ linhas efetivas e estimadas
  = receita (mercadoria − desconto + frete cobrado)
  + CMV (baixas de venda − estornos; ou custo médio atual do que ainda não saiu)
  + custos logísticos (frete pago à transportadora + embalagem)
  + taxas e comissões (taxa do pagamento | comissão + tarifa do marketplace + frete do marketplace)
  + tributos (registrados, ou estimados pela alíquota validada)
  + devoluções (CMV devolvido ao estoque − perda na quarentena − frete de volta − reembolso)
  + outros custos lançados
margem % = margem ÷ receita
```

## 3. Origem de cada componente

| Componente | Grupo | Efetivo | Estimado | Desconhecido | Origem (rastreável) |
|---|---|---|---|---|---|
| Mercadoria, desconto, frete cobrado | receita | sempre | — | — | `orders` (subtotal, desconto, frete) |
| CMV da baixa (`cogs`) | CMV | baixa de venda com custo médio > 0 e sem entrada sem custo antes | média formada com saldo que entrou sem custo (entrada `receipt`/`return`/`adjustment`/`inventory` sem custo e média 0 antes da baixa) | custo médio 0 na baixa | `stock_movements` da venda (`avg_cost_after` da própria baixa) menos os estornos (`reverses_id`) |
| CMV sem baixa (`cogs_pending`) | CMV | — | custo médio atual > 0 | médio atual 0 | `stock_balances` (pedido pago ainda não despachado) |
| Frete pago (`freight_paid`) | logística | custo informado na remessa (Fase 8) | — | remessa de transportadora sem custo, não despachada, ou pedido sem remessa | `shipment_freight_costs` por remessa |
| Embalagem (`packaging`) | logística | — | regra validada do tipo (medidas da caixa em qualquer ordem) ou custo genérico por volume | sem regra ou ainda não embalado; retirada não tem | `shipments.packages` × `cost_settings` (`packaging`) |
| Taxa do pagamento | taxas | lançamento | regra validada (canal, meio, parcelas) sobre o valor pago | sem lançamento nem regra | `order_cost_entries` ou `cost_settings` × `payments` |
| Comissão e tarifa do marketplace | taxas | lançamentos (comissão + tarifa) | regra validada do canal | sem lançamento nem regra | `order_cost_entries` ou `cost_settings` |
| Frete do marketplace | taxas | lançamento | — | sem lançamento | `order_cost_entries` |
| Tributos | tributos | lançamento `tax` (registrado) | alíquota validada pelo contador sobre o total ou a mercadoria | sem lançamento nem alíquota | `order_cost_entries` ou `cost_settings` (`tax_rate`) |
| Outros | outros | lançamentos `other` (com observação) | — | — | `order_cost_entries` |
| Devolução ao estoque (`return_credit`) | devoluções | conferência boa, quarentena ou avariada pelo custo da venda | idem, pelo médio atual (venda sem custo) | — | `return_inspections` (estorno desconta) |
| Perda na quarentena (`return_loss`) | devoluções | descarte na quarentena | — | — | `quarantine_decisions` |
| Devolução descartada | devoluções | informativo (0) | — | — | `return_inspections` |
| Frete de volta | devoluções | valor informado | — | devolução por transportadora sem valor | `customer_returns.return_freight_cents` |
| Reembolso | devoluções | confirmado | realizado | — (solicitado = informativo) | `refund_records` |

### CMV histórico

O custo médio do estoque (`moveStock`) só é recalculado em **entrada com custo**. A saída por venda grava o custo
médio vigente em `avg_cost_after` e não muda a média. O `avg_cost_after` da **própria baixa de venda** é, portanto, o
custo unitário que o estoque baixou naquela saída. Compras posteriores não mudam o CMV de um pedido já baixado.

Não se usa o `avg_cost_after` de outro movimento nem o médio atual para um pedido já baixado. O médio atual só entra,
como estimado, para o que ainda não saiu do estoque.

### Devoluções e reembolsos, sem dupla contagem

| Caso | Efeito |
|---|---|
| Devolução física | Só muda a margem na conferência. Voltou ao estoque (boa, quarentena, avariada): o CMV volta (crédito). Descartada na conferência: sem crédito (o CMV da venda fica). |
| Quarentena descartada | Perda (`return_loss`), que desfaz o crédito daquela parte. |
| Baixa posterior de avaria da devolução | Só no relatório de perdas de estoque, que exclui a origem `customer_return` e `supplier_return` para não contar duas vezes. |
| Reembolso | Linha separada da devolução física. |
| Taxa importada | Bloqueia o lançamento manual do mesmo tipo, e vice-versa: um ativo por pedido e tipo, referência externa única, no banco. |

### Taxas, tributos e configurações

- **Configuração:** informada → validada. Só a validada entra no cálculo, pela vigência na data do fato (data do
  pagamento em Brasília), a mais específica primeiro.
- **Imutável.** Para corrigir, encerre a vigência e informe outra versão. As vigências validadas da mesma chave não se
  sobrepõem, e dois tipos de embalagem não podem ter as mesmas medidas (gatilho no banco).
- **Tributo estimado:** só vale validado por quem tem `fiscal.validate` (o contador). Guarda versão, vigência,
  origem e quem validou. Aparece separado do tributo registrado e nunca como valor fiscal definitivo.
- **Lançamento:**
  - imutável; a correção é por estorno, com motivo, numa linha nova de valor negativo;
  - a planilha CSV é conferida antes (prévia) e entra inteira ou nada;
  - o mesmo arquivo (hash) não entra duas vezes;
  - nenhuma API financeira nova.

## 4. Períodos

- **Base:**
  - data do pagamento (padrão), do pedido ou do **primeiro** despacho não cancelado, em Brasília;
  - cada tela e o CSV dizem a base;
  - até 366 dias por consulta.
- **Comparação:** com o período anterior de mesma duração, na mesma base.
- **Visão por safra:** devoluções, reembolsos e custos lançados depois entram **no pedido de origem, no período dele**,
  com a situação do momento da consulta. Um relatório de um mês passado pode mudar quando chega um custo ou uma
  devolução. Isso evita números incompatíveis entre filtros: a soma por canal, por produto ou por UF fecha com o total.
- **Exceções rotuladas:**
  - perdas de estoque e giro do estoque usam a **data do movimento**;
  - fornecedores usam a **data do recebimento**;
  - "agora" (rastreio parado, pagos sem despacho, ocorrências abertas) é a situação atual.

## 5. Rateio por produto, categoria e fornecedor

- **Direto ao item:** CMV e devolução.
- **Rateado pela participação do item na receita de mercadoria do pedido:** os custos do pedido (frete, embalagem,
  taxas, tributos, frete cobrado, desconto).
- A soma dos grupos fecha com o total, com diferença de no máximo 1 centavo por grupo (arredondamento).
- **Fornecedor:** o da alocação do item quando houver. Senão, o fornecedor principal do produto, marcado assim, porque a
  venda do estoque não guarda de qual compra saiu. Sem nenhum dos dois: "Sem fornecedor identificado".

## 6. Permissões

| Permissão | O que dá | MFA | Padrão |
|---|---|---|---|
| `costs.view` | custos (configurações, lançamentos, custos logísticos, valor do estoque) | não | gerente, financeiro |
| `margins.view` | margem do pedido, rentabilidade, valores do painel | não | gerente, financeiro |
| `management.view` | entrar no Painel Gestão e nos relatórios | não | gerente, financeiro |
| `costs.settings` | informar, validar, cancelar e encerrar configurações | sim | só o proprietário (concessão individual possível) |
| `costs.record` | lançar, importar e estornar custos externos | sim | financeiro |
| `fiscal.validate` (existente) | validar e encerrar a alíquota estimada | sim | quem o proprietário conceder |

- **Menor privilégio:**
  - quem vê pedidos não vê margem;
  - `management.view` sem `margins.view` vê só contagens, cobertura e indicadores operacionais;
  - logística, comprador, estoquista, expedição e atendimento não recebem nada novo.
- **Auditoria:** configuração (informar, validar, cancelar, encerrar), lançamento, estorno, importação e conferência.

## 7. Conferência C22–C24

- **C22 (`cost_reconcile()`, lançamentos):**
  - estorno diferente do original;
  - líquido negativo;
  - mais de um ativo por pedido e tipo;
  - referência externa repetida;
  - tipo incompatível com o canal.
- **C23 (`cost_reconcile()`, configurações):**
  - vigências validadas sobrepostas;
  - tipos de embalagem com as mesmas medidas.
- **C24 (API, `GET /admin/costs/reconcile`):** nos últimos 300 pedidos pagos, confere que:
  - a margem é igual à soma das linhas e à soma dos grupos;
  - nenhuma linha desconhecida tem valor.

C1–C21 (`stock_reconcile()`) não mudaram.

## 8. Desvios do planejamento

- **D10-2:** o cálculo da margem ficou em SQL montado no TypeScript (`lib/costs.ts`), agregado no banco, e não em
  funções SQL dentro da migração. Assim uma correção de regra não exige migração nova. Só C22 e C23 são funções da
  0029; a C24 roda na API.
- **Consultas gerenciais:** rodam numa transação só de leitura com `enable_nestloop = off`. As CTEs agregadas não
  têm estatística, e com estimativa baixa o planejador escolhia laço aninhado entre elas. Com 10 mil pedidos e
  estatísticas velhas, o resumo levava 26 s e o rateio por produto estourava o limite de 30 s. Agora levam menos de
  0,5 s.

## 9. Riscos e limitações

- **CMV:**
  - é o custo médio da baixa, não um custo por lote (o estoque não tem lote);
  - saldo que entrou sem custo deixa o CMV estimado ou desconhecido até haver entrada com custo.
- **Cobertura hoje:**
  - sem configurações validadas, toda margem fica parcial: taxa do pagamento, tributo e embalagem desconhecidos;
  - frete pago só existe onde foi informado na Fase 8.
- **Tributo estimado:**
  - é uma alíquota simples sobre uma base;
  - não reproduz o cálculo fiscal (ICMS-ST, DIFAL, créditos, regime);
  - só serve à gestão.
- **Taxa do marketplace:** sem integração, depende do lançamento manual ou da planilha.
- **Visão por safra:** números de meses fechados mudam com devoluções, reembolsos e lançamentos tardios.
- **Fornecedor da venda:** é atribuição pelo fornecedor principal, não origem comprovada.
- **Indicadores:**
  - o prazo de despacho mede do pagamento ao primeiro despacho ou retirada;
  - o rastreio "parado" usa 3 dias sem evento;
  - "pagos sem despacho" usa 2 dias.
- **Reposição da troca:** fica fora até a definição fiscal (a trava da Fase 9 continua).
