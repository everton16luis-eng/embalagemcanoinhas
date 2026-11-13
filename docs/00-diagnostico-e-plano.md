# Fase 1 — Diagnóstico técnico e plano

Loja virtual + ERP + central comercial + módulo fiscal (NF-e) para embalagens e utensílios de confeitaria.
Operação inicial em Canoinhas-SC, atendimento ao Planalto Norte por transportadoras.

Escrito em 13/11/2026. **Nenhum arquivo dos projetos existentes foi alterado.** Esta pasta (`loja-embalagens/`) é nova
e o nome é provisório: a marca ainda será definida.

**Aguardando aprovação** antes de criar código.

---

## 1. Projetos existentes inspecionados

### 1.1 SaaS Barbearia / Salão (`SaaS/Barbearia`)

Um único monorepo atende os dois segmentos (barbearia e salão) por uma coluna de segmento.

| Item | O que existe |
|---|---|
| Stack | Node 22+, TypeScript, **Fastify 5** (API), **Next.js 16 + React 19 + Tailwind 4** (web), **PostgreSQL** com `pg`, sem ORM |
| Banco | 33 migrations SQL versionadas com `down`; multiempresa com RLS; a API conecta com papel sem `BYPASSRLS` |
| Autenticação | Sessão por cookie, argon2, MFA TOTP (`otplib`), login social do cliente (Google/Facebook), recuperação de senha |
| Permissões | Lista granular de permissões por usuário (`lib/permissions.ts`) |
| Auditoria | `audit_logs` com ator, ação, alvo, metadados e IP |
| Criptografia | AES-256-GCM para credenciais e segredos (`lib/crypto.ts`), hash com chave para dados pessoais |
| Uploads | `sharp` com limite de pixels, recodificação e rate limit por sessão |
| Pagamentos online | Camada de gateways com contrato comum (`lib/gateways/types.ts`): **Mercado Pago, Sicoob (Pix, mTLS), PicPay, Pagar.me (Stone online), PagBank**. Capacidades declaradas, `NOT_SUPPORTED` em vez de simulação, idempotência, webhook com token + consulta ao provedor antes de valer, token de cartão gerado no navegador |
| Pagamento presencial | Camada separada de terminais/Tap to Pay — **não serve ao e-commerce** |
| Estoque | Produtos com `stock_qty integer`, uma única unidade, histórico por lançamento |
| Caixa | Livro imutável de movimentos com estorno |
| WhatsApp | Fila de mensagens com provedor **Baileys** (`@whiskeysockets/baileys`) — automação **não oficial** por QR Code |
| Testes | ~40 arquivos Vitest (RLS, segurança, webhooks, resiliência) e Playwright com axe |
| Produção | Ubuntu 24.04, nginx (CloudPanel) dividido com outros sistemas, systemd, backup diário cifrado — roteiro em `docs/INSTALACAO.md` |
| Fiscal | **Nada.** Não há NF-e, DANFE nem integração com SEFAZ |

### 1.2 AdManager Hub (`ERP -`) — encontrado durante a inspeção

Não estava no pedido, mas é diretamente relevante: catálogo e base para marketplaces.

| Item | O que existe |
|---|---|
| Stack | Express 5 + React/Vite + PostgreSQL com RLS, sem ORM |
| Catálogo | Produtos com variações (SKU, código de barras, preço e estoque próprios), categorias em árvore, características técnicas, imagens com miniatura, importação/exportação CSV/XLSX com prévia |
| Marketplaces | Contrato de conectores por capacidades (`packages/connectors`), pesquisa documentada de Mercado Livre (User Products) e Shopee. **Nenhuma integração real** |
| Situação | Fase 2 de 13 concluída; estoque ainda é campo de cadastro |

---

## 2. Reaproveitamento

Regra: **copiar e adaptar** para o novo projeto. Nada de pacote compartilhado, banco compartilhado ou import entre
repositórios — uma mudança na loja nunca pode quebrar a barbearia, e vice-versa.

| Módulo | Origem | Decisão | Observação |
|---|---|---|---|
| Estrutura API Fastify, config validada com zod, tratamento de erros | Barbearia | **Reaproveitar** | Mesma stack reduz manutenção |
| Sessão, argon2, MFA, rate limit, CSRF/origem | Barbearia | **Reaproveitar** | Separar login de equipe (com MFA obrigatório) e de cliente |
| Login social do cliente | Barbearia | Reaproveitar depois | Não é requisito da V1 |
| Permissões granulares | Barbearia | **Adaptar** | Nova lista: catálogo, estoque, compras, pedidos, expedição, fiscal, financeiro, central comercial |
| Auditoria | Barbearia | **Reaproveitar** | Ampliar com antes/depois para preço, estoque e fiscal |
| Criptografia de credenciais | Barbearia | **Reaproveitar** | Também para certificado A1 e senha dele |
| Upload de imagens | Barbearia + AdManager | **Reaproveitar** | Gerar variantes WebP/AVIF para catálogo |
| Camada de gateways | Barbearia | **Adaptar** | O contrato serve ao checkout online. Trocar a origem "atendimento/mensalidade" por "pedido". Mercado Pago e Pagar.me (Stone) atendem Pix e cartão; Sicoob só Pix; PicPay sem sandbox oficial (ver riscos) |
| Terminais / Tap to Pay | Barbearia | **Não usar** | Pagamento presencial não é checkout online |
| Estoque | Barbearia | **Não usar** | Inteiro, sem conversão de unidades, sem reserva |
| Catálogo com variações, importação XLSX | AdManager | **Adaptar** | Modelo de dados e regras; portar de Express para Fastify |
| Contrato de conectores de marketplace | AdManager | Reaproveitar na Fase 7 | Junto com a pesquisa do Mercado Livre e Shopee |
| WhatsApp Baileys | Barbearia | **Não usar** | A especificação proíbe integração não oficial. V1 usa `wa.me`; V3 usa Cloud API |
| PDF (pdfkit) | Barbearia | Reaproveitar | Orçamentos em PDF. O DANFE vem do provedor fiscal |
| Roteiro de instalação, backup, systemd | Barbearia | **Adaptar** | Mesmo servidor, usuário, banco, portas e pastas próprios |
| Padrão de testes (Vitest + Playwright + axe) | Barbearia | **Reaproveitar** | |
| Design system | Barbearia | **Não usar** | A loja precisa de identidade própria (ver seção 9) |

---

## 3. Arquitetura proposta

```
                          nginx (TLS)
          ┌──────────────────┼────────────────────┐
     loja.dominio       painel.dominio        /api/v1/...
     Next.js (SSR)      Next.js (área restrita) │
     Ambiente A         Ambientes B e C         │
          └──────────────────┴──────► API Fastify ──► PostgreSQL (banco próprio)
                                          │
                                       worker (1 processo)
                                          │
        ┌──────────────┬───────────────┬──┴───────────┬────────────────┐
   Gateways        Provedor fiscal   Transportadoras   Marketplaces (V2)  WhatsApp Cloud API (V3)
   (Pix/cartão)    (NF-e)            (frete/rastreio)
```

- **Um monorepo**, `apps/api`, `apps/web` (loja + painel no mesmo Next, separados por rota e layout) e `apps/worker`
  dentro da API. Loja e painel ficam visualmente distintos, mas um só build economiza memória no servidor.
- **Next.js com SSR/ISR** na loja: SEO das páginas de produto e categoria e carregamento rápido no celular.
- **Banco de empresa única** (sem multi-tenant). Simplifica o RLS e as consultas; a separação entre clientes e equipe
  vem das permissões.
- **Worker com fila no PostgreSQL** (`FOR UPDATE SKIP LOCKED`), sem Redis: webhooks, emissão fiscal, e-mails,
  liberação de reservas vencidas, alertas de certificado e estoque. Retentativa com recuo exponencial e registro de
  cada tentativa.
- **Outbox**: toda chamada externa (cobrar, emitir, sincronizar) nasce como registro no banco na mesma transação do
  pedido. Se a internet ou o provedor cair, o trabalho fica pendente e é retomado, nunca perdido nem duplicado.
- **Adaptadores** para pagamento, fiscal, frete e marketplace: o pedido não conhece o provedor.

---

## 4. Estrutura de banco sugerida (resumo)

Valores em centavos (`bigint`). Quantidades em `numeric(14,3)` na **unidade base** do produto.

**Empresa e configuração**
- `company_profile` (versionada: cada alteração gera nova linha; a nota guarda a versão usada)
- `fiscal_settings` (ambiente, série, próximo número, provedor, CRT/regime), `fiscal_certificates` (cifrado, validade)
- `settings` (marca, logotipo, cores, domínio, textos institucionais)

**Catálogo**
- `categories` (árvore), `products`, `product_variants` (SKU único, código de barras)
- `units` e `variant_packagings`: unidade base + embalagens de venda (unidade, pacote com N, caixa com M)
  e de compra (pacote do fornecedor com N), com fator de conversão
- `price_lists`, `price_list_items`, `quantity_tiers` (faixas progressivas configuráveis), `price_history`
- `product_fiscal` (NCM, CEST, origem, unidade/quantidade tributável) e `tax_rules`
  (por produto/grupo, operação, UF de destino, regime → CFOP, CST/CSOSN, ICMS, PIS, COFINS, IPI), com
  `validated_by`/`validated_at` do contador
- `product_images`, `turnover_class` (alto, médio, baixo giro), `lead_time_days` para sob encomenda

**Estoque**
- `stock_balances` (físico, reservado; disponível = físico − reservado), com `CHECK` e trava de linha
- `stock_movements` imutável: entrada, saída, reserva, liberação, perda, avaria, ajuste, inventário; sempre com
  origem, usuário e motivo
- `stock_reservations` com vencimento (carrinho no checkout, pedido aguardando pagamento)
- `inventory_counts` e itens

**Compras**
- `suppliers`, `supplier_contacts`, `supplier_products` (código do fornecedor, embalagem, custo, prazo)
- `purchase_orders`, itens, `purchase_receipts` (entrada), frete de aquisição rateado no custo
- `supplier_invoices` (XML de NF-e de compra importado) e conciliação item a item com divergências

**Clientes e vendas**
- `customers` (consumidor ou profissional, CPF/CNPJ, IE), `customer_addresses`
- `carts`, `orders`, `order_items` (preço, desconto e custo congelados no momento da venda), `order_status_history`
- `quotes` e itens (central comercial), conversão em pedido
- `share_events` (produto/orçamento compartilhado por `wa.me`)

**Pagamentos** (adaptado da barbearia)
- `payment_providers` (credenciais cifradas), `payment_transactions`, `payment_events` (webhooks, idempotentes)

**Fiscal**
- `fiscal_documents` (pedido, modelo, série, número, chave, protocolo, situação, ambiente, versão da empresa)
- `fiscal_document_events` (autorização, rejeição, cancelamento, CC-e, inutilização, contingência) — só inclusão
- `fiscal_files` (XML autorizado, DANFE) guardados em disco com hash
- Índice único por pedido + finalidade: impede segunda NF-e de venda para o mesmo pedido

**Expedição e financeiro**
- `carriers`, `shipping_methods`, `shipments`, `tracking_events`
- `receivables`, `payables`, `fees` (gateway, comissão de canal), visão de margem por pedido

**Plataforma**
- `users`, `sessions`, `user_permissions`, `audit_logs`, `jobs` (fila), `integration_logs`

**Marketplaces (V2)**: `channels`, `channel_listings` (SKU ↔ anúncio), `channel_prices`, `channel_orders`, `sync_errors`.

### Exemplo do fracionamento

Copo com unidade base "unidade". Compra: pacote do fornecedor com 100. Venda: unidade, pacote com 25, caixa com 1.000.
A entrada do pacote lança +100; a venda de 5 unidades lança −5; o saldo é 95. A venda de 2 pacotes de 25 lança −50.
Toda conversão é feita no servidor, a partir da tabela de embalagens.

---

## 5. Estratégia do módulo fiscal

### 5.1 Documento

- **NF-e modelo 55** para as vendas do e-commerce. É o documento das vendas não presenciais de mercadoria, inclusive
  para consumidor final pessoa física.
- **NFC-e (65)**: não prevista. É voltada à venda presencial ao consumidor; só reavaliar se houver balcão.
- **NFS-e**: não se aplica à venda de mercadorias.

### 5.2 Direto na SEFAZ ou provedor fiscal

| Critério | Direto (SEFAZ-SC / ambiente autorizador) | Provedor por API |
|---|---|---|
| Custo mensal | Sem mensalidade | Mensalidade ou valor por nota |
| Desenvolvimento | Alto: XML, assinatura digital, schemas, eventos, contingência, DANFE | Baixo a médio |
| Manutenção | Alta: cada nota técnica muda layout e regras, inclusive as da reforma tributária (IBS/CBS) | Do provedor |
| Risco | Alto para uma operação que está começando | Dependência de terceiro, mitigada pelo adaptador |

**Recomendação: provedor fiscal por API, atrás de um adaptador próprio** (`FiscalProvider`: emitir, consultar,
cancelar, CC-e, inutilizar, baixar XML/DANFE, receber webhook). Trocar de provedor depois não muda o ERP.

Candidatos a comparar na Fase 5, **com documentação, preços e SLA conferidos nas páginas oficiais na época**:
Focus NFe, Nuvem Fiscal, PlugNotas (Tecnospeed), Webmania, eNotas. Critérios: NF-e 55 em SC, homologação gratuita,
webhook, eventos, armazenamento de XML, atualização para IBS/CBS, preço para o volume inicial, suporte.

O ambiente autorizador usado por SC para NF-e, os web services e as notas técnicas vigentes serão confirmados no
Portal Nacional da NF-e e na SEF-SC antes do desenvolvimento. Não haverá endpoint nem layout escrito de memória.

### 5.3 Momento da emissão

Fluxo previsto: pagamento confirmado → validação fiscal (emitente, destinatário, itens) → pedido "apto à emissão"
→ separação → **emissão antes da liberação para a transportadora** → XML e DANFE no pedido → expedição liberada.

A política (emitir na separação ou na expedição, quem aprova, o que fazer com pedido sob encomenda pago antes da
compra) é **configurável e definida com o contador**. A expedição fica bloqueada sem NF-e autorizada.

### 5.4 Garantias

- Idempotência por pedido; número da nota reservado em transação com trava; rejeição registrada e reenviada só após correção.
- Nota autorizada nunca é apagada; cancelamento e CC-e são eventos. XML guardado com hash e incluído no backup.
- Certificado A1 cifrado, alerta de vencimento em 30, 15 e 7 dias.
- Permissão própria para emitir, cancelar e alterar configuração fiscal; tudo auditado.
- Homologação obrigatória antes de liberar o ambiente de produção (trava no sistema).
- Importação de XML de compra com conferência manual quando houver divergência.

---

## 6. Dados que a empresa precisará fornecer

Só serão pedidos quando forem necessários (homologação fiscal, credenciais de pagamento, produção). O assistente de
configuração vai mostrar o que falta.

**Empresa (sede, CNPJ emissor):** razão social, nome fantasia, CNPJ, Inscrição Estadual em SC, Inscrição Municipal
(se houver), endereço completo, código IBGE do município, telefone, e-mail, CNAE principal e secundários (precisam
cobrir comércio varejista dos produtos e venda pela internet), regime tributário (Simples Nacional, Presumido ou Real).

**Contador:** nome, CRC, escritório, contato; validação do enquadramento de cada produto (NCM, CEST, CST/CSOSN, CFOP
dentro e fora de SC, PIS/COFINS, IPI se houver), da política de emissão e do tratamento de frete, desconto e devolução.

**Fiscal:** certificado digital **A1** (arquivo + senha) do CNPJ; credenciamento como emissor de NF-e na SEF-SC;
série inicial e último número usado, se já houver emissão em outro sistema.

**Pagamentos:** conta PJ e credenciais de teste e produção do provedor escolhido; para o Sicoob, conta de cooperado
e certificado para a API Pix.

**Operação:** transportadoras atendidas e tabelas de frete; fornecedores iniciais; lista de produtos com custos e
embalagens; política de trocas e devoluções; domínio e marca.

---

## 7. Fases de implementação

Cada fase termina com testes passando e uma demonstração. Nenhuma fase começa sem a anterior aprovada.

| Fase | Entrega | Critério de aceite |
|---|---|---|
| 1 | Este diagnóstico | Aprovação |
| 2 | Projeto, banco, autenticação, permissões, painel base, produtos e categorias, assistente de dados da empresa e fiscal | Testes de permissão e RLS; cadastro completo de um produto |
| 3 | Unidades e embalagens, conversão, movimentos, reservas, fornecedores, compras, custo com frete rateado, inventário, alertas, giro | Testes do fracionamento (100 → vende 5 → 95), reserva concorrente, custo médio |
| **Direção visual** | 3 propostas, mockups de início (desktop e celular), categoria e produto | Aprovação antes da Fase 4 |
| 4 | Loja, busca e filtros, carrinho, clientes, checkout, frete por tabela, Pix e cartão (1 provedor primeiro), pedidos, expedição | Compra completa em sandbox; webhook duplicado e fora de ordem; queda do provedor |
| 5 | Provedor fiscal, regras por produto/operação, NF-e, XML/DANFE, rejeição, cancelamento, CC-e, inutilização, importação de XML de compra | Emissão, rejeição, cancelamento e recuperação em homologação; validação do contador |
| 6 | Central comercial: busca rápida, disponibilidade, compartilhar por `wa.me`, orçamentos, conversão em pedido | Orçamento → pedido sem redigitar |
| — | **Lançamento da V1** | NF-e homologada e validada, backup e restauração testados |
| 7 | Mercado Livre e Shopee | V2 |
| 8 | WhatsApp Cloud API, transportadoras por API, relatórios avançados | V3 |

Relatórios básicos de vendas e margem entram nas Fases 3 e 4, conforme os dados passam a existir.

Sugestão de ordem dos pagamentos na Fase 4: **Mercado Pago primeiro** (Pix + crédito + débito, sandbox completo,
adaptador já existe), depois Pagar.me (Stone) e Sicoob Pix, conforme custo das taxas negociadas.

---

## 8. Riscos e dependências

| Risco | Impacto | Mitigação |
|---|---|---|
| Credenciamento NF-e, certificado e validação do contador demoram | Atrasa o lançamento | Pedir já: é caminho crítico, independente do código |
| Regras tributárias erradas | Autuação, rejeição | Enquadramento só pelo contador; sistema bloqueia produto sem regra validada |
| Reforma tributária (IBS/CBS) em transição a partir de 2026 | Layout da NF-e muda | Provedor fiscal absorve; conferir notas técnicas vigentes na Fase 5 |
| PicPay sem sandbox oficial (verificado em 12/11/2026 no projeto da barbearia) | Testes só em produção | Deixar PicPay para depois do lançamento ou testar com valor mínimo autorizado |
| Débito online depende do provedor e da bandeira | Forma pode não estar disponível | Exibir só formas confirmadas pelo provedor |
| Sob encomenda: fornecedor sem prazo confiável | Promessa de entrega errada | Prazo só aparece com estimativa cadastrada; senão "prazo informado após confirmação" e possibilidade de estorno |
| Servidor compartilhado com outros sistemas (VPS com CloudPanel) | Memória e CPU | Um Next, uma API, um worker, fila no PostgreSQL; medir RAM livre antes da Fase 2 |
| Venda simultânea do último item (loja e, depois, marketplaces) | Venda sem estoque | Reserva com trava de linha; margem de segurança por canal na V2 |
| Fotos de produtos | A loja depende delas | Padrão de fotografia definido na direção visual; imagens recodificadas |
| Marketplaces exigem aprovação e mudam APIs | Atrasa a V2 | Começar os cadastros de desenvolvedor cedo |
| LGPD (CPF, endereço) | Legal | Política de privacidade, retenção, dados mínimos, cifragem de documento |

---

## 9. Identidade visual

Direção recomendada pelo usuário: **varejo contemporâneo especializado** — aparência de loja grande e organizada,
com a proximidade de um comércio regional. Ela será a base das três propostas, que vão diferir em conceito,
tipografia, uso de fotografia e estrutura de navegação, não só em cor. A rodada visual acontece antes da Fase 4,
usando as skills `frontend-design` e `ecommerce-visual-design` e pesquisa de referências (Awwwards, Behance,
Dribbble, lojas Shopify do segmento), sem copiar concorrentes. Nome, logo, cores e domínio ficam configuráveis.

---

## 10. Decisões pedidas para começar a Fase 2

1. Aprovar a stack: Fastify + Next.js + PostgreSQL, monorepo novo em `loja-embalagens/`.
2. Aprovar **provedor fiscal por API** (escolha do provedor na Fase 5, após comparação documentada).
3. Confirmar o servidor de produção (o mesmo VPS da barbearia?) para medir a capacidade.
4. Confirmar o primeiro gateway (sugestão: Mercado Pago).
5. Iniciar já, fora do sistema, o credenciamento NF-e, o certificado A1 e a conversa com o contador.
