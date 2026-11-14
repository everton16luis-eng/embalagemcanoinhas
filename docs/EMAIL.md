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

### 7. Webmail próprio (`webmail.embalagemcanoinhas.com.br`)

É o mesmo Roundcube do portal e do barbasystem (`/var/www/roundcube`), com o endereço e a marca da loja. Os arquivos
são copiados dos do barbasystem, que já funcionam, trocando só o domínio. Os arquivos do portal, do barbasystem e do
CloudPanel não são alterados.

**a) DNS na Hostinger.** Crie um registro A `webmail` com o mesmo IP de `webmail.barbasystem.com.br`:

```bash
dig +short A webmail.barbasystem.com.br @8.8.8.8
```

Espere até este comando responder o mesmo IP:

```bash
dig +short A webmail.embalagemcanoinhas.com.br @8.8.8.8
```

**b) Certificado.** Primeiro um arquivo nginx só para o desafio do certbot:

```bash
cp /srv/loja-embalagens/deploy/email/webmail-http-inicial.conf /etc/nginx/sites-available/webmail.embalagemcanoinhas.com.br.conf
```

```bash
ln -s /etc/nginx/sites-available/webmail.embalagemcanoinhas.com.br.conf /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx
```

```bash
certbot certonly --webroot -w /var/www/letsencrypt -d webmail.embalagemcanoinhas.com.br
```

Nunca use `certbot --nginx`: ele altera os arquivos do CloudPanel.

**c) Arquivo nginx definitivo**, copiado do barbasystem:

```bash
sed 's/barbasystem\.com\.br/embalagemcanoinhas.com.br/g; s/barbasystem/embalagemcanoinhas/g' /etc/nginx/sites-available/webmail.barbasystem.com.br.conf > /tmp/webmail-loja.conf
```

Confira a diferença. Só podem mudar nomes de domínio, caminhos do certificado e nomes de log:

```bash
diff /etc/nginx/sites-available/webmail.barbasystem.com.br.conf /tmp/webmail-loja.conf
```

```bash
mv /tmp/webmail-loja.conf /etc/nginx/sites-available/webmail.embalagemcanoinhas.com.br.conf && nginx -t && systemctl reload nginx
```

Se o `nginx -t` falhar, nada é recarregado. Volte ao arquivo temporário do item b e me mande o erro.

**d) Marca da loja no Roundcube.** Copie a marca do barbasystem:

```bash
sed 's/barbasystem\.com\.br/embalagemcanoinhas.com.br/g' /var/www/roundcube/config/barbasystem.inc.php > /var/www/roundcube/config/embalagemcanoinhas.inc.php
```

Abra o arquivo e troque os nomes que ainda forem do barbasystem (por exemplo `product_name`) por `Embalagem Canoinhas`:

```bash
nano /var/www/roundcube/config/embalagemcanoinhas.inc.php
```

```bash
chown --reference=/var/www/roundcube/config/barbasystem.inc.php /var/www/roundcube/config/embalagemcanoinhas.inc.php && chmod --reference=/var/www/roundcube/config/barbasystem.inc.php /var/www/roundcube/config/embalagemcanoinhas.inc.php
```

Ligue a marca ao endereço. Faça um backup e veja a linha do barbasystem:

```bash
cp -a /var/www/roundcube/config/config.inc.php /var/www/roundcube/config/config.inc.php.loja-bak && grep -n "include_host_config" -A6 /var/www/roundcube/config/config.inc.php
```

Abra o arquivo e, logo abaixo da linha `'webmail.barbasystem.com.br' => 'barbasystem.inc.php',`, acrescente:

```
    'webmail.embalagemcanoinhas.com.br' => 'embalagemcanoinhas.inc.php',
```

```bash
nano /var/www/roundcube/config/config.inc.php
```

```bash
php -l /var/www/roundcube/config/config.inc.php && php -l /var/www/roundcube/config/embalagemcanoinhas.inc.php
```

Os dois têm que responder `No syntax errors detected`. Se um deles falhar, volte o backup com
`cp -a /var/www/roundcube/config/config.inc.php.loja-bak /var/www/roundcube/config/config.inc.php`.

**e) Endereço no painel.** As instruções das caixas passam a mostrar o webmail:

```bash
grep -q "^EMAIL_WEBMAIL_URL=" /srv/loja-embalagens/.env || echo "EMAIL_WEBMAIL_URL=https://webmail.embalagemcanoinhas.com.br" >> /srv/loja-embalagens/.env
```

```bash
systemctl restart loja-api
```

**Conferir:**
- abra `https://webmail.embalagemcanoinhas.com.br`: o cadeado aparece e a tela mostra o nome da loja;
- entre com `contato@embalagemcanoinhas.com.br` e a senha da caixa;
- `https://webmail.barbasystem.com.br` continua com a marca do barbasystem.

O certificado renova sozinho pelo timer do certbot. Para confirmar:

```bash
certbot renew --dry-run --cert-name webmail.embalagemcanoinhas.com.br
```

### Erros comuns

Erros no log (`journalctl -u loja-api -n 100 --no-pager`) e no Histórico:

| Código | Causa provável |
|---|---|
| `EAUTH` / 535 | Usuário ou senha do SMTP errados. |
| `ESOCKET` com certificado | `SMTP_HOST` diferente de `mail.portalplanaltonorte.com.br`. |
| 553 / "Sender address rejected" | `MAIL_FROM` diferente da caixa do login. |
| "O servidor de e-mail não respondeu" na aba Caixas | Socket parado: `systemctl status loja-contas-email.socket` e `journalctl -u 'loja-contas-email@*' -n 50`. |
