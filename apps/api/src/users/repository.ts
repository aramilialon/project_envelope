import type { DbPool } from "../db/pool.ts";

export interface UserRecord {
  readonly id: string;
  readonly email: string;
}

export async function upsertUserFromClaims(
  pool: DbPool,
  claims: { keycloakSubject: string; email: string },
): Promise<UserRecord> {
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
