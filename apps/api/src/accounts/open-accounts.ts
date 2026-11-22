import type { DbClient, DbPool } from "../db/pool.ts";
import { AccountClosedError } from "../errors.ts";

/**
 * Refuses the write when any of `accountIds` is a closed account of the workspace (#741), before
 * anything else is checked: a write to a closed account answers `account_closed`, never another
 * code of a check or replay that would also have failed. The accounts are read `FOR KEY SHARE`,
 * the lock migration 0033's trigger takes, which conflicts with the `FOR UPDATE` of `closeAccount`:
 * an account found open here stays open until the transaction ends. An id that names no account
 * of the workspace is left to the caller's own checks (`unknown_account`, the foreign key).
 * Shared by the trades (#741) and transactions (#655) repositories.
 *
 * @throws AccountClosedError naming the first closed account found.
 */
export async function checkAccountsOpen(
  db: DbPool | DbClient,
  workspaceId: string,
  accountIds: Iterable<string | undefined>,
): Promise<void> {
  const ids = [...new Set([...accountIds].filter((id): id is string => id !== undefined))].sort();
  if (ids.length === 0) {
    return;
  }
  const { rows } = await db.query<{ id: string; closed: boolean }>(
    `SELECT id, closed_at IS NOT NULL AS closed FROM accounts
     WHERE workspace_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR KEY SHARE`,
    [workspaceId, ids],
  );
  const closed = rows.find((row) => row.closed);
  if (closed) {
    throw new AccountClosedError(closed.id);
  }
}
