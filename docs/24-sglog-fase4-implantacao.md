# SGLog — Fase 4: implantação na VPS

Roteiro para levar a Fase 4 ([23-sglog-fase4.md](23-sglog-fase4.md)) à VPS de testes com HTTPS. **Só você executa.**
Rode tudo como o usuário `loja`, na pasta `/srv/loja-embalagens`, exceto o reinício dos serviços, que é como root.
Depois de cada etapa, traga a saída.

- **Versão:** o ramo `sglog/fase4`, depois de integrado à `main`. O hash entra aqui quando o merge for feito; até lá,
  este roteiro não deve ser executado.
- **Dependências:** a Fase 4 não muda `package.json` nem `package-lock.json`, então não é preciso `npm ci`.
- **Migração:** só a `0023_sglog_distribuicao`. A `0020`, a `0021` e a `0022` não mudaram.
- **Alocação automática:** fica **desligada**. Não acrescente `ALLOCATION_AUTO` ao `.env` nesta implantação.

## Etapa 1 — Conferência rápida (só leitura)

```bash
cd /srv/loja-embalagens && git status -sb && git log -1 --format='em uso: %h %s' && git fetch origin && git log --oneline HEAD..origin/main
```

```bash
node -e "process.loadEnvFile('.env');const pg=require('pg');const c=new pg.Client({host:process.env.DB_HOST,port:+process.env.DB_PORT,user:process.env.DB_OWNER_USER,password:process.env.DB_OWNER_PASSWORD,database:process.env.DB_NAME});c.connect().then(()=>c.query('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1')).then(r=>{console.log('ultima migration: '+r.rows[0].name);return c.query(\"SELECT (SELECT count(*) FROM warehouses WHERE is_default)::int AS padrao, (SELECT count(*) FROM orders WHERE status IN ('paid','preparing','ready'))::int AS pedidos_abertos, (SELECT count(*) FROM (SELECT 1 FROM stock_reservations WHERE status='active' AND source_type='order' GROUP BY source_id, variant_id HAVING count(*)>1) x)::int AS reservas_duplicadas, (SELECT count(*) FROM stock_reservations WHERE status='active')::int AS reservas_ativas\")}).then(r=>{console.log('estado: '+JSON.stringify(r.rows[0]));return c.end()}).catch(e=>{console.error('ERRO: '+e.message);process.exit(1)})"
```

```bash
grep -c '^ALLOCATION_AUTO=on' .env || echo 'alocacao automatica desligada'
```

Seguir para a etapa 2 só se tudo abaixo bater:

- o `git status` está limpo, no ramo `main`;
- a última migration é `0022_sglog_estoque`;
- `padrao` é 1 e `reservas_duplicadas` é 0, porque a 0023 recusa sem isso;
- aparece `alocacao automatica desligada`.

## Etapa 2 — Backup recente e verificação

```bash
npm run backup
```

```bash
npm run backup:verify -- backups/<pasta nova>
```

Parar se a verificação não terminar com tudo conferido.

## Etapa 3 — Código novo e ensaio isolado da 0023

O código é atualizado sem build: os serviços continuam no build anterior. O ensaio restaura o backup num banco
temporário, aplica a 0023 só nele, roda a conferência e apaga o banco temporário.

```bash
git rev-parse HEAD > ~/antes-sglog-fase4.txt && git merge --ff-only origin/main && git log -1 --format='%h %s'
```

```bash
node scripts/backup.mjs migrate-rehearsal backups/<pasta da etapa 2>
```

**Parar e trazer a saída.** Não aplicar em produção se acontecer qualquer um destes:

- `FALHOU` ou erro;
- o ensaio aplicar outra migração além da `0023`;
- os bloqueios levarem mais de 1 s ou mais de 50 tentativas;
- pedidos e reservas ficarem bloqueados por mais de 2 s;
- alguma divergência na conferência;
- os avisos não mostrarem:
  - `0023: N pedido(s) pago(s) em aberto aguardando alocacao`, com N igual a `pedidos_abertos` da etapa 1;
  - `M reserva(s) ativa(s) no deposito padrao`, com M igual a `reservas_ativas` da etapa 1.

Para desistir aqui (nada foi migrado nem construído):

```bash
git reset --keep $(cat ~/antes-sglog-fase4.txt) && git log -1 --format='%h %s'
```

## Etapa 4 — Migração, build e reinício

Fazer logo depois do ensaio. A janela com o banco novo e o build antigo é segura:

- o código antigo reserva sem depósito, e a conciliação conta isso como padrão;
- o código antigo despacha sem consultar a alocação, que é o comportamento de antes.

1. Backup do instante:

   ```bash
   npm run backup && npm run backup:verify -- backups/<pasta nova>
   ```

2. Migração. Guardar os avisos `0023:`. Se aparecer `pedidos ou reservas ocupados`, nada mudou: repita alguns minutos depois.

   ```bash
   npm run migrate
   ```

3. Build:

   ```bash
   npm run build -w apps/api && npm run build -w apps/web
   ```

4. Reinício, como root:

   ```bash
   sudo systemctl restart loja-api loja-web && sleep 3 && systemctl is-active loja-api loja-web && curl -s http://127.0.0.1:4010/ready; echo
   ```

## Etapa 5 — Validação

### 5.1 Banco (etapa F estendida à C8 e à C9)

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
  if (last !== '0023_sglog_distribuicao') fail.push('ultima migration nao e a 0023');
  const cols = ['on_hand', 'reserved', 'blocked', 'damaged', 'in_transit'];
  const s = (await q(`SELECT ${cols.map((k) => `(SELECT coalesce(sum(${k}), 0) FROM stock_balances)::text AS t_${k}, (SELECT coalesce(sum(${k}), 0) FROM stock_location_balances)::text AS d_${k}`).join(', ')}`))[0];
  for (const k of cols) if (s['t_' + k] !== s['d_' + k]) fail.push(`${k}: total diferente da soma dos depositos`);
  const neg = (await q('SELECT count(*)::int AS n FROM stock_location_balances WHERE on_hand < 0 OR blocked < 0 OR damaged < 0 OR in_transit < 0 OR reserved < 0'))[0].n;
  if (neg) fail.push('saldo negativo em deposito');
  const lg = await q("SELECT status, coalesce(logistics_status, '-') AS logistica, allocation_required AS exige, count(*)::int AS n FROM orders GROUP BY 1, 2, 3 ORDER BY 1, 2");
  console.log('pedidos (comercial / logistica / exige alocacao): ' + JSON.stringify(lg));
  if (lg.some((r) => ['paid', 'preparing', 'ready'].includes(r.status) && r.logistica !== 'awaiting' && r.logistica !== 'analysis')) fail.push('pedido em aberto sem situacao logistica');
  if (lg.some((r) => ['paid', 'preparing', 'ready'].includes(r.status) && r.exige)) fail.push('pedido anterior marcado como exigindo alocacao');
  const sem = (await q("SELECT count(*)::int AS n FROM stock_reservations WHERE status = 'active' AND warehouse_id IS NULL"))[0].n;
  console.log('reservas ativas sem deposito: ' + sem);
  if (sem) fail.push('reserva ativa sem deposito');
  const f = (await q("SELECT (SELECT count(*) FROM fulfillments)::int AS atendimentos, (SELECT count(*) FROM allocation_decisions)::int AS decisoes, (SELECT dropship_status FROM logistics_settings) AS dropshipping"))[0];
  console.log('fase 4: ' + JSON.stringify(f));
  if (f.dropshipping !== 'blocked') fail.push('dropshipping nao esta bloqueado');
  const r = await q('SELECT check_code, field, variant_id, expected::text, found::text FROM stock_reconcile()');
  const run = r.find((x) => x.check_code === 'run');
  const divs = r.filter((x) => x.check_code !== 'run');
  console.log('conferencia (C1-C9): ' + Number(run.expected) + ' variante(s), ' + divs.length + ' divergencia(s)');
  for (const d of divs.slice(0, 20)) console.log('  ' + JSON.stringify(d));
  if (divs.length) fail.push(divs.length + ' divergencia(s) na conferencia');
  console.log(fail.length ? 'RESULTADO: PARAR - ' + fail.join('; ') : 'RESULTADO: OK');
  await c.end();
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
EOF
```

```bash
journalctl -u loja-api -n 60 --no-pager | grep -iE 'error|erro|fatal|aloca' || echo 'sem erros no log'
```

A rotina pode mover pedidos em aberto de `awaiting` para `analysis`, com o motivo, nos primeiros minutos. É o esperado
quando nenhum depósito cobre o pedido.

### 5.2 Navegador, pelo HTTPS

O roteiro completo está em
[TESTES-PENDENTES.md](TESTES-PENDENTES.md#sglog-fase-4--alocação-dos-pedidos-23-sglog-fase4md). O mínimo para
considerar a atualização no ar:

- **Loja:** busca, carrinho e pagamento de teste sem erro.
- **Painel, menu Logística → Alocação:**
  - os pedidos em aberto aparecem como "Aguardando alocação" ou "Em análise", com o motivo;
  - a alocação automática aparece desligada.
- **Pedido antigo (aberto antes da atualização):** o bloco "Alocação" aparece, mas o despacho continua liberado como
  antes.
- **Pedido novo de teste:**
  1. pagar;
  2. abrir o bloco "Alocação" e confirmar a recomendada;
  3. conferir o selo "Alocado" e a reserva "no Depósito principal";
  4. tentar despachar antes de confirmar dá o aviso, e depois de confirmar libera.
- Rodar o bloco 5.1 de novo: `RESULTADO: OK`.

## Se algo der errado

| Quando | O que fazer |
|---|---|
| Etapa 1 com `reservas_duplicadas` > 0 | Não seguir. Trazer a saída: a 0023 recusaria |
| Etapa 3 (ensaio) falhou | Nada foi aplicado. Voltar o código com `git reset --keep $(cat ~/antes-sglog-fase4.txt)` e trazer a saída |
| Migração falhou (etapa 4.2) | A 0023 roda numa transação só: nada mudou. Se apareceu `pedidos ou reservas ocupados`, repetir. Com outro erro, parar e trazer a saída |
| Build ou reinício falharam | O banco já está na 0023 e o código antigo funciona sobre ela. Trazer a saída; não reverter a migração por conta própria |
| Depois de alocar algum pedido | O `npm run migrate -- down` **recusa** (há decisões e atendimentos) e não muda nada. Não apagar dados para destravar: voltar só o código e corrigir para a frente. Restaurar backup só com autorização expressa ([BACKUP.md](BACKUP.md)) |
