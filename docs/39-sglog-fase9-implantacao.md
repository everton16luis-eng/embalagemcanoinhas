# SGLog — Fase 9: implantação na VPS

Roteiro para levar a Fase 9 ([38-sglog-fase9.md](38-sglog-fase9.md)) à VPS de testes com HTTPS. **Só você executa.**
Segue o roteiro da Fase 8 ([36-sglog-fase8-implantacao.md](36-sglog-fase8-implantacao.md)). A 0028 é compatível com o
código anterior, inclusive na escrita: a API **não** precisa ficar parada durante a migração.

**Publicado:** `main` em `b7f7749` (push autorizado em 21/11/2026). Na VPS, em uso: `d76ca4f`.

- **Usuários:**
  - os comandos do projeto rodam como `loja`, na pasta `/srv/loja-embalagens`. Para entrar como esse usuário:
    `sudo -u loja -H bash`;
  - `systemctl` e `journalctl` rodam como root.
- **Versão:** `b7f7749`, a `main` depois do avanço rápido para `sglog/fase9`, com o planejamento (`a09424b`), a 9a
  (`d454b30`), a 9b (`8bd11c7`), a documentação (`8a647da`) e a trava da reposição de troca (`b7f7749`: sem NF-e nem
  despacho até a definição fiscal). A 9a e a 9b vão juntas: a 0028 foi ampliada na 9b antes de qualquer implantação, e não há
  implantação só da 9a.
- **Migração:** só a `0028_sglog_devolucoes`. As migrações de `0020` a `0027` não mudaram.
- **Dependências:** nenhum `package.json` mudou. **Não rode `npm ci`.**
- **`.env`:** nada muda. Não ligue `ALLOCATION_AUTO` nem `SHIPPING_LABELS_ENABLED`.
- **Travas que continuam:**
  - alocação automática desligada;
  - dropshipping, remessas múltiplas e e-mail ao fornecedor `blocked`;
  - compra de etiqueta `blocked`;
  - NF-e sem mudança: não altere `invoice_status` na VPS.
- **Mudanças de comportamento:**
  - menus Logística → **Ocorrências**, **Devoluções** e **Devol. ao fornecedor**;
  - painéis "Ocorrências e devoluções" e "Reembolsos" no pedido;
  - pedido entregue com ocorrência aberta que segura a conclusão fica `on_hold` (não conclui). Sem ocorrências na VPS,
    nada muda na prática;
  - aviso `delivery_failed`/`returned` do rastreio e pagamento devolvido ou contestado no provedor abrem ocorrência
    (sem estoque, reembolso ou nota);
  - a página do cliente mostra a situação das devoluções e esconde os eventos internos da Fase 9.

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
      (SELECT count(*) FROM orders)::int AS pedidos,
      (SELECT count(*) FROM orders WHERE status = 'delivered')::int AS entregues,
      (SELECT count(*) FROM orders WHERE logistics_status = 'completed')::int AS concluidos,
      (SELECT count(*) FROM order_events)::int AS eventos_pedido,
      (SELECT count(*) FROM stock_movements)::int AS movimentos,
      (SELECT count(*) FROM payments WHERE status IN ('refunded', 'charged_back'))::int AS pagamentos_devolvidos,
      (SELECT count(*) FROM shipments)::int AS remessas,
      (SELECT dropship_status FROM logistics_settings) AS dropshipping,
      (SELECT multi_shipment_status FROM logistics_settings) AS remessas_multiplas,
      (SELECT supplier_email_status FROM logistics_settings) AS email_fornecedor,
      (SELECT label_status FROM logistics_settings) AS etiqueta`))[0];
  console.log('estado: ' + JSON.stringify(e));
  await c.end();
})().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
EOF
```

```bash
grep -c '^ALLOCATION_AUTO=on' .env || echo 'alocacao automatica desligada'; grep -c '^SHIPPING_LABELS_ENABLED=true' .env || echo 'etiqueta desligada'
```

O último comando só conta as linhas e não mostra os valores.

Siga só se:
- **Git:**
  - o ramo é `main`;
  - fora do controle de versão aparecem só `.env.antes-dominio` e `embalagemcanoinhas.inc.php,`. Esses arquivos não
    devem ser apagados.
- **Banco:**
  - a última migration é `0027_sglog_frete`;
  - `dropshipping`, `remessas_multiplas`, `email_fornecedor` e `etiqueta` estão `blocked`.
- **`.env`:** aparecem `alocacao automatica desligada` e `etiqueta desligada`.

Anote `pedidos`, `entregues`, `concluidos`, `eventos_pedido`, `movimentos`, `pagamentos_devolvidos` e `remessas`.

## Etapa 2 — Backup recente e verificação

Como `loja`. Use **o nome que o `npm run backup` imprimir**.

```bash
npm run backup
```

```bash
npm run backup:verify -- backups/<nome impresso acima>
```

## Etapa 3 — Código novo e ensaio da 0028 numa cópia

Como `loja`. O banco em uso não é tocado. A 0028 não altera linhas existentes: só cria tabelas vazias, acrescenta
colunas com padrão e amplia checagens. O ensaio deve mostrar as mesmas contagens antes e depois.

```bash
git rev-parse HEAD > ~/antes-sglog-fase9.txt && git merge --ff-only origin/main && git log -1 --format='%h %s'
```

```bash
git diff --stat $(cat ~/antes-sglog-fase9.txt) HEAD -- package.json package-lock.json apps/api/package.json apps/web/package.json
```

O `diff` deve sair vazio. Se aparecer algum arquivo, pare e traga a saída.

```bash
node scripts/backup.mjs migrate-rehearsal backups/<nome da etapa 2>
```

**Pare e traga a saída** se aparecer qualquer um destes:
- `FALHOU` ou erro;
- outra migração além da `0028`;
- `0028: bloqueios obtidos` com mais de 1000 ms ou mais de 50 tentativas;
- divergência na conferência.

O ensaio também deve mostrar o aviso `0028: … pedido(s) entregue(s) e … concluido(s) na logistica; nenhuma
ocorrencia, devolucao, reembolso ou devolucao ao fornecedor existe ainda`.

Para desistir aqui, sem nada migrado nem construído:

```bash
git reset --keep $(cat ~/antes-sglog-fase9.txt) && git log -1 --format='%h %s'
```

## Etapa 4 — Migração, build e reinício

A API continua no ar durante a migração. A 0028 trava `orders`, `stock_movements`, `stock_reconciliations`,
`logistics_settings` e `order_events` por alguns milissegundos (espera até 10 s).

1. Como `loja`, a migração. Guarde os avisos `0028:`. Com `pedidos ou estoque ocupados`, nada mudou: repita em
   seguida.

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

### 5.1 Banco: conferência até a C21

Como `loja`, depois de ao menos 1 minuto com a API no ar:

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
  if (last !== '0028_sglog_devolucoes') fail.push('ultima migration nao e a 0028');
  const cols = ['on_hand', 'reserved', 'blocked', 'damaged', 'in_transit'];
  const s = (await q(`SELECT ${cols.map((k) => `(SELECT coalesce(sum(${k}), 0) FROM stock_balances)::text AS t_${k}, (SELECT coalesce(sum(${k}), 0) FROM stock_location_balances)::text AS d_${k}`).join(', ')}`))[0];
  for (const k of cols) if (s['t_' + k] !== s['d_' + k]) fail.push(`${k}: total diferente da soma dos depositos`);
  const t = (await q(`SELECT
      (SELECT label_status FROM logistics_settings) AS etiqueta,
      (SELECT dropship_status FROM logistics_settings) AS dropshipping,
      (SELECT multi_shipment_status FROM logistics_settings) AS remessas_multiplas,
      (SELECT supplier_email_status FROM logistics_settings) AS email_fornecedor,
      (SELECT return_regret_days FROM logistics_settings) AS prazo_arrependimento,
      (SELECT return_defect_days FROM logistics_settings) AS prazo_defeito,
      (SELECT count(*) FROM orders)::int AS pedidos,
      (SELECT count(*) FROM orders WHERE status = 'delivered')::int AS entregues,
      (SELECT count(*) FROM orders WHERE logistics_status = 'completed')::int AS concluidos,
      (SELECT count(*) FROM orders WHERE logistics_status = 'on_hold')::int AS segurados,
      (SELECT count(*) FROM orders WHERE replacement_for_return_id IS NOT NULL)::int AS reposicoes,
      (SELECT count(*) FROM order_events)::int AS eventos_pedido,
      (SELECT count(*) FROM order_events WHERE internal)::int AS eventos_internos,
      (SELECT count(*) FROM stock_movements)::int AS movimentos,
      (SELECT count(*) FROM shipments)::int AS remessas,
      (SELECT count(*) FROM logistic_occurrences)::int AS ocorrencias,
      (SELECT count(*) FROM customer_returns)::int AS devolucoes,
      (SELECT count(*) FROM refund_records)::int AS reembolsos,
      (SELECT count(*) FROM return_fiscal_documents)::int AS documentos_devolucao,
      (SELECT count(*) FROM supplier_returns)::int AS devolucoes_fornecedor`))[0];
  console.log('fase 9: ' + JSON.stringify(t));
  if (t.etiqueta !== 'blocked') fail.push('etiqueta nao esta bloqueada');
  if (t.dropshipping !== 'blocked') fail.push('dropshipping nao esta bloqueado');
  if (t.remessas_multiplas !== 'blocked') fail.push('remessas multiplas nao estao bloqueadas');
  if (t.email_fornecedor !== 'blocked') fail.push('e-mail ao fornecedor nao esta bloqueado');
  if (t.segurados !== 0) fail.push('pedido on_hold logo apos a implantacao');
  if (t.reposicoes !== 0 || t.reembolsos !== 0 || t.devolucoes !== 0 || t.devolucoes_fornecedor !== 0) fail.push('dado da fase 9 logo apos a implantacao');
  const r = await q('SELECT check_code, field, variant_id, expected::text, found::text, ref_id FROM stock_reconcile()');
  const run = r.find((x) => x.check_code === 'run');
  const divs = r.filter((x) => x.check_code !== 'run');
  console.log('conferencia (C1-C21): ' + Number(run.expected) + ' variante(s), ' + divs.length + ' divergencia(s)');
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
journalctl -u loja-api -n 80 --no-pager | grep -iE 'error|erro|fatal|ocorr|devol|reembolso' || echo 'sem erros no log'
```

Esperado logo após a implantação:
- `RESULTADO: OK`;
- `etiqueta`, `dropshipping`, `remessas_multiplas` e `email_fornecedor` `blocked`;
- `prazo_arrependimento` 7 e `prazo_defeito` 90;
- `pedidos`, `entregues`, `concluidos`, `movimentos` e `remessas` iguais aos da etapa 1 (salvo vendas ou despachos
  feitos entre as etapas);
- `eventos_pedido` igual ao da etapa 1, e `eventos_internos` 0;
- `segurados`, `reposicoes`, `ocorrencias`, `devolucoes`, `reembolsos`, `documentos_devolucao` e
  `devolucoes_fornecedor` em 0. Uma `ocorrencia` só aparece se chegou, depois da migração, um aviso de rastreio de
  falha ou devolução, ou um pagamento devolvido no provedor.

### 5.2 Navegador, pelo HTTPS

O roteiro está em
[TESTES-PENDENTES.md](TESTES-PENDENTES.md#sglog-fase-9--ocorrências-devoluções-e-logística-reversa-38-sglog-fase9md).

## Se algo der errado

| Quando | O que fazer |
|---|---|
| Ensaio (etapa 3) falhou | Nada foi aplicado. Rode `git reset --keep $(cat ~/antes-sglog-fase9.txt)` e traga a saída |
| Migração falhou (4.1) | A 0028 roda numa transação só: nada mudou. Com `ocupados`, repita. Com outro erro, volte o código e traga a saída. A API antiga continua no ar |
| Build falhou (4.2), com a 0028 aplicada | O código antigo funciona com a 0028. Volte o código (`git reset --keep ...`), faça o build antigo e reinicie. A 0028 pode ficar |
| Precisar desfazer a 0028 | `npm run migrate -- down`. A reversão é recusada se a Fase 9 já foi usada, e então nada muda. Contam como uso: ocorrência, devolução, reembolso, documento de devolução, devolução ao fornecedor, pedido de reposição, movimento de devolução, pedido `on_hold`, divergência C14–C21 gravada ou prazos da política alterados. Não apague dados para destravar. Restaurar o backup só com autorização expressa ([BACKUP.md](BACKUP.md)) |
