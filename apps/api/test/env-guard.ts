import pg from 'pg';

// Trava contra rodar a suite fora do banco de testes (docs/15-sglog-fase1.md §Travas).
// Os testes apagam tabelas (TRUNCATE): qualquer duvida sobre o banco aborta antes de conectar ou de limpar.
// O nome do banco nao basta (um banco de producao pode ter outro nome): o banco precisa ter a marca que
// so `npm run migrate:test` grava, e esse comando recusa banco que nao termina em _test.

/** Mesmo texto gravado por src/db/migrate.ts --test (COMMENT ON DATABASE). */
export const TEST_DB_MARK = 'loja-embalagens: banco de TESTES (os testes apagam dados)';

type Env = Record<string, string | undefined>;

/** Confere o .env sem conectar. Devolve o motivo da recusa, ou null se pode seguir. */
export function testEnvProblem(env: Env, fileEnv: Env = env): string | null {
  const name = env.DB_NAME_TEST ?? '';
  if (fileEnv.NODE_ENV === 'production') return 'o .env e de producao (NODE_ENV=production)';
  if (!name) return 'DB_NAME_TEST vazio';
  if (!/^loja_[a-z]*_?test$/.test(name) || !name.endsWith('_test')) return `DB_NAME_TEST (${name}) precisa terminar em _test`;
  if (name === 'loja_prod') return 'DB_NAME_TEST aponta para loja_prod';
  if (fileEnv.DB_NAME && name === fileEnv.DB_NAME) return 'DB_NAME_TEST igual a DB_NAME (banco da aplicacao)';
  return null;
}

/** Confere o banco conectado: nome e marca de banco de testes. */
export async function testDatabaseProblem(client: { query: pg.Pool['query'] }, expected: string): Promise<string | null> {
  const { rows } = await client.query<{ db: string; mark: string | null }>(
    `SELECT current_database() AS db, shobj_description(d.oid, 'pg_database') AS mark FROM pg_database d WHERE d.datname = current_database()`,
  );
  const r = rows[0];
  if (!r || r.db !== expected) return `conectado em ${r?.db ?? '?'}, esperado ${expected}`;
  if (r.mark !== TEST_DB_MARK) return `o banco ${r.db} nao tem a marca de banco de testes (rode npm run migrate:test)`;
  return null;
}

let checked: Promise<void> | null = null;

/** Aborta a suite se o ambiente ou o banco nao forem de teste. Resultado guardado: confere uma vez por processo. */
export function ensureTestDatabase(env: Env = process.env, fileEnv: Env = env): Promise<void> {
  checked ??= (async () => {
    const envProblem = testEnvProblem(env, fileEnv);
    if (envProblem) throw new Error(`Testes recusados: ${envProblem}.`);
    const client = new pg.Client({
      host: env.DB_HOST,
      port: Number(env.DB_PORT),
      user: env.DB_OWNER_USER,
      password: env.DB_OWNER_PASSWORD,
      database: env.DB_NAME_TEST,
    });
    await client.connect();
    try {
      const dbProblem = await testDatabaseProblem(client, env.DB_NAME_TEST!);
      if (dbProblem) throw new Error(`Testes recusados: ${dbProblem}.`);
    } finally {
      await client.end();
    }
  })();
  return checked;
}
