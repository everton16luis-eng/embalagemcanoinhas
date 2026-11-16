# SGLog — Fase 2: gestão de fornecedores

Decisões D2-1 a D2-12 aprovadas em 16/11/2026 (ver [17-sglog-fase2-planejamento.md](17-sglog-fase2-planejamento.md)).
Implementado e testado **só na branch `sglog/fase2`, numa worktree com cluster PostgreSQL próprio**. Nada foi enviado,
integrado ou implantado, e **nenhuma migration rodou em produção**. A Fase 1 (0020) continua aguardando o diagnóstico
da Etapa 0 e a autorização de implantação. A 0021 só pode ir para produção **depois** da 0020.

## Commits (locais, branch `sglog/fase2`)

| Commit | Conteúdo |
|---|---|
| `f7bea62` | Planejamento (doc 17), já existente antes desta etapa |
| `b0567c5` | Migration 0021 (up/down), relatório de códigos, ajustes de teste/demo |
| `11cf250` | API de fornecedores, permissões `suppliers.*`, função de escolha, mínimo na compra, testes |
| `2b45923` | Telas: lista, ficha com abas, comparação no produto, exceção de mínimo no pedido de compra |
| (este) | Este documento |

A branch parte de `b5ff9f2` (Fase 1). Os três commits locais ainda não enviados do checkout principal (`f3b7998`,
`eddd4e9`, `84eff18`) **não estão nesta branch** e não foram misturados.

Não foram alterados: migrations 0019/0020, checkout, pagamentos, fiscal (emissão e importação de NF-e), pedidos de
venda, marketplaces, vitrine, reposição e saldo de estoque.

## Banco (0021)

### Preparação e travas
- Pega a trava de `supplier_products` primeiro (espera) e depois as demais com `NOWAIT`, com novas tentativas por até
  10 s. Assim não forma deadlock com a aplicação. Em ensaio local com os dados de demonstração, a trava durou ~1 ms.
- **Pré-checagem dos códigos do fornecedor** (`supplier_sku`). A migration **para sem mudar nada** (`check_violation`)
  se houver código duplicado exato no mesmo fornecedor ou código vazio/com espaço nas pontas. Códigos que diferem só por
  maiúsculas ou espaços internos geram apenas aviso (NOTICE). **Nenhum código é corrigido automaticamente**, porque a
  importação da NF-e de compra casa o item pelo código exato.

### Mudanças
- **`suppliers`**
  - Campos novos: endereço (CEP, rua, número, complemento, bairro), preparação e transporte em dias, política e prazo
    de devolução.
  - Frete e outras despesas por pedido: **nulo significa desconhecido, nunca zero**.
  - `dropship_enabled`, sempre desligado para a operação.
  - `status` (`active`/`inactive`/`blocked`), com motivo, autor e data do bloqueio.
  - Arquivamento lógico: `archived_at/by`, `archive_reason`.
  - `version`.
  - `active` continua existindo e é sincronizado com `status` por gatilho, nos dois sentidos, para o código antigo.
  - Fornecedor arquivado não pode ser reativado sem antes ser restaurado.
- **`supplier_contacts`**: WhatsApp e contato principal (no máximo um por fornecedor).
- **`supplier_products`** (ofertas)
  - Campos novos: `variant_id` (derivado da embalagem), mínimo e múltiplo em embalagens, preparação, `dropship_allowed`,
    `is_primary`, `status` (`active`/`paused`/`ended`) com motivo de encerramento, `created_at`, `version`.
  - Código do fornecedor único por fornecedor (D2-5).
  - No máximo um principal ativo por variante, sempre definido à mão (D2-9).
  - Uma oferta encerrada não volta por `active=true` de código antigo. A volta só acontece pela reativação explícita,
    que é auditada (D2-7).
- **`supplier_price_history`**
  - Histórico de custo imutável: UPDATE, DELETE e TRUNCATE são bloqueados por gatilho.
  - Cada linha guarda custo antigo e novo, fornecedor, variante, usuário, data/hora, origem e motivo.
  - Linhas são gravadas por gatilho em toda mudança de custo, venha de qualquer caminho.
  - A carga inicial grava uma linha `migration` por oferta. Não há histórico anterior a isso (D2-3); a auditoria antiga
    continua como está.
- **`supplier_availability`**
  - Disponibilidade informada pelo fornecedor, só inclusão, com validade (`valid_until`).
  - **Não toca estoque**: `stock_balances`, a vitrine e os marketplaces não leem essa tabela.
- **`supplier_settings`**: linha única com tolerância de empate (3 %), cotação antiga (90 dias) e aviso de
  disponibilidade (3 dias), todos editáveis com `version` (D2-10).
- **`purchase_order_items`**
  - Guarda o mínimo e o múltiplo vigentes na hora da compra.
  - Guarda a justificativa quando a compra fica abaixo do mínimo ou fora do múltiplo (D2-11).
- **View `supplier_offer_terms`**: oferta com o fornecedor, custo por unidade base, idade da cotação, prazo efetivo e a
  última disponibilidade, com o indicador de vencida.
- **Exclusão física**
  - `loja_app` perde `DELETE` em `suppliers` e `supplier_products`.
  - As FKs dos contatos e das ofertas para o fornecedor passam a `RESTRICT`.
- **Permissões**: quem tinha `purchases.view/manage` individual recebe `suppliers.view/manage` equivalentes. As
  concessões individuais existentes são preservadas.

### Reversão (`0021_…down.sql`)
A reversão só roda se nada novo tiver sido usado. Ela **se recusa**, sem mudar nada, quando existe qualquer um destes:
- fornecedor bloqueado ou arquivado;
- campo novo preenchido;
- contato com WhatsApp ou marcado como principal;
- oferta encerrada ou principal;
- histórico de custo diferente de `migration`;
- qualquer disponibilidade;
- parâmetros alterados;
- justificativa de mínimo;
- permissão `suppliers.*` diferente da `purchases.*` correspondente.

Fora desses casos ela desfaz tudo. Em ensaio local, a sequência up → down → up deu esquema, restrições, índices,
gatilhos e grants idênticos (hash), tanto com o banco vazio quanto com a demonstração (7 fornecedores, 274 ofertas,
346 itens de compra).

## Relatório de códigos (antes da 0021)

```bash
node scripts/fornecedores-codigos.mjs
```

```bash
node scripts/fornecedores-codigos.mjs --json
```

- Roda como `loja_app`, numa transação `READ ONLY`, e não muda nada.
- Lista quatro grupos:
  - **A**: duplicados exatos (bloqueiam a 0021);
  - **B**: códigos vazios ou com espaço nas pontas (bloqueiam a 0021);
  - **C**: códigos parecidos (só aviso);
  - **D**: quantas NF-e de compra já importadas trazem cada código. Essa é a informação para decidir a correção sem
    quebrar a associação da nota.
- Quem conhece o fornecedor decide e corrige no painel, antes de aplicar a 0021.

## API (`/api/v1/admin/suppliers`)

Leitura exige `suppliers.view` **ou** `purchases.view`. Escrita exige `suppliers.manage`. Erros seguem o formato
`{error:{code,message,details}}`.

| Rota | O quê |
|---|---|
| `GET /` | Lista. Sem filtro, continua trazendo só os ativos, como antes. Filtros novos: `status`, `uf`, `alert`, `dropship`, `sort` |
| `GET /summary` | Contagens para os atalhos da lista |
| `GET /:id` | Ficha, com alertas e indicadores de 90 dias |
| `POST /` | Cria fornecedor |
| `PUT /:id` | Altera. Exige `version` (senão 409 `VERSION_CONFLICT`). Para fornecedor bloqueado ou arquivado, o campo legado `active` responde 409 `USE_STATUS_ROUTE` |
| `POST /:id/status` | Ativa, inativa ou bloqueia (bloquear exige motivo). Devolve os pedidos abertos e as variantes que perderam o principal |
| `POST /:id/archive`, `POST /:id/restore` | Arquivamento lógico, com motivo. Só arquiva fornecedor que não está ativo |
| `GET /:id/offers?status=` | Ofertas do fornecedor |
| `POST /:id/offers/item` | Cria uma oferta |
| `PUT /:id/offers` (legado) | Grava a lista inteira. Embalagem repetida responde 409 `DUPLICATE_OFFER`; oferta encerrada na lista responde 409 `OFFER_ENDED`; ofertas omitidas viram **pausadas**, não são apagadas |
| `PATCH /offers/:offerId` | Altera uma oferta (com `version`). Mudança de custo aceita motivo e vai para o histórico |
| `POST /offers/:offerId/end`, `…/reactivate` | Encerra ou reativa, sempre com motivo e auditoria |
| `POST /offers/:offerId/primary` | Marca ou desmarca o principal. Trava as ofertas da variante em ordem fixa |
| `GET /offers/:offerId/price-history` | Histórico de custo |
| `GET/POST /:id/availability` | Disponibilidade informada (POST só inclui) |
| `GET /:id/history` | Linha do tempo: auditoria e custos |
| `GET /variants/:variantId/comparison?need=` | Comparação e sugestão explicada para uma variante |
| `GET/PUT /settings` | Parâmetros. O PUT exige `settings.manage` com verificação em duas etapas e `version` |

Códigos de erro novos:
- `VERSION_CONFLICT`
- `DUPLICATE_SUPPLIER_SKU`
- `PRIMARY_CONFLICT`
- `INVALID_STATE`
- `REASON_REQUIRED`
- `ARCHIVE_ACTIVE`
- `NO_OFFER`
- `INVALID_DATE`
- `USE_STATUS_ROUTE`
- `DUPLICATE_OFFER`
- `OFFER_ENDED`

Toda escrita é **uma transação por operação**, com versão otimista. Um conflito é informado e nunca sobrescrito em
silêncio.

**Pedido de compra (`/api/v1/admin/purchase-orders`)**
- Item abaixo do mínimo ou fora do múltiplo sem `minExceptionReason` → 422 `BELOW_MINIMUM`, com a lista dos itens.
- Com a justificativa, o item é gravado e a exceção é auditada (`purchases.min_exception`).
- Fornecedor bloqueado → 422 `SUPPLIER_BLOCKED` ao criar e 409 `SUPPLIER_BLOCKED` ao enviar.

## Permissões

| Papel | `suppliers.view` | `suppliers.manage` |
|---|---|---|
| Dono | ✔ | ✔ |
| Gerente | ✔ | ✔ |
| Comprador | ✔ | ✔ |
| Estoquista | ✔ | — (D2-4) |
| Logística | ✔ | — |
| Financeiro | ✔ | — |

- Permissões individuais continuam valendo. A autorização é sempre conferida no backend.
- Menu: Fornecedores aparece para `suppliers.view` ou `purchases.view`. O menu Logística é da Fase 3 (D2-8).

## Função de escolha (`apps/api/src/lib/supplier-choice.ts`)

- **Função pura e determinística**: a mesma entrada dá a mesma saída. A data de referência (`now`) é passada como
  parâmetro e o desempate final é pelo id da oferta.
- **Exclui, com motivo**:
  - oferta pausada ou encerrada;
  - fornecedor inativo, bloqueado ou arquivado;
  - embalagem ou variante inativa;
  - oferta sem custo;
  - prazo acima do limite;
  - dropship sem liberação. Na Fase 2, `dropshipReleased` é sempre falso.
- **Ordena por critérios em sequência**:
  1. atende o prazo;
  2. disponibilidade sabidamente insuficiente vai para o fim;
  3. custo total completo à frente do incompleto;
  4. faixa de empate de custo (tolerância configurável);
  5. principal;
  6. menor prazo;
  7. confirmação mais recente;
  8. menor sobra;
  9. menor custo total;
  10. id.
- **Custo desconhecido nunca vale zero**: frete ou despesas não informados marcam o total como incompleto e geram
  aviso.
- Cada opção traz os motivos e os avisos: cotação antiga, abaixo do mínimo do fornecedor e disponibilidade vencida ou
  ausente.
- **Só sugere**: não cria pedido, não muda o principal e não altera a reposição (D2-6).

## Telas

- **Lista**: atalhos de resumo, que também filtram; filtros na URL; paginação de 25; painel de parâmetros.
- **Ficha**, com abas:
  - Visão geral: alertas e indicadores;
  - Cadastro: com versão, aviso de conflito e botão Recarregar;
  - Produtos e embalagens: edição por linha; principal com confirmação; pausar, encerrar e reativar com motivo;
    histórico de custo;
  - Disponibilidade: separada do estoque, deixando isso claro na tela;
  - Histórico.
- **Produto**: painel "Fornecedores" com a comparação e a sugestão explicada por variante. Aparece só para quem tem
  `suppliers.view`.
- **Pedido de compra**
  - Aviso por linha quando a quantidade fica abaixo do mínimo ou fora do múltiplo, e campo de justificativa.
  - Uma linha nova já começa com o mínimo do fornecedor.
  - A justificativa aparece também na visualização do pedido.

## Testes

| Suíte | Resultado |
|---|---|
| `test/supplier-choice.test.ts`: função de escolha, unitário | 26/26 |
| `test/sglog-fase2.test.ts`: integração | 24/24 |
| Suíte completa da API (23 arquivos) | **354/354** |
| Código antigo (main) com a 0021 aplicada: compatibilidade | **304/304** |
| Typecheck api e web | sem erros |
| `next build` e build da API | ok |

Itens obrigatórios cobertos pela integração:
- migration e reversão (com recusa);
- compatibilidade do PUT legado e do `active`;
- concorrência com versão e principal disputado em paralelo;
- histórico imutável e íntegro;
- unicidade do código;
- associação com a NF-e de compra pelo código;
- permissões por papel e individuais;
- exclusão lógica e reativação;
- disponibilidade vencida;
- separação do estoque (saldo e movimentos inalterados);
- escolha determinística;
- mínimo na compra;
- fornecedor bloqueado.

Verificação no navegador (servidor local da worktree, banco `loja_dev` isolado):
- lista e todas as abas da ficha;
- comparação no produto;
- pedido de compra abaixo do mínimo: 422 sem justificativa; aceito com justificativa, que aparece na edição e na
  visualização.

Nenhum erro no console.

## Riscos e pendências de revisão

1. **Códigos em produção ainda desconhecidos.** É preciso rodar o relatório em produção (só leitura) antes da 0021. Se
   houver código duplicado ou vazio, a migration para; a correção é manual e decidida por quem conhece o fornecedor.
2. **Gatilhos novos em `suppliers` e `supplier_products`.** Código antigo que gravar `active=true` numa oferta
   encerrada passa a receber erro. Isso é intencional (D2-7), mas não há esse caminho no código atual.
3. **PUT legado de ofertas.** Ofertas omitidas agora viram pausadas em vez de serem apagadas. Uma integração externa
   que dependa da exclusão veria comportamento diferente. Não há integração conhecida que use essa rota.
4. **Falta comparação compacta dentro do pedido de compra.** O componente aceita `compact`, mas ainda não está ligado
   à tela.
5. **Equivalência da reposição não tem teste dedicado.** A reposição não foi alterada (D2-6), mas não existe um teste
   que compare a saída antes e depois da 0021.
6. **Dropship sem operação.** O campo existe e a escolha o exclui. Não há fluxo de pedido em dropship.
7. **Indicadores de 90 dias** (prazo real, entregas no prazo) dependem de recebimentos com data. Com poucos dados, os
   números são pouco representativos.
8. **Histórico de custo começa na 0021.** Mudanças anteriores existem só na auditoria antiga.

## Implantação (quando autorizada, depois da 0020)

1. Backup e ensaio da migration numa cópia restaurada (`npm run backup:migrate-rehearsal`), como na Fase 1.
2. Rodar `node scripts/fornecedores-codigos.mjs` em produção (só leitura) e resolver os grupos A e B no painel.
3. Integrar a branch e aplicar a 0021 fora do horário de pico. A trava é curta, mas pega `supplier_products` com
   exclusividade.
4. Conferir os avisos da migration (códigos parecidos e permissões copiadas) e revisar os papéis dos usuários.
5. Conferir os parâmetros (3 % / 90 d / 3 d) na lista de fornecedores.

## Checklist de aprovação antes do merge

- [ ] Fase 1 (0020) implantada e estável em produção.
- [ ] Revisão de código dos commits `b0567c5`, `11cf250`, `2b45923` e deste documento.
- [ ] Relatório de códigos rodado em produção, sem itens A ou B pendentes.
- [ ] Ensaio da 0021 (up, down e up) numa cópia restaurada de produção.
- [ ] Suíte completa verde na branch rebaseada sobre o `main` atualizado (incluindo os três commits locais pendentes).
- [ ] Revisão da matriz de permissões (estoquista sem `suppliers.manage`) e das concessões individuais copiadas.
- [ ] Aceite visual das telas por quem compra.
- [ ] Decisão sobre as pendências 4 e 5 (fazer agora ou na Fase 3).
- [ ] Autorização expressa para merge, push e implantação.
