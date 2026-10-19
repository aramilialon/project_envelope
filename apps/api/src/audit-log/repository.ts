import type { DbClient, DbPool } from "../db/pool.ts";

export interface AuditLogEntry {
  readonly workspaceId: string;
  readonly userId: string | null;
  readonly action: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

/**
 * The one place that writes to audit_log, so every caller gets the same
 * columns instead of each repository writing its own INSERT (#216). Accepts
 * a pool or a request's own client so a caller already inside a transaction
 * (for example the RLS-scoped client set up by workspace-membership.ts) can
 * record the entry atomically with the change it describes.
 */
export async function recordAuditLog(db: DbPool | DbClient, entry: AuditLogEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (workspace_id, user_id, action, before, after)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      entry.workspaceId,
      entry.userId,
      entry.action,
      // `JSON.stringify` explicitly, never the bare value: `pg` serializes a top-level JS array
      // parameter as a Postgres ARRAY literal, not JSON, which the `jsonb` columns below reject —
      // a caller's `before`/`after` happening to be an array (not just a plain object) would
      // otherwise fail at the SQL layer, not at the type system (`#403`). `null`/`undefined`
      // bypass this entirely, a plain SQL `NULL`, same as before.
      entry.before === null || entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === null || entry.after === undefined ? null : JSON.stringify(entry.after),
    ],
  );
}
