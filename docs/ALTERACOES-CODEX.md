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
