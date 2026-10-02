import pg from "pg";

/**
 * The one step this seed script does with direct SQL, deliberately isolated here: creating (and,
 * on `--reset`, deleting) a workspace and its first membership. `apps/api` has no HTTP endpoint
 * for either yet — only direct SQL does this today, the same way `apps/web/e2e/db.ts`'s own
 * `createWorkspaceWithMembership` does it for the end-to-end tests. Everything else this seed
 * produces (accounts, categories, transactions, assignments, scheduled transactions, goals) goes
 * through the real API instead (`lib/api.ts`), so RLS and the assignment ledger actually get
 * exercised.
 */

function pool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}

export async function deleteWorkspace(databaseUrl: string, workspaceId: string): Promise<void> {
  const db = pool(databaseUrl);
  try {
    await db.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
  } finally {
    await db.end();
  }
}

export async function findUserIdBySubject(databaseUrl: string, keycloakSubject: string): Promise<string | undefined> {
  const db = pool(databaseUrl);
  try {
    const { rows } = await db.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [keycloakSubject]);
    return rows[0]?.id;
  } finally {
    await db.end();
  }
}

export async function createWorkspaceWithOwner(
  databaseUrl: string,
  name: string,
  timeZone: string,
  baseCurrency: string,
  ownerUserId: string,
): Promise<string> {
  const db = pool(databaseUrl);
  try {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO workspaces (name, base_currency, time_zone) VALUES ($1, $2, $3) RETURNING id",
      [name, baseCurrency, timeZone],
    );
    const id = rows[0]?.id;
    if (!id) {
      throw new Error("createWorkspaceWithOwner: INSERT ... RETURNING produced no row");
    }
    await db.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [ownerUserId, id]);
    return id;
  } finally {
    await db.end();
  }
}
