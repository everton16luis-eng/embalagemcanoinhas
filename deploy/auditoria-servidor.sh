#!/usr/bin/env bash
# Auditoria do servidor da loja: SO LEITURA. Nao altera nada, nao reinicia nada, nao imprime segredos.
# Uso (como administrador, no VPS):
#   sudo bash /srv/loja-embalagens/deploy/auditoria-servidor.sh 2>&1 | tee ~/auditoria-$(date +%F).txt
# Depois, copie a saida para a conversa. Revise antes: ela mostra nomes de servicos, portas e caminhos.
set -u
APP=/srv/loja-embalagens
# Endereco da loja. Com o dominio no ar, as sondas vao direto ao nginx deste servidor (--resolve), sem depender do DNS.
URL_LOCAL=${URL_LOCAL:-https://embalagemcanoinhas.com.br}
RESOLVE="--resolve embalagemcanoinhas.com.br:443:127.0.0.1"
sec() { printf '\n===== %s =====\n' "$1"; }

sec "Sistema"
. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"
uname -r; uptime
echo "CPUs: $(nproc)"; free -m; swapon --show
df -h / /srv 2>/dev/null
echo "Atualizacoes pendentes: $(apt list --upgradable 2>/dev/null | grep -c upgradable)"
echo "Atualizacoes de seguranca: $(apt list --upgradable 2>/dev/null | grep -ci security)"
systemctl is-enabled unattended-upgrades 2>/dev/null | sed 's/^/unattended-upgrades: /'
[ -f /var/run/reboot-required ] && echo "REINICIO PENDENTE (kernel/libs)"

sec "Portas abertas (escutando)"
ss -tlnp | awk 'NR==1 || /LISTEN/' | sed -E 's/users:\(\("([^"]+)".*/\1/'

sec "Firewall (ufw)"
ufw status verbose 2>/dev/null || echo "ufw indisponivel"

sec "SSH"
sshd -T 2>/dev/null | grep -Ei '^(port|permitrootlogin|passwordauthentication|pubkeyauthentication|maxauthtries|x11forwarding) '
systemctl is-active fail2ban 2>/dev/null | sed 's/^/fail2ban: /'

sec "Servicos em execucao"
systemctl list-units --type=service --state=running --no-legend | awk '{print $1}' | tr '\n' ' '; echo
echo "Servicos com falha:"; systemctl --failed --no-legend --plain | awk '{print $1}'

sec "Servicos da loja"
for s in loja-db loja-api loja-web loja-backup.timer; do printf '%-20s %s / %s\n' "$s" "$(systemctl is-active $s)" "$(systemctl is-enabled $s 2>/dev/null)"; done
systemctl show loja-api -p MemoryCurrent -p CPUUsageNSec -p NRestarts -p User 2>/dev/null
systemctl show loja-web -p MemoryCurrent -p NRestarts -p User 2>/dev/null
echo "Erros da API nas ultimas 24 h: $(journalctl -u loja-api --since '24 hours ago' -p err --no-pager 2>/dev/null | grep -vc '^--')"
echo "Respostas 5xx da API nas ultimas 24 h: $(journalctl -u loja-api --since '24 hours ago' --no-pager 2>/dev/null | grep -c '"statusCode":5')"

sec "Configuracao da aplicacao (sem segredos)"
if [ -f "$APP/.env" ]; then
  grep -E '^(NODE_ENV|TRUST_PROXY|APP_ORIGIN|PUBLIC_API_URL|PORT|DB_HOST|DB_PORT|DB_NAME|RATE_LIMIT_STORE)=' "$APP/.env"
  echo "Simuladores ligados: $(grep -Ec '^[A-Z_]*_FAKE=true' "$APP/.env")"
  echo "Chaves preenchidas (so os nomes):"; grep -E '^[A-Z_]+=.+' "$APP/.env" | cut -d= -f1 | grep -E 'TOKEN|SECRET|KEY|PASSWORD' | tr '\n' ' '; echo
fi

sec "Permissoes de arquivos sensiveis"
for p in "$APP/.env" "$APP/.local" "$APP/.local/credentials.json" "$APP/.local/pgdata" "$APP/storage" "$APP/backups"; do
  [ -e "$p" ] && stat -c '%A %U:%G %n' "$p"
done
echo "Arquivos sensiveis legiveis por qualquer usuario (deveria ser vazio):"
find "$APP/.env" "$APP/.local" "$APP/backups" -maxdepth 2 -perm -o+r 2>/dev/null | head -20
# storage/ tem XML e DANFE das notas: a pasta nao pode ser aberta por outros usuarios.
find "$APP/storage" -maxdepth 0 -perm -o+x 2>/dev/null
echo "Arquivos da aplicacao com escrita para todos (deveria ser vazio):"
find "$APP" -path "$APP/node_modules" -prune -o -perm -o+w -type f -print 2>/dev/null | head -20

sec "Banco de dados"
ss -tlnp | grep 54330 || echo "PostgreSQL da loja nao esta escutando"
[ -f "$APP/.local/pgdata/pg_hba.conf" ] && grep -Ev '^\s*(#|$)' "$APP/.local/pgdata/pg_hba.conf"
du -sh "$APP/.local/pgdata" 2>/dev/null
ls -1t "$APP/backups" 2>/dev/null | head -3 | sed 's/^/backup: /'

sec "nginx"
nginx -t 2>&1 | tail -2
nginx -v 2>&1
grep -h 'server_tokens' /etc/nginx/nginx.conf 2>/dev/null
for f in /etc/nginx/sites-enabled/*embalagem* /etc/nginx/sites-enabled/loja*; do
  [ -f "$f" ] && { echo "--- $f"; grep -Ev '^\s*(#|$)' "$f"; }
done

sec "HTTPS e cabecalhos"
# Loja e painel: o painel tem CSP propria (estrita) e X-Frame-Options.
for u in "$URL_LOCAL/" "$URL_LOCAL/painel/entrar"; do
  echo "--- $u"
  curl -skI $RESOLVE --max-time 10 "$u" | grep -Ei '^(HTTP|strict-transport|content-security|x-frame|x-content-type|referrer-policy|permissions-policy|server|x-powered-by)'
done
echo | openssl s_client -connect embalagemcanoinhas.com.br:443 -servername embalagemcanoinhas.com.br 2>/dev/null | openssl x509 -noout -subject -issuer -enddate 2>/dev/null || echo "certificado do dominio indisponivel"

sec "Arquivos que NAO podem abrir pela web (esperado: 404)"
for p in /.env /.git/config /.local/credentials.json /backups/ /storage/ /package.json /apps/api/.env /api/v1/public/images/..%2F..%2F.env/320.webp; do
  printf '%-45s %s\n' "$p" "$(curl -skL $RESOLVE -o /dev/null -w '%{http_code}' --max-time 10 "$URL_LOCAL$p")"
done

sec "Dependencias (npm audit, so producao)"
if [ -d "$APP" ]; then
  sudo -u loja -H bash -c "cd $APP && npm audit --omit=dev 2>&1 | tail -5"
  sudo -u loja -H bash -c "cd $APP && node -v && npm -v"
fi

sec "Fim"
date
