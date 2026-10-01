import type { DbClient, DbPool } from "../db/pool.ts";

export interface WorkspaceMember {
  readonly userId: string;
  /** ADR 0004: which language this member's own text (here, push notification wording) should render in. */
  readonly language: string;
  readonly locale: string;
}

/** Every member of a workspace regardless of role: role-based write restrictions are #24's own concern, not this list's. */
export async function listWorkspaceMembers(db: DbPool | DbClient, workspaceId: string): Promise<WorkspaceMember[]> {
  const { rows } = await db.query<{ user_id: string; language: string; locale: string }>(
    `SELECT u.id AS user_id, u.language, u.locale
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = $1`,
    [workspaceId],
  );
  return rows.map((row) => ({ userId: row.user_id, language: row.language, locale: row.locale }));
}

export type WorkspaceRole = "owner" | "editor" | "read_only";

export interface UserWorkspace {
  readonly id: string;
  readonly name: string;
  readonly role: WorkspaceRole;
  readonly baseCurrency: string;
}

/**
 * The workspaces a user belongs to, with their own role in each (#50, the workspace switcher).
 * Also carries each workspace's `baseCurrency` (#51's account-creation form defaults new
 * accounts to it, since a workspace's currency is fixed at creation — design.md's onboarding —
 * and there is no other endpoint yet that exposes it to the web app).
 * Unlike every other query in this codebase, there is no single workspace to scope this to —
 * that is the whole point, picking one is what this list is for — so this opens its own short
 * transaction with only `app.user_id` set (never `app.workspace_id`), relying on migration
 * 0022's own membership-based RLS allowance on `workspaces` (and 0008's on `memberships`) rather
 * than `workspace-membership.ts`'s usual per-request one.
 */
export async function listWorkspacesForUser(pool: DbPool, userId: string): Promise<UserWorkspace[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const { rows } = await client.query<{ id: string; name: string; role: WorkspaceRole; base_currency: string }>(
      `SELECT w.id, w.name, m.role, w.base_currency
       FROM memberships m
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = $1
       ORDER BY w.name`,
      [userId],
    );
    await client.query("COMMIT");
    return rows.map((row) => ({ id: row.id, name: row.name, role: row.role, baseCurrency: row.base_currency }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
