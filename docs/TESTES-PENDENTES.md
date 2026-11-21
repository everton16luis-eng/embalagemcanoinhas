# Testes pendentes (depois, com HTTPS ou com você)

Tudo o que não dá para testar no ambiente local: precisa de endereço público com HTTPS, de credencial real, de dado
da empresa ou de alguém de fora (contador, fornecedor, provedor). O código segue sendo feito; esta lista é o roteiro
de testes antes do lançamento. Marque `[x]` quando for testado e anote a data.

Legenda: **HTTPS** = precisa da API publicada com certificado · **Você** = depende de dado, conta ou decisão sua ·
**Contador** = depende da validação dele.

## Infraestrutura (antes de tudo)

- [x] **HTTPS** Domínio no ar com certificado Let's Encrypt por webroot (14/11/2026; vale até 12/02/2027,
      renovação recarrega o nginx). VPS: 7,9 GB, ~5,5 GB disponíveis com tudo rodando. Acesso provisório pelo IP desligado.
- [x] **Servidor** `certbot renew --dry-run` passou (14/11/2026).
- [x] **HTTPS** `next build` e implantação no domínio, cabeçalhos de segurança conferidos pelo script (14/11/2026).
- [x] **HTTPS** Cookie de sessão com `Secure` e `HttpOnly` no navegador (14/11/2026).
- [x] Backup e teste de restauração **local** (13/11/2026): `npm run backup` e `backup:restore-test` OK; arquivo
      adulterado detectado pelo `backup:verify`. Ver [BACKUP.md](BACKUP.md).
- [x] **Servidor** Backup agendado (`loja-backup.timer`) e teste de restauração no servidor: cópia
      `20261115-123155` conferida e restaurada em banco temporário, 16 tabelas batendo com o manifesto (15/11/2026).
- [x] **Servidor** Cópia cifrada no Google Drive (`loja-cripto:`), enviada e conferida com `cryptcheck`; cópia
      `20261115-123155` baixada do Drive e restaurada com `backup:restore-test` (15/11/2026).
- [x] **Servidor** Fotos pelo computador no servidor: 7,8 MB subiu e 8,2 MB foi recusada com a mensagem do sistema,
      já com a correção do erro 500 acima de 8 MB (14/11/2026). Fotos do teste em `.local/fotos-teste/`.
- [x] **Servidor** Foto de produto tirada pelo celular (botão "Tirar foto"), enviada pelo painel no servidor: 1 foto
      gerou as 3 versões em `storage/` (15/11/2026).
- [x] **Servidor** Depois de `systemctl restart loja-api` as fotos continuam aparecendo na loja e no painel (15/11/2026).
- [x] **Você** Cópias fora do servidor: Google Drive de uma conta da loja, cifradas pelo rclone; retenção de 7 diárias,
      4 semanais e 12 mensais (decidido em 15/11/2026, passo a passo em [BACKUP.md](BACKUP.md)).
- [x] **Servidor** E-mail da loja (passos 1 a 6 de [EMAIL.md](EMAIL.md)): domínio no Postfix, DKIM, DNS na Hostinger,
      script e socket das caixas, `nao-responda@` e `contato@` criadas pelo painel, SMTP no `.env` (14/11/2026).
- [x] **Servidor** `printf '{"acao":"info"}' | sudo -u loja nc -U -N /run/loja-contas-email.sock` mostra só caixas
      `@embalagemcanoinhas.com.br` (nenhuma do portal ou do barbasystem) (14/11/2026).
- [x] **Você** E-mail de teste do painel chega no Gmail com SPF, DKIM e DMARC = PASS ("Mostrar original") (14/11/2026).
- [ ] **Você** Depois de alguns dias sem problema de entrega, trocar o DMARC na Hostinger para `p=quarantine`.
      Em 18/11/2026, mantido em `p=none`. Hotmail rejeitou o IP de saída `187.41.99.91` com `550 5.7.1 S3150` às 17:55 (Brasília). Investigar bloqueio do IP/rede e repetir a entrega antes de endurecer a política.
      Validação em 18/11/2026 às 18:04: mensagem de contato@embalagemcanoinhas.com.br recebida pelo Gmail em 3 s, com SPF PASS (187.41.99.91), DKIM PASS para o domínio da loja e DMARC PASS, mas classificada como spam. PTR/A e HELO coerentes; opendkim-testkey com seletor mail retornou key OK. Entrega em caixa de entrada e desbloqueio S3150 continuam pendentes.
- [x] **Você** "Esqueci minha senha" no painel: o link chega, troca a senha e não funciona uma segunda vez (14/11/2026).
- [x] **Servidor** Webmail `https://webmail.embalagemcanoinhas.com.br` (passo 7 de [EMAIL.md](EMAIL.md)): cadeado,
      marca da loja, login de `contato@` (14/11/2026).
- [x] **Servidor** `webmail.barbasystem.com.br` continua com a marca dele; `certbot renew --dry-run --cert-name
      webmail.embalagemcanoinhas.com.br` sem erro (14/11/2026).
- [x] **Você** Caixa criada pelo painel entra no celular (IMAP 993 e SMTP 587 em `mail.portalplanaltonorte.com.br`),
      envio e recebimento conferidos no app do Gmail (16/11/2026). Atenção: o app preenche sozinho o servidor com o
      domínio da loja e mostra aviso de certificado; apagar e digitar `mail.portalplanaltonorte.com.br` nas duas telas.
- [x] Inspeção visual por captura de tela (painel e loja, desktop e celular): feita em 16/11/2026 no navegador embutido,
      1366 px e 375 px, loja até a tela de dados do checkout (sem fechar pedido) e painel só olhando. Corrigido: nome
      de departamento quebrando a palavra no celular e preço do carrinho em duas linhas (3adf217); prefetch do painel
      estourando o limite do nginx com respostas 429 (3f48328); última coluna das tabelas do painel sem recuo no
      celular (980b0f5). Publicados no servidor com o SGLog Fase 1 em 16/11/2026. Ainda sem dados da empresa: logo "NOME DA LOJA" e rodapé
      pedindo cadastro (preencher em Configuração inicial).

## Pagamento — Mercado Pago (Fase 4)

- [x] **Você** Credenciais de teste configuradas no `.env` em 17/11/2026, conforme confirmação do responsável e testes de pagamento realizados.
- [x] **HTTPS** URL do webhook (`/api/v1/webhooks/mercadopago`) cadastrada no Mercado Pago em modo teste. Em 17/11/2026, o simulador enviou `payment.updated` com `live_mode: false` e recebeu `200 OK`.
- [x] **HTTPS** Pix gerado no checkout em 17/11/2026 às 22:33. A captura do pedido nº 1453 (R$ 1,70) mostra o QR Code e o Pix copia e cola.
- [x] **HTTPS** Pix validado em produção em 18/11/2026: QR Code gerado, pagamento real efetuado e pedido alterado automaticamente para **Pago**, conforme confirmação do responsável.
      O mecanismo da confirmação (webhook ou reconsulta) ainda não foi identificado em log. O cenário completo com credenciais de teste continua sem confirmação.
      Em 17/11/2026, a geração no checkout recebeu `HTTP 500 internal_error` do Mercado Pago (sem causa detalhada). A confirmação do pagamento continua pendente.
      Antes da geração bem-sucedida, houve HTTP 500 também na chamada direta com nome, CPF e e-mail. ID no Mercado Pago: `6d1c6a33-d10a-46cf-abbc-67c97ac70b9e`.
- [x] **HTTPS** Cartão de teste aprovado pelo Card Payment Brick (17/11/2026, 22:26): pedido nº 1451, R$ 1,90.
      A captura do checkout mostra o pedido como **Pago** e a mensagem “Pagamento confirmado. Vamos separar seu pedido.”
- [x] **HTTPS** Cartão de teste em análise pelo Card Payment Brick (17/11/2026): checkout de R$ 8,50 com titular `CONT`
      exibiu “Pagamento em análise pelo Mercado Pago” e permaneceu na etapa de pagamento.
- [x] **HTTPS** Cartão de teste recusado pelo Card Payment Brick em 18/11/2026. Após a publicação de `d73dd65`, o checkout exibiu “O cartão foi recusado. Confira os dados ou tente outro cartão.” com titular `OTHE`.
      A correção permite gravar a recusa quando o provedor devolve um final mascarado. A nova tentativa no mesmo pedido tem seu próprio teste.
- [x] **HTTPS** Nova tentativa de cartão no mesmo pedido após recusa confirmada pelo responsável em 18/11/2026, após a atualização da web para `a802078`.
- [x] **VPS** Webhook repetido e fora de ordem validado em 18/11/2026 no pedido de teste nº 1459. A rota instalada na VPS recebeu avisos simulados e consultou o Mercado Pago. Reconheceu a cópia de `payment.updated` e processou os dois avisos distintos, incluindo o `payment.created` entregue por último. O pedido permaneceu **Pago**, com uma única confirmação no histórico.
- [x] **HTTPS** Webhook do Mercado Pago com assinatura inválida recusado com HTTP 401 em 17/11/2026, às 22:41:44 (horário de Brasília).
- [x] **VPS** Recuperação após falha inicial ao gerar o Pix, em 18/11/2026. No pedido nº 1461, a falha simulada retornou HTTP 502, manteve o pedido aguardando pagamento e registrou a tentativa como erro. Na nova tentativa pelo checkout, o Mercado Pago gerou o Pix para o mesmo pedido.
      Na VPS em 18/11/2026, o primeiro comando parou na validação do link antes de simular a falha. Separadamente, a tentativa pelo checkout às 19:06:40 retornou HTTP 500 no Mercado Pago (create_ti, x-request-id 227e6b04-b564-40e4-a86e-7f9567c39d08).
- [x] **VPS** Recuperação após falha ao consultar um Pix já emitido, em 18/11/2026. No pedido nº 1461, o HTTP 503 simulado preservou o QR Code. A consulta seguinte ao Mercado Pago retornou HTTP 200 (request ID fb4ccfc3-a5ba-4d99-857e-84b71624ad6c). O pedido permaneceu em pending_payment e o Pix em pending.
- [x] **Você** Devolução de Pix em produção confirmada pelo responsável em 18/11/2026.

## NF-e — Focus NFe em homologação (Fase 5)

**Testes fiscais adiados a pedido do responsável da loja em 17/11/2026.**

- [ ] **Você** Conta na Focus, token de homologação no `.env`, certificado A1 enviado à Focus.
- [ ] **Você** Dados reais da empresa no painel (Empresa) e credenciamento na SEF-SC confirmado.
- [ ] **Contador** Regras fiscais por operação validadas; cadastro fiscal dos produtos (NCM, CEST, origem, CST/CSOSN).
- [ ] **Contador** Códigos de pagamento (`17` Pix, `03` cartão), IBS/CBS, rateio de frete, retirada sem endereço,
      política de emissão (manual ou ao pagar).
- [ ] **HTTPS** Cadastrar o gatilho (hook) da Focus apontando para `/api/v1/webhooks/fiscal` com o header
      `X-Fiscal-Webhook-Token` = `FISCAL_WEBHOOK_SECRET`.
- [ ] Emitir nota em homologação: autorizada, XML e DANFE salvos, cliente baixa pela loja.
- [ ] Forçar rejeição (ex.: NCM inválido): nota rejeitada, corrigir, nova tentativa com nova referência.
- [ ] Clique duplo em "Emitir": uma nota só.
- [ ] Derrubar a rede depois do envio: reconsulta recupera a nota sem duplicar.
- [ ] Carta de correção e cancelamento em homologação; arquivos de evento salvos.
- [ ] Inutilização de faixa em homologação.
- [ ] **HTTPS** Aviso da Focus chega e dispara a reconsulta (sem depender do ciclo de 60 s).
- [ ] **Contador** Conferir o DANFE e o XML da nota de homologação; registrar o nome dele na liberação de produção.
- [ ] Importar o XML **real** de uma nota de fornecedor (até agora só XML montado nos testes).

## Central comercial (Fase 6)

- [x] Link `wa.me` do orçamento abre no celular com a mensagem preenchida. Texto e link confirmados pelo responsável
      da loja em 17/11/2026.
- [x] **HTTPS** Link público de orçamento criado manualmente abriu no celular fora do Wi-Fi (17/11/2026).
- [x] **HTTPS** Cliente selecionou o frete, aceitou o orçamento pelo link e gerou o Pix do pedido (17/11/2026).
      O erro observado antes ocorreu em um orçamento de seed, sem causa confirmada.
- [x] **HTTPS** Em 18/11/2026, o orçamento nº 242 gerou o pedido nº 1462. Após o pagamento por Pix, o responsável confirmou que a página do pedido no celular mudou automaticamente para **Pago**.
- [x] **Você** Em 18/11/2026, o responsável confirmou que o balcão precisa registrar pagamentos em dinheiro e na maquininha presencial.
- [ ] **Balcão** Implementar o registro dessas duas formas de pagamento e validar na VPS uma venda em dinheiro e outra paga na maquininha.

## Marketplaces (Fase 7)

Roteiro detalhado em [07-marketplaces.md](07-marketplaces.md) §5. Tudo abaixo foi feito só com o simulado.

- [ ] **Você** Cadastrar o aplicativo no DevCenter do Mercado Livre (PKCE ligado, tópico `orders_v2`) e pôr
      `ML_CLIENT_ID`/`ML_CLIENT_SECRET` no `.env`; conta de vendedor de teste.
- [ ] **Você** Cadastrar o app na Shopee Open Platform (sandbox primeiro: `SHOPEE_API_HOST`/`SHOPEE_AUTH_HOST` do
      sandbox) e pôr `SHOPEE_PARTNER_ID`/`SHOPEE_PARTNER_KEY` no `.env`; loja de teste.
      Em 18/11/2026, o responsável criou a conta de desenvolvedor na Open Platform e informou que ainda não possui loja de vendedor na Shopee. As credenciais e os endereços do sandbox estão ausentes na VPS.
      Testes da Shopee adiados a pedido do responsável: o cadastro de vendedor apresentado solicitou CNPJ, que ele ainda não possui.
- [ ] **HTTPS** URLs de retorno e de aviso cadastradas (`/painel/marketplaces/retorno/{canal}`,
      `/api/v1/webhooks/marketplaces/{canal}`); `SHOPEE_PUSH_URL` idêntica à cadastrada.
- [x] **HTTPS** Em 18/11/2026, o painel mostrou duas contas do Mercado Livre como **Conectada**: a conta real 24176353 e a segunda conta 3857682650, conectada durante o teste do vendedor. Autorizações exibidas até 17/05/2027 às 20:22 e 20:46, respectivamente.
- [ ] **HTTPS** Conectar a conta Shopee pelo painel e conferir a renovação do token nos dois canais (Mercado Livre após 6 h e Shopee após 4 h).
- [x] **HTTPS** Mercado Livre, 18/11/2026: aviso da venda de teste 2000019649740740 recebido às 21:12 para o vendedor 3857682650. Após o HTTP 403 inicial, o responsável confirmou que o pedido apareceu como **Pago** e o saldo disponível diminuiu (saldo inicial 28).
- [ ] **HTTPS** Shopee: confirmar que o aviso de venda de teste chega, o pedido entra pago e o estoque é reservado.
- [ ] **HTTPS** Mesmo aviso reenviado e aviso perdido (tela "Buscar venda"): nada duplica.
- [ ] **HTTPS** Venda cancelada lá: pedido cancelado e reserva devolvida.
- [ ] **HTTPS** Saldo enviado aparece no anúncio (ML sem variação; Shopee com e sem modelo). Conferir a resposta
      real do `update_stock` quando o saldo fica abaixo do reservado pela Shopee.
- [ ] **HTTPS** Push da Shopee com assinatura válida aceito (até agora só a fórmula da documentação foi testada).
- [ ] Conferir os campos reais de `GET /orders/{id}` (ML) e `get_order_detail` (Shopee) com os mapeados no código
      (preço unitário, `variation_id`/`model_id`, status).
- [ ] **Você** + **Contador** Nota fiscal das vendas de marketplace: hoje manual; decidir se integra a API de
      faturamento de cada plataforma (dados do comprador) ou outro caminho.
- [ ] **Você** Anúncios do ML com variação: saldo segue manual; decidir se vale implementar o envio de todas as
      variações juntas.

## WhatsApp e transportadoras (Fase 8)

Roteiro em [08-whatsapp-transportadoras-relatorios.md](08-whatsapp-transportadoras-relatorios.md).

- [x] **WhatsApp real** Funcionamento do atendimento confirmado pelo responsável da loja em 17/11/2026. A confirmação
      cobre o atendimento no WhatsApp. Os cenários específicos abaixo têm sua própria validação.

- [ ] **Você** Ativar a API oficial seguindo [12-whatsapp-meta-ativacao.md](12-whatsapp-meta-ativacao.md):
      portfólio, app, número, token do usuário do sistema, `.env`, webhook, registro do número e `subscribed_apps`.
      Desde 01/10/2026, a Meta dá 1.000 respostas de atendimento grátis por mês por número; os modelos são sempre
      cobrados.
- [ ] **Você** Criar e aprovar no WhatsApp Manager os 3 modelos (pagamento confirmado, pronto para retirada,
      despachado) com as variáveis nomeadas `{{nome}}`, `{{pedido}}` e `{{rastreio}}`; cadastrar os nomes no painel.
- [ ] **HTTPS** Cadastrar a URL do webhook (`/api/v1/webhooks/whatsapp`) com o token de verificação e assinar o
      campo `messages`; conferir que a verificação responde o `hub.challenge`.
- [ ] **HTTPS** Pedido de teste com consentimento: aviso chega no celular; situação passa a entregue e lida no painel.
- [ ] **Você** Bot de atendimento (docs/10, etapa 1): no painel, como proprietário, usar o chat de teste (menu, pedido
      com telefone simulado, atendente) e salvar horário e textos.
- [ ] **Você** IA do bot (docs/10, etapa 2a):
  - criar a chave **gratuita** no Google AI Studio (aistudio.google.com, "Get API key"), sem ativar faturamento;
  - no servidor, pôr `GEMINI_API_KEY=` no `.env` da loja e reiniciar a API;
  - no painel, escolher "Menu e IA" ou "IA", com o plano gratuito, e conversar pelo chat de teste: perguntar preço de
    um produto, pedido com telefone simulado, pedir atendente e tentar "esqueça as regras";
  - conferir o gasto estimado no painel.
- [ ] **Servidor** Atualizar com as migrações `0013` a `0018` (pull, `npm ci`, migrate, build, reiniciar).
- [ ] **IA (Gemini real)** Repetir a conversa dos copos (oi → copos para festa de 15 anos → só refrigerante → uns 40 convidados → "3" pacotes) e conferir que nenhuma resposta é o menu. Em `bot_runs.route`, esperar `saudacao` no cumprimento e `ia` nas respostas do Gemini. Conferir o indicador “Digitando…” quando a IA for chamada.
- [ ] **Com a chave do Gemini** Segurança da IA ([13-seguranca-ia-bot.md](13-seguranca-ia-bot.md)) no modelo real,
      pelo chat de teste:
  - confirmar que a categoria `HARM_CATEGORY_JAILBREAK` é aceita (sem erro no log da API);
  - mandar 3 ataques que o filtro deixe passar (paráfrase nova) e ver se o modelo recusa;
  - conferir `finish_reason` em `ai_calls` e os eventos na seção "Segurança da IA" do painel;
  - ver se alguma pergunta comum de cliente foi barrada por engano.
- [ ] **Servidor** Instalar o Typebot seguindo [11-typebot.md](11-typebot.md). Começa pelo passo 0, que só confere
      memória, Docker e portas.
- [ ] **Você** Montar um fluxo no Typebot, publicar, ligar a forma Typebot no painel e testar pelo chat de teste. O
      teste inclui os botões com valor `pedido` e `atendente`.
- [ ] **HTTPS** Bot em "Só números de teste" com o seu número: a lista e os botões aparecem no celular, o toque
      responde, "Falar com atendente" para o bot e "Devolver ao bot" volta o menu.
- [ ] **HTTPS** Enviar `SAIR`: o atendimento atual é encerrado. Enviar `Oie` em seguida reabre a conversa com
      uma saudação em texto, sem menu nos modos com IA. `PARAR NOTIFICAÇÕES` interrompe os avisos automáticos
      de pedidos e mantém o atendimento disponível.
- [ ] **HTTPS** Mensagem do cliente → resposta pelo painel dentro de 24 h; depois de 24 h o painel bloqueia.
- [ ] Conferir com respostas reais os campos usados do webhook (status, erros) e a recusa de modelo inexistente.
- [ ] **Você** Conta no Melhor Envio (sandbox primeiro): gerar o token e pôr `MELHOR_ENVIO_TOKEN` e
      `MELHOR_ENVIO_USER_AGENT` (nome do app e e-mail técnico, exigido pela API) no `.env`; `MELHOR_ENVIO_SANDBOX=false`
      só em produção.
- [ ] **Você** Confirmar como o token é renovado (não achado na documentação pública) e a validade dele.
- [ ] Cotação real: conferir `custom_price`/`custom_delivery_time` e serviços indisponíveis com o CEP da empresa.
- [ ] **Você** Escolher os serviços de transportadora que a loja oferece e cadastrar o CEP da empresa; preencher
      peso e medidas das variações (sem eles a opção não aparece).
- [ ] **Você** Decidir como comprar o frete e gerar etiqueta (hoje fora do sistema). Fase 8: compra pelo sistema pronta e bloqueada; veja a seção da Fase 8 no fim.

## Auditoria de novembro de 2026 ([AUDITORIA-2026-11.md](AUDITORIA-2026-11.md))

- [x] **Servidor** Auditoria do servidor (14/11/2026): ver seção 3.3 do relatório.
- [x] **Servidor** Permissões das cópias de backup e da `.local` (14/11/2026).
- [x] **Servidor** Pasta `storage/` em 750, `UMask=0027` na API e reinício com o kernel novo (14/11/2026).
- [ ] **Você** SSH só com chave e sem senha para o root (testar a chave numa segunda janela antes).
- [x] **Servidor** Atualizações de segurança aplicadas e servidor reiniciado (14/11/2026).
- [x] **Servidor** Limite por IP (`00-loja-limites.conf`) e `server_tokens off` instalados e conferidos (14/11/2026).
- [ ] **Servidor** Carga no VPS de outra máquina, fora do horário de movimento: `fumaca` e depois `inicial`
      ([tests/carga/README.md](../tests/carga/README.md)), com `vmstat -w 2` aberto no servidor. Anotar p95 e CPU.
- [x] **HTTPS** CSP no painel e na loja, HSTS e `X-Frame-Options` pelo nginx (14/11/2026).
- [ ] **Você** Sandbox do Mercado Pago: anotar os domínios que o SDK carrega e então fechar a CSP da loja
      (`script-src`, `connect-src`, `frame-src`).
- [ ] **Você** Lighthouse de novo com o catálogo e as fotos reais (LCP passa a ser a foto).
- [ ] **Você** Logotipo definido → `favicon` (hoje 404 no console).
- [ ] **Você** Retenção de sessões vencidas e carrinhos abandonados; monitor externo de disponibilidade.
- [ ] **Você** Tornar o repositório do GitHub privado.

## Lançamento

- [x] **Servidor** Unidades do systemd (inclusive `loja-db`) voltaram sozinhas depois do reinício do VPS (14/11/2026).
- [x] **HTTPS** IP real do cliente na Auditoria (nginx sobrescrevendo `X-Forwarded-For` + `TRUST_PROXY=1`) (14/11/2026).
- [x] **Servidor** `loja-backup.timer` gerou a cópia da madrugada (14/11/2026, 03:30).
- [x] **Você** Cópia dos backups para fora do servidor: Google Drive cifrado, toda madrugada (15/11/2026).
- [x] **Servidor** Envio de foto de 8 MB pelo painel passando por nginx e Next (14/11/2026).
- [x] **Você** Provedor de e-mail: servidor próprio do VPS, sem custo (14/11/2026). Ver [EMAIL.md](EMAIL.md).
- [ ] **Você** E-mails para clientes da loja (recuperação de senha do cliente, avisos de pedido): ainda não existem.

- [ ] **Servidor** `demo:seed` e `demo:reset` no banco de produção (ver [DEMONSTRACAO.md](DEMONSTRACAO.md)); a
      reversão roda **antes** da primeira nota de homologação e do catálogo real.
- [ ] **Você** Nome, logotipo, fotos, textos de trocas e privacidade, formas de entrega reais.
- [ ] **Você** + **Contador** Liberar produção fiscal no painel só depois de tudo acima.

## Importação de produtos por planilha ([14-importacao-produtos.md](14-importacao-produtos.md))

- [ ] **Servidor** Publicar (roteiro de [IMPLANTACAO.md](IMPLANTACAO.md)): `npm run backup`, `git pull`, `npm ci`, `npm run migrate` (aplica a `0019_importacao_produtos`),
      `npm run build -w apps/api && npm run build -w apps/web`, `sudo systemctl restart loja-api loja-web`.
- [ ] **Você** Conferir as telas no painel (não verificadas no navegador durante o desenvolvimento): baixar o modelo,
      abrir no Excel (listas suspensas de categoria, unidade e status; aba Instruções), enviar com 2 ou 3 produtos,
      corrigir uma linha na prévia, decidir uma categoria nova, confirmar e baixar o relatório.
- [ ] **Servidor** Envio de uma planilha perto de 5 MB passando por nginx e Next (limite de upload do proxy).
- [ ] **Você** Testar a planilha aberta e salva no LibreOffice e no Google Planilhas (exportada como .xlsx).
- [ ] **Você** Fotos em lote pelo SKU numa importação real (nomes de arquivo iguais aos SKUs).
- [ ] **Você** Gerente ou funcionário que for importar: ativar a verificação em duas etapas (a permissão exige).

## SGLog Fase 1 — depósitos e conferência do estoque ([15-sglog-fase1.md](15-sglog-fase1.md))

Implantação **só com autorização expressa**. Testado localmente em 16/11/2026: suíte 304/304 e ensaio com dados de
demonstração (bloqueio de 120 a 168 ms, 0 divergência e reversão com o histórico idêntico). Auditoria de prontidão
na mesma data: deadlock da primeira versão corrigido; checklists de implantação, validação e reversão em
[15-sglog-fase1.md](15-sglog-fase1.md). Enviado ao GitHub em 16/11/2026 (`b5ff9f2`); roteiro de implantação com pontos
de parada em [16-sglog-fase1-implantacao.md](16-sglog-fase1-implantacao.md).

- [x] **Servidor** Etapa 0 do roteiro (diagnóstico só leitura), 16/11/2026: `cac8397` no ar, banco `loja_prod`
      (19 MB), 81 GB livres, serviços ativos, prévia da diferença herdada = 0.
- [x] **Servidor** Última migration em produção: `0019_importacao_produtos` (15/11/2026). Etapa A dispensada.
- [x] **Servidor** Espaço em disco: 81 GB livres para 74 MB de `.local/pgdata` (16/11/2026).
- [x] **Servidor** Ensaio `backup:migrate-rehearsal` com a cópia `backups/sglog/20261116-190053` (16/11/2026): só a
      0020, bloqueios em 0 ms (0 tentativas), saldo bloqueado 32 ms, 204 variantes, 0 diferença herdada, 0 divergência.
- [x] **Você** Diferença herdada: não houve (0), nada a decidir.
- [ ] **Servidor** `.env` do servidor: `DB_NAME_TEST` ausente ou apontando para banco `_test` (os testes não rodam
      no servidor; a trava recusa banco sem a marca de testes de qualquer forma).
- [x] **Servidor** Depois da migration real: etapa F `RESULTADO: OK` (16/11/2026), repetida depois de um ajuste +1/−1
      no painel: depósito `PRINCIPAL`, saldo total = soma dos depósitos, 204 variantes conferidas, 0 divergência.
- [ ] **Você** Criar um usuário de cada papel novo e conferir, com login próprio, o menu e as recusas (já com as
      permissões de fornecedores da Fase 2). Os 3 papéis aparecem no cadastro (16/11/2026). Roteiro:

      | Papel | Menu esperado | Pode | Não pode (recusa ou sem botão) |
      |---|---|---|---|
      | Gerente de logística | Configuração inicial, Pedidos, Produtos, Categorias, Estoque, Inventário, Compras, Reposição, Fornecedores, Formas de entrega | Lançar ajuste no estoque; ver pedidos, compras e fornecedores | Cancelar pedido; criar pedido de compra; editar fornecedor; `/painel/vendas`, `/painel/usuarios` |
      | Comprador | Configuração inicial, Produtos, Categorias, Estoque, Inventário, Compras, Reposição, Fornecedores | Criar pedido de compra; editar fornecedor e oferta | Lançar ajuste no estoque; `/painel/pedidos`, `/painel/vendas` |
      | Financeiro | Configuração inicial, Pedidos, Compras, Reposição, Fornecedores, Formas de entrega, Vendas, Relatórios de estoque | Ver pedidos, compras, fornecedores e vendas | Criar pedido de compra; editar fornecedor; cancelar pedido; `/painel/estoque`, `/painel/produtos` |

      Depois do teste, desativar os 3 usuários (não excluir).
- [x] **Navegador** Loja em 375 px (navegador embutido, 16/11/2026): sem rolagem lateral; menu Departamentos com
      cada nome numa linha; preço do item do carrinho numa linha.
- [ ] **Você** Painel em 375 px (precisa do login): no Chrome, F12 e Ctrl+Shift+M (modo dispositivo, 375 px), ou no
      celular. Conferir Estoque, Compras e Fornecedores: última coluna das tabelas com recuo e sem rolagem da página.
- [ ] **Você** (máquinas de desenvolvimento) Rodar `npm run migrate:test` uma vez para gravar a marca do banco de
      testes; sem ela a suíte se recusa a rodar.

Acompanhamento passo a passo da validação no servidor: seção seguinte.

## SGLog — Fase 1: implantação no servidor

**Situação: IMPLANTADA em 16/11/2026** (`b5ff9f2`, 0020 aplicada às 19:05 UTC). A VPS é ambiente de testes com
HTTPS, sem operação comercial; o roteiro foi encurtado com a sua autorização: sem a pasta de trabalho da etapa C (o
ensaio rodou da própria pasta, antes do build) e sem `npm ci` (`package-lock.json` igual entre `cac8397` e `b5ff9f2`).

| # | Situação | Atividade | Data | Resultado | Evidência | Observações |
|---|---|---|---|---|---|---|
| 1 | [x] | **Servidor** Etapa 0, só leitura | 16/11/2026 | OK | Saída na conversa | 2 arquivos não rastreados na pasta: `.env.antes-dominio` (0600) e `embalagemcanoinhas.inc.php,` (vazio, root). 5 pastas de backup de 14/11 são do root (a retenção do `loja` as ignora). `.git` com escrita para o grupo |
| 2 | [x] | **Servidor** Commit e última migração | 16/11/2026 | OK | `cac8397`; `0019_importacao_produtos` | |
| 3 | [x] | **Servidor** Disco, serviços, reservas, pedidos, papéis | 16/11/2026 | OK | 81 GB livres; `/ready` ok; 77 reservas ativas; 449 pedidos | Portas 54330, 4010 e 3047 só em 127.0.0.1 |
| 4 | [x] | **Servidor** 0019 aplicada | 16/11/2026 | OK | 15/11/2026 12:33 | Etapa A dispensada |
| 5 | [x] | **Servidor** Prévia da diferença herdada | 16/11/2026 | OK | 0 variantes, 0 unidades | |
| 6 | [x] | **Servidor** Pasta de trabalho da etapa C | 16/11/2026 | N/A | — | Dispensada: ensaio rodou da pasta do sistema, código atualizado e serviços ainda no build antigo |
| 7 | [x] | **Servidor** Backup e restauração isolada | 16/11/2026 | OK | `backups/sglog/20261116-190053` | 16 tabelas batendo com o manifesto. A cópia foi feita como root e teve o dono trocado para `loja` |
| 8 | [x] | **Servidor** Ensaio da 0020 (`loja_ensaio`) | 16/11/2026 | OK | Saída na conversa | Banco temporário apagado pelo script |
| 9 | [x] | **Servidor** Bloqueio, divergências, diferença herdada, C1–C5 | 16/11/2026 | OK | Ensaio: 0 ms / 32 ms; real: 0 ms / 154 ms | 204 variantes, 0 diferença, 0 divergência |
| 10 | [x] | **Você** Autorização | 16/11/2026 | OK | Na conversa | Backup do instante anterior: `backups/sglog/20261116-190552`. Versão anterior em `~/antes-sglog-fase1.txt` (`cac8397`) |
| 11 | [x] | **Servidor** + **Você** Validação (etapa F) | 16/11/2026 | OK | Etapa F `RESULTADO: OK` duas vezes; navegador | Painel: estoque e ajuste +1/−1 com motivo. Loja: busca, produto e carrinho sem erro no console. Papéis novos no cadastro. Falta: menus de cada papel novo com login próprio, e a loja no celular |

Pendências de manutenção encontradas (nenhuma bloqueia; cada uma em passo separado, com autorização):

- [ ] `backups/sglog/` (4 cópias de 16/11) fica fora da retenção automática e do envio ao Drive: apagar à mão quando
      não for mais preciso.
- [ ] Arquivo vazio `embalagemcanoinhas.inc.php,` (root) e `.env.antes-dominio` na pasta do sistema: decidir o destino.
- [ ] 5 pastas de backup de 14/11 com dono root: trocar o dono para `loja` ou apagar.
- [ ] `loja-web` termina com status 143 ao parar (SIGTERM do Next) e o systemd registra como falha; só cosmético.
      Ajuste possível: `SuccessExitStatus=143` em `deploy/systemd/loja-web.service`.
- [ ] Reiniciar serviços sempre como root: como `loja`, o polkit pede a senha e a conexão D-Bus cai no meio.

## SGLog Fase 2 — Gestão de Fornecedores ([18-sglog-fase2.md](18-sglog-fase2.md))

**Situação: IMPLANTADA em 16/11/2026** (merge `0ccdc74`, 0021 aplicada às 20:14 UTC, serviços reiniciados às 20:15).
Integração: `sglog/fase2` com `--no-ff` na `main`, sem conflito; suíte 361/361, typecheck e builds; push
`b5ff9f2..0ccdc74`. Versão anterior em `~/antes-sglog-fase2.txt` (`b5ff9f2`); backup anterior à migração em
`backups/sglog/20261116-201408`.

**Validação funcional: CONCLUÍDA em 16/11/2026, no ambiente HTTPS, com ressalvas.** Ficam com você: o login dos 3
papéis novos (Gerente de logística, Comprador, Financeiro) e o painel em 375 px, na seção da Fase 1, e o
cancelamento do rascunho nº 85, abaixo.

- [x] **Servidor** Código `b5ff9f2` → `0ccdc74` por fast-forward; `package-lock.json` igual (sem `npm ci`) (16/11/2026).
- [x] **Servidor** Relatório de códigos (`node scripts/fornecedores-codigos.mjs`): 274 ofertas, 0 duplicados, 0 vazios,
      0 avisos, saída 0 (16/11/2026).
- [x] **Servidor** Ensaio da 0021 na cópia: só a 0021, bloqueio 0 ms, 7 fornecedores, 274 ofertas, 61 variantes com
      mais de um fornecedor, estoque 204 variantes e 0 divergência (16/11/2026).
- [x] **Servidor** 0021 em `loja_prod`: bloqueio 1 ms, mesmo resumo do ensaio; builds e reinício sem erro; `/ready` ok.
- [x] **Servidor** Conferência final: última migração 0021, 7 fornecedores, 274 ofertas, 274 linhas de histórico de
      custo, estoque com 0 divergência (16/11/2026).
- [x] **Navegador** Painel → Fornecedores: lista com os 7 e os indicadores; ficha com as 5 abas (visão geral,
      cadastro, produtos e embalagens, disponibilidade, histórico) carregando, sem erro no console (16/11/2026).
- [x] **Navegador** Observação da Distribuidora Alfa alterada e salva ("Fornecedor salvo."), depois devolvida ao
      texto original e salva de novo (16/11/2026).
- [x] **Navegador** Comparação na Forminha de papel nº 3 (FRM-3-BRA, 5.000 UN): sugere a Embalagens Eta, Alfa em 2º,
      com o motivo explicado (16/11/2026).
- [x] **Navegador** Rascunho nº 83: "Comparar fornecedores" na edição mostra os fornecedores e o "neste pedido";
      edição fechada sem salvar, pedido intacto (16/11/2026).
- [x] **Navegador** Mínimo no pedido de compra (16/11/2026): oferta SKL-20X29 da Distribuidora Alfa com mínimo
      temporário de 5; pedido novo com 1 embalagem recusado sem justificativa ("Há itens abaixo do mínimo…") e aceito
      com ela (rascunho nº 85, justificativa no item). Mínimo restaurado para vazio (custo, data e prazo intactos). O
      nº 84 foi consumido pela tentativa recusada.
- [ ] **Você** Cancelar o rascunho de teste nº 85 ("PEDIDO DE TESTE SGLog") em Compras → nº 85 → Cancelar.
      Fica pendente até você confirmar o cancelamento.
- [ ] **Você** Opcional: marcar o fornecedor principal das 61 variantes com mais de um fornecedor; sem isso a escolha
      segue o critério automático (custo por unidade, depois prazo).

## SGLog Fase 3 — estoque por depósito ([20-sglog-fase3.md](20-sglog-fase3.md))

**Situação: IMPLANTADA em 16/11/2026** (merge `78ea278`, push `0ccdc74..394e0ab`, 0022 aplicada às 22:07).
Roteiro em [21-sglog-fase3-implantacao.md](21-sglog-fase3-implantacao.md). Versão anterior em
`~/antes-sglog-fase3.txt` (`0ccdc74`).

**Validação funcional: ENCERRADA em 16/11/2026, com ressalvas.** Movimentações aprovadas no navegador, 0022 aplicada
e C1–C7 com 0 divergência. Continuam pendentes:

- a MFA do gerente;
- a solicitação de ajuste com dois usuários (Estoquista e Gerente);
- os 3 papéis da Fase 1, o painel a 375 px da Fase 1 e o rascunho nº 85 da Fase 2, nas seções acima;
- o teste opcional num celular de verdade.

Os testes aprovados não se repetem.

Resultados antes da implantação: suíte 381/381 depois do merge, typecheck e builds sem erros, e a 0022 aplicada sobre
o banco de teste na 0021.

- [x] **Servidor** Conferência rápida (16/11/2026):
  - `0ccdc74` no ar, `git status` limpo, só os 2 arquivos não rastreados já conhecidos;
  - última migração `0021_sglog_fornecedores`;
  - 81 GB livres.
- [x] **Servidor** MFA nos papéis de estoque (16/11/2026): os 2 proprietários com MFA; gerente e estoquista sem.
- [x] **Servidor** Backup `backups/20261116-220516`, conferido.
- [x] **Servidor** Ensaio da 0022 na cópia:
  - só a 0022;
  - bloqueios em 1 ms, saldo travado 75 ms;
  - 1 depósito, 204 linhas de saldo, 2 contagens no padrão;
  - conferência com 204 variantes e 0 divergência.
- [x] **Servidor** Backup do instante `backups/20261116-220722`, conferido.
- [x] **Servidor** 0022 em `loja_prod`: bloqueios em 1 ms, saldo travado 71 ms, mesmo resumo do ensaio.
- [x] **Servidor** Builds da API e da web sem erro. Reinício como root: `active`/`active` e `/ready` ok.
- [x] **Servidor** Etapa F estendida: `RESULTADO: OK`.
  - Última migração `0022_sglog_estoque`, só o `PRINCIPAL`.
  - Os 5 saldos com total = soma dos depósitos: disponível 226.455, reservado 13.976; bloqueado, avariado e em
    trânsito em zero.
  - 0 negativos; C1–C7 com 204 variantes e 0 divergência.
  - Log da API sem erros.

Pendente com você:

- [ ] **Você** Ativar a verificação em duas etapas do gerente (Painel → Minha conta). Sem ela, ele não faz ajuste
      direto, estorno, extravio, cancelamento de transferência nem cadastro de depósito.
- [ ] **Você** Combinar quem aprova as solicitações de ajuste do Estoquista. Hoje são os 2 proprietários, que têm MFA.

No painel, com HTTPS:

- [x] **Navegador** Menu LOGÍSTICA (16/11/2026, proprietário com MFA): Estoque, Inventário, Transferências, Depósitos,
      Compras, Reposição e Fornecedores abrem nas URLs de antes, sem erro no console. Alertas e Solicitações também
      abrem, vazias.
- [x] **Navegador** Depósitos (16/11/2026):
  - `TESTE-F3` cadastrado com MFA;
  - a desativação com mercadoria chegando foi recusada (`WAREHOUSE_IN_USE`);
  - depois de esvaziado, foi desativado sem erro.
- [x] **Navegador** Transferência (16/11/2026, GDN-20X23-BRA):
  - envio de 3 UN para o `TESTE-F3` (doc. TESTE-F3-1): o padrão caiu para 11.597 e o destino mostrou 3 chegando, fora
    do vendável;
  - recebimento parcial de 2 e devolução de 1 com motivo: "Encerrada com divergência", e o 1 voltou ao padrão;
  - receber de novo foi recusado (`TRANSFER_CLOSED`), e enviar 5 com só 2 livres também (`INSUFFICIENT_STOCK`);
  - devolução dos 2 ao padrão com "Já receber agora" (doc. TESTE-F3-2): recebida na hora.
- [x] **Navegador** Bloqueio no GDN-20X23-BRA (16/11/2026): bloquear 1 UN levou o vendável de 11.600 a 11.599 e o
      bloqueado a 1; liberar voltou a 11.600 e 0.
- [x] **Navegador** Avaria no GDN-20X23-BRA (16/11/2026): separar 1 UN levou o vendável de 11.600 a 11.599 e o
      avariado a 1; recuperar voltou a 11.600 e 0.
- [x] **Navegador** Estorno no GDN-20X23-BRA (16/11/2026):
  - o ajuste +1 (#2930) levou o saldo a 11.601;
  - o estorno (#2931) voltou a 11.600, e a linha original ficou "Estornado", sem o botão;
  - um segundo estorno do mesmo lançamento foi recusado (`ALREADY_REVERSED`).
- [ ] **Navegador** Testar a solicitação de ajuste:
  - o Estoquista pede uma perda;
  - o gerente com MFA aprova ou recusa;
  - quem pediu não consegue aprovar.
  
  Precisa do login de dois papéis, junto com os testes de papéis pendentes da Fase 1.
- [x] **Navegador** Alertas no `TESTE-F3` (16/11/2026):
  - mínimo 5 e máximo 10 com 2 UN: alerta de abaixo do mínimo;
  - mínimo 5 com máximo 3: recusado (`INVALID_RANGE`);
  - só máximo 1: alerta de acima do máximo, listado em Estoque → Alertas;
  - os limites foram apagados no fim.
- [x] **Navegador** Inventário (16/11/2026):
  - com o padrão selecionado, "Abrir contagem" não aparece, porque ele já tem a contagem aberta da demonstração;
  - contagem aberta no `TESTE-F3` (201 itens), com 2 contados para o GDN-20X23-BRA e fechada sem diferença nem reserva
    descoberta;
  - a contagem do padrão continuou aberta, com 7 de 12 itens contados.
- [x] **Navegador** Loja (16/11/2026): busca "guardanapo", página do produto e carrinho sem erro; o item de teste foi
      tirado do carrinho em seguida.
- [x] **Navegador** Checkout (16/11/2026): `/finalizar` abre sem erro no console, com o resumo do carrinho. Parei antes
      de preencher dados e de fazer o pedido.
  - O estoque da loja é o total (`on_hand − reserved` de `stock_balances`), como previsto no [requisito
    10](20-sglog-fase3.md). Com 2 UN no `TESTE-F3`, a loja mostrou 232 pacotes de 50 (11.600), e não 231.
  - A venda baixa do padrão. Se faltar mercadoria nele, a venda é recusada com o nome do depósito.
- [x] **Navegador** Telas novas a 375 px (16/11/2026, aba do Chrome com simulação de 375 × 824):
  - Estoque, detalhe do produto, Alertas, Solicitações, Depósitos, Transferências, nova transferência, detalhe da
    transferência, Inventário, contagem e `/finalizar`;
  - nenhuma passa da largura da tela (`scrollWidth` 375), e as tabelas largas rolam dentro do próprio quadro.
- [ ] **Celular** Conferir num aparelho de verdade, junto com o teste de 375 px pendente da Fase 1 (opcional).

Depois dos testes:

- [x] **Navegador** Depósito de teste desativado (16/11/2026), depois de devolvido o saldo. No fim, o padrão tem
      disponível 226.455 e reservado 13.976, os mesmos da etapa F. O GDN-20X23-BRA voltou a 11.600.
- [x] **Servidor** Bloco 5.1 de [21-sglog-fase3-implantacao.md](21-sglog-fase3-implantacao.md) de novo, depois dos
      testes (16/11/2026): `RESULTADO: OK`.
  - `TESTE-F3` inativo, 2 transferências, 0 solicitação.
  - Os 5 saldos com total = soma dos depósitos, iguais aos da etapa F.
  - 0 negativo; C1–C7 com 204 variantes e 0 divergência.

## SGLog Fase 4 — alocação dos pedidos ([23-sglog-fase4.md](23-sglog-fase4.md))

**Situação: implantada na VPS de testes em 20/11/2026, commit `7d2ae42`.** Roteiro em
[24-sglog-fase4-implantacao.md](24-sglog-fase4-implantacao.md). A alocação automática fica desligada
(`ALLOCATION_AUTO` ausente) até esta validação terminar.

Implantação em 20/11/2026:

- Backups `20261120-132859` e `20261120-133128`, ambos conferidos.
- Ensaio da 0023 na cópia: 0 ms de espera pelos bloqueios e 80 ms de bloqueio. Mostrou 29 pedidos em aberto aguardando alocação, 399 encerrados com situação logística, 76 reservas no depósito padrão e 0 divergências.
- Migração no banco real com os mesmos números, 174 ms de bloqueio.
- Builds da API e da web sem erro, serviços `active`, `/ready` respondendo `{"ok":true}` e log sem erros.
- Bloco 5.1 depois do reinício: `RESULTADO: OK`. C1–C9 sem divergência nas 204 variantes, 0 reservas ativas sem depósito e dropshipping `blocked`.

Validação pelo painel HTTPS, depois da implantação:

- [x] **Fila.** Logística → Alocação abre a 375 px sem rolagem lateral. Mostra:
  - os contadores;
  - "Alocação automática desligada";
  - os pedidos que estavam em aberto como "Aguardando alocação" ou "Em análise", com o motivo.

  Em 20/11/2026, no Chrome a 375 px: 0 em análise, 29 aguardando e 0 alocados, com a alocação automática desligada. O detalhe da alocação, a página do pedido e a busca da loja também abriram sem rolagem lateral.
- [x] **Pedido antigo.** Um pedido em aberto antes da atualização despacha como antes, sem pedir alocação.
  Em 20/11/2026, o pedido nº 1421 mostra o bloco "Alocação", sem o aviso de alocação obrigatória. O despacho está bloqueado só pela NF-e, como antes da atualização, porque o fiscal não está configurado.
- [ ] **Pedido novo, caso simples.** Pagar um pedido de teste e abrir o bloco "Alocação". Conferir:

  Parcial em 20/11/2026, feito no pedido de demonstração nº 1421, com pagamento simulado:
  - a recomendada foi "Estoque próprio — Depósito principal", confirmada sem pedir motivo;
  - o selo passou a "Alocado" e a reserva a "BIC-21: 3 no Depósito principal";
  - o histórico ganhou um único registro;
  - a fila passou a 28 aguardando e 1 alocado;
  - o bloco 5.1 seguinte deu C1–C9 sem divergência, com 1 atendimento e 1 decisão.

  Falta o pedido novo pago. Sem pagamento real, o único caminho é uma venda de teste do Mercado Livre, que depende da
  conta de teste. Fica pendente. O aviso e a liberação do despacho só podem ser vistos com a NF-e autorizada ou dispensada, porque a trava da alocação vem depois da trava da NF-e.

  Conferir num pedido novo:
  - a recomendada é "Estoque próprio — Depósito principal";
  - o despacho fica bloqueado com o aviso antes de confirmar;
  - confirmar não pede motivo;
  - o selo muda para "Alocado" e as reservas aparecem "no Depósito principal";
  - o despacho é liberado.
- [x] **Outra opção e troca.** Com um segundo depósito cadastrado e com saldo, escolher a opção não recomendada.
  - Sem motivo, a tela recusa.
  - Com motivo, a origem muda e o histórico mostra "Origem trocada" com o motivo.

  Em 20/11/2026, no pedido nº 1421 (BIC-21, 3 un.), com o depósito de teste TESTE-F3 abastecido pela transferência
  nº 3. A troca para o TESTE-F3 foi feita com motivo e o histórico mostrou "Origem trocada". A recusa sem motivo não
  foi conferida na tela; ela é coberta pelo teste automatizado (`JUSTIFICATION_REQUIRED`). Saldos de BIC-21:
  - antes: PRINCIPAL 38 físico / 8 reservado;
  - depois da troca: PRINCIPAL 35/5 e TESTE-F3 3/3.
- [x] **Desfazer.** Desfazer pede motivo. A reserva continua com o pedido ("sem alocação") e o pedido vai para "Em
  análise".
  Em 20/11/2026, no mesmo pedido: depois de desfazer, os saldos não mudaram e a reserva de 3 ficou "sem alocação"
  no TESTE-F3. O pedido foi realocado no PRINCIPAL (35/8 e TESTE-F3 3/0) e a mercadoria voltou pela transferência
  nº 4. Situação final igual à de antes: BIC-21 com 38/8, só no PRINCIPAL, e TESTE-F3 desativado. Histórico do
  pedido: confirmada 10:46, trocada 11:05, desfeita 11:05, confirmada 11:06.
- [x] **Encomenda.** Num produto sob encomenda com fornecedor e falta de estoque:
  - a proposta mostra parte em estoque e parte "Encomenda ao fornecedor";
  - depois de confirmar, a reserva da parte encomendada aparece "aguardando mercadoria";
  - o despacho só passa depois da entrada da mercadoria.

  Parcial em 20/11/2026, no pedido de demonstração nº 1436 (POT-150, 25 un.), depois da falta descoberta abaixo. A
  proposta mostrou "Estoque do Depósito principal + encomenda ao fornecedor": 20 em estoque e 5 por encomenda à
  Embalagens Exemplo Eta. **Confirmar deu "Erro interno"** (HTTP 500), duas vezes, sem mudar nada. É o defeito
  registrado em "Problema encontrado" abaixo.

  Retestado em 20/11/2026, depois da implantação de `d3c15f6`, no pedido de demonstração nº 1426 (FRM-4-VER, 300 un.):
  - antes: pedido aguardando alocação, reserva de 300 sem alocação, PRINCIPAL 4400 físico / 400 reservado;
  - alocado no estoque próprio às 11:42;
  - Perda de teste de 4150 (PRINCIPAL 250/400): o pedido voltou para "Em análise" com "Falta descoberta";
  - a proposta passou a 150 em estoque + 150 por encomenda à Distribuidora Exemplo Alfa;
  - "Confirmar alocação" funcionou, sem erro. O atendimento anterior ficou encerrado com o motivo da análise;
  - o painel mostrou "150 no Depósito principal · aguardando mercadoria" e "150 no Depósito principal";
  - o total reservado continuou 400, sem reserva duplicada, e o pagamento seguiu "Aprovado";
  - histórico: confirmada 11:42, falta 11:43, confirmada 11:43.

  Restauração:
  - perda estornada com Ajuste de entrada de 4150 (PRINCIPAL 4400/400, como antes);
  - origem trocada de volta para estoque próprio, com motivo: uma reserva firme de 300 e decisão `change`;
  - o pedido nº 1426 ficou alocado ("Alocado"), em vez de "Aguardando alocação".

  O despacho depois da entrada da mercadoria continua dependente da NF-e e fica para o teste de despacho.
- [x] **Cancelar pedido alocado.** A reserva volta para o disponível e o histórico mostra "Pedido cancelado". O estorno
  no Mercado Pago continua manual, como antes.
  Em 20/11/2026, no pedido nº 1436, que estava em análise com o atendimento da alocação ainda confirmado:
  - pedido "Cancelado", com o aviso de devolução manual pelo Mercado Pago (o pagamento era simulado, nada foi
    devolvido);
  - atendimento encerrado com "Pedido cancelado", nenhuma reserva ativa e "25 · liberado" no pedido;
  - decisões: manual, shortage e order_canceled;
  - POT-150 passou de PRINCIPAL 20 físico / 25 reservado para 20/0.
- [x] **Falta descoberta.** Contar a menos, no inventário, um item reservado para pedido alocado. O pedido volta para
  "Em análise" com "Falta descoberta".
  Em 20/11/2026, no pedido nº 1436, alocado no PRINCIPAL às 11:07, com POT-150 em 300 físico / 25 reservado. O
  inventário não pôde ser aberto, porque há uma contagem de demonstração em aberto no PRINCIPAL desde 13/11 (só uma
  por depósito), que foi preservada. A falta foi produzida por uma saída de Perda de 280 (20/25):
  - o pedido voltou para "Em análise" com "Falta descoberta: POT-150 no depósito Depósito principal (físico 20.000,
    reservado para pedidos 25.000)";
  - nada foi cancelado nem liberado;
  - antes, "Separar como avariado" 280 foi recusado ("livre … 275, pedido 280"), como previsto.

  A perda foi estornada depois com um Ajuste de entrada de 280. POT-150 terminou com PRINCIPAL 300/0 (os 25 eram do
  pedido nº 1436, cancelado acima).
- [x] **Dropshipping.** Aparece "Bloqueado". Só o proprietário ou o gerente com MFA vê o campo para liberar. **Não
  liberar** antes da validação fiscal.
- [ ] **Permissões.**
  - Estoquista e comprador veem a fila e o detalhe, sem os botões.
  - Financeiro não vê o menu.
  - Vendas não vê custo de fornecedor.

  Pendente: precisa entrar com um usuário de cada perfil. Não há usuários de teste de comprador, financeiro nem
  logística.
- [x] **Banco.** O bloco 5.1 do roteiro, rodado de novo, dá `RESULTADO: OK`, com C1–C9 sem divergência.
  Em 20/11/2026, depois da alocação do pedido nº 1421: C1–C9 sem divergência nas 204 variantes, com 1 atendimento e 1 decisão. A versão daquele dia do script acusava `PARAR` para o pedido alocado (`processing`); o roteiro foi corrigido para aceitar essa situação.
- [x] **Problema encontrado (20/11/2026): realocar depois de falta descoberta dá erro 500.** Depois da falta, o pedido
  vai para "Em análise", mas o atendimento da alocação anterior continua confirmado:
  - "Confirmar alocação" trata o caso como alocação nova, porque o pedido não está em `processing`. Não encerra o
    atendimento anterior, e a trava `fulfillment_allocations_over` recusa passar da quantidade vendida. A API devolve
    500 em vez de uma mensagem.
  - "Desfazer" recusa com "O pedido não tem alocação confirmada em aberto", porque exige `processing`.
  - Na prática, o pedido fica sem saída pela alocação. Só o cancelamento do pedido encerra o atendimento.

  Reproduzido no teste local, com o caso "perda que descobre a reserva" seguido de uma nova confirmação: 500
  `INTERNAL_ERROR`. Precisa de correção no código antes de ligar `ALLOCATION_AUTO`. Até lá, não usar a alocação nos
  pedidos que voltarem com "Falta descoberta".

  Corrigido no commit `b80d6b1` (ainda não implantado). A nova confirmação encerra o atendimento anterior com o motivo
  da análise e grava o novo. Os testes automatizados conferem:
  - a realocação depois da falta, com estoque e encomenda;
  - a repetição da mesma chave, sem agir de novo;
  - que o pagamento continua aprovado;
  - que uma falha no meio desfaz tudo, com o atendimento, a alocação e as reservas anteriores intactos;
  - a realocação no mesmo depósito, que reaproveita a reserva sem duplicar;
  - C1–C9 sem divergência.

  Sem a correção, os três casos de realocação depois da falta falham. A encomenda em pedido nunca alocado passa com ou
  sem ela, inclusive com produto de pronta entrega. O erro 500 do pedido nº 1436 veio do atendimento anterior, não da
  encomenda. Suíte da API: 416 testes passando.

  Implantado na VPS em 20/11/2026: `d3c15f6`, com o backup `20261120-143652` conferido, o build só da API e o
  reinício do `loja-api`. Depois disso, o bloco 5.1 deu `RESULTADO: OK`, com C1–C9 sem divergência nas 204 variantes.
  Retestado no pedido nº 1426 (ver "Encomenda" acima): a realocação depois da falta confirmou sem erro.
  O bloco 5.1 rodado depois do reteste deu `RESULTADO: OK`:
  - C1–C9 sem divergência nas 204 variantes e 0 reservas ativas sem depósito;
  - 8 atendimentos (4 novos no pedido nº 1426) e 11 decisões (4 novas);
  - dropshipping `blocked`.
- [ ] **Depois de tudo aprovado.** Decidir se liga `ALLOCATION_AUTO=on` (D4-2). Ligada, a rotina passa a confirmar
  sozinha o caso simples.

## SGLog Fase 5 — remessas e expedição ([26-sglog-fase5.md](26-sglog-fase5.md))

**Situação: implementada só no local, branch `sglog/fase5`. Não implantada.** O roteiro está em
[27-sglog-fase5-implantacao.md](27-sglog-fase5-implantacao.md) e foi ensaiado no local; executar só depois do merge
e do push autorizados. `ALLOCATION_AUTO` continua desligado. Remessas múltiplas nascem travadas. A trava da NF-e não
muda: não alterar `invoice_status` de pedido na VPS.

Validação pelo painel HTTPS, depois da implantação:

- [ ] **Fila.** Logística → Expedição abre a 375 px sem rolagem lateral, com os contadores e "Remessas múltiplas:
  Travadas". Os pedidos de demonstração com alocação aberta (por exemplo, nº 1421 e nº 1426) aparecem em "A separar".
- [ ] **Separar e conferir.** Num pedido de demonstração escolhido, anotar o saldo do produto antes. Depois:
  1. iniciar a separação, separar e concluir;
  2. conferir por SKU, tentar uma unidade a mais (deve recusar e aparecer no histórico) e concluir;
  3. embalar.

  O saldo do produto não muda em nenhuma dessas etapas.
- [ ] **Pedido antigo.** Um pedido sem alocação obrigatória continua com os botões de antes.
- [ ] **Troca de origem bloqueada.** Com a remessa em separação, "Trocar origem" e "Desfazer" na alocação recusam com a
  mensagem de remessa em andamento. Depois de "Liberar para pendente", voltam a funcionar.
- [ ] **Falta.** Registrar uma falta: a remessa volta para "A separar", o pedido vai para "Em análise" com a nota e o
  saldo não muda.
- [ ] **Despacho.** **Você**/**Contador**: sem NF-e configurada, a remessa para em "Embalada" com "Aguardando NF-e"
  (esperado). Com a NF-e autorizada em homologação: despachar, conferir a baixa só da quantidade da remessa e o
  WhatsApp "enviado" uma vez. Retirada na loja vai direto para "Entregue".
- [ ] **Bloco 5.1** depois dos testes: `RESULTADO: OK`, com C1–C11 sem divergência.
- [ ] **Contador.** Definir como emitir NF-e numa entrega parcial (uma nota por remessa ou outra regra). Só depois
  liberar "Remessas múltiplas" em Expedição → Regras, com o nome de quem validou.
- [ ] **Usuários por perfil.** Quando houver: estoquista separa e confere, mas não despacha nem cancela remessa;
  financeiro não vê a expedição.

## SGLog Fase 6 — compras, recebimento e encomendas ([29-sglog-fase6.md](29-sglog-fase6.md))

**Situação: implantada na VPS em 20/11/2026 (`5a07198`, migração 0025).** Bloco 5.1 logo após a implantação:
`RESULTADO: OK`, 204 variantes, C1–C13 sem divergência. Roteiro em
[30-sglog-fase6-implantacao.md](30-sglog-fase6-implantacao.md).

Validado pelo HTTPS em 20/11/2026 com o proprietário (MFA ativo), na compra de teste nº 107 (3 pacotes de
CPO-50-BRA, fornecedor de demonstração). Ficou no estoque de demonstração: +200 UN disponíveis e 100 UN em avariado
(dar baixa da avaria quando quiser).
Continuam assim:
- `ALLOCATION_AUTO` desligado;
- dropshipping e remessas múltiplas bloqueados;
- limite de aprovação R$ 0.

Validação pelo painel HTTPS, depois da implantação. Use só compras de teste, com valores pequenos, e não informe
pagamento real.

- [x] **Regras.** Compras mostra "Regras da compra: Toda compra passa por aprovação" e tolerância 0%. Não altere.
- [ ] **Aprovação.** Feito: envio para aprovação e aprovação própria do proprietário com justificativa e histórico.
  Falta: recusa sem MFA e aprovação por um segundo usuário (precisa de outra conta).
  1. Crie um rascunho de compra de teste e clique "Enviar para aprovação": a compra fica "Aguardando aprovação".
  2. Com o mesmo usuário, "Aprovar" deve recusar. Sem MFA, a recusa pede para ativar a verificação. Com MFA, quem
     criou só aprova se for o proprietário, com justificativa, e a compra mostra "Aprovado pelo próprio proprietário".
  3. Se houver um segundo usuário gerente com MFA, aprove com ele.
- [ ] **Edição depois de aprovada** volta para rascunho, com "Voltou para rascunho" no histórico.
- [x] **Pagamento informado.** Registrado com `confirmedByProvider: false`. Com o Financeiro, ou com você: informar data e valor fictícios mostra "Informação
  administrativa: não confirma o pagamento no banco". Nada muda em Pagamentos e Vendas.
- [x] **Recebimento.** 2000 → 2100 disponível, avariado 0 → 100, divergência de qualidade registrada. Marque como enviado e receba em parte, por exemplo 1 embalagem com outra recusada como
  "Avariado":
  1. Anote o saldo antes.
  2. Depois, o disponível sobe só o aceito e o avariado sobe o recusado.
  3. A divergência aparece em "Divergências do recebimento".
- [x] **Preço da nota.** Sem justificativa recusou; com justificativa entrou, custo médio pelo preço da nota. Informe um custo de nota diferente sem justificativa: deve recusar. Com justificativa, entra e
  registra divergência de preço.
- [ ] **Encomenda.** Pendente: não havia encomenda aguardando na VPS. Se houver um pedido pago de produto sob encomenda alocado como "comprar para atender":
  1. vincule-o à compra em "Encomendas de clientes" e receba;
  2. o pedido aparece em "Atendidas na chegada desta compra";
  3. no detalhe logístico do pedido aparece "atendido pela compra nº ...";
  4. o pedido não muda de situação nem despacha sozinho.
- [ ] **Encerrar com falta** (pendente, depende de encomenda vinculada) uma compra com vínculo ainda aguardando:
  - a tela lista as encomendas pendentes;
  - o pedido do cliente mostra "Vínculo desfeito ... pendente" e não é cancelado.
- [x] **Logística → Encomendas** abre a 375 px sem rolagem lateral. "Reprocessar encomendas" mostra só a prévia;
  aplique só se a prévia fizer sentido.
- [x] **Bloco 5.1** do roteiro de implantação depois dos testes: `RESULTADO: OK`, C1–C13 sem divergência (20/11/2026,
  depois da compra de teste nº 107).
- [ ] **Usuários por perfil** (pendente, precisa de outras contas), quando houver:
  - comprador cria e envia para aprovação, mas não recebe;
  - estoquista recebe, mas não aprova;
  - financeiro informa pagamento, mas não aprova.
- [ ] **Decisões da empresa:**
  - limite de aprovação de produção (D6-3) e tolerância de preço (D6-12);
  - quem passa a receber no lugar do comprador (D6-1).

## SGLog Fase 7 — abastecimento e fornecedores ([32-sglog-fase7.md](32-sglog-fase7.md))

**Situação: implantada na VPS em 21/11/2026 (`f5501d7`, migração 0026).** Roteiro em
[33-sglog-fase7-implantacao.md](33-sglog-fase7-implantacao.md). Backup antes da implantação: `20261121-002752`.

- **Ensaio da 0026:** bloqueios em 1 ms e compras bloqueadas por 54 ms. Na produção, 113 ms.
- **Bloco 5.1 logo após a implantação:**
  - `RESULTADO: OK`, 204 variantes, C1–C13 sem divergência;
  - 6 compras enviadas como anteriores ao acompanhamento;
  - documentos, confirmações, requisições e itens cancelados em 0;
  - e-mail ao fornecedor, dropshipping e remessas múltiplas `blocked`;
  - prazo de confirmação de 2 dias.
- **Pendente antes de testar o envio:**
  - razão social, CNPJ e endereço em Empresa, que estavam vazios;
  - ou o endereço do "Depósito principal".
- **Reversão:** com os testes de 20/11/2026 a Fase 7 passou a ser usada; a 0026 não se desfaz mais. Recuperação só
  pelo backup.
- **Fuso (20/11/2026):** o banco da VPS estava em UTC; a partir das 21h, "hoje" já era o dia seguinte. Correções:
  - `ALTER DATABASE loja_prod SET timezone TO 'America/Sao_Paulo'`;
  - fuso fixo nas conexões da API (`e057df4`).

  O relógio do sistema continua em UTC, com NTP.
- **Correção depois da implantação:** `3393f8a`. As datas vencidas das compras antigas apareciam em vermelho em "A
  caminho".

**Resultados pelo HTTPS em 20/11/2026** (Chrome, proprietário):
- Compras antigas: as 6 aparecem como "Anterior ao acompanhamento", sem alerta e, depois de `3393f8a`, sem vermelho.
- Telas a 375 px: Abastecimento, Requisições e início abrem sem rolagem lateral; o início mostra o resumo.
- Documento sem CNPJ: o rascunho nº 106 lista razão social, CNPJ e endereço de entrega, e o envio fica bloqueado.
- Confirmação na compra nº 82 (versão 1):
  - BIC-32 confirmado em 25/11;
  - FAL-20 parcial, 1 de 2 em 24/11, com o restante sem data e nada cancelado;
  - topper reduzido, 1 de 2, com 1 cancelado.

  Saldo, custo médio e movimentos dos 3 produtos ficaram iguais.
- Acompanhamento na nº 82: contato registrado, retorno em 23/11.
- Requisição nº 1:
  1. criada e convertida no rascunho nº 108;
  2. o rascunho foi cancelado e a requisição voltou a ficar aberta;
  3. a requisição foi cancelada.

  Eventos: criada → em compra → devolvida → cancelada.
- Aumento de preço na compra nº 79: aumento de R$ 22,74 no FAL-15, com tolerância de 0%.
  - A situação ficou "Aumento de preço aguardando aprovação" e o preço do item não mudou.
  - O recebimento foi recusado (`CONFIRMATION_APPROVAL_PENDING`).
  - **Pendente:** aprovar ou recusar, com MFA, na tela da compra nº 79. O proprietário aprova o próprio registro só
    com justificativa. Até lá, a nº 79 não recebe.
- Pendentes:
  - documento e envio (versões 1 e 2), quando houver CNPJ;
  - "Preencher pela nota (XML)";
  - perfis de outros usuários.
- **Melhorias futuras** (registradas em 20/11/2026, não são defeitos):
  - exibir o nome do produto junto à embalagem no histórico de confirmação (hoje aparece só, por exemplo, "Caixa com
    12");
  - manter visíveis as requisições sem fornecedor principal (grupo "Sem fornecedor principal"), **sem** selecionar
    automaticamente um fornecedor.

**Fase 7 concluída funcionalmente em 20/11/2026** (em execução `e057df4`, 0026 aplicada, C1–C13 sem divergência em 204
variantes). As pendências acima continuam abertas: compra nº 79 aguardando a decisão do aumento, cadastro da empresa
e versões do documento, pré-preenchimento pelo XML e permissões por perfil.

Validação pelo painel HTTPS, depois da implantação. Use só compras de teste, do fornecedor de demonstração, com valores
pequenos. Nada nesta fase movimenta estoque: anote o saldo do produto antes e confira que só o recebimento o muda.

- [ ] **Compras antigas.** Em Logística → Abastecimento, as compras enviadas antes da implantação aparecem como
  "Anterior ao acompanhamento". Não aparecem como confirmação atrasada nem como entrega atrasada.
- [ ] **Documento com dado faltante.** Numa compra aprovada, o painel "Pedido ao fornecedor" mostra a prévia. Se faltar
  razão social, CNPJ ou endereço de entrega, aparece a lista do que falta e o envio fica bloqueado. Complete em Empresa
  ou Depósitos.
- [ ] **Envio e versão imutável:**
  1. "Copiar texto" copia o pedido.
  2. "Abrir para imprimir" mostra o documento. "Imprimir ou salvar em PDF" gera o PDF pelo navegador.
  3. Confira que não há nome, telefone ou e-mail de cliente.
  4. "Registrar envio ao fornecedor" com canal (por exemplo "PDF") grava a versão 1, com autor, data e canal.
  5. "Reenviar" grava a versão 2; a versão 1 continua igual, inclusive o código de conferência.
  6. Nenhum e-mail sai sozinho.
- [ ] **Prazo de confirmação.** A compra enviada fica "Aguardando confirmação". Em Compras → "Regras da compra", o
  prazo mostra 2 dias. Não altere: um valor diferente de 2 impede desfazer a 0026.
- [ ] **Confirmação total.** Registre a confirmação com tudo confirmado e uma data de entrega: fica "Entrega prevista".
- [ ] **Confirmação parcial**, numa segunda compra de teste: um item com entrega parcial (parte numa data e o restante
  sem data). A compra mostra "Entrega parcial ... restante sem previsão". Nada é cancelado, e as encomendas vinculadas
  continuam vinculadas.
- [ ] **Redução e recusa:**
  - reduzir a quantidade de um item mostra "cancelada(s): quantidade reduzida pelo fornecedor";
  - o pendente do recebimento diminui;
  - se havia encomenda vinculada além do que sobrou, o vínculo é desfeito com pendência no pedido do cliente, sem
    cancelar o pedido;
  - recusar o pedido inteiro deixa a compra "Recusada pelo fornecedor", para cancelar.
- [ ] **Aumento de preço** (precisa de MFA). Confirme um item com preço maior que o pedido:
  1. A compra fica "Aumento de preço aguardando aprovação" e o recebimento some, com aviso.
  2. Aprovar com o mesmo usuário que registrou deve recusar. O proprietário pode, com justificativa.
  3. Depois de aprovar, o recebimento volta.
  4. O custo médio do produto não muda com a confirmação, só com a nota no recebimento.
- [ ] **Acompanhamento.** Registre uma cobrança com data de retorno: aparece no histórico e em "Próximo retorno".
- [ ] **Recebimento pelo XML.** Numa compra com nota de entrada importada e ligada, "Preencher pela nota (XML)" preenche
  as quantidades e os preços. Nada entra até clicar em receber. As conferências de preço e fiscal continuam pedindo
  justificativa.
- [ ] **Requisição manual.** Em Compras → Requisições, "Pedir compra" de um produto de demonstração cria a requisição
  aberta. "Cancelar" pede o motivo e a remove das abertas.
- [ ] **Gerar compra.** Marque uma requisição aberta e "Gerar compra":
  - nasce um rascunho no mesmo depósito, com a requisição "Em compra";
  - o rascunho segue aprovação e envio normais;
  - cancele o rascunho no fim; a requisição volta a ficar aberta.
- [ ] **Requisição automática.** Se houver encomenda ativa sem compra, ela aparece como requisição "Encomenda" com o
  número do pedido, uma só, mesmo depois de "Atualizar encomendas" várias vezes.
- [ ] **Abastecimento a 375 px.** Logística → Abastecimento, Compras → Requisições e o documento abrem sem rolagem
  lateral. O início do painel mostra o resumo "Abastecimento".
- [ ] **Reposição.** Um produto com requisição aberta mostra "em requisição" e a necessidade desconta essa quantidade.
- [ ] **Bloco 5.1** do roteiro de implantação depois dos testes: `RESULTADO: OK`, C1–C13 sem divergência.
- [ ] **Usuários por perfil** (precisa de outras contas), quando houver:
  - logística pede compra, mas não gera compra;
  - estoquista pede e gera;
  - financeiro vê as requisições, mas não pede nem gera compra.

## SGLog Fase 8 — fretes, etiquetas, rastreio e custos ([35-sglog-fase8.md](35-sglog-fase8.md))

**Situação: validada funcionalmente, com ressalvas (21/11/2026).** Implantada na VPS em 21/11/2026 (`d58a3dd`,
migração 0027); em execução `d76ca4f`. Roteiro em [36-sglog-fase8-implantacao.md](36-sglog-fase8-implantacao.md).

Encerramento da fase:
- **Validado:** na VPS, `d76ca4f` com a 0027, suíte da API 497/497 e reconciliação C1–C13 sem divergência. Pelo
  HTTPS, foram validados:
  - menu e trava da etiqueta;
  - os seis cards e a fila;
  - o relatório;
  - custo, ajuste e estorno;
  - rastreio manual do despacho anterior;
  - aviso falso (`404` sem provedor);
  - marketplace fora do frete da loja.
- **Ressalvas** (não bloqueiam a fase e seguem abertas abaixo):
  - não houve remessa de entrega nova na VPS. Por isso ficaram sem teste: o despacho com custo, a entrega pela
    remessa e o painel de uma remessa embalada;
  - a página do cliente não foi aberta (precisa da conta do cliente de teste);
  - as permissões por perfil não foram conferidas pelo HTTPS;
  - o Melhor Envio não está configurado (sem sandbox, token nem segredo do aviso). A assinatura em base64 segue sem
    confirmação;
  - **a compra real de etiqueta continua bloqueada**, e `SHIPPING_LABELS_ENABLED` continua desligado;
  - alocação automática, dropshipping, remessas múltiplas e e-mail ao fornecedor continuam desligados ou bloqueados.
- **Correção local depois da validação** (sem push nem implantação): no despacho anterior, a tela da remessa mostrava
  "Marcar como entregue", mas a API recusa (`LEGACY_SHIPMENT`). Agora a tela segue a mesma regra: em vez do botão,
  explica que a entrega é registrada na tela do pedido, com o link. Não mudaram as regras de entrega, as situações
  nem os dados. Commit `127572f`.
- **Commits locais sem push:**
  - `fe927bf` (este documento: rastreio do despacho anterior validado);
  - `127572f` (a correção acima);
  - este encerramento.

- **Antes da implantação:** 401 remessas, 10 em transporte e 5 eventos de remessa. O `.env` não tinha alocação
  automática, etiqueta ligada nem Melhor Envio. O backup foi verificado (4 arquivos com sha256 correto).
- **Ensaio da 0027:** OK.
- **Migração na produção:** bloqueios em 1 ms, sem nova tentativa; concluída em 106 ms.
- **Bloco 5.1 logo após a implantação:**
  - `RESULTADO: OK`, 204 variantes, C1–C13 sem divergência;
  - etiqueta `blocked`, limite `null`, rastreio a cada 6 h e parado depois de 5 dias;
  - remessas (401) e eventos (5) iguais aos de antes;
  - cotações, etiquetas, custos, tarefas e avisos em 0;
  - dropshipping, remessas múltiplas e e-mail ao fornecedor `blocked`;
  - log da API sem erros.
- **Defeitos achados pelo HTTPS em 21/11/2026** (Chrome, proprietário, só leitura). Corrigidos em `4b09c4d`, implantado
  em 21/11/2026 (sem migração):
  - o card "Em transporte" respondia **500** (`view=tracking`): a consulta recebia um parâmetro que não usava. A tela
    guardava o erro, e os cards seguintes (por exemplo "Rastreio parado") continuavam mostrando "Erro interno" mesmo com
    resposta 200. Agora cada lista monta só os parâmetros que usa, e a tela descarta respostas e erros de um card
    anterior;
  - pedidos de **marketplace** com despacho anterior (por exemplo o nº 1419, Shopee) apareciam em "Rastreio parado",
    em "Sem custo informado" e no relatório, e o painel "Frete" oferecia rastreio e custo. Agora o frete da loja é só a
    remessa de entrega ou o despacho anterior de pedido da loja ou do balcão que não seja retirada. O marketplace fica
    de fora das listas, do relatório e do painel, e a API recusa custo e rastreio (`NOT_CARRIER_SHIPMENT`);
  - o despacho anterior de pedido da loja não aceitava custo (`LEGACY_SHIPMENT`) apesar de aparecer em "Sem custo
    informado". Agora aceita.
- **Depois de `4b09c4d`, pelo HTTPS (Chrome, só leitura):**
  - cliques seguidos nos seis cards, em várias voltas: todas as listas responderam 200, inclusive "Em transporte",
    sem "Erro interno"; a tela fica sempre com a lista do último card clicado;
  - marketplace fora do frete da loja: "Rastreio parado" caiu de 10 para 5, "Sem custo informado" de 297 para 84, o
    relatório ficou só com "Entrega própria" (24 remessas), e a remessa da Shopee nº 1419 não mostra mais o painel
    "Frete";
  - em janela estreita (767 px, menu recolhido), sem rolagem lateral.
- **Testes com gravação pelo HTTPS em 21/11/2026** (Chrome, proprietário), no pedido de demonstração nº 1416
  (despacho anterior, entrega própria, nota "não exigida"):
  - custo pago R$ 18,40 → pago R$ 18,40; ajuste sem motivo recusado ("Informe o motivo."); ajuste de R$ 2,00 → R$ 20,40;
    estorno de R$ 1,00 → R$ 19,40; os três lançamentos ficaram na lista;
  - **defeito:** o rastreio manual nessa remessa era recusado ("Remessa de pedido antigo: já foi despachada pelo fluxo
    anterior."), embora ela apareça em "Em transporte" e "Rastreio parado". Corrigido no local: o evento entra no
    histórico com a nota "remessa do despacho anterior", e a situação segue o pedido, sem mudar o fluxo antigo.
    Corrigido em `d76ca4f`, implantado em 21/11/2026 (sem migração) e conferido no nº 1416:
    - em trânsito, saiu para entrega, em trânsito de novo e falha na entrega entraram no histórico, na ordem, com a
      nota, e a remessa continuou "despachada";
    - a remessa saiu de "Rastreio parado" (de 5 para 4) e continua em "Em transporte";
  - relatório depois dos testes: o nº 1416 aparece com cobrado R$ 10,00, pago R$ 20,40, estorno −R$ 1,00, líquido
    R$ 19,40 e diferença −R$ 9,40; é a única remessa com custo conhecido (23 sem custo, fora da diferença). "Sem custo
    informado" caiu de 84 para 83;
  - aviso falso do Melhor Envio, sem assinatura e com assinatura falsa: `404`, porque não há Melhor Envio configurado;
  - não testados: despacho com custo e entrega pela remessa (não há remessa de entrega nova embalada nem em transporte
    na VPS) e a página do cliente (precisa da conta do cliente).
- **Conferido pelo HTTPS sem defeito:** a fila nas quatro situações, o relatório, a trava da etiqueta com os motivos e
  o painel "Frete" sem botão de compra.

No local:
- suíte da API 495/495 (497 com `d76ca4f`; 498 com o teste da entrega do despacho anterior);
- código anterior (`e057df4`) 471/471 com a 0027 aplicada;
- 0027 em up, down e up;
- telas a 375 px e no desktop.

**A compra real de etiqueta continua bloqueada.** Não ligue `SHIPPING_LABELS_ENABLED` nem libere a regra do frete.
Use só pedidos de teste, com NF-e já autorizada pelo fluxo normal: não altere `invoice_status`.

Validação pelo painel HTTPS, como proprietário, depois da implantação:

- [x] **Menu e trava.** Abra Logística → Fretes:
  - o topo mostra o transportador. Sem token do Melhor Envio, aparece "nenhum configurado (frete manual)";
  - aparece "Compra de etiqueta pelo sistema: bloqueada", com os motivos (servidor, regras do frete e limite não
    definido);
  - nenhum botão de compra.
- [x] **Listas e relatório:**
  - "Sem custo informado" lista as remessas despachadas nos últimos 90 dias;
  - o relatório do mês mostra o cobrado, e o pago "não informado" (nunca R$ 0,00) enquanto ninguém informar custo;
  - a tela não rola para o lado no celular.
- [ ] **Remessa embalada de teste.** O painel "Frete" mostra cobrado, cotado "—" e pago "não informado":
  - sem provedor, aparece "Cotação pelo sistema indisponível";
  - em Etiqueta, aparece o aviso de compra bloqueada.
- [ ] **Despacho com custo.** Despache a remessa de teste informando a transportadora, o código e o custo pago (por
  exemplo R$ 18,40):
  - o painel passa a mostrar o pago R$ 18,40;
  - a remessa sai de "Sem custo informado";
  - o relatório conta a remessa na diferença cobrado − pago.
- [ ] **Despacho sem custo.** Numa segunda remessa, despache sem o custo. Ela aparece em "Sem custo informado" e o pago
  fica "não informado". Depois, em "Custo pago à transportadora", registre o custo e confira a mudança.
- [x] **Ajuste e estorno.** Na primeira remessa:
  - registre um ajuste de R$ 2,00 com motivo: o pago vira R$ 20,40;
  - registre um estorno de R$ 1,00 com motivo: o pago vira R$ 19,40;
  - os lançamentos anteriores continuam iguais (não há edição nem exclusão);
  - ajuste ou estorno sem motivo é recusado.
- [x] **Rastreio manual:**
  - na remessa despachada, registre "Em trânsito" e depois "Saiu para entrega": o histórico mostra os dois;
  - registre "Em trânsito" de novo: entra no histórico, mas a situação continua "Saiu para entrega" (sem voltar);
  - "Falha na entrega" só fica registrada, e a remessa continua em transporte (o tratamento é da Fase 9).
- [ ] **Página do cliente** (ressalva: não testada). Com a conta do cliente de teste, abra o pedido. O histórico de rastreio mostra enviada,
  em trânsito e saiu para entrega, sem nome de funcionário nem observação interna.
- [ ] **Entrega** (ressalva: falta remessa de entrega nova). "Marcar como entregue" na remessa de entrega. No
  despacho anterior, o botão não aparece; a entrega é feita na tela do pedido. O pedido fica entregue, como antes, e o histórico do cliente
  mostra "Entregue".
- [x] **Aviso falso.** Do seu computador (não da VPS), envie um aviso sem assinatura:

  ```powershell
  curl.exe -s -o NUL -w "%{http_code}" -X POST https://<domínio>/api/v1/webhooks/carriers/melhorenvio -H "content-type: application/json" -d '{\"event\":\"order.delivered\",\"data\":{\"id\":\"x\"}}'
  ```

  Sem Melhor Envio configurado, responde `404` (a rota não existe para esse provedor). Com o Melhor Envio configurado,
  responde `401`. Nenhuma remessa muda e nenhum aviso é gravado.
- [ ] **Permissões:**
  - o perfil da logística vê Fretes e registra custo e rastreio;
  - o perfil de expedição não tem "Etiquetas de frete";
  - em Usuários, a permissão nova aparece como "Etiquetas de frete (compra, cancelamento)".
- [x] **Fila.** Em Fretes → "Fila de integrações", "Com falha" fica vazia. Sem provedor, nenhuma tarefa é criada.
- [ ] **Banco depois dos testes** (como `loja`, bloco 5.1 do doc 36):
  - `RESULTADO: OK`;
  - `etiquetas` 0 e `etiqueta` `blocked`;
  - `custos` igual ao número de lançamentos feitos.

Pendentes, fora do HTTPS de testes:
- [ ] **Você** Conta do Melhor Envio no sandbox: token, `MELHOR_ENVIO_SANDBOX=true` e o segredo do app em
  `MELHOR_ENVIO_WEBHOOK_SECRET`. Depois, cotar uma remessa real e cadastrar a URL do aviso no app.
- [ ] Conferir com um aviso real assinado se a assinatura é em base64, como assumido a partir da documentação.
- [ ] **Decisão futura** Compra de etiqueta pelo sistema. Exige:
  - um provedor com idempotência ou busca pela nossa chave (o Melhor Envio não tem);
  - CNPJ e NF-e em produção, saldo, teste no sandbox, limite definido, MFA e a sua autorização expressa.
