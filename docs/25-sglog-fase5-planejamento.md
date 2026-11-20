# SGLog — Fase 5: planejamento (remessas, separação, conferência e expedição)

Data: 20/11/2026. **Situação: proposta para análise. Nada foi implementado.**

Base:

- [sglog-fase0-auditoria.md](sglog-fase0-auditoria.md): D4 e D6; §3 (itens 5 e 7); §4 (R1, R2, R4, R6, R12, R13);
  §5.5 e §5.7; §6.1; §7; os casos 9, 13, 14 e 16–17 da §8.
- [22-sglog-fase4-planejamento.md](22-sglog-fase4-planejamento.md) §9–§10: o que a Fase 4 trouxe para si e o que deixou.
- O código depois da Fase 4 (`d3c15f6`):
  - migrações `0020`–`0023`;
  - `lib/stock.ts`, `lib/allocation.ts`;
  - `modules/logistics.ts`, `modules/orders.ts` (`/dispatch`, `/deliver`, `orderView`), `modules/whatsapp.ts`,
    `modules/bot.ts`, `modules/fiscal.ts`;
  - `components/loja/order-view.tsx`.

## 1. Escopo original e proposta

### 1.1 O que o plano geral põe nas Fases 5, 7 e 8

| Fase | Entrega prevista (§7 e §5.5–§5.8 da auditoria) |
|---|---|
| **5** | Remessas múltiplas: `shipments` sem `UNIQUE (order_id)` e com situação própria, `shipment_items`, `shipment_events` (rastreio deduplicado), aviso de WhatsApp por remessa. Também: gancho no pagamento, reservas por alocação, cancelamento parcial e total, projeção para `orders.status`, página do cliente por remessa e Playwright (D6). Migração `0024_sglog_remessas` |
| 7 | Expedição: fila de separação, checklist obrigatório de conferência (`shipment_checks`), volumes e peso (`shipment_volumes`), postagem manual. Solicitações formais a fornecedores. Migração `0026_sglog_expedicao` |
| 8 | Frete: cotação por origem, contratação, etiqueta, rastreio automático, fila `integration_jobs`, webhooks |

**Remessa** é o que sai fisicamente para o cliente. **Separação, conferência e expedição** são, no plano original, a
Fase 7.

### 1.2 O que a Fase 4 já entregou da Fase 5

| Item | Situação |
|---|---|
| Gancho no pagamento | Feito: gatilho `orders_logistics_project` (pago → `awaiting`) |
| Reservas por alocação e por depósito | Feito (D4-1) |
| Cancelamento total do pedido e da alocação; falta descoberta | Feito (D4-1), com a correção `d3c15f6` |
| Cancelamento parcial **comercial** (tirar item, estornar) | Fora: D4-9, sem fase |

### 1.3 O que sobra e a proposta

Sobram da Fase 5:
- remessas múltiplas;
- `partially_shipped` e `partially_delivered`;
- projeção para `orders.status`;
- página do cliente por remessa;
- WhatsApp por remessa;
- Playwright.

Você pediu foco em remessas, separação, conferência e expedição. **Proposta (D5-1):** a Fase 5 é **o ciclo físico
completo da remessa, com despacho manual**:

1. criar a remessa;
2. separar;
3. conferir;
4. embalar, com volumes e peso;
5. despachar ou entregar na retirada;
6. marcar como entregue.

Por isso, a fila de separação, a conferência item a item e os volumes vêm da Fase 7 para a Fase 5. Continuam
fora:

| Fica para | O quê |
|---|---|
| Fase 6 | Recebimento de compra por depósito; conversão da reserva de encomenda em firme na chegada (§3.6) |
| Fase 7 | Solicitação formal ao fornecedor (gerar, imprimir, confirmar, rastreio, divergência) |
| Fase 8 | Cotação por origem, contratação de frete, etiqueta, rastreio automático, `in_transit` pelo transportador |
| Fase 9 | Ocorrências, devolução, entrega com falha |
| Sem fase | Cancelamento parcial comercial (D4-9); troca do depósito padrão (D4-12) |

## 2. Situação atual do código (o que a Fase 5 muda)

| Ponto | Hoje | Consequência |
|---|---|---|
| `shipments` (0005) | `order_id UNIQUE`: uma remessa por pedido, criada **no despacho**, sem situação própria | Não existe remessa "em separação". Separar e conferir não têm onde ficar (R1) |
| `/dispatch` | Exige `status = 'ready'`, NF-e autorizada ou dispensada e alocação confirmada (pedido novo). **Consome todas as reservas do pedido** e muda o pedido para `shipped` | Despacho parcial é impossível (R4) |
| `/status` | `paid → preparing → ready` são botões manuais, sem ligação com separação | A separação real não aparece no pedido |
| `orderView`, página do cliente | Leem **uma** remessa (`shipment`) | Com N remessas, mostram só uma |
| Bot e WhatsApp | `LEFT JOIN shipments` por pedido | Com N remessas, **a consulta duplica linhas** (o bot pode responder duas vezes, o aviso pega um rastreio qualquer) |
| `whatsapp_messages` | `UNIQUE (order_id, event)` | Um só aviso de despacho por pedido (R12) |
| NF-e (0006) | Uma nota ativa por (pedido, finalidade). O despacho exige nota autorizada | Várias remessas com uma nota é questão fiscal (R6, §3.7) |
| Reserva de encomenda | Fica `backorder = true` mesmo depois da chegada da mercadoria. A baixa no despacho funciona se o físico cobrir | A separação precisa saber se a parte encomendada já chegou (§3.6) |
| Localização (`bin`) | Já existe por depósito (Fase 3) | Ordena a lista de separação |
| Código de barras | **Não existe** campo GTIN/EAN nas variantes | Conferência por SKU digitado ou bipado de etiqueta própria (D5-6) |
| Playwright | Não instalado | Instalação prevista (D6), só `devDependencies` |

## 3. Regras de negócio

### 3.1 Conceitos

- **Remessa:** um pacote físico, ou um conjunto de volumes, que sai de **um** depósito para **um** destino, com
  itens e quantidades.
  - Nasce de alocações confirmadas de estoque próprio ou de encomenda; as duas saem do nosso depósito.
  - Dropshipping continua travado (D3); a remessa direta do fornecedor fica modelada, mas não liberada.
- **Item da remessa:** uma alocação × quantidade. Uma alocação pode ser dividida entre remessas. A soma das remessas
  não canceladas nunca passa da alocação (trava no banco, como o teto por item da 0023).
- **Separação:** retirar do lugar (`bin`) a quantidade de cada item. Registra quem separou e quanto.
- **Conferência:** contagem independente do que foi separado, item a item. Só passa se bater com a remessa.
- **Expedição:** volumes, peso, transportadora e rastreio (manual nesta fase), e a baixa do estoque.

### 3.2 Ciclo da remessa (D5-2)

A auditoria cita "12 estados da especificação", mas a lista não está no repositório. Proposta:

| Situação | Quando | Fase |
|---|---|---|
| `pending` | Criada, aguardando separação | 5 |
| `picking` | Em separação | 5 |
| `checking` | Separada, aguardando conferência | 5 |
| `packed` | Conferida e embalada (volumes e peso) | 5 |
| `shipped` | Despachada (ou entregue na retirada) | 5 |
| `delivered` | Entregue | 5 |
| `canceled` | Cancelada antes do despacho | 5 |
| `in_transit`, `out_for_delivery` | Pelo rastreio do transportador | 8 (reservadas no CHECK) |
| `delivery_failed`, `returned` | Ocorrência e devolução | 9 (reservadas no CHECK) |

Transições permitidas:
- `pending → picking → checking → packed → shipped → delivered`;
- de `picking`, `checking` e `packed` pode **voltar para `pending`**, com motivo (divergência, troca de embalagem);
- `canceled` vale até `packed`, com motivo.

Depois de `shipped`, nada volta: o que der errado é ocorrência da Fase 9.

### 3.3 Criação das remessas

- **Automática ao confirmar a alocação:** uma remessa `pending` por depósito com todos os itens alocados ali.
  - Como a Fase 4 limita a um depósito próprio por pedido (D4-4), na prática é **uma remessa por pedido**.
  - A divisão vem de duas formas:
    - **dividir** a remessa à mão (entrega parcial), quando houver mercadoria que ainda não chegou;
    - a liberação de mais de um depósito por pedido (D5-3).
- **Troca de origem ou "Desfazer" alocação:** cancela as remessas ainda `pending` daquele pedido.
  - Com remessa em `picking` ou adiante, a troca é **recusada** até a remessa voltar para `pending`, porque a
    mercadoria já está sendo manuseada.
- **Pedidos antigos** (`allocation_required = false`, sem atendimento): o `/dispatch` atual continua igual, criando
  uma remessa já `shipped` para o pedido inteiro.
  - As remessas antigas ganham situação `shipped` ou `delivered` na migração, sem `fulfillment_id`.

### 3.4 Separação

- **Lista de separação** por remessa, ou por lote de remessas do mesmo depósito: itens ordenados por `bin`, depois
  SKU. Pode ser impressa.
- **Separar um item:** registrar a quantidade separada.
  - Não passa da quantidade do item.
  - Separar menos é permitido só com motivo ("não encontrado", "avariado"). Isso abre a falta (§3.8).
- **Item de encomenda (`backorder`):** só pode ser separado quando a mercadoria tiver chegado, ou seja, quando o
  físico do depósito cobrir as reservas firmes **e** esta (§3.6). Antes disso, aparece "aguardando mercadoria".
- **Projeção no pedido:** a primeira remessa em `picking` muda o pedido de `paid` para `preparing` (D5-5).

### 3.5 Conferência

- **Item a item:** SKU, digitado ou bipado, e quantidade. Só aceita SKU da remessa.
- **Resultado:**
  - quantidade conferida igual à separada: o item passa;
  - diferente: bloqueia, e a remessa volta para `picking` com o motivo.
- **Registro** imutável em `shipment_checks`, com quem conferiu e quando.
- **Conferente diferente do separador:** opcional, por configuração (D5-7).
- **Embalagem:** com tudo conferido, informar volumes (quantidade, peso e medidas) e passar para `packed`.

### 3.6 Encomenda: quando a mercadoria chega

Hoje a reserva de encomenda continua `backorder = true` depois do recebimento da compra.

**Proposta para a Fase 5:**
- a liberação para separar é **calculada**, sem mudar a reserva: o físico do depósito menos as reservas firmes
  precisa cobrir a quantidade encomendada desta remessa;
- havendo **várias encomendas da mesma variante**, vale a mais antiga (`paid_at`). A tela mostra a ordem.

A conversão definitiva (`backorder → firme`, por ordem de pagamento, no recebimento) fica para a Fase 6, junto com o
recebimento por depósito.

### 3.7 Expedição, NF-e e projeção para o pedido

- **Despachar uma remessa** (`packed → shipped`):
  - exige a mesma trava fiscal de hoje: NF-e autorizada ou dispensada, **sem alterar a validação**;
  - exige a alocação confirmada;
  - baixa **só as reservas dos itens da remessa**. Se a remessa leva parte de uma alocação, a reserva é dividida
    na mesma transação: consome a parte e mantém o resto reservado;
  - registra transportadora, rastreio, volumes e peso, de forma manual.
- **Retirada na loja:** a remessa `packed` aparece como "pronta para retirar" e avisa o cliente (`order_ready`).
  "Entregue ao cliente" faz `packed → shipped → delivered` de uma vez.
- **Uma NF-e por pedido** (como hoje) e **várias remessas** (R6):
  - entrega parcial com uma nota só é questão fiscal: a nota acompanha a mercadoria, e uma entrega parcial pode
    exigir uma nota por remessa ou um tratamento próprio;
  - **não invento a regra.** Proposta (D5-4): as remessas múltiplas **nascem travadas**, como o dropshipping;
  - com a trava, o pedido sai numa remessa só, e o ciclo de separação, conferência e expedição funciona igual;
  - a divisão em várias remessas só libera depois de o contador validar o tratamento fiscal, com registro de quem
    validou (padrão de `logistics_settings`).
- **Projeção para `orders.status`** (R2), numa função única:

| Remessas | `orders.status` | `logistics_status` |
|---|---|---|
| alguma em `picking` ou adiante | `preparing` (se ainda `paid`) | `processing` |
| todas `packed` | `ready` | `processing` |
| primeira `shipped`, outras não | `shipped` | `partially_shipped` |
| todas `shipped` | `shipped` | `shipped` |
| uma ou mais `delivered`, não todas | `shipped` | `partially_delivered` |
| todas `delivered` | `delivered` | `completed` |

O CHECK de `orders.status` não muda. Os botões manuais "Iniciar separação" e "Marcar como pronto" continuam
para pedidos antigos; nos novos, a situação vem das remessas (D5-5).

### 3.8 Falta na separação

- O separador registra menos do que a remessa pede, com motivo.
- A remessa volta para `pending`.
- O pedido vai para "Em análise" com "Falta na separação: SKU, depósito, pedido X, encontrado Y".
- A decisão vai para o histórico (`allocation_decisions.kind = 'shortage'`, já existente).
- **Nenhum movimento de estoque é feito automaticamente.** A correção do saldo é por inventário ou perda, com
  motivo, como hoje.
- Depois, a realocação usa o caminho corrigido em `d3c15f6`: encerra o atendimento anterior e cancela a remessa
  `pending`.

### 3.9 Cancelamento

- **Remessa** (até `packed`): com motivo.
  - Os itens voltam para "a separar".
  - As reservas continuam com o pedido.
  - Se já tinha separado algo, a tela pede "devolver ao lugar" (só registro, sem movimento: a mercadoria não saiu
    do depósito).
- **Pedido inteiro:** como hoje, só até `ready`. Cancela as remessas abertas e libera as reservas.
- **Depois da primeira remessa `shipped`:** cancelar o restante seria um cancelamento parcial comercial, que está
  fora (D4-9). Fica recusado com mensagem clara.

### 3.10 Marketplaces (D4, R13)

- Pedidos do Mercado Livre e da Shopee passam por separação e conferência, com uma remessa só.
- No despacho, a remessa registra só o código informado pelo marketplace. Frete, etiqueta e rastreio continuam com
  ele.
- A situação comercial continua vindo do marketplace, como hoje.

### 3.11 Avisos ao cliente

- WhatsApp:
  - `order_shipped` **por remessa**, com o rastreio da própria remessa;
  - unicidade (pedido, evento, remessa) (R12);
  - o modelo aprovado na Meta não muda.
- `order_ready` continua um por pedido (retirada).
- Página do pedido do cliente: lista de remessas com situação, itens, transportadora e rastreio de cada uma.

### 3.12 Permissões

| Ação | Permissão | Papéis (D5-8) |
|---|---|---|
| Ver fila de separação e remessas | `logistics.view` | os que já têm (estoquista, comprador, expedição, logística, gerente, proprietário) |
| Separar, conferir, embalar | `shipping.manage` | expedição, logística, gerente, proprietário. **Proposta:** o estoquista também (hoje não tem) |
| Criar, dividir e cancelar remessa; liberar remessa de volta | `logistics.manage` (nova, prevista para a Fase 5) | logística, gerente, proprietário |
| Despachar e marcar entregue | `shipping.manage` (como hoje) | expedição, logística, gerente, proprietário |
| Liberar remessas múltiplas (trava fiscal) | proprietário ou gerente com MFA | igual à trava do dropshipping |

## 4. Proposta técnica

### 4.1 Migração `0024_sglog_remessas` (aditiva, uma transação, com ensaio)

```
shipments (existente)
  - DROP UNIQUE (order_id)
  + fulfillment_id NULL, warehouse_id NULL, seq (nº da remessa no pedido), kind ('delivery','pickup','marketplace','legacy'),
    status (CHECK com os 11 valores da §3.2), version, request_key UNIQUE,
    picking_started_at, picked_by, checked_at, checked_by, packed_at, canceled_at, cancel_reason, updated_at
  - linhas antigas: kind 'legacy', status 'shipped' ou 'delivered' (por delivered_at), seq 1
  - UNIQUE (order_id, seq); CHECK das datas por situação

shipment_items      id, shipment_id, allocation_id, order_item_id, variant_id, base_qty > 0, picked_qty, status ('active','canceled')
                    gatilho: Σ itens ativos de remessas não canceladas por alocação ≤ alocação
shipment_checks     (imutável) shipment_id, shipment_item_id, sku_read, qty_checked, ok, checked_by, checked_at
shipment_volumes    shipment_id, n, weight_g, length_mm, width_mm, height_mm
shipment_events     (imutável) shipment_id, status, source ('manual','carrier','marketplace'), provider_event_id NULL,
                    note, actor_id, occurred_at; UNIQUE (shipment_id, provider_event_id)
whatsapp_messages   + shipment_id NULL; unicidade (order_id, event, coalesce(shipment_id, zero))
logistics_settings  + multi_shipment_status ('blocked','enabled') DEFAULT 'blocked', validador, autor, data (D5-4)
stock_reconcile()   + C10: Σ itens despachados por alocação = reservas consumidas da alocação
                    + C11: remessa não cancelada e não despachada sem reserva ativa correspondente
GRANTs mínimos: loja_app sem DELETE; históricos com forbid_mutation
```

Antes da migração, conferir se há `shipments` órfãos ou duplicados nos dados reais. O ensaio em cópia
(`migrate-rehearsal`) é o mesmo das Fases 1–4.

### 4.2 Código

- **`lib/shipments.ts`** (novo):
  - criar a remessa a partir das alocações;
  - transições numa única função (`transition(shipment, to, motivo)`), com `version`, `request_key` e auditoria;
  - projeção para o pedido (§3.7);
  - divisão da reserva no despacho parcial.
- **`lib/stock.ts`:** `consumeReservationPart(id, qty)`, que consome a parte e deixa o resto reservado na mesma
  reserva, com movimento.
- **`modules/logistics.ts`:**
  - ao confirmar a alocação, cria a remessa;
  - na troca de origem, no "Desfazer" e na falta, cancela as remessas `pending` ou recusa se houver remessa adiante.
- **`modules/shipments.ts`** (novo), em `/api/v1/admin/shipments`:
  - fila por depósito e situação, paginada;
  - detalhe;
  - separar, conferir, embalar, despachar, entregar, dividir, cancelar;
  - lista de separação imprimível.
- **`modules/orders.ts`:**
  - `/dispatch` e `/deliver` continuam para pedidos antigos;
  - nos novos, respondem "use a remessa";
  - `orderView` passa a devolver `shipments[]` e mantém `shipment` (a primeira) por compatibilidade durante a
    transição.
- **`bot.ts` e `whatsapp.ts`:** trocar o `LEFT JOIN shipments` por subconsulta à remessa relevante, sem duplicar
  linhas.

### 4.3 Painel

- **Menu Logística → Expedição:**
  - fila por situação (a separar, em separação, a conferir, embaladas, prontas para retirar);
  - filtros por depósito e canal;
  - 375 px sem rolagem lateral.
- **Tela da remessa:** lista de separação, conferência item a item (campo de SKU com foco para leitor de código de
  barras), volumes, despacho.
- **Página do pedido:** bloco "Remessas" no lugar do despacho único para pedidos novos.
- **Loja, página do pedido:** lista de remessas.

### 4.4 Testes

- **Integração** (vitest e `inject`, `loja_test`):
  - ciclo completo;
  - divisão e despacho parcial, com reserva dividida;
  - falta na separação e realocação;
  - cancelamento de remessa e de pedido;
  - pedido antigo pelo caminho atual;
  - marketplace;
  - retirada;
  - projeção para o pedido;
  - concorrência: dois separadores na mesma remessa e despacho repetido (idempotência);
  - trava de remessas múltiplas;
  - permissões (caso 16);
  - imutabilidade (caso 17);
  - C10 e C11;
  - WhatsApp um por remessa.
- **Casos 13 e 14 da §8:** rastreio duplicado (`provider_event_id`) e entrega parcial (`partially_delivered`).
- **Playwright (D6):** só `devDependencies`, contra a web e a API locais (`baseURL` recusa domínio que não seja
  `localhost`).
  - Primeiro grava o fluxo atual do checkout, **antes** de mexer.
  - Depois: separar → conferir → despachar.
- **Regressão:** os 416 testes atuais continuam passando.

### 4.5 Implantação prevista (quando autorizada, só você executa)

- Mesmo roteiro das Fases 3 e 4: conferência, backup verificado, ensaio da `0024` em cópia, migração, build da API e
  da web, reinício, bloco 5.1 estendido com C10 e C11.
- `ALLOCATION_AUTO` continua desligado.
- A trava de remessas múltiplas nasce `blocked`.

## 5. Dependências

| Dependência | Situação | Impacto |
|---|---|---|
| Fase 4 (alocação, `d3c15f6`) | Implantada e validada | Pré-requisito direto |
| NF-e (provedor fiscal e dados da empresa) | **Não configurada** | Sem nota, nenhuma remessa de pedido novo é despachada em produção, como hoje. Separação, conferência e embalagem funcionam e podem ser validadas; o despacho só se valida com a NF-e |
| Validação do contador para entrega parcial | Não existe | Remessas múltiplas ficam travadas (D5-4) |
| Validação do contador para dropshipping (D3) | Não existe | Continua travado |
| Fase 6 (recebimento por depósito) | Não iniciada | Encomenda usa a liberação calculada (§3.6) |
| Fase 8 (frete) | Não iniciada | Transportadora e rastreio manuais |
| Usuários de teste por perfil | Não existem (comprador, financeiro, logística) | Permissões validadas por teste automatizado; no painel, quando houver usuários |

## 6. Riscos

| # | Risco | Mitigação |
|---|---|---|
| F5-R1 | Tirar o `UNIQUE (order_id)` afeta quem lê "a remessa do pedido": `orderView`, página do cliente, bot, WhatsApp, `demo.ts` | Inventário completo das leituras (§2); `shipment` mantido por compatibilidade; teste de cada leitura com 2 remessas |
| F5-R2 | Despacho parcial divide a reserva: erro deixaria reserva órfã ou baixa duplicada | Uma transação por despacho; C10 e C11 na conferência; teste de falha no meio (padrão do `d3c15f6`) |
| F5-R3 | Projeção para `orders.status` em dois lugares (gatilho da 0023 e remessas) | Uma função só; o gatilho da 0023 continua projetando do comercial para o logístico. As remessas mudam o comercial por essa função, sem caminho paralelo |
| F5-R4 | Entrega parcial com uma NF-e (questão fiscal) | Trava D5-4; não mudar a validação fiscal |
| F5-R5 | Encomenda: duas remessas disputando a mesma mercadoria que chegou | Ordem por `paid_at` (§3.6), calculada sob trava da variante |
| F5-R6 | Troca de origem com mercadoria já separada | Recusar com remessa em `picking` ou adiante (§3.3) |
| F5-R7 | Pedidos antigos misturados com novos | Caminho legado intacto, decidido por `allocation_required`; teste dos dois |
| F5-R8 | Telas novas no celular da expedição | 375 px conferido, como na Fase 4; campo de SKU funciona com leitor de código de barras USB ou Bluetooth (age como teclado) |
| F5-R9 | Playwright puxando dependências pesadas | Só `devDependencies`; não entra no build nem no servidor |
| F5-R10 | Pedidos de demonstração na VPS de testes | Testes funcionais num pedido de demonstração escolhido, com saldos registrados antes e depois, como na Fase 4 |

## 7. Decisões que precisam da sua aprovação

| # | Decisão | Recomendação |
|---|---|---|
| **D5-1** | Escopo: trazer da Fase 7 a **separação, conferência e volumes**; solicitação ao fornecedor continua na Fase 7, frete na Fase 8 | **Sim** |
| **D5-2** | Situações da remessa (§3.2): 7 usadas na Fase 5 e 4 reservadas para as Fases 8 e 9 | **Sim**, ou me envie a lista dos 12 estados da especificação original para alinhar |
| **D5-3** | Mais de um depósito próprio por pedido (fim do D4-4) | **Não nesta fase.** Dividir à mão no mesmo depósito cobre a entrega parcial; vários depósitos dependem de frete por origem (Fase 8) |
| **D5-4** | Remessas múltiplas **travadas** até o contador validar entrega parcial com NF-e; travado, o pedido sai numa remessa só | **Sim** |
| **D5-5** | `preparing` e `ready` passam a vir das remessas nos pedidos novos; botões manuais só nos antigos | **Sim** |
| **D5-6** | Conferência por SKU, sem GTIN/EAN (não há o campo). Cadastro de código de barras fica para depois | **Sim.** Se quiser GTIN agora, é mudança de cadastro com campo novo |
| **D5-7** | Conferente diferente do separador | **Opcional por configuração, desligado de início** (equipe pequena) |
| **D5-8** | Estoquista ganha `shipping.manage` para separar e conferir; `logistics.manage` para logística, gerente e proprietário | **Sim** |
| **D5-9** | Falta na separação manda o pedido para análise sem mexer no estoque; ajuste por inventário ou perda com motivo | **Sim** |
| **D5-10** | Encomenda: liberação calculada por ordem de pagamento; conversão definitiva no recebimento fica para a Fase 6 | **Sim** |
| **D5-11** | Cancelar o restante depois de uma remessa despachada continua recusado (cancelamento parcial comercial fora, D4-9) | **Sim** |
| **D5-12** | Playwright instalado nesta fase, só em desenvolvimento, gravando primeiro o checkout atual | **Sim** |
| **D5-13** | Migração e branch: `0024_sglog_remessas`, branch `sglog/fase5` a partir da `main` | **Sim** |

## 8. Fora da Fase 5

Ficam fora:
- cotação, contratação e etiqueta de frete;
- rastreio automático e `in_transit`;
- solicitação formal ao fornecedor;
- recebimento por depósito;
- devolução e ocorrências;
- cancelamento parcial comercial;
- dropshipping operando;
- `ALLOCATION_AUTO` ligado.

Nada desta fase é implementado, integrado, enviado ou implantado sem sua autorização expressa.
