/**
 * Whether an id from a request names a row of the selected workspace (#513). The table comes from
 * a fixed allowlist, never from the request: a caller names it in code, and each one maps to its
 * own literal query, so no string a client sent is ever spliced into SQL.
 */
import { isUuid } from "../ids.ts";
import type { DbClient, DbPool } from "./pool.ts";

const EXISTS_QUERIES = {
  accounts: "SELECT 1 FROM accounts WHERE id = $1 AND workspace_id = $2",
  splits: "SELECT 1 FROM splits WHERE id = $1 AND workspace_id = $2",
  transactions: "SELECT 1 FROM transactions WHERE id = $1 AND workspace_id = $2",
} as const;

/** A workspace-scoped table `workspaceRowExists` can look a row up in. */
export type WorkspaceTable = keyof typeof EXISTS_QUERIES;

/**
 * True only when `id` is a well-formed uuid naming a row of `table` in `workspaceId`. A row of
 * another workspace is answered exactly like an id that names nothing, so the answer never says
 * whether a foreign id exists.
 */
export async function workspaceRowExists(
  db: DbPool | DbClient,
  table: WorkspaceTable,
  workspaceId: string,
  id: string,
): Promise<boolean> {
  if (!Object.hasOwn(EXISTS_QUERIES, table)) {
    throw new Error("workspaceRowExists: table is not in the allowlist");
  }
  if (!isUuid(id)) {
    return false;
  }
  const { rows } = await db.query(EXISTS_QUERIES[table], [id, workspaceId]);
  return rows.length > 0;
}
