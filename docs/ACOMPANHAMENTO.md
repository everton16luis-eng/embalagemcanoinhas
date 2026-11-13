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

## Fase 4 — Loja, carrinho, checkout e pedidos — próxima

Antes da vitrine: 3 direções visuais com mockups para aprovação. Em paralelo, sem depender da aprovação: clientes,
carrinho e pedido na API, integração do Mercado Pago (documentação oficial), frete e expedição.
