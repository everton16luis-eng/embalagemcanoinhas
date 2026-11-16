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
      celular (980b0f5). Falta publicar esses commits. Ainda sem dados da empresa: logo "NOME DA LOJA" e rodapé
      pedindo cadastro (preencher em Configuração inicial).

## Pagamento — Mercado Pago (Fase 4)

- [ ] **Você** Credenciais de teste (Access Token, Public Key, chave do webhook) no `.env`.
- [ ] **HTTPS** Cadastrar a URL do webhook (`/api/v1/webhooks/mercadopago`) no Mercado Pago.
- [ ] **HTTPS** Pix de teste: gerar, pagar com usuário de teste, webhook confirma, pedido vai a pago.
- [ ] **HTTPS** Cartão de teste pelo Card Payment Brick: aprovado, recusado, em análise.
- [ ] **HTTPS** Webhook repetido e fora de ordem (reenviar pelo painel do Mercado Pago): pedido não muda duas vezes.
- [ ] **HTTPS** Webhook com assinatura errada é recusado.
- [ ] Queda do provedor durante o checkout (desligar a rede): pedido fica pendente e reconsulta depois.
- [ ] **Você** Devolução de pagamento cancelado (hoje é feita no painel do Mercado Pago).

## NF-e — Focus NFe em homologação (Fase 5)

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

- [ ] Abrir o link `wa.me` gerado num celular com WhatsApp e conferir o texto (acentos, quebras de linha, link do
      orçamento).
- [ ] **HTTPS** Link público do orçamento aberto pelo cliente fora da rede local.
- [ ] **HTTPS** Cliente aceita o orçamento pelo link e paga com Pix de teste do Mercado Pago (fim a fim).
- [ ] **Você** Decidir se o balcão recebe pagamento presencial (dinheiro/maquininha); hoje só Pix e cartão online.

## Marketplaces (Fase 7)

Roteiro detalhado em [07-marketplaces.md](07-marketplaces.md) §5. Tudo abaixo foi feito só com o simulado.

- [ ] **Você** Cadastrar o aplicativo no DevCenter do Mercado Livre (PKCE ligado, tópico `orders_v2`) e pôr
      `ML_CLIENT_ID`/`ML_CLIENT_SECRET` no `.env`; conta de vendedor de teste.
- [ ] **Você** Cadastrar o app na Shopee Open Platform (sandbox primeiro: `SHOPEE_API_HOST`/`SHOPEE_AUTH_HOST` do
      sandbox) e pôr `SHOPEE_PARTNER_ID`/`SHOPEE_PARTNER_KEY` no `.env`; loja de teste.
- [ ] **HTTPS** URLs de retorno e de aviso cadastradas (`/painel/marketplaces/retorno/{canal}`,
      `/api/v1/webhooks/marketplaces/{canal}`); `SHOPEE_PUSH_URL` idêntica à cadastrada.
- [ ] **HTTPS** Conectar as duas contas pelo painel; conferir a renovação do token depois de 6 h (ML) e 4 h (Shopee).
- [ ] **HTTPS** Venda de teste paga em cada plataforma: aviso chega, pedido entra pago, estoque reservado.
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

Roteiro em [08-whatsapp-transportadoras-relatorios.md](08-whatsapp-transportadoras-relatorios.md). Tudo abaixo foi
feito só com os simulados.

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
- [ ] **IA (Gemini real)** Repetir a conversa dos copos (oi → copos para festa de 15 anos → só refrigerante → uns 40 convidados → "3" pacotes) e conferir que nenhuma resposta é o menu. Conferir em `bot_runs.route` que todas saíram como `ia`.
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
- [ ] **HTTPS** Responder SAIR: número bloqueado, próximos avisos não saem.
- [ ] **HTTPS** Mensagem do cliente → resposta pelo painel dentro de 24 h; depois de 24 h o painel bloqueia.
- [ ] Conferir com respostas reais os campos usados do webhook (status, erros) e a recusa de modelo inexistente.
- [ ] **Você** Conta no Melhor Envio (sandbox primeiro): gerar o token e pôr `MELHOR_ENVIO_TOKEN` e
      `MELHOR_ENVIO_USER_AGENT` (nome do app e e-mail técnico, exigido pela API) no `.env`; `MELHOR_ENVIO_SANDBOX=false`
      só em produção.
- [ ] **Você** Confirmar como o token é renovado (não achado na documentação pública) e a validade dele.
- [ ] Cotação real: conferir `custom_price`/`custom_delivery_time` e serviços indisponíveis com o CEP da empresa.
- [ ] **Você** Escolher os serviços de transportadora que a loja oferece e cadastrar o CEP da empresa; preencher
      peso e medidas das variações (sem eles a opção não aparece).
- [ ] **Você** Decidir como comprar o frete e gerar etiqueta (hoje fora do sistema).

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
demonstração (bloqueio de 120 a 167 ms, 0 divergência e reversão com o histórico idêntico).

- [ ] **Servidor** Conferir que a última migration aplicada em produção é a `0019_importacao_produtos`.
- [ ] **Servidor** Espaço em disco para um backup e um banco temporário do tamanho do de produção.
- [ ] **Servidor** `npm run backup:migrate-rehearsal -- backups/<pasta>` com a cópia de produção. Anotar o tempo de
      bloqueio, a diferença herdada (quantidade, valor e SKUs) e o resultado da conferência.
- [ ] **Você** Se houver diferença herdada, decidir se ela é aceita como está (ela fica registrada na abertura) ou se
      os saldos são acertados antes, por ajuste com movimento.
- [ ] **Servidor** `.env` do servidor: `DB_NAME_TEST` ausente ou apontando para banco `_test` (os testes não rodam
      no servidor; a trava recusa banco sem a marca de testes de qualquer forma).
- [ ] **Servidor** Depois da migration real: `SELECT * FROM stock_reconcile();` só com a linha `run` e `found = 0`.
- [ ] **Você** Criar um usuário de cada papel novo (logística, comprador, financeiro) e conferir as telas no painel.
- [ ] **Você** (máquinas de desenvolvimento) Rodar `npm run migrate:test` uma vez para gravar a marca do banco de
      testes; sem ela a suíte se recusa a rodar.
