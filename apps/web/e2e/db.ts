/**
 * Direct database fixtures for the e2e tests (#50): the superuser connection (`DATABASE_URL`,
 * the same convention `apps/api`'s own tests use for setup), never the restricted `envelope_app`
 * role — this is test setup, not something exercising Row-Level Security.
 */
import pg from "pg";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Set DATABASE_URL to run the e2e tests, e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope",
    );
  }
  return url;
}

/** The local `users.id` for a Keycloak subject (`sub` claim), once the user-mapper preHandler has created it (i.e. after at least one authenticated request). */
export async function findUserIdBySubject(keycloakSubject: string): Promise<string | undefined> {
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [
      keycloakSubject,
    ]);
    return rows[0]?.id;
  } finally {
    await pool.end();
  }
}

export interface TestWorkspace {
  readonly id: string;
  teardown(): Promise<void>;
}

/** Creates a workspace and a membership for it, for the e2e test user to see (#50). */
export async function createWorkspaceWithMembership(
  userId: string,
  name: string,
  role: "owner" | "editor" | "read_only" = "owner",
): Promise<TestWorkspace> {
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO workspaces (name, base_currency, time_zone) VALUES ($1, 'EUR', 'Europe/Rome') RETURNING id",
    [name],
  );
  const id = rows[0]!.id;
  await pool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, $3)", [userId, id, role]);
  return {
    id,
    async teardown() {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [id]);
      await pool.end();
    },
  };
}
