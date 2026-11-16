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
| `f3ff927` | Este documento (primeira versão) |
| auditoria final | Rota antiga de ofertas, mensagem da reversão, relatório de códigos, regressão da reposição, comparação no pedido |
| encerramento técnico | 428 sem `version`, mesclagem de conflito na tela, plano de descontinuação, rollback e checklist |

A branch parte de `b5ff9f2` (Fase 1). Dos três commits locais ainda não enviados do `main`, só o planejamento da Fase 2
está aqui: `f7bea62` é o mesmo patch de `84eff18` (mesmo `patch-id`; o merge não duplica). `f3b7998` (roteiro da
Fase 1) e `eddd4e9` (testes pendentes) **não estão nesta branch**.

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
- Mostra fornecedor, código, SKU, embalagem, id da oferta e a contagem de notas. **Não mostra CPF/CNPJ** (é usado só
  para achar as notas do fornecedor).
- Código de saída: **0** sem conflito; **2** quando há itens A ou B (para o passo de implantação parar sozinho).

## API (`/api/v1/admin/suppliers`)

Lista, ficha e ofertas (`GET /`, `GET /:id`, `GET /:id/offers`) aceitam `suppliers.view` **ou** `purchases.view`,
como antes. Resumo, comparação, histórico de custo, disponibilidade e linha do tempo exigem `suppliers.view` (quem teve
`suppliers.view` revogado continua só com o que via antes). Escrita exige `suppliers.manage`. Erros seguem o formato
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
| `PUT /:id/offers` (legado) | Substituição **completa e explícita** da lista (detalhes abaixo). Responde com o cabeçalho `Deprecation: true` |
| `PATCH /offers/:offerId` | Altera uma oferta (com `version`). Mudança de custo aceita motivo e vai para o histórico |
| `POST /offers/:offerId/end`, `…/reactivate` | Encerra ou reativa, sempre com motivo e auditoria |
| `POST /offers/:offerId/primary` | Marca ou desmarca o principal. Trava as ofertas da variante em ordem fixa |
| `GET /offers/:offerId/price-history` | Histórico de custo |
| `GET/POST /:id/availability` | Disponibilidade informada (POST só inclui) |
| `GET /:id/history` | Linha do tempo: auditoria e custos |
| `GET /variants/:variantId/comparison?need=` | Comparação e sugestão explicada para uma variante |
| `GET/PUT /settings` | Parâmetros. O PUT exige `settings.manage` com verificação em duas etapas e `version` |

### Rota antiga de ofertas (`PUT /:id/offers`)

Consumidores encontrados (auditoria de 16/11/2026):
- **Tela antiga de fornecedores** (`fornecedores/[id]`, até `b5ff9f2`): enviava sempre a lista inteira lida do
  fornecedor, inclusive as inativas (com `active: false`). Foi substituída na Fase 2 pelas rotas por oferta; a tela nova
  não chama mais esta rota.
- **Testes** (`stock.test.ts`, `sglog-fase2.test.ts`): um deles omitia de propósito uma oferta para testar a
  desativação por omissão.
- Nenhum serviço interno, script, importação ou integração usa a rota.

Contrato a partir da Fase 2:
- É **substituição completa**: a lista precisa trazer **todas** as ofertas atuais (ativas e pausadas) do fornecedor.
  Para pausar, a linha vem com `active: false`.
- **Nenhuma oferta é pausada por omissão.** Lista parcial, ou desatualizada (alguém incluiu oferta depois da leitura),
  responde **409 `OFFERS_OMITTED`** com as ofertas que faltam, e nada é gravado.
- Encerrada: pode vir exatamente como estava (`active: false`, mesmo custo e código) e é ignorada, como a tela antiga
  enviava; pode também ser omitida. Qualquer outra mudança nela responde 409 `OFFER_ENDED` (reativação só explícita).
- `version` por linha continua opcional; quando vem, é conferida (409 `VERSION_CONFLICT`). O fornecedor e as ofertas
  ficam travados, em ordem fixa, até o fim da transação.
- Fornecedor arquivado: 409 `SUPPLIER_ARCHIVED`.
- Salvar sem mudar o custo **não renova** a data da cotação (antes, toda gravação punha a data de hoje).
- Oferta já existente cuja embalagem foi desativada depois pode continuar na lista (antes isso dava 422 e obrigava a
  omiti-la, o que agora não é permitido).
- Auditoria: `suppliers.offers_updated` com `metadata.route = 'legacy_full_list'`.

Compatibilidade: a tela antiga continua funcionando (sempre mandou a lista inteira). O único comportamento que mudou é o
da omissão, e ele **falha de forma explícita** (409, nada gravado) em vez de pausar em silêncio. A desativação por
omissão **não volta**: é exatamente o risco de lista parcial.

Como cada consumidor conhecido trata o `409 OFFERS_OMITTED` (conferido em 16/11/2026):

| Consumidor | Envia lista parcial? | Com 409 |
|---|---|---|
| Tela antiga (`b5ff9f2`), numa aba aberta durante a implantação | Não: manda todas as ofertas lidas | Mostra a mensagem do erro ("…veio sem algumas delas (ou está desatualizada)…"); nada gravado; recarregar resolve |
| Tela nova (Fase 2) | Não usa a rota | — |
| `stock.test.ts`, `sglog-fase2.test.ts` | Só de propósito | Os testes esperam o 409 e conferem que nada mudou |
| Serviços internos, scripts, importação, integrações | Não usam a rota | — |

Descontinuação planejada (não executar agora; cada etapa só com autorização):
1. **Hoje (Fase 2):** rota mantida, com `Deprecation: true` e auditoria `route = 'legacy_full_list'` em toda gravação.
2. **Depois da implantação da Fase 2:** acompanhar por pelo menos 60 dias as linhas de auditoria com
   `legacy_full_list` e os 409 `OFFERS_OMITTED` no log da API. Esperado: zero (nenhum cliente conhecido).
3. **Sem uso no período:** anunciar a data de desligamento e acrescentar o cabeçalho `Sunset` com essa data.
4. **Na data:** a rota passa a responder `410 Gone`, indicando as rotas por oferta (`POST /:id/offers/item`,
   `PATCH /offers/:offerId`). A remoção do código fica para depois de mais um ciclo sem chamadas.
5. **Se aparecer uso real:** contatar o responsável e migrar para as rotas por oferta. A proteção contra omissão continua
   valendo durante toda a transição.

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
- `OFFERS_OMITTED`

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
  - "Comparar fornecedores" por linha (só com `suppliers.view`): fornecedor, situação da oferta, custo por unidade,
    custo total para a quantidade da linha, mínimo, prazo e data da cotação, com o fornecedor do pedido e o sugerido
    marcados. É só informativa: não troca o fornecedor, a quantidade nem o custo.

## Testes

Resultados da auditoria final (16/11/2026), todos no cluster isolado da worktree (porta 54331):

| Verificação | Resultado |
|---|---|
| `test/supplier-choice.test.ts`: função de escolha, unitário | 26/26 |
| `test/sglog-fase2.test.ts`: integração | 30/30 |
| `test/reposicao-fase2.test.ts`: regressão da reposição | 1/1 (7 cenários) |
| Suíte completa da API (24 arquivos) | **361/361** |
| Código anterior (`b5ff9f2`) com a 0021 aplicada | **304/304** |
| 0021 up → down → up, banco vazio | esquema idêntico; depois do down, igual ao de um banco só até a 0020 |
| 0021 down com dados novos (demonstração) | recusado com o motivo; esquema e dados intactos |
| Typecheck api e web | sem erros |
| Build da API e `next build` | ok |

**Regressão da reposição.** O teste compara a rota com uma cópia congelada do cálculo anterior, que lê só as colunas
antigas, e com valores calculados à mão. Cobre:
- seleção do fornecedor e custo por unidade;
- cobertura máxima e quantidade sugerida;
- fornecedor inativo, bloqueado e arquivado;
- oferta pausada e encerrada (e a volta ao estado anterior);
- pedido enviado (conta como "a caminho"), mesmo abaixo do mínimo com justificativa, e rascunho (não conta).

Ele também confirma que o que só a Fase 2 tem não muda nada:
- mínimo, múltiplo e dropship;
- preparo e transporte;
- fornecedor principal;
- disponibilidade informada;
- parâmetros da comparação.

**Itens obrigatórios cobertos pela integração:**
- reversão recusada com o motivo;
- compatibilidade da rota antiga e do `active`;
- lista parcial e lista desatualizada na rota antiga;
- concorrência com versão e principal disputado em paralelo;
- histórico imutável e íntegro;
- unicidade do código;
- associação com a NF-e de compra pelo código;
- permissões por papel e individuais;
- exclusão lógica e reativação;
- disponibilidade vencida;
- separação do estoque;
- escolha determinística;
- mínimo na compra (exigido, validado, auditado, preservado na edição, protegido por permissão);
- fornecedor bloqueado (inclusive ao trocar o fornecedor do rascunho).
- cadastro sem `version` recusado com 428 `VERSION_REQUIRED`, sem gravar nada.

**Verificação no navegador** (servidor local da worktree, banco `loja_dev` isolado):
- lista e todas as abas da ficha;
- comparação no produto;
- comparação compacta no pedido de compra, inclusive em 375 px sem rolagem lateral da página;
- pedido abaixo do mínimo: 422 sem justificativa; aceito com ela, que aparece na edição e na visualização.
- conflito de edição com duas abas (cadastro e linha de oferta): o digitado é mantido, a mudança da outra aba é
  incorporada, os campos em disputa são apontados e nada é sobrescrito sem nova confirmação.

Nenhum erro no console.

## Riscos e pendências de revisão

1. **Códigos em produção ainda desconhecidos.** É preciso rodar o relatório em produção (só leitura) antes da 0021. Se
   houver código duplicado ou vazio, a migration para; a correção é manual e decidida por quem conhece o fornecedor.
2. **Gatilhos novos em `suppliers` e `supplier_products`.** Código antigo que gravar `active=true` numa oferta
   encerrada passa a receber erro. Isso é intencional (D2-7), mas não há esse caminho no código atual.
3. **Rota antiga de ofertas.** Omitir oferta agora dá 409 em vez de desativá-la. Nenhum consumidor conhecido depende da
   omissão (a tela antiga sempre mandou a lista inteira), mas um cliente externo desconhecido receberia 409. Nada é
   gravado nesse caso.
4. **`PUT /:id` (cadastro) exige `version` desde a Fase 2.** Uma aba aberta com a tela antiga durante a implantação
   recebe 428 `VERSION_REQUIRED` ao salvar, com a orientação de copiar o que digitou e recarregar; nada é gravado.
10. **Mesclagem de conflito é só na tela.** Ao receber 409 de versão, a tela busca a versão salva e mantém o que a
    pessoa digitou nos campos que ela mudou; os demais assumem o valor salvo. Se os dois mudaram o mesmo campo, vale o
    digitado e a tela avisa quais campos conferir. O servidor continua validando tudo e recusando versão velha.
5. **Reversão só vale enquanto nada novo foi usado.** Depois do primeiro uso (oferta encerrada, histórico manual,
   justificativa etc.), a 0021 down recusa com o motivo; o caminho é voltar só o código (o código antigo funciona com a
   0021 aplicada — suíte do código anterior verde sobre a 0021).
6. **Dropship sem operação.** O campo existe e a escolha o exclui. Não há fluxo de pedido em dropship.
7. **Indicadores de 90 dias** (prazo real, entregas no prazo) dependem de recebimentos com data. Com poucos dados, os
   números são pouco representativos.
8. **Histórico de custo começa na 0021.** Mudanças anteriores existem só na auditoria antiga.
9. **A comparação usa o prazo efetivo (preparo + transporte) e a reposição continua com o prazo antigo** (D2-6). Os
   dois números podem diferir na mesma tela; está documentado e coberto pelo teste de regressão.

## Conflito de edição na tela

- **Cadastro do fornecedor.** Se outra pessoa salvou antes, nada é gravado (409 no servidor) e a tela **não descarta o
  que foi digitado**. Ela lê a versão atual e mescla em três vias:
  - o que só a outra pessoa mudou entra no formulário;
  - o que só você mudou fica como você digitou;
  - o que os dois mudaram fica com o seu valor e é listado para conferir.

  A mensagem diz o que aconteceu. A gravação exige um novo clique em Salvar, já com a versão nova. Há também a opção
  "Descartar o que digitei e ver a versão salva".
- **Linha de oferta.** O mesmo comportamento. A linha não é mais remontada ao recarregar a lista, então a edição aberta
  sobrevive ao conflito.
- **Tela antiga sem `version`** (aba aberta antes da implantação). O servidor responde 428 `VERSION_REQUIRED`: "Esta
  tela está desatualizada. Copie o que digitou, recarregue a página (F5) e salve de novo; nada foi gravado." Antes era
  um genérico "Dados inválidos".
- **Sem sobrescrita silenciosa.** As validações continuam no servidor (versão obrigatória e conferida em toda edição).

## Recuperação e rollback

Nenhum cenário apaga dados para forçar uma reversão. Restaurar backup em produção exige **autorização expressa** do
responsável, caso a caso.

| Cenário | Estado do banco | O que fazer |
|---|---|---|
| **0021 falha antes de concluir** (trava ocupada por mais de 10 s, códigos A/B, qualquer erro) | Inalterado: a migration roda numa transação só e é desfeita inteira; `schema_migrations` não registra a 0021 | Ler a mensagem. Para trava ocupada: repetir fora do pico. Para códigos: rodar o relatório, corrigir no painel e repetir. Nada a restaurar. |
| **0021 aplicada, sem uso dos dados novos** | 0021 aplicada; nada criado que a reversão perderia | Preferir voltar só o código (o anterior funciona com a 0021: 304/304). Se for preciso tirar a 0021: `npm run migrate -- down` (reverte só a última); se recusar, cai no cenário seguinte. Ensaiar antes numa cópia. |
| **0021 aplicada, com dados novos** (oferta encerrada, histórico manual, justificativa, disponibilidade, bloqueio etc.) | A reversão **recusa**, diz o motivo e não muda nada | **Não** apagar dados para destravar. Voltar só o código e manter a 0021 aplicada (compatível). Corrigir para a frente com uma nova versão. |
| **Problema só no frontend** | Banco e API corretos | Publicar o build web anterior. Ele funciona com a API nova, exceto o salvar do cadastro, que pede recarregar (428). Banco intocado. |
| **Problema só na API** | Banco com 0021 | Publicar a API anterior (compatível com a 0021: suíte 304/304). Mantém leitura, compras e lista de ofertas. As telas novas que dependem das rotas novas ficam indisponíveis até a correção. |
| **Restauração excepcional de backup** (corrupção ou perda) | — | Só com autorização expressa. Seguir [BACKUP.md](BACKUP.md) "Restauração de verdade": restaurar num **banco novo**, conferir com `backup:restore-test`, e só então trocar. Tudo gravado depois do backup se perde; antes, exportar o que for preciso. |

Antes de qualquer passo em produção: backup recente verificado (`npm run backup` + `backup:verify`), ensaio na cópia
(`backup:migrate-rehearsal`) e registro do que foi feito.

## Implantação (quando autorizada, depois da 0020)

1. Backup e ensaio da migration numa cópia restaurada (`npm run backup:migrate-rehearsal`), como na Fase 1.
2. Rodar `node scripts/fornecedores-codigos.mjs` em produção (só leitura) e resolver os grupos A e B no painel.
3. Integrar a branch e aplicar a 0021 fora do horário de pico. A trava é curta, mas pega `supplier_products` com
   exclusividade.
4. Conferir os avisos da migration (códigos parecidos e permissões copiadas) e revisar os papéis dos usuários.
5. Conferir os parâmetros (3 % / 90 d / 3 d) na lista de fornecedores.

## Checklist de aprovação antes do merge

Fase 2 **congelada** em `sglog/fase2`, só com commits locais. Nada abaixo foi feito em produção.

- [ ] **Dependência da 0020:** Fase 1 implantada e estável em produção, com `schema_migrations` terminando em
  `0020_sglog_depositos` (a 0021 pressupõe exatamente esse estado).
- [ ] **Relatório de códigos em produção** (só leitura) com saída 0, ou seja, sem itens A ou B; os do grupo C conferidos
  com quem compra.
- [ ] **Ensaio da 0021 numa cópia restaurada** de produção: up, down e up com esquema idêntico, e tempo de trava
  medido.
- [ ] **Testes de regressão:** suíte completa, regressão da reposição e suíte do código anterior sobre a 0021, todas
  verdes na branch já rebaseada sobre o `main` atualizado (o rebase só quando autorizado).
- [ ] **Permissões validadas:** matriz por papel (estoquista sem `suppliers.manage`) e concessões individuais copiadas
  de `purchases.*` revisadas com o responsável.
- [ ] **Compatibilidade com clientes antigos aceita:** rota antiga de ofertas com omissão → 409 e plano de
  descontinuação; cadastro exige `version` (aba antiga recebe 428 com orientação).
- [ ] **Aceite visual das telas** por quem compra: lista, ficha (todas as abas), comparação no produto, comparação no
  pedido, conflito de edição.
- [ ] **Roteiro de recuperação** lido e aceito (seção "Recuperação e rollback").
- [ ] **Revisão de código** dos commits da branch.
- [ ] **Autorização expressa** para merge, para push e para implantação (cada uma separadamente).
