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

## Lançamento

- [ ] **Você** Nome, logotipo, fotos, textos de trocas e privacidade, formas de entrega reais.
- [ ] **Você** + **Contador** Liberar produção fiscal no painel só depois de tudo acima.
