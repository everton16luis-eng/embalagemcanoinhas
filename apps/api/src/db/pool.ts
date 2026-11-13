import pg from 'pg';
import { config } from '../config.js';

// numeric volta como texto: quantidades fracionadas nunca passam por float.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);

export const pool = new pg.Pool({
  host: config.DB_HOST,
  port: config.DB_PORT,
  database: config.DB_NAME,
  user: config.APP_DB_USER,
  password: config.APP_DB_PASSWORD,
  max: config.DB_POOL_MAX,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 30_000,
  idle_in_transaction_session_timeout: 60_000,
});

const lost = (err: Error) => console.error('conexao com o banco perdida', err.message);
pool.on('error', lost);
pool.on('connect', (client) => client.on('error', lost));

export type Db = pg.PoolClient;

/**
 * Executa fn numa transacao. O usuario fica em app.user_id, lido pelos gatilhos de historico
 * (precos, classificacao fiscal), para que nenhuma alteracao fique sem autor.
 */
export async function tx<T>(actorId: string | null, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [actorId ?? '']);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    client.release(broken);
  }
}
