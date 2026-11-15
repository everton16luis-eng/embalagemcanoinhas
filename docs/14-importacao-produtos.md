# Importação de produtos por planilha (.xlsx)

Painel → Produtos → **Importar via Excel** (`/painel/produtos/importar`). Cadastra muitos produtos de uma vez,
sem alterar nada que já existe. O fluxo tem quatro etapas, e só a última grava no catálogo:

1. **Modelo**: o administrador baixa o modelo oficial, com as categorias e unidades atuais.
2. **Envio e análise**: a planilha é conferida e cada linha classificada. Nada é criado nessa etapa.
3. **Prévia e revisão**: totais, filtros, correção de erros simples na tela, decisão sobre duplicados e categorias novas.
4. **Confirmação**: grava só as linhas novas e as aprovadas, em lotes transacionais, e gera o relatório.

## O que existia no banco (análise antes do modelo)

| Tabela | Campos usados pela importação |
|---|---|
| `products` | nome, slug, categoria, descrição, marca, status, unidade base, estoque mínimo, ficha técnica (`specs`) |
| `product_variants` | SKU (`citext UNIQUE`), código de barras (`UNIQUE`), peso e medidas |
| `packagings` | embalagem de venda padrão: rótulo, unidade, quantidade base 1, preço |
| `categories` | árvore de até 3 níveis, nome único por nível (`lower(name)`) |
| `units` | UN, PCT, CX, FD, DZ, CJ, KIT, PAR, RL, FL, KG, G, L, ML, M |
| `stock_movements` / `stock_balances` | saldo inicial pelo `moveStock` existente, com `request_key` |
| `product_fiscal` | registro criado vazio (pendente), como no cadastro individual |
| `product_images` | não recebe nada da planilha; as fotos vão depois, pelo SKU |

Campos pedidos que **não têm lugar no cadastro atual** e por isso ficaram fora do modelo: preço promocional,
palavras-chave e observações internas. Se a planilha trouxer essas colunas, a análise avisa que foram ignoradas.

## Estrutura do modelo

Abas: **Produtos** (dados), **Instruções** (como preencher, colunas, unidades e categorias) e **Listas** (oculta,
alimenta as listas suspensas). Linha 1: cabeçalhos (obrigatórios com `*`, em cor diferente, com nota explicativa).
Linha 2: exemplo, ignorado enquanto o nome começar com "Exemplo:". Produtos a partir da linha 3, até 2.000 por arquivo.

| Coluna | Obrigatória | Vai para |
|---|---|---|
| Nome do produto | sim | `products.name` (2 a 150) |
| Descrição comercial | sim | `products.description` (até 10.000) |
| Categoria | sim (lista; aceita nova) | `products.category_id` (raiz) |
| Subcategoria | não (lista; aceita nova) | filha da categoria |
| Preço de venda | sim | `packagings.price_cents` da embalagem de venda padrão |
| Unidade de venda | sim (lista) | `products.base_unit` e unidade da embalagem |
| Status | sim (lista: Ativo/Inativo) | `products.status` |
| SKU | não | `product_variants.sku`; em branco, gerado |
| Marca | não | `products.brand` |
| EAN/GTIN | não | `product_variants.barcode` (dígito verificador conferido) |
| Custo | não | custo da entrada de estoque (`unit_cost_cents`); só com quantidade |
| Quantidade em estoque | não | movimento `adjustment` pelo `moveStock`; em branco, nada |
| Estoque mínimo | não | `products.min_stock` |
| Peso (g), Comprimento, Largura, Altura (cm) | não | `product_variants.weight_g`, `length_mm`… (cm × 10) |
| Material, Cor, Capacidade | não | ficha técnica (`specs`) |
| Unidades por pacote | não | ficha técnica e rótulo da embalagem ("Pacote com 50") |
| Aplicações e indicações de uso | não | ficha técnica (até 200) |

Preço, custo, estoque, estoque mínimo e peso valem para a **unidade de venda** escolhida: o produto importado tem
uma embalagem de venda (quantidade base 1) nessa unidade. Mais embalagens (pacote e caixa do mesmo item) continuam
pelo cadastro individual. SKU e EAN são colunas de texto, para o Excel não cortar zeros nem usar notação científica.

Formatos aceitos: preço `12,50`, `12.50`, `R$ 1.234,56`; custo com até 4 casas (`0,0437`); quantidade `40`,
`1.000` (mil), `2,5` (só em unidade que aceita fração); unidade pelo código ou nome (`PCT`, `Pacote`, `pacotes`);
status `Ativo`/`Inativo`.

## Segurança do arquivo

- Extensão `.xlsx` obrigatória e conteúdo conferido: assinatura ZIP, diretório central lido sem descompactar,
  presença de `[Content_Types].xml` e `xl/workbook.xml`. Arquivo de outro tipo com nome `.xlsx` é recusado.
- Limites: 5 MB enviados, 60 MB descompactados, 2.000 partes no ZIP, 2.000 linhas.
- Macros (`vbaProject.bin`), ActiveX, objetos incorporados e vínculos externos recusam o arquivo inteiro.
- Fórmulas nunca são calculadas: a biblioteca não calcula, e o importador descarta o conteúdo da célula (nem o
  resultado salvo é usado). Texto começando com `=`, `+` ou `@` também é descartado. A linha aponta o campo.
- Caracteres de controle e marcação HTML são removidos; espaços repetidos viram um.
- No relatório gerado, nenhum texto começa com sinal de fórmula.
- Biblioteca: `exceljs` 4.4.0, versão fixa. O `npm audit` aponta um aviso moderado no `uuid` 8 que ela usa
  (falha só em `v3/v5/v6` com buffer); o exceljs usa apenas `v4()` sem buffer, então não se aplica.

## Classificação das linhas

| Situação | Quando | Na confirmação |
|---|---|---|
| Novo | tudo certo | cadastra |
| Já existe | SKU informado ou EAN já cadastrados (variação ou embalagem) | ignora; o existente não muda |
| Possível duplicado | nome parecido com produto do catálogo ou com linha anterior da planilha | só cadastra se aprovado |
| Categoria pendente | categoria ou subcategoria inexistente sem decisão | ignora até decidir |
| Com erro | valor inválido, fórmula, SKU ou EAN repetidos na planilha | ignora (corrigível na tela) |
| Incompleto | falta campo obrigatório | ignora (corrigível na tela) |

### Regras de duplicidade

- **SKU ou EAN idênticos** ao catálogo: "já existe". Comparação de SKU sem diferença de maiúsculas (`citext`).
- **Repetidos dentro da planilha**: a segunda linha com o mesmo SKU ou EAN vira erro, citando a primeira.
- **Nome semelhante**: o nome é normalizado (sem acento, minúsculo, singular simples, sem palavras como "de",
  "para", "com"), medidas são juntadas (`300 ML` = `300ml`, `Nº 4` = `n4`, `10 x 15` = `10x15`) e alguns sinônimos
  de embalagem se equivalem (cristal = transparente = incolor). Semelhança = palavras em comum ÷ palavras no total;
  a partir de 0,6 a linha vai para conferência. Ex.: "Copo Descartável 300ml Transparente" × "Copo 300 ML
  Descartável Cristal" = 1,0.
- **Tamanhos diferentes não são duplicados**: se os dois nomes têm medidas e elas diferem (200ml × 300ml, Nº 4 × Nº 5),
  a semelhança é zero.
- **Reenvio do mesmo arquivo**: o painel avisa a data da importação anterior (mesmo SHA-256); linhas com SKU/EAN
  viram "já existe" e as sem SKU viram "possível duplicado" (nome igual). Nada é cadastrado de novo sem aprovação.
- Um produto existente nunca é alterado: a importação só insere.

### Categorias

A comparação ignora acentos, maiúsculas e espaços ("  confeitaria " = "Confeitária"). Categoria inexistente aparece
na prévia com o número de linhas; o administrador escolhe uma existente ou autoriza criar. A criação só acontece na
confirmação, respeitando a hierarquia (subcategoria dentro da categoria; se a categoria já existe, só a subcategoria
é criada), e cada categoria criada vai para a auditoria.

## SKU automático

Gerado no backend (`apps/api/src/lib/sku.ts`), uma vez, a partir do nome:

- sem acento, maiúsculo, só letras, números, ponto e hífen;
- até 3 palavras, cada uma com as 3 primeiras letras (abreviações fixas: Caixa → CX, Bolo → BOLO, Doce → DOCE),
  e até 3 medidas inteiras, na ordem do nome; palavras como "de", "para", "com", "c/" ficam de fora;
- Copo Descartável 300ml → `COP-DES-300ML`; Caixa para Bolo Nº 4 → `CX-BOLO-N4`; Forma de Papel Nº 5 → `FOR-PAP-N5`;
  Copo Descartável 300ml Transparente → `COP-DES-300ML-TRA`;
- colisão (catálogo ou planilha): `-02`, `-03`…;
- unicidade garantida pela restrição `product_variants_sku_key` (`citext UNIQUE`, da migração 0002). Se outro
  cadastro pegar o SKU previsto entre a prévia e a gravação, a inserção falha no índice, volta ao savepoint e tenta
  o próximo sufixo (até 25 vezes); o relatório da linha diz que o previsto foi usado por outro cadastro;
- permanente: nada recalcula o SKU quando o nome muda; produtos que já têm SKU mantêm o seu, e SKU informado na
  planilha é usado como está (em maiúsculas);
- aparece na prévia (com a marca "gerado") e no cadastro individual, no campo SKU da variação.

## Confirmação em lotes

`POST /admin/product-imports/:id/process` processa um lote (padrão 100, a tela usa 50) por chamada, e a tela repete
mostrando o andamento. A primeira chamada confere tudo de novo com o catálogo atual, cria as categorias autorizadas,
marca as linhas que serão cadastradas e as ignoradas (com o motivo) e muda a importação para "em andamento".

- Cada lote é uma transação. Cada produto (produto, variação, embalagem, registro fiscal, estoque, auditoria) fica
  num savepoint: SKU ou EAN tomados depois da análise voltam só aquela linha, que entra no relatório como "não
  cadastrado". Qualquer outro erro desfaz o lote inteiro; as linhas continuam na fila e "Continuar importação"
  retoma de onde parou. Nenhum produto fica pela metade.
- A importação fica travada (`FOR UPDATE NOWAIT`): duas janelas não processam o mesmo lote.
- Estoque: só quando a quantidade é informada e maior que zero, por `moveStock` (`adjustment`, origem `manual`,
  `request_key = import-<id>-<linha>`), com o custo quando informado. Sem a permissão `stock.manage`, o produto é
  cadastrado e o relatório avisa que o estoque não foi lançado.
- Produto sem imagem é cadastrado e sinalizado (relatório, prévia e lista de produtos, que já mostra "sem foto").

## Imagens em lote por SKU

Na importação concluída com produtos sem imagem, o painel aceita várias fotos de uma vez, cada uma com o nome igual
ao SKU (`COP-DES-300ML.jpg`; outras do mesmo produto: `COP-DES-300ML_2.jpg`). A tela consulta
`POST /admin/product-imports/image-targets` e envia pela rota de imagens de sempre (tipo conferido pelo conteúdo,
12 por produto). Produto que já tinha foto não recebe nada: nenhuma imagem é trocada nem inventada.

## Relatório e histórico

- Relatório `.xlsx` (`GET /:id/report.xlsx`): aba "Resultado" com linha, produto, SKU, EAN, categoria, situação na
  análise, resultado, motivo e "sem imagem"; aba "Resumo" com arquivo, data, usuário, situação e totais. Gerado na
  hora a partir do banco, então pode ser baixado de novo a qualquer momento, inclusive antes de confirmar.
- Histórico na página de importação: arquivo, data e hora, usuário, cadastrados, ignorados, com erro, situação e
  link para o relatório.
- Auditoria: `product_imports.analyzed`, `.row_edited`, `.confirmed`, `.finished`, `.canceled`, `products.imported`
  (um por produto) e `categories.created`, todos com o id da importação.

## Permissões

Permissão nova **`catalog.import`** ("Importar produtos por planilha"), em `MFA_REQUIRED`: importar cria produtos e
preços em massa, como `prices.manage`. Vem no padrão do proprietário e do gerente; os outros papéis só com concessão.
Todas as rotas exigem também `catalog.manage`. A importação só escreve em `product_imports`, `product_import_rows`,
`categories`, `products`, `product_variants`, `packagings`, `product_fiscal`, `stock_*` e `audit_logs`; não toca em
usuários, permissões nem configurações (coberto por teste). Todas as consultas são parametrizadas.

## API (`/api/v1/admin/product-imports`)

| Método e rota | Faz |
|---|---|
| `GET /template.xlsx` | modelo oficial |
| `GET /guide` | colunas, unidades e categorias para a tela de instruções |
| `GET /` | histórico |
| `POST /` (multipart `file`) | envia e analisa; 10 por minuto por sessão |
| `GET /:id?filter=all\|new\|existing\|duplicate\|error\|review\|imported\|skipped\|failed&page=` | prévia |
| `PATCH /:id/rows/:row` `{ values?, decision? }` | corrige campos ou aprova/ignora duplicado; reanalisa |
| `PUT /:id/categories` `{ decisions: { chave: {action:'map', categoryId} \| {action:'create'} \| null } }` | categorias |
| `POST /:id/cancel` | descarta a análise |
| `POST /:id/process` `{ batchSize? }` | confirma e processa um lote |
| `GET /:id/report.xlsx` | relatório |
| `POST /image-targets` `{ skus }` | localiza produtos para as fotos por SKU |

Tabelas novas (migração `0019_importacao_produtos`): `product_imports` (arquivo, SHA-256, situação, decisões de
categoria, avisos, totais, quem enviou e confirmou) e `product_import_rows` (valores lidos, campos com fórmula,
dados normalizados, situação, problemas, semelhantes, decisão, SKU, resultado e motivo, produto criado).

## Testes

`apps/api/test/product-import.test.ts` (23 testes): geração e colisão de SKU, semelhança de nomes, modelo,
permissões (sem permissão, sem MFA, sem login), coluna obrigatória ausente, arquivo corrompido e cortado, extensão
falsa nos dois sentidos, ZIP sem planilha, macro e objeto incorporado, fórmulas, 1 produto completo (estoque, custo,
ficha, auditoria, relatório, histórico), SKU e EAN duplicados (catálogo e planilha), preço inválido e correção na
tela, nome semelhante com aprovação e recusa, categoria inexistente sem duplicar por acento, acentos e caracteres
especiais, 100 e 1.000 produtos, interrupção no meio de um lote e retomada, reenvio do mesmo arquivo, duas
importações confirmadas ao mesmo tempo, SKU tomado no meio do lote, nada alterado em usuários/permissões/
configurações e localização para imagens por SKU.

## Limitações

- Uma variação e uma embalagem de venda por linha. Variações (cor, tamanho) e embalagens extras (pacote e caixa do
  mesmo item) continuam pelo cadastro individual depois da importação.
- Dois níveis de categoria pela planilha (categoria e subcategoria); o terceiro nível só pelo cadastro de categorias.
- Preço promocional, palavras-chave e observações internas não existem no cadastro e não são importados.
- A semelhança de nomes é heurística (palavras e medidas), sem dicionário completo de sinônimos; pode deixar passar
  duplicados escritos de forma muito diferente ou pedir conferência a mais. A decisão é sempre do administrador.
- A análise carrega o catálogo inteiro na memória para comparar nomes: adequado a alguns milhares de produtos.
- Dados fiscais (NCM, origem) não vêm na planilha: os produtos entram com a classificação fiscal pendente.
- O custo só é gravado junto com a entrada de estoque (é o lugar dele no modelo atual).
