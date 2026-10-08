/**
 * The `scheduled-transactions-fire` job (design.md: "a scheduled job materializes a real
 * transaction on its due date"; `#38`): a periodic job (`main.ts`'s `queue.schedule`, an hourly
 * cron — frequent enough that every workspace's own local midnight is caught within the hour,
 * whatever its time zone), not triggered by any one request or workspace, so it has neither
 * `app.user_id` nor `app.workspace_id` to start from. Lists every workspace (ADR 0010's own
 * `app_is_system_job()` allowance, the one place this job needs it), then works through them one
 * at a time exactly like `budget-recompute-job.ts` already does for a job with no request
 * context — `set_config('app.workspace_id', ...)` before anything workspace-scoped.
 */
import type { DbClient } from "../db/pool.ts";
import type { JobHandler } from "../queue/driver.ts";
import type { QueueDriver } from "../queue/index.ts";
import type { ScheduledTransactionsFireJobData } from "../queue/job-types.ts";
import { fireDueScheduledTransactions } from "./repository.ts";

export function createScheduledTransactionsFireHandler(queue: QueueDriver): JobHandler<ScheduledTransactionsFireJobData> {
  return async (_data: ScheduledTransactionsFireJobData, db: DbClient) => {
    await db.query("SELECT set_config('app.is_system_job', 'true', true)");
    const { rows: workspaces } = await db.query<{ id: string; today: string }>(
      "SELECT id, to_char(now() AT TIME ZONE time_zone, 'YYYY-MM-DD') AS today FROM workspaces",
    );

    for (const workspace of workspaces) {
      await db.query("SELECT set_config('app.workspace_id', $1, true)", [workspace.id]);
      await fireDueScheduledTransactions(db, workspace.id, workspace.today, queue);
    }
  };
}
