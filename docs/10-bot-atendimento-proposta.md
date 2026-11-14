# Bot de atendimento no WhatsApp — proposta para aprovação

Pedido de 14/11/2026: ter disponíveis as três formas de bot (menu, Typebot e IA) e estudar o **Gemini 3.5 Flash-Lite**
como a IA das respostas. **Nada foi instalado, contratado ou ativado.** Pela diretriz de integrações, a cobrança do
Gemini, a instalação do Typebot no VPS e a ativação da Cloud API dependem da sua autorização expressa.

## 1. Resumo

- **É possível usar o Gemini 3.5 Flash-Lite.** O modelo é estável, aceita chamada de funções (function calling) e
  saída estruturada, e é o mais barato da linha 3.5.
- **Testes no plano gratuito, clientes só no pago.** Decisão de 14/11/2026: a IA começa com a chave gratuita para os
  testes e passa para o plano pago depois de tudo testado e alinhado. No gratuito, o Google usa as conversas para
  melhorar os produtos dele e os termos permitem revisão humana. Por isso, **enquanto a chave for gratuita, a IA só
  responde em conversas de teste** (seção 4.4) e os clientes reais ficam com o menu.
- **Custo estimado do plano pago:** cerca de US$ 0,0015 por resposta. Com 2.000 respostas por mês, uns US$ 3. É uma
  estimativa, não um preço fechado (seção 4.4).
- **As três formas ficam atrás de um único "motor de atendimento" na API da loja.** O webhook da Meta continua
  chegando só na loja, e você escolhe no painel qual forma responde. Também dá para combinar: menu primeiro e IA só
  para "outra dúvida".
- **Dá para programar e testar tudo antes de criar a conta na Meta,** com simuladores e um chat de teste no painel.

## 2. O que já existe

| Peça | Situação |
|---|---|
| Cloud API (`apps/api/src/lib/whatsapp.ts`) | Envia modelo e texto, confere assinatura e verificação do webhook. Tem simulador. Nunca ligada na Meta. |
| Webhook (`modules/whatsapp.ts`) | Grava mensagens recebidas (`whatsapp_inbound`, sem duplicar), atualiza situação dos envios, trata "SAIR". |
| Caixa de entrada no painel | Lista conversas e responde texto livre dentro da janela de 24 h. |
| Fila de avisos | `whatsapp_messages`, rotina de 60 s com novas tentativas. |

O que falta para o bot: mensagens **interativas** (botões e listas), **estado da conversa** (em que passo o cliente
está, se está com o bot ou com um atendente) e o próprio motor.

## 3. Arquitetura

```mermaid
flowchart LR
  WA[(WhatsApp)] <--> META[Cloud API da Meta]
  META -->|webhook| API[API da loja]
  API --> MOTOR{Motor de atendimento}
  MOTOR -->|modo menu| MENU[Regras e textos do painel]
  MOTOR -->|modo typebot| TB[Typebot 127.0.0.1]
  MOTOR -->|modo IA| GEM[Gemini API]
  MOTOR -->|atendente| PAINEL[Caixa de entrada do painel]
  MENU & TB & GEM --> FERR[Consultas da loja: pedido, produtos, dados da loja]
```

**Regras que valem para as três formas**
1. "SAIR"/"PARAR" continua tendo prioridade sobre tudo.
2. **Falar com atendente** está sempre disponível. A conversa passa para o painel e o bot fica em silêncio até o
   atendente encerrar.
3. **Fora do horário de atendimento,** o bot avisa quando a loja volta a responder. O horário é cadastrado no painel.
4. **Consulta de pedido só para o dono:** o bot só mostra um pedido se o número que está escrevendo for o mesmo do
   pedido. Sem isso, qualquer pessoa consultaria pedidos de outros.
5. **O bot não altera nada:** não cria pedido, não dá desconto, não cancela, não muda endereço. Para isso, transfere
   para um atendente.
6. **O webhook responde 200 na hora.** A resposta do bot é processada logo em seguida, fora da requisição, sem
   duplicar (pelo `id` da mensagem). A rotina de 60 s reprocessa o que tiver falhado.
7. Tudo o que o bot envia fica gravado na conversa, visível no painel.

**Banco (migração nova)**

| Tabela | Conteúdo |
|---|---|
| `whatsapp_conversations` | Telefone, situação (`bot`, `atendente`, `encerrada`), forma ativa, passo atual, contexto (jsonb), atendente responsável, datas. |
| `bot_settings` | Linha única: forma ativa, horário de atendimento, textos do menu, limites da IA. |
| `ai_usage` | Por dia: chamadas, tokens de entrada e de saída, custo estimado. Sem o texto das conversas. |

As respostas do bot entram na `whatsapp_messages` como `kind = 'text'` ou `'interactive'`.

## 4. As três formas

### 4.1 Mensagens interativas (base das três)

A Cloud API tem dois tipos interativos, conforme o guia oficial de mensagens interativas:

- **Botões de resposta:** até 3 botões numa mensagem.
- **Lista:** um botão que abre uma lista de opções, com escolha de uma só por vez. Os limites exatos de linhas e
  caracteres serão conferidos na documentação da Meta no momento de programar.

O que muda no código:
- o envio ganha `sendInteractive`;
- o webhook passa a ler `interactive.button_reply` e `interactive.list_reply`, que hoje são ignorados por não serem
  texto;
- o simulador ganha os dois tipos.

### 4.2 Forma 1: menu (regras fixas)

- **Custo:** R$ 0.
- **Instalação:** nada novo no servidor.
- **Menu inicial em lista:** acompanhar meu pedido, pedir orçamento, horário e endereço, outra dúvida, falar com
  atendente.
- **Pedido:** o cliente digita o número, e o bot responde a situação, a forma de entrega e o rastreio (se houver).
- **Orçamento:** envia o link da loja ou transfere para um atendente.
- **Horário e endereço:** vêm do cadastro da empresa que já existe.
- **No painel:** os textos são editáveis, com prévia, como os modelos de e-mail.

### 4.3 Forma 2: Typebot

- **O que é:** um editor visual de fluxos, de arrastar e soltar, em que você monta conversas sem programação.
- **Licença:** Functional Source License (FSL), que vira Apache 2.0 depois de dois anos. Permite o uso para a própria
  empresa; não permite revender nem hospedar para terceiros.
- **Componentes:** dois apps Next.js (*builder*, o editor, e *viewer*, que roda as conversas) e um PostgreSQL. A
  documentação traz instalação manual, **sem Docker**. Isso importa, porque Docker não deve entrar neste VPS (seção
  1.2 da proposta 09).
- **Como liga na loja:** a loja conversa com o *viewer* pela **Chat API** do Typebot (`startChat` e
  `continueChat`).
  - As escolhas do fluxo viram botões ou listas no WhatsApp.
  - **Não** se usa a integração nativa de WhatsApp do Typebot. Ela tomaria o webhook da Meta, e a loja perderia a
    caixa de entrada, o "SAIR" e os avisos de pedido.
- **Dados da loja no fluxo:** o bloco *HTTP Request* do Typebot chama um endpoint interno da loja, só em
  `127.0.0.1` e com token. O telefone do cliente vai preenchido pela loja, não digitado: assim vale a regra 4.
- **No servidor:**
  - *builder* em `bot.embalagemcanoinhas.com.br`, com certificado por `certbot --webroot` e nginx próprio;
  - *viewer* só em `127.0.0.1`;
  - entrada no editor por link enviado por e-mail, usando o SMTP que a loja já tem;
  - **banco próprio do Typebot**, com usuário próprio, sem usar as tabelas da loja (regra de não compartilhar
    bancos);
  - dois serviços systemd.
- **Memória:** os dois apps Next.js devem usar algumas centenas de MB. O VPS tem cerca de 5,5 GB livres. A memória é
  medida antes e depois da instalação.
- **Pontos a conferir na instalação:** versão do Node exigida, variáveis de ambiente e passo a passo da instalação
  manual. A página consultada não traz esses detalhes, que estão nas páginas específicas.

### 4.4 Forma 3: IA com Gemini 3.5 Flash-Lite

**O que a documentação oficial confirma (consultada em 14/11/2026)**
- **Modelo:** código `gemini-3.5-flash-lite`, situação **estável**.
- **Limites:** 1.048.576 tokens de entrada e 65.536 de saída.
- **Recursos:** aceita chamada de funções, saída estruturada, raciocínio (*thinking*) e cache de contexto.
- **Preço no plano pago (padrão):** US$ 0,30 por milhão de tokens de entrada e US$ 2,50 por milhão de tokens de
  saída, **com os tokens de raciocínio contando como saída**. Entrada em cache: US$ 0,03 por milhão.
- **Plano gratuito:** existe, mas "usado para melhorar nossos produtos: **sim**". No pago, **não**. Pelos termos, o
  uso só é "pago" num projeto do Google Cloud com faturamento ativo. Versões anteriores dos termos permitem revisão
  humana das conversas no gratuito e desaconselham enviar dados pessoais.
- **Conclusão:** para mensagens de clientes, **só o plano pago**.

**Modo gratuito (testes) e modo pago (clientes)**

| | Modo gratuito | Modo pago |
|---|---|---|
| Chave | Gratuita, criada no Google AI Studio, sem faturamento | Projeto do Google Cloud com faturamento ativo |
| Quem a IA atende | **Só** o chat de teste do painel e os números da lista de teste (`bot.test_phones`, cadastrada no painel) | Todos os clientes |
| Clientes reais | Recebem o menu, como se a IA estivesse desligada | Recebem a IA |
| Custo | R$ 0 | Seção de estimativa abaixo |
| Limites | Os limites de uso do plano gratuito do Google. Ao estourar, o teste mostra o erro e o menu assume | Limite mensal em dólares no painel |

- **A troca é uma opção no painel,** `Plano da chave: gratuito / pago`, com verificação em duas etapas e registro na
  auditoria. A chave paga é trocada no `.env`.
- **Nos testes, use só dados de teste:** pedidos e nomes fictícios. Não teste com o pedido de um cliente real.
- Antes da troca para o pago ficam valendo os itens desta seção: limite mensal, política de privacidade e sua
  autorização de custo.

**Como a IA responde sem inventar**
- **A IA não acessa o banco.** Ela pede uma "ferramenta" (função) e a loja decide o que entregar. As ferramentas são
  só de leitura:

  | Ferramenta | O que devolve |
  |---|---|
  | `consultar_pedido(numero)` | Situação, entrega e rastreio. Só se o telefone bater com o do pedido (regra 4). |
  | `buscar_produtos(termo)` | Nome, embalagem, preço com faixas por quantidade, disponível ou sob encomenda. Só produtos ativos na loja. |
  | `dados_da_loja()` | Horário, endereço, formas de entrega e pagamento, vindos do cadastro. |
  | `transferir_atendente(motivo)` | Passa a conversa para o painel. |

- **Instrução fixa** (que você aprova antes):
  - responder só com o que as ferramentas devolveram;
  - nunca inventar preço, prazo, estoque ou política;
  - na dúvida, transferir para um atendente;
  - respostas curtas e em português.
- **O texto do cliente é tratado como dado, não como ordem.** Como nenhuma ferramenta altera nada e a consulta de
  pedido é presa ao telefone, um cliente que tente "enganar" a IA não consegue ver dados de outros nem mudar
  pedidos.
- **O que vai para o Google:** só o necessário. As últimas mensagens da conversa (no máximo 10) e o primeiro nome do
  cliente. CPF, endereço e e-mail nunca são enviados.
- **Raciocínio no nível mais baixo,** porque cada token de raciocínio é cobrado como saída.

**Controle de custo**
- **Limite mensal em dólares no painel,** por exemplo US$ 10. A loja soma o custo pelos tokens que a própria
  resposta do Gemini informa. Ao atingir o limite, a IA se desliga sozinha e o menu assume.
- **Limite por conversa:** por exemplo, 20 respostas da IA por dia por número. Depois disso, transfere para um
  atendente.
- **Alerta de orçamento no Google Cloud,** configurado por você, como segunda trava.

**Estimativa de custo**

| Item | Conta |
|---|---|
| Uma resposta | Uns 3.000 tokens de entrada (instrução, ferramentas, histórico) e 250 de saída: 3.000 × 0,30/1M + 250 × 2,50/1M ≈ **US$ 0,0015** |
| 2.000 respostas por mês | ≈ US$ 3 |
| 10.000 respostas por mês | ≈ US$ 15 |

O valor real depende do tamanho das conversas. O painel mostra o custo acumulado.

**LGPD**
- A política de privacidade da loja precisa dizer que as mensagens do WhatsApp podem ser processadas pelo Google
  (Gemini API) para responder o cliente.
- Eu não escrevo texto jurídico: o texto é seu, ou do seu contador ou advogado.
- A IA só é ligada depois disso.

**Integração técnica**
- `POST` na Gemini API (`generateContent`) com a chave no cabeçalho, nunca na URL.
- O formato exato da chamada e das funções é conferido na documentação oficial no momento de programar.
- Adaptador próprio na API, como os outros provedores, com simulador para testes sem custo.
- Chave em `GEMINI_API_KEY` no `.env`; o modelo em `GEMINI_MODEL`, para trocar sem mudar o código.

## 5. Painel

**Tela "Atendimento" (nova), dentro de WhatsApp:**
- forma ativa: menu, Typebot, IA, ou menu com IA para "outra dúvida";
- horário de atendimento;
- textos do menu;
- instrução da IA (só leitura, com o texto aprovado);
- limites e custo da IA no mês.

**Chat de teste:** conversar com o bot dentro do painel, sem WhatsApp e sem gastar mensagem da Meta. Na forma IA, o
chat de teste gasta tokens do Gemini e conta no limite.

**Caixa de entrada:**
- mostra quem está com o bot e quem está com atendente;
- tem um botão "Assumir conversa" e outro "Devolver ao bot".

**Permissões:**
- `bot.manage` para mudar a forma ativa, os textos e os limites, com verificação em duas etapas;
- `sales_desk.use`, que já existe, para atender.

## 6. Etapas

| Etapa | Entrega | Custo | Depende de |
|---|---|---|---|
| 1 | Mensagens interativas, estado da conversa, motor, forma **menu**, chat de teste, transferência para atendente, testes | R$ 0 | Sua aprovação deste plano |
| 2 | Forma **IA** com Gemini: adaptador, ferramentas, limites, custo no painel, modo gratuito só para testes, testes com o simulador | R$ 0 | Etapa 1 |
| 2a | Testar a IA com a **chave gratuita**: chat de teste do painel e números de teste | R$ 0 | Você criar a chave gratuita no Google AI Studio e colocar no `.env` |
| 2b | Trocar para o **plano pago** e liberar para os clientes | Cobrança do Google | Testes da 2a aprovados, sua autorização de custo, conta Google Cloud com faturamento, texto da política de privacidade |
| 3 | Instalar o **Typebot** no VPS e a forma Typebot na loja | R$ 0 de licença; memória do VPS | Sua autorização para instalar o serviço |
| 4 | Ativar a Cloud API da Meta (passos já combinados) | Cobrança da Meta por mensagem de modelo | Sua autorização de custo |

As etapas 1 a 3 funcionam com o simulador do WhatsApp. A 4 pode vir antes ou depois.

## 7. Decisões que preciso de você

1. **Aprova o plano e a etapa 1** (menu, sem custo)?
2. ~~Gemini no plano pago~~ **Decidido em 14/11/2026:** testes com a chave gratuita, restrita a conversas de teste;
   o plano pago fica para depois dos testes. O limite mensal (sugestão: US$ 10) é decidido na troca.
3. **Typebot no VPS:** autoriza instalar os dois serviços, o banco próprio e o subdomínio `bot.`?
4. **Forma padrão** depois de tudo pronto: só menu, só IA, ou menu com IA para "outra dúvida" (sugestão: menu com IA)?
5. **Horário de atendimento** da loja, para o aviso fora do horário.
6. **Política de privacidade:** quem escreve o trecho sobre o processamento das mensagens pela IA?

## 8. Fontes (consultadas em 14/11/2026)

- Gemini, preços: aistudio.google.com/docs/pricing (redirecionado de ai.google.dev/gemini-api/docs/pricing).
- Gemini, modelos: aistudio.google.com/docs/models e aistudio.google.com/docs/models/gemini-3.5-flash-lite.
- Gemini, termos: ai.google.dev/gemini-api/terms.
- WhatsApp, mensagens interativas: developers.facebook.com/docs/whatsapp/guides/interactive-messages e
  developers.facebook.com/docs/whatsapp/cloud-api/reference/messages.
- Typebot, instalação própria: docs.typebot.com/self-hosting/get-started.
- Typebot, Chat API: docs.typebot.com/deploy/api/overview.
- Typebot, bloco HTTP Request: docs.typebot.com/editor/blocks/integrations/http-request.
