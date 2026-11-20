/**
 * Direct database fixtures for the e2e tests (#50): the superuser connection (`DATABASE_URL`,
 * the same convention `apps/api`'s own tests use for setup), never the restricted `envelope_app`
 * role — this is test setup, not something exercising Row-Level Security. With `E2E_MANIFEST`
 * set, the same superuser connects to the disposable environment's database instead
 * (`environment.ts`, #536).
 */
import pg from "pg";

import { databaseUrl } from "./environment.ts";

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

/** Sets a workspace's tax country (#508), which no screen sets yet. */
export async function setWorkspaceTaxCountry(workspaceId: string, taxCountry: string | null): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    await pool.query("UPDATE workspaces SET tax_country = $2 WHERE id = $1", [workspaceId, taxCountry]);
  } finally {
    await pool.end();
  }
}

/** A brokerage account's tax regime history (#508), oldest first. */
export async function listTaxRegimes(accountName: string, workspaceId: string): Promise<{ regime: string }[]> {
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    const { rows } = await pool.query<{ regime: string }>(
      `SELECT r.regime FROM account_tax_regimes r JOIN accounts a ON a.id = r.account_id
       WHERE a.workspace_id = $1 AND a.name = $2 ORDER BY r.valid_from`,
      [workspaceId, accountName],
    );
    return rows;
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
