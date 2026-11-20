# SGLog — Fase 6: implantação na VPS

Roteiro para levar a Fase 6 ([29-sglog-fase6.md](29-sglog-fase6.md)) à VPS de testes com HTTPS. **Só você executa.**
Segue o roteiro da Fase 5 ([27-sglog-fase5-implantacao.md](27-sglog-fase5-implantacao.md)), com uma diferença: a 0025 é
compatível com o código anterior (D6-13), então a API **não** precisa ficar parada durante a migração.

**Não execute antes do merge e do push autorizados.** O hash final entra aqui nesse momento.

- **Usuários:**
  - os comandos do projeto rodam como `loja`, na pasta `/srv/loja-embalagens`; para entrar como ele, use
    `sudo -u loja -H bash`;
  - `systemctl` e `journalctl` rodam como root.
- **Versão:** a `main` depois do avanço rápido para `sglog/fase6`: o commit do planejamento (`01bdc7c`) e os commits da
  Fase 6.
- **Migração:** só a `0025_sglog_compras`. As migrações de `0020` a `0024` não mudaram.
- **Dependências:** nenhum `package.json` mudou. **Não rode `npm ci`.**
- **Travas que continuam:**
  - `ALLOCATION_AUTO` desligado;
  - dropshipping e remessas múltiplas `blocked`;
  - NF-e sem mudança: não altere `invoice_status` na VPS.
- **Limite de aprovação:** a migração cria R$ 0, então toda compra pede aprovação. O valor de produção é decisão da
  empresa e se muda em Compras → "Regras da compra" (permissão de configurações, com MFA). Não mude para os testes.
- **Mudança de comportamento:** o Comprador não recebe mais mercadoria (D6-1). Antes de implantar, confira quem recebe
  hoje: precisa do papel Estoquista ou Logística, ou da permissão individual "Receber mercadoria de compras".

## Etapa 1 — Conferência rápida (só leitura)

Como `loja`:

```bash
cd /srv/loja-embalagens && git status -sb && git log -1 --format='em uso: %h %s' && git fetch origin && git log --oneline HEAD..origin/main
```

```bash
node - <<'EOF'
process.loadEnvFile('.env');
const pg = require('pg');
const c = new pg.Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_OWNER_USER, password: process.env.DB_OWNER_PASSWORD, database: process.env.DB_NAME });
(async () => {
  await c.connect();
  const q = async (s) => (await c.query(s)).rows;
  console.log('ultima migration: ' + (await q('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1'))[0].name);
  const e = (await q(`SELECT
      (SELECT count(*) FROM purchase_orders WHERE status IN ('draft', 'sent', 'partial'))::int AS compras_em_aberto,
      (SELECT count(*) FROM purchase_receipts)::int AS recebimentos,
      (SELECT count(*) FROM stock_reservations r JOIN orders o ON r.source_type = 'order' AND o.id::text = r.source_id
         WHERE r.status = 'active' AND r.backorder AND o.status IN ('paid', 'preparing', 'ready'))::int AS encomendas_ativas,
      (SELECT dropship_status FROM logistics_settings) AS dropshipping,
      (SELECT multi_shipment_status FROM logistics_settings) AS remessas_multiplas`))[0];
  console.log('estado: ' + JSON.stringify(e));
  const buyers = (await q(`SELECT count(*)::int AS n FROM users WHERE role = 'buyer' AND is_active`))[0].n;
  console.log('compradores ativos (deixam de receber): ' + buyers);
  await c.end();
})().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
EOF
```

```bash
grep -c '^ALLOCATION_AUTO=on' .env || echo 'alocacao automatica desligada'
```

Siga só se:
- **Git:**
  - o ramo é `main`;
  - fora do controle de versão aparecem só `.env.antes-dominio` e `embalagemcanoinhas.inc.php,`, que não devem ser
    apagados.
- **Banco:**
  - a última migration é `0024_sglog_remessas`;
  - `dropshipping` e `remessas_multiplas` estão `blocked`.
- **Alocação automática:** aparece `alocacao automatica desligada`.

Anote `compras_em_aberto` e `encomendas_ativas`.

## Etapa 2 — Backup recente e verificação

Como `loja`. Use **o nome que o `npm run backup` imprimir**.

```bash
npm run backup
```

```bash
npm run backup:verify -- backups/<nome impresso acima>
```

## Etapa 3 — Código novo e ensaio da 0025 numa cópia

Como `loja`. O banco em uso não é tocado. A 0025 não cria linhas em tabelas existentes, então o ensaio deve mostrar as
mesmas contagens antes e depois.

```bash
git rev-parse HEAD > ~/antes-sglog-fase6.txt && git merge --ff-only origin/main && git log -1 --format='%h %s'
```

```bash
git diff --stat $(cat ~/antes-sglog-fase6.txt) HEAD -- package.json package-lock.json apps/api/package.json apps/web/package.json
```

O `diff` deve sair vazio. Se aparecer algum arquivo, pare e traga a saída.

```bash
node scripts/backup.mjs migrate-rehearsal backups/<nome da etapa 2>
```

**Pare e traga a saída** se aparecer qualquer um destes:
- `FALHOU` ou erro;
- outra migração além da `0025`;
- `0025: bloqueios obtidos` com mais de 1000 ms ou mais de 50 tentativas;
- `0025: compras bloqueadas por` com mais de 2000 ms;
- divergência na conferência;
- o aviso `0025: X compra(s) em aberto ...; Y encomenda(s) ativa(s) NAO convertida(s)` sem bater com a etapa 1. X deve
  ser igual a `compras_em_aberto` e Y igual a `encomendas_ativas`.

Para desistir aqui, sem nada migrado nem construído:

```bash
git reset --keep $(cat ~/antes-sglog-fase6.txt) && git log -1 --format='%h %s'
```

## Etapa 4 — Migração, build e reinício

A API continua no ar durante a migração: o código anterior funciona com a 0025 (suíte anterior 431/431 contra o banco
migrado).

1. Como `loja`, a migração. Guarde os avisos `0025:`. Com `compras ou estoque ocupados`, nada mudou: repita em seguida.

   ```bash
   npm run migrate
   ```

2. Como `loja`, o build:

   ```bash
   npm run build -w apps/api && npm run build -w apps/web
   ```

3. Como root:

   ```bash
   systemctl restart loja-api loja-web && sleep 3 && systemctl is-active loja-api loja-web && curl -s http://127.0.0.1:4010/ready; echo
   ```

   Deve aparecer `active`, `active` e `{"ok":true}`.

## Etapa 5 — Validação

### 5.1 Banco: conferência até a C13

Como `loja`:

```bash
node - <<'EOF'
process.loadEnvFile('.env');
const pg = require('pg');
const c = new pg.Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_OWNER_USER, password: process.env.DB_OWNER_PASSWORD, database: process.env.DB_NAME });
(async () => {
  await c.connect();
  const q = async (s) => (await c.query(s)).rows;
  const fail = [];
  const last = (await q('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1'))[0].name;
  console.log('ultima migration: ' + last);
  if (last !== '0025_sglog_compras') fail.push('ultima migration nao e a 0025');
  const cols = ['on_hand', 'reserved', 'blocked', 'damaged', 'in_transit'];
  const s = (await q(`SELECT ${cols.map((k) => `(SELECT coalesce(sum(${k}), 0) FROM stock_balances)::text AS t_${k}, (SELECT coalesce(sum(${k}), 0) FROM stock_location_balances)::text AS d_${k}`).join(', ')}`))[0];
  for (const k of cols) if (s['t_' + k] !== s['d_' + k]) fail.push(`${k}: total diferente da soma dos depositos`);
  const t = (await q(`SELECT (SELECT dropship_status FROM logistics_settings) AS dropshipping,
      (SELECT multi_shipment_status FROM logistics_settings) AS remessas_multiplas,
      (SELECT purchase_approval_min_cents FROM logistics_settings)::text AS limite_aprovacao_centavos,
      (SELECT purchase_price_tolerance_pct FROM logistics_settings)::text AS tolerancia_preco_pct,
      (SELECT count(*) FROM purchase_orders WHERE warehouse_id IS NULL)::int AS compras_sem_destino,
      (SELECT count(*) FROM reservation_conversions)::int AS conversoes,
      (SELECT count(*) FROM purchase_order_links WHERE status = 'active')::int AS vinculos_ativos`))[0];
  console.log('fase 6: ' + JSON.stringify(t));
  if (t.dropshipping !== 'blocked') fail.push('dropshipping nao esta bloqueado');
  if (t.remessas_multiplas !== 'blocked') fail.push('remessas multiplas nao estao bloqueadas');
  if (t.compras_sem_destino) fail.push('compra sem deposito de destino');
  const r = await q('SELECT check_code, field, variant_id, expected::text, found::text FROM stock_reconcile()');
  const run = r.find((x) => x.check_code === 'run');
  const divs = r.filter((x) => x.check_code !== 'run');
  console.log('conferencia (C1-C13): ' + Number(run.expected) + ' variante(s), ' + divs.length + ' divergencia(s)');
  for (const d of divs.slice(0, 20)) console.log('  ' + JSON.stringify(d));
  if (divs.length) fail.push(divs.length + ' divergencia(s) na conferencia');
  console.log(fail.length ? 'RESULTADO: PARAR - ' + fail.join('; ') : 'RESULTADO: OK');
  await c.end();
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
EOF
```

Como root:

```bash
journalctl -u loja-api -n 80 --no-pager | grep -iE 'error|erro|fatal|purchase|compra' || echo 'sem erros no log'
```

Esperado logo após a implantação:
- `RESULTADO: OK`;
- `limite_aprovacao_centavos` "0" e `tolerancia_preco_pct` "0.00";
- `conversoes` 0 e `vinculos_ativos` 0, porque a migração não converte nada (D6-10).

### 5.2 Navegador, pelo HTTPS

Roteiro em [TESTES-PENDENTES.md](TESTES-PENDENTES.md#sglog-fase-6--compras-recebimento-e-encomendas-29-sglog-fase6md).

## Se algo der errado

| Quando | O que fazer |
|---|---|
| Ensaio (etapa 3) falhou | Nada foi aplicado. `git reset --keep $(cat ~/antes-sglog-fase6.txt)` e trazer a saída |
| Migração falhou (4.1) | A 0025 roda numa transação só: nada mudou. Com `ocupadas`, repetir. Com outro erro, voltar o código e trazer a saída. A API antiga continua no ar |
| Build falhou (4.2), com a 0025 aplicada | O código antigo funciona com a 0025: voltar o código (`git reset --keep ...`), fazer o build antigo e reiniciar. A 0025 pode ficar |
| Precisar desfazer a 0025 | `npm run migrate -- down`. É recusado se a Fase 6 já foi usada (aprovação, vínculo, conversão, divergência, pagamento informado, configuração), e então nada muda. Não apagar dados para destravar; restaurar backup só com autorização expressa ([BACKUP.md](BACKUP.md)) |
