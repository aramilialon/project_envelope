import type { DbPool } from "../db/pool.ts";

export interface UserRecord {
  readonly id: string;
  readonly email: string;
}

/**
 * The local user of a token, created on first sign-in, its email kept in sync.
 *
 * Reads first, and writes only when the row is missing or its email changed (#559). The upsert
 * locks the user's row `FOR UPDATE` even when nothing changes (it sets `email`, a unique column),
 * which waits behind every open transaction holding `FOR KEY SHARE` on that row: any write that
 * references the user by foreign key (an idempotency key, an assignment's author, an audit entry, a
 * reconciliation). Upserting on every request made each of the user's requests wait for the
 * previous write in flight to commit.
 */
export async function upsertUserFromClaims(
  pool: DbPool,
  claims: { keycloakSubject: string; email: string },
): Promise<UserRecord> {
  const { rows: existing } = await pool.query<UserRecord>("SELECT id, email FROM users WHERE keycloak_subject = $1", [
    claims.keycloakSubject,
  ]);
  if (existing[0] && existing[0].email === claims.email) {
    return existing[0];
  }
  const { rows } = await pool.query<UserRecord>(
    `INSERT INTO users (keycloak_subject, email)
     VALUES ($1, $2)
     ON CONFLICT (keycloak_subject) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email`,
    [claims.keycloakSubject, claims.email],
  );
  const user = rows[0];
  if (!user) {
    throw new Error("upsertUserFromClaims: INSERT ... RETURNING produced no row");
  }
  return user;
}
