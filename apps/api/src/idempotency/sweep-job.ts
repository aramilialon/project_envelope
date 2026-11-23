/**
 * The `idempotency-keys-sweep` job (#559, ADR 0020): an hourly system job that deletes the
 * `Idempotency-Key`s older than their lifetime (24 hours), so a stored reply, a copy of workspace
 * data such as a payee or a memo, is kept about 25 hours at most (design.md, "Security, privacy and
 * GDPR"). A key claimed again after its lifetime is deleted by the claim itself.
 *
 * As ADR 0010 requires of a job that enumerates every workspace: the system-job flag
 * (`app.is_system_job`) is set only for listing the workspaces, in the job delivery's own
 * transaction, and cleared right after; each workspace's keys are then deleted in a transaction of
 * their own on `pool` with only `app.workspace_id` set, under the table's ordinary policy, which
 * has no system-job allowance. A workspace that fails does not stop the others; the job then fails
 * and the queue retries it. A repeat delivery of the same job id is discarded by the queue module
 * (`processed_jobs`), and a second run deletes nothing more.
 */
import type { DbClient, DbPool } from "../db/pool.ts";
import type { JobHandler } from "../queue/driver.ts";
import type { IdempotencyKeysSweepJobData } from "../queue/job-types.ts";
import { deleteExpiredIdempotencyKeys } from "./repository.ts";

/** Minute 20 of every hour (the queue's cron runs in UTC). */
export const IDEMPOTENCY_KEYS_SWEEP_CRON = "20 * * * *";

/** The part of a pino logger the job uses. */
export interface SweepLogger {
  info(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
}

/** Deletes one workspace's expired keys in a transaction of its own, under that workspace's policy. */
export async function sweepWorkspaceIdempotencyKeys(pool: DbPool, workspaceId: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const deleted = await deleteExpiredIdempotencyKeys(client, workspaceId);
    await client.query("COMMIT");
    return deleted;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function createIdempotencyKeysSweepHandler(pool: DbPool, log: SweepLogger): JobHandler<IdempotencyKeysSweepJobData> {
  return async (_data: IdempotencyKeysSweepJobData, db: DbClient) => {
    await db.query("SELECT set_config('app.is_system_job', 'true', true)");
    const { rows: workspaces } = await db.query<{ id: string }>("SELECT id FROM workspaces ORDER BY id");
    await db.query("SELECT set_config('app.is_system_job', '', true)");

    let deleted = 0;
    let failed = 0;
    for (const workspace of workspaces) {
      try {
        deleted += await sweepWorkspaceIdempotencyKeys(pool, workspace.id);
      } catch (error) {
        failed++;
        log.error({ workspaceId: workspace.id, err: error }, "expired idempotency keys not removed for a workspace");
      }
    }
    log.info({ workspaces: workspaces.length, deleted }, "expired idempotency keys removed");
    if (failed > 0) {
      throw new Error(`expired idempotency keys not removed in ${failed} workspaces`);
    }
  };
}
