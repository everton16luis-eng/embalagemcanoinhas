# Auditoria de segurança — alterações do Codex (17 e 18/11/2026)

Feita em 20/11/2026. Só leitura: nenhum código do Codex foi alterado, e nada foi executado na VPS.

## Escopo

`docs/ALTERACOES-CODEX.md` registra 5 entradas, das quais uma foi revertida. O GitHub (`origin/main`, depois de
`394e0ab`) tem **10 commits**. Os 5 primeiros abaixo não aparecem no registro:

| Commit | Assunto | No registro? |
|---|---|---|
| `02f66a0` | Gemini gratuito no atendimento em produção | não |
| `3c52d30` | Restaura arquivos do bot de WhatsApp | não |
| `9da5c88` | Libera Gemini gratuito e desbloqueio da IA | não |
| `d172315` | SAIR encerra só o atendimento atual | não |
| `0629d4a` | IA abre a conversa sem menu e mostra "digitando" | não |
| `8a233bc`, `fe3cffe` | Identificador dos erros do Mercado Pago | sim |
| `32da07b` | Formato do vencimento do Pix | sim |
| `d73dd65` | Final de cartão mascarado | sim |
| `a802078` | Nova tentativa de cartão no mesmo pedido | sim |

Foram auditados os 14 arquivos alterados: pagamentos, WhatsApp, bot, IA do bot, painel do WhatsApp, página do pedido
na loja e testes. Também rodei a suíte da API sobre esse código.

## Resultado

Não há falha de injeção, de permissão, de vazamento de credencial nem de cobrança nova introduzida pelas alterações.
As mudanças no Mercado Pago estão corretas. Há **dois pontos de privacidade e consentimento** que precisam de decisão,
**uma rede de testes de segurança quebrada** e um risco antigo que a nova tela de cartão deixa mais à mão.

### 1. ALTA — Conversas de clientes reais vão para o Gemini gratuito (LGPD)

**Onde.** `apps/api/src/modules/bot.ts`, em `handleOne`: `aiAllowed = isAiMode(settings.mode)`.

**O que mudou.** Antes, no plano gratuito, a IA só atendia o chat de teste e os números de teste. O motivo estava
escrito no próprio painel: no nível gratuito, o Google pode usar as conversas para melhorar os produtos dele. Agora a
IA atende **todos os clientes** com o plano gratuito. O campo "plano" virou só um rótulo e não limita mais nada.

**Impacto.** O texto livre dos clientes e o resultado das consultas de pedido feitas pela IA vão para um serviço que
pode reutilizar o conteúdo:

- nome;
- número e situação do pedido;
- itens e quantidades;
- o que o cliente escrever, inclusive dados pessoais.

O documento (CPF/CNPJ) continua oculto antes de ir para a IA, e o e-mail do cliente não é enviado (o teste 33
confere). Mesmo assim, o resto é compartilhamento de dado pessoal com terceiro para finalidade do terceiro. Isso pede
base legal e transparência ao titular: aviso na conversa e na política de privacidade.

**Recomendação.** Decidir entre:

- (a) voltar a trava: gratuito só para teste, como antes;
- (b) ativar o plano pago, em que o Google não usa o conteúdo;
- (c) manter o gratuito com aviso explícito ao cliente na primeira mensagem e na política de privacidade.

A (b) é a mais limpa.

### 2. MÉDIA — "SAIR" deixou de desligar as notificações já consentidas

**Onde.** `apps/api/src/modules/whatsapp.ts`: `STOP_WORDS` e `optinText`.

**O que mudou.** "SAIR" agora só encerra a conversa com o bot. Quem desliga as notificações de pedido passou a ser
"PARAR NOTIFICAÇÕES", "PARAR", "PARE", "STOP" ou "CANCELAR".

**Impacto.** Os pedidos feitos antes da mudança guardam no consentimento (`orders.whatsapp_optin_text`) a frase
"Para parar, responda SAIR". Quem seguir essa instrução não é mais descadastrado e continua recebendo avisos de pedido.
A promessa feita no consentimento deixa de ser cumprida, o que contraria a LGPD e a política da Meta.

**Recomendação.** Continuar tratando "SAIR" como pedido de parar as notificações, além de encerrar o atendimento. Uma
alternativa mais estreita é tratá-lo assim só para quem tem pedido com o texto antigo de consentimento.

### 3. MÉDIA — A suíte de ataques do bot está vermelha e deixou de testar o que testava

**Onde.** `test/bot-security.test.ts` (cenários 06, 20, 22, 25 e 33) e `test/bot-continuity.test.ts` (1 e 7).

**O que acontece.** O bot agora responde um cumprimento puro ("oi", "olá", "bom dia, tudo bem?") com uma saudação
pronta, sem chamar a IA. Esses cenários usavam cumprimentos como mensagem de ataque, então a proteção nem chega a ser
exercitada e o teste falha.

**Verificação.** Rodei cópias temporárias desses testes trocando o cumprimento por "quero ver caixas". **Todos
passaram:**

- segredo na resposta é barrado;
- uma sessão não vê a outra;
- mensagem e chamada repetidas rodam uma vez só;
- o erro gravado sai sem segredo;
- ferramenta não autorizada é negada.

Ou seja, as proteções continuam funcionando.

**Impacto.** Com a suíte vermelha, uma regressão real de segurança no bot passaria despercebida.

**Recomendação.** Trocar as mensagens desses cenários por texto que não seja só cumprimento e acrescentar um cenário
próprio para a saudação pronta.

### 4. BAIXA (antigo, agora mais à mão) — Possível cobrança dupla depois de "falha na comunicação"

**Onde.** `apps/web/src/components/loja/order-view.tsx`, botão "Tentar cartão novamente".

**O que acontece.** Quando a chamada ao Mercado Pago cai por tempo ou rede, o pagamento fica `error`, mas a cobrança
pode ter sido feita do lado do provedor. A nova tentativa usa outra chave de idempotência, então o Mercado Pago não a
reconhece como repetição. O servidor barra uma segunda tentativa enquanto houver pagamento `created`, `pending` ou
`approved`, mas não enquanto houver um `error`.

Esse risco já existia, porque o formulário reaparecia antes. Agora a nova tentativa está a um clique.

**Recomendação.** Antes de liberar nova tentativa sobre um pagamento `error`, reconsultar o Mercado Pago pela
referência externa do pedido.

### 5. BAIXA — Atendente e bot falam com quem pediu para parar

**O que mudou.** O painel deixou de recusar mensagem manual para número com opt-out, e o bot voltou a responder esses
números.

**Avaliação.** Dentro da janela de 24 h aberta pelo próprio cliente, isso é aceito pela Meta, e o painel agora deixa
claro que só as notificações automáticas estão desligadas. É aceitável, desde que o item 2 seja corrigido.

### 6. BAIXA — "Digitando" marca a mensagem do cliente como lida

**Onde.** `CloudApiProvider.showTyping` envia `status: 'read'`.

**Avaliação.** O cliente passa a ver o sinal de lida assim que a IA começa a processar. Não é falha de segurança; só
fica o registro.

### 7. PROCESSO

- **Registro incompleto.** 5 dos 10 commits (bot, Gemini, WhatsApp) não estão em `ALTERACOES-CODEX.md`, que diz
  registrar toda alteração.
- **Publicação direta.** Os commits foram direto para `origin/main`, fora do fluxo de ramo e revisão.
- **Divergência.** A `main` local tem 6 commits de documentação que não estão no GitHub, e o GitHub tem os 10 do
  Codex. A integração da Fase 4 vai precisar juntar as duas, com merge, sem rebase e sem force push.

## Conferido e sem problema

- **Mercado Pago:**
  - o identificador `x-request-id` vai só para o log, cortado em 128 caracteres;
  - o final do cartão só é gravado com exatamente 4 dígitos;
  - o vencimento do Pix representa o mesmo instante.
- **Desbloqueio da IA:**
  - exige `bot.manage`, que pede MFA;
  - tem limite de 30 por minuto;
  - é auditado (só o hash do número);
  - não apaga o histórico de segurança: grava um marco de liberação, e a contagem recomeça depois dele.
- **"SAIR" que encerra a conversa:**
  - só vale para mensagem nova, e o reenvio do mesmo webhook não repete;
  - as comparações por `id` são seguras, porque `whatsapp_inbound.id` é sequencial (`bigserial`);
  - a mensagem antiga na fila é descartada como `superseded`.
- **Indicador "digitando":** limite de 2 s e erro ignorado, sem afetar a resposta.
- **Nova tentativa de cartão:** o servidor mantém a trava de pagamento em andamento e o limite de 5 tentativas por
  pedido.

## Testes rodados

A suíte da API sobre o código atual tem 381 testes, dos quais **9 falham**, todos do bot:

- os 7 do item 3;
- `bot-ai` "chat de teste usa a IA", pelo mesmo motivo da saudação;
- `bot-performance` "tamanho do System Prompt" (4.105 > 4.000 caracteres), porque o Codex acrescentou uma regra ao
  prompt.

Nenhuma dessas falhas indica proteção desligada; a verificação está no item 3.
