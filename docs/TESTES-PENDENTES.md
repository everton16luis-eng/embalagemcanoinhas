# Testes pendentes (depois, com HTTPS ou com você)

Tudo o que não dá para testar no ambiente local: precisa de endereço público com HTTPS, de credencial real, de dado
da empresa ou de alguém de fora (contador, fornecedor, provedor). O código segue sendo feito; esta lista é o roteiro
de testes antes do lançamento. Marque `[x]` quando for testado e anote a data.

Legenda: **HTTPS** = precisa da API publicada com certificado · **Você** = depende de dado, conta ou decisão sua ·
**Contador** = depende da validação dele.

## Infraestrutura (antes de tudo)

- [ ] **HTTPS** Publicar API e site em servidor com domínio e certificado; medir memória livre no VPS.
- [ ] **HTTPS** `next build` e implantação; conferir cookies `Secure`, cabeçalhos de segurança e `TRUST_PROXY`.
- [x] Backup e teste de restauração **local** (13/11/2026): `npm run backup` e `backup:restore-test` OK; arquivo
      adulterado detectado pelo `backup:verify`. Ver [BACKUP.md](BACKUP.md).
- [ ] **HTTPS** Backup agendado no servidor, cópia para fora dele e teste de restauração lá.
- [ ] **Servidor** Fotos de produto pelo celular e pelo computador no servidor (nginx com 12 MB): foto de 7–8 MB
      sobe; acima de 8 MB aparece a mensagem do sistema; depois de `systemctl restart loja-api` as fotos continuam.
- [ ] **Você** Onde guardar as cópias fora do servidor e por quanto tempo (retenção).
- [ ] **Você** Provedor de e-mail transacional; testar a recuperação de senha chegando de verdade.
- [ ] Inspeção visual por captura de tela (painel e loja, desktop e celular): até aqui a verificação foi por texto e
      medidas.

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

- [ ] **Você** Criar o app na Meta (WhatsApp Business Platform), registrar o número e pôr `WA_PHONE_NUMBER_ID`,
      `WA_ACCESS_TOKEN` (token de usuário de sistema), `WA_APP_SECRET` e `WA_VERIFY_TOKEN` no `.env`.
- [ ] **Você** Criar e aprovar no WhatsApp Manager os 3 modelos (pagamento confirmado, pronto para retirada,
      despachado) com as variáveis nomeadas `{{nome}}`, `{{pedido}}` e `{{rastreio}}`; cadastrar os nomes no painel.
- [ ] **HTTPS** Cadastrar a URL do webhook (`/api/v1/webhooks/whatsapp`) com o token de verificação e assinar o
      campo `messages`; conferir que a verificação responde o `hub.challenge`.
- [ ] **HTTPS** Pedido de teste com consentimento: aviso chega no celular; situação passa a entregue e lida no painel.
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

- [ ] **Servidor** Rodar `sudo bash /srv/loja-embalagens/deploy/auditoria-servidor.sh 2>&1 | tee ~/auditoria-$(date +%F).txt`
      (só leitura) e corrigir o que aparecer: SSH, firewall, portas, permissões do `.env`, PostgreSQL só em 127.0.0.1.
- [ ] **Servidor** Instalar `deploy/nginx/00-loja-limites.conf` e os sites da loja atualizados; `nginx -t` antes do
      reload; conferir que a loja abre e que `curl -I` não mostra a versão do nginx.
- [ ] **Servidor** Carga no VPS de outra máquina, fora do horário de movimento: `fumaca` e depois `inicial`
      ([tests/carga/README.md](../tests/carga/README.md)), com `vmstat -w 2` aberto no servidor. Anotar p95 e CPU.
- [ ] **HTTPS** Cabeçalhos pelo nginx: `Content-Security-Policy` no painel e na loja, cookies `Secure`.
- [ ] **Você** Sandbox do Mercado Pago: anotar os domínios que o SDK carrega e então fechar a CSP da loja
      (`script-src`, `connect-src`, `frame-src`).
- [ ] **Você** Lighthouse de novo com o catálogo e as fotos reais (LCP passa a ser a foto).
- [ ] **Você** Logotipo definido → `favicon` (hoje 404 no console).
- [ ] **Você** Retenção de sessões vencidas e carrinhos abandonados; monitor externo de disponibilidade.
- [ ] **Você** Tornar o repositório do GitHub privado.

## Lançamento

- [ ] **Servidor** Seguir [IMPLANTACAO.md](IMPLANTACAO.md) num servidor Ubuntu: unidades do systemd sobem e
      voltam depois de reiniciar a máquina (o `loja-db` com `Type=oneshot` foi escrito, não testado).
- [ ] **HTTPS** IP real do cliente na Auditoria (nginx sobrescrevendo `X-Forwarded-For` + `TRUST_PROXY=1`).
- [ ] **Servidor** `loja-backup.timer` gera a cópia diária; cópia para fora do servidor definida por você.
- [ ] **Servidor** Envio de foto de 8 MB pelo painel passando por nginx e Next.
- [ ] **Você** Provedor de e-mail (transacional): sem ele a recuperação de senha por e-mail fica desligada e quem
      esquecer a senha do painel depende de alguém com "Gerenciar usuários" gerar uma nova (tela Usuários). Clientes
      da loja ainda não têm recuperação de senha: precisa do provedor de e-mail. Decidir o provedor antes do lançamento.

- [ ] **Servidor** `demo:seed` e `demo:reset` no banco de produção (ver [DEMONSTRACAO.md](DEMONSTRACAO.md)); a
      reversão roda **antes** da primeira nota de homologação e do catálogo real.
- [ ] **Você** Nome, logotipo, fotos, textos de trocas e privacidade, formas de entrega reais.
- [ ] **Você** + **Contador** Liberar produção fiscal no painel só depois de tudo acima.
