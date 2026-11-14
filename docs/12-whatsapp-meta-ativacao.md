# Ativar a API oficial do WhatsApp (Meta) — etapa 4

Autorizado em 14/11/2026. O código já está pronto desde a Fase 8 ([docs/08](08-whatsapp-transportadoras-relatorios.md)):
envio, webhook, caixa de entrada, avisos do pedido e bot. Falta a conta da Meta e as credenciais. Quase tudo aqui é
feito por você nos sites da Meta, porque a criação de contas e os tokens são seus.

Fontes conferidas em 14/11/2026, todas em developers.facebook.com/documentation/business-messaging/whatsapp:
- business-phone-numbers/registration;
- solution-providers/manage-webhooks (subscribed_apps);
- pricing.

## Custos (leia antes)

A Meta cobra **por mensagem entregue**, conforme a categoria. Mensagens que o cliente manda não são cobradas.

| O que | Custo desde 01/10/2026 |
|---|---|
| **Respostas de atendimento** (bot e atendente, dentro das 24 h depois da mensagem do cliente) | **1.000 por mês grátis por número.** Depois disso, cobradas. |
| **Modelos de utilidade** (avisos do pedido: pagamento confirmado, pronto, despachado) | **Cobrados sempre**, inclusive dentro das 24 h. |
| Marketing e autenticação | Cobrados. A loja não usa. |

- **Sem forma de pagamento cadastrada:** as 1.000 mensagens grátis continuam saindo. Depois delas, a Meta para de
  entregar.
- **Como fica configurado:** os **avisos do pedido ficam desligados** até você autorizar o custo e cadastrar os
  modelos no painel (sem modelo cadastrado, o aviso não sai).
- **Respostas do bot:** cada resposta conta. Algumas respostas são 2 mensagens, como o pedido mais os botões.
- **Preços por país:** estão no WhatsApp Manager → Visão geral → Preços.

## 1. Antes de começar

- O servidor precisa estar atualizado com as migrações até a `0016` (TESTES-PENDENTES, item do servidor).
- **Número:** ele não pode estar ativo no app WhatsApp ou WhatsApp Business. Se estiver, apague a conta do WhatsApp no
  app antes. Isso perde o histórico do app. Outra opção é usar um número novo que receba SMS ou ligação.
- Tenha em mãos os dados da empresa: razão social, CNPJ, endereço e site.

## 2. Portfólio empresarial

Em **business.facebook.com**, crie o portfólio da loja com os dados da empresa. Se já existir um, use o mesmo.

## 3. App da Meta

1. Em **developers.facebook.com** → Meus apps → **Criar app**.
2. Escolha o caso de uso de **WhatsApp** (conectar com clientes) e ligue o app ao portfólio do passo 2.
3. No painel do app, abra **WhatsApp → Configuração da API** e **adicione o número da loja**:
   - nome de exibição: o nome da loja (a Meta aprova);
   - categoria: a da empresa;
   - verificação: código por SMS ou ligação.
4. Anote dois IDs, que aparecem na mesma tela:
   - **Identificação do número de telefone** (é o `WA_PHONE_NUMBER_ID`);
   - **Identificação da conta do WhatsApp Business** (WABA).

## 4. Token permanente (usuário do sistema)

1. Em **business.facebook.com** → Configurações → Usuários → **Usuários do sistema**, adicione um usuário do sistema
   com função **Administrador**.
2. Em **Atribuir ativos**, dê a ele o **app** do passo 3 e a **conta do WhatsApp**, com controle total.
3. Clique em **Gerar token**:
   - app: o do passo 3;
   - validade: **nunca expira**;
   - permissões: `whatsapp_business_messaging` e `whatsapp_business_management`.
4. Copie o token. Ele aparece uma vez só. **Não mande o token por chat ou e-mail.**

O **segredo do app** fica em: painel do app → Configurações do app → Básico → Chave secreta do app.

## 5. `.env` da loja no servidor

Abra o arquivo com o editor e cole os três valores no final. Não use `echo`, porque o token ficaria no histórico do
terminal.

```bash
sudo -u loja nano /srv/loja-embalagens/.env
```

```
WA_PHONE_NUMBER_ID=<identificação do número>
WA_ACCESS_TOKEN=<token do passo 4>
WA_APP_SECRET=<chave secreta do app>
```

O token de verificação do webhook é gerado pelo servidor:

```bash
sudo bash -c 'grep -q "^WA_VERIFY_TOKEN=" /srv/loja-embalagens/.env || echo "WA_VERIFY_TOKEN=$(openssl rand -hex 24)" >> /srv/loja-embalagens/.env' && sudo systemctl restart loja-api
```

Para ver o token e colar no passo 6, rode o comando abaixo. É o único momento em que ele aparece na tela.

```bash
sudo grep "^WA_VERIFY_TOKEN=" /srv/loja-embalagens/.env | cut -d= -f2-
```

## 6. Webhook

1. No painel do app, abra **WhatsApp → Configuração** → Webhook → **Editar**.
2. Preencha:
   - **URL de retorno:** `https://embalagemcanoinhas.com.br/api/v1/webhooks/whatsapp`
   - **Token de verificação:** o valor do passo 5.
3. Clique em **Verificar e salvar**. A loja responde ao desafio da Meta.
4. Em **Campos do webhook**, assine o campo **messages**.

## 7. Registrar o número na Cloud API

O registro é feito só por API. Escolha um **PIN de 6 dígitos** e guarde: ele vira a verificação em duas etapas do
número. Troque `123456` no comando abaixo. O comando lê o token do `.env`, sem mostrá-lo.

A Meta limita o registro a 10 tentativas por número a cada 72 h.

```bash
sudo bash -c 'E=/srv/loja-embalagens/.env; T=$(grep "^WA_ACCESS_TOKEN=" $E | cut -d= -f2-); I=$(grep "^WA_PHONE_NUMBER_ID=" $E | cut -d= -f2-); curl -sS "https://graph.facebook.com/v27.0/$I/register" -H "Authorization: Bearer $T" -H "Content-Type: application/json" -d "{\"messaging_product\":\"whatsapp\",\"pin\":\"123456\"}"; echo'
```

Resposta esperada: `{"success":true}`.

## 8. Inscrever o app na conta do WhatsApp

Sem este passo, as mensagens dos clientes não chegam ao webhook. Troque `WABA_ID` pela identificação da conta do
passo 3.

```bash
sudo bash -c 'T=$(grep "^WA_ACCESS_TOKEN=" /srv/loja-embalagens/.env | cut -d= -f2-); curl -sS -X POST "https://graph.facebook.com/v27.0/WABA_ID/subscribed_apps" -H "Authorization: Bearer $T"; echo; curl -sS "https://graph.facebook.com/v27.0/WABA_ID/subscribed_apps" -H "Authorization: Bearer $T"; echo'
```

A primeira resposta deve ser `{"success":true}`. A segunda deve listar o app.

## 9. Testar (bot só com o seu número)

1. No painel da loja, vá em WhatsApp → Bot de atendimento e escolha **Só números de teste**. Coloque o seu celular
   e salve.
2. Do seu celular, mande "oi" para o número da loja. Devem acontecer duas coisas:
   - a mensagem aparece em WhatsApp → Conversas;
   - o bot responde com a lista de opções.
3. Siga os itens "HTTPS" do bot em [TESTES-PENDENTES.md](TESTES-PENDENTES.md): lista, botões, atendente, SAIR e
   resposta pelo painel.
4. Só depois de testar, mude para **Ligado para todos**.

**Avisos do pedido:** cadastre os modelos no WhatsApp Manager e os nomes no painel só depois de autorizar o custo dos
modelos de utilidade.

## Se der errado

| Sintoma | Causa provável |
|---|---|
| "Verificar e salvar" falha | A API não foi reiniciada depois do `.env`, ou o token colado não é igual ao do arquivo. |
| Mensagem do cliente não aparece no painel | Faltou o passo 8, ou o campo `messages` no passo 6. |
| Mensagem aparece, mas o envio falha | Token sem as permissões do passo 4, ou número não registrado (passo 7). Veja o erro na conversa. |
| Erro `133016` | Excesso de tentativas de registro: espere 72 h. |
