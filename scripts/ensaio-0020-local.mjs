#!/usr/bin/env node
// Ensaio da migration 0020 (SGLog Fase 1) com dados realistas e concorrencia. SO NO CLUSTER LOCAL de
// desenvolvimento (recusa outro host e NODE_ENV=production); usa um banco proprio, loja_semente, e nunca o banco
// em uso. Ver docs/15-sglog-fase1.md §Ensaios.
//
//   node scripts/ensaio-0020-local.mjs create          cria loja_semente ate a 0019 com o seed de demonstracao
//   node scripts/ensaio-0020-local.mjs deadlock up     venda que toca users / livro / variantes antes do saldo
//                                                      enquanto a 0020 sobe (ou "down": enquanto reverte)
//   node scripts/ensaio-0020-local.mjs load            0020 com 6 vendas simultaneas pelo papel da aplicacao
//   node scripts/ensaio-0020-local.mjs cycle           down e up com conferencia de hash do livro, saldos e reservas
//   node scripts/ensaio-0020-local.mjs stats           reservas ativas, pedidos em andamento, papeis, abertura
//   node scripts/ensaio-0020-local.mjs mig up|down     aplica ou reverte em loja_semente
//   node scripts/ensaio-0020-local.mjs drop            apaga loja_semente
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, arg] = process.argv.slice(2);
process.loadEnvFile(path.join(root, '.env'));
const DBN = 'loja_semente';
if (!['127.0.0.1', 'localhost'].includes(process.env.DB_HOST ?? '')) throw new Error('Ensaio so no cluster local (DB_HOST 127.0.0.1).');
if (process.env.NODE_ENV === 'production') throw new Error('Ensaio recusado: NODE_ENV=production.');
const cfg = (user, password, database = DBN) => ({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user, password, database });
const ownerCfg = () => cfg(process.env.DB_OWNER_USER, process.env.DB_OWNER_PASSWORD);
const appCfg = () => cfg('loja_app', process.env.APP_DB_PASSWORD);
const env = { ...process.env, DB_NAME: DBN };
const tsxArgs = (args) => [path.join(root, 'node_modules/tsx/dist/cli.mjs'), ...args];
const NL = String.fromCharCode(10);

function tsx(args) {
  const r = spawnSync(process.execPath, tsxArgs(args), { cwd: path.join(root, 'apps/api'), env, encoding: 'utf8' });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (r.status !== 0) throw new Error(`falhou: ${args.join(' ')}`);
}
/** Assincrono: o processo das vendas precisa continuar rodando enquanto a migration espera bloqueio. */
function migAsync(dir) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const c = spawn(process.execPath, tsxArgs(['src/db/migrate.ts', dir]), { cwd: path.join(root, 'apps/api'), env });
    let text = '';
    c.stdout.on('data', (d) => (text += d));
    c.stderr.on('data', (d) => (text += d));
    c.on('close', (code) => {
      const lines = text.split(NL).filter((l) => /aviso|up:|down:|deadlock|recusada|error:/.test(l) && !l.startsWith('    at'));
      resolve({ ok: code === 0, ms: Math.round(performance.now() - t0), text: lines.slice(0, 6).join(NL) });
    });
  });
}
async function withOwner(fn) {
  const o = new pg.Client(ownerCfg());
  await o.connect();
  try {
    return await fn(o);
  } finally {
    await o.end();
  }
}

if (cmd === 'create' || cmd === 'drop') {
  const su = JSON.parse(readFileSync(path.join(root, '.local/credentials.json'), 'utf8')).superuser;
  const a = new pg.Client(cfg('postgres', su, 'postgres'));
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${DBN} WITH (FORCE)`);
  if (cmd === 'create') await a.query(`CREATE DATABASE ${DBN} OWNER ${process.env.DB_OWNER_USER} ENCODING 'UTF8' TEMPLATE template0`);
  await a.end();
  if (cmd === 'create') {
    tsx(['src/db/migrate.ts', 'up']);
    tsx(['src/db/migrate.ts', 'down']); // tira a 0020: igual a producao antes da Fase 1
    await withOwner((o) => o.query(`INSERT INTO users (email, name, role, password_hash) VALUES ('dono@semente.local', 'Dono da semente', 'owner', 'sem-login')`));
    tsx(['src/db/demo.ts', 'seed', '--confirmar', 'DEMO']);
  } else console.log(`${DBN} apagado`);
} else if (cmd === 'mig') {
  tsx(['src/db/migrate.ts', arg]);
} else if (cmd === 'stats') {
  await withOwner(async (o) => {
    const q = async (s) => (await o.query(s)).rows;
    const opening = (await q(`SELECT to_regclass('stock_opening_balances') IS NOT NULL AS ok`))[0].ok
      ? (await q(`SELECT count(*)::int AS variantes, sum(reserved)::text AS reservado, sum(reservations_active)::text AS reservas_ativas, count(*) FILTER (WHERE reservations_active <> reserved)::int AS dif_reserva FROM stock_opening_balances`))[0]
      : null;
    console.log(JSON.stringify({
      reservasAtivas: (await q(`SELECT count(*)::int AS n, sum(qty)::text AS qtd FROM stock_reservations WHERE status = 'active'`))[0],
      pedidosPorSituacao: Object.fromEntries((await q(`SELECT status, count(*)::int AS n FROM orders GROUP BY 1 ORDER BY 1`)).map((r) => [r.status, r.n])),
      usuariosPorPapel: Object.fromEntries((await q(`SELECT role, count(*)::int AS n FROM users GROUP BY 1 ORDER BY 1`)).map((r) => [r.role, r.n])),
      abertura: opening,
      variantesSemSaldo: (await q(`SELECT count(*)::int AS n FROM product_variants v WHERE NOT EXISTS (SELECT 1 FROM stock_balances b WHERE b.variant_id = v.id)`))[0].n,
    }, null, 2));
  });
} else if (cmd === 'deadlock') {
  // A aplicacao pode tocar outra tabela ANTES do saldo: a idempotencia do ajuste le o livro, orcamento/pedido
  // grava com FK para users, cadastro mexe em variantes. A venda segura essa tabela, a migration comeca, e so
  // depois a venda pede o saldo. Sem a tecnica de bloqueio da 0020: deadlock.
  const dir = arg === 'down' ? 'down' : 'up';
  const app = new pg.Pool({ ...appCfg(), max: 2 });
  const v = (await app.query(`SELECT variant_id FROM stock_balances WHERE on_hand - reserved >= 50 ORDER BY variant_id LIMIT 3`)).rows.map((r) => r.variant_id);
  const scenarios = [
    ['users', `SELECT 1 FROM users LIMIT 1`],
    ['stock_movements', `SELECT 1 FROM stock_movements WHERE request_key = 'nao-existe'`],
    ['product_variants', `UPDATE product_variants SET updated_at = updated_at WHERE id = '${v[2]}'`],
  ];
  const out = [];
  for (const [i, [table, first]] of scenarios.entries()) {
    const c = await app.connect();
    await c.query('BEGIN');
    await c.query(first);
    const mig = migAsync(dir);
    await new Promise((r) => setTimeout(r, 1200));
    const t0 = performance.now();
    let sale = 'ok';
    try {
      const b = (await c.query('UPDATE stock_balances SET on_hand = on_hand + 1, updated_at = now() WHERE variant_id = $1 RETURNING on_hand, reserved, avg_cost_cents', [v[i % 2]])).rows[0];
      await c.query(`INSERT INTO stock_movements (variant_id, kind, on_hand_delta, reserved_delta, on_hand_after, reserved_after, avg_cost_after, source_type, source_id) VALUES ($1, 'receipt', 1, 0, $2, $3, $4, 'manual', 'ensaio-deadlock')`, [v[i % 2], b.on_hand, b.reserved, b.avg_cost_cents]);
      await c.query('COMMIT');
    } catch (err) {
      sale = `${err.code} ${err.message}`;
      await c.query('ROLLBACK');
    }
    const saleMs = Math.round(performance.now() - t0);
    c.release();
    const m = await mig;
    out.push({ tocouAntes: table, venda: sale, esperaDaVendaMs: saleMs, migracao: m.ok ? 'ok' : 'falhou', migracaoMs: m.ms, saida: m.text });
    if (m.ok) {
      const back = await migAsync(dir === 'up' ? 'down' : 'up'); // volta ao estado do proximo cenario
      if (!back.ok) throw new Error(`nao voltou: ${back.text}`);
    }
  }
  console.log(JSON.stringify(out, null, 2));
  await app.end();
} else if (cmd === 'load') {
  // Vendas simultaneas como a aplicacao faz (saldo total antes do livro), pelo papel loja_app, durante a migration.
  const app = new pg.Pool({ ...appCfg(), max: 6 });
  const variants = (await app.query(`SELECT variant_id FROM stock_balances WHERE on_hand - reserved >= 50 ORDER BY variant_id LIMIT 6`)).rows.map((r) => r.variant_id);
  let stop = false;
  let done = 0;
  let failed = 0;
  let maxWait = 0;
  const worker = async (variantId) => {
    while (!stop) {
      const c = await app.connect();
      const t0 = performance.now();
      try {
        await c.query('BEGIN');
        const b = (await c.query('UPDATE stock_balances SET on_hand = on_hand + 1, updated_at = now() WHERE variant_id = $1 RETURNING on_hand, reserved, avg_cost_cents', [variantId])).rows[0];
        await c.query(`INSERT INTO stock_movements (variant_id, kind, on_hand_delta, reserved_delta, on_hand_after, reserved_after, avg_cost_after, source_type, source_id) VALUES ($1, 'receipt', 1, 0, $2, $3, $4, 'manual', 'ensaio-carga')`, [variantId, b.on_hand, b.reserved, b.avg_cost_cents]);
        await c.query('COMMIT');
        done++;
      } catch (err) {
        failed++;
        await c.query('ROLLBACK');
        console.error(`venda simultanea falhou: ${err.message}`);
      } finally {
        maxWait = Math.max(maxWait, performance.now() - t0);
        c.release();
      }
    }
  };
  const workers = variants.map(worker);
  await new Promise((r) => setTimeout(r, 300));
  const m = await migAsync('up');
  await new Promise((r) => setTimeout(r, 300));
  stop = true;
  await Promise.all(workers);
  console.log(m.text);
  const divs = m.ok ? (await app.query(`SELECT check_code, field, expected, found FROM stock_reconcile() WHERE check_code <> 'run'`)).rows : null;
  const opening = m.ok ? (await app.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE ledger_on_hand <> on_hand OR ledger_reserved <> reserved OR reservations_active <> reserved)::int AS diff FROM stock_opening_balances`)).rows[0] : null;
  console.log(JSON.stringify({ variantesSobCarga: variants.length, vendasDuranteEnsaio: done, vendasQueFalharam: failed, maiorEsperaDeUmaVendaMs: Math.round(maxWait), migracaoOk: m.ok, migracaoMs: m.ms, abertura: opening, divergenciasDepois: divs }, null, 2));
  await app.end();
} else if (cmd === 'cycle') {
  // down e up com dados: nada do livro, do saldo nem das reservas pode mudar.
  await withOwner(async (o) => {
    const snap = async () => (await o.query(`SELECT (SELECT count(*) FROM stock_movements)::int AS mov,
      (SELECT md5(string_agg(id::text || on_hand_delta || reserved_delta || on_hand_after || reserved_after, ',' ORDER BY id)) FROM stock_movements) AS livro,
      (SELECT md5(string_agg(variant_id::text || on_hand || reserved || avg_cost_cents, ',' ORDER BY variant_id)) FROM stock_balances) AS saldos,
      (SELECT md5(string_agg(id::text || status || qty, ',' ORDER BY id)) FROM stock_reservations) AS reservas`)).rows[0];
    const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    const a = await snap();
    let t = performance.now();
    tsx(['src/db/migrate.ts', 'down']);
    const downMs = Math.round(performance.now() - t);
    const b = await snap();
    t = performance.now();
    tsx(['src/db/migrate.ts', 'up']);
    const upMs = Math.round(performance.now() - t);
    const c = await snap();
    const divs = (await o.query(`SELECT 1 FROM stock_reconcile() WHERE check_code <> 'run'`)).rowCount;
    console.log(JSON.stringify({ antes: a, downMs, upMs, historicoIntactoNoDown: same(a, b), historicoIntactoNoUp: same(a, c), divergenciasDepoisDoUp: divs }, null, 2));
  });
} else {
  console.error('Uso: node scripts/ensaio-0020-local.mjs create | deadlock up|down | load | cycle | stats | mig up|down | drop');
  process.exit(1);
}
