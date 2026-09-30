/**
 * The `budget-recompute` job (design.md, "Notifications"; #35/#40): recomputes a workspace's
 * budget problems for one month and notifies every member when one is new or has changed.
 * The job type name and payload shape live in ../queue/job-types.ts, shared with the producer
 * (transactions/repository.ts, enqueued in the same transaction as the write that triggers it);
 * `createBudgetRecomputeHandler` below is the consumer, registered once in main.ts.
 */
import { listBudgetProblems } from "../budget/repository.ts";
import type { DbClient } from "../db/pool.ts";
import { listWorkspaceMembers } from "../memberships/repository.ts";
import type { JobHandler } from "../queue/driver.ts";
import type { BudgetRecomputeJobData } from "../queue/job-types.ts";
import { composeBudgetAlert } from "./budget-alert-text.ts";
import { reconcileNotifiedProblems } from "./notified-problems.ts";
import type { PushDrivers } from "./repository.ts";
import { sendPushToUser } from "./repository.ts";

export function createBudgetRecomputeHandler(drivers: PushDrivers): JobHandler<BudgetRecomputeJobData> {
  return async (data, db: DbClient, jobId: string) => {
    // Row-Level Security (ADR 0006): this handler's transaction starts with no session
    // variables set at all (it never went through a request's own membership check), so every
    // workspace-scoped query below needs this first.
    await db.query("SELECT set_config('app.workspace_id', $1, true)", [data.workspaceId]);

    const problems = await listBudgetProblems(db, data.workspaceId, data.month);
    const changed = await reconcileNotifiedProblems(db, data.workspaceId, data.month, problems);
    if (changed.length === 0) {
      return;
    }

    const { rows } = await db.query<{ base_currency: string }>("SELECT base_currency FROM workspaces WHERE id = $1", [
      data.workspaceId,
    ]);
    const workspace = rows[0];
    if (!workspace) {
      throw new Error(`createBudgetRecomputeHandler: workspace ${data.workspaceId} not found`);
    }

    const members = await listWorkspaceMembers(db, data.workspaceId);
    for (const member of members) {
      const content = composeBudgetAlert(changed, {
        language: member.language,
        locale: member.locale,
        currency: workspace.base_currency,
      });
      // device_tokens/notification_deliveries are scoped by app_user_id() (ADR 0006), a user
      // concept, not a workspace one: set to whichever member this iteration is sending to.
      await db.query("SELECT set_config('app.user_id', $1, true)", [member.userId]);
      await sendPushToUser(db, drivers, jobId, member.userId, content);
    }
  };
}
