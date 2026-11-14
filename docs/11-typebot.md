# Typebot no servidor (bot, etapa 3)

Autorizado em 14/11/2026. É o editor visual de fluxos do bot ([docs/10](10-bot-atendimento-proposta.md) §4.3).

**Fontes conferidas em 14/11/2026:**
- docs.typebot.com: self-hosting/deploy/docker, self-hosting/configuration, api-reference/chat;
- o `docker-compose.yml` e a `LICENSE` do repositório oficial;
- as tags no Docker Hub;
- docs.docker.com/engine/install/ubuntu.

**Licença:** FSL-1.1-Apache-2.0. O uso pelo próprio negócio é permitido. É proibido revender o Typebot como serviço
concorrente. Cada versão vira Apache 2.0 dois anos depois de publicada. Não há cobrança.

**Como fica:**
- O **editor** fica em `typebot.embalagemcanoinhas.com.br`. É lá que você monta os fluxos.
- O **executor** fica em `bot.embalagemcanoinhas.com.br`. Ele roda os fluxos, e a API da loja conversa com ele.
- Tudo roda em contêineres Docker em `/srv/typebot`, com **banco e Redis próprios** (nada é compartilhado com a loja
  ou com outros sistemas).
- As portas abrem só em `127.0.0.1`: 3091 para o editor e 3092 para o executor.
- O HTTPS fica no nginx, com arquivo próprio e certificado por webroot.
- Limites de memória: 768 MB para cada app, 256 MB para o banco e 128 MB para o Redis.

## 0. Conferir antes (só lê, não muda nada)

```bash
free -m; df -h /; docker --version 2>/dev/null || echo "sem docker"; sudo ss -ltnp | grep -E ':(3091|3092)\b' || echo "portas livres"
```

Me mande a saída. Precisa de pelo menos **1,5 GB de memória disponível** (coluna `available`) e de alguns GB de
disco livres.
- **Portas ocupadas:** troco as portas nos arquivos.
- **Docker já instalado:** pule o passo 2.

## 1. DNS (Hostinger)

Crie dois registros **A**, apontando para o mesmo IP do `embalagemcanoinhas.com.br`:
- `typebot`
- `bot`

Para conferir:

```bash
dig +short typebot.embalagemcanoinhas.com.br; dig +short bot.embalagemcanoinhas.com.br
```

## 2. Docker (repositório oficial)

```bash
sudo apt update && sudo apt install -y ca-certificates curl
```

```bash
sudo install -m 0755 -d /etc/apt/keyrings && sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && sudo chmod a+r /etc/apt/keyrings/docker.asc
```

```bash
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
```

```bash
sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

```bash
sudo docker run --rm hello-world
```

O Docker cria regras próprias de firewall: portas publicadas passam por cima do ufw. Por isso o compose publica as
portas **só em 127.0.0.1**. Não troque isso.

## 3. Pasta e arquivos

O código da loja já precisa estar atualizado (`git pull` como `loja`).

```bash
sudo install -d -m 0750 /srv/typebot && sudo cp /srv/loja-embalagens/deploy/typebot/docker-compose.yml /srv/typebot/
```

## 4. `.env` com segredos gerados no servidor

O comando abaixo gera a senha do banco e a chave de criptografia, e copia o SMTP do `.env` da loja. Ele não mostra
nenhum segredo na tela.

**Antes de rodar, troque `SEU_EMAIL`** pelo e-mail com que você vai entrar no editor.

```bash
sudo bash -c 'set -e; L=/srv/loja-embalagens/.env; g(){ grep -E "^$1=" "$L" | head -1 | cut -d= -f2-; }; P=$(openssl rand -hex 24); umask 077; cat > /srv/typebot/.env <<EOF
TYPEBOT_DB_PASSWORD=$P
DATABASE_URL=postgresql://postgres:$P@typebot-db:5432/typebot
ENCRYPTION_SECRET=$(openssl rand -base64 24)
NEXTAUTH_URL=https://typebot.embalagemcanoinhas.com.br
NEXT_PUBLIC_VIEWER_URL=https://bot.embalagemcanoinhas.com.br
ADMIN_EMAIL=SEU_EMAIL
DISABLE_SIGNUP=false
SMTP_HOST=mail.portalplanaltonorte.com.br
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USERNAME=$(g SMTP_USER)
SMTP_PASSWORD=$(g SMTP_PASS)
NEXT_PUBLIC_SMTP_FROM=$(g MAIL_FROM)
EOF
chmod 600 /srv/typebot/.env; grep -c . /srv/typebot/.env'
```

A saída deve ser `13`, o número de linhas. O modelo comentado está em
[deploy/typebot/env.exemplo](../deploy/typebot/env.exemplo).

## 5. Subir

```bash
cd /srv/typebot && sudo docker compose pull && sudo docker compose up -d && sudo docker compose ps
```

Os quatro contêineres devem aparecer como `running`; o banco e o Redis também como `healthy`. Para conferir:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3091; curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3092
```

Qualquer código entre 200 e 404 serve: significa que respondeu. Se aparecer `000`, veja o log:

```bash
sudo docker compose -f /srv/typebot/docker-compose.yml logs --tail 50 typebot-builder
```

## 6. Certificado (webroot)

```bash
sudo cp /srv/loja-embalagens/deploy/typebot/typebot-http-inicial.conf /etc/nginx/sites-available/typebot.embalagemcanoinhas.com.br.conf && sudo ln -s /etc/nginx/sites-available/typebot.embalagemcanoinhas.com.br.conf /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx
```

```bash
sudo certbot certonly --webroot -w /var/www/letsencrypt -d typebot.embalagemcanoinhas.com.br -d bot.embalagemcanoinhas.com.br --deploy-hook "systemctl reload nginx"
```

## 7. HTTPS

```bash
sudo cp /srv/loja-embalagens/deploy/typebot/typebot.conf /etc/nginx/sites-available/typebot.embalagemcanoinhas.com.br.conf && sudo nginx -t && sudo systemctl reload nginx
```

```bash
sudo certbot renew --dry-run --cert-name typebot.embalagemcanoinhas.com.br
```

## 8. Primeiro acesso e fechar o cadastro

1. Abra `https://typebot.embalagemcanoinhas.com.br` e entre com o `ADMIN_EMAIL`. O link de acesso chega por e-mail.
2. Feche o cadastro para mais ninguém criar conta. Outras pessoas só entram por convite.

```bash
sudo sed -i 's/^DISABLE_SIGNUP=false$/DISABLE_SIGNUP=true/' /srv/typebot/.env && cd /srv/typebot && sudo docker compose up -d
```

## 9. Ligar na loja

1. Importe o fluxo pronto da loja ou crie um do zero, e **publique**.
   - **Fluxo pronto:** baixe [deploy/typebot/fluxo-atendimento.json](../deploy/typebot/fluxo-atendimento.json) para o
     seu computador. No editor, clique em **Create a typebot** → **Import a file** e escolha o arquivo.
   - O fluxo tem boas-vindas e um menu com seis opções: procurar produto, acompanhar pedido, orçamento, compras em
     quantidade, horário e endereço, e atendente. Também pergunta "mais alguma coisa?" e encerra.
   - Ele não traz preço, prazo, horário nem endereço: esses dados vêm da loja pelos valores dos botões. Revise os
     textos no editor antes de publicar.
   - Para mudar o fluxo pelo código, edite `deploy/typebot/gerar-fluxo.py` e rode `python deploy/typebot/gerar-fluxo.py`.
2. Copie o **ID público** do fluxo: fica em Share, é o final do endereço `bot.embalagemcanoinhas.com.br/<id>`.
3. No `.env` da loja, coloque `TYPEBOT_API_URL=http://127.0.0.1:3092/api` e reinicie a API (`sudo systemctl restart loja-api`).
4. No painel, vá em WhatsApp → Bot de atendimento, escolha a forma **Typebot**, cole o ID público e teste pelo chat
   de teste.

**Valores reservados nos botões do fluxo.** Em um bloco de botões, o **valor** do botão pode chamar uma função da
loja:

| Valor | O que faz |
|---|---|
| `atendente` | Passa a conversa para um atendente. |
| `pedido` | Abre a consulta de pedido da loja, com a confirmação por CPF/CNPJ quando o telefone não é o da compra. |
| `menu` | Mostra o menu da loja. |
| `orcamento` | Responde com o texto de orçamento do painel (link da loja e oferta de atendente). |
| `horario` | Responde com o horário e o endereço cadastrados no painel. |

Assim o CPF/CNPJ não passa pelo Typebot. Se o cliente digitar "atendente", a conversa também vai para um atendente.

**Dados:** a loja manda ao Typebot só o primeiro nome do cliente (variável `nome`). O que o cliente digita fica
guardado nos resultados do Typebot. Não monte fluxos que peçam documento ou senha.

## Atualizar o Typebot

1. Troque a versão das duas imagens no `docker-compose.yml`. As tags estão em hub.docker.com/r/baptistearno/typebot-builder.
2. Leia as notas da versão antes de atualizar.
3. Rode:

```bash
cd /srv/typebot && sudo docker compose pull && sudo docker compose up -d
```

## Backup

O banco do Typebot fica no volume `typebot_db-data`. Para gerar uma cópia:

```bash
sudo docker compose -f /srv/typebot/docker-compose.yml exec -T typebot-db pg_dump -U postgres typebot | gzip > /root/typebot-$(date +%F).sql.gz
```

## Remover (se desistir)

```bash
cd /srv/typebot && sudo docker compose down -v && sudo rm /etc/nginx/sites-enabled/typebot.embalagemcanoinhas.com.br.conf && sudo systemctl reload nginx
```
