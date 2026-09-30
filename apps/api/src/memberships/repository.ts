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
