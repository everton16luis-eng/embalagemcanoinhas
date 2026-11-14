# E-mail da loja

A loja usa o servidor de e-mail que já existe no VPS (Postfix + Dovecot + OpenDKIM, o mesmo do portal e do
barbasystem). Não há custo nem serviço externo. Duas partes:

- **Envio.** A API envia pelo SMTP `mail.portalplanaltonorte.com.br:587` com STARTTLS obrigatório, autenticando
  como `nao-responda@embalagemcanoinhas.com.br`. O código não configura o servidor de e-mail: conecta como um
  cliente qualquer.
- **Caixas pelo painel.** Painel → **E-mails** cria e altera as caixas `@embalagemcanoinhas.com.br`. Isso passa pelo
  script `deploy/email/loja-contas-email.py`, adaptado do script do portal.

## Painel → E-mails

Permissões:

| Permissão | O que libera | Quem tem por padrão |
|---|---|---|
| `email.view` | Ver a tela | Proprietário e gerente |
| `email.manage` | Remetente, Reply-To, textos, teste de conexão e de envio | Proprietário |
| `email.accounts` | Criar, trocar senha, suspender, excluir caixas e apelidos | Proprietário |

`email.manage` e `email.accounts` exigem verificação em duas etapas.

A tela tem três abas.

**Caixas de e-mail**
- Lista as caixas e o espaço ocupado por cada uma.
- Cria caixas (com gerador de senha), troca senha, suspende, reativa e exclui.
- Cria, altera e exclui apelidos.
- Mostra os dados para configurar a caixa no celular ou no Outlook.

**Envio e textos**
- Mostra a situação do SMTP.
- Testar conexão.
- Enviar e-mail de teste, só para quem pediu e no máximo 5 por hora.
- Nome do remetente e "Responder para".
- Textos dos e-mails, com prévia e opção de voltar ao padrão.

**Histórico**
- Cada envio, com data, tipo, domínio do destinatário (`***@gmail.com`), assunto, situação e código de erro.
- Nunca guarda o texto, links ou tokens.
- Ninguém altera nem apaga o histórico (gatilho no banco).

Toda alteração vai para a Auditoria. As senhas das caixas nunca vão para o banco, para o log ou para a auditoria.

### O que a loja envia hoje

| E-mail | Para quem | Quando |
|---|---|---|
| Redefinição de senha do painel | A própria pessoa | Em "Esqueci minha senha", na entrada do painel. |
| Teste de envio | Quem clicou | Botão na aba Envio e textos. |

**Redefinição de senha do painel**
- A resposta é sempre a mesma e o envio não é aguardado: nem o texto nem o tempo de resposta revelam se o e-mail tem
  conta.
- O link vale 30 minutos e é de uso único.
- O token vai no fragmento (`#token=`), que o navegador não envia a nenhum servidor.

Ainda não há e-mail para clientes da loja (recuperação de senha do cliente, avisos de pedido). Isso fica para uma
etapa seguinte.

## Por que um script próprio da loja

O script do portal enxerga todos os domínios do servidor. Usado pela loja, ele deixaria um usuário do painel da loja
alterar as caixas do portal. O da loja é uma cópia adaptada. O original continua como está.

**O que ele enxerga e altera**
- Só endereços `@embalagemcanoinhas.com.br`. O domínio está fixo no arquivo instalado pelo root, que o painel não
  consegue alterar.
- Caixas e apelidos de outros domínios não aparecem e são recusados.
- O destino de um apelido pode ser externo, como um Gmail.

**Como a API chega até ele**
- Não usa sudo: a API continua com `NoNewPrivileges` e `ProtectSystem=strict`.
- A API conversa com o socket `loja-contas-email.socket` do systemd.
- Para cada pedido, o systemd roda o script como root, com escrita só nos arquivos do Postfix/Dovecot.
- Só o grupo `loja` abre o socket.

**Proteções**
- Usa a mesma trava (`/run/lock/portal-contas-email.lock`) do script do portal, para os dois nunca gravarem ao mesmo
  tempo.
- A senha chega só pelo socket. Vira hash `{SHA512-CRYPT}` pelo `openssl passwd -6 -stdin`.
- Antes de cada alteração, guarda a versão anterior do arquivo em `<arquivo>.loja-bak`.

**Detalhes das ações**
- **Excluir caixa:** move as mensagens para `/var/mail/vhosts-excluidas/embalagemcanoinhas.com.br/<nome>-<data>`, sem
  apagar.
- **Caixa que recebe apelidos:** não é excluída; altere os apelidos antes.
- **Caixa do `SMTP_USER`:** a loja usa essa caixa para enviar, então ela não pode ser suspensa nem excluída pelo
  painel.

## Variáveis do `.env`

| Variável | Valor em produção | Observação |
|---|---|---|
| `SMTP_HOST` | `mail.portalplanaltonorte.com.br` | O certificado do servidor de e-mail só cobre esse nome. Vazio desliga o envio. |
| `SMTP_PORT` | `587` | |
| `SMTP_SECURE` | `false` | `false` com a porta 587 exige STARTTLS antes do login. |
| `SMTP_USER` | `nao-responda@embalagemcanoinhas.com.br` | |
| `SMTP_PASS` | senha da caixa `nao-responda@` | **Secreta**: digite direto no servidor. |
| `MAIL_FROM` | `"Embalagem Canoinhas <nao-responda@embalagemcanoinhas.com.br>"` | Mesmo endereço do login. O nome pode ser trocado no painel. |
| `EMAIL_ACCOUNTS_SOCKET` | `/run/loja-contas-email.sock` | Liga a aba Caixas de e-mail. Vazio desliga. |
| `EMAIL_WEBMAIL_URL` | opcional | Aparece nas instruções das caixas, se existir um webmail para a loja. |
| `SMTP_TIMEOUT_MS` | `15000` | Opcional. |

O nome que aparece no assunto vem de Marca da loja (nome da loja).

## Configurar no servidor

Rode os comandos como root (ou com sudo). Antes de cada passo, confira o arquivo existente. Os arquivos do Postfix e
do OpenDKIM são compartilhados com o portal e o barbasystem: só acrescente linhas, nunca apague.

### 1. Domínio no Postfix

Veja o formato das linhas que já existem:

```bash
cat /etc/postfix/virtual_domains
```

Acrescente o domínio da loja no mesmo formato. Exemplo, se as linhas forem `dominio OK`:

```bash
echo "embalagemcanoinhas.com.br OK" >> /etc/postfix/virtual_domains
```

```bash
postmap /etc/postfix/virtual_domains && systemctl reload postfix
```

### 2. Chave DKIM

O OpenDKIM do servidor usa o seletor `mail`, com uma pasta de chave por domínio. Gere a chave da loja:

```bash
mkdir -p /etc/opendkim/keys/embalagemcanoinhas.com.br
```

```bash
opendkim-genkey -b 2048 -d embalagemcanoinhas.com.br -D /etc/opendkim/keys/embalagemcanoinhas.com.br -s mail
```

```bash
chown -R opendkim:opendkim /etc/opendkim/keys/embalagemcanoinhas.com.br && chmod 600 /etc/opendkim/keys/embalagemcanoinhas.com.br/mail.private
```

Veja onde ficam as tabelas de chaves e as linhas do barbasystem, para copiar o formato:

```bash
grep -E "^(KeyTable|SigningTable|InternalHosts|TrustedHosts)" /etc/opendkim.conf
```

```bash
grep -r "barbasystem" /etc/opendkim/
```

Em cada arquivo que tiver uma linha do barbasystem, acrescente a linha equivalente da loja, trocando o domínio e a
pasta da chave. Depois:

```bash
systemctl restart opendkim && systemctl status opendkim --no-pager | head -5
```

### 3. DNS na Hostinger

No painel da Hostinger, em DNS do domínio `embalagemcanoinhas.com.br`:

| Tipo | Nome | Valor | Prioridade |
|---|---|---|---|
| MX | `@` | `mail.portalplanaltonorte.com.br` | 10 |
| TXT | `@` | `v=spf1 mx ~all` | |
| TXT | `mail._domainkey` | o conteúdo entre aspas de `/etc/opendkim/keys/embalagemcanoinhas.com.br/mail.txt`, juntado numa linha só | |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:postmaster@embalagemcanoinhas.com.br` | |

Para ver a chave pública:

```bash
cat /etc/opendkim/keys/embalagemcanoinhas.com.br/mail.txt
```

O DMARC começa com `p=none`, como no barbasystem. Depois de confirmar SPF, DKIM e DMARC com resultado PASS num
e-mail recebido no Gmail ("Mostrar original"), passe para `p=quarantine`.

### 4. Script das caixas e socket

Na pasta do projeto, depois de atualizar o código:

```bash
install -o root -g root -m 755 /srv/loja-embalagens/deploy/email/loja-contas-email.py /usr/local/sbin/loja-contas-email
```

```bash
cp /srv/loja-embalagens/deploy/systemd/loja-contas-email.socket "/srv/loja-embalagens/deploy/systemd/loja-contas-email@.service" /etc/systemd/system/
```

```bash
systemctl daemon-reload && systemctl enable --now loja-contas-email.socket
```

Conferir, como o usuário `loja`. A resposta deve ter `"ok": true`, `"dominio_atendido": true` e nenhuma caixa de
outro domínio:

```bash
printf '{"acao":"info"}' | sudo -u loja nc -U -N /run/loja-contas-email.sock
```

Depois de cada atualização do repositório, repita o `install` para o script instalado acompanhar a versão nova.

### 5. Ligar no `.env` e criar as caixas

Ligue a aba Caixas acrescentando ao `.env` da loja:

```bash
echo "EMAIL_ACCOUNTS_SOCKET=/run/loja-contas-email.sock" >> /srv/loja-embalagens/.env
```

```bash
systemctl restart loja-api
```

No painel (proprietário, com verificação em duas etapas), em E-mails → Caixas de e-mail:

1. Crie `nao-responda@` com "Gerar" senha. Copie a senha para usar no `.env`.
2. Crie `contato@`, a caixa que recebe e responde.
3. Crie os apelidos `postmaster@` e `abuse@`, entregando em `contato@`.

### 6. Ligar o envio

Edite o `.env` e preencha `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` e `MAIL_FROM` com os
valores da tabela acima. A senha é a da caixa `nao-responda@`.

```bash
nano /srv/loja-embalagens/.env
```

```bash
systemctl restart loja-api
```

No painel, em E-mails → Envio e textos:
- clique "Testar conexão";
- depois clique "Enviar e-mail de teste";
- abra o e-mail recebido no Gmail → "Mostrar original" e confira SPF, DKIM e DMARC = PASS.

Por fim, teste "Esqueci minha senha" na entrada do painel.

### Erros comuns

Erros no log (`journalctl -u loja-api -n 100 --no-pager`) e no Histórico:

| Código | Causa provável |
|---|---|
| `EAUTH` / 535 | Usuário ou senha do SMTP errados. |
| `ESOCKET` com certificado | `SMTP_HOST` diferente de `mail.portalplanaltonorte.com.br`. |
| 553 / "Sender address rejected" | `MAIL_FROM` diferente da caixa do login. |
| "O servidor de e-mail não respondeu" na aba Caixas | Socket parado: `systemctl status loja-contas-email.socket` e `journalctl -u 'loja-contas-email@*' -n 50`. |
