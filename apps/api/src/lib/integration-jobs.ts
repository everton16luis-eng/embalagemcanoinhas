// SGLog Fase 8: fila de integracoes no banco (docs/35-sglog-fase8.md §E).
// - Tarefa com chave de idempotencia unica: enfileirar duas vezes a mesma coisa nao cria duas tarefas.
// - A rotina pega as tarefas vencidas com FOR UPDATE SKIP LOCKED (dois processos nunca pegam a mesma).
// - Falha: nova tentativa espacada (1, 5, 15, 60, 180 min); passou do limite, 'dead' e o painel reprocessa.
// - Tarefa 'running' parada ha mais de 10 min (queda do processo) volta para a fila: os tratadores conferem o estado
//   antes de agir (a compra de etiqueta nunca e reenviada as cegas).
// - Log sem corpo, sem token e sem dados pessoais (safeError corta o que parece documento, telefone, CEP ou e-mail).
import { pool, tx, type Db } from '../db/pool.js';

export type JobKind = 'label_purchase' | 'label_reconcile' | 'label_cancel' | 'tracking_poll' | 'webhook_process';
export type Job = { id: string; kind: JobKind; ref_id: string; attempts: number; max_attempts: number; idempotency_key: string };
export type JobOutcome = { done: true; note?: string } | { retry: true; error: string; delayMinutes?: number } | { dead: true; error: string };

const BACKOFF_MIN = [1, 5, 15, 60, 180];
export const STALE_RUNNING_MIN = 10;

/** Erro para guardar ou mostrar: sem e-mail, sem sequencias longas de digitos (CPF, CNPJ, telefone, CEP), ate 500. */
export function safeError(msg: unknown) {
  return String(msg instanceof Error ? msg.message : msg ?? '')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[e-mail]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [oculto]')
    .replace(/\(?\d[\d.\-/ ()]{6,}\d/g, '[numero]')
    .slice(0, 500);
}

export async function enqueueJob(db: Db | typeof pool, j: { kind: JobKind; refId: string; key: string; createdBy?: string | null; maxAttempts?: number; runAt?: Date }) {
  const row = (
    await db.query<{ id: string }>(
      `INSERT INTO integration_jobs (kind, ref_id, idempotency_key, created_by, max_attempts, next_run_at)
       VALUES ($1, $2, $3, $4, $5, coalesce($6, now())) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id::text`,
      [j.kind, j.refId, j.key, j.createdBy ?? null, j.maxAttempts ?? 5, j.runAt ?? null],
    )
  ).rows[0];
  return row?.id ?? null;
}

export async function logCall(
  db: Db | typeof pool,
  l: { jobId?: string | null; provider: string; operation: string; httpStatus?: number | null; durationMs?: number | null; ok: boolean; error?: unknown },
) {
  await db.query(`INSERT INTO integration_logs (job_id, provider, operation, http_status, duration_ms, ok, error) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    l.jobId ?? null,
    l.provider.slice(0, 30),
    l.operation.slice(0, 40),
    l.httpStatus ?? null,
    l.durationMs === undefined || l.durationMs === null ? null : Math.max(0, Math.round(l.durationMs)),
    l.ok,
    l.ok || l.error === undefined ? null : safeError(l.error) || null,
  ]);
}

/** Pega ate `limit` tarefas vencidas e marca como em execucao (tentativa +1). */
export async function claimJobs(limit: number, kinds?: JobKind[]): Promise<Job[]> {
  return tx(null, async (db) => {
    await db.query(
      `UPDATE integration_jobs SET status = 'pending', locked_at = NULL, updated_at = now(),
         last_error = left(coalesce(last_error || ' | ', '') || 'execucao interrompida; tarefa retomada', 500)
       WHERE status = 'running' AND locked_at < now() - make_interval(mins => $1)`,
      [STALE_RUNNING_MIN],
    );
    const rows = (
      await db.query<Job>(
        `SELECT id::text, kind, ref_id, attempts, max_attempts, idempotency_key FROM integration_jobs
         WHERE status = 'pending' AND next_run_at <= now() ${kinds ? 'AND kind = ANY($2::text[])' : ''}
         ORDER BY next_run_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        kinds ? [limit, kinds] : [limit],
      )
    ).rows;
    if (rows.length) {
      await db.query(`UPDATE integration_jobs SET status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now() WHERE id = ANY($1::bigint[])`, [
        rows.map((r) => r.id),
      ]);
    }
    return rows.map((r) => ({ ...r, attempts: r.attempts + 1 }));
  });
}

export async function finishJob(db: Db | typeof pool, job: Job, out: JobOutcome) {
  if ('done' in out) {
    await db.query(
      `UPDATE integration_jobs SET status = 'done', locked_at = NULL, finished_at = now(), updated_at = now(), last_error = coalesce($2, last_error) WHERE id = $1`,
      [job.id, out.note ? safeError(out.note) : null],
    );
    return;
  }
  const error = safeError(out.error) || 'falha sem mensagem';
  if ('dead' in out || job.attempts >= job.max_attempts) {
    await db.query(`UPDATE integration_jobs SET status = 'dead', locked_at = NULL, finished_at = now(), updated_at = now(), last_error = $2 WHERE id = $1`, [job.id, error]);
    return;
  }
  const delay = out.delayMinutes ?? BACKOFF_MIN[Math.min(job.attempts - 1, BACKOFF_MIN.length - 1)]!;
  await db.query(
    `UPDATE integration_jobs SET status = 'pending', locked_at = NULL, updated_at = now(), last_error = $2, next_run_at = now() + make_interval(mins => $3) WHERE id = $1`,
    [job.id, error, delay],
  );
}

/** Reprocessar pelo painel: so tarefa 'dead'; volta para a fila do zero. */
export async function retryJob(db: Db, id: string) {
  return (
    await db.query<{ id: string; kind: JobKind; ref_id: string }>(
      `UPDATE integration_jobs SET status = 'pending', attempts = 0, next_run_at = now(), locked_at = NULL, finished_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'dead' RETURNING id::text, kind, ref_id`,
      [id],
    )
  ).rows[0] ?? null;
}
