# Acompanhamento

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
