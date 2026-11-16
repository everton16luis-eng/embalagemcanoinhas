# SGLog — Fase 2: Gestão de Fornecedores (planejamento)

Data: 16/11/2026. Base: arquitetura aprovada em [sglog-fase0-auditoria.md](sglog-fase0-auditoria.md) (§5.2, §5.11,
§6.0, decisões D2 e D3).

**Situação: PLANEJAMENTO — nada implementado.** Esta etapa foi só auditoria do código e documentação:

- nenhuma migração criada ou executada;
- nenhum arquivo da Fase 1 alterado;
- nenhum push nem deploy.

A implementação aguarda a aprovação das decisões da §12 e começa num ramo próprio (`sglog/fase2`), não na `main`.

Dependência: a 0021 só vai para produção **depois** da 0020 (Fase 1) implantada e validada
([16-sglog-fase1-implantacao.md](16-sglog-fase1-implantacao.md)).

---

## 1. Diagnóstico do módulo atual

### 1.1 Banco (0004 e 0007)

**`suppliers`**

| Grupo | Campos |
|---|---|
| Identificação | `name`, `legal_name`, `document` (CPF ou CNPJ, único quando preenchido), `state_registration` |
| Contato | `email`, `phone`, `whatsapp`, `website` |
| Localização | `city`, `uf` |
| Condições | `payment_terms`, `lead_time_days` (0–180), `min_order_cents` (pedido mínimo em valor), `freight_terms` |
| Outros | `notes`, `active`, `created_at`, `updated_at` |

Não tem endereço completo, situação "bloqueado", versão para edição concorrente nem exclusão lógica.

**`supplier_contacts`**: `name`, `role`, `email`, `phone`. Não tem WhatsApp nem contato principal.

**`supplier_products`** (a "oferta", **por embalagem**):

- campos: `supplier_sku`, `cost_cents` (custo da embalagem), `lead_time_days`, `quoted_at` (data), `active`;
- `UNIQUE (supplier_id, packaging_id)`;
- não tem histórico de preço, quantidade mínima, disponibilidade, fornecedor principal nem versão.

**Ligações.** `supplier_contacts` e `supplier_products` → `suppliers` usam `ON DELETE CASCADE`. `supplier_products`
→ `packagings` não tem cascade, então uma embalagem com oferta não pode ser apagada; o catálogo, na prática,
**desativa** embalagens em vez de apagar.

**Privilégios.** `loja_app` tem `SELECT, INSERT, UPDATE, DELETE` nas três tabelas. Hoje nada impede apagar um
fornecedor com histórico: só a FK de `purchase_orders` (sem cascade) barra quem tem pedido de compra.

**Ligados ao fornecedor:**

- `purchase_orders.supplier_id`;
- `purchase_order_items`, que copia rótulo, conversão e custo da embalagem no momento do pedido e não referencia a
  oferta;
- `purchase_receipts`, imutável;
- `purchase_invoices.supplier_id`.

**Padrões que já existem e serão reaproveitados:**

- `price_history` com o gatilho `packagings_price_history` (0002): histórico de preço de venda imutável. A 0021
  repete o mesmo desenho para o custo do fornecedor.
- `forbid_mutation()`.
- `version` com bloqueio otimista, como em `products` e `purchase_orders`.

### 1.2 API (`modules/suppliers.ts`)

| Rota | Permissão | Comportamento |
|---|---|---|
| `GET /admin/suppliers` | `purchases.view` | Busca por nome, razão social ou documento; filtro ativo/inativo/todos; paginação; nº de ofertas ativas e data da última entrega |
| `GET /admin/suppliers/:id` | `purchases.view` | Cadastro, contatos e ofertas com custo por unidade base (`cost / base_qty`) |
| `POST /admin/suppliers` | `purchases.manage` | Cria; CPF/CNPJ validado; auditoria `suppliers.created` |
| `PUT /admin/suppliers/:id` | `purchases.manage` | Substitui o cadastro **sem controle de versão** e regrava os contatos (apaga e reinsere) |
| `PUT /admin/suppliers/:id/offers` | `purchases.manage` | **Substitui a lista inteira**: o que não vier fica `active = false`. A auditoria guarda antes e depois da lista |

**Outros usos de fornecedor no código:**

- **`purchases.ts`**: o pedido de compra exige fornecedor `active`. O custo do item vem da oferta ativa quando não é
  informado, e o rótulo e a conversão são copiados para o item.
- **`stock-reports.ts` (reposição)** já escolhe um fornecedor:
  - considera as ofertas ativas de fornecedores ativos com embalagem ativa;
  - prazo = `coalesce(oferta, fornecedor)`;
  - recomenda a oferta de **menor custo por unidade** que não passe da cobertura máxima; se todas passarem, a de
    menor desembolso.

  É a semente do "melhor fornecedor" (§6.6).
- **`purchase-invoices.ts`** casa os itens da NF-e de compra pelo `supplier_sku` com `LIMIT 1`. Se o fornecedor tiver
  o mesmo código em duas embalagens, a escolha é arbitrária.

### 1.3 Telas (`apps/web`)

- **`/painel/fornecedores`**:
  - busca com atraso de 200 ms e lista de até 100, sem paginação na tela;
  - colunas: fornecedor (documento e prazo), cidade, nº de itens e última entrega;
  - selo "Inativo".
- **`/painel/fornecedores/[id]`** (também serve `novo`):
  - um painel "Cadastro" e um painel "Custos por embalagem";
  - o painel de custos usa o `PackagingPicker` e tem uma tabela editável (custo, por unidade, código no fornecedor,
    prazo, ativo) com um botão "Salvar lista de custos";
  - botão "Novo pedido de compra".
- **Menu** (`shell.tsx`): lista plana, sem grupos. "Fornecedores" exige `purchases.view`.
- **Componentes reaproveitáveis:**
  - `PageHeader`, `Panel`, `Field`, `Input`, `Select`, `Textarea`, `Button`, `Badge`, `Notice`, `Empty` (`ui.tsx`);
  - `PackagingPicker`, `packLabel` (`stock.tsx`);
  - `formatCnpj`, `when`, `centsToInput`, `parseMoney`, `unitMoney` (`format.ts`);
  - `Guard` e `useMe().can`;
  - o padrão de tabela com `overflow-x-auto` e colunas escondidas por largura, já ajustado para celular.
- **Auditoria** já tem rótulos para `suppliers.created`, `suppliers.updated` e `suppliers.offers_updated`.

### 1.4 Permissões

As rotas usam `purchases.view` e `purchases.manage`. A permissão efetiva é o padrão do papel mais as concessões e
revogações individuais (`user_permissions`).

| Papel | Permissões hoje |
|---|---|
| manager, stock, buyer | `purchases.view` e `purchases.manage`: editam fornecedor e custo |
| logistics, finance | `purchases.view`: consultam, com custos |
| sales, fiscal, shipping | sem acesso |

### 1.5 Problemas de usabilidade encontrados

1. **A lista de custos é "tudo ou nada".** Editar um preço regrava a lista inteira. Duas pessoas editando ao mesmo
   tempo se sobrescrevem sem aviso, e quem esquecer uma linha a desativa.
2. **Cadastro sem versão.** O último a salvar vence, sem aviso.
3. **Sem histórico de preço.** O custo anterior só aparece no JSON da auditoria, e nenhuma tela compara.
4. **Sem visão por produto.** Para saber quem fornece uma variante e quanto cobra, é preciso abrir fornecedor por
   fornecedor. A comparação só aparece indiretamente na reposição.
5. **Contatos sem WhatsApp nem contato principal**, e regravados a cada edição (ids mudam).
6. **Lista sem paginação** (100 primeiros) e **sem filtros** além do texto.
7. **Prazo em um único número.** Não separa preparação de transporte, e cotação "velha" não é sinalizada.
8. **Código do fornecedor duplicado** quebra o casamento da NF-e de compra em silêncio.

### 1.6 Riscos de incompatibilidade

| Ponto | Por que importa | Tratamento proposto |
|---|---|---|
| `PUT /:id/offers` (substitui a lista) | Usado pela tela atual e por 3 testes de `stock.test.ts` | Mantido com o mesmo contrato e comportamento, reimplementado por cima das regras novas (histórico, versão); marcado como legado |
| `suppliers.active` e `supplier_products.active` | Lidos por compras, reposição, NF-e de compra e seed | Mantidos e **sincronizados** com `status` por gatilho, nos dois sentidos (§8.2) |
| Trocar `purchases.*` por `suppliers.*` nas rotas | Usuários com concessão individual de `purchases.*` perderiam acesso; a tela de compras lista fornecedores | Cópia das concessões e revogações na migração; leitura aceita `suppliers.view` **ou** `purchases.view` (§7) |
| `ON DELETE CASCADE` → `RESTRICT` | Nada no código apaga fornecedor hoje; o seed e os testes limpam com TRUNCATE | Sem efeito no código; `loja_app` perde DELETE |
| Unicidade de `supplier_sku` por fornecedor | Dados existentes podem ter duplicados | A migração confere antes e **recusa com a lista** dos duplicados (§8.3) |
| `demo.ts` grava `supplier_products` direto | Colunas novas precisam de padrão ou derivação | `variant_id` derivado por gatilho; colunas novas com padrão |
| Reposição (`stock-reports.ts`) | Usa `coalesce(oferta, fornecedor)` para o prazo | Só muda se a decisão D2-6 for aprovada (§12) |

---

## 2. Requisitos

### 2.1 Funcionais

| # | Requisito |
|---|---|
| RF1 | Cadastro completo: identificação, endereço (CEP, logradouro, número, complemento, bairro, cidade, UF), contatos (com WhatsApp e principal) e condições comerciais (pagamento, frete, pedido mínimo em valor) |
| RF2 | Prazos: dias de preparação e dias de transporte por fornecedor; preparação própria por oferta, quando houver |
| RF3 | Política de devolução: texto e prazo em dias |
| RF4 | Situação: `ativo`, `inativo` ou `bloqueado`. Bloquear exige motivo; o motivo, quem bloqueou e a data ficam registrados |
| RF5 | Vários fornecedores por produto: ofertas por embalagem, cada uma ligada à variante |
| RF6 | Um fornecedor principal por variante, apontado numa oferta (fornecedor e embalagem de compra preferida) |
| RF7 | Histórico imutável de custo de cada oferta: quem mudou, quando, de quanto para quanto |
| RF8 | Disponibilidade informada pelo fornecedor: quantidade, data de confirmação, validade e origem. Histórico imutável; vale a última confirmação dentro da validade |
| RF9 | Quantidade mínima de compra por oferta, em embalagens |
| RF10 | Indicação de dropshipping: o fornecedor aceita e a oferta permite. Fica **só registrada**; a operação real continua bloqueada (D3) |
| RF11 | Exclusão lógica: arquivar fornecedor e encerrar oferta, sem apagar nada que tenha histórico |
| RF12 | Permissões próprias: `suppliers.view` e `suppliers.manage` |
| RF13 | Comparação de ofertas por variante (custo por unidade base, mínimo, prazo, disponibilidade) com sugestão explicada |
| RF14 | Alertas de informação desatualizada: cotação antiga, disponibilidade vencida ou a vencer, fornecedor sem contato ou sem documento |
| RF15 | Indicadores de compras por fornecedor (§5.6), calculados das tabelas existentes |

### 2.2 Técnicos

| # | Requisito |
|---|---|
| RT1 | Uma migração, `0021_sglog_fornecedores` (up e down), só com o que a Fase 2 usa |
| RT2 | A disponibilidade do fornecedor **nunca** entra em `stock_balances`, `stock_location_balances`, na vitrine nem nos marketplaces (D2). Testado |
| RT3 | Histórico de custo e de disponibilidade imutáveis (`forbid_mutation`); o `loja_app` só faz INSERT nelas, e o custo só entra pelo gatilho |
| RT4 | Concorrência: `version` em `suppliers` e `supplier_products`; edição com versão diferente devolve 409 `VERSION_CONFLICT` |
| RT5 | `loja_app` sem DELETE em `suppliers` e `supplier_products`; FKs `RESTRICT` |
| RT6 | Rotas e contrato antigos continuam funcionando (§1.6), e os 304 testes atuais continuam passando |
| RT7 | Mesma técnica de bloqueio da 0020 (bloqueios antes de tudo, sem esperar segurando, teto de 10 s) |
| RT8 | Ensaio em cópia restaurada (`migrate-rehearsal`) e ensaio local com carga, como na Fase 1 |
| RT9 | Escolha do melhor fornecedor numa função pura (`lib/supplier-choice.ts`), testada por tabela de casos, que a Fase 4 reutiliza |

---

## 3. Modelo de dados proposto (`0021_sglog_fornecedores`)

```
suppliers
  + cep text CHECK (~ '^[0-9]{8}$'), street, number, complement, district     -- city e uf já existem
  + prep_days integer CHECK (0..180)          -- preparação/separação no fornecedor
  + delivery_days integer CHECK (0..180)      -- transporte até a loja
  + return_policy text CHECK (length <= 2000), return_days integer CHECK (0..365)
  + dropship_enabled boolean NOT NULL DEFAULT false      -- só cadastro (D3)
  + status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','blocked'))
  + blocked_reason text, blocked_by uuid REFERENCES users, blocked_at timestamptz
      CHECK ((status = 'blocked') = (blocked_reason IS NOT NULL AND blocked_at IS NOT NULL))
  + archived_at timestamptz, archived_by uuid REFERENCES users, archive_reason text
      CHECK (archived_at IS NULL OR status <> 'active')      -- arquivado nunca está ativo
  + version integer NOT NULL DEFAULT 1
  active: mantido; gatilho sincroniza active = (status = 'active') nos dois sentidos
  lead_time_days: mantido (compatibilidade); ver D2-6
  name: continua sendo o nome fantasia (sem trade_name novo; ver D2-1)

supplier_contacts
  + whatsapp text CHECK (~ '^[0-9]{12,13}$'), is_primary boolean NOT NULL DEFAULT false
  + UNIQUE parcial (supplier_id) WHERE is_primary
  FK supplier_id: ON DELETE CASCADE → RESTRICT (contatos continuam editáveis; a auditoria guarda antes/depois)

supplier_products  (oferta = fornecedor × embalagem)
  + variant_id uuid NOT NULL REFERENCES product_variants   -- derivado da embalagem por gatilho; não editável
  + min_order_packs numeric(12,3) CHECK (> 0)              -- quantidade mínima, em embalagens
  + prep_days integer CHECK (0..180)                       -- preparação específica do item (opcional)
  + dropship_allowed boolean NOT NULL DEFAULT false        -- só cadastro (D3)
  + is_primary boolean NOT NULL DEFAULT false
  + status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended'))
  + ended_at timestamptz, ended_by uuid REFERENCES users
  + created_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
  active: mantido; gatilho sincroniza active = (status = 'active')
  CHECK (NOT is_primary OR status = 'active')
  UNIQUE parcial (variant_id) WHERE is_primary            -- um principal por variante
  UNIQUE parcial (supplier_id, supplier_sku) WHERE supplier_sku IS NOT NULL   -- ver D2-5
  INDEX (variant_id, status)
  FK supplier_id: ON DELETE CASCADE → RESTRICT
  gatilho: principal só em fornecedor 'active'; bloquear ou arquivar o fornecedor tira o principal das ofertas dele
  'ended' → 'active' só pela ação explícita de reativação, registrada (o UNIQUE impede outra linha) — ver D2-7

supplier_price_history  (imutável; mesmo desenho de price_history)
  id bigint identity, supplier_product_id uuid NOT NULL REFERENCES supplier_products,
  old_cost_cents bigint NULL, new_cost_cents bigint NOT NULL,
  quoted_at date NOT NULL, source text CHECK (source IN ('manual','legacy_list','migration','invoice')),
  changed_by uuid REFERENCES users, changed_at timestamptz NOT NULL DEFAULT now()
  gatilho AFTER INSERT OR UPDATE OF cost_cents ON supplier_products (SECURITY DEFINER), como packagings_price_history
  INDEX (supplier_product_id, changed_at DESC)

supplier_availability  (imutável; vale a última linha por fornecedor × variante)
  id bigint identity, supplier_id uuid NOT NULL REFERENCES suppliers,
  variant_id uuid NOT NULL REFERENCES product_variants,
  available_qty numeric(14,3) NOT NULL CHECK (>= 0)        -- unidade base; 0 = "sem estoque no fornecedor"
  confirmed_at timestamptz NOT NULL, valid_until timestamptz NOT NULL CHECK (valid_until > confirmed_at),
  source text NOT NULL CHECK (source IN ('manual','whatsapp','email','api')), note text CHECK (length <= 300),
  created_by uuid REFERENCES users, created_at timestamptz NOT NULL DEFAULT now()
  INDEX (supplier_id, variant_id, confirmed_at DESC)
  -- sem ligação com stock_*: nenhuma FK, gatilho ou visão leva isto ao saldo da loja (RT2)

VIEW supplier_offer_terms (só leitura): oferta + fornecedor + embalagem + variante, com
  unit_cost_cents = cost_cents / base_qty, lead_days efetivo (§6.4), disponibilidade vigente
  (última confirmação, vencida ou não), idade da cotação. Usada pelas telas, pela comparação e pela Fase 4.

user_permissions: cópia de purchases.view → suppliers.view e purchases.manage → suppliers.manage
  (mesmo granted) para quem tem concessão ou revogação individual. Não toca em nenhuma outra linha.

Privilégios do loja_app:
  suppliers, supplier_products: SELECT, INSERT, UPDATE (REVOKE DELETE)
  supplier_contacts: SELECT, INSERT, UPDATE, DELETE (contato não tem histórico ligado)
  supplier_price_history: SELECT (só o gatilho grava)
  supplier_availability: SELECT, INSERT
  supplier_offer_terms: SELECT
```

**Por que a disponibilidade é por fornecedor e variante, e não por oferta.** O §5.2 da Fase Zero previa a
disponibilidade por oferta. Só que o estoque do fornecedor é do produto, não da embalagem. Duas ofertas do mesmo
fornecedor (caixa com 500 e caixa com 1000) contariam o mesmo estoque duas vezes, e o motor da Fase 4 somaria errado.
Esta é uma mudança no modelo aprovado e precisa de aprovação: **D2-2**.

---

## 4. Endpoints

Base: `/api/v1/admin`. Toda escrita grava auditoria. Toda edição exige `version` e devolve 409
`VERSION_CONFLICT` com a versão atual.

| Método e rota | Permissão | Uso |
|---|---|---|
| `GET /suppliers` | `suppliers.view` ou `purchases.view` | Lista paginada (25 por página): `q`, `status` (`active`, `inactive`, `blocked`, `archived`, `all`), `uf`, `alert` (`stale_price`, `expired_availability`, `missing_contact`), `dropship`, `sort` (`name`, `last_receipt`, `offers`) |
| `GET /suppliers/summary` | `suppliers.view` | Indicadores do topo da lista (§5.1) |
| `GET /suppliers/:id` | `suppliers.view` ou `purchases.view` | Cadastro, contatos, alertas e indicadores do fornecedor (§5.6) |
| `POST /suppliers` | `suppliers.manage` | Cria |
| `PUT /suppliers/:id` | `suppliers.manage` | Edita cadastro e contatos, com `version`; não muda situação |
| `POST /suppliers/:id/status` | `suppliers.manage` | `{status, reason, version}`; bloquear exige motivo; devolve quantos pedidos de compra abertos existem (aviso) |
| `POST /suppliers/:id/archive`, `/restore` | `suppliers.manage` | Exclusão lógica com motivo, e o desfazer |
| `GET /suppliers/:id/offers` | `suppliers.view` ou `purchases.view` | Ofertas com custo por unidade, mínimo, prazo efetivo, disponibilidade vigente, principal e alertas; filtro por `status` |
| `POST /suppliers/:id/offers/item` | `suppliers.manage` | Cria **uma** oferta (409 `DUPLICATE_OFFER` se a embalagem já tiver oferta, mesmo encerrada) |
| `PUT /suppliers/:id/offers` | `suppliers.manage` | **Legado**, mesmo contrato de hoje (lista inteira); grava histórico e respeita versão por linha quando enviada |
| `PATCH /supplier-offers/:offerId` | `suppliers.manage` | Custo, código, mínimo, preparação, dropshipping permitido, situação (`active` ou `paused`), `quotedAt`, com `version` |
| `POST /supplier-offers/:offerId/end` | `suppliers.manage` | Encerra a oferta (lógico) |
| `POST /supplier-offers/:offerId/primary` | `suppliers.manage` | Torna principal da variante; troca a anterior na mesma transação |
| `GET /supplier-offers/:offerId/price-history` | `suppliers.view` | Histórico de custo, paginado |
| `POST /suppliers/:id/availability` | `suppliers.manage` | `{variantId, availableQty, confirmedAt, validUntil, source, note}`, só inclusão |
| `GET /suppliers/:id/availability` | `suppliers.view` | Vigente por variante e histórico |
| `GET /variants/:variantId/suppliers` | `suppliers.view` | Comparação: todas as ofertas da variante, sugestão e os motivos (§6.6) |
| `GET /suppliers/:id/history` | `suppliers.view` | Linha do tempo: auditoria do fornecedor, custo e disponibilidade, paginada |

Pedidos de compra, reposição e NF-e de compra continuam com `purchases.*`, sem mudança.

---

## 5. Estrutura das telas

Princípios:

- mesmo shell, tokens e componentes do painel;
- nada de layout novo, só uma linha de abas;
- tabelas com colunas escondidas por largura, como hoje;
- números com a classe `num`;
- selos com `Badge`;
- avisos com `Notice`.

O item do menu continua "Fornecedores", no mesmo lugar (D2-8).

### 5.1 Lista (`/painel/fornecedores`)

```
┌ Fornecedores ─────────────────────────────────────────────── [Novo fornecedor] ┐
│ 12 ativos · 1 bloqueado · 7 cotações com mais de 90 dias · 3 disponibilidades   │
│ vencidas · 18 variantes sem fornecedor principal · 9 com fornecedor único       │  ← cada número é um filtro
├────────────────────────────────────────────────────────────────────────────────┤
│ [Buscar nome, razão social, CNPJ]  [Situação ▾] [UF ▾] [Alertas ▾] [Dropship ▾] │
├────────────────────────────────────────────────────────────────────────────────┤
│ Fornecedor                       Cidade/UF      Prazo     Itens  Alertas  Última │
│ Embalagens Sul  ●Ativo           Joinville/SC   2+3 dias     48   ⚠ 3    12/11   │
│ 12.345.678/0001-90                                                               │
│ Papelaria X  ●Bloqueado: atraso recorrente                                       │
├────────────────────────────────────────────────────────────────────────────────┤
│ 1–25 de 63                                        ‹ Anterior  Próxima ›         │
└────────────────────────────────────────────────────────────────────────────────┘
```

- Paginação no servidor.
- Filtros e página guardados na URL (voltar mantém o estado).
- No celular: só fornecedor, selo e alertas.

### 5.2 Página do fornecedor (`/painel/fornecedores/[id]`)

Cabeçalho:

- nome;
- selo de situação (bloqueado mostra o motivo);
- ações: Novo pedido de compra, Bloquear/Ativar, Arquivar.

Abas por `?aba=`:

1. **Visão geral**:
   - indicadores (§5.6);
   - alertas com link para corrigir;
   - contato principal com links `tel:`, `mailto:` e WhatsApp;
   - condições comerciais e política de devolução em leitura.
2. **Cadastro**: o formulário de hoje, reorganizado em `Panel`s:
   - Identificação;
   - Endereço (digitado: o projeto não tem consulta de CEP, e ela seria um serviço externo novo, fora desta fase);
   - Contatos;
   - Condições comerciais;
   - Prazos;
   - Devolução;
   - Dropshipping (com aviso fixo "bloqueado para operação até validação fiscal").

   O salvar envia `version`. Num conflito aparece "Outra pessoa alterou este fornecedor. Recarregue para ver" e nada é
   sobrescrito.
3. **Produtos e embalagens**: tabela por produto e variante.
   - Colunas: embalagem, código no fornecedor, custo, custo por unidade base, mínimo, prazo efetivo, disponibilidade
     (selo: em dia, vence em N dias, vencida, sem informação), principal (★), situação.
   - Edição **por linha**: lápis abre a linha, Salvar e Cancelar; cada linha tem sua versão.
   - "Adicionar item" usa o `PackagingPicker`.
   - "Informar disponibilidade" abre um formulário curto (quantidade, confirmada em, válida até, origem).
   - "Histórico de custo" abre um painel lateral com a tabela e uma linha de variação.
4. **Histórico**: linha do tempo paginada (cadastro, situação, custos, disponibilidade), com autor e data.

### 5.3 Comparação por variante

Em dois lugares, com o mesmo componente (`SupplierComparison`):

- **Página do produto** (`/painel/produtos/[id]`): painel "Fornecedores" por variante, só para quem tem
  `suppliers.view`.
- **Pedido de compra**: ao adicionar um item, o mesmo componente aparece compacto, mostrando a sugestão.

```
Variante CX-ROSA-15 · unidade base: un
                         Embalagem      Custo/un  Mínimo   Prazo  Disponível        Cotação
★ Embalagens Sul         Caixa c/500    R$ 0,184  2 cx     5 d    3.000 (vence 2 d)  há 12 d
  Papelaria X ⛔bloqueado Caixa c/1000  R$ 0,171  1 cx     9 d    —                  há 140 d ⚠
  Distribuidora Y        Pacote c/100   R$ 0,205  10 pct   2 d    vencida ⚠          há 30 d
Sugestão para 1.200 un: Embalagens Sul, 3 caixas, R$ 276,00, chega em 5 dias.
  Motivo: menor custo total entre os aptos; Papelaria X fora (bloqueado); Y com mínimo acima da necessidade.
```

### 5.4 Fornecedor principal

- Estrela e selo "Principal" na comparação e na aba de produtos.
- Na página do produto aparece "Fornecedor principal: …", ou um aviso quando não há.
- Trocar o principal pede confirmação e diz qual era o anterior.

### 5.5 Alertas de informação desatualizada

| Alerta | Regra (constantes no código, ajustáveis) |
|---|---|
| Cotação antiga | `quoted_at` há mais de 90 dias |
| Disponibilidade vencida | `valid_until < now()` |
| Disponibilidade a vencer | `valid_until` nos próximos 3 dias |
| Sem contato | Nenhum contato com telefone, WhatsApp ou e-mail |
| Sem documento | `document` vazio (a NF-e de compra não casa) |
| Variante sem principal | Variante ativa com oferta ativa e nenhum principal |
| Fornecedor único | Variante ativa com uma única oferta ativa |

### 5.6 Indicadores para compras

Calculados de `purchase_orders`, `purchase_receipts` e `supplier_price_history`, **sem tabela nova**:

- total comprado em 90 dias;
- nº de pedidos e de recebimentos;
- prazo real médio (`received_at - sent_at`) contra o informado;
- percentual de pedidos recebidos até `expected_at`;
- variação de custo em 90 dias (média das ofertas);
- data da última compra e da última entrega;
- itens em que é o principal e itens em que é o mais barato.

---

## 6. Regras de negócio

1. **Situação do fornecedor.**
   - `active`: tudo liberado.
   - `inactive`: não recebe pedido de compra novo, não é sugerido e não pode ser principal. Os pedidos abertos
     seguem e o recebimento continua permitido.
   - `blocked`: tudo do inativo, e mais: exige motivo, aparece em vermelho em toda lista e comparação, e os pedidos de
     compra **em rascunho** com ele não podem ser enviados. Os enviados podem ser recebidos (a mercadoria pode estar a
     caminho).
   - Bloquear ou inativar tira a marca de principal das ofertas dele, e a tela avisa quais variantes ficaram sem.
2. **Arquivar** (exclusão lógica) exige `inactive` ou `blocked` e motivo, e esconde o fornecedor das listas padrão.
   Não apaga nada: pedidos, recebimentos, notas, histórico de custo e disponibilidade continuam ligados. Restaurar
   volta como `inactive`.
3. **Oferta.**
   - Uma por fornecedor e embalagem (UNIQUE).
   - `active` entra em sugestão e no custo padrão do pedido; `paused` é temporário e fica fora da sugestão; `ended` é
     o encerramento lógico, fora de tudo e mostrado só no filtro "encerradas".
   - Reativar uma oferta encerrada é uma ação explícita e registrada (D2-7).
   - A variante vem da embalagem e não muda.
   - Embalagem ou variante desativadas no catálogo deixam a oferta fora da sugestão, sem apagar.
4. **Custo.** Só pela oferta. Toda mudança gera uma linha em `supplier_price_history` (gatilho), também pela rota
   legada. Custo igual não gera linha. `quoted_at` é obrigatório na mudança de custo; vale o padrão "hoje".
5. **Principal.** No máximo um por variante (índice único parcial). Só oferta `active` de fornecedor `active`. A troca
   é atômica: desmarca e marca na mesma transação, com a linha da variante bloqueada.
6. **Disponibilidade.**
   - Só inclusão.
   - A vigente é a última por `confirmed_at`.
   - Está **vencida** quando `valid_until < now()`. Vencida vale como "sem informação": nunca como zero e nunca como
     a última quantidade.
   - É em unidade base.
   - **Nunca soma ao estoque da loja** (D2): fica fora de `stock_*`, da vitrine e dos marketplaces, sem exceção.
7. **Prazo efetivo de uma oferta** = `coalesce(oferta.prep_days, fornecedor.prep_days) + fornecedor.delivery_days`.
   Se faltar uma das partes, vale `coalesce(oferta.lead_time_days, fornecedor.lead_time_days)`, como hoje. Se nada
   estiver preenchido, o prazo é desconhecido. A reposição continua usando a regra atual até a decisão D2-6.
8. **Quantidade mínima.** `min_order_packs` na oferta. A sugestão arredonda a necessidade para cima até o mínimo e
   mostra o excedente. O pedido de compra **avisa** abaixo do mínimo, mas não recusa (o fornecedor pode aceitar).
9. **Pedido mínimo em valor.** `suppliers.min_order_cents` já existe e entra na sugestão como alerta, sem recusar.
10. **Dropshipping.** `suppliers.dropship_enabled` e `supplier_products.dropship_allowed` são só cadastro. Nenhuma
    rota da Fase 2 cria pedido, remessa ou alocação por dropshipping. A trava operacional (`logistics_settings`) é da
    Fase 4 (D3).
11. **Edição concorrente.** Toda escrita confere `version`; conflito devolve 409 e não grava nada.
12. **Nada é apagado** pelo `loja_app` em fornecedor, oferta ou históricos. Contatos podem ser removidos (sem histórico
    ligado), com antes e depois na auditoria.

### 6.6 Escolha do melhor fornecedor (base do motor da Fase 4)

Função pura `chooseSupplier(need, offers, context)` em `lib/supplier-choice.ts`, sem acesso ao banco. A entrada vem
da visão `supplier_offer_terms`. Ela devolve as opções ordenadas, cada uma com **motivos legíveis**. A tela mostra
"por que este".

**Etapa 1 — aptos.** Fica de fora, com o motivo registrado, a oferta que não for `active`, cujo fornecedor não for
`active`, cuja embalagem ou variante estiver inativa, ou cujo custo for nulo. Regras extras por contexto:

| Contexto | Regra extra |
|---|---|
| `purchase` (compra para estoque próprio) | Disponibilidade é informativa: vencida ou ausente não exclui |
| `fulfillment` (Fase 4: atender pedido por fornecedor) | Exige disponibilidade **vigente** ≥ necessidade e `dropship_allowed`, e só funciona com a trava de dropshipping liberada (D3). Na Fase 2 este contexto existe só nos testes |
| Com prazo-limite | Prazo desconhecido ou acima do limite vai para o fim, como "pode atrasar"; não exclui sozinho |

**Etapa 2 — custo comparável.** Para cada apta:

- embalagens = `max(ceil(necessidade / base_qty), min_order_packs)`;
- custo total = embalagens × custo;
- excedente = embalagens × base_qty − necessidade.

**Etapa 3 — ordem lexicográfica com tolerância** (explicável, sem pesos mágicos):

1. atende o prazo-limite (quando há);
2. menor custo total;
3. empate técnico (até 3 % de diferença de custo total) → o **principal** primeiro;
4. menor prazo efetivo;
5. disponibilidade confirmada há menos tempo;
6. menor excedente.

**Saída:**

- a recomendada;
- as demais, com custo total, custo por unidade, prazo, excedente e motivos;
- as excluídas, com o motivo.

A regra atual da reposição (cobertura máxima, para não prender capital) é um contexto a mais. Ela pode migrar para
essa função sem mudar o resultado, conferido por teste de equivalência (D2-6).

A Fase 4 acrescenta a divisão de um pedido entre vários fornecedores e o custo de frete por origem, usando esta
mesma função por item.

---

## 7. Matriz de permissões

Permissões novas: `suppliers.view` e `suppliers.manage`, sem MFA. O custo não é público e não gasta dinheiro. O
custo continua visível só a quem já vê custo hoje.

| Papel | `suppliers.view` | `suppliers.manage` | Hoje (por `purchases.*`) | Observação |
|---|---|---|---|---|
| owner | ✔ | ✔ | ver e editar | — |
| manager | ✔ | ✔ | ver e editar | — |
| buyer | ✔ | ✔ | ver e editar | Papel natural do cadastro e das cotações |
| stock | ✔ | **D2-4** | ver e editar | Recomendação: só ver. Estoquista não deveria mudar custo; hoje muda |
| logistics | ✔ | — | ver | Precisa de prazo e disponibilidade |
| finance | ✔ | — | ver | Vê custo como hoje (já tem `purchases.view`) |
| sales | — | — | sem acesso | — |
| fiscal | — | — | sem acesso | — |
| shipping | — | — | sem acesso | — |

**Compatibilidade:**

- Leitura de lista, detalhe e ofertas aceita `suppliers.view` **ou** `purchases.view`, para a tela de compras
  continuar escolhendo fornecedor.
- Comparação, histórico e indicadores exigem `suppliers.view`.
- A escrita exige `suppliers.manage`.
- A migração copia as concessões e revogações individuais de `purchases.*` para `suppliers.*`.
- O menu "Fornecedores" passa a exigir `suppliers.view` ou `purchases.view`.

---

## 8. Estratégia de migração

### 8.1 Bloqueios

Mesma técnica da 0020: espera só a tabela principal, sem segurar nada; pede as demais com `NOWAIT`; se alguma
estiver ocupada, solta tudo, espera 20 ms e tenta de novo, com teto de 10 s.

Tabelas: `suppliers`, `supplier_products`, `supplier_contacts`, `packagings` e `product_variants` (FKs e gatilho),
`users` (FKs novas) e `user_permissions`.

Nenhuma delas é de estoque ou de pedido. Venda e checkout não esperam, exceto uma leitura de catálogo que trave
`product_variants` por instantes (SHARE ROW EXCLUSIVE não bloqueia leitura).

### 8.2 Passos do `up`

1. Pré-checagens com mensagem clara:
   - `supplier_sku` duplicado no mesmo fornecedor: lista e recusa (D2-5);
   - oferta apontando para embalagem sem variante: impossível pela FK, mas conferido.
2. Colunas novas com padrão (sem reescrever tabela grande; as tabelas de fornecedor são pequenas).
3. Preenchimento:
   - `status` a partir de `active`;
   - `supplier_products.variant_id` a partir da embalagem;
   - `status` das ofertas a partir de `active`;
   - `created_at` das ofertas = `updated_at`.
4. Gatilhos de sincronização `active` ↔ `status`, criados **depois** do preenchimento:
   - se só `active` mudar, `status` acompanha (`true` → `active`; `false` → `inactive` ou `paused`, ou mantém
     `blocked`/`ended`);
   - se `status` mudar, `active` é recalculado.

   O código atual e o seed continuam funcionando sem mudança.
5. Histórico inicial: uma linha por oferta em `supplier_price_history` (`old_cost_cents` nulo, custo atual,
   `quoted_at` atual, `source = 'migration'`). Os custos anteriores continuam consultáveis na auditoria (D2-3).
6. Nenhum principal automático (D2-9). Nenhuma disponibilidade inventada: começa vazia.
7. FKs `CASCADE` → `RESTRICT`.
8. `REVOKE DELETE` e `GRANT`s.
9. Visão `supplier_offer_terms`.
10. Cópia das permissões individuais.
11. Aviso final com contagens: fornecedores por situação, ofertas, ofertas sem prazo, variantes com mais de um
    fornecedor.

### 8.3 `down`

Recusa, sem mudar nada, se existir:

- fornecedor `blocked` ou arquivado;
- oferta `ended` ou `paused`;
- qualquer linha de `supplier_price_history` com `source <> 'migration'`;
- qualquer linha de `supplier_availability`.

Nesses casos a reversão apagaria informação: o caminho é voltar só o código, porque a 0021 é compatível com o código
antigo. Sem nada disso, o `down` remove gatilhos, visão, tabelas novas e colunas novas, devolve CASCADE e DELETE, e
remove as linhas `suppliers.*` de `user_permissions`.

### 8.4 Ensaios (como na Fase 1)

- `up → down → up` no `loja_test`.
- `migrate-rehearsal` numa cópia restaurada.
- Ensaio local com o seed: hash de `suppliers`, `supplier_products`, `purchase_*` e `stock_*` idêntico antes e
  depois; tempo de bloqueio; edição de oferta pela aplicação durante a migração, sem deadlock.
- Roteiro de implantação com pontos de parada, no formato do [16](16-sglog-fase1-implantacao.md).

---

## 9. Plano de testes (`sglog-fase2.test.ts` e `supplier-choice.test.ts`)

| Grupo | Casos |
|---|---|
| Permissões | Cada papel da matriz §7 contra cada rota (200/403). Concessão e revogação individual copiadas. Leitura por `purchases.view` continua funcionando. Sem sessão: 401 |
| Histórico de preço | Mudar custo gera exatamente uma linha com antes, depois, autor e data. Custo igual não gera. A rota legada também gera. `loja_app` recebe 42501 em INSERT direto, UPDATE e DELETE; o dono recebe 23001 em UPDATE e DELETE |
| Concorrência | Duas edições da mesma oferta com a mesma versão: uma 200 e outra 409, e o histórico tem uma linha só. Duas trocas simultâneas de principal na mesma variante: termina com exatamente um. Edição do cadastro com versão velha: 409 sem gravar contatos |
| Exclusão impedida | `loja_app` não apaga fornecedor nem oferta (42501). O dono apagando fornecedor com oferta, pedido ou histórico recebe 23503. Arquivar preserva pedidos, recebimentos e históricos (contagens iguais) |
| Disponibilidade vencida | Vencida aparece como vencida, não conta na sugestão de `fulfillment` e não vale como zero. Nova confirmação passa a valer. Histórico só cresce. `valid_until` ≤ `confirmed_at` recusado |
| Disponibilidade ≠ estoque | Informar disponibilidade não muda `stock_balances`, `stock_location_balances` nem a conferência C1–C5, nem o estoque mostrado na vitrine e no balcão |
| Fornecedor bloqueado | Bloquear sem motivo: 422. Bloqueado não recebe pedido de compra novo nem envio de rascunho; o recebimento de pedido já enviado continua. Perde o principal e sai da sugestão com o motivo. Desbloquear não devolve o principal sozinho |
| Duplicidade | Mesma embalagem duas vezes no fornecedor: 409 (individual e lista legada). `supplier_sku` repetido no fornecedor: 409. Segundo principal na variante: recusado pelo índice |
| Integridade produto–variante–embalagem | `variant_id` da oferta sempre igual ao da embalagem, mesmo em INSERT direto pelo dono com valor errado (o gatilho corrige ou recusa). Embalagem ou variante desativada tira a oferta da sugestão sem apagar. Oferta não pode apontar para embalagem inexistente |
| Compatibilidade | Os 304 testes atuais sem mudança. `PUT /:id/offers` com o contrato antigo. Pedido de compra usa o custo da oferta ativa. Reposição dá o mesmo resultado de antes. NF-e de compra casa pelo `supplier_sku`. `demo:seed` e `demo:reset` funcionam. `active` e `status` sincronizados nos dois sentidos |
| Escolha do fornecedor (unitário, por tabela) | Mais barato vence; empate em 3 % → principal; mínimo maior que a necessidade gera excedente e pode perder; prazo-limite; bloqueado e pausado excluídos com motivo; vencida em `purchase` não exclui e em `fulfillment` exclui; sem ofertas; prazo desconhecido; equivalência com a regra atual da reposição |
| Migração | `up → down → up` com hash idêntico; `down` recusado com histórico real; pré-checagem de `supplier_sku` duplicado; ensaio sem deadlock |

---

## 10. Riscos e dependências

| Risco ou dependência | Gravidade | Tratamento |
|---|---|---|
| Fase 1 (0020) ainda não implantada | Alta (bloqueia produção) | A 0021 só vai ao servidor depois da 0020 validada; o desenvolvimento local pode seguir |
| Mudança de permissão tirar acesso de alguém | Média | Cópia das permissões individuais, leitura aceitando `purchases.view` e teste por papel |
| `supplier_sku` duplicado em produção | Média | Pré-checagem no ensaio da cópia mostra a lista antes; você decide como corrigir |
| Rota legada de ofertas com comportamento novo | Média | Contrato e testes antigos mantidos; tela nova usa as rotas por linha |
| Sincronização `active` ↔ `status` mal feita | Média | Testes nos dois sentidos, incluindo INSERT pelo seed |
| Disponibilidade confundida com estoque | Alta se acontecer | Sem FK nem gatilho com `stock_*`; teste dedicado; texto da tela sempre "informado pelo fornecedor" |
| Dropshipping usado antes da validação fiscal | Alta se acontecer | Só cadastro na Fase 2; nenhuma rota operacional; trava real na Fase 4 (D3) |
| Telas maiores pesarem no celular | Baixa | Abas, colunas por largura e paginação no servidor |
| Volume do histórico | Baixa | Uma linha por mudança real de custo; índice por oferta e data |
| Escolha do fornecedor divergir da reposição | Baixa | Teste de equivalência antes de qualquer troca na reposição (D2-6) |

---

## 11. Ordem recomendada de implementação

Tudo no ramo `sglog/fase2`, com commit local por passo e suíte completa verde a cada passo.

1. Migração 0021 (up e down) com pré-checagens, e testes de banco: privilégios, imutabilidade, sincronização,
   índices, `up → down → up`.
2. Permissões `suppliers.*`, cópia de concessões e leitura compatível; testes por papel.
3. API de cadastro, situação, arquivamento e versão; testes de bloqueio e concorrência.
4. API de ofertas por linha, histórico de custo, principal e rota legada reimplementada; testes de duplicidade,
   histórico e compatibilidade.
5. Disponibilidade (inclusão e vigente) e a visão `supplier_offer_terms`; testes de vencimento e de "não é estoque".
6. `lib/supplier-choice.ts` com testes unitários, e a rota de comparação.
7. Telas: lista com filtros e indicadores, página com abas, edição por linha, disponibilidade, histórico,
   comparação na página do produto e no pedido de compra.
8. Indicadores de compras e alertas.
9. Seed de demonstração com os campos novos, e ensaios (local, carga, cópia restaurada).
10. Documentação (`docs/18-sglog-fase2.md`), roteiro de implantação e relatório. Pedido de autorização.

---

## 12. Decisões que precisam da sua aprovação

| # | Decisão | Recomendação |
|---|---|---|
| D2-1 | Nome fantasia | Usar o `name` atual como nome fantasia; **não** criar `trade_name` (evita dois campos com o mesmo papel) |
| D2-2 | Disponibilidade por fornecedor × variante, em vez de por oferta (muda o §5.2 aprovado) | Aprovar: evita contar o mesmo estoque do fornecedor duas vezes |
| D2-3 | Histórico de custo anterior à 0021 | Começar com uma linha "migração" por oferta; não reconstruir da auditoria (os dados existem lá, mas em JSON de lista inteira, sujeito a erro) |
| D2-4 | Papel `stock` (estoquista) com `suppliers.manage` | Só `suppliers.view`. Muda o comportamento atual: o estoquista deixa de editar custos. Alternativa: manter `manage` por compatibilidade |
| D2-5 | `supplier_sku` único por fornecedor | Aprovar, com pré-checagem que recusa a migração e lista os duplicados |
| D2-6 | Reposição passar a usar a função de escolha e o prazo dividido (preparação + transporte) | Não na Fase 2. Primeiro só a comparação usa a função nova; a troca na reposição vem depois, com teste de equivalência |
| D2-7 | Oferta encerrada pode ser reativada | Sim, por ação explícita e registrada (o UNIQUE fornecedor × embalagem impede criar outra) |
| D2-8 | Menu "LOGÍSTICA" (§7 da Fase Zero previa na Fase 2) | Adiar para a Fase 3, quando houver mais de uma tela logística. Na Fase 2 o item "Fornecedores" fica onde está, sem mudar o layout |
| D2-9 | Fornecedor principal automático na migração | Não marcar nenhum; a tela lista as variantes sem principal para você decidir |
| D2-10 | Tolerância de empate (3 %) e cotação "antiga" (90 dias) | Aprovar como ponto de partida, em constantes no código |
| D2-11 | Pedido de compra abaixo do mínimo da oferta | Avisar, não recusar |
| D2-12 | Implementação no ramo `sglog/fase2`, com merge na `main` só depois da sua revisão | Aprovar |
