import { createHash } from 'node:crypto';
import { pool } from '../db/pool.js';

type Result = { current: number; ttl: number };
type Done = (err: Error | null, result?: Result) => void;

const SQL = `INSERT INTO rate_limits AS r (key, hits, reset_at)
  VALUES ($1, 1, now() + make_interval(secs => $2::float8 / 1000))
  ON CONFLICT (key) DO UPDATE SET
    hits = CASE WHEN r.reset_at <= now() THEN 1 ELSE r.hits + 1 END,
    reset_at = CASE WHEN r.reset_at <= now() THEN EXCLUDED.reset_at ELSE r.reset_at END
  RETURNING hits, greatest(0, extract(epoch FROM r.reset_at - now()) * 1000)::int AS ttl`;

/**
 * Contador do limite de requisicoes no banco: vale para todas as instancias e sobrevive a
 * reinicio. Uma so instrucao atomica, entao duas requisicoes juntas nunca contam como uma.
 */
export class PostgresRateLimitStore {
  private readonly route: string;

  constructor(options: { routeInfo?: { method?: string; url?: string } } = {}) {
    const info = options.routeInfo;
    this.route = info ? `${info.method}:${info.url}` : '';
  }

  incr(key: string, done: Done, timeWindow: number) {
    const hashed = createHash('sha256').update(`${this.route}|${key}`).digest('hex');
    pool.query<{ hits: number; ttl: number }>(SQL, [hashed, timeWindow]).then(
      ({ rows }) => done(null, { current: rows[0]!.hits, ttl: rows[0]!.ttl }),
      (err: Error) => done(err),
    );
  }

  child(options: { routeInfo?: { method?: string; url?: string } }) {
    return new PostgresRateLimitStore(options);
  }
}
