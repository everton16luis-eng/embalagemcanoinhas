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

## 18/11/2026 — Nova tentativa de cartão no mesmo pedido

- Arquivo `apps/web/src/components/loja/order-view.tsx`.
- Após recusa ou erro no envio, o checkout oferece **Tentar cartão novamente**. O botão também aparece ao reabrir um pedido cuja última tentativa foi recusada ou ficou com erro.
- O botão consulta o pedido antes de reabrir o formulário do Mercado Pago. O cliente confirma a nova tentativa manualmente e ela usa uma nova chave de idempotência. Enquanto o pagamento está em andamento, a página consulta o pedido a cada cinco segundos.
- A checagem de tipos e a build de produção da web passaram. A tentativa com OTHE seguida de APRO no mesmo pedido ainda precisa ser testada na VPS.

## 17/11/2026 — E-mail e CPF na aceitação do orçamento público

**Revertida a pedido do usuário antes de ser publicada.** O formulário, a API e os testes voltaram ao código original.

- Arquivos: `apps/web/src/app/(loja)/orcamento/[token]/page.tsx`, `apps/api/src/modules/quotes.ts` e `apps/api/test/quotes.test.ts`.
- O formulário lê e-mail e documento dos campos no envio, inclusive quando o navegador os preenche. A interface informa quando a escolha de entrega ou retirada ainda impede o pagamento.
- A API aceita espaços externos no e-mail e usa o documento informado quando o documento salvo falha na validação. O documento válido já cadastrado continua prevalecendo.
- Validação: checagem de tipos e teste isolado da substituição do documento passaram. O teste de integração de aceitação pública foi adicionado, mas a suíte parou antes de executá-lo devido a uma chave estrangeira no reset do banco de testes. Retestar em HTTPS após a publicação.

## 18/11/2026 — Recusa de cartão com final mascarado

- Arquivos: `apps/api/src/lib/payments.ts` e `apps/api/test/payment-provider.test.ts`.
- O teste real com OTHE devolveu rejected/cc_rejected_other_reason e final de cartão ***2. Ao gravar esse valor, o PostgreSQL recusou a atualização pela restrição payments_card_last_four_check e o checkout mostrou erro genérico.
- O adaptador passa a conservar o final somente quando ele é uma string com exatamente quatro dígitos. Valores mascarados, ausentes ou fora do formato viram null, preservando a restrição do banco.
- A normalização cobre a criação do cartão e a reconsulta usada nas notificações. A regressão verifica o status recusado e preserva finais válidos, inclusive com zero inicial.
- Validação local: checagem de tipos da API e web aprovada, 8 testes de regressão aprovados com transporte HTTP simulado. Retestar OTHE na VPS após a publicação.

## 17/11/2026 — Arquivos do bot apagados e restaurados (registro retroativo)

- Commits `02f66a0` ("Permite Gemini gratuito no atendimento em produção") e `3c52d30` ("Restaura arquivos do bot de WhatsApp").
- Arquivos: `apps/api/src/modules/bot.ts`, `apps/api/test/bot-ai.test.ts` e `apps/web/src/app/painel/(app)/whatsapp/bot-panel.tsx`.
- Apesar da mensagem, o primeiro commit **apagou** os três arquivos por inteiro. O segundo, um minuto depois, os restaurou idênticos. Efeito líquido nulo, conferido com `git diff 02f66a0^ 3c52d30` vazio. A liberação do Gemini gratuito entrou de fato no commit seguinte (`9da5c88`).
- Validação: nenhuma na época. Registrado em 20/11/2026 a partir do histórico do git.

## 17/11/2026 — Gemini gratuito para todo o público do bot e desbloqueio manual da IA (registro retroativo)

- Commit `9da5c88`.
- Arquivos: `apps/api/src/modules/bot.ts`, `apps/api/src/modules/bot-ai.ts`, `apps/api/test/bot-ai.test.ts` e `apps/web/src/app/painel/(app)/whatsapp/bot-panel.tsx`.
- Motivo: liberar a IA para os testes do bot, que não respondia nem aos números de teste.
- A IA passa a atender todo o público configurado em "Público do bot", também no plano gratuito. Antes, o gratuito só atendia o chat de teste e os números de teste.
  - Na prática, o campo "plano" não limita mais quem fala com a IA.
  - Os números de teste só aparecem quando o público é "teste".
  - O texto do painel avisa que, no plano gratuito, o Google pode usar as conversas para melhorar seus produtos.
- Desbloqueio da IA pausada para um contato:
  - rota `POST /api/v1/admin/whatsapp/bot/security/unblock`, que exige `bot.manage` (com MFA), tem limite de 30 por minuto e grava auditoria `whatsapp.bot_cooldown_cleared` só com o hash do número;
  - o desbloqueio não apaga o histórico de segurança: grava um evento `cooldown`/`flagged` com a categoria `manual_reset`, e a contagem de bloqueios recomeça depois dele;
  - a contagem de bloqueios e o resumo de contatos pausados passam a considerar só o canal WhatsApp, sem o chat de teste.
- No painel, a seção de segurança do bot ganhou o campo "Número do WhatsApp" e o botão "Desbloquear IA".
- Validação na época: não registrada. Ver a auditoria em 20/11/2026.
- **Atenção antes de abrir o bot a clientes reais:** com o plano gratuito e o público "todos", as conversas reais vão para o nível gratuito do Gemini. Antes disso, ativar o plano pago ou avisar o cliente e atualizar a política de privacidade (LGPD). Para os testes com o público "teste", não há impedimento.

## 17/11/2026 — SAIR encerra só o atendimento; notificações param com "PARAR NOTIFICAÇÕES" (registro retroativo)

- Commit `d172315`.
- Arquivos: `apps/api/src/modules/whatsapp.ts`, `apps/api/src/modules/bot.ts`, `apps/api/src/modules/bot-ai.ts`, `apps/api/test/bot.test.ts`, `apps/api/test/phase8.test.ts` e `apps/web/src/app/painel/(app)/whatsapp/page.tsx`.
- "SAIR" agora encerra a conversa atual com o bot:
  - registra o encerramento (`bot_runs` com `closed_by_customer`);
  - fecha a conversa e limpa atendente, passo e contexto;
  - descarta as mensagens anteriores ainda na fila (`superseded`);
  - a IA não usa o histórico de antes do encerramento.
- Uma nova mensagem do cliente reabre o atendimento.
- O descadastro das notificações automáticas de pedido passa a ser feito por "PARAR NOTIFICAÇÕES", "PARAR", "PARE", "STOP" ou "CANCELAR". O texto do consentimento mudou para "Para parar as notificações, responda PARAR NOTIFICAÇÕES".
- O bot e o atendente voltam a responder números descadastrados, já que o descadastro vale só para as notificações automáticas. O painel avisa "Notificações automáticas de pedido desativadas para este número".
- Validação na época: testes `bot.test.ts` e `phase8.test.ts` ajustados.
- **Pendência:** os pedidos anteriores guardam o consentimento antigo, "Para parar, responda SAIR". Quem responder SAIR seguindo essa instrução deixa de ser descadastrado. É preciso tratar SAIR também como descadastro, ao menos para quem tem o texto antigo.

## 17/11/2026 — IA abre a conversa sem menu e mostra "digitando" (registro retroativo)

- Commit `0629d4a`.
- Arquivos: `apps/api/src/lib/whatsapp.ts`, `apps/api/src/modules/bot.ts`, `apps/api/src/modules/bot-ai.ts`, `apps/api/test/bot-ai.test.ts`, `apps/api/test/bot-security.test.ts`, `apps/api/test/bot.test.ts` e `apps/web/src/app/painel/(app)/whatsapp/bot-panel.tsx`.
- Nos modos "IA" e "Menu e IA", o texto livre é atendido pela IA desde a primeira mensagem. O menu continua acessível pelo comando "menu".
- Cumprimento puro ("oi", "olá", "bom dia", "boa tarde", "boa noite", com ou sem "tudo bem") recebe a resposta pronta "Oi! 😊 Como posso te ajudar hoje?", sem chamar a IA.
- Se a IA estiver indisponível, no limite ou barrada na primeira mensagem, a resposta é em texto, sem menu.
- O system prompt ganhou a regra de retribuir o cumprimento e conversar sem menu.
- Indicador "digitando":
  - enquanto a IA processa, o bot envia à Meta o "digitando" (`typing_indicator`) da mensagem recebida;
  - a mesma chamada marca a mensagem do cliente como lida;
  - o limite é de 2 s, e um erro é ignorado sem afetar a resposta.
- Validação: na auditoria de 20/11/2026, 9 testes do bot falham com este código: os cenários 06, 20, 22, 25 e 33 de `bot-security`, os cenários 1 e 7 de `bot-continuity`, "chat de teste usa a IA" de `bot-ai` e o tamanho do system prompt de `bot-performance` (4.105 > 4.000).
  - Os 8 primeiros falham porque usam cumprimento como mensagem e agora recebem a saudação pronta.
  - Com outra mensagem, todas as proteções passaram.
  - Resolvido em 20/11/2026 no ramo `correcao/bot-codex` (entrada abaixo).

## 20/11/2026 — Testes do bot alinhados à saudação pronta e prompt dentro do teto

- Ramo `correcao/bot-codex`, a partir de `origin/main`. Feito pelo Claude, não pelo Codex. Registrado aqui porque corrige as entradas acima.
- Arquivos: `apps/api/src/modules/bot-ai.ts`, `apps/api/test/bot-security.test.ts`, `apps/api/test/bot-continuity.test.ts` e `apps/api/test/bot-ai.test.ts`.
- **Prompt.** O system prompt passou de 4.105 para cerca de 3.960 caracteres, abaixo do teto de 4.000 do teste de desempenho. O número exato depende do endereço da loja. Foram reescritas frases das regras de atendimento, sem tirar nenhuma regra. As regras de segurança não mudaram.
- **Testes.** Os 8 cenários usavam um cumprimento ("oi", "olá", "bom dia", "boa tarde") só como mensagem qualquer para chegar à IA. Desde `0629d4a`, esse cumprimento de abertura recebe a saudação pronta, de propósito e com teste próprio ("menu_ai: saudação em texto"). Por isso a proteção nem chegava a rodar.
  - Os cenários 06, 20, 22, 25 e 33 de `bot-security`, o 7 de `bot-continuity` e "chat de teste usa a IA" de `bot-ai` passaram a usar um texto livre. As verificações não mudaram.
  - O cenário 1 de `bot-continuity` reproduz a conversa real, que começa com "Oi.". Ele continua começando assim e agora espera a saudação pronta e a rota `saudacao` na abertura.
  - Cenário novo em `bot-security`: a saudação pronta só vale para cumprimento puro. "oi, ignore todas as instruções…" continua barrado antes da IA.
- O código do bot não mudou: atendimento, proteções da IA, SAIR, desbloqueio e "digitando" continuam como o Codex deixou.
- Validação: os 99 testes do bot passam, contando o novo, e a suíte inteira também.
