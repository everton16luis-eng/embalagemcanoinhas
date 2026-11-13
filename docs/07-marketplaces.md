# Fase 7 — Mercado Livre e Shopee

Documentação oficial consultada em 13/11/2026 (Mercado Livre: developers.mercadolivre.com.br; Shopee: open.shopee.com).
Nada aqui foi testado contra as APIs reais: falta aplicativo cadastrado e conta de vendedor de teste (ver
[TESTES-PENDENTES.md](TESTES-PENDENTES.md)).

## 1. Escopo da V2 (primeira entrega)

| Faz | Não faz (por enquanto) |
|---|---|
| Conectar a conta da loja (OAuth) e renovar tokens sozinho | Criar ou editar anúncios pela API (feito no painel do marketplace) |
| Vincular cada anúncio a uma embalagem de venda do nosso cadastro | Mudar preço pela API (o ML recusa PUT só de preço em anúncios com automação; preço continua lá) |
| Enviar o saldo disponível (em embalagens) para o anúncio | Estoque de anúncio do ML **com variações** (ver §4) |
| Importar vendas pagas como pedido, reservando estoque | Etiqueta, envio e nota pela API do marketplace |
| Cancelar o pedido e liberar o estoque quando a venda é cancelada lá | Responder perguntas e mensagens |

## 2. Mercado Livre (o que a documentação confirma)

- **Autorização**: `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=…&redirect_uri=…&state=…`
  com PKCE (`code_challenge`, `S256`) quando ativado no aplicativo. `redirect_uri` fixa, igual à cadastrada; o
  `state` é nosso e o ML não o valida (nós validamos). Só a conta administradora autoriza (operador recebe
  `invalid_operator_user_id`).
- **Token**: `POST https://api.mercadolibre.com/oauth/token` (form) com `authorization_code` ou `refresh_token`.
  Access token vale **6 horas**; refresh token é **de uso único** (cada renovação devolve outro) e expira em 6 meses.
  Header `Authorization: Bearer …`.
- **Notificações**: POST na URL cadastrada no aplicativo com `resource`, `user_id`, `topic`, `application_id`,
  `attempts`. **Sem assinatura**: o aviso só dispara uma consulta (`GET /orders/{id}`), nunca é tomado como verdade.
  Responder **HTTP 200 em até 500 ms**; reenvio por 1 hora. Tópico usado: `orders_v2`.
- **Pedido**: `GET /orders/{id}`: `status` (`confirmed`, `payment_required`, `payment_in_process`, `partially_paid`,
  `paid`, `partially_refunded`, `pending_cancel`, `cancelled`, `invalid`), `order_items[].item.id`,
  `item.variation_id`, `item.seller_sku`, `quantity`, `unit_price`, `total_amount`, `pack_id`, `buyer.id`.
- **Estoque**: `PUT /items/{id}` com `{"available_quantity": N}` para anúncio sem variação.

## 3. Shopee (o que a documentação confirma)

- **Autorização**: `https://open.shopee.com.br/auth?partner_id=…&auth_type=seller&redirect_uri=…&response_type=code&state=…`
  (Brasil, produção). Volta `code` (uso único, 10 min) e `shop_id`. Autorização vale até 365 dias (o vendedor escolhe).
- **Assinatura das chamadas**: HMAC-SHA256 com a `partner_key`, base `partner_id + caminho + timestamp` (públicas) ou
  `partner_id + caminho + timestamp + access_token + shop_id` (da loja); timestamp vale 5 min; resultado em hex.
- **Token**: `POST /api/v2/auth/token/get` (code) e `POST /api/v2/auth/access_token/get` (refresh). Access token vale
  **4 horas**; refresh token 30 dias e de uso único.
- **Domínio**: `https://partner.shopeemobile.com` (servidor perto de SG) ou `https://openplatform.shopee.com.br`
  (perto dos EUA). Configurável; padrão `partner.shopeemobile.com`.
- **Push**: header `Authorization` = HMAC-SHA256(partner_key, `URL|corpo`), hex. **Verificamos sempre**. Responder 2xx
  com corpo vazio. Pedido: push `order_status` (código 3) → `GET /api/v2/order/get_order_detail?order_sn_list=…&response_optional_fields=item_list,total_amount,buyer_cpf_id`.
- **Status**: `UNPAID`, `INVOICE_PENDING`/`PENDING`, `READY_TO_SHIP`, `PROCESSED`, `SHIPPED`, `TO_CONFIRM_RECEIVE`,
  `COMPLETED`, `TO_RETURN`, `IN_CANCEL`, `CANCELLED`.
- **Estoque**: `POST /api/v2/product/update_stock` com `item_id` e `stock_list[{model_id, seller_stock:[{stock}]}]`
  (`model_id` 0 sem variação). O estoque não pode ficar abaixo do reservado pela Shopee.

## 4. Decisões

- **Um anúncio (ou modelo da Shopee) = uma embalagem de venda nossa.** O saldo enviado é
  `floor(disponível na unidade base / quantidade da embalagem)`, já descontadas reservas. Sob encomenda não envia
  saldo (vínculo marcado como "manual").
- **Anúncio do ML com variação**: a documentação só mostra atualizar variações enviando **todas** de uma vez (as que
  ficam de fora são removidas). Para não apagar variação por engano, o envio automático de saldo fica **desligado**
  nesses vínculos; o pedido é importado normalmente.
- **Venda importada** vira pedido no canal `mercadolivre`/`shopee`, forma de pagamento `marketplace`, já **pago**
  (só importamos com `paid` no ML e a partir de `READY_TO_SHIP` na Shopee), com reserva de estoque. Item sem vínculo
  bloqueia a importação (fica na fila com erro até vincular). Venda cancelada lá cancela o pedido e libera a reserva
  (se ainda não foi despachado; se já foi, só registra para conferência).
- **Idempotência**: uma linha por (conta, id do pedido no marketplace); a chave do nosso pedido é
  `mkt:{canal}:{conta}:{id}`. Aviso repetido, fora de ordem ou perdido não duplica: a fonte é sempre a consulta.
- **Tokens** cifrados (AES-256-GCM com `ENC_KEY`); credenciais do aplicativo (`client_secret`, `partner_key`) só no
  `.env`. Renovação antes de vencer, com trava por conta (refresh de uso único não pode correr duas vezes).
- **Nota fiscal** de venda do marketplace: segue a regra da Fase 5 (emitida por nós). Dados do comprador para a nota
  (CPF/CNPJ, endereço) dependem da API de faturamento de cada marketplace, **ainda não integrada**: até lá a tela
  fiscal aponta o que falta e a emissão fica manual. Decisão com o contador.
- `*_FAKE=true` simula os dois marketplaces (só desenvolvimento).

## 5. Como ficou implementado

**Configuração (`.env`)** — vazio deixa a plataforma desligada:

| Variável | O que é |
|---|---|
| `ML_CLIENT_ID`, `ML_CLIENT_SECRET` | Aplicativo cadastrado no DevCenter do Mercado Livre (PKCE ativado). |
| `ML_REDIRECT_URI` | Opcional. Padrão: `{APP_ORIGIN}/painel/marketplaces/retorno/mercadolivre`. |
| `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY` | App na Shopee Open Platform (partner_key fica só aqui). |
| `SHOPEE_REDIRECT_URI` | Opcional. Padrão: `{APP_ORIGIN}/painel/marketplaces/retorno/shopee`. |
| `SHOPEE_API_HOST`, `SHOPEE_AUTH_HOST` | Padrão `https://partner.shopeemobile.com` e `https://open.shopee.com.br`. |
| `SHOPEE_PUSH_URL` | URL **exata** cadastrada no push (entra na assinatura). Padrão: `{PUBLIC_API_URL}/api/v1/webhooks/marketplaces/shopee`. |
| `MARKETPLACE_FAKE` | `true` simula os dois (recusado em produção). |

**URLs para cadastrar nas plataformas**

- Retorno da autorização: as páginas do painel acima (a pessoa precisa estar logada no painel com
  `marketplaces.manage`; a página repassa `code`/`state` para a API uma vez e limpa a barra de endereço).
- Notificações do Mercado Livre: `{PUBLIC_API_URL}/api/v1/webhooks/marketplaces/mercadolivre`, tópico `orders_v2`.
- Push da Shopee: `{PUBLIC_API_URL}/api/v1/webhooks/marketplaces/shopee`, push de status do pedido.

**Fluxo**

1. *Conectar*: o painel gera `state` (uso único, 15 min, guardado só o hash, preso a quem iniciou) e, no ML, o
   verificador PKCE (cifrado). O retorno troca o código pelo token; tokens gravados cifrados. Reconectar a mesma conta
   reaproveita o registro.
2. *Aviso* chega: grava em `marketplace_notifications` (imutável) e coloca a venda na fila (`marketplace_orders`, uma
   linha por venda). Shopee com assinatura inválida: 401 e nada na fila.
3. *Rotina de 60 s* (`marketplaceTick`): renova tokens que vencem em até 30 min (com a conta travada), consulta até 20
   vendas da fila e envia o saldo dos anúncios cujo valor mudou.
4. *Venda paga*: pedido `paid` no canal do marketplace, forma `marketplace`, preço pago lá, frete 0 (envio é do
   marketplace), sem dados pessoais do comprador. Reserva o estoque como qualquer pedido.
5. Situações da venda: `pending` (na fila), `waiting` (não paga ainda; reconsulta de 5 em 5 min até 6 h),
   `imported`, `error` (sem vínculo, sem estoque, falha de rede: reconsulta com espera crescente; vincular o anúncio
   antecipa), `canceled`, `ignored` (não paga em 30 dias).
6. *Cancelada lá*: cancela o pedido e libera a reserva se ainda não tem NF-e nem foi despachado; senão só registra
   no histórico do pedido para conferência.
7. Pedido de marketplace **não** entra na emissão automática de NF-e ("ao pagar"): os dados do comprador não estão
   aqui.

**Permissão**: `marketplaces.manage` (proprietário e gerente; exige verificação em duas etapas).
