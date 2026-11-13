# Implantação no servidor (Ubuntu)

Roteiro para subir a V1 num servidor Ubuntu sem interface. Os arquivos de apoio ficam em [`deploy/`](../deploy).
Nada aqui foi executado num servidor real ainda: os itens de conferência estão em
[TESTES-PENDENTES.md](TESTES-PENDENTES.md).

Arquitetura: nginx (HTTPS) → Next.js `127.0.0.1:3047` (loja e painel; repassa `/api` para a API) → API
`127.0.0.1:4010` → PostgreSQL próprio da loja `127.0.0.1:54330`. Nenhuma porta da aplicação fica aberta para fora;
o banco não é compartilhado com outros sistemas do servidor.

## 1. Pré-requisitos

- Node.js 22.12 ou superior, instalado de forma que `/usr/bin/node` exista. Se ficar em outro caminho, ajuste o
  `ExecStart` dos arquivos `deploy/systemd/*.service`.
- Binários do PostgreSQL 16, 17 ou 18 (`/usr/lib/postgresql/<versão>/bin`). O script cria um cluster próprio da loja;
  o serviço PostgreSQL que já existir no servidor não é usado nem alterado.
- nginx e um certificado TLS para o domínio (ex.: certbot).
- Memória: medir a RAM livre antes (a API e o Next juntos usam algumas centenas de MB).

## 2. Usuário e código

```bash
sudo useradd --system --create-home --home-dir /srv/loja --shell /usr/sbin/nologin loja
```

Copie o código para `/srv/loja-embalagens` (por `git clone` do repositório ou cópia da pasta, sem `.env`, `.local`,
`node_modules`, `storage` e `backups` da máquina de desenvolvimento) e deixe tudo com dono `loja`:

```bash
sudo chown -R loja:loja /srv/loja-embalagens
```

Daqui em diante, os comandos rodam como o usuário `loja`, dentro de `/srv/loja-embalagens`:

```bash
sudo -u loja -H bash
```

```bash
cd /srv/loja-embalagens && npm ci
```

## 3. Banco e `.env` de produção

```bash
node scripts/db-local.mjs init --production https://embalagemcanoinhas.com.br
```

Cria o cluster em `.local/pgdata` (porta 54330, só 127.0.0.1), os papéis `loja_owner` e `loja_app`, o banco
`loja_prod` e um `.env` com `NODE_ENV=production`, segredos aleatórios, `TRUST_PROXY=1` e **sem simuladores**.
Guarde uma cópia de `.local/credentials.json` e do `ENC_KEY` do `.env` fora do servidor, em local seguro: sem o
`ENC_KEY` os segredos cifrados (MFA, tokens de marketplace) ficam ilegíveis.

```bash
npm run migrate
```

Preencha no `.env` as credenciais reais conforme forem ficando prontas (pagamento, provedor fiscal, WhatsApp,
Melhor Envio, marketplaces). Campo vazio deixa a integração desligada. A API não sobe se algum endereço público não
for `https://` ou se algum `*_FAKE=true` estiver no arquivo.

## 4. Build

```bash
npm run build -w apps/api
```

```bash
npm run build -w apps/web
```

Primeiro proprietário (a senha inicial aparece uma única vez; ative o MFA no primeiro acesso):

```bash
npm run create-owner -w apps/api -- email@dominio.com.br "Nome"
```

## 5. Serviços (systemd)

Como administrador:

```bash
sudo cp /srv/loja-embalagens/deploy/systemd/loja-* /etc/systemd/system/
```

```bash
sudo systemctl daemon-reload
```

```bash
sudo systemctl enable --now loja-db loja-api loja-web loja-backup.timer
```

- `loja-db`: sobe o PostgreSQL da loja.
- `loja-api`: API e rotinas de 60 s (reservas vencidas, NF-e, marketplaces, WhatsApp). Só escreve em `storage/`.
- `loja-web`: loja e painel.
- `loja-backup.timer`: backup diário às 03:30 em `backups/` (ver [BACKUP.md](BACKUP.md)); a cópia para fora do
  servidor é responsabilidade sua.

Logs:

```bash
journalctl -u loja-api -n 100 --no-pager
```

## 6. nginx e HTTPS

Domínio: `embalagemcanoinhas.com.br` (o `www` redireciona para ele). O DNS precisa ter registro A dos dois nomes
para o IP do servidor antes do certificado. O servidor usa CloudPanel e tem outros sites: a loja ganha arquivos
nginx próprios e o certificado sai por **webroot** (nunca `certbot --nginx`, que já quebrou o `default.conf` do
CloudPanel). A loja escuta na porta 3047 porque a 3010 e a 3020 já são usadas por outro sistema nesse servidor.

Primeiro só a porta 80, para validar o domínio:

```bash
sudo mkdir -p /var/www/letsencrypt
```

```bash
sudo cp /srv/loja-embalagens/deploy/nginx/loja-http.conf /etc/nginx/sites-available/embalagemcanoinhas.com.br.conf
```

```bash
sudo ln -s /etc/nginx/sites-available/embalagemcanoinhas.com.br.conf /etc/nginx/sites-enabled/
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

```bash
sudo certbot certonly --webroot -w /var/www/letsencrypt -d embalagemcanoinhas.com.br -d www.embalagemcanoinhas.com.br
```

Com o certificado emitido, o site completo:

```bash
sudo cp /srv/loja-embalagens/deploy/nginx/loja.conf /etc/nginx/sites-available/embalagemcanoinhas.com.br.conf
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Pontos de [`deploy/nginx/loja.conf`](../deploy/nginx/loja.conf) que não podem faltar:

- HTTP redireciona para HTTPS (os cookies de sessão são `Secure` em produção e não funcionam em HTTP).
- `proxy_set_header X-Forwarded-For $remote_addr;` (sobrescreve): é o que permite à API saber o IP real do cliente
  para os limites de tentativa, junto com `TRUST_PROXY=1`. O Next repassa esse cabeçalho sem acrescentar nada.
- `client_max_body_size` de pelo menos 8 MB (fotos de produto).

## 7. Conferência depois de subir

```bash
curl -s http://127.0.0.1:4010/ready
```

1. Abrir `https://embalagemcanoinhas.com.br/painel`: entrar, ativar o MFA, abrir **Configuração inicial**. O grupo
   "Antes de vender" mostra o que falta para o lançamento (simuladores nunca contam como prontos).
2. No navegador, conferir que o cookie de sessão está com `Secure` e `HttpOnly`.
3. Errar a senha uma vez e conferir em **Auditoria** que o IP registrado é o seu, não `127.0.0.1`.
4. Rodar `npm run backup` e `npm run backup:restore-test -- backups/<pasta>` uma vez à mão.

## 8. Endereços para cadastrar nos provedores

Todos sob o domínio da loja, com HTTPS:

| Provedor | Endereço |
|---|---|
| Mercado Pago (notificações) | `/api/v1/webhooks/mercadopago` (enviado automaticamente a partir de `PUBLIC_API_URL`) |
| Provedor fiscal (gatilho) | `/api/v1/webhooks/fiscal` |
| WhatsApp (Meta) | `/api/v1/webhooks/whatsapp` |
| Mercado Livre / Shopee (avisos) | `/api/v1/webhooks/marketplaces/mercadolivre` e `/api/v1/webhooks/marketplaces/shopee` |
| Mercado Livre / Shopee (retorno OAuth) | `/painel/marketplaces/retorno/mercadolivre` e `/painel/marketplaces/retorno/shopee` |

## 9. Atualização do sistema

Com o sistema no ar, como `loja`:

1. `npm run backup` e `npm run backup:restore-test -- backups/<pasta nova>`.
2. Atualizar o código (`git pull` ou cópia) e `npm ci`.
3. `npm run migrate` (as migrations só acrescentam; nota autorizada nunca é apagada).
4. `npm run build -w apps/api` e `npm run build -w apps/web`.
5. Como administrador: `sudo systemctl restart loja-api loja-web`.
6. Conferir `/ready`, o painel e um pedido de teste.

Se algo der errado depois da migration, não volte o banco sem antes ver o que foi gravado depois do backup
(pedidos e notas): a restauração está em [BACKUP.md](BACKUP.md).
