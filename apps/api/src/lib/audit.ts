import type { Db } from '../db/pool.js';

type AuditEntry = {
  actorId: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  ip?: string;
};

/** Grava na trilha de auditoria (somente inclusao). Chame dentro da mesma transacao da alteracao. */
export async function audit(db: Db, e: AuditEntry) {
  await db.query(
    `INSERT INTO audit_logs (actor_id, action, entity, entity_id, before, after, metadata, ip) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.actorId, e.action, e.entity ?? null, e.entityId ?? null, e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after), e.metadata ?? {}, e.ip || null],
  );
}
