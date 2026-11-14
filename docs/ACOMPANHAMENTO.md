# Acompanhamento

Testes que dependem de HTTPS, credenciais reais, da empresa ou do contador ficam em
[TESTES-PENDENTES.md](TESTES-PENDENTES.md) e não seguram o desenvolvimento.

## Fase 1 — Diagnóstico — concluída (13/11/2026)

Ver [00-diagnostico-e-plano.md](00-diagnostico-e-plano.md).

## Fase 2 — Base do sistema — entregue para validação (13/11/2026)

### Pronto

- Monorepo novo, banco próprio em cluster isolado, papéis separados (dono e aplicação) e migrations com `down`.
- Equipe: login, sessão em cookie `httpOnly` com expiração por inatividade (2 h) e absoluta (12 h), bloqueio após
  tentativas, recuperação de senha de uso único, troca de senha que derruba as outras sessões, MFA (TOTP) com código
  de uso único, lista e encerramento de sessões.
- Permissões por papel (proprietário, gerente, atendimento, estoque, fiscal, expedição) com exceções individuais.
  Permissões sensíveis exigem MFA. Ninguém altera o próprio papel; o sistema não fica sem proprietário.
- Auditoria somente inclusão, com antes/depois, protegida por gatilho até contra o dono das tabelas.
- Proteções: CSRF por origem, rate limit, validação no servidor (zod), SQL parametrizado, cabeçalhos de segurança.
- Catálogo: categorias em até 3 níveis, produtos com variações (SKU único, GTIN validado), unidade base,
  embalagens de venda (com preço) e de compra (com conversão para a unidade base), ficha técnica, giro,
  sob encomenda com prazo opcional, busca sem acento por nome/SKU/código de barras.
- Histórico de preços gravado por gatilho, com autor; alterar preço exige permissão própria + MFA.
- Concorrência otimista no produto (duas pessoas não se sobrescrevem). Variação retirada fica inativa, não some.
- Fotos: conteúdo verificado, metadados removidos, WebP em 320/800/1600 px, foto principal.
- Classificação fiscal do produto (NCM, CEST, origem, unidade tributável) com quem informou e quem validou.
  Qualquer mudança derruba a validação; histórico completo.
- Empresa: dados do emitente e do contador em versões imutáveis; CNPJ numérico e alfanumérico validado; IBGE
  conferido com a UF. Configuração fiscal começa em homologação e não vai para produção sem liberação registrada
  (regra no banco).
- Assistente de configuração: o que falta, quem informa (empresa, contador, sistema) e o que fica para fases seguintes.
- Painel: configuração inicial, produtos, categorias, empresa e fiscal, marca da loja, usuários, auditoria, conta.

### Testes

- 39 testes de integração da API (`npm test`): autenticação, MFA, CSRF, varredura de todas as rotas sem sessão e
  com papel sem permissão, privilégios do papel do banco, catálogo, conversão de embalagens, preços, fiscal,
  empresa e assistente.
- Navegador: login, assistente, cadastro e edição de produto pela tela (histórico de preço atualizado), páginas do
  painel sem erro e sem rolagem horizontal em 375 px.

### Não verificado

- Inspeção visual por captura de tela: o painel do navegador estava oculto durante a verificação.
- Build de produção (`next build`) e implantação em servidor.
- Envio de e-mail (recuperação de senha): não há provedor configurado; o link não é entregue.

### Decisões em aberto

| Decisão | Necessária até |
|---|---|
| Servidor de produção (mesmo VPS da barbearia?) e medição de memória | Primeira implantação |
| Provedor de e-mail transacional | Primeira implantação |
| Primeiro gateway de pagamento (sugestão: Mercado Pago) | Fase 4 |
| Provedor fiscal | Fase 5 |

## Fase 3 — ERP e estoque — entregue para validação (13/11/2026)

### Pronto

- Saldo por variação na unidade base: físico, reservado e disponível (físico − reservado). Saldo físico nunca fica
  negativo (regra no banco).
- Livro de movimentos imutável (entrada de compra, venda, devolução, perda, avaria, ajuste, inventário, reserva,
  liberação). Cada linha guarda o saldo resultante, o custo e o autor. Nem o papel da aplicação altera ou apaga.
- Um único caminho altera saldo (`moveStock`), com bloqueio da linha do saldo: duas reservas simultâneas nunca vendem
  a mesma unidade (testado com 10 pedidos concorrentes sobre 50 unidades).
- Reservas com vencimento, liberação automática a cada minuto e repetição sem efeito. Produto sob encomenda reserva
  além do físico (a falta aparece no filtro "reservado além do físico") e só baixa quando a mercadoria chega.
- Fracionamento: quilo, litro e metro aceitam até 3 casas; unidade, pacote e caixa recusam fração em toda entrada
  e saída.
- Fornecedores com contatos, prazo, pedido mínimo, condição de pagamento e frete; lista de custos por embalagem com
  custo por unidade base (comparável entre pacotes e fornecedores). Oferta retirada fica inativa.
- Pedido de compra: rascunho → enviado → recebido em parte → recebido (ou cancelado / encerrado com saldo pendente).
  O pedido guarda cópia da embalagem e do custo. Editável até o primeiro recebimento.
- Recebimento parcial ou total com chave de requisição (reenvio não dá entrada dupla). Custo de entrada =
  embalagem + frete e despesas rateados pelo valor dos itens, proporcional ao que chegou; custo médio ponderado.
- Inventário: contagem cega (quem conta não vê o saldo), em partes, uma aberta por vez; no fechamento a diferença
  vira movimento de inventário. Item não contado não muda.
- Sugestão de reposição por giro: necessidade = venda diária × (prazo do fornecedor + cobertura) + mínimo −
  (disponível + a caminho). Para cada oferta: embalagens, desembolso, custo por unidade e dias de cobertura. A
  recomendada é a mais barata por unidade que não passe da cobertura máxima ("pacote que compensa sem prender
  capital de giro"). Gera os pedidos de compra em rascunho, um por fornecedor.
- Relatórios: valor em estoque por categoria (custo médio), alertas, movimentação do período, mais vendidos e
  compras recebidas.
- Quem só vende vê saldo, mas não custo.
- Painel: Estoque, Inventário, Compras, Reposição, Fornecedores, Relatórios.

### Testes

- 51 testes de integração (12 novos): comprar 1 pacote de 100 com frete, vender 5 e restar 95 com custo de R$ 0,25;
  venda de 0,250 kg; recusa de fração em unidade; rateio de frete em recebimentos parciais (frete total entra uma
  vez); custo médio ponderado; recebimento repetido e acima do pedido; reservas concorrentes; sob encomenda; reserva
  vencida; perda sem motivo e acima do saldo; imutabilidade dos movimentos; custo oculto para atendimento;
  inventário; reposição recomendando o pacote menor quando o maior prende capital; varredura de permissões.
- Navegador: cadastro de fornecedor e lista de custos, pedido com custo puxado da lista, envio, recebimento parcial
  (R$ 2,00/UN com metade do frete), reserva e baixa (100 → 95), inventário com diferença, reposição e relatórios.
  Sem rolagem horizontal em 375 px.

### Decisões registradas

- Estoque mínimo continua no produto e vale para cada variação.
- Pedido encerrado com saldo pendente não rateia a parte do frete que corresponderia ao que não chegou.
- Fechamento do inventário compara com o saldo do momento do fechamento: contar com a loja parada ou fechar logo
  após a contagem.
- A venda pela loja (Fase 4) usará as mesmas funções de reserva e baixa (`reserve`, `consumeReservation`).

### Não verificado

- Inspeção por captura de tela: o painel do navegador seguia oculto; a verificação foi por texto e medidas.

## Fase 4 — Loja, carrinho, checkout e pedidos — entregue para validação (13/11/2026)

### Direção visual

Proposta em [design/direcoes-visuais.html](design/direcoes-visuais.html): A · Gôndola (recomendada), B · Ateliê,
C · Catálogo técnico. Sem resposta no prazo, a loja foi construída na **A · Gôndola**, como combinado: dá para trocar,
os tokens da loja ficam separados (`--color-g-*` em `globals.css`). Da C veio o pedido rápido por código (SKU).
A linha de "ocasiões" da B ficou de fora: depende de curadoria real de produtos.

Segunda rodada (13/11/2026), a pedido: [design/direcoes-visuais-2.html](design/direcoes-visuais-2.html) com três
direções novas, a partir das lojas especializadas mais bem colocadas no Google (pesquisa e o que cada uma inspirou na
primeira aba do arquivo): **D · Balcão** (comprar pelo site e retirar em Canoinhas, departamentos por ícone, quantidade
no card, repetir pedido), **E · Monte seu kit** (calculadora: o que vai produzir e quanto → lista de compras em
pacotes) e **F · Calendário** (régua do ano, coleção da próxima data com "peça até"). Nada copiado das lojas
pesquisadas. A loja continua na A até a sua escolha (A a F).

### Pronto

- **Faixas de preço por quantidade** por embalagem de venda (até 6). Alterar exige permissão de preços + MFA,
  como o preço. Editor no cadastro de produto.
- **Vitrine** (`/`, `/c/[departamento]`, `/busca`, `/p/[produto]`): etiqueta amarela com preço da embalagem e preço
  por unidade, escada de preço por quantidade, pronta entrega × sob encomenda com prazo, filtros e ordenação que
  funcionam sem JavaScript. Foto ausente aparece como "Foto em breve" (nunca imagem inventada).
- **Carrinho** por cookie, recalculado no servidor a cada mudança; aviso de falta de estoque e de "leve mais N".
- **Frete** por regras do painel (Formas de entrega): retirada, ou entrega por faixa de CEP, valor fixo + por kg,
  grátis acima de um valor, peso máximo.
- **Checkout** sem obrigar conta, idempotente (duplo clique devolve o mesmo pedido), preço recalculado no servidor,
  bloqueio se o preço mudou ou faltou estoque. Estoque reservado na hora; item sob encomenda entra como encomenda.
- **Pagamento Mercado Pago** (Checkout Transparente): Pix com QR e copia e cola, cartão pelo Card Payment Brick
  (a loja recebe só o token). Aviso (webhook) com assinatura `x-signature` conferida, avisos repetidos ignorados,
  valor divergente nunca aprova. A tela do pedido também consulta o Mercado Pago enquanto o Pix está pendente.
- **Vencimento**: pedido sem pagamento no prazo é cancelado e o estoque volta; antes, a rotina pergunta ao
  Mercado Pago (Pix pago no último minuto não é cancelado).
- **Conta do cliente**: cadastro, entrada, endereços, meus pedidos. Sessão separada da equipe.
- **Painel**: Pedidos (separação → pronto → despacho, cancelamento com devolução de estoque), Formas de entrega.
  **Despacho só com NF-e autorizada** (a emissão é a Fase 5; até lá fica bloqueado de propósito).

### Testes

- API: 75 testes passando (24 novos em `store.test.ts`): faixas, vitrine sem custo/saldo, CSRF do carrinho, frete,
  checkout idempotente, bloqueios, encomenda, Pix/cartão/aviso, assinatura oficial do Mercado Pago, vencimento,
  despacho bloqueado sem NF-e e baixa no despacho, permissões, conta do cliente, papel do banco.
- Navegador (provedor simulado): produto → carrinho → frete por CEP → pedido → Pix → pago → painel (separação,
  pronto, despacho bloqueado). Nenhuma página transborda a 375 px.

### Decisões registradas

- Link de acompanhamento do pedido derivado da chave do pedido com a chave secreta do servidor (só o hash no banco).
- Pedido pago guarda a reserva até o despacho; o despacho consome a reserva (baixa de estoque).
- Cancelar pedido pago não devolve o dinheiro sozinho: o painel avisa para devolver no Mercado Pago. Devolução
  pela API fica para quando as credenciais forem homologadas.
- `PAYMENT_FAKE=true` liga um provedor simulado **só fora de produção** (a API recusa iniciar em produção com ele).
- Formas de entrega "(exemplo)" existem só no banco local de desenvolvimento.

### Não verificado / pendente com você

- **Credenciais de teste do Mercado Pago** (Access Token, Public Key, chave do webhook) para homologar Pix e o
  Card Payment Brick de verdade. O formulário do cartão foi escrito pela documentação, mas só roda com a chave pública.
- Endereço público (https) da API para o Mercado Pago chamar o webhook.
- Nome e logotipo da loja, fotos, dados da empresa no rodapé, textos de trocas/privacidade (Painel > Marca da loja).
- Formas de entrega reais (retirada? quais CEPs? valores?).

## Fase 5 — NF-e modelo 55 — entregue para validação (13/11/2026)

Decisões e comparação de provedores: `docs/05-fiscal-nfe.md`.

### Pronto

- **Provedor**: Focus NFe, atrás da interface `FiscalProvider` (trocável). Contrato conferido na documentação
  oficial: emissão assíncrona por `ref`, consulta, cancelamento, CC-e, inutilização, gatilho (webhook).
  Autorizador de SC: SVRS (via provedor).
- **Conferência antes de emitir**, mostrada no pedido: credencial do ambiente, dados da empresa, regime, endereço e
  documento do comprador, regra fiscal validada para a operação, produtos com cadastro fiscal validado.
- **Regras fiscais por operação** (dentro/fora do estado × PF/empresa contribuinte/não contribuinte): natureza,
  CFOP, CST/CSOSN, PIS, COFINS, consumidor final, presença e campos extras do provedor (IBS/CBS). Informada →
  validada pelo contador; alterou, a validação cai; histórico imutável.
- **Emissão idempotente**: uma nota ativa por pedido (índice único), documento criado antes de chamar o provedor,
  falha de rede deixa pendente e a rotina reenvia **com a mesma ref** só se o provedor não a recebeu.
  Rejeição fica no histórico e a nova tentativa usa outra ref.
- **Aviso do provedor**: header de autorização próprio; a situação vem sempre da consulta à API, nunca do corpo.
- **Arquivos**: XML, DANFE, XML de cancelamento e de CC-e guardados com SHA-256 (conferido a cada download).
  Cliente baixa DANFE e XML no link do pedido e na conta.
- **Guarda**: nota não pode ser apagada; o que foi enviado não muda; autorizada só vira cancelada (gatilhos no banco).
- **Cancelamento e CC-e** no detalhe da nota; pedido com nota autorizada só é cancelado depois da nota.
- **Inutilização** de faixa (recusa faixa que contém nota da loja).
- **Certificado A1**: fica no provedor; a loja registra a validade e avisa com 30, 15 e 7 dias.
- **Trava de produção**: liberação só com credenciamento concluído, nota autorizada em homologação, credencial de
  produção e nome do contador (permissão `fiscal.validate` com MFA).
- **Política de emissão**: manual (botão no pedido) ou automática ao confirmar o pagamento.
- **Painel**: Nota fiscal (visão geral, notas, regras, certificado e numeração), detalhe da nota, cartão no pedido.
- **XML de compra**: Compras › Notas de compra importa o XML do fornecedor (uma vez por chave, sem DOCTYPE, chave
  conferida), confere fornecedor e itens pelo código do fornecedor ou de barras e, vinculada ao pedido de compra,
  aponta diferenças de quantidade e preço. Não mexe no estoque; o link para receber já leva o número da NF.

### Testes

- API: 96 testes passando (17 em `fiscal.test.ts`, 4 em `purchase-invoices.test.ts`): JSON da NF-e, adaptador Focus com `fetch` simulado
  (Basic, ref, reconsulta, rejeição, 5xx, download só do provedor, header do aviso), conferência, emissão com
  arquivos e DANFE do cliente, clique duplo simultâneo, aviso sem header, corpo do aviso ignorado, falha de rede e
  resposta perdida, rejeição e nova tentativa, CC-e e cancelamento, imutabilidade, arquivo adulterado, inutilização,
  regras e permissões, liberação de produção, emissão automática, avisos do certificado.
- Navegador (provedor simulado): página Nota fiscal nas 4 abas e cartão do pedido com a lista do que falta;
  sem erros e sem transbordar a 375 px.
- Navegador: Notas de compra (lista e detalhe da conferência) com XML fictício no banco de desenvolvimento; sem erros
  no console e sem transbordar a 375 px.

### Não verificado / pendente com você

- **Nenhuma chamada real à Focus foi feita**: falta conta e token de homologação. O adaptador segue a documentação e
  foi testado com respostas simuladas.
- A tela do detalhe de nota autorizada e o bloco "Nota fiscal" da loja não foram vistos no navegador: o banco local
  não tem dados da empresa (não preenchi dados inventados). Estão cobertos pelos testes da API.
- Com o contador: regras por operação, validação fiscal dos produtos, códigos de pagamento (`17` Pix, `03` cartão),
  IBS/CBS, política de emissão, rateio de frete por item, pedido de retirada sem endereço.
- Com a empresa: contrato com o provedor, certificado A1 enviado a ele, credenciamento na SEF-SC.
- Importação de XML de compra: testada só com XML montado nos testes; vale conferir com um XML real de fornecedor.

---

## Fase 6 — Central comercial — entregue para validação (13/11/2026)

Critério do plano: **orçamento → pedido sem redigitar**. Testes externos desta fase estão em
[TESTES-PENDENTES.md](TESTES-PENDENTES.md).

### Pronto

- **Balcão** (permissão `sales_desk.use`): busca rápida por nome, SKU ou código de barras, com preço, faixas por
  quantidade, saldo em embalagens disponíveis (já descontadas as reservas) ou prazo de sob encomenda.
- **Compartilhar pelo WhatsApp**: link oficial `wa.me` (formato conferido na Central de Ajuda do WhatsApp). A
  mensagem é enviada pela pessoa, no WhatsApp dela; não há automação. O painel só registra que o link foi aberto.
- **Orçamento**: preço calculado pelo banco e congelado nos itens; validade de 1 a 30 dias (padrão 7); entrega
  definida ou "a combinar"; cliente com nome e WhatsApp, e-mail e CPF/CNPJ opcionais. Repetir o envio não duplica.
  Itens e eventos imutáveis; orçamento não é apagado (só cancelado com motivo).
- **Desconto** só com a permissão de preços (com MFA), menor que o total dos itens, auditado.
- **Link público do orçamento** (`/orcamento/{token}`): o cliente vê os itens e totais, completa só o que falta
  (e-mail, CPF/CNPJ, entrega), escolhe Pix ou cartão e aceita. O link não mostra telefone, e-mail nem documento.
- **Conversão em pedido** (pelo atendente ou pelo cliente): mesmos preços do orçamento até a validade, reserva de
  estoque, pedido no canal "balcão", prazo de pagamento até o fim do dia de validade (mínimo 1 h, máximo 24 h).
  Clique duplo, outro atendente ou o cliente pelo link devolvem o mesmo pedido. Se o pedido for cancelado por falta de
  pagamento e o orçamento ainda valer, a próxima conversão cria outro pedido reaproveitando os dados já completados.
- **Bloqueios**: orçamento vencido (oferece cópia com preços atuais), cancelado, ou com item que saiu de venda ou sem
  saldo (sob encomenda passa).
- Criação do pedido extraída do checkout (`insertOrder`) e usada pelos dois caminhos.

### Testes

- API: 104 testes passando (8 novos em `quotes.test.ts`): busca por nome/SKU/código de barras e curinga do LIKE,
  permissão, preço congelado com faixa, repetição sem duplicar, desconto só com MFA e limite, item fora de venda,
  documento inválido, entrega sem endereço, link público sem dados de contato, conversão com preço antigo depois de
  aumento, reserva, repetição pelo atendente e pelo cliente, reconversão após cancelamento por prazo, entrega
  escolhida pelo cliente, vencido/cancelado/sem saldo, cópia com preço atual, imutabilidade.
- Navegador (banco de desenvolvimento, cliente fictício): busca, link do WhatsApp, criação do orçamento, página
  pública a 375 px sem transbordar, aceite com retirada e Pix até a página do pedido, lista de orçamentos com
  "Virou pedido". Sem erros no console.

### Decisões registradas

- Preço do orçamento vale até a validade mesmo que o preço do produto mude; disponibilidade é conferida na conversão.
- Saldo só é reservado quando o orçamento vira pedido (orçamento não segura estoque).
- Orçamento não se edita: para mudar, cancela-se ou faz-se uma cópia (preços e frete recalculados).
- Sem pagamento online configurado, a conversão é recusada (o pedido não teria como ser pago).

### Não verificado / pendente com você

- Abrir o link `wa.me` num celular com WhatsApp e conferir a mensagem; link público acessado de fora (precisa HTTPS).
- Pagamento "na loja" (dinheiro, maquininha) para pedidos do balcão não existe: hoje o pedido do balcão é pago por
  Pix ou cartão online. Se quiser receber no balcão, é uma decisão sua (e do contador, para a nota).

## Fase 7 — Mercado Livre e Shopee — entregue para validação (13/11/2026)

Critério do plano: **pedidos importados sem duplicidade e estoque sincronizado**. Decisões e contratos das APIs
(conferidos na documentação oficial) em [07-marketplaces.md](07-marketplaces.md); testes reais em
[TESTES-PENDENTES.md](TESTES-PENDENTES.md) (precisam de app cadastrado, HTTPS e conta de vendedor).

### Pronto

- **Conexão das contas** pelo painel (Marketplaces, permissão `marketplaces.manage` com MFA): OAuth com `state` de
  uso único e PKCE no Mercado Livre; tokens cifrados; renovação automática antes de vencer, com trava por conta
  (refresh de uso único). Recusa da plataforma deixa a conta em "Autorizar de novo".
- **Vínculo de anúncios**: cada anúncio (ou modelo da Shopee) aponta para uma embalagem de venda, com busca de
  embalagens na própria tela.
- **Saldo**: disponível em embalagens (descontadas as reservas) enviado ao anúncio quando muda; botão "Enviar saldos
  agora". Sob encomenda não envia; anúncio do ML com variação fica manual.
- **Vendas**: avisos (ML sem assinatura, Shopee com HMAC conferido) só disparam a consulta. Venda paga vira pedido
  pago no canal do marketplace, com reserva de estoque. Anúncio sem vínculo ou falta de estoque deixam a venda em
  "Precisa de ação" com o motivo; vincular o anúncio reprocessa. Venda cancelada lá cancela o pedido e devolve a
  reserva. "Buscar venda" pelo número cobre aviso perdido.
- Pedidos mostram o canal (Mercado Livre/Shopee) e "Pago no marketplace"; ficam fora da emissão automática de NF-e.
- O backup confere também contas e vendas de marketplace.

### Testes

- API: 125 testes passando (21 novos em `marketplaces.test.ts`, com os dois marketplaces simulados e respostas
  gravadas para os adaptadores reais): state de uso único e de outra pessoa, tokens cifrados, permissão e MFA,
  renovação e reautorização, importação sem duplicar com aviso repetido, reserva e saldo enviado (17 = (1000 − 150) / 50),
  sem vínculo → vincula → importa, sem estoque, aguardando pagamento → paga → cancelada, erro de rede e nova
  consulta, aviso de outra conta/tópico, push da Shopee sem assinatura recusado, ML com variação sem envio,
  assinatura das chamadas da Shopee e PKCE conferidos pela fórmula da documentação.
- Navegador (desenvolvimento, simulado): conectar o Mercado Livre até a página de retorno, vincular anúncio a uma
  embalagem, enviar saldo (4 pacotes), buscar venda inexistente (fica em "Precisa de ação" com o motivo). Tela a
  375 px sem transbordar. Para essa verificação, o MFA do usuário de desenvolvimento foi ligado só no banco e
  desligado logo depois.

### Decisões registradas

- O aviso nunca é a verdade: a situação vem sempre da consulta à API.
- Venda importada usa o preço pago no marketplace; frete 0 no pedido (o envio é do marketplace).
- Sem estoque, a venda não é importada (não há reserva além do saldo); fica com o motivo até a entrada de estoque ou
  o cancelamento no marketplace.
- Dados pessoais do comprador não são copiados; a NF-e desses pedidos é manual até decidir com o contador.

### Não verificado / pendente com você

- Nada foi chamado nas APIs reais: aplicativos, URLs com HTTPS e contas de teste estão em TESTES-PENDENTES.
- Códigos de erro específicos da Shopee não são interpretados (só HTTP 401/403 pedem nova autorização); confirmar
  com respostas reais.

---

## Fase 8 — WhatsApp, transportadoras e relatórios — entregue para validação (13/11/2026)

Escopo do plano: avisos por WhatsApp (API oficial), cotação de transportadoras por API e relatórios avançados.
Contratos conferidos na documentação oficial e decisões em
[08-whatsapp-transportadoras-relatorios.md](08-whatsapp-transportadoras-relatorios.md); testes reais em
[TESTES-PENDENTES.md](TESTES-PENDENTES.md).

### Pronto

- **Consentimento**: caixa opcional no checkout e na aceitação do orçamento, com o nome da loja no texto ("Quero
  receber atualizações deste pedido pelo WhatsApp da {loja}. Para parar, responda SAIR."). Texto e data gravados no
  pedido. Sem nome da loja cadastrado, a caixa não aparece.
- **Avisos automáticos** por modelo aprovado (pagamento confirmado, pronto para retirada, despachado com rastreio):
  fila com um aviso por pedido e evento (nunca duplica), novas tentativas com espera crescente (até 8), sem envio a
  quem respondeu SAIR. Os modelos são cadastrados no painel (WhatsApp, `settings.manage` com MFA).
- **Webhook** `/api/v1/webhooks/whatsapp`: verificação do `hub.challenge` e assinatura `X-Hub-Signature-256`
  conferida no corpo bruto; mensagens repetidas ignoradas; situação da mensagem só avança (enviada → entregue → lida).
- **Caixa de conversas** no painel (permissão do balcão): mensagens recebidas e enviadas, situação de cada envio,
  resposta em texto livre só dentro de 24 h da última mensagem do cliente; número que pediu SAIR fica bloqueado.
- **Transportadora**: nova forma de entrega "Transportadora (cotação automática)" com o código do serviço, dias de
  separação, taxa de manuseio e frete grátis acima de um valor. A cotação (Melhor Envio, endpoint de cálculo) usa
  CEP de origem da empresa, CEP do cliente e peso/medidas das variações; guarda 30 min em cache. Produto sem peso ou
  medidas, provedor fora do ar ou sem CEP de origem: a opção some e ficam as formas próprias. O pedido guarda a
  cotação escolhida (aparece no detalhe do pedido).
- **Relatórios de vendas** (Vendas, `reports.view`): pedidos pagos por dia ou mês, canal e forma de pagamento,
  ticket médio, frete; produtos com custo, margem estimada e curva ABC; exportação CSV (separador `;`, abre no Excel).
- A emissão automática de NF-e fica restrita à loja e ao balcão.

### Testes

- API: 138 testes passando (13 novos em `phase8.test.ts`): consentimento gravado e fila sem duplicar, envio e nova
  tentativa, falha definitiva, SAIR bloqueia, webhook sem assinatura recusado e repetido ignorado, situação não
  regride, janela de 24 h na resposta, cotação com cache, provedor fora do ar, produto sem medidas, relatórios
  (totais, ABC, margem, período inválido).
- Navegador (desenvolvimento, simulados `WHATSAPP_FAKE`/`CARRIER_FAKE`): cadastrar transportadora; mensagem recebida
  por webhook assinado aparece na caixa, resposta enviada com situação "Enviada"; definir modelo; relatório de vendas
  com um pedido pago. As três telas a 375 px sem transbordar. MFA do usuário de desenvolvimento ligado só no banco
  para a verificação e desligado logo depois.

### Decisões registradas

- Só a API oficial (Cloud API) ou link `wa.me`; nenhuma automação não oficial.
- Mensagem fora da janela de 24 h só por modelo aprovado; o painel não deixa enviar texto livre fora dela.
- Transportadora aparece para o cliente como entrega, para manter endereço, checkout e NF-e iguais.
- Token do Melhor Envio vem do `.env`; a renovação (OAuth) não foi achada na documentação pública e fica pendente.
- Custo do relatório é estimativa (custo médio na baixa do estoque, ou o atual se o pedido não saiu).

### Não verificado / pendente com você

- Nada foi enviado ao WhatsApp nem cotado no Melhor Envio de verdade (app da Meta, número, modelos aprovados e conta
  do Melhor Envio estão em TESTES-PENDENTES).
- O CEP de origem do ambiente de desenvolvimento não está cadastrado; a cotação na loja só foi testada nos testes
  automáticos.

---

## Preparação do lançamento (V1)

- **Backup e restauração** (critério do plano): `scripts/backup.mjs` com `backup`, `verify` e `restore-test`.
  Testado localmente: restauração num banco temporário com contagens e migrations iguais ao manifesto e o XML de
  compra conferido pelo hash; um arquivo adulterado de propósito foi detectado. O teste de restauração encontrou e
  levou à correção do caminho dos arquivos fiscais (`storage/fiscal/<chave>`). Procedimento em [BACKUP.md](BACKUP.md).
- A cópia `backups/20261113-125357` do banco local ficou com um arquivo alterado de propósito (teste do `verify`);
  pode ser apagada.

### Checklist de lançamento e implantação (13/11/2026)

- **Configuração inicial virou o checklist do lançamento**: os itens que antes diziam "próxima fase" agora conferem o
  estado real (regras fiscais validadas, certificado e dias até vencer, token de homologação do provedor fiscal,
  credenciais de pagamento). Novo grupo **Antes de vender**: formas de entrega, política de privacidade (LGPD),
  termos de uso, NF-e de teste autorizada e cancelada em homologação no provedor real, produção liberada com a
  validação do contador e backup no servidor. Simulados de desenvolvimento nunca contam como prontos.
- **Travas de produção na API**: não sobe com `APP_ORIGIN`, `PUBLIC_API_URL` ou URLs de retorno dos marketplaces sem
  `https://` (além dos simuladores, que já eram recusados); avisa no log se `TRUST_PROXY=0` e que não há provedor de
  e-mail.
- **Nova senha temporária** em Usuários (permissão "Gerenciar usuários" com MFA): gera senha mostrada uma vez, derruba
  as sessões e pode desligar o MFA de quem perdeu o celular. Ninguém usa para si mesmo; proprietário só por outro
  proprietário; fica na auditoria. Sem provedor de e-mail, era o único jeito de recuperar o acesso.
- **Kit de implantação** para Ubuntu: [IMPLANTACAO.md](IMPLANTACAO.md), unidades do systemd (`deploy/systemd`: banco
  próprio, API, loja/painel, backup diário com timer) e modelo do nginx (`deploy/nginx/loja.conf`).
  `node scripts/db-local.mjs init --production https://dominio` cria só o banco `loja_prod` e um `.env` de produção
  sem simuladores.
- Testes: API com 140 testes passando (nova senha temporária e travas de produção). O build da API subiu em modo
  produção na máquina local: endereço sem HTTPS recusado, `/ready` respondendo, HSTS e `nosniff` presentes. Navegador:
  checklist com os itens reais; "Nova senha" num usuário de teste (depois desativado), com a permissão e o MFA do
  usuário de desenvolvimento ligados só no banco e retirados logo depois.
- Não verificado: nada foi instalado num servidor de verdade (itens em TESTES-PENDENTES, seção Lançamento).


### Dados de demonstração e reversão (13/11/2026)

- `npm run demo:seed -- --confirmar DEMO` enche um banco vazio com uma loja fictícia de 6 meses: ~100 produtos,
  ~450 pedidos em todos os canais e situações, 240 orçamentos, compras, inventários, clientes, marketplaces e
  WhatsApp. O estoque é simulado em ordem de data, então saldo, reservas e custo médio batem com o livro de
  movimentos. Empresa, regras fiscais, certificado e NF-e ficam vazios (não se inventa dado fiscal). Roteiro em
  [DEMONSTRACAO.md](DEMONSTRACAO.md).
- `npm run demo:reset -- --confirmar APAGAR-TUDO` apaga todos os cadastros e deixa só os proprietários e a
  auditoria. Recusa se houver nota fiscal, XML de compra, pagamento real ou conta de marketplace conectada; faz
  backup antes; tudo numa transação.
- Correções achadas com os dados de demonstração: a previsão de entrega das compras aparecia "Invalid Date" (a API
  mandava data com hora); a página do pedido quebrava em pedido sem CPF/CNPJ, caso das vendas de marketplace, e
  dizia "cliente retira na loja" para elas.
- Testes: seed, reversão e seed de novo num banco temporário; conferência por SQL (saldo = soma dos movimentos,
  reservado = reservas ativas, nenhuma data no futuro, nenhum gatilho desligado depois); trava fiscal recusando; painel
  aberto com os dados (pedidos, orçamentos, vendas, compras, estoque, inventário, relatórios, WhatsApp, loja). API com
  140 testes passando.
- Não verificado: rodar no servidor (anotado em TESTES-PENDENTES).

### Estabilidade da página de produto (13/11/2026)

- Causa: na grade foto | compra, a foto quadrada (`aspect-ratio`) ganhava largura mínima igual à altura da linha, e
  essa altura vinha da caixa de compra. Trocar de embalagem ou passar de faixa de preço mudava a altura da caixa,
  que mudava a largura da foto, que mudava a largura da caixa (ex.: 1024 px: colunas 677/228 px no pacote e
  498/407 px na caixa). Correção: `min-w-0` na galeria e colunas `minmax(0, …)`.
- Blocos que dependem da embalagem (tabela de preço por quantidade, estoque) são desenhados para todas as
  embalagens na mesma célula, só a escolhida visível: a altura é a da maior. Linha do preço cheio riscado e linha
  de dica/aviso ficam reservadas. Botão de adicionar com largura do espaço livre e números tabulares.
- Embalagem esgotada mantém quantidade e botão no lugar, desabilitados ("Esgotado no momento"), em vez de sumir.
- Medido com script no navegador (posição e tamanho de título, embalagens, preço, quantidade, botão, caixa e
  descrição): 0 px de deslocamento em 375, 768 e 1024 px, em produto com opções, esgotado, sob encomenda e estoque
  limitado. Preços e total conferidos com o carrinho da API.
