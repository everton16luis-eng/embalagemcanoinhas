# SGLog — Fase 10: implantação na VPS

Roteiro para levar a Fase 10 ([41-sglog-fase10.md](41-sglog-fase10.md)) à VPS de testes com HTTPS. **Só você
executa.**

Segue o roteiro da Fase 9 ([39-sglog-fase9-implantacao.md](39-sglog-fase9-implantacao.md)). A 0029 é aditiva e
compatível com o código anterior, inclusive na escrita: a API **não** precisa ficar parada.

**Publicado:** a `main` avançou por fast-forward para `sglog/fase10` (push autorizado em 21/11/2026). Na VPS, em
uso: `8c66097`. A `main` publicada tem, depois de `8c66097`:
- `d0f7a9b`, testes pendentes da Fase 9;
- `29b771f`, planejamento da Fase 10;
- `3a2f9a5`, a 10a;
- `15f8527`, a 10b e esta documentação;
- o commit desta nota de publicação.

O código da Fase 10 é o de `15f8527`. A etapa 3 confere, com `git log -1`, que a VPS ficou no último commit da `main`.

- **Usuários:**
  - os comandos do projeto rodam como `loja`, na pasta `/srv/loja-embalagens`. Para entrar como esse usuário:
    `sudo -u loja -H bash`;
  - `systemctl` e `journalctl` rodam como root.
- **Migração:** só a `0029_sglog_custos`. As migrações de `0020` a `0028` não mudaram.
- **Dependências:** nenhum `package.json` mudou. **Não rode `npm ci`.**
- **`.env`:** nada muda. Não ligue `ALLOCATION_AUTO` nem `SHIPPING_LABELS_ENABLED`.
- **Travas que continuam:**
  - alocação automática desligada;
  - dropshipping, remessas múltiplas, e-mail ao fornecedor e compra de etiqueta `blocked`;
  - NF-e e despacho da reposição de troca bloqueados até a definição fiscal;
  - não altere `invoice_status` na VPS.
- **Mudanças de comportamento:**
  - menu **Gestão**: Painel Gestão, Rentabilidade, Custos logísticos, Desempenho de fornecedores e Custos e margens;
  - painel "Margem de contribuição" no pedido, para quem tem `margins.view`;
  - cinco permissões novas (`costs.view`, `margins.view`, `management.view`, `costs.settings`, `costs.record`).
    Gerente e financeiro passam a consultar custos e margens; o financeiro lança custos (MFA). Nenhum outro perfil
    ganha acesso;
  - nada muda no checkout, nos pagamentos, na NF-e, nos pedidos, no estoque, no despacho, nos marketplaces ou no
    relatório de vendas.

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
      (SELECT count(*) FROM orders WHERE status IN ('paid', 'preparing', 'ready', 'shipped', 'delivered'))::int AS pagos,
      (SELECT count(*) FROM stock_movements)::int AS movimentos,
      (SELECT count(*) FROM stock_movements WHERE kind = 'sale')::int AS vendas_estoque,
      (SELECT count(*) FROM shipments)::int AS remessas,
      (SELECT count(*) FROM shipment_freight_costs)::int AS custos_frete,
      (SELECT count(*) FROM payments)::int AS pagamentos,
      (SELECT count(*) FROM fiscal_documents)::int AS notas,
      (SELECT count(*) FROM refund_records)::int AS reembolsos,
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
  - a última migration é `0028_sglog_devolucoes`;
  - `dropshipping`, `remessas_multiplas`, `email_fornecedor` e `etiqueta` estão `blocked`.
- **`.env`:** aparecem `alocacao automatica desligada` e `etiqueta desligada`.

Anote todos os números do `estado`.

## Etapa 2 — Backup recente e verificação

Como `loja`. Use **o nome que o `npm run backup` imprimir**.

```bash
npm run backup
```

```bash
npm run backup:verify -- backups/<nome impresso acima>
```

## Etapa 3 — Código novo e ensaio da 0029 numa cópia

Como `loja`. O banco em uso não é tocado. A 0029 não altera linhas existentes: só cria tabelas vazias, a função
`cost_reconcile()` e índices. O ensaio deve mostrar as mesmas contagens antes e depois.

```bash
git rev-parse HEAD > ~/antes-sglog-fase10.txt && git merge --ff-only origin/main && git log -1 --format='%h %s'
```

```bash
git diff --stat $(cat ~/antes-sglog-fase10.txt) HEAD -- package.json package-lock.json apps/api/package.json apps/web/package.json
```

O `diff` deve sair vazio. Se aparecer algum arquivo, pare e traga a saída.

```bash
node scripts/backup.mjs migrate-rehearsal backups/<nome da etapa 2>
```

**Pare e traga a saída** se aparecer qualquer um destes:
- `FALHOU` ou erro;
- outra migração além da `0029`;
- `0029: bloqueios obtidos` com mais de 1000 ms ou mais de 50 tentativas;
- divergência na conferência.

O ensaio também deve mostrar o aviso `0029: … pedido(s) pago(s) e … movimento(s) de venda no estoque; nenhuma
configuracao de custo ou lancamento existe ainda`.

Para desistir aqui, sem nada migrado nem construído:

```bash
git reset --keep $(cat ~/antes-sglog-fase10.txt) && git log -1 --format='%h %s'
```

## Etapa 4 — Migração, build e reinício

A API continua no ar durante a migração. A 0029 trava por alguns milissegundos, à espera de até 10 s:
- `orders`, `shipments` e `stock_movements` para escrita;
- `users` contra alteração de linhas.

Os índices novos (pagamento, pedido, despacho e origem do movimento) são criados nessa janela.

1. Como `loja`, a migração. Guarde os avisos `0029:`. Com `pedidos ou estoque ocupados`, nada mudou: repita em
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

### 5.1 Banco: C1–C21, C22–C23 e margem calculável

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
  if (last !== '0029_sglog_custos') fail.push('ultima migration nao e a 0029');
  const t = (await q(`SELECT
      (SELECT label_status FROM logistics_settings) AS etiqueta,
      (SELECT dropship_status FROM logistics_settings) AS dropshipping,
      (SELECT multi_shipment_status FROM logistics_settings) AS remessas_multiplas,
      (SELECT supplier_email_status FROM logistics_settings) AS email_fornecedor,
      (SELECT count(*) FROM orders)::int AS pedidos,
      (SELECT count(*) FROM orders WHERE status IN ('paid', 'preparing', 'ready', 'shipped', 'delivered'))::int AS pagos,
      (SELECT count(*) FROM stock_movements)::int AS movimentos,
      (SELECT count(*) FROM stock_movements WHERE kind = 'sale')::int AS vendas_estoque,
      (SELECT count(*) FROM shipments)::int AS remessas,
      (SELECT count(*) FROM shipment_freight_costs)::int AS custos_frete,
      (SELECT count(*) FROM payments)::int AS pagamentos,
      (SELECT count(*) FROM fiscal_documents)::int AS notas,
      (SELECT count(*) FROM refund_records)::int AS reembolsos,
      (SELECT count(*) FROM cost_settings)::int AS configuracoes,
      (SELECT count(*) FROM order_cost_entries)::int AS lancamentos,
      (SELECT count(*) FROM cost_imports)::int AS importacoes`))[0];
  console.log('fase 10: ' + JSON.stringify(t));
  for (const k of ['etiqueta', 'dropshipping', 'remessas_multiplas', 'email_fornecedor']) if (t[k] !== 'blocked') fail.push(k + ' nao esta blocked');
  const cr = await q('SELECT check_code, field, ref_id, expected, found FROM cost_reconcile()');
  console.log('conferencia de custos (C22-C23): ' + cr.length + ' divergencia(s)');
  for (const d of cr.slice(0, 20)) console.log('  ' + JSON.stringify(d));
  if (cr.length) fail.push(cr.length + ' divergencia(s) em C22-C23');
  const r = await q('SELECT check_code, field, variant_id, expected::text, found::text, ref_id FROM stock_reconcile()');
  const run = r.find((x) => x.check_code === 'run');
  const divs = r.filter((x) => x.check_code !== 'run');
  console.log('conferencia do estoque (C1-C21): ' + Number(run.expected) + ' variante(s), ' + divs.length + ' divergencia(s)');
  for (const d of divs.slice(0, 20)) console.log('  ' + JSON.stringify(d));
  if (divs.length) fail.push(divs.length + ' divergencia(s) em C1-C21');
  const perms = (await q(`SELECT count(*)::int AS n FROM user_permissions WHERE permission IN ('costs.view', 'margins.view', 'management.view', 'costs.settings', 'costs.record')`))[0].n;
  console.log('concessoes individuais da fase 10: ' + perms);
  console.log(fail.length ? 'RESULTADO: PARAR - ' + fail.join('; ') : 'RESULTADO: OK');
  await c.end();
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
EOF
```

Como root:

```bash
journalctl -u loja-api -n 80 --no-pager | grep -iE 'error|erro|fatal|cost|management' || echo 'sem erros no log'
```

Esperado logo após a implantação:
- `RESULTADO: OK`;
- C22–C23 e C1–C21 sem divergência;
- os números da etapa 1 iguais, salvo vendas ou despachos feitos entre as etapas;
- `configuracoes`, `lancamentos`, `importacoes` e concessões individuais da Fase 10 em 0.

### 5.2 Navegador, pelo HTTPS

O roteiro está em
[TESTES-PENDENTES.md](TESTES-PENDENTES.md#sglog-fase-10--custos-margem-de-contribuição-e-gestão-41-sglog-fase10md).

## Se algo der errado

| Quando | O que fazer |
|---|---|
| Ensaio (etapa 3) falhou | Nada foi aplicado. Rode `git reset --keep $(cat ~/antes-sglog-fase10.txt)` e traga a saída. |
| Migração falhou (4.1) | A 0029 roda numa transação só, então nada mudou. Com `ocupados`, repita. Com outro erro, volte o código e traga a saída. A API antiga continua no ar. |
| Build falhou (4.2), com a 0029 aplicada | O código antigo funciona com a 0029. Volte o código (`git reset --keep ...`), faça o build antigo e reinicie. A 0029 pode ficar. |
| Painel Gestão lento ou com "Erro interno" | Traga o horário e a saída do `journalctl`. As consultas são só de leitura: nada precisa ser desfeito. |
| Precisar desfazer a 0029 | `npm run migrate -- down`. A reversão é recusada se já existir configuração de custo, lançamento ou importação, e então nada muda. Não apague dados para destravar. Restaurar o backup só com autorização expressa ([BACKUP.md](BACKUP.md)). |
