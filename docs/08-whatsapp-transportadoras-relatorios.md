# Fase 8 — WhatsApp Cloud API, transportadoras por API e relatórios avançados

Documentação oficial consultada em 13/11/2026. Nada aqui foi chamado contra os serviços reais: falta conta,
credenciais e HTTPS (ver [TESTES-PENDENTES.md](TESTES-PENDENTES.md)).

## 1. WhatsApp Cloud API (Meta) — o que a documentação confirma

Fonte: developers.facebook.com/documentation/business-messaging/whatsapp (send-messages, webhooks/create-webhook-endpoint,
webhooks/reference/messages, getting-opt-in, catalogs/spm-template-messages).

- **Envio**: `POST https://graph.facebook.com/{versão}/{PHONE_NUMBER_ID}/messages`, `Authorization: Bearer …`, JSON com
  `messaging_product: "whatsapp"`, `recipient_type: "individual"`, `to`, `type`. Exemplos atuais usam `v27.0`
  (versão configurável). Resposta `messages[0].id` (wamid) = **aceito**, não entregue; a entrega vem por webhook.
- **Modelo (template)**: `type: "template"`, `template: { name, language: { code }, components: [{ type: "body",
  parameters: [{ type: "text", parameter_name, text }] }] }` (parâmetros nomeados).
- **Janela de atendimento**: 24 h a partir da última mensagem do cliente. Dentro dela, texto livre; fora, só modelo
  aprovado.
- **Opt-in**: obrigatório antes de enviar. Deve dizer claramente que a pessoa aceita receber mensagens **e o nome da
  empresa**; pode ser coletado no site; pode ser por categoria (ex.: atualizações do pedido). Dar instrução de como
  sair e respeitar.
- **Webhook**: verificação por `GET` com `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge` (responder 200 com o
  challenge). Avisos por `POST` com `X-Hub-Signature-256: sha256=<HMAC-SHA256(app secret, corpo cru)>`. Responder 200;
  reenvio por até 7 dias, **duplicados acontecem** (deduplicar). Certificado TLS válido (sem autoassinado).
- **Payload**: `entry[].changes[].value` com `metadata.phone_number_id`, `contacts[].wa_id`/`profile.name`,
  `messages[] {from, id, timestamp, type, text.body}` e `statuses[] {id, status: sent|delivered|read|failed,
  timestamp, recipient_id, errors}`.

### Decisões

- **Só avisos do pedido** (categoria utilidade): pagamento confirmado, pronto para retirada, despachado (com rastreio).
  Nada de marketing.
- **Opt-in por pedido**: caixa desmarcada no checkout e no aceite do orçamento, com o texto "Quero receber
  atualizações deste pedido pelo WhatsApp da {nome da loja}. Para parar, responda SAIR." Grava data e texto aceito.
  Cliente que responde "SAIR"/"PARAR" entra numa lista de bloqueio (por hash do número) e não recebe mais nada.
- **Modelos** são criados e aprovados no WhatsApp Manager por você; no painel só se informa o **nome** e o idioma de
  cada evento. Evento sem modelo configurado não envia. Parâmetros nomeados que o código preenche: `nome`, `pedido`,
  `rastreio` (este só no despacho).
- **Fila no banco** (`whatsapp_messages`): uma mensagem por (pedido, evento) — repetir o evento não duplica. Envio na
  rotina de 60 s com novas tentativas espaçadas; situação atualizada pelos webhooks.
- **Caixa de entrada** no painel: mensagens recebidas (deduplicadas pelo `id`), resposta em texto livre **só dentro da
  janela de 24 h** (o botão some fora dela).
- `WHATSAPP_FAKE=true` simula (só desenvolvimento). O `wa.me` da Fase 6 continua como está.

## 2. Transportadoras por API

O plano prevê cotação por API. **A escolha do provedor é sua.** Proposta: **Melhor Envio** (um contrato só cota
várias transportadoras, incluindo Correios e Jadlog), atrás de uma interface de provedor que permite trocar.

O que a documentação oficial confirma (docs.melhorenvio.com.br, "Cálculo de fretes por produtos" e "Autenticação"):

- `POST https://melhorenvio.com.br/api/v2/me/shipment/calculate` (sandbox: `https://sandbox.melhorenvio.com.br/…`),
  headers `Accept`/`Content-Type: application/json`, `Authorization: Bearer`, e **`User-Agent` obrigatório** com nome
  da aplicação e e-mail de contato técnico.
- Corpo: `from.postal_code`, `to.postal_code`, `products[] {id, width, height, length (cm), weight (kg),
  insurance_value (R$), quantity}`, opcional `services` ("1,2,18").
- Resposta: lista com `id`, `name`, `custom_price`, `custom_delivery_time`, `company.name` (usar os `custom_*`, que
  já têm as condições da conta). Erro 422 com `message` e `errors`.
- Autenticação OAuth2 (aplicativo no painel do Melhor Envio), token válido por 30 dias, renovação por refresh token.
  **Os endpoints exatos de autorização e renovação não foram encontrados na documentação pública consultada**: por
  isso o token entra pelo `.env` e a renovação fica pendente de conferir (TESTES-PENDENTES).

### Decisões

- Forma de entrega nova do tipo **transportadora**: você cadastra no painel o serviço (código do serviço no
  provedor), nome exibido e prazo extra de separação. Na loja, com CEP, aparece com o preço e o prazo cotados.
- Itens enviados como produtos: dimensões e peso **da variação** (unidade base) × quantidade em unidades base. O
  provedor faz o empacotamento. Produto sem peso ou medidas → a transportadora não aparece (como já acontece com
  frete por peso). Seguro = valor dos itens.
- Cotação guardada 30 min (`shipping_quote_cache`): o checkout usa o mesmo preço que o cliente viu e não chama a API
  de novo. Provedor fora do ar → só as formas próprias (retirada, entrega local) aparecem.
- **Etiqueta, compra do frete e rastreio automático ficam fora** desta entrega (compra é dinheiro saindo da conta:
  decisão sua). O despacho continua registrando transportadora e código de rastreio à mão.
- `CARRIER_FAKE=true` simula (só desenvolvimento).

## 3. Relatórios avançados

Base: pedidos pagos (pago, separando, pronto, despachado, entregue) pela data do pagamento, horário de Brasília.

- **Vendas por dia ou mês**: pedidos, faturamento, ticket médio, frete, desconto.
- **Por canal** (loja, balcão, Mercado Livre, Shopee) e **por forma de pagamento**.
- **Produtos**: quantidade, faturamento, custo e margem. Custo = custo médio na baixa do estoque (pedidos
  despachados) ou custo médio atual (pedidos ainda não despachados) — estimativa, não substitui a contabilidade.
- **Curva ABC** por faturamento: A até 80% acumulado, B até 95%, C o resto.
- Exportação CSV de cada tabela. Permissão `reports.view`.
