# SGLog — Fase Zero: auditoria técnica e plano

Projeto: loja-embalagens (Embalagem Canoinhas), branch `main`.

Data: 16/11/2026.

A auditoria foi só leitura: nenhuma migração foi executada e nenhum dado foi tocado.

**Situação:** arquitetura aprovada em 16/11/2026, com as decisões abaixo. A Fase 1 aguarda autorização expressa (escopo na §10).

### Decisões aprovadas

| # | Decisão | Onde se aplica |
|---|---|---|
| D1 | `orders.logistics_status` separado de `orders.status`. A máquina de estados comercial não muda | Fase 4 |
| D2 | A vitrine não usa a disponibilidade de fornecedor como estoque próprio. Dropshipping continua "sob encomenda" | todas (nada muda em `storefront.ts`) |
| D3 | Dropshipping preparado tecnicamente, mas **bloqueado para operação real** até o contador validar o tratamento fiscal | Fase 4 (trava) |
| D4 | Pedidos do Mercado Livre e da Shopee entram só para separação e conferência. Frete e logística continuam com o marketplace | Fases 5 e 7 |
| D5 | Novos papéis `logistics`, `buyer` e `finance`, no sistema atual de permissões e MFA | Fase 1 |
| D6 | Playwright autorizado **só como dependência de desenvolvimento** (`devDependencies`), para ponta a ponta dos fluxos críticos | Fase 5 |
| D7 | Este relatório fica em `docs/sglog-fase0-auditoria.md` | feito |

### Restrições permanentes da implementação

- Os 287 testes atuais continuam passando em todas as fases, sem regressão. Linha de base conferida em 16/11/2026: 20 arquivos, 287/287, banco `loja_test`.
- Nenhum teste, carga, seed ou homologação roda no banco de produção (`loja_prod`). A trava técnica está na §12.
- Contratação de frete e compra de etiqueta reais ficam desligadas até autorização expressa (Fase 8).
- Checkout, pagamentos, emissão fiscal e funções existentes não mudam sem necessidade técnica demonstrada e registrada neste documento.
- As migrações seguem as fases reais: cada fase cria só as tabelas que ela usa (§6).

---

## 1. Diagnóstico da arquitetura existente

### Pilha

| Camada | Tecnologia |
|---|---|
| Monorepo | npm workspaces (`apps/api`, `apps/web`), Node ≥ 22.12 |
| API | Fastify 5, zod 4, `pg` com SQL escrito à mão (sem ORM), TypeScript 7, vitest 5 |
| Web | Next 16 (App Router), React 19, Tailwind 4, lucide-react. Loja pública e painel `/painel/(app)` no mesmo app |
| Banco | PostgreSQL. Migrações SQL versionadas `NNNN_nome.up.sql` e `.down.sql` (0001 a 0019), aplicadas por `src/db/migrate.ts` |
| Infra | VPS Ubuntu, `/srv/loja-embalagens`, systemd (`loja-api`, `loja-web`, `loja-db`, `loja-backup.timer`), nginx com HTTPS por webroot, backup cifrado fora do servidor (rclone) |
| Rotinas | Sem fila externa. `setInterval` de 60 s em `server.ts` cuida de: reservas vencidas, pedidos sem pagamento, NF-e, marketplaces, WhatsApp e bot. Lotes usam `FOR UPDATE SKIP LOCKED` |

### Convenções que o SGLog deve seguir

- **Papéis do banco.** A API conecta como `loja_app`, que não é dona das tabelas. Cada migração termina com `GRANT`s explícitos e mínimos.
- **Histórico imutável.** As tabelas de histórico recebem o gatilho `forbid_mutation()`, que bloqueia UPDATE e DELETE, e às vezes TRUNCATE. Já é usado em `stock_movements`, `audit_logs`, `order_items`, `order_events`, `purchase_receipts` e nos documentos fiscais.
- **Usuário da transação.** `tx(actorId, fn)` grava `app.user_id`, que `app_user_id()` lê. Os gatilhos de histórico registram o autor com isso.
- **Dinheiro em centavos inteiros.** Valores ficam em `bigint *_cents`. Custos unitários ficam em `numeric(16,4)` de centavos. Quantidades ficam em `numeric(14,3)` na **unidade base**. Não há float. O SGLog segue isso, sem migrar para DECIMAL em reais.
- **Validação dupla.** As regras ficam em CHECKs no banco e também em zod na API.
- **Idempotência.** Usa `request_key UNIQUE` em movimentos, recebimentos e pedidos. Usa `UNIQUE (provider, dedupe_key)` em notificações e `wamid UNIQUE` no WhatsApp.
- **Concorrência.** Usa `version` nos pedidos, `FOR UPDATE` no saldo e `SAVEPOINT` em `moveStock`.
- **Auditoria.** `audit(db, {...})` grava em `audit_logs` (somente inclusão) dentro da mesma transação. As ações seguem o formato `modulo.acao`.
- **Provedores externos.** Cada integração tem uma interface com uma implementação real e uma Fake: `PaymentProvider`, `CarrierProvider`, `FiscalProvider`, `WhatsAppProvider`, `Marketplaces`, `AiProvider`. Os testes injetam a Fake por `buildApp(opts)`. As credenciais ficam só no `.env`, e os tokens de marketplace ficam cifrados com `ENC_KEY`.

### Autenticação e permissões

- **Equipe.** A tabela `users` tem `role` limitado pelo CHECK a `owner`, `manager`, `sales`, `stock`, `fiscal` e `shipping`.
  - A sessão usa cookie, com hash do token no banco.
  - O MFA é TOTP.
  - O hash da senha só é lido por funções SECURITY DEFINER.
- **Permissões.** Ficam em `lib/permissions.ts`: lista `PERMISSIONS`, padrões por papel (`ROLE_DEFAULTS`) e concessões ou revogações individuais (`user_permissions`).
  - `MFA_REQUIRED` exige 2FA para permissões sensíveis.
  - O backend verifica com `requirePermission(req, 'x.y')` em cada rota.
  - O painel filtra o menu com `can(perm)` e protege as telas com `<Guard>`.
- **Clientes.** Ficam separados (`customers`, `customer_sessions`).

### Produtos e variantes (0002)

- **Estrutura.** `products` → `product_variants` (SKU citext único, peso e medidas em g/mm) → `packagings`.
  - Uma embalagem é de `kind` `sale` (com preço) ou `purchase`, com `base_qty` em unidades base.
  - Ainda existem `price_tiers`, `price_history` (imutável, alimentado por gatilho) e `product_fiscal` com histórico.
- **Disponibilidade.** `products.availability_mode` vale `stock` ou `made_to_order`, com `lead_time_days`. `products.min_stock` fica no nível do produto.
- **Importação.** A importação por planilha (0019, commit 15fc2a1, já no GitHub) cria produtos e variantes. Não mexe em estoque.

### Pedidos e itens (0005)

- **`orders`**:
  - `status` vale `pending_payment`, `paid`, `preparing`, `ready`, `shipped`, `delivered` ou `canceled`;
  - `channel` vale `store`, `sales_desk`, `mercadolivre` ou `shopee`;
  - o pedido guarda cópias JSON de `buyer`, `ship_to` e `shipping_snapshot`;
  - `freight_cents` e `total_cents` são verificados por CHECK;
  - `invoice_status` tem a regra "expedição só com NF-e autorizada";
  - há `version` e `has_backorder`.
- **`order_items`** é imutável e guarda cópia de SKU, nome, embalagem, preço e `base_qty_per_pack`.
- **`order_events`** é o histórico de situações, somente inclusão.
- **Transições no painel** (`orders.ts`):
  - `paid` → `preparing` → `ready` → `/dispatch` → `shipped` → `/deliver` → `delivered`;
  - `/cancel` funciona até `ready`.

### Pagamento

- **Provedor.** Mercado Pago (Pix e cartão) atrás de `PaymentProvider`, com uma versão Fake para testes.
- **Registros.** `payments` usa `idempotency_key`. `payment_notifications` deduplica os webhooks.
- **Confirmação.** `applyPayment` bloqueia pagamento e pedido. Quando aprova, muda o pedido de `pending_payment` para `paid` e grava o evento.
- **Gancho natural do SGLog.** O pedido chega a `paid`. Nada no checkout ou no pagamento precisa mudar.

### Estoque existente (0004 e `lib/stock.ts`): base sólida, sem depósitos

- **`stock_balances`** guarda o saldo por **variante**, com uma única linha (sem depósito): `on_hand ≥ 0`, `reserved ≥ 0` e `avg_cost_cents` (custo médio ponderado).
- **`stock_movements`** é um livro **imutável**:
  - `kind` vale `receipt`, `sale`, `return`, `loss`, `damage`, `adjustment`, `inventory`, `reserve` ou `release`;
  - cada linha guarda deltas e saldo resultante, origem, motivo (obrigatório em perda, avaria e ajuste), `request_key UNIQUE` e autor.
- **`moveStock()`** é o único caminho que altera saldo. Bloqueia a linha e transforma saldo negativo em `INSUFFICIENT_STOCK`.
- **`stock_reservations`**:
  - vem de `order`, `cart`, `quote` ou `manual`;
  - a origem é única enquanto a reserva está ativa;
  - `backorder` permite reservar além do físico quando o produto é `made_to_order`;
  - tem prazo e rotina de expiração.
- **Reserva no pedido.** O pedido reserva **todo o pedido** já no checkout (`insertOrder` → `reserve`). O despacho **consome todas** as reservas do pedido de uma vez.
- **Outras peças prontas:**
  - inventário (`inventory_counts`, uma contagem aberta por vez no sistema todo);
  - relatórios de estoque e sugestão de reposição por giro (`stock-reports.ts`, tela `/painel/reposicao`).
- **Quem lê `on_hand - reserved` direto de `stock_balances`:**
  - vitrine (`storefront.ts`);
  - sincronização de saldo dos marketplaces (`marketplaces.ts`);
  - orçamentos;
  - bot com IA;
  - relatórios.

### Fornecedores e compras (0004, 0007)

- **`suppliers`** guarda nome, razão social, CNPJ/CPF, IE, e-mail, telefone, WhatsApp, site, cidade e UF, condições, prazo, pedido mínimo, frete, observações e `active`.
- **`supplier_contacts`**.
- **`supplier_products`** é a oferta por **embalagem**:
  - campos: `cost_cents`, `supplier_sku`, `lead_time_days`, `quoted_at`, `active`;
  - é `UNIQUE (supplier_id, packaging_id)`;
  - tem `ON DELETE CASCADE`;
  - **não tem histórico de preço**;
  - o PUT `/:id/offers` substitui a lista inteira.
- **`purchase_orders` e `purchase_order_items`** vão de `draft` a `sent`, depois `partial`, `received` e `canceled`. Rateiam frete e outras despesas no custo.
- **Recebimento.** `purchase_receipts` e `purchase_receipt_items` são imutáveis e aceitam recebimento parcial. Recebe-se informando a quantidade conferida, o que gera um movimento `receipt` com custo.
- **`purchase_invoices`** guarda o XML da NF-e de compra para conferência.

### Frete existente

- **`shipping_options`** tem três tipos:
  - `pickup`;
  - `delivery`, por faixa de CEP e peso;
  - `carrier`, cotado no Melhor Envio por `carrier_service`, com `handling_days`.
- **Cotação.** `lib/carriers.ts` define `CarrierProvider` com `MelhorEnvioProvider` (só **cotação**, `/me/shipment/calculate`) e uma versão Fake.
  - A origem é sempre o CEP da empresa (`company_profiles`).
  - `shipping_quote_cache` guarda a cotação por 30 min.
- **Remessa.** `shipments` tem **`order_id UNIQUE`**, ou seja, uma remessa por pedido. Guarda transportadora, rastreio, volumes, peso e datas.
- **Fora do escopo hoje.** Compra de frete, etiqueta e rastreio automático ficaram de fora por decisão sua (docs/08 §2). O despacho registra o rastreio à mão.

### NF-e (0006)

- **Emissão.** Usa um provedor fiscal.
  - `fiscal_documents` só permite **uma nota ativa por (pedido, finalidade)**.
  - Eventos, arquivos e inutilizações são imutáveis.
- **Política de emissão.** Manual ou ao pagar.
- **Bloqueio de despacho.** O despacho exige `invoice_status` `authorized` ou `not_required`.

### Notificações

- **WhatsApp Cloud API.** Usa fila em `whatsapp_messages` (com tentativas e `next_attempt_at`) e modelos para `order_paid`, `order_ready` e `order_shipped`. A regra **`UNIQUE (order_id, event)`** limita a um aviso de despacho por pedido.
- **E-mail.** Usa SMTP com `nodemailer` e registro em `email_sends`, sem conteúdo.
- **Bot.** Atendimento com Gemini e Typebot. Consulta a situação do pedido.

### Testes existentes

- **Suíte vitest** em `apps/api/test`, com 21 arquivos e cerca de 287 casos.
  - Roda contra o banco `loja_test`. O pool do dono prepara os cenários e a API conecta como `loja_app`, o que prova o que ela **não** consegue fazer.
  - Os provedores Fake são injetados.
  - `stock.test.ts` tem 12 casos (concorrência de reserva, imutabilidade e custo médio).
- **Testes de carga** com k6 em `tests/carga/` (jornada da loja).
- **Sem e2e de navegador** (não há Playwright). As telas são conferidas à mão, e as pendências vão para `docs/TESTES-PENDENTES.md`.

---

## 2. Componentes que podem ser reaproveitados

| Requisito SGLog | Reaproveitar | Ajuste necessário |
|---|---|---|
| Cadastro único de produto | `products` / `product_variants` / `packagings` | Nenhum. O SGLog referencia `variant_id`, sem duplicar produto |
| Pedido comercial e itens | `orders` / `order_items` (imutável) / `order_events` | Não criar outro pedido. A logística fica em tabelas filhas |
| Pagamento aprovado como gatilho | `applyPayment` → `paid` | Só um gancho (fila) para "disponível para logística" |
| Livro imutável de estoque | `stock_movements` + `forbid_mutation` + `moveStock()` | Estender com depósito, baldes (bloqueado, avariado, em trânsito), transferência e estorno |
| Reservas e concorrência | `reserve` / `release` / `consume` com `FOR UPDATE` | Reserva por alocação e consumo por remessa |
| Inventário | `inventory_counts` | Uma contagem aberta **por depósito** |
| Mínimo e reposição | `products.min_stock` + `stock-reports` | Mínimo e máximo por depósito e alerta |
| Fornecedores e contatos | `suppliers`, `supplier_contacts`, telas `/painel/fornecedores` | Completar campos (endereço, prazos, devolução, situação, dropshipping) |
| Fornecedor × produto | `supplier_products` | Novos campos, histórico de preço, disponibilidade separada e fim do CASCADE |
| Compras e recebimento parcial | `purchase_orders`, `purchase_receipts`, rateio de frete | Finalidade (reposição × atendimento), aprovação, pagamento, divergências |
| XML de compra | `purchase_invoices` | Nenhum |
| Cotação de frete | `CarrierProvider` / `MelhorEnvioProvider` / Fake / cache | Origem por remessa e métodos novos (contratar, etiqueta, rastreio, cancelar) |
| Remessa | `shipments` | Permitir N por pedido (ver Riscos) |
| Fila com tentativas | Padrão de `whatsapp_messages` + `setInterval` + `SKIP LOCKED` | Tabela genérica `integration_jobs` no mesmo padrão. **Sem Redis** |
| Webhooks deduplicados | Padrão de `payment_notifications` / `marketplace_notifications` | `logistics_webhook_events` |
| Auditoria | `audit_logs` + `audit()` + tela `/painel/auditoria` | Novas ações `logistics.*`, `stock.*`, `suppliers.*` |
| Permissões | `PERMISSIONS`, `ROLE_DEFAULTS`, `MFA_REQUIRED`, `Guard` | Novas permissões e papéis |
| Interface | `shell.tsx` (menu), `ui.tsx` (Button, Input, tabelas), `components/stock.tsx`, `orders.tsx` | Menu LOGÍSTICA com subseções no mesmo visual |
| Avisos ao cliente | Fila do WhatsApp, e-mail | Aviso por remessa |
| Testes | `test/helpers.ts`, pools dono/app, provedores Fake, k6 | Novos arquivos de teste |

---

## 3. Componentes que precisam ser criados

1. **Depósitos e saldo por depósito.** `warehouses` e `stock_location_balances`, mantendo `stock_balances` como total por variante, que a vitrine, os marketplaces e os relatórios leem.
2. **Disponibilidade de fornecedor separada do estoque.** `supplier_availability` (histórico com validade), `supplier_price_history` (imutável, por gatilho) e campos novos em `supplier_products`.
3. **Motor de distribuição.** Serviço puro em TypeScript (`lib/allocation.ts`). Recebe o item, o saldo próprio por depósito, as ofertas válidas e as cotações, e devolve sugestões e comparação. Não grava nada. A gravação é a confirmação do administrador.
4. **Atendimentos e alocações.** `fulfillments`, um por origem (depósito ou fornecedor), e `fulfillment_allocations`: item do pedido × origem × quantidade, com cópia de custo, fornecedor e justificativa.
5. **Remessas múltiplas.** `shipments` alterada, mais `shipment_items` e `shipment_events` (rastreio deduplicado).
6. **Situação logística do pedido.** Coluna `orders.logistics_status` separada de `orders.status` (ver Riscos 2).
7. **Expedição.** Fila de separação, checklist de conferência (`shipment_checks`), volumes e peso, e localização (`bin`) no saldo por depósito.
8. **Solicitações a fornecedores.** `supplier_requests` e `supplier_request_events`. Tela com copiar e imprimir. A confirmação é manual.
9. **Compras.** Finalidade, aprovação, pagamento, rastreio e divergências de recebimento (`purchase_receipt_issues`).
10. **Fretes.**
    - Adaptadores por plataforma: estender `CarrierProvider` com uma capacidade por método.
    - `shipping_quotes` e `shipping_labels`.
    - `integration_jobs` (fila) e `integration_logs` (sem dados sensíveis).
    - `logistics_webhook_events`.
11. **Ocorrências e devoluções.** `logistic_occurrences`, `occurrence_events`, `returns` e `return_items`.
12. **Custos.** Custo de embalagem e de frete por remessa, taxa do pagamento, `cost_settings` (alíquotas informadas pelo contador, no padrão "informado → validado" de `fiscal_rules`) e visões de margem.
13. **Painel.**
    - Menu LOGÍSTICA com 10 seções.
    - Rotas `/painel/logistica/*`. As telas atuais de Estoque, Fornecedores, Compras e Inventário podem ficar como estão ou ser movidas para baixo de LOGÍSTICA, sem duplicar.
14. **Reconciliação de estoque.** A função `stock_reconcile()` compara a soma do livro com o saldo e grava o resultado em `stock_reconciliations`. A correção é por lançamento compensatório.

---

## 4. Riscos de incompatibilidade

| # | Risco | Onde | Mitigação proposta |
|---|---|---|---|
| R1 | **`shipments.order_id UNIQUE`**: hoje só cabe uma remessa por pedido | 0005, `orders.ts` (`/dispatch`, `/deliver`, `orderView` lê uma remessa), página de acompanhamento do cliente, `customerOrderRoutes` | Migração remove o UNIQUE e adiciona `fulfillment_id`. O fluxo antigo continua criando uma remessa. `orderView` passa a devolver uma lista e a tela do cliente mostra uma por remessa |
| R2 | **`orders.status` é usado por checkout, pagamento, NF-e, marketplaces, orçamentos, bot, WhatsApp, relatórios e cliente.** Trocar o CHECK pelos estados novos quebraria esse fluxo | `orders.ts`, `fiscal.ts`, `marketplaces.ts`, `bot*.ts`, `sales-reports.ts` | **Não mexer no CHECK.** Criar `orders.logistics_status` com os 8 estados do SGLog. Projetar dela para o `status` comercial só nos marcos: primeira remessa postada → `shipped`; todas entregues → `delivered`. Transições numa única função |
| R3 | **Reserva no checkout do pedido inteiro.** Item de dropshipping hoje só passa no checkout se o produto for `made_to_order`, e gera reserva **backorder** que infla `reserved` sem físico | `insertOrder`, `reserve` | Na confirmação da distribuição, a parte alocada a fornecedor libera a reserva backorder (movimento `release` com justificativa). A parte própria troca para reserva vinculada à alocação e ao depósito |
| R4 | **Despacho consome todas as reservas do pedido** | `/dispatch` | Consumo por remessa (itens da remessa). `/dispatch` legado vira atalho para pedido de uma remessa só |
| R5 | **Vitrine não enxerga fornecedor.** Princípio 3: estoque próprio ≠ disponibilidade de fornecedor | `storefront.ts` | **Decisão sua.** Proposta: a vitrine continua como está (produtos de fornecedor marcados `made_to_order` com prazo). Exibir disponibilidade de fornecedor como vendável fica para depois, com sinalizador próprio |
| R6 | **NF-e e dropshipping.** Hoje é uma nota ativa por pedido, e o despacho exige nota autorizada. No dropshipping, a remessa direta do fornecedor tem tratamento fiscal próprio (nota de remessa por conta e ordem do fornecedor, CFOP específico) | `fiscal.ts`, `fiscal_rules` | **Não inventar regra fiscal.** O SGLog só registra a nota do fornecedor (chave) na remessa. O enquadramento fica para o contador validar antes de operar dropshipping em produção. A trava "despacho só com NF-e" vale para remessas do estoque próprio |
| R7 | **`stock_movements` é imutável.** Preencher `warehouse_id` nas linhas antigas exigiria desligar o gatilho | 0004 | Não reescrever o histórico. `warehouse_id` nulo significa "depósito padrão, antes do SGLog", e uma visão faz o `coalesce` |
| R8 | **`stock_balances` precisa continuar correto** para vitrine, marketplaces, orçamentos, bot e relatórios | vários | `moveStock` atualiza o saldo do depósito e o total na mesma transação, sempre na mesma ordem de bloqueio (total → depósito) para evitar deadlock. Teste de reconciliação na suíte |
| R9 | **Semântica de `damage`.** Hoje tira do físico (baixa). O SGLog quer saldo "avariado" | `lib/stock.ts` | Manter `damage` como baixa. Criar `quarantine` e `release_quarantine` (físico ↔ avariado) e `block`/`unblock` (físico ↔ bloqueado) |
| R10 | **Inventário é uma contagem aberta no sistema todo** | índice `inventory_counts_one_open` | Trocar por uma aberta por depósito |
| R11 | **`supplier_products ON DELETE CASCADE`**, `GRANT DELETE` em fornecedores e ofertas, e PUT de ofertas que apaga e regrava | 0004, `suppliers.ts` | Trocar para `RESTRICT`, revogar DELETE e usar exclusão lógica (`status`). O PUT de ofertas passa a fazer *upsert* e gravar histórico de preço por gatilho |
| R12 | **WhatsApp `UNIQUE (order_id, event)`** só permite um aviso de despacho por pedido | 0010 | Adicionar `shipment_id` e trocar a unicidade para (pedido, evento, remessa). O modelo aprovado na Meta continua o mesmo |
| R13 | **Pedidos de marketplace** (Mercado Livre e Shopee) usam a logística do marketplace | `marketplaces.ts` | Proposta: entram no SGLog só para separação e conferência do estoque próprio. Frete e etiqueta ficam no marketplace. **Confirmar com você** |
| R14 | **Cotação tem origem fixa** no CEP da empresa | `quoteShipping` | O adaptador recebe a origem da remessa (depósito ou fornecedor). **Não presumir** que o Melhor Envio, a Frenet ou a Kangu aceitam terceiro como remetente: isso é configuração por adaptador, conferida na documentação oficial antes de ativar |
| R15 | **Custos externos.** Compra de frete e etiqueta custam dinheiro | — | Sem contratação nem chamada paga sem sua autorização. Primeiro, operação manual mais adaptador Fake. Os adaptadores reais ficam atrás de chave de configuração desligada |
| R16 | **Numeração de migrações e sessões paralelas.** 0019 está no GitHub, mas não está confirmada no servidor (§6.0.1) | — | SGLog a partir de 0020, depois de a 0019 estar confirmada no servidor |
| R17 | **Dados fictícios.** `demo:seed` e `demo:reset` existem | `db/demo.ts` | O cenário de homologação roda só em `loja_test` ou num banco de homologação, nunca em produção |
| R18 | **Rotinas no mesmo processo da API** (`setInterval`) | `server.ts` | Novas rotinas seguem o padrão `SKIP LOCKED`, com lotes pequenos e tempo-limite. Nada pesado dentro da requisição |

---

## 5. Proposta de estrutura de banco de dados

Este é o **modelo-alvo** completo, mostrado para conferir a coerência do conjunto. As subseções 5.1 a 5.7 descrevem o destino; elas **não** são o conteúdo de uma migração. A divisão real por fase está na §6: cada fase cria só o que ela usa.

Segue as convenções do projeto:

- nomes em inglês e snake_case;
- `uuid` como chave e `bigint IDENTITY` nos livros;
- dinheiro em `bigint *_cents` e custo unitário em `numeric(16,4)`;
- quantidade em `numeric(14,3)` na unidade base;
- CHECKs, `created_at`/`updated_at`, `forbid_mutation` nos históricos;
- GRANTs mínimos para `loja_app`.

### 5.1 Estoque (0020_sglog_estoque)

```
warehouses
  id, code UNIQUE, name, kind ('own'), cep, street, number, complement, district, city, uf,
  is_default (UNIQUE parcial: um só), active, created_at, updated_at
  -- a migração cria o depósito padrão "PRINCIPAL" (endereço preenchido pelo painel, sem inventar)

stock_location_balances                    -- saldo por depósito × variante
  warehouse_id, variant_id (PK composta),
  on_hand ≥0, reserved ≥0, blocked ≥0, damaged ≥0, in_transit ≥0,
  bin text (localização), min_qty, max_qty (CHECK max ≥ min), updated_at
  -- disponível = on_hand - reserved (mesma regra de hoje)

stock_balances (existente)                 -- continua sendo o TOTAL por variante (on_hand e reserved = soma dos depósitos)

stock_movements (existente) + colunas:
  warehouse_id NULL (nulo = histórico anterior, depósito padrão),
  counter_warehouse_id (destino/origem na transferência),
  blocked_delta, damaged_delta, in_transit_delta (default 0),
  document_ref text, reverses_id bigint REFERENCES stock_movements (estorno),
  kind += 'transfer_out','transfer_in','block','unblock','quarantine','release_quarantine','reversal'
  source_type += 'fulfillment','shipment','return','supplier_request'
  CHECK: estorno exige reverses_id e motivo; transferência exige counter_warehouse_id

stock_reservations (existente) + colunas: warehouse_id, allocation_id

inventory_counts + warehouse_id; índice "uma aberta" passa a ser por depósito

stock_reconciliations (imutável)           -- resultado de cada conferência livro × saldo
  id, warehouse_id, variant_id, ledger_on_hand, balance_on_hand, diff, checked_at, checked_by, fixed_by_movement_id
```

### 5.2 Fornecedores (0021_sglog_fornecedores)

```
suppliers + trade_name, cep, street, number, complement, district,
  prep_days, delivery_days, return_policy, dropship_enabled boolean,
  status ('active','inactive','blocked') (o `active` atual é mantido por compatibilidade, sincronizado)
  -- revogar DELETE de loja_app

supplier_contacts + whatsapp, is_primary

supplier_products + variant_id (derivado da embalagem), min_order_packs, prep_days, dropship_allowed,
  is_primary (UNIQUE parcial por variante), status ('active','paused','ended'), created_at
  -- FK de suppliers passa a ON DELETE RESTRICT; revogar DELETE

supplier_price_history (imutável, gatilho como packagings_price_history)
  id, supplier_product_id, old_cost_cents, new_cost_cents, changed_by, changed_at

supplier_availability (imutável; a última linha é a vigente)
  id, supplier_product_id, available_qty (unidade base), confirmed_at, valid_until,
  source ('manual','api'), note, created_by
  -- "vencida" = valid_until < now(): o motor sinaliza confirmação manual
```

### 5.3 Atendimento e remessas (0022_sglog_atendimento)

```
orders + logistics_status ('awaiting','analysis','processing','partially_shipped','shipped',
                           'partially_delivered','completed','canceled') NULL até pago

fulfillments                               -- um atendimento por origem
  id, order_id, source_kind ('own','supplier'), warehouse_id NULL, supplier_id NULL,
  status ('proposed','confirmed','in_progress','done','canceled'),
  origin_snapshot jsonb (endereço/CEP da origem no momento), created_by, confirmed_by, confirmed_at, version
  CHECK (source_kind='own') = (warehouse_id IS NOT NULL) e (source_kind='supplier') = (supplier_id IS NOT NULL)

fulfillment_allocations                    -- item × origem × quantidade
  id, fulfillment_id, order_item_id, base_qty >0,
  supplier_product_id NULL, unit_cost_cents numeric(16,4) (cópia), supplier_sku (cópia),
  reservation_id NULL, status ('active','canceled'), justification, created_by, created_at
  -- gatilho: soma das alocações ativas de um item ≤ packs × base_qty_per_pack do item

allocation_changes (imutável)              -- troca de origem antes da confirmação, com justificativa

shipments (existente): remover UNIQUE(order_id); + fulfillment_id, status (12 estados da spec),
  origin_cep, service, freight_cost_cents, packaging_cost_cents, label_id, posted_at, version, updated_at
  -- linhas antigas: fulfillment_id nulo e status derivado (shipped/delivered)

shipment_items      (shipment_id, allocation_id, base_qty) PK composta
shipment_volumes    (shipment_id, n, weight_g, length_mm, width_mm, height_mm)
shipment_checks     (imutável) conferência item a item: shipment_id, allocation_id, qty_checked, checked_by, checked_at
shipment_events     (imutável) shipment_id, status, source ('manual','carrier'), provider_event_id,
                    occurred_at, note, UNIQUE (shipment_id, provider_event_id) → rastreio duplicado é ignorado

supplier_requests
  id, number (sequência), fulfillment_id, supplier_id, status (8 estados da spec),
  ship_to_snapshot jsonb, due_at, notes, sent_at, confirmed_at, supplier_ship_by, tracking_code,
  supplier_invoice_key, version
supplier_request_events (imutável): status, note, divergence jsonb, actor_id
```

### 5.4 Compras (0023_sglog_compras)

```
purchase_orders + purpose ('replenishment','fulfillment'), fulfillment_id NULL, warehouse_id,
  status += 'pending_approval','approved'; approved_by/at, paid_at, payment_ref, tracking_code
purchase_receipts + warehouse_id
purchase_receipt_issues (imutável): receipt_id, item_id, kind ('quantity','quality','price'), expected, found, note
  -- quantidade reprovada vai para o saldo "avariado" ou "bloqueado", nunca para o disponível
```

O recebimento continua sendo a própria conferência. O estoque só entra quando o recebimento conferido é registrado, que é o comportamento de hoje.

### 5.5 Frete e integrações (0024_sglog_frete)

```
carrier_providers   (code PK: 'manual','melhorenvio','frenet','kangu'), enabled, capabilities jsonb
                    -- credenciais SÓ no .env; nada de token no banco em claro
shipping_quotes     shipment_id, provider, service, price_cents, days, origin_cep, dest_cep, expires_at, chosen
shipping_labels     shipment_id, provider, external_id, status ('requested','purchased','printed','canceled','failed'),
                    cost_cents, idempotency_key UNIQUE, tracking_code, created_by
integration_jobs    id, kind, ref_id, idempotency_key UNIQUE, status ('queued','running','done','failed','dead'),
                    attempts, next_attempt_at, last_error (≤500, sem dados pessoais), created_at, updated_at
integration_logs    (imutável) job_id, provider, operation, http_status, duration_ms, ok, created_at  -- sem corpo
logistics_webhook_events  provider, dedupe_key, payload, signature_valid, processed_at, error  UNIQUE (provider, dedupe_key)
whatsapp_messages + shipment_id; unicidade (order_id, event, coalesce(shipment_id))
```

### 5.6 Ocorrências e devoluções (0025_sglog_ocorrencias)

```
logistic_occurrences  id, order_id, shipment_id, order_item_id NULL, allocation_id NULL,
                      kind ('damaged','lost','late','refused','wrong_item','regret','exchange','refund','reverse'),
                      responsibility ('company','supplier','carrier','customer','undetermined'),
                      status ('open','in_progress','resolved','canceled'), blocks_completion boolean, resolution, version
occurrence_events     (imutável)
returns               id, order_id, occurrence_id, status, reverse_label_id NULL, refund_ref, refund_cents
return_items          return_id, allocation_id, base_qty, condition ('good','damaged') → movimento 'return' ou 'quarantine'
```

O reembolso é **registro** do que foi feito no Mercado Pago. O SGLog não move dinheiro.

### 5.7 Custos (0026_sglog_custos)

```
payments + fee_cents NULL (informado/obtido do provedor)
cost_settings         (padrão informado → validado de fiscal_rules) alíquotas e taxas parametrizadas, com histórico
packaging_materials   (opcional) custo de caixa/fita por volume
VIEWs: v_shipment_costs, v_order_margin, v_margin_by_product, v_margin_by_supplier, v_freight_by_region
```

A margem só é chamada de "margem de contribuição". "Lucro líquido" não aparece enquanto `cost_settings` não estiver validado.

### 5.8 Permissões e papéis (sem migração de dados)

- **Novas permissões em `PERMISSIONS`:**
  - `logistics.view`, `logistics.manage`, `logistics.allocate`;
  - `stock.transfer`, `stock.adjust` (MFA);
  - `suppliers.view`, `suppliers.manage`;
  - `purchases.approve`;
  - `shipping.labels` (MFA: gasta dinheiro);
  - `returns.manage`, `costs.view`.
- **Papéis.** Ampliar o CHECK de `users.role` com `logistics` (gerente de logística), `buyer` (comprador) e `finance` (financeiro).
- **Correspondência com os perfis da especificação:**

| Perfil da especificação | Papel no sistema |
|---|---|
| Administrador | `owner` e `manager` |
| Estoquista | `stock` |
| Atendimento | `sales` |
| Expedição | `shipping` |

---

## 6. Plano de migração

### 6.0 Migrações por fase (revisado após aprovação)

Uma migração por fase, criada só quando a fase começa. Os números são previstos e podem mudar se outra entrega criar migração antes.

| Fase | Migração | Conteúdo, e somente isto |
|---|---|---|
| 1 | `0020_sglog_depositos` | `warehouses` (depósito padrão), `stock_location_balances` (só `on_hand` e `reserved`) mantida por gatilho, `stock_movements.warehouse_id`, `stock_reconciliations` + `stock_reconcile()`, papéis novos no CHECK de `users.role` |
| 2 | `0021_sglog_fornecedores` | Campos novos de `suppliers`, `supplier_contacts` e `supplier_products`; `supplier_price_history`; `supplier_availability`; FK `RESTRICT` e revogação de DELETE |
| 3 | `0022_sglog_estoque` | Saldos bloqueado, avariado e em trânsito; tipos novos de movimento (transferência, bloqueio, quarentena, estorno); `document_ref` e `reverses_id`; localização, mínimo e máximo por depósito; inventário por depósito; `stock_reservations.warehouse_id`; escrita em `warehouses` |
| 4 | `0023_sglog_distribuicao` | `orders.logistics_status`; `fulfillments`; `fulfillment_allocations`; `allocation_changes`; `stock_reservations.allocation_id`; trava de dropshipping (`logistics_settings`, D3) |
| 5 | `0024_sglog_remessas` | `shipments` sem UNIQUE e com campos novos; `shipment_items`; `shipment_events`; `whatsapp_messages.shipment_id` |
| 6 | `0025_sglog_compras` | Finalidade, aprovação e pagamento da compra; `purchase_receipts.warehouse_id`; `purchase_receipt_issues` |
| 7 | `0026_sglog_expedicao` | `shipment_volumes`; `shipment_checks`; `supplier_requests`; `supplier_request_events` |
| 8 | `0027_sglog_frete` | `carrier_providers`; `shipping_quotes`; `shipping_labels`; `integration_jobs`; `integration_logs`; `logistics_webhook_events` |
| 9 | `0028_sglog_ocorrencias` | `logistic_occurrences`; `occurrence_events`; `returns`; `return_items` |
| 10 | `0029_sglog_custos` | `payments.fee_cents`; `cost_settings`; visões de margem |
| 11 | — | Sem tabela nova prevista. Só correções que a revisão encontrar, em migração própria |

### 6.0.1 Dependência da 0019 (importação de produtos)

- **No GitHub.** O commit `15fc2a1` (migração `0019_importacao_produtos`) **está** no GitHub: `origin/main` em `cac8397` contém `15fc2a1`. Conferido com `git merge-base` em 16/11/2026.
- **No servidor: não confirmado.** Não tenho acesso ao servidor, e estar no GitHub não prova que o servidor fez `git pull` e `npm run migrate`. A conferência é o comando da §11.1, executado por você.
- **Dependência técnica.** A 0020 não usa nenhuma tabela da 0019. A dependência é de ordem: `migrate.ts` aplica **todas** as pendentes em ordem de nome. Se a 0019 não estiver no servidor, aplicar a Fase 1 aplicaria as duas juntas.
- **Regra adotada.** Se a 0019 estiver pendente no servidor, ela sobe **antes e separadamente**, no procedimento normal (`docs/IMPLANTACAO.md` §9). A Fase 1 só sobe depois.
- **Commits locais.** Há 7 commits locais ainda não enviados ao GitHub (de `9e0e493` a `bb6f6dc`: backup fora do servidor, correções no celular, testes pendentes). Nenhum tem migração.

### 6.1 Regras gerais

1. **Pré-requisito.** A 0019 (importação) precisa estar aplicada no servidor (§6.0.1). Só depois vem a 0020, e daí em diante uma migração por fase, cada uma com `.down.sql`.
2. **Só migrações aditivas.** Colunas novas são anuláveis ou têm *default*. Nenhuma tabela existente é apagada. A única regra relaxada é `shipments.order_id UNIQUE`, e os CHECKs de `kind`, `source_type` e `status` são ampliados.
3. **Sem reescrever histórico.** `stock_movements` antigos ficam com `warehouse_id` nulo (R7).
4. **Carga inicial de `stock_location_balances`.** Uma linha por variante no depósito padrão, copiando `stock_balances.on_hand` e `reserved`. Os baldes novos começam em zero. A reconciliação roda logo depois e o resultado fica gravado.
5. **Fornecedores.**
   - `status` é preenchido a partir de `active`.
   - `variant_id` das ofertas é preenchido a partir da embalagem.
   - O histórico de preço começa com uma linha "valor inicial" por oferta.
6. **Pedidos.**
   - `logistics_status` é calculado para os pedidos existentes: `paid`, `preparing` e `ready` viram `awaiting`; `shipped` vira `shipped`; `delivered` vira `completed`; `canceled` vira `canceled`. O `status` não muda.
   - Pedidos antigos **não** ganham atendimentos retroativos. A remessa existente continua ligada ao pedido.
7. **Ordem no servidor.** O procedimento completo de backup, ensaio, aplicação e reversão está na §11.
8. **Volta atrás.** Cada `.down.sql` remove só o que a fase criou. Depois de haver remessas múltiplas reais, voltar o UNIQUE exige decisão manual, e isso fica documentado.

---

## 7. Plano de desenvolvimento por etapas

Cada fase termina com:

- suíte completa verde, sem regressão nos 287 testes atuais;
- typecheck;
- reconciliação de estoque;
- revisão de permissões;
- documentação em `docs/15-sglog-*.md`;
- commit local.

| Fase | Entrega | Depende de |
|---|---|---|
| 1 | Fundação: migração 0020 (depósitos, saldo por depósito por gatilho, reconciliação, papéis novos), trava contra testes em produção, ensaio de migração em cópia restaurada. Escopo exato na §10 | autorização |
| 2 | Fornecedores: API e telas (campos novos, ofertas com *upsert*, histórico de preço, disponibilidade com validade, fornecedor principal, exclusão lógica) | 1 |
| 3 | Estoque: `moveStock` com depósito e baldes, transferência, bloqueio, quarentena, estorno, inventário por depósito, mínimo e máximo, alertas, reconciliação e telas | 1 |
| 4 | Motor de distribuição (`lib/allocation.ts`, puro e com testes unitários), `logistics_status`, atendimentos e alocações, tela de comparação e confirmação, troca de origem com justificativa, trava de dropshipping (D3) | 2, 3 |
| 5 | Pedidos e remessas: gancho no pagamento, reservas por alocação, remessas múltiplas, cancelamento parcial e total, projeção para `orders.status`, página do cliente por remessa. Instalação do Playwright (D6), com o ponta a ponta do checkout atual gravado **antes** de mexer no fluxo | 4 |
| 6 | Compras e recebimentos: finalidade, aprovação, pagamento, divergências, recebimento por depósito | 3 |
| 7 | Expedição (fila, checklist obrigatório, volumes, postagem manual) e solicitações a fornecedores (gerar, copiar, imprimir, confirmar, rastreio, divergência) | 5 |
| 8 | Fretes: adaptadores (manual mais Fake; Melhor Envio só cotação com origem real), fila `integration_jobs`, webhooks, rastreio deduplicado, aviso por remessa. **Contratação e etiqueta reais só com sua autorização** | 5, 7 |
| 9 | Ocorrências e devoluções, com retorno ao estoque bom ou avariado e bloqueio de conclusão | 5 |
| 10 | Custos, visões de margem, relatórios e dashboards (dados reais, paginados) | 6–9 |
| 11 | Segurança (revisão de rotas e permissões, LGPD, logs), testes de carga com k6, cenário de homologação automatizado e documentação final | todas |

O menu LOGÍSTICA entra na Fase 2 e cresce a cada fase. As seções sem entrega ainda não aparecem: não haverá telas vazias.

---

## 8. Estratégia de testes

- **Unitários.** O motor de distribuição é uma função pura, testada com tabelas de casos.
- **Integração.** É o padrão do projeto: vitest com Fastify `inject`, no banco `loja_test`, com a API conectada como `loja_app` e o dono só preparando cenários.
  - Provedores Fake: `FakeCarrier` estendido com `failQuote`, `failLabel` e eventos duplicados.
  - Testes de privilégio: `loja_app` não consegue fazer UPDATE nem DELETE no histórico.
- **Ponta a ponta.** Playwright como dependência de desenvolvimento (D6), a partir da Fase 5. Roda contra a API e a web locais, nos bancos `loja_test`/`loja_dev`, nunca contra o domínio de produção. O fluxo completo do pedido também é coberto pela API com `inject`.
- **Carga.** Só em ambiente local ou de homologação, nunca no servidor de produção. Novos cenários k6 em `tests/carga/`:
  - reservas concorrentes na mesma variante;
  - listagem de pedidos logísticos e remessas paginada com 50 mil remessas semeadas em banco de teste;
  - consulta de rastreio.

### Os 18 casos obrigatórios

| # | Caso | Arquivo / técnica |
|---|---|---|
| 1 | Só estoque próprio | `allocation.test.ts`: sugere 100% próprio |
| 2 | Só fornecedor | Sugere fornecedor com dropshipping; sem dropshipping, "sem origem" |
| 3 | Duas origens | Prioriza o próprio e mostra a comparação de custo e prazo |
| 4 | Divisão estoque + fornecedor | Exemplo da especificação: 10 próprio + 5 fornecedor A |
| 5 | Dois fornecedores | Ordena por custo, prazo e preferência; mostra os dois |
| 6 | Estoque insuficiente | Confirmação recusada com `INSUFFICIENT_STOCK`, saldo intacto |
| 7 | Disponibilidade vencida | Oferta vencida aparece marcada e exige confirmação manual; não entra no automático |
| 8 | Reserva concorrente | Duas transações simultâneas na mesma variante: só uma passa, sem saldo negativo (padrão de `stock.test.ts`) |
| 9 | Cancelamento parcial | Cancela uma alocação: libera a reserva, o pedido segue, auditoria gravada |
| 10 | Recebimento parcial de compra | 2 recebimentos, estoque entra só nos conferidos, divergência registrada |
| 11 | Falha na contratação do frete | Fake falha: job com nova tentativa, remessa não muda de estado, sem cobrança duplicada |
| 12 | Falha na etiqueta | Etiqueta fica `failed` e a `idempotency_key` impede duas compras |
| 13 | Rastreio duplicado | Mesmo `provider_event_id` duas vezes: 1 evento gravado |
| 14 | Entrega parcial | 1 de 3 remessas entregue: `partially_delivered`; o pedido não conclui |
| 15 | Devolução parcial | Devolve parte de um item: estoque bom ou avariado conforme a condição |
| 16 | Usuário sem permissão | 403 em cada rota nova para papéis sem a permissão (teste em tabela, como `security.test.ts`) |
| 17 | Alterar histórico | `loja_app` UPDATE/DELETE em movimentos, eventos, histórico de preço e auditoria → erro `restrict_violation` |
| 18 | Recuperação após falha de integração | Job falha 2×, depois sucede; `dead` após o limite; reprocessamento manual |

### Cenário de homologação (`sglog-homologacao.test.ts`, automatizado)

O teste usa 5 produtos: P1 e P2 no estoque próprio, P3 e P4 no fornecedor A, P5 no fornecedor B. Os passos são:

1. Checkout real (`/public/checkout`) com pagamento Fake aprovado (webhook).
2. O pedido entra em `awaiting`.
3. A distribuição confirmada reserva P1 e P2 no depósito.
4. Gera o atendimento e a solicitação ao fornecedor A (P3, P4) e ao fornecedor B (P5).
5. Cria 3 remessas com cotação Fake, cada uma com o CEP de origem correto, verificado pela chamada registrada no Fake.
6. Registra 3 rastreios.
7. Entrega a remessa 1 e verifica que o pedido fica `partially_delivered`.
8. Uma ocorrência aberta na remessa 2 impede a conclusão.
9. Com tudo resolvido, o pedido fica `completed`.

Variantes do mesmo cenário cobrem cancelamento de P5, falha de etiqueta e divergência do fornecedor.

O cenário roda só em `loja_test` ou num banco de homologação, nunca em produção.

---

## 9. Estimativa de complexidade por módulo

| Módulo | Complexidade | Por quê |
|---|---|---|
| A Fornecedores | Média | A base existe; faltam campos, histórico e disponibilidade com validade |
| B Estoque | **Alta** | Depósitos e baldes sem quebrar o total lido por 6 módulos; concorrência; estorno; reconciliação |
| C Motor de distribuição | **Alta** | Regras, validade, comparação e divisão parcial; precisa de muitos testes |
| D Pedidos e atendimentos | **Alta** | Integra com pagamento, reservas do checkout, NF-e, `orders.status` e várias remessas (R1–R4) |
| E Expedição | Média | Telas e conferência; postagem manual primeiro |
| F Solicitações a fornecedores | Média-baixa | Fluxo manual com estados e impressão |
| G Compras e recebimentos | Média-baixa | A base existe; faltam aprovação, finalidade e divergências |
| H Fretes | **Alta** (integrações reais) / Média (estrutura + manual) | Cada plataforma tem regras próprias; a parte real depende da sua autorização |
| I Devoluções e ocorrências | Média | Estados, responsabilidades e retorno ao estoque |
| J Custos e rentabilidade | Média | Visões SQL; depende de alíquotas validadas pelo contador |
| Painel LOGÍSTICA | Média-alta | 10 seções no padrão atual, responsivas, com filtros e paginação |
| Segurança e testes (Fase 11) | Média | O padrão do projeto já é forte; trabalho de cobertura e carga |

---

---

## 10. Escopo exato da Fase 1: fundação (aguarda autorização)

**Objetivo.** Criar a base de depósitos e de conferência do estoque sem mudar o comportamento de nenhuma função existente. Ao final da fase, a loja, o checkout, os pagamentos, a NF-e, os marketplaces e o painel funcionam exatamente como antes. A única novidade visível são os três papéis novos na tela de Usuários.

### 10.1 Migração `0020_sglog_depositos` (up e down)

- **`warehouses`.** Campos: `id`, `code` UNIQUE, `name`, endereço (anulável), `is_default` (índice único parcial: um só) e `active`, mais `created_at` e `updated_at`.
  - A migração cria só o depósito padrão `PRINCIPAL` ("Depósito principal"), **sem endereço**. O endereço será informado pelo painel na Fase 3, sem dado inventado.
  - `loja_app` só tem SELECT nesta fase.
- **`stock_location_balances`.** Chave (`warehouse_id`, `variant_id`), com `on_hand ≥ 0`, `reserved ≥ 0` e `updated_at`.
  - Os saldos bloqueado, avariado e em trânsito, a localização e o mínimo/máximo ficam para a Fase 3.
  - `loja_app` só tem SELECT: o saldo por depósito só muda pelo gatilho.
- **`stock_movements.warehouse_id`.** Coluna anulável com FK para `warehouses`. Nulo significa "depósito padrão". As linhas antigas **não são reescritas**: é um `ADD COLUMN` sem valor padrão, que não altera nem regrava as linhas existentes.
- **Gatilho `stock_movements_location`.**
  - Roda AFTER INSERT em `stock_movements`, como SECURITY DEFINER.
  - Aplica `on_hand_delta` e `reserved_delta` ao saldo de `coalesce(warehouse_id, depósito padrão)`.
  - Assim, **`lib/stock.ts` não muda**: todo movimento atual já passa a alimentar o saldo por depósito.
  - Ordem de bloqueio: o saldo total é bloqueado antes, por `moveStock`; o do depósito, depois, pelo gatilho. Como existe um só caminho, não há risco de deadlock.
- **Carga inicial.** Uma linha por variante no depósito padrão, copiada de `stock_balances` (`on_hand`, `reserved`), na mesma transação da migração.
- **`stock_reconciliations` e `stock_reconcile()`.**
  - A tabela é imutável (`forbid_mutation`).
  - A função compara, por variante: (a) `stock_balances` com a soma dos depósitos; (b) `stock_balances.on_hand` e `reserved` com a soma dos deltas do livro; (c) o saldo com o `on_hand_after` e `reserved_after` do último movimento.
  - Ela devolve as divergências e grava a execução. **Não corrige nada**: correção é por lançamento compensatório, na Fase 3.
  - `loja_app` tem EXECUTE na função e SELECT na tabela.
- **`users.role`.** O CHECK passa a aceitar `logistics`, `buyer` e `finance`.
- **Down.**
  - Recusa com mensagem clara se houver usuário com papel novo.
  - Remove gatilho, função, tabelas e a coluna `warehouse_id`, e devolve o CHECK original.
  - Não toca em nenhuma linha de `stock_movements` nem de `stock_balances`.

### 10.2 Arquivos criados

| Arquivo | Conteúdo |
|---|---|
| `apps/api/migrations/0020_sglog_depositos.up.sql` | §10.1 |
| `apps/api/migrations/0020_sglog_depositos.down.sql` | Reversão (§10.1) |
| `apps/api/test/sglog-fase1.test.ts` | Testes da §10.4 |
| `docs/15-sglog-fase1.md` | O que foi feito, decisões, resultado dos testes, procedimento aplicado |

### 10.3 Arquivos modificados

| Arquivo | Mudança | Por que é necessária |
|---|---|---|
| `apps/api/src/lib/permissions.ts` | `ROLES` ganha `logistics`, `buyer` e `finance`; `ROLE_DEFAULTS` dá a eles **só permissões que já existem** (ver abaixo). Nenhuma permissão nova nesta fase; `MFA_REQUIRED` não muda | D5 |
| `apps/web/src/lib/format.ts` | `ROLE_LABELS`: "Logística", "Comprador", "Financeiro" | O painel de usuários mostra o papel pelo rótulo |
| `apps/api/test/helpers.ts` | Inclui `stock_location_balances` e `stock_reconciliations` na limpeza entre testes; chama a trava de ambiente (§12) | A limpeza atual apaga `stock_balances`; o saldo por depósito precisa ser limpo junto |
| `apps/api/vitest.config.ts` | Trava de ambiente antes de qualquer teste (§12) | Restrição permanente: nada de teste em produção |
| `scripts/backup.mjs` | Comando novo `migrate-rehearsal <pasta>` (§11.2) | Homologar a migração em cópia real antes da produção |
| `docs/BACKUP.md` e `docs/IMPLANTACAO.md` | Documentar o ensaio e a conferência pós-migração | Procedimento |
| `docs/TESTES-PENDENTES.md` | Conferências que só você pode fazer no servidor | Regra do projeto |

**Padrões dos papéis novos**, editáveis pelo proprietário como hoje:

| Papel | Permissões padrão |
|---|---|
| `logistics` | `catalog.view`, `stock.view`, `stock.manage`, `purchases.view`, `orders.view`, `shipping.manage`, `reports.view` |
| `buyer` | `catalog.view`, `stock.view`, `purchases.view`, `purchases.manage` |
| `finance` | `orders.view`, `purchases.view`, `finance.view`, `reports.view` |

As permissões `logistics.*`, `suppliers.*`, `purchases.approve`, `shipping.labels` e as demais só nascem na fase que cria a tela ou a rota correspondente.

**Não mudam:** `lib/stock.ts`, `orders.ts`, checkout, `payments.ts`, `fiscal.ts`, `storefront.ts`, `marketplaces.ts` e o menu do painel.

### 10.4 Testes da Fase 1 (`sglog-fase1.test.ts`)

1. Existe exatamente um depósito padrão, e um segundo `is_default` é recusado.
2. Entrada, venda, perda, ajuste, reserva, liberação e consumo pelo código atual atualizam o saldo do depósito igual ao total.
3. Depois de uma sequência mista, incluindo um checkout real com pagamento Fake e despacho, `stock_reconcile()` não encontra divergências.
4. Divergência provocada pelo dono do banco (só no teste) é detectada e gravada em `stock_reconciliations`.
5. `loja_app` não consegue INSERT, UPDATE nem DELETE em `stock_location_balances`, nem UPDATE ou DELETE em `stock_reconciliations`, nem INSERT em `warehouses`.
6. A saída maior que o saldo continua devolvendo `INSUFFICIENT_STOCK`, sem erro novo.
7. Reservas concorrentes na mesma variante: só uma passa, e o saldo do depósito acompanha o total.
8. Os papéis novos podem ser criados pelo proprietário; o gerente não pode criar proprietário (regra atual mantida); `buyer` recebe 403 em `orders.manage`; `finance` recebe 403 em `stock.manage`.
9. Trava de ambiente: recusa `DB_NAME_TEST` vazio, igual a `DB_NAME`, igual a `loja_prod` ou com `NODE_ENV=production` no `.env`.

**Critério de aceite:**
- 287 testes atuais mais os novos, todos passando;
- `npm run typecheck` nas duas aplicações;
- `migrate --test` up → down → up sem erro no banco de testes local;
- ensaio (§11.2) numa cópia restaurada sem divergências.

### 10.5 Riscos da Fase 1

| Risco | Efeito se acontecer | Mitigação |
|---|---|---|
| Erro no gatilho bloqueia **todo** movimento de estoque (vendas incluídas) | Checkout falha | Os 25 testes de loja e os 12 de estoque passam pelo gatilho; ensaio em cópia real; reversão só de código não basta, então há o `down` (§11.4) |
| Gatilho acrescenta uma escrita por movimento | Latência maior no checkout | Uma linha por movimento, mesma transação; medir a duração da suíte antes e depois |
| A 0019 sobe junto sem querer | Duas mudanças no mesmo deploy | Conferência da §11.1 antes; a 0019 sobe separada se estiver pendente |
| `.env` do servidor sem `DB_NAME_TEST` | `npm test` no servidor poderia mirar banco errado | Trava da §12; testes não rodam no servidor |
| `down` com usuários nos papéis novos | Reversão recusada | Mensagem clara: trocar o papel desses usuários antes |
| Reconciliação acusar divergência antiga já existente em produção | Ensaio "reprova" por dado antigo | O ensaio mostra antes; divergência antiga é relatada a você e corrigida só na Fase 3, por lançamento compensatório com justificativa |

---

## 11. Procedimentos: backup, homologação, aplicação e reversão

Os comandos rodam no servidor, por você, como hoje. Eu entrego os comandos e leio a saída que você colar.

### 11.1 Conferência prévia (só leitura)

```bash
cd /srv/loja-embalagens && sudo -u loja git log -1 --oneline && ls apps/api/migrations | tail -2
```

```bash
cd /srv/loja-embalagens && sudo -u loja node --env-file=.env --input-type=module -e 'import pg from "pg"; const c = new pg.Client({ host: process.env.DB_HOST, port: +process.env.DB_PORT, user: process.env.DB_OWNER_USER, password: process.env.DB_OWNER_PASSWORD, database: process.env.DB_NAME }); await c.connect(); console.table((await c.query("SELECT name, applied_at FROM schema_migrations ORDER BY name DESC LIMIT 3")).rows); await c.end();'
```

Se `0019_importacao_produtos` não aparecer, ela sobe antes, sozinha (`docs/IMPLANTACAO.md` §9), e a Fase 1 espera.

### 11.2 Backup e homologação (ensaio em cópia restaurada)

1. `npm run backup` e `npm run backup:restore-test -- backups/<pasta nova>` (já existentes).
2. **Ensaio.** `node scripts/backup.mjs migrate-rehearsal backups/<pasta nova>` (novo na Fase 1). Ele:
   - restaura a cópia num banco temporário `loja_ensaio`;
   - aplica as migrações pendentes **nesse banco**;
   - roda `stock_reconcile()`;
   - compara as contagens das tabelas antigas (nenhuma pode mudar);
   - mostra o resultado e apaga o banco temporário.

   **Não toca no `loja_prod`.**
3. Só se o ensaio passar sem erro e sem divergência nova segue-se para a aplicação.

Não existe servidor de homologação separado. A homologação da migração é este ensaio em cópia real; a homologação funcional fica na suíte local.

### 11.3 Aplicação

1. `git pull` (depois de você autorizar o envio ao GitHub) e `npm ci`.
2. `npm run migrate`.
3. Build: `npm run build -w apps/api` e `npm run build -w apps/web`.
4. `sudo systemctl restart loja-api loja-web`.
5. Conferências:
   - `/ready`;
   - painel de pedidos e de estoque;
   - `stock_reconcile()` sem divergências (comando entregue na fase);
   - log sem erro (`journalctl -u loja-api -n 100`).

### 11.4 Reversão (do mais leve ao mais pesado)

1. **Só código.** `git checkout <commit anterior>`, build e restart.
   - O código antigo funciona com a 0020 aplicada: o gatilho é transparente para ele.
2. **Banco.** `npm run migrate -w apps/api -- down` desfaz **só** a última migração (0020).
   - Perde só o saldo por depósito, que é derivado e recalculável.
   - Os movimentos e os saldos totais ficam intactos.
3. **Último recurso.** Restaurar o backup (`docs/BACKUP.md`).
   - Perde o que foi gravado depois do backup (pedidos, pagamentos, notas).
   - Só com sua decisão, depois de conferir o que entrou nesse intervalo.

---

## 12. Salvaguardas contra execução em produção

- **Testes.** `vitest.config.ts` e `test/helpers.ts` passam a **abortar** antes de conectar se:
  - `NODE_ENV=production` no `.env`;
  - `DB_NAME_TEST` está vazio;
  - `DB_NAME_TEST` é igual a `DB_NAME`;
  - `DB_NAME_TEST` é `loja_prod`;
  - `DB_NAME_TEST` não termina em `_test`.

  Isso é importante porque os testes apagam tabelas (`TRUNCATE`).
- **Migração de teste.** `migrate --test` só aceita bancos `loja_*`. Isso já existe e continua.
- **Seed e demonstração.** `demo:seed` e `demo:reset` já exigem `--confirmar DEMO`. O SGLog **não** cria seed próprio. O cenário de homologação roda só na suíte, em `loja_test`.
- **Carga.** O k6 só aponta para endereço local ou de homologação; o README de `tests/carga` ganha esse aviso na Fase 11.
- **Ponta a ponta (Fase 5).** A configuração do Playwright recusa `baseURL` que não seja `localhost` ou `127.0.0.1`.
- **Integrações pagas (Fase 8).** A compra de frete e etiqueta exige configuração explícita no `.env`, desligada por padrão, além da permissão `shipping.labels` com MFA. Sem autorização expressa, a configuração não é ligada.
