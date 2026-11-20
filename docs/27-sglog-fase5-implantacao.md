# SGLog — Fase 5: implantação na VPS

Roteiro para levar a Fase 5 ([26-sglog-fase5.md](26-sglog-fase5.md)) à VPS de testes com HTTPS. **Só você executa.**
Ele segue o roteiro da Fase 4 ([24-sglog-fase4-implantacao.md](24-sglog-fase4-implantacao.md)), com três diferenças:
o `loja-api` fica parado durante a migração, não há `npm ci`, e a conferência vai até a C11.

- **Usuários:** os comandos do projeto rodam como `loja`, na pasta `/srv/loja-embalagens`, e para entrar como ele use
  `sudo -u loja -H bash`. `systemctl` e `journalctl` rodam como root. Cada etapa diz qual usuário usar.
- **Versão:** a `main` depois do avanço rápido (`--ff-only`) para o ramo `sglog/fase5`. Hoje a VPS está em `d3c15f6`.
  Entre os dois:
  - os três commits de documentação da `main` local: `bc427f0`, `7d01563` e `55cc51d`;
  - os commits da Fase 5, de `cbfb305` até o último da branch, que inclui este roteiro.

  O hash final entra aqui quando o merge e o push forem autorizados e feitos. Até lá, este roteiro não deve ser
  executado.
- **Migração:** só a `0024_sglog_remessas`. As migrações de `0020` a `0023` não mudaram.
- **Dependências:** **não rode `npm ci`**.
  - O `package.json` e o `package-lock.json` mudaram só para incluir o `@playwright/test`, que é dependência de
    desenvolvimento.
  - Nenhum build nem serviço usa esse pacote. O build da API compila só `apps/api/src`, e o da web, só `apps/web`.
  - O pacote não baixa navegador na instalação. Se um `npm ci` futuro o instalar, ele fica parado na pasta
    `node_modules`.
- **Travas que continuam:**
  - `ALLOCATION_AUTO` fica desligado; não acrescente essa variável ao `.env`;
  - as remessas múltiplas nascem `blocked`; não libere em Expedição → Regras;
  - a validação fiscal não muda. **Não altere `invoice_status` de nenhum pedido na VPS.** No teste local, a NF-e
    de um pedido foi dispensada direto no banco, só para ver a entrega no balcão. Isso não deve ser repetido aqui.
- **Por que parar o `loja-api` na etapa 4:**
  - a 0024 troca a unicidade das mensagens de WhatsApp de "pedido + evento" para "pedido + evento + remessa", para
    permitir um aviso por remessa;
  - o código anterior grava esses avisos com `ON CONFLICT (order_id, event)`;
  - se ele rodar sobre o banco já migrado, essa gravação dá erro, por exemplo ao confirmar um pagamento.

  Por isso o `loja-api` fica parado entre a migração e o reinício, por cerca de 1 a 2 minutos. Pelo mesmo motivo, voltar
  só o código depois da migração não funciona: ver "Se algo der errado".

## Ensaio local deste roteiro (20/11/2026)

As etapas 1 a 3 foram executadas no computador local, com os comandos deste documento, num banco preparado como a VPS:
- `loja_preremessas`, com as migrações até a 0023 e a demonstração anterior à Fase 5;
- reservas no depósito padrão e 2 pedidos pagos com alocação confirmada (nº 1436 e 1438).

Resultados:
- **Etapa 1:**
  - `remessas_existentes` 400, `remessas_entregues` 394;
  - `pedidos_alocados_em_aberto` 2 (nº 1436 e 1438);
  - `pedidos_com_2_remessas` e `alocados_em_2_depositos` 0.
- **Etapa 2:** backup criado e conferido.
- **Etapa 3:**
  - `bloqueios obtidos em 1 ms`, `remessas bloqueadas por 189 ms`;
  - `400 remessa(s) antiga(s) (394 entregue(s)), 2 remessa(s) pendente(s)`;
  - `remessas: 400 antiga(s) preservada(s), 2 pendente(s) nova(s)`;
  - conferência com 204 variantes e 0 divergências;
  - `Ensaio de migration OK`.
- **Bloco 5.1, depois de migrar a cópia:** `RESULTADO: OK`, com:
  - remessas `legacy` 394 entregues e 6 despachadas;
  - 1 `delivery` e 1 `pickup` em `pending`;
  - travas `blocked` e conferência C1–C11 sem divergência.
- **Volta:** `npm run migrate -- down` sem uso da expedição desfez a 0024, e o `up` aplicou de novo.

O ensaio precisou de um ajuste no `scripts/backup.mjs`, que está neste mesmo pacote. Antes, ele exigia que nenhuma
tabela da lista mudasse de tamanho, e a 0024 cria remessas pendentes: a VPS daria `FALHOU` mesmo com a migração
correta. Agora, em `shipments`, ele compara as remessas antigas e mostra as novas à parte.

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
  const alloc = `FROM orders o JOIN fulfillments f ON f.order_id = o.id AND f.status = 'confirmed' AND f.mode IN ('stock', 'purchase_to_order')
                 JOIN fulfillment_allocations a ON a.fulfillment_id = f.id AND a.status = 'active'
                 WHERE o.logistics_status = 'processing' AND o.status IN ('paid', 'preparing', 'ready')`;
  const e = (await q(`SELECT
      (SELECT count(*) FROM shipments)::int AS remessas_existentes,
      (SELECT count(*) FROM shipments WHERE delivered_at IS NOT NULL)::int AS remessas_entregues,
      (SELECT count(*) FROM (SELECT 1 FROM shipments GROUP BY order_id HAVING count(*) > 1) x)::int AS pedidos_com_2_remessas,
      (SELECT count(DISTINCT o.id) ${alloc})::int AS pedidos_alocados_em_aberto,
      (SELECT count(*) FROM (SELECT o.id ${alloc} GROUP BY o.id HAVING count(DISTINCT a.warehouse_id) > 1) x)::int AS alocados_em_2_depositos,
      (SELECT dropship_status FROM logistics_settings) AS dropshipping`))[0];
  console.log('estado: ' + JSON.stringify(e));
  const nums = (await q(`SELECT DISTINCT o.number ${alloc} ORDER BY 1`)).map((r) => r.number);
  console.log('pedidos que ganham remessa pendente: ' + (nums.join(', ') || 'nenhum'));
  await c.end();
})().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
EOF
```

```bash
grep -c '^ALLOCATION_AUTO=on' .env || echo 'alocacao automatica desligada'
```

Anote os números. Siga para a etapa 2 só se tudo abaixo bater:

- **Git:** o ramo é `main`, em uso `d3c15f6`. Fora do controle de versão aparecem só os dois arquivos de sempre,
  `.env.antes-dominio` e `embalagemcanoinhas.inc.php,`, que não devem ser apagados. O `git log HEAD..origin/main`
  mostra os commits listados em "Versão".
- **Banco:**
  - a última migration é `0023_sglog_distribuicao`;
  - `pedidos_com_2_remessas` é 0, porque a 0024 recusa sem isso;
  - `alocados_em_2_depositos` é 0, porque nesta fase a remessa sai de um depósito só e a 0024 recusaria. Se não for 0,
    pare e traga a saída.
- **Alocação automática:** aparece `alocacao automatica desligada`.

## Etapa 2 — Backup recente e verificação

Como `loja`. Use **o nome que o `npm run backup` imprimir**, nunca "o último da pasta".

```bash
npm run backup
```

```bash
npm run backup:verify -- backups/<nome impresso acima>
```

Pare se a verificação não terminar com tudo conferido.

## Etapa 3 — Código novo e ensaio da 0024 numa cópia

Como `loja`. O código é atualizado sem build, e os serviços continuam no build anterior. O ensaio:

1. restaura o backup da etapa 2 num banco temporário (`loja_ensaio`);
2. aplica a 0024 só nele;
3. confere que as tabelas antigas não perderam nem ganharam linhas. Em `shipments`, compara as remessas antigas e
   mostra à parte as pendentes novas;
4. roda a conciliação, que depois da 0024 vai de C1 a C11;
5. apaga o banco temporário.

O banco em uso não é tocado.

```bash
git rev-parse HEAD > ~/antes-sglog-fase5.txt && git merge --ff-only origin/main && git log -1 --format='%h %s'
```

```bash
git diff --stat $(cat ~/antes-sglog-fase5.txt) HEAD -- package.json package-lock.json apps/api/package.json apps/web/package.json
```

Esse `diff` deve mostrar só `package.json` e `package-lock.json`, com o `@playwright/test`. Se aparecer
`apps/api/package.json` ou `apps/web/package.json`, pare e traga a saída: nesse caso seria preciso `npm ci`.

```bash
node scripts/backup.mjs migrate-rehearsal backups/<nome da etapa 2>
```

**Pare e traga a saída.** Não aplique no banco em uso se acontecer qualquer um destes:

- `FALHOU` ou erro;
- o ensaio aplicar outra migração além da `0024`;
- `0024: bloqueios obtidos` com mais de 1000 ms ou mais de 50 tentativas;
- `0024: remessas bloqueadas por` mais de 2000 ms;
- alguma divergência na `conferencia do estoque (stock_reconcile)`;
- o aviso `0024: X remessa(s) antiga(s) (Y entregue(s)), Z remessa(s) pendente(s) criada(s)` não bater com a etapa 1:
  - X igual a `remessas_existentes`;
  - Y igual a `remessas_entregues`;
  - Z igual a `pedidos_alocados_em_aberto`.

  A linha `remessas: X antiga(s) preservada(s), Z pendente(s) nova(s)` do ensaio repete esses números.

Para desistir aqui, sem nada migrado nem construído:

```bash
git reset --keep $(cat ~/antes-sglog-fase5.txt) && git log -1 --format='%h %s'
```

## Etapa 4 — Migração, build e reinício

Faça logo depois do ensaio. O `loja-api` fica parado do passo 2 ao 5, cerca de 1 a 2 minutos. A loja mostra erro de
carregamento nesse intervalo. O Mercado Pago reenvia as notificações que falharem.

1. Como `loja`, backup do instante:

   ```bash
   npm run backup
   ```

   ```bash
   npm run backup:verify -- backups/<nome impresso acima>
   ```

2. Como root, parar só a API:

   ```bash
   systemctl stop loja-api && systemctl is-active loja-api; true
   ```

   Deve aparecer `inactive`.

3. Como `loja`, a migração. Guarde os avisos `0024:`. Se aparecer `pedidos ou remessas ocupados`, nada mudou: repita
   em seguida, porque a API parada libera os bloqueios.

   ```bash
   npm run migrate
   ```

4. Como `loja`, o build:

   ```bash
   npm run build -w apps/api && npm run build -w apps/web
   ```

5. Como root, subir os dois serviços:

   ```bash
   systemctl restart loja-api loja-web && sleep 3 && systemctl is-active loja-api loja-web && curl -s http://127.0.0.1:4010/ready; echo
   ```

   Deve aparecer `active`, `active` e `{"ok":true}`.

## Etapa 5 — Validação

### 5.1 Banco: bloco 5.1 estendido à C10 e à C11

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
  if (last !== '0024_sglog_remessas') fail.push('ultima migration nao e a 0024');
  const cols = ['on_hand', 'reserved', 'blocked', 'damaged', 'in_transit'];
  const s = (await q(`SELECT ${cols.map((k) => `(SELECT coalesce(sum(${k}), 0) FROM stock_balances)::text AS t_${k}, (SELECT coalesce(sum(${k}), 0) FROM stock_location_balances)::text AS d_${k}`).join(', ')}`))[0];
  for (const k of cols) if (s['t_' + k] !== s['d_' + k]) fail.push(`${k}: total diferente da soma dos depositos`);
  const neg = (await q('SELECT count(*)::int AS n FROM stock_location_balances WHERE on_hand < 0 OR blocked < 0 OR damaged < 0 OR in_transit < 0 OR reserved < 0'))[0].n;
  if (neg) fail.push('saldo negativo em deposito');
  const sem = (await q("SELECT count(*)::int AS n FROM stock_reservations WHERE status = 'active' AND warehouse_id IS NULL"))[0].n;
  console.log('reservas ativas sem deposito: ' + sem);
  if (sem) fail.push('reserva ativa sem deposito');
  const rem = await q("SELECT kind, status, count(*)::int AS n FROM shipments GROUP BY 1, 2 ORDER BY 1, 2");
  console.log('remessas (tipo / situacao): ' + JSON.stringify(rem));
  const t = (await q(`SELECT (SELECT dropship_status FROM logistics_settings) AS dropshipping,
      (SELECT multi_shipment_status FROM logistics_settings) AS remessas_multiplas,
      (SELECT distinct_checker FROM logistics_settings) AS conferente_distinto,
      (SELECT count(*) FROM shipment_checks)::int AS registros_conferencia,
      (SELECT count(*) FROM (SELECT 1 FROM shipments WHERE status <> 'canceled' AND kind <> 'legacy' GROUP BY order_id HAVING count(*) > 1) x)::int AS pedidos_com_2_remessas_novas`))[0];
  console.log('fase 5: ' + JSON.stringify(t));
  if (t.dropshipping !== 'blocked') fail.push('dropshipping nao esta bloqueado');
  if (t.remessas_multiplas !== 'blocked') fail.push('remessas multiplas nao estao bloqueadas');
  if (t.pedidos_com_2_remessas_novas) fail.push('pedido com mais de uma remessa nova');
  const r = await q('SELECT check_code, field, variant_id, expected::text, found::text FROM stock_reconcile()');
  const run = r.find((x) => x.check_code === 'run');
  const divs = r.filter((x) => x.check_code !== 'run');
  console.log('conferencia (C1-C11): ' + Number(run.expected) + ' variante(s), ' + divs.length + ' divergencia(s)');
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
journalctl -u loja-api -n 80 --no-pager | grep -iE 'error|erro|fatal|remessa|shipment' || echo 'sem erros no log'
```

Esperado:
- `RESULTADO: OK`;
- remessas `legacy` com as mesmas quantidades da etapa 1, `delivery`/`pickup`/`marketplace` em `pending` iguais a
  `pedidos_alocados_em_aberto`;
- `remessas_multiplas` `blocked`, `conferente_distinto` `false` e `registros_conferencia` 0.

### 5.2 Navegador, pelo HTTPS

O roteiro completo está em
[TESTES-PENDENTES.md](TESTES-PENDENTES.md#sglog-fase-5--remessas-e-expedição-26-sglog-fase5md). O mínimo para
considerar a atualização no ar:

1. **Loja:** busca, carrinho e um pedido de teste até a tela de pagamento, sem erro.
2. **Logística → Expedição:**
   - os contadores aparecem;
   - "Remessas múltiplas" mostra "Travadas";
   - os pedidos listados na etapa 1 estão em "A separar";
   - a tela abre a 375 px sem rolagem lateral.
3. **Um pedido de demonstração da lista.** Anote o saldo do produto antes. Depois:
   1. iniciar a separação, separar e concluir;
   2. conferir por SKU; uma unidade a mais deve ser recusada e aparecer no histórico;
   3. embalar.

   O saldo não muda. A remessa para em "Embalada" com "Aguardando NF-e": é o esperado sem a NF-e configurada.
   **Não force a nota pelo banco.**
4. **Pedido antigo, sem alocação obrigatória:** os botões de antes continuam.
5. Rode o bloco 5.1 de novo: `RESULTADO: OK`, com C1–C11 sem divergência.

## Se algo der errado

| Quando | O que fazer |
|---|---|
| Etapa 1 com `pedidos_com_2_remessas` ou `alocados_em_2_depositos` > 0 | Não seguir. Trazer a saída |
| Etapa 3 (ensaio) falhou | Nada foi aplicado. Voltar o código com `git reset --keep $(cat ~/antes-sglog-fase5.txt)` e trazer a saída |
| Migração falhou (4.3) | A 0024 roda numa transação só: nada mudou. Com `ocupados`, repetir. Com outro erro: voltar o código (`git reset --keep ...`), religar com `systemctl start loja-api` (o build antigo continua no lugar, porque o build novo ainda não rodou) e trazer a saída |
| Build falhou (4.4), com a 0024 aplicada | Manter o `loja-api` **parado**. O build antigo não funciona com a 0024 (avisos de WhatsApp). Trazer a saída: o caminho é corrigir para a frente, ou desfazer a 0024 com `npm run migrate -- down`, voltar o código e fazer o build antigo |
| Reinício falhou (4.5) | Trazer `systemctl status loja-api` e `journalctl -u loja-api -n 80` |
| Precisar voltar ao código anterior **depois** da 0024 | Primeiro `npm run migrate -- down`. Ele recusa se a expedição já foi usada (remessa além de `pending`, conferência, aviso de WhatsApp por remessa) e então não muda nada. Só depois `git reset --keep ...`, build e reinício. Não apagar dados para destravar; restaurar backup só com autorização expressa ([BACKUP.md](BACKUP.md)) |
