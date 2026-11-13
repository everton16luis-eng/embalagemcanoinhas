#!/usr/bin/env node
// Cluster PostgreSQL proprio do projeto, em .local/pgdata e numa porta separada.
// Usa os binarios ja instalados, mas nunca toca no servico PostgreSQL da maquina
// nem nos bancos de outros sistemas.
// Uso: node scripts/db-local.mjs init|start|stop|status
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localDir = path.join(root, '.local');
const dataDir = path.join(localDir, 'pgdata');
const credsFile = path.join(localDir, 'credentials.json');
const logFile = path.join(localDir, 'postgres.log');
const envFile = path.join(root, '.env');
const PORT = Number(process.env.LOJA_PG_PORT ?? 54330);

function findBin() {
  const exe = process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl';
  const candidates = [process.env.PG_BIN];
  for (const v of [18, 17, 16]) {
    if (process.platform === 'win32') for (const d of ['C', 'D']) candidates.push(`${d}:\\Program Files\\PostgreSQL\\${v}\\bin`);
    else candidates.push(`/usr/lib/postgresql/${v}/bin`);
  }
  const found = candidates.find((dir) => dir && existsSync(path.join(dir, exe)));
  if (!found) throw new Error('Binarios do PostgreSQL nao encontrados. Defina PG_BIN com a pasta bin.');
  return found;
}

function run(bin, args, opts = {}) {
  const res = spawnSync(path.join(findBin(), bin), args, {
    encoding: 'utf8',
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...opts.env },
  });
  if (res.status !== 0 && !opts.allowFail) throw new Error(`${bin} falhou (${res.status}): ${res.stderr ?? ''}${res.stdout ?? ''}`);
  return res;
}

const secret = () => randomBytes(24).toString('base64url');
const isRunning = () => existsSync(dataDir) && run('pg_ctl', ['status', '-D', dataDir], { allowFail: true }).status === 0;

function start() {
  if (!existsSync(dataDir)) throw new Error('Cluster nao criado. Rode: npm run setup');
  if (isRunning()) return console.log(`PostgreSQL do projeto ja esta rodando na porta ${PORT}`);
  // stdio ignorado: no Windows o postgres herda os handles e prenderia o processo pai.
  run('pg_ctl', ['start', '-w', '-D', dataDir, '-l', logFile, '-o', `-p ${PORT} -c listen_addresses=127.0.0.1`], { stdio: 'ignore' });
  console.log(`PostgreSQL do projeto rodando na porta ${PORT}`);
}

function stop() {
  if (isRunning()) run('pg_ctl', ['stop', '-w', '-m', 'fast', '-D', dataDir], { stdio: 'ignore' });
  console.log('PostgreSQL do projeto parado');
}

function psql(sql, password) {
  run('psql', ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    env: { PGPASSWORD: password },
  });
}

function init() {
  mkdirSync(localDir, { recursive: true });
  if (!existsSync(dataDir)) {
    const creds = { superuser: secret(), owner: secret(), app: secret() };
    const pwFile = path.join(localDir, 'pwfile.tmp');
    writeFileSync(pwFile, creds.superuser, { mode: 0o600 });
    try {
      run('initdb', ['-D', dataDir, '-U', 'postgres', '--pwfile', pwFile, '-A', 'scram-sha-256', '-E', 'UTF8', '--locale-provider=icu', '--icu-locale=pt-BR', '--locale=C']);
    } finally {
      rmSync(pwFile, { force: true });
    }
    writeFileSync(credsFile, JSON.stringify(creds, null, 2), { mode: 0o600 });
    console.log('Cluster criado em .local/pgdata');
  }
  start();
  const c = JSON.parse(readFileSync(credsFile, 'utf8'));
  // Dono das tabelas (migrations) e papel da aplicacao, sem privilegios administrativos.
  psql(
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'loja_owner') THEN CREATE ROLE loja_owner LOGIN PASSWORD '${c.owner}'; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'loja_app') THEN CREATE ROLE loja_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${c.app}'; END IF;
    END $$`,
    c.superuser,
  );
  for (const db of ['loja_dev', 'loja_test']) {
    const exists = run('psql', ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'postgres', '-d', 'postgres', '-tAc', `SELECT 1 FROM pg_database WHERE datname = '${db}'`], {
      env: { PGPASSWORD: c.superuser },
    }).stdout.trim();
    if (!exists) psql(`CREATE DATABASE ${db} OWNER loja_owner ENCODING 'UTF8' TEMPLATE template0`, c.superuser);
    psql(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC; GRANT CONNECT ON DATABASE ${db} TO loja_app`, c.superuser);
  }
  if (!existsSync(envFile)) {
    const env = [
      'NODE_ENV=development',
      'DB_HOST=127.0.0.1',
      `DB_PORT=${PORT}`,
      'DB_NAME=loja_dev',
      'DB_NAME_TEST=loja_test',
      'DB_OWNER_USER=loja_owner',
      `DB_OWNER_PASSWORD=${c.owner}`,
      'APP_DB_USER=loja_app',
      `APP_DB_PASSWORD=${c.app}`,
      `ENC_KEY=${randomBytes(32).toString('hex')}`,
      'APP_ORIGIN=http://localhost:3010',
      'PORT=4010',
      'TRUST_PROXY=0',
      'STORAGE_DIR=../../storage',
      '# Pagamento: credenciais de TESTE do Mercado Pago (Suas integracoes > Credenciais de teste).',
      '# Vazio = pagamento online desligado. PAYMENT_FAKE=true simula o provedor (so desenvolvimento).',
      'MP_ACCESS_TOKEN=',
      'MP_PUBLIC_KEY=',
      'MP_WEBHOOK_SECRET=',
      'PUBLIC_API_URL=',
      'PAYMENT_FAKE=true',
      '# NF-e: tokens da Focus NFe por ambiente (painel da Focus). Vazio = emissao desligada naquele ambiente.',
      '# FISCAL_WEBHOOK_SECRET: valor cadastrado no gatilho da Focus (header X-Fiscal-Webhook-Token).',
      '# FISCAL_FAKE=true simula o provedor fiscal (so desenvolvimento).',
      'FOCUS_TOKEN_HOMOLOGACAO=',
      'FOCUS_TOKEN_PRODUCAO=',
      `FISCAL_WEBHOOK_SECRET=${randomBytes(24).toString('hex')}`,
      'FISCAL_FAKE=true',
      '',
    ].join('\n');
    writeFileSync(envFile, env, { mode: 0o600 });
    console.log('.env criado com segredos aleatorios');
  }
}

const cmd = process.argv[2];
if (cmd === 'init') init();
else if (cmd === 'start') start();
else if (cmd === 'stop') stop();
else if (cmd === 'status') console.log(isRunning() ? `rodando na porta ${PORT}` : 'parado');
else {
  console.error('Uso: node scripts/db-local.mjs init|start|stop|status');
  process.exit(1);
}
