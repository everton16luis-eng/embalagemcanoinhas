# Registro de alterações no código pelo Codex

Toda alteração no código feita pelo Codex deve ser registrada neste arquivo. Cada entrada informa a data, os arquivos alterados, o motivo e as validações feitas.

## 17/11/2026 — Identificador do Mercado Pago nos erros do Pix

- Arquivo: `apps/api/src/lib/payments.ts`.
- O adaptador registra o cabeçalho `x-request-id` da resposta do Mercado Pago como `providerRequestId` no erro. O identificador ajuda o suporte a localizar a chamada que retornou `500 internal_error`. O log recebe apenas esse identificador adicional.
- O primeiro envio (`8a233bc`) introduziu uma referência incorreta na URL do provedor. A correção restaura a variável `path` e mantém o registro do identificador.
- Validação: checagem de tipos e resposta simulada de HTTP 500 com o identificador. A confirmação no provedor depende de nova tentativa com as credenciais de teste na VPS.

## 17/11/2026 — Formato de vencimento no Pix do Mercado Pago

- Arquivo: `apps/api/src/lib/payments.ts`.
- O vencimento enviado para `POST /v1/payments` passa a usar a saída direta de `toISOString()`, com sufixo `Z`, igual ao adaptador da Barbearia. O prazo mínimo da loja continua em 31 minutos e o timestamp representa o mesmo instante.
- A Barbearia foi confirmada pelo responsável como funcional em teste e produção. O ajuste isola a diferença de serialização para investigar o HTTP 500 persistente da loja.
- Validação local: checagem de tipos e captura simulada do JSON de criação de Pix, com confirmação do vencimento esperado e leitura do QR Code. O efeito no ambiente de teste do Mercado Pago ainda precisa ser verificado na VPS.

## 18/11/2026 — Recusa de cartão com final mascarado

- Arquivos: `apps/api/src/lib/payments.ts` e `apps/api/test/payment-provider.test.ts`.
- O teste real com OTHE devolveu rejected/cc_rejected_other_reason e final de cartão ***2. Ao gravar esse valor, o PostgreSQL recusou a atualização pela restrição payments_card_last_four_check e o checkout mostrou erro genérico.
- O adaptador passa a conservar o final somente quando ele é uma string com exatamente quatro dígitos. Valores mascarados, ausentes ou fora do formato viram null, preservando a restrição do banco.
- A normalização cobre a criação do cartão e a reconsulta usada nas notificações. A regressão verifica o status recusado e preserva finais válidos, inclusive com zero inicial.
- Validação local: checagem de tipos da API e web aprovada, 8 testes de regressão aprovados com transporte HTTP simulado. Retestar OTHE na VPS após a publicação.

## 18/11/2026 — Nova tentativa de cartão no mesmo pedido

- Arquivo `apps/web/src/components/loja/order-view.tsx`.
- Após recusa ou erro no envio, o checkout oferece **Tentar cartão novamente**. O botão também aparece ao reabrir um pedido cuja última tentativa foi recusada ou ficou com erro.
- O botão consulta o pedido antes de reabrir o formulário do Mercado Pago. O cliente confirma a nova tentativa manualmente e ela usa uma nova chave de idempotência. Enquanto o pagamento está em andamento, a página consulta o pedido a cada cinco segundos.
- A checagem de tipos e a build de produção da web passaram. A tentativa com OTHE seguida de APRO no mesmo pedido ainda precisa ser testada na VPS.
