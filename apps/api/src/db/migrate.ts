// Uso: migrate.ts [up|down] [--test]
// Conecta como dono das tabelas (loja_owner). O banco e os papeis sao criados por scripts/db-local.mjs
// no desenvolvimento e pelo roteiro de instalacao em producao.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
const direction = process.argv.includes('down') ? 'down' : 'up';
const database = process.argv.includes('--test') ? process.env.DB_NAME_TEST : process.env.DB_NAME;

if (!database || !/^loja_[a-z]+$/.test(database)) throw new Error('DB_NAME/DB_NAME_TEST deve seguir o padrao loja_*');

const client = new pg.Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_OWNER_USER,
  password: process.env.DB_OWNER_PASSWORD,
  database,
});

await client.connect();
try {
  const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'loja_app'`);
  if (!role.rowCount) throw new Error('Papel loja_app nao existe. Rode npm run setup.');
  if (role.rows[0]!.rolsuper || role.rows[0]!.rolbypassrls) throw new Error('loja_app tem privilegio a mais. Corrija o papel antes de migrar.');

  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
  const applied = new Set(rows.map((r) => r.name));
  const names = (await readdir(dir))
    .filter((f) => f.endsWith('.up.sql'))
    .map((f) => f.replace('.up.sql', ''))
    .sort();
  const targets = direction === 'up' ? names.filter((n) => !applied.has(n)) : rows.map((r) => r.name).slice(-1);

  for (const name of targets) {
    const sql = await readFile(path.join(dir, `${name}.${direction}.sql`), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      if (direction === 'up') await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      else await client.query('DELETE FROM schema_migrations WHERE name = $1', [name]);
      await client.query('COMMIT');
      console.log(`${database} ${direction}: ${name}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }
  if (!targets.length) console.log(`${database}: nada a aplicar`);
} finally {
  await client.end();
}
