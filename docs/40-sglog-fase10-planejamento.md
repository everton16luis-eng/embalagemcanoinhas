# SGLog — Fase 10: planejamento (custos, rentabilidade, indicadores e painéis gerenciais)

**Situação: planejamento para aprovação. Nada foi implementado.** Branch local `sglog/fase10`, a partir da `main`
(`d0f7a9b`). Nenhum merge, push, implantação ou comando na VPS.

Base: Fase 9 encerrada funcionalmente na VPS (`8c66097`, migração 0028, C1–C21 sem divergência), com as ressalvas de
[TESTES-PENDENTES.md](TESTES-PENDENTES.md). Essas ressalvas continuam pendentes e não entram nesta fase:
- página do cliente e permissões por perfil;
- documento fiscal da devolução;
- pedido segurado por ocorrência;
- definição fiscal da troca e da devolução pelo contador;
- política jurídica de prazos de devolução.

## 1. Escopo original e o que já existe

### 1.1 O que o plano geral previa ([sglog-fase0-auditoria.md](sglog-fase0-auditoria.md))

- **§7, Fase 10:** "Custos, visões de margem, relatórios e dashboards (dados reais, paginados)", dependendo das Fases
  6 a 9.
- **§5.10, migração `0029_sglog_custos`:**
  - `payments.fee_cents` (taxa do pagamento, informada ou obtida do provedor);
  - `cost_settings`: alíquotas e taxas parametrizadas, com histórico, no padrão "informado → validado" de
    `fiscal_rules`;
  - `packaging_materials` (opcional): custo de caixa e fita por volume;
  - visões `v_shipment_costs`, `v_order_margin`, `v_margin_by_product`, `v_margin_by_supplier` e
    `v_freight_by_region`.
- **Regra já aprovada:** a margem só se chama **"margem de contribuição"**. "Lucro líquido" não aparece enquanto
  `cost_settings` não estiver validado.
- **§3, item 12:** custo de embalagem e de frete por remessa, taxa do pagamento, `cost_settings` e visões de margem.
- **§5.11:** permissão nova `costs.view`.
- **§9:** complexidade "média", com a ressalva de que depende de alíquotas validadas pelo contador.

### 1.2 O que as fases anteriores já registram (fontes da Fase 10)

| Fonte | Onde está | O que dá |
|---|---|---|
| Receita do pedido | `orders` (`subtotal_cents`, `discount_cents`, `freight_cents`, `total_cents`), `order_items` (`unit_price_cents`, `list_price_cents`, `total_cents`) | Receita de mercadoria, desconto e frete cobrado, por item |
| Custo da mercadoria vendida | `stock_movements` do tipo `sale` (`avg_cost_after`, gravado na baixa) | Custo médio na data da saída. O relatório de vendas atual ([sales-reports.ts](../apps/api/src/modules/sales-reports.ts)) já usa isso e cai no médio atual quando o pedido não saiu (`costMissing`) |
| Custo de compra | `purchase_receipt_items` (`unit_cost_cents`, `allocated_extra_cents` com frete e despesas rateados), `supplier_price_history` | Custo de entrada por fornecedor e por recebimento |
| Origem da mercadoria | `fulfillment_allocations` (`unit_cost_cents`, fornecedor, depósito) | De onde saiu cada item e o custo copiado na alocação |
| Frete | `orders.freight_cents` (cobrado), `shipping_quotes.price_cents` (cotado), `shipment_freight_costs` (pago, ajuste e estorno; Fase 8), rateio do cobrado por remessa | Cobrado × cotado × pago por remessa. O relatório da Fase 8 já existe |
| Embalagem e volumes | `shipments.volumes`, `weight_g`, `packages` (Fase 5) | Quantidade e medidas dos volumes. **Não há custo** |
| Perdas | `stock_movements` `loss`, `damage`, `transfer_loss`, `inventory` e `adjustment` negativos, com custo médio | Perda a custo médio, por depósito e motivo |
| Devoluções | `return_inspections` (condição, custo da venda), `quarantine_decisions`, `refund_records` (Fase 9) | Volta ao estoque, avaria, descarte e reembolso registrado |
| Fornecedores | `/admin/supply/performance` (Fase 7): prazo de confirmação, prazo real × cadastrado, pontualidade, alterações e recusas; `purchase_receipt_issues`; `supplier_returns` | Desempenho operacional. **Sem custo e sem qualidade** (devolução e avaria por fornecedor) |
| Pagamento | `payments` (`amount_cents`, `method`, `installments`, `status`) | Valor pago e forma. **Sem taxa** |
| Marketplace | `marketplace_orders.snapshot` (`status`, `totalCents`, `items` com preço) | Venda bruta. **Sem comissão, tarifa nem frete do marketplace** |
| Empresa | `company_settings.tax_regime` | Regime tributário informado. **Sem alíquota** |

## 2. Efetivo, estimado e desconhecido

A regra central da fase: **cada valor exibido carrega a sua natureza**, e nenhum desconhecido vira zero.

| Natureza | Significado | Exemplo |
|---|---|---|
| **Efetivo** | Vem de um registro do sistema, de um documento ou do provedor, com a origem rastreável | Preço vendido, custo de saída do estoque, frete pago informado, reembolso confirmado, perda baixada |
| **Estimado** | Calculado por uma regra parametrizada em `cost_settings` (com versão, quem informou e quem validou) ou por um dado de referência | Imposto pela alíquota do regime, taxa do cartão pela tabela, custo de embalagem por volume, frete pela cotação quando não há pago |
| **Desconhecido** | Não há registro nem regra validada | Comissão do marketplace sem registro, taxa do Pix sem tabela, frete pago não informado |

Classificação de cada componente, hoje e com a Fase 10:

| Componente | Hoje | Com a Fase 10 |
|---|---|---|
| Receita de mercadoria e frete cobrado | Efetivo | Efetivo |
| Descontos | Efetivo | Efetivo |
| Custo da mercadoria (pedido despachado) | Efetivo (custo médio na saída) | Efetivo |
| Custo da mercadoria (ainda não despachado) | Estimado (médio atual) | Estimado, rotulado |
| Custo médio herdado de saldo sem custo (zero) | Tratado como zero no relatório atual (`cost_missing`) | **Desconhecido**, nunca zero |
| Frete pago à transportadora | Efetivo quando informado; senão desconhecido | Igual; estimado pela cotação só se D10-6 aprovar |
| Frete de marketplace | Fora do frete da loja | Desconhecido até registro (D10-5) |
| Taxa do meio de pagamento | Desconhecido | Efetivo se registrada ou obtida do provedor; estimado pela tabela; senão desconhecido (D10-4) |
| Comissão e tarifas do marketplace | Desconhecido | Efetivo se registrada; estimado pela tabela; senão desconhecido (D10-5) |
| Impostos sobre a venda | Desconhecido | Estimado pela alíquota validada pelo contador (D10-3). Nunca "efetivo" nesta fase |
| Embalagem de envio | Desconhecido | Estimado por volume (D10-7) |
| Devolução (reembolso) | Registrado (Fase 9) | Efetivo só quando **confirmado**; solicitado aparece à parte |
| Devolução (mercadoria) | Movimentos da Fase 9 | Efetivo: volta a custo da venda; avaria e descarte como perda |
| Perdas e avarias de estoque | Movimentos | Efetivo a custo médio |

Todo total mostra a **cobertura**: quanto da receita do período tem cada componente efetivo, estimado ou desconhecido.
Por exemplo: "frete pago conhecido em 23 de 401 remessas".

## 3. Escopo proposto

### 3.1 Entra na Fase 10

**10a: base de cálculo e rastreabilidade**
1. **`cost_settings`** versionado: alíquota estimada de impostos por regime e canal, tabela de taxas por meio de
   pagamento e parcelas, comissão de referência por marketplace, custo de embalagem por volume. Fluxo "informado →
   validado" de `fiscal_rules`, com histórico imutável e vigência por data.
2. **Custos externos do pedido** (`order_cost_entries`): lançamentos efetivos de taxa de pagamento, comissão e tarifa
   de marketplace, frete do marketplace e outros. Com origem (manual, provedor), referência, autor, `request_key` e
   estorno. Imutável, como `shipment_freight_costs`.
3. **Cálculo da margem de contribuição por pedido** (função SQL ou módulo, D10-2): uma linha por componente, com
   valor, natureza e origem (tabela e id). Sem materializar.
4. **Rastreabilidade:** cada número de relatório abre o detalhe dos componentes e cada componente aponta para o
   registro de origem (movimento, lançamento, reembolso, versão de `cost_settings`).

**10b: relatórios, indicadores e painéis**
5. **Rentabilidade:** por pedido, produto, categoria, canal, fornecedor (da alocação) e região (UF do destino),
   paginados, com exportação CSV.
6. **Custos logísticos consolidados:** frete (cobrado × cotado × pago, por transportadora e por UF), embalagem,
   devoluções (reembolso confirmado, avaria, descarte), perdas de estoque (por motivo e depósito).
7. **Desempenho de fornecedores ampliado:** além da Fase 7, a variação de custo (pedido × recebido × histórico),
   divergências no recebimento, devoluções e avarias atribuídas ao fornecedor e devoluções ao fornecedor.
8. **Indicadores operacionais:** tempo pago → despachado, despachado → entregue, pedidos com ocorrência, taxa de
   devolução, rastreio parado, ruptura (encomendas), giro e cobertura do estoque.
9. **Indicadores financeiros:** receita, margem de contribuição (efetiva e estimada separadas), ticket médio, frete
   como % da receita, perdas como % do custo.
10. **Painel gerencial** (menu novo, D10-9): cartões com período, comparação com o período anterior e link para cada
    relatório. Sem gráficos pesados: tabelas e barras simples, responsivas.

### 3.2 Não entra (fica para depois ou depende de você)

- Busca automática de taxas no Mercado Pago e de comissões no Mercado Livre e na Shopee pela API (D10-4, D10-5). Nesta
  fase só registro manual ou importação de planilha, salvo autorização.
- "Lucro líquido", DRE, rateio de despesas fixas (aluguel, folha) e contabilidade. A fase vai até a **margem de
  contribuição**.
- Imposto efetivo por NF-e (apuração do Simples, ICMS-ST, DIFAL): só estimativa pela alíquota validada.
- Consumo de caixas do próprio estoque como baixa de material (D10-7, alternativa B).
- Alterações no checkout, nos pagamentos, na NF-e, no estoque e nas fases anteriores.

## 4. Regras

### 4.1 Cálculo
- **R10-1.** Margem de contribuição do pedido = receita líquida − custo da mercadoria − custos variáveis (frete pago,
  embalagem, taxa de pagamento, comissão, impostos estimados) − devoluções (reembolso confirmado e perdas da volta).
- **R10-2.** Cada componente tem **natureza** (`effective`, `estimated`, `unknown`) e **origem**. Um total com algum
  componente desconhecido mostra "parcial" e a lista do que falta. Desconhecido não soma zero: o total exclui o
  componente e diz que excluiu.
- **R10-3.** Dinheiro em centavos inteiros e custo unitário em `numeric(16,4)`, sem float, como no projeto todo. Os
  arredondamentos ficam no fim e são documentados.
- **R10-4.** O custo da mercadoria é o `avg_cost_after` do movimento `sale`, ou seja, o custo médio na saída. As
  devoluções voltam pelo mesmo custo (D9-3). Nada é recalculado para trás.
- **R10-5.** A versão de `cost_settings` aplicada é a **vigente na data do fato** (pagamento, venda, despacho). Mudar
  uma alíquota não muda o passado; o relatório diz qual versão usou.
- **R10-6.** Período: pela data do pagamento, como o relatório de vendas atual, no horário de Brasília. Custos
  logísticos pela data do fato (despacho, perda, reembolso confirmado). D10-8 confirma.
- **R10-7.** Pedido cancelado não entra na margem. Pedido de reposição de troca entra como custo da troca da
  devolução de origem, não como venda.
- **R10-8.** Marketplace: o frete e a logística são do marketplace (D4). A margem mostra a receita bruta da plataforma
  e os lançamentos registrados; o que não foi registrado é desconhecido.

### 4.2 Registro e trilha
- **R10-9.** `cost_settings` e `order_cost_entries` são imutáveis: correção por nova versão ou estorno, com motivo,
  autor e auditoria.
- **R10-10.** Só a versão **validada** de `cost_settings` entra como "estimado". A informada e não validada aparece
  como "a validar" e fica fora dos totais (mesmo padrão de `fiscal_rules`).
- **R10-11.** Lançar custo externo exige `costs.manage` (com MFA, porque mexe em valores financeiros). Ver exige
  `costs.view`.
- **R10-12.** Nenhum cálculo da Fase 10 grava em estoque, pedido, pagamento, NF-e ou remessa. A fase só lê essas
  tabelas.

### 4.3 Desempenho e volume
- **R10-13.** Relatórios paginados e com período obrigatório (máximo de 366 dias), índices nas colunas de data. Sem
  tabela agregada nesta fase; uma "foto" mensal fica para D10-10.
- **R10-14.** Tempo de resposta alvo: menos de 1 s por relatório com 10 mil pedidos no período, medido no ensaio local.

## 5. Migração prevista: `0029_sglog_custos`

Aditiva, como as anteriores. Não edita as migrações 0020–0028.

| Objeto | Conteúdo |
|---|---|
| `cost_settings` | `kind` (`tax_rate`, `payment_fee`, `marketplace_fee`, `packaging_per_volume`), chave (regime e canal, meio e parcelas, marketplace, tipo de volume), valor (percentual em `numeric(7,4)` e/ou fixo em centavos), `valid_from`, `status` (`informed`, `validated`, `retired`), `informed_by/at`, `validated_by`, `validator_name`, `validated_at`, nota. Uma vigência validada por chave e data (exclusão) |
| `cost_setting_events` | Histórico imutável |
| `order_cost_entries` | Pedido, remessa opcional, `kind` (`payment_fee`, `marketplace_commission`, `marketplace_fee`, `marketplace_shipping`, `other`), valor, `source` (`manual`, `provider`, `import`), referência externa, nota, `reverses_id`, autor, `request_key`. Imutável |
| `payments.fee_cents` | Opcional, como previsto. **Proposta:** em vez da coluna, usar `order_cost_entries` (`payment_fee`), sem mexer em `payments` (D10-4) |
| Funções | `order_margin(order_id)` e as funções de relatório por período, `STABLE`, só leitura, ou o cálculo no módulo (D10-2) |
| Índices | Datas de `stock_movements` (`kind = 'sale'`), `orders.paid_at`, `shipment_freight_costs`, `refund_records`, `order_cost_entries` |
| Permissões | `costs.view` e `costs.manage` (MFA). Perfis em D10-11 |
| Conferência | C22–C24 (§6) |

A `down` remove só o que a 0029 criou, e recusa se houver `cost_settings` ou `order_cost_entries` registrados.

**Compatibilidade:** o código anterior não lê nada novo. A 0029 não altera linhas, restrições nem gatilhos existentes,
então o código da Fase 9 roda com ela aplicada. Ensaio igual ao da Fase 9: up, down e up no local, a suíte anterior
com a 0029 aplicada e o bloco de ensaio na VPS **feito por você**.

## 6. Conferências novas

| Código | Conferência |
|---|---|
| C22 | Lançamentos de custo do pedido: os estornos apontam para um lançamento do mesmo pedido e tipo, e o líquido por tipo não fica negativo |
| C23 | `cost_settings`: no máximo uma versão validada vigente por chave e data |
| C24 | Margem recalculada × componentes: a soma das linhas de `order_margin` bate com o total, para uma amostra fixa de pedidos |

C1–C21 continuam iguais.

## 7. Testes previstos

- **Cálculo:** pedido com todos os componentes efetivos; com estimados; com desconhecidos. O total marcado como
  "parcial" lista o que falta, e nenhum desconhecido entra como zero.
- **Custo da mercadoria:** saída pelo custo médio, devolução pelo custo da venda (D9-3), pedido não despachado como
  estimado e saldo sem custo como desconhecido.
- **Vigência:** a alíquota trocada no meio do período aplica a versão certa a cada pedido; a versão não validada fica
  fora.
- **Lançamentos:** idempotência por `request_key`, estorno, imutabilidade (UPDATE e DELETE recusados), MFA e 403 sem
  permissão.
- **Rastreabilidade:** cada componente devolve a origem e o id, e o id existe.
- **Marketplace:** frete fora do frete da loja; comissão desconhecida até o registro.
- **Troca:** a reposição não entra como venda e o custo dela vai para a devolução.
- **Relatórios:** paginação, período máximo, filtros e exportação CSV com os mesmos números da tela.
- **Desempenho:** ensaio local com 10 mil pedidos sintéticos (fora da VPS).
- **Regressão:** o relatório de vendas atual continua com os mesmos números para os mesmos dados.
- **Suíte anterior** (526) com a 0029 aplicada; C1–C24.
- **Telas:** e2e no desktop e a 375 px, só leitura.

## 8. Riscos

| Risco | Efeito | Mitigação |
|---|---|---|
| Margem "bonita" por faltar custo | Decisão errada de preço | R10-2: desconhecido nunca vira zero; cobertura sempre visível |
| Alíquota estimada lida como imposto real | Problema fiscal ou de preço | Rótulo "estimado", só versão validada (R10-10), sem "lucro líquido" |
| Custo médio herdado zerado ou errado | Margem inflada | Saldo sem custo vira desconhecido; lista de variantes sem custo no painel |
| Dados de demonstração na VPS | Indicadores sem sentido | Filtro e aviso de base de demonstração; `demo:reset` antes do uso real (D10-12) |
| Lançamento manual errado ou duplicado | Custo distorcido | Imutável, estorno, `request_key`, MFA, C22 |
| Relatório lento com mais volume | Painel travando | Período obrigatório, paginação, índices, ensaio de 10 mil pedidos |
| Mudar o relatório de vendas atual | Quebra de algo validado | O atual fica como está; os relatórios novos ficam ao lado. Teste de regressão |
| Comissões de marketplace mudam sem aviso | Estimativa desatualizada | Tabela com vigência; o efetivo vem do lançamento |
| Exposição de custo e margem | Informação sensível | `costs.view` própria e auditoria de exportação |

## 9. Dependências

- **Contador:** alíquota estimada por regime e canal e o que entra na margem de contribuição. Sem isso, impostos
  ficam "a validar" e a margem é mostrada sem eles, como parcial.
- **Você:** tabela de taxas do Mercado Pago (por meio e parcelas) e comissões do Mercado Livre e da Shopee; custo médio
  de embalagem por volume; quem vê custos.
- **Dados:** custo de entrada correto (compras recebidas pelo sistema e saldos de abertura com custo). Hoje parte do
  estoque de demonstração tem custo.
- **Fases anteriores:** frete pago (Fase 8), devoluções e reembolsos (Fase 9), alocação (Fase 4). Nenhuma muda.

## 10. Ordem de entrega sugerida

1. **10a:** 0029, `cost_settings` com validação, `order_cost_entries`, cálculo da margem por pedido com natureza e
   origem, telas de configuração e lançamento, C22–C24.
2. **10b:** relatórios de rentabilidade, custos logísticos, fornecedores, indicadores operacionais e financeiros,
   painel gerencial e exportação CSV.

Cada etapa com commits separados e roteiro de implantação próprio (doc 42), **executado por você**.

## 11. Decisões que precisam da sua aprovação

| # | Decisão | Proposta |
|---|---|---|
| **D10-1** | Escopo e divisão em 10a/10b (§3 e §10) | Aprovar como está |
| **D10-2** | Onde fica o cálculo | Funções SQL de leitura para a margem do pedido (testáveis e iguais em tela e CSV), sem visões materializadas nem tabelas agregadas. Alternativa: cálculo no módulo TypeScript |
| **D10-3** | Impostos | Só **estimados**, pela alíquota informada e **validada pelo contador** em `cost_settings`, por regime e canal. Sem validação, ficam fora e a margem aparece como parcial |
| **D10-4** | Taxa do pagamento | Lançamento em `order_cost_entries` (manual ou planilha), mais estimativa pela tabela validada. **Sem** coluna em `payments` e sem chamada à API do Mercado Pago nesta fase. A busca automática fica para depois, com a sua autorização |
| **D10-5** | Comissão e tarifas do marketplace | Igual à D10-4: lançamento manual ou planilha e estimativa pela tabela. Sem chamada às APIs |
| **D10-6** | Frete sem custo pago informado | Fica **desconhecido**. Alternativa: estimar pela cotação quando houver, rotulado "estimado" |
| **D10-7** | Embalagem de envio | A: estimado por volume, valor fixo em `cost_settings` (proposta). B: baixa do material do próprio estoque a cada remessa (mexe no estoque e na expedição; fica para depois) |
| **D10-8** | Data de referência do período | Data do pagamento para receita e margem (como hoje); data do fato para custos logísticos e perdas |
| **D10-9** | Painel | Menu novo "Gestão" → Painel, Rentabilidade, Custos logísticos, Fornecedores e Indicadores. Tabelas e barras simples, sem biblioteca de gráficos nova |
| **D10-10** | Fechamento mensal | Fora desta fase: tudo calculado na hora. Uma "foto" imutável por mês pode entrar depois, se você quiser travar os números de um mês |
| **D10-11** | Permissões | `costs.view` para proprietário, gerente e financeiro; `costs.manage` (MFA) para proprietário e financeiro. Logística e compras sem acesso a margem; o comprador segue vendo custo de compra como hoje |
| **D10-12** | Dados de demonstração | Os painéis mostram um aviso quando há pedidos `@demo.invalid` no período e permitem excluí-los. Não apagar nada |
| **D10-13** | Desempenho de fornecedores | Acrescentar variação de custo, divergências, avarias e devoluções atribuídas ao fornecedor ao relatório da Fase 7, sem nota ou ranking automático. Alternativa: nota ponderada (precisa dos seus pesos) |
