# SGLog — Fase 3: implantação na VPS

Roteiro para levar a Fase 3 ([20-sglog-fase3.md](20-sglog-fase3.md)) à VPS de testes com HTTPS. **Só você executa.**
Rode tudo como o usuário `loja`, na pasta `/srv/loja-embalagens`. A exceção é o reinício dos serviços, que é como
root. Depois de cada etapa, traga a saída.

Não repete as auditorias já concluídas. O diagnóstico completo, os códigos de fornecedor e a diferença herdada foram
feitos nas Fases 1 e 2, em 16/11/2026, e a VPS está em `0ccdc74` com a `0021`. Aqui há só uma conferência rápida de
estado, mais o backup, o ensaio, a migração, o build, o reinício e a validação.

- **Versão no GitHub:** merge `78ea278` (`sglog/fase3` integrada à `main`).
- **Dependências:** `package.json` e `package-lock.json` iguais aos de `0ccdc74`, então não é preciso `npm ci`.
- **Migração:** só a `0022_sglog_estoque`. A `0020` e a `0021` não mudaram.

## Etapa 1 — Conferência rápida (só leitura)

```bash
cd /srv/loja-embalagens && git status -sb && git log -1 --format='em uso: %h %s' && git fetch origin && git log --oneline HEAD..origin/main
```

```bash
node -e "process.loadEnvFile('.env');const pg=require('pg');const c=new pg.Client({host:process.env.DB_HOST,port:+process.env.DB_PORT,user:process.env.DB_OWNER_USER,password:process.env.DB_OWNER_PASSWORD,database:process.env.DB_NAME});c.connect().then(()=>c.query('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1')).then(r=>{console.log('ultima migration: '+r.rows[0].name);return c.query(\"SELECT u.role, count(*)::int AS n, count(*) FILTER (WHERE u.totp_enabled)::int AS com_mfa FROM users u WHERE u.is_active AND u.role IN ('owner','manager','logistics','stock') GROUP BY 1 ORDER BY 1\")}).then(r=>{console.log('papeis de estoque: '+JSON.stringify(r.rows));return c.end()}).catch(e=>{console.error('ERRO: '+e.message);process.exit(1)})"
```

```bash
df -h /srv && du -sh .local/pgdata
```

Seguir para a etapa 2 só se tudo abaixo bater:

- o `git status` está limpo, no ramo `main`;
- a versão em uso é `0ccdc74`;
- o `git log HEAD..origin/main` termina em `78ea278`;
- a última migration é `0021_sglog_fornecedores`;
- o disco livre é maior que 3× o tamanho de `pgdata`.

Os **papéis de estoque** mostram quem tem MFA. Dono e gerente sem MFA continuam consultando, transferindo,
bloqueando e pedindo ajuste. Ajuste direto, estorno, extravio, cancelamento de transferência e cadastro de depósito
passam a exigir MFA. Para isso, ative a verificação em **Painel → Minha conta**; pode ser antes ou depois da
atualização.

## Etapa 2 — Backup recente e verificação

```bash
npm run backup
```

```bash
npm run backup:verify -- backups/<pasta nova>
```

Parar se a verificação não terminar com tudo conferido.

## Etapa 3 — Código novo e ensaio isolado da 0022

O código é atualizado na pasta do sistema, mas **sem build**. Os serviços continuam rodando o build anterior, como
na Fase 2. O ensaio restaura o backup da etapa 2 num banco temporário (`loja_ensaio`) e aplica a 0022 só nele. Depois
mostra os avisos, roda a conferência e apaga o banco temporário. A produção não é tocada.

```bash
git rev-parse HEAD > ~/antes-sglog-fase3.txt && git merge --ff-only origin/main && git log -1 --format='%h %s'
```

```bash
node scripts/backup.mjs migrate-rehearsal backups/<pasta da etapa 2>
```

**Parar e trazer a saída.** Não aplicar em produção se acontecer qualquer um destes:

- `FALHOU` ou erro;
- o ensaio aplicar outra migração além da `0022`;
- os bloqueios levarem mais de 1 s ou mais de 50 tentativas;
- o saldo ficar bloqueado por mais de 2 s;
- alguma divergência na conferência;
- o aviso `1 deposito(s)` não aparecer.

Se precisar desistir aqui, volte só o código (nada foi migrado nem construído). O `--keep` recusa se houver
arquivo alterado, sem perder nada:

```bash
git reset --keep $(cat ~/antes-sglog-fase3.txt) && git log -1 --format='%h %s'
```

## Etapa 4 — Migração, build e reinício

Fazer logo depois do ensaio, em seguida, para a janela com o banco novo e o build antigo ficar curta (segundos a
poucos minutos). Durante essa janela, a loja e o painel antigos continuam funcionando sobre a 0022, porque as
colunas novas têm padrão zero e a contagem sem depósito recebe o padrão por gatilho.

1. Backup do instante:

   ```bash
   npm run backup && npm run backup:verify -- backups/<pasta nova>
   ```

2. Migração. Guardar os avisos `0022:`. Se aparecer `tabelas de estoque ocupadas`, nada mudou: repita alguns minutos
   depois.

   ```bash
   npm run migrate
   ```

3. Build:

   ```bash
   npm run build -w apps/api && npm run build -w apps/web
   ```

4. Reinício, como root (como `loja`, o polkit pede senha e a conexão cai):

   ```bash
   sudo systemctl restart loja-api loja-web && sleep 3 && systemctl is-active loja-api loja-web && curl -s http://127.0.0.1:4010/ready; echo
   ```

## Etapa 5 — Validação

### 5.1 Banco (etapa F estendida aos novos saldos)

A conferência grava uma linha em `stock_reconciliations`; isso é o esperado.

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
  if (last !== '0022_sglog_estoque') fail.push('ultima migration nao e a 0022');
  const wh = await q('SELECT code, is_default, active FROM warehouses ORDER BY code');
  console.log('depositos: ' + JSON.stringify(wh));
  if (wh.filter((w) => w.is_default).length !== 1 || !wh.find((w) => w.code === 'PRINCIPAL' && w.is_default)) fail.push('deposito padrao diferente do esperado');
  const cols = ['on_hand', 'reserved', 'blocked', 'damaged', 'in_transit'];
  const s = (await q(`SELECT ${cols.map((k) => `(SELECT coalesce(sum(${k}), 0) FROM stock_balances)::text AS t_${k}, (SELECT coalesce(sum(${k}), 0) FROM stock_location_balances)::text AS d_${k}`).join(', ')}`))[0];
  console.log('saldos (total / depositos): ' + cols.map((k) => `${k} ${s['t_' + k]} / ${s['d_' + k]}`).join('; '));
  for (const k of cols) if (s['t_' + k] !== s['d_' + k]) fail.push(`${k}: total diferente da soma dos depositos`);
  const neg = (await q('SELECT count(*)::int AS n FROM stock_location_balances WHERE on_hand < 0 OR blocked < 0 OR damaged < 0 OR in_transit < 0 OR reserved < 0'))[0].n;
  console.log('saldos negativos por deposito: ' + neg);
  if (neg) fail.push('saldo negativo em deposito');
  const t = (await q("SELECT (SELECT count(*) FROM stock_transfers)::int AS transferencias, (SELECT count(*) FROM stock_adjustment_requests)::int AS solicitacoes, (SELECT count(*) FROM inventory_counts WHERE warehouse_id IS NULL)::int AS contagens_sem_deposito"))[0];
  console.log('fase 3: ' + JSON.stringify(t));
  if (t.contagens_sem_deposito) fail.push('contagem sem deposito');
  const r = await q('SELECT check_code, field, variant_id, expected::text, found::text FROM stock_reconcile()');
  const run = r.find((x) => x.check_code === 'run');
  const divs = r.filter((x) => x.check_code !== 'run');
  console.log('conferencia (C1-C7): ' + Number(run.expected) + ' variante(s), ' + divs.length + ' divergencia(s)');
  for (const d of divs.slice(0, 20)) console.log('  ' + JSON.stringify(d));
  if (divs.length) fail.push(divs.length + ' divergencia(s) na conferencia');
  console.log(fail.length ? 'RESULTADO: PARAR - ' + fail.join('; ') : 'RESULTADO: OK');
  await c.end();
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
EOF
```

```bash
journalctl -u loja-api -n 40 --no-pager | grep -iE 'error|erro|fatal' || echo 'sem erros no log'
```

### 5.2 Navegador, pelo HTTPS

O roteiro completo do painel está em
[TESTES-PENDENTES.md](TESTES-PENDENTES.md#sglog-fase-3--estoque-por-depósito-20-sglog-fase3md). O mínimo para
considerar a atualização no ar:

- **Loja:**
  - busca, produto e carrinho sem erro no console;
  - o estoque exibido continua o mesmo de antes (vendável do depósito padrão).
- **Painel, menu LOGÍSTICA:**
  - abrir Estoque, Inventário, Transferências, Depósitos, Compras, Reposição e Fornecedores;
  - todos carregam sem erro.
- **Detalhe de um produto:**
  - os 6 números aparecem (vendável, disponível, reservado, bloqueado, avariado, em trânsito);
  - o quadro "Por depósito" mostra só o Depósito principal.
- **Bloqueio de 1 UN:** o vendável cai 1. Liberar o bloqueio e conferir que o vendável voltou.
- **Com MFA ativa:** ajuste de +1 com motivo, depois "Estornar" na linha. O saldo volta ao de antes e "Estornar" some.
- Rodar o bloco 5.1 de novo: `RESULTADO: OK`.

## Se algo der errado

| Quando | O que fazer |
|---|---|
| Etapa 3 (ensaio) falhou | Nada foi aplicado. Voltar o código com `git reset --keep $(cat ~/antes-sglog-fase3.txt)` e trazer a saída |
| Migração falhou (etapa 4.2) | A 0022 roda numa transação só: nada mudou. `tabelas de estoque ocupadas`: repetir. Outro erro: parar e trazer a saída |
| Build ou reinício falharam | O banco já está na 0022 e o código antigo funciona sobre ela. Trazer a saída; não reverter a migração por conta própria |
| Depois de usar a Fase 3 | O `npm run migrate -- down` **recusa** (há dados novos) e não muda nada. Não apagar dados para destravar: voltar só o código e corrigir para a frente. Restaurar backup só com autorização expressa ([BACKUP.md](BACKUP.md)) |
