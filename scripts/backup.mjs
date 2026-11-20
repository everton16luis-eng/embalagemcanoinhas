#!/usr/bin/env node
// Copia de seguranca do banco e dos arquivos (storage/, inclui XML e DANFE das notas) e teste de restauracao.
//
//   node scripts/backup.mjs backup [--out pasta]     cria backups/AAAAMMDD-HHMMSS/ com db.dump, storage/ e manifest.json
//   node scripts/backup.mjs verify <pasta>           confere o sha256 de cada arquivo da copia
//   node scripts/backup.mjs restore-test <pasta>     restaura num banco TEMPORARIO, compara contagens e hashes, apaga o temporario
//   node scripts/backup.mjs migrate-rehearsal <pasta>  ensaio das migrations pendentes numa copia restaurada (banco
//                                                    TEMPORARIO loja_ensaio): tempo, conferencia do estoque, contagens
//   node scripts/backup.mjs prune [--dry-run]        apaga copias locais fora da retencao (7 diarias, 4 semanais, 12 mensais)
//   node scripts/backup.mjs offsite [--dry-run]      envia as copias ao remoto cifrado do rclone (BACKUP_REMOTE) e aplica
//                                                    a mesma retencao la
//
// Nunca restaura por cima do banco em uso. Restaurar de verdade (desastre) e manual e esta descrito em docs/BACKUP.md.
// Credenciais vem do .env (dono das tabelas) e, para criar o banco temporario, de .local/credentials.json (cluster
// local) ou das variaveis RESTORE_ADMIN_USER / RESTORE_ADMIN_PASSWORD.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A copia tem o banco inteiro (clientes, hashes de senha): so o usuario da loja le. Vale tambem para o pg_dump,
// que herda a mascara. Auditoria 11/2026: no servidor as copias saiam legiveis por qualquer usuario.
process.umask(0o077);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = process.env;
const DB = { host: env.DB_HOST ?? '127.0.0.1', port: env.DB_PORT ?? '54330', name: env.DB_NAME ?? 'loja_dev', user: env.DB_OWNER_USER ?? 'loja_owner', password: env.DB_OWNER_PASSWORD };
// STORAGE_DIR no .env e relativo a apps/api (onde a API roda).
const storageDir = path.resolve(root, 'apps/api', env.STORAGE_DIR ?? '../../storage');

// Tabelas conferidas depois da restauracao (as que nao podem se perder).
const CHECK_TABLES = ['users', 'products', 'packagings', 'stock_movements', 'orders', 'order_items', 'payments', 'quotes', 'quote_items', 'marketplace_accounts', 'marketplace_orders', 'purchase_orders', 'purchase_invoices', 'fiscal_documents', 'fiscal_files', 'audit_logs'];

function findBin(exe) {
  const name = process.platform === 'win32' ? `${exe}.exe` : exe;
  const candidates = [env.PG_BIN];
  for (const v of [18, 17, 16]) {
    if (process.platform === 'win32') for (const d of ['C', 'D']) candidates.push(`${d}:\\Program Files\\PostgreSQL\\${v}\\bin`);
    else candidates.push(`/usr/lib/postgresql/${v}/bin`);
  }
  const dir = candidates.find((d) => d && existsSync(path.join(d, name)));
  return dir ? path.join(dir, name) : name; // sem pasta conhecida: usa o PATH
}

function run(exe, args, password) {
  const res = spawnSync(findBin(exe), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, PGPASSWORD: password ?? '' } });
  if (res.status !== 0) throw new Error(`${exe} falhou (${res.status}): ${res.stderr || res.stdout || res.error?.message}`);
  return res.stdout;
}

const conn = (user, db) => ['-h', DB.host, '-p', String(DB.port), '-U', user, '-d', db];
const sql = (user, password, db, query) => run('psql', [...conn(user, db), '-X', '-qtA', '-v', 'ON_ERROR_STOP=1', '-c', query], password).trim();

const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const full = path.join(dir, n);
    return statSync(full).isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

async function counts(user, password, db) {
  const out = {};
  for (const t of CHECK_TABLES) {
    const exists = sql(user, password, db, `SELECT to_regclass('public.${t}') IS NOT NULL`);
    if (exists === 't') out[t] = Number(sql(user, password, db, `SELECT count(*) FROM ${t}`));
  }
  return out;
}

async function backup(outArg) {
  if (!DB.password) throw new Error('DB_OWNER_PASSWORD ausente no .env');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dir = path.resolve(outArg ?? path.join(root, 'backups'), stamp);
  if (existsSync(dir)) throw new Error(`Pasta ja existe: ${dir}`);
  mkdirSync(dir, { recursive: true });
  // Formato custom (-Fc): comprimido e restauravel com pg_restore. Sem senhas de papeis (roles nao entram no dump).
  run('pg_dump', [...conn(DB.user, DB.name), '-Fc', '-f', path.join(dir, 'db.dump')], DB.password);
  if (existsSync(storageDir)) cpSync(storageDir, path.join(dir, 'storage'), { recursive: true, errorOnExist: true });
  const files = Object.fromEntries(['db.dump', ...walk(path.join(dir, 'storage')).map((f) => `storage/${f}`)].map((f) => [f, sha256File(path.join(dir, f))]));
  const manifest = {
    createdAt: new Date().toISOString(),
    database: DB.name,
    migrations: sql(DB.user, DB.password, DB.name, 'SELECT coalesce(string_agg(name, \',\' ORDER BY name), \'\') FROM schema_migrations').split(',').filter(Boolean),
    counts: await counts(DB.user, DB.password, DB.name),
    files,
  };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Backup criado: ${dir}`);
  console.log(`  ${Object.keys(files).length} arquivo(s), banco ${DB.name}, ${manifest.migrations.length} migration(s)`);
  return dir;
}

function verify(dir) {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const bad = Object.entries(manifest.files).filter(([f, h]) => !existsSync(path.join(dir, f)) || sha256File(path.join(dir, f)) !== h);
  const extra = walk(path.join(dir, 'storage')).filter((f) => !(`storage/${f}` in manifest.files));
  if (bad.length || extra.length) {
    for (const [f] of bad) console.error(`  alterado ou ausente: ${f}`);
    for (const f of extra) console.error(`  arquivo fora do manifesto: storage/${f}`);
    throw new Error('Backup NAO confere com o manifesto.');
  }
  console.log(`Backup confere: ${Object.keys(manifest.files).length} arquivo(s) com sha256 correto.`);
  return manifest;
}

function admin() {
  const creds = path.join(root, '.local', 'credentials.json');
  if (env.RESTORE_ADMIN_USER && env.RESTORE_ADMIN_PASSWORD) return { user: env.RESTORE_ADMIN_USER, password: env.RESTORE_ADMIN_PASSWORD };
  if (existsSync(creds)) return { user: 'postgres', password: JSON.parse(readFileSync(creds, 'utf8')).superuser };
  throw new Error('Defina RESTORE_ADMIN_USER e RESTORE_ADMIN_PASSWORD (papel que pode criar banco) para o teste de restauracao.');
}

async function restoreTest(dir) {
  const manifest = verify(dir);
  const a = admin();
  const temp = `loja_restore_${randomBytes(4).toString('hex')}`;
  console.log(`Restaurando em banco temporario ${temp}...`);
  sql(a.user, a.password, 'postgres', `CREATE DATABASE ${temp} OWNER ${DB.user} ENCODING 'UTF8' TEMPLATE template0`);
  const problems = [];
  try {
    run('pg_restore', [...conn(a.user, temp), '--exit-on-error', '--no-owner', '--role', DB.user, path.join(dir, 'db.dump')], a.password);
    const got = await counts(a.user, a.password, temp);
    for (const [t, n] of Object.entries(manifest.counts)) if (got[t] !== n) problems.push(`contagem de ${t}: backup ${n}, restaurado ${got[t]}`);
    const migrations = sql(a.user, a.password, temp, 'SELECT coalesce(string_agg(name, \',\' ORDER BY name), \'\') FROM schema_migrations').split(',').filter(Boolean);
    if (migrations.join(',') !== manifest.migrations.join(',')) problems.push('lista de migrations diferente');
    // Todo arquivo fiscal e XML de compra registrado no banco precisa estar na copia, com o mesmo hash.
    const rows = sql(a.user, a.password, temp, `SELECT storage_key || ' ' || sha256 FROM fiscal_files UNION ALL SELECT storage_key || ' ' || sha256 FROM purchase_invoices`)
      .split('\n')
      .filter(Boolean);
    for (const r of rows) {
      const [key, sha] = r.split(' ');
      const file = path.join(dir, 'storage', 'fiscal', key); // a API grava em STORAGE_DIR/fiscal/<chave>
      if (!existsSync(file)) problems.push(`arquivo ausente na copia: ${key}`);
      else if (sha256File(file) !== sha) problems.push(`hash diferente: ${key}`);
    }
    console.log(`  ${Object.keys(got).length} tabela(s) conferidas, ${rows.length} arquivo(s) fiscais conferidos`);
  } finally {
    sql(a.user, a.password, 'postgres', `DROP DATABASE IF EXISTS ${temp} WITH (FORCE)`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`  ${p}`);
    throw new Error('Teste de restauracao FALHOU.');
  }
  console.log('Teste de restauracao OK (banco temporario apagado).');
}

// ---------------------------------------------------------------------------------------------
// Ensaio de migration (docs/15-sglog-fase1.md). Restaura a copia num banco temporario, aplica as migrations pendentes
// NELE (nunca no banco em uso), mede o tempo, roda a conferencia do estoque (stock_reconcile, se existir), mostra a
// diferenca herdada da abertura e confere que nenhuma tabela antiga perdeu ou ganhou linhas. Apaga o temporario no fim.

const REHEARSAL_DB = 'loja_ensaio';
const REHEARSAL_TABLES = [...CHECK_TABLES, 'stock_balances', 'stock_reservations', 'product_variants', 'shipments'];

async function migrateRehearsal(dir) {
  if (DB.name === REHEARSAL_DB) throw new Error(`DB_NAME e ${REHEARSAL_DB}: o ensaio usa esse nome para o banco temporario.`);
  verify(dir);
  const a = admin();
  const q = (query) => sql(a.user, a.password, REHEARSAL_DB, query);
  const exists = (rel) => q(`SELECT to_regclass('public.${rel}') IS NOT NULL`) === 't';
  const countAll = () => Object.fromEntries(REHEARSAL_TABLES.filter((t) => exists(t)).map((t) => [t, Number(q(`SELECT count(*) FROM ${t}`))]));

  // Sobra de um ensaio interrompido: o nome e reservado ao ensaio, entao pode ser apagado.
  sql(a.user, a.password, 'postgres', `DROP DATABASE IF EXISTS ${REHEARSAL_DB} WITH (FORCE)`);
  console.log(`Restaurando em banco temporario ${REHEARSAL_DB}...`);
  sql(a.user, a.password, 'postgres', `CREATE DATABASE ${REHEARSAL_DB} OWNER ${DB.user} ENCODING 'UTF8' TEMPLATE template0`);
  const problems = [];
  try {
    run('pg_restore', [...conn(a.user, REHEARSAL_DB), '--exit-on-error', '--no-owner', '--role', DB.user, path.join(dir, 'db.dump')], a.password);
    const before = countAll();
    const kindQuery = `SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'shipments' AND column_name = 'kind'`;
    const hadKind = q(kindQuery) === '1';
    const pending = q(`SELECT coalesce(string_agg(name, ',' ORDER BY name), '') FROM schema_migrations`).split(',').filter(Boolean);
    console.log(`  migrations na copia: ${pending.length} (ultima: ${pending.at(-1) ?? 'nenhuma'})`);

    const t0 = process.hrtime.bigint();
    const mig = spawnSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'src/db/migrate.ts', 'up'], {
      cwd: path.join(root, 'apps/api'),
      encoding: 'utf8',
      env: { ...env, DB_NAME: REHEARSAL_DB },
    });
    const ms = Number((process.hrtime.bigint() - t0) / 1_000_000n);
    for (const line of `${mig.stdout}${mig.stderr}`.split('\n').filter(Boolean)) console.log(`  | ${line}`);
    if (mig.status !== 0) throw new Error('As migrations falharam na copia. Nada foi aplicado no banco em uso.');
    console.log(`  migrations aplicadas na copia em ${ms} ms (processo inteiro; o tempo de bloqueio aparece nos avisos acima)`);

    const after = countAll();
    // A 0024 (Fase 5) cria remessas pendentes para pedidos ja alocados: em shipments, o que precisa bater sao as
    // remessas que ja existiam (agora 'legacy'); as novas sao mostradas a parte. So vale quando a 0024 roda neste
    // ensaio: com ela ja aplicada antes (copia com a coluna kind), as remessas nao-legacy ja estavam na contagem de
    // antes e o total precisa bater como nas outras tabelas.
    if (!hadKind && q(kindQuery) === '1' && 'shipments' in before) {
      const legacy = Number(q(`SELECT count(*) FROM shipments WHERE kind = 'legacy'`));
      const created = Number(q(`SELECT count(*) FROM shipments WHERE kind <> 'legacy'`));
      console.log(`  remessas: ${legacy} antiga(s) preservada(s), ${created} pendente(s) nova(s) para pedido(s) ja alocado(s)`);
      after.shipments = legacy;
    } else if ('shipments' in before) {
      console.log(`  remessas: ${after.shipments} (antes ${before.shipments})`);
    }
    for (const [t, n] of Object.entries(before)) if (after[t] !== n) problems.push(`contagem de ${t} mudou: antes ${n}, depois ${after[t]}`);

    if (exists('stock_opening_balances')) {
      const [variants, withDiff, qtyDiff, costDiff] = q(
        `SELECT count(*), count(*) FILTER (WHERE o.ledger_on_hand <> o.on_hand OR o.ledger_reserved <> o.reserved OR o.reservations_active <> o.reserved),
                coalesce(sum(abs(o.ledger_on_hand - o.on_hand)), 0), coalesce(round(sum(abs(o.ledger_on_hand - o.on_hand) * b.avg_cost_cents) / 100, 2), 0)
         FROM stock_opening_balances o JOIN stock_balances b ON b.variant_id = o.variant_id`,
      ).split('|');
      console.log(`  abertura do estoque: ${variants} variante(s); ${withDiff} com diferenca herdada`);
      if (Number(withDiff)) {
        console.log(`  diferenca herdada no fisico: ${qtyDiff} (unidades base, somadas em modulo), cerca de R$ ${costDiff} a custo medio`);
        const sample = q(
          `SELECT v.sku || ' saldo=' || o.on_hand || ' livro=' || o.ledger_on_hand || ' reservado=' || o.reserved || ' livro_res=' || o.ledger_reserved || ' reservas=' || o.reservations_active
           FROM stock_opening_balances o JOIN product_variants v ON v.id = o.variant_id
           WHERE o.ledger_on_hand <> o.on_hand OR o.ledger_reserved <> o.reserved OR o.reservations_active <> o.reserved ORDER BY v.sku LIMIT 20`,
        );
        for (const line of sample.split('\n').filter(Boolean)) console.log(`    ${line}`);
      }
    }
    if (q(`SELECT to_regprocedure('stock_reconcile()') IS NOT NULL`) === 't') {
      const rows = q(`SELECT check_code || '|' || coalesce(field, '') || '|' || expected || '|' || found FROM stock_reconcile()`).split('\n').filter(Boolean);
      const run = rows.find((r) => r.startsWith('run|'));
      const divs = rows.filter((r) => !r.startsWith('run|'));
      console.log(`  conferencia do estoque (stock_reconcile): ${run ? Number(run.split('|')[2]) : '?'} variante(s) conferidas, ${divs.length} divergencia(s)`);
      for (const d of divs.slice(0, 20)) console.log(`    ${d}`);
      if (divs.length) problems.push(`${divs.length} divergencia(s) na conferencia do estoque depois da migration`);
    }
  } finally {
    sql(a.user, a.password, 'postgres', `DROP DATABASE IF EXISTS ${REHEARSAL_DB} WITH (FORCE)`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`  ${p}`);
    throw new Error('Ensaio de migration FALHOU (banco temporario apagado; o banco em uso nao foi tocado).');
  }
  console.log('Ensaio de migration OK (banco temporario apagado; o banco em uso nao foi tocado).');
}

// ---------------------------------------------------------------------------------------------
// Retencao e copia fora do servidor (docs/BACKUP.md). As pastas tem nome AAAAMMDD-HHMMSS (UTC).

const STAMP = /^\d{8}-\d{6}$/;
const keepN = (name, fallback) => {
  const n = Number(env[name]);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
};
const RETENTION = { daily: keepN('BACKUP_KEEP_DAILY', 7), weekly: keepN('BACKUP_KEEP_WEEKLY', 4), monthly: keepN('BACKUP_KEEP_MONTHLY', 12) };

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${Math.ceil(((t - start) / 86400000 + 1) / 7)}`;
}

/**
 * Quais copias ficam: a mais nova de cada um dos ultimos N dias, semanas e meses que TEM copia. Conta pelas copias
 * existentes, nao pelo relogio: se o backup parar, nada mais e apagado. A mais nova sempre fica.
 */
export function keepSet(names, r = RETENTION) {
  const sorted = names.filter((n) => STAMP.test(n)).sort().reverse();
  const keep = new Set(sorted.slice(0, 1));
  const pick = (keyOf, limit) => {
    const seen = new Set();
    for (const n of sorted) {
      const k = keyOf(n);
      if (seen.has(k)) continue;
      if (seen.size >= limit) break;
      seen.add(k);
      keep.add(n);
    }
  };
  const date = (n) => new Date(Date.UTC(+n.slice(0, 4), +n.slice(4, 6) - 1, +n.slice(6, 8)));
  pick((n) => n.slice(0, 8), r.daily);
  pick((n) => isoWeek(date(n)), r.weekly);
  pick((n) => n.slice(0, 6), r.monthly);
  return keep;
}

const backupsDir = path.join(root, 'backups');
const localBackups = () => (existsSync(backupsDir) ? readdirSync(backupsDir).filter((n) => STAMP.test(n) && existsSync(path.join(backupsDir, n, 'manifest.json'))) : []);

function prune(dry) {
  const names = localBackups();
  const keep = keepSet(names);
  const drop = names.filter((n) => !keep.has(n)).sort();
  for (const n of drop) {
    if (!dry) rmSync(path.join(backupsDir, n), { recursive: true, force: true });
    console.log(`${dry ? '(simulacao) apagaria' : 'apagada'}: backups/${n}`);
  }
  console.log(`Retencao local: ${keep.size} copia(s) mantida(s), ${drop.length} ${dry ? 'a apagar' : 'apagada(s)'} (${RETENTION.daily} diarias, ${RETENTION.weekly} semanais, ${RETENTION.monthly} mensais).`);
}

function rclone(args) {
  const res = spawnSync(env.RCLONE_BIN || 'rclone', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.status !== 0) throw new Error(`rclone ${args[0]} falhou (${res.status ?? res.error?.message}): ${(res.stderr || res.stdout || '').trim().slice(-800)}`);
  return res.stdout;
}

function offsite(dry) {
  const remote = (env.BACKUP_REMOTE ?? '').trim();
  if (!remote) {
    console.log('Copia fora do servidor desligada: BACKUP_REMOTE vazio no .env (docs/BACKUP.md).');
    return;
  }
  const at = (n) => (remote.endsWith(':') || remote.endsWith('/') ? `${remote}${n}` : `${remote}/${n}`);
  const names = localBackups().sort();
  if (!names.length) throw new Error('Nenhuma copia local para enviar.');
  const newest = names.at(-1);
  const remoteDirs = () => {
    try {
      return new Set(rclone(['lsf', '--dirs-only', remote]).split(/\r?\n/).map((l) => l.replace(/\/$/, '').trim()).filter((n) => STAMP.test(n)));
    } catch (err) {
      // Primeiro envio: a pasta ainda nao existe no remoto.
      if (/directory not found/i.test(err.message)) return new Set();
      throw err;
    }
  };
  const before = remoteDirs();
  if (!before.size && !dry) rclone(['mkdir', remote]);
  // So envia o que esta dentro da retencao: uma copia velha recem-apagada aqui nao volta a subir.
  const send = [...keepSet(names)].filter((n) => !before.has(n) || n === newest).sort();
  for (const n of send) {
    if (dry) console.log(`(simulacao) enviaria backups/${n}`);
    else {
      rclone(['copy', path.join(backupsDir, n), at(n)]);
      console.log(`enviada: backups/${n}`);
    }
  }
  if (dry) return;
  // Confere a mais nova pelo conteudo: o remoto cifrado e decifrado e comparado arquivo a arquivo.
  rclone(['cryptcheck', '--one-way', path.join(backupsDir, newest), at(newest)]);
  console.log(`conferida no remoto: ${newest}`);
  const now = remoteDirs();
  if (!now.has(newest)) throw new Error('A copia mais nova nao aparece no remoto; nada foi apagado la.');
  const keep = keepSet([...now]);
  const drop = [...now].filter((n) => !keep.has(n)).sort();
  for (const n of drop) {
    rclone(['purge', at(n)]);
    console.log(`apagada no remoto: ${n}`);
  }
  console.log(`Remoto: ${keep.size} copia(s) mantida(s), ${drop.length} apagada(s).`);
}

const [cmd, arg, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'backup') await backup(arg === '--out' ? rest[0] : undefined);
  else if (cmd === 'verify' && arg) verify(path.resolve(arg));
  else if (cmd === 'restore-test' && arg) await restoreTest(path.resolve(arg));
  else if (cmd === 'migrate-rehearsal' && arg) await migrateRehearsal(path.resolve(arg));
  else if (cmd === 'prune') prune(arg === '--dry-run');
  else if (cmd === 'offsite') offsite(arg === '--dry-run');
  else if (cmd === 'keep-test') console.log([...keepSet(readFileSync(0, 'utf8').split(/\s+/))].sort().join(' '));
  else {
    console.error('Uso: node scripts/backup.mjs backup [--out pasta] | verify <pasta> | restore-test <pasta> | migrate-rehearsal <pasta> | prune [--dry-run] | offsite [--dry-run]');
    process.exit(1);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
