# SGLog — Fase 7: implantação na VPS

Roteiro para levar a Fase 7 ([32-sglog-fase7.md](32-sglog-fase7.md)) à VPS de testes com HTTPS. **Só você executa.**
Segue o roteiro da Fase 6 ([30-sglog-fase6-implantacao.md](30-sglog-fase6-implantacao.md)). A 0026 também é compatível
com o código anterior (D7-12), então a API **não** precisa ficar parada durante a migração.

**Não execute antes do merge e do push autorizados.** O hash final entra aqui nesse momento.

- **Usuários:**
  - os comandos do projeto rodam como `loja`, na pasta `/srv/loja-embalagens`; para entrar como ele, use
    `sudo -u loja -H bash`;
  - `systemctl` e `journalctl` rodam como root.
- **Versão:** a `main` depois do avanço rápido para `sglog/fase7`: o planejamento (`20578fa`) e os commits da Fase 7.
- **Migração:** só a `0026_sglog_abastecimento`. As migrações de `0020` a `0025` não mudaram.
- **Dependências:** nenhum `package.json` mudou. **Não rode `npm ci`.**
- **Travas que continuam:**
  - `ALLOCATION_AUTO` desligado;
  - dropshipping e remessas múltiplas `blocked`;
  - e-mail ao fornecedor `blocked`;
  - NF-e sem mudança: não altere `invoice_status` na VPS.
- **Mudanças de comportamento:**
  - "Marcar como enviado" deu lugar a "Registrar envio ao fornecedor", que grava o documento. O envio exige:
    - razão social e CNPJ da empresa;
    - endereço de entrega: o do depósito de destino, ou o da empresa quando é o depósito padrão.

    A etapa 1 confere esses dados.
  - As compras já enviadas ficam "anteriores ao acompanhamento". Não geram alerta de confirmação nem de atraso
    retroativo.
  - Encomendas ativas sem compra viram requisição automática no primeiro ciclo da API, em até 60 s. Não cria compra nem
    reserva.

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
      (SELECT count(*) FROM purchase_orders WHERE status IN ('sent', 'partial'))::int AS compras_enviadas,
      (SELECT count(*) FROM stock_reservations r JOIN orders o ON r.source_type = 'order' AND o.id::text = r.source_id
         WHERE r.status = 'active' AND r.backorder AND o.status IN ('paid', 'preparing', 'ready'))::int AS encomendas_ativas,
      (SELECT dropship_status FROM logistics_settings) AS dropshipping,
      (SELECT multi_shipment_status FROM logistics_settings) AS remessas_multiplas`))[0];
  console.log('estado: ' + JSON.stringify(e));
  const co = (await q(`SELECT legal_name IS NOT NULL AND cnpj IS NOT NULL AS razao_cnpj,
      (street IS NOT NULL AND number IS NOT NULL AND district IS NOT NULL AND city IS NOT NULL AND uf IS NOT NULL AND cep IS NOT NULL) AS endereco
      FROM company_profiles ORDER BY version DESC LIMIT 1`))[0] ?? { razao_cnpj: false, endereco: false };
  console.log('empresa: ' + JSON.stringify(co));
  const w = await q(`SELECT name, is_default,
      (street IS NOT NULL AND number IS NOT NULL AND district IS NOT NULL AND city IS NOT NULL AND uf IS NOT NULL AND cep IS NOT NULL) AS endereco
      FROM warehouses WHERE active ORDER BY is_default DESC, name`);
  for (const x of w) console.log('deposito: ' + JSON.stringify(x));
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
  - a última migration é `0025_sglog_compras`;
  - `dropshipping` e `remessas_multiplas` estão `blocked`.
- **Alocação automática:** aparece `alocacao automatica desligada`.

Anote `compras_enviadas` e `encomendas_ativas`.

Dados da empresa e dos depósitos não impedem a implantação. Se `empresa.razao_cnpj` for `false`, ou se um depósito usado
em compras tiver `endereco: false`, o envio de compras fica bloqueado até completar o cadastro. O depósito padrão pode
usar o endereço da empresa. Complete pelo painel, em Empresa ou Depósitos, antes de testar o envio.

## Etapa 2 — Backup recente e verificação

Como `loja`. Use **o nome que o `npm run backup` imprimir**.

```bash
npm run backup
```

```bash
npm run backup:verify -- backups/<nome impresso acima>
```

## Etapa 3 — Código novo e ensaio da 0026 numa cópia

Como `loja`. O banco em uso não é tocado. A 0026 não cria linhas em tabelas existentes, então o ensaio deve mostrar as
mesmas contagens antes e depois.

```bash
git rev-parse HEAD > ~/antes-sglog-fase7.txt && git merge --ff-only origin/main && git log -1 --format='%h %s'
```

```bash
git diff --stat $(cat ~/antes-sglog-fase7.txt) HEAD -- package.json package-lock.json apps/api/package.json apps/web/package.json
```

O `diff` deve sair vazio. Se aparecer algum arquivo, pare e traga a saída.

```bash
node scripts/backup.mjs migrate-rehearsal backups/<nome da etapa 2>
```

**Pare e traga a saída** se aparecer qualquer um destes:
- `FALHOU` ou erro;
- outra migração além da `0026`;
- `0026: bloqueios obtidos` com mais de 1000 ms ou mais de 50 tentativas;
- `0026: compras bloqueadas por` com mais de 2000 ms;
- divergência na conferência;
- o aviso `0026: X compra(s) enviada(s) ficam como anteriores ao acompanhamento ...; Y encomenda(s) ativa(s) ...`
  sem bater com a etapa 1. X deve ser igual a `compras_enviadas` e Y igual a `encomendas_ativas`.

Para desistir aqui, sem nada migrado nem construído:

```bash
git reset --keep $(cat ~/antes-sglog-fase7.txt) && git log -1 --format='%h %s'
```

## Etapa 4 — Migração, build e reinício

A API continua no ar durante a migração: o código anterior funciona com a 0026 (suíte anterior 451/451 contra o banco
migrado, inclusive escrita).

1. Como `loja`, a migração. Guarde os avisos `0026:`. Com `compras ocupadas`, nada mudou: repita em seguida.

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

Como `loja`, depois de ao menos 1 minuto com a API no ar (primeiro ciclo das requisições automáticas):

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
  if (last !== '0026_sglog_abastecimento') fail.push('ultima migration nao e a 0026');
  const cols = ['on_hand', 'reserved', 'blocked', 'damaged', 'in_transit'];
  const s = (await q(`SELECT ${cols.map((k) => `(SELECT coalesce(sum(${k}), 0) FROM stock_balances)::text AS t_${k}, (SELECT coalesce(sum(${k}), 0) FROM stock_location_balances)::text AS d_${k}`).join(', ')}`))[0];
  for (const k of cols) if (s['t_' + k] !== s['d_' + k]) fail.push(`${k}: total diferente da soma dos depositos`);
  const t = (await q(`SELECT (SELECT dropship_status FROM logistics_settings) AS dropshipping,
      (SELECT multi_shipment_status FROM logistics_settings) AS remessas_multiplas,
      (SELECT supplier_email_status FROM logistics_settings) AS email_fornecedor,
      (SELECT purchase_confirmation_days FROM logistics_settings) AS prazo_confirmacao_dias,
      (SELECT count(*) FROM purchase_orders WHERE status IN ('sent', 'partial') AND confirmation_status = 'none')::int AS enviadas_anteriores,
      (SELECT count(*) FROM purchase_order_documents)::int AS documentos,
      (SELECT count(*) FROM purchase_confirmations)::int AS confirmacoes,
      (SELECT count(*) FROM purchase_requests WHERE source = 'backorder')::int AS requisicoes_automaticas,
      (SELECT count(*) FROM purchase_requests WHERE source = 'manual')::int AS requisicoes_manuais,
      (SELECT count(*) FROM purchase_order_items WHERE canceled_packs > 0)::int AS itens_cancelados`))[0];
  console.log('fase 7: ' + JSON.stringify(t));
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
journalctl -u loja-api -n 80 --no-pager | grep -iE 'error|erro|fatal|purchase|compra|request' || echo 'sem erros no log'
```

Esperado logo após a implantação:
- `RESULTADO: OK`;
- `email_fornecedor` `blocked` e `prazo_confirmacao_dias` 2;
- `enviadas_anteriores` igual a `compras_enviadas` da etapa 1;
- `documentos`, `confirmacoes`, `requisicoes_manuais` e `itens_cancelados` 0;
- `requisicoes_automaticas` no máximo `encomendas_ativas`: uma por encomenda sem compra vinculada suficiente.

### 5.2 Navegador, pelo HTTPS

Roteiro em [TESTES-PENDENTES.md](TESTES-PENDENTES.md#sglog-fase-7--abastecimento-e-fornecedores-32-sglog-fase7md).

## Se algo der errado

| Quando | O que fazer |
|---|---|
| Ensaio (etapa 3) falhou | Nada foi aplicado. `git reset --keep $(cat ~/antes-sglog-fase7.txt)` e trazer a saída |
| Migração falhou (4.1) | A 0026 roda numa transação só: nada mudou. Com `ocupadas`, repetir. Com outro erro, voltar o código e trazer a saída. A API antiga continua no ar |
| Build falhou (4.2), com a 0026 aplicada | O código antigo funciona com a 0026: voltar o código (`git reset --keep ...`), fazer o build antigo e reiniciar. A 0026 pode ficar |
| Precisar desfazer a 0026 | `npm run migrate -- down`. É recusado se a Fase 7 já foi usada, e então nada muda. Contam como uso: documento, confirmação, requisição (inclusive automática), envio ou contato registrado, prazo diferente de 2. Não apagar dados para destravar; restaurar backup só com autorização expressa ([BACKUP.md](BACKUP.md)) |
