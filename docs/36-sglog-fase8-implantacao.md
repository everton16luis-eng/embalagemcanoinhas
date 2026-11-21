# SGLog — Fase 8: implantação na VPS

Roteiro para levar a Fase 8 ([35-sglog-fase8.md](35-sglog-fase8.md)) à VPS de testes com HTTPS. **Só você executa.**
Segue o roteiro da Fase 7 ([33-sglog-fase7-implantacao.md](33-sglog-fase7-implantacao.md)). A 0027 é compatível com o
código anterior, inclusive na escrita (D8-12): a API **não** precisa ficar parada durante a migração.

**Não execute antes do merge e do push autorizados.** O hash final entra aqui nesse momento.

- **Usuários:**
  - os comandos do projeto rodam como `loja`, na pasta `/srv/loja-embalagens`. Para entrar como esse usuário:
    `sudo -u loja -H bash`;
  - `systemctl` e `journalctl` rodam como root.
- **Versão:** a `main` depois do avanço rápido para `sglog/fase8`, com o planejamento (`4e45038`) e os commits da
  Fase 8.
- **Migração:** só a `0027_sglog_frete`. As migrações de `0020` a `0026` não mudaram.
- **Dependências:** nenhum `package.json` mudou. **Não rode `npm ci`.**
- **`.env`:** nada é obrigatório.
  - **Não** ponha `SHIPPING_LABELS_ENABLED=true`. O padrão `false` mantém a compra de etiqueta bloqueada.
  - `MELHOR_ENVIO_WEBHOOK_SECRET` é opcional. Sem ele, todo aviso do Melhor Envio é recusado com 401, como deve ser.
  - Sem `MELHOR_ENVIO_TOKEN`, a cotação pelo sistema fica indisponível, e o frete segue manual no despacho.
- **Travas que continuam:**
  - `ALLOCATION_AUTO` desligado;
  - dropshipping, remessas múltiplas e e-mail ao fornecedor `blocked`;
  - NF-e sem mudança: não altere `invoice_status` na VPS.
- **Mudanças de comportamento:**
  - menu Logística → **Fretes**;
  - painel "Frete" na remessa;
  - campo opcional de custo no despacho;
  - histórico de rastreio na página do pedido do cliente;
  - remessa com etiqueta ativa não cancela. Sem etiquetas na VPS, nada muda na prática.

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
      (SELECT count(*) FROM shipments)::int AS remessas,
      (SELECT count(*) FROM shipments WHERE status IN ('shipped', 'in_transit', 'out_for_delivery'))::int AS em_transporte,
      (SELECT count(*) FROM shipment_events)::int AS eventos_remessa,
      (SELECT dropship_status FROM logistics_settings) AS dropshipping,
      (SELECT multi_shipment_status FROM logistics_settings) AS remessas_multiplas,
      (SELECT supplier_email_status FROM logistics_settings) AS email_fornecedor`))[0];
  console.log('estado: ' + JSON.stringify(e));
  await c.end();
})().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
EOF
```

```bash
grep -c '^ALLOCATION_AUTO=on' .env || echo 'alocacao automatica desligada'; grep -c '^SHIPPING_LABELS_ENABLED=true' .env || echo 'etiqueta desligada'; grep -cE '^MELHOR_ENVIO_(TOKEN|WEBHOOK_SECRET)=.' .env || echo 'sem melhor envio'
```

O último comando só conta as linhas e não mostra os valores.

Siga só se:
- **Git:**
  - o ramo é `main`;
  - fora do controle de versão aparecem só `.env.antes-dominio` e `embalagemcanoinhas.inc.php,`. Esses arquivos não
    devem ser apagados.
- **Banco:**
  - a última migration é `0026_sglog_abastecimento`;
  - `dropshipping`, `remessas_multiplas` e `email_fornecedor` estão `blocked`.
- **`.env`:**
  - aparecem `alocacao automatica desligada` e `etiqueta desligada`;
  - o terceiro número (0, 1 ou 2) é só informativo.

Anote `remessas`, `em_transporte` e `eventos_remessa`.

## Etapa 2 — Backup recente e verificação

Como `loja`. Use **o nome que o `npm run backup` imprimir**.

```bash
npm run backup
```

```bash
npm run backup:verify -- backups/<nome impresso acima>
```

## Etapa 3 — Código novo e ensaio da 0027 numa cópia

Como `loja`. O banco em uso não é tocado. A 0027 não cria nem altera linhas nas tabelas existentes. Ela só acrescenta
colunas vazias e a configuração padrão. O ensaio deve mostrar as mesmas contagens antes e depois.

```bash
git rev-parse HEAD > ~/antes-sglog-fase8.txt && git merge --ff-only origin/main && git log -1 --format='%h %s'
```

```bash
git diff --stat $(cat ~/antes-sglog-fase8.txt) HEAD -- package.json package-lock.json apps/api/package.json apps/web/package.json
```

O `diff` deve sair vazio. Se aparecer algum arquivo, pare e traga a saída.

```bash
node scripts/backup.mjs migrate-rehearsal backups/<nome da etapa 2>
```

**Pare e traga a saída** se aparecer qualquer um destes:
- `FALHOU` ou erro;
- outra migração além da `0027`;
- `0027: bloqueios obtidos` com mais de 1000 ms ou mais de 50 tentativas;
- divergência na conferência.

Para desistir aqui, sem nada migrado nem construído:

```bash
git reset --keep $(cat ~/antes-sglog-fase8.txt) && git log -1 --format='%h %s'
```

## Etapa 4 — Migração, build e reinício

A API continua no ar durante a migração.

1. Como `loja`, a migração. Guarde os avisos `0027:`. Com `remessas ocupadas`, nada mudou: repita em seguida.

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

Como `loja`, depois de ao menos 1 minuto com a API no ar (primeiro ciclo da fila):

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
  if (last !== '0027_sglog_frete') fail.push('ultima migration nao e a 0027');
  const cols = ['on_hand', 'reserved', 'blocked', 'damaged', 'in_transit'];
  const s = (await q(`SELECT ${cols.map((k) => `(SELECT coalesce(sum(${k}), 0) FROM stock_balances)::text AS t_${k}, (SELECT coalesce(sum(${k}), 0) FROM stock_location_balances)::text AS d_${k}`).join(', ')}`))[0];
  for (const k of cols) if (s['t_' + k] !== s['d_' + k]) fail.push(`${k}: total diferente da soma dos depositos`);
  const t = (await q(`SELECT
      (SELECT label_status FROM logistics_settings) AS etiqueta,
      (SELECT label_max_cents FROM logistics_settings) AS limite_etiqueta,
      (SELECT tracking_poll_hours FROM logistics_settings) AS rastreio_horas,
      (SELECT tracking_stale_days FROM logistics_settings) AS rastreio_parado_dias,
      (SELECT dropship_status FROM logistics_settings) AS dropshipping,
      (SELECT multi_shipment_status FROM logistics_settings) AS remessas_multiplas,
      (SELECT supplier_email_status FROM logistics_settings) AS email_fornecedor,
      (SELECT count(*) FROM shipments)::int AS remessas,
      (SELECT count(*) FROM shipment_events)::int AS eventos_remessa,
      (SELECT count(*) FROM shipments WHERE quote_id IS NOT NULL OR carrier_provider IS NOT NULL)::int AS remessas_com_frete,
      (SELECT count(*) FROM shipping_quotes)::int AS cotacoes,
      (SELECT count(*) FROM shipping_labels)::int AS etiquetas,
      (SELECT count(*) FROM shipment_freight_costs)::int AS custos,
      (SELECT count(*) FROM integration_jobs)::int AS tarefas,
      (SELECT count(*) FROM logistics_webhook_events)::int AS avisos`))[0];
  console.log('fase 8: ' + JSON.stringify(t));
  if (t.etiqueta !== 'blocked') fail.push('etiqueta nao esta bloqueada');
  if (t.limite_etiqueta !== null) fail.push('limite de etiqueta definido');
  if (t.etiquetas !== 0) fail.push('existe etiqueta registrada');
  if (t.dropshipping !== 'blocked') fail.push('dropshipping nao esta bloqueado');
  if (t.remessas_multiplas !== 'blocked') fail.push('remessas multiplas nao estao bloqueadas');
  if (t.email_fornecedor !== 'blocked') fail.push('e-mail ao fornecedor nao esta bloqueado');
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
journalctl -u loja-api -n 80 --no-pager | grep -iE 'error|erro|fatal|integra|frete' || echo 'sem erros no log'
```

Esperado logo após a implantação:
- `RESULTADO: OK`;
- `etiqueta` `blocked`, `limite_etiqueta` `null`, `rastreio_horas` 6, `rastreio_parado_dias` 5;
- `remessas` e `eventos_remessa` iguais aos da etapa 1;
- `remessas_com_frete`, `cotacoes`, `etiquetas`, `custos`, `tarefas` e `avisos` em 0. Se alguém despachou entre a
  implantação e a conferência, `remessas_com_frete` conta esses despachos.

  Sem provedor com rastreio, nenhuma tarefa é criada.

### 5.2 Navegador, pelo HTTPS

O roteiro está em
[TESTES-PENDENTES.md](TESTES-PENDENTES.md#sglog-fase-8--fretes-etiquetas-rastreio-e-custos-35-sglog-fase8md).

## Se algo der errado

| Quando | O que fazer |
|---|---|
| Ensaio (etapa 3) falhou | Nada foi aplicado. Rode `git reset --keep $(cat ~/antes-sglog-fase8.txt)` e traga a saída |
| Migração falhou (4.1) | A 0027 roda numa transação só: nada mudou. Com `ocupadas`, repita. Com outro erro, volte o código e traga a saída. A API antiga continua no ar |
| Build falhou (4.2), com a 0027 aplicada | O código antigo funciona com a 0027. Volte o código (`git reset --keep ...`), faça o build antigo e reinicie. A 0027 pode ficar |
| Precisar desfazer a 0027 | `npm run migrate -- down`. A reversão é recusada se a Fase 8 já foi usada, e então nada muda. Contam como uso: qualquer despacho feito com o código novo (marca a remessa como frete manual), cotação, etiqueta, custo, tarefa, aviso, rastreio ou regra alterada. Não apague dados para destravar. Restaurar o backup só com autorização expressa ([BACKUP.md](BACKUP.md)) |
