import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { upsertUserFromClaims } from "./repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

describe("upsertUserFromClaims", () => {
  let pool: DbPool;
  let keycloakSubject: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
  });

  after(async () => {
    await pool.query("DELETE FROM users WHERE keycloak_subject = $1", [keycloakSubject]);
    await pool.end();
  });

  it("creates one row on first sign-in and reuses it on a repeat one", async () => {
    keycloakSubject = randomUUID();
    const email = `${randomUUID()}@example.com`;

    const first = await upsertUserFromClaims(pool, { keycloakSubject, email });
    const second = await upsertUserFromClaims(pool, { keycloakSubject, email });

    assert.equal(second.id, first.id);
    const { rows } = await pool.query("SELECT id FROM users WHERE keycloak_subject = $1", [keycloakSubject]);
    assert.equal(rows.length, 1);
  });

  it("updates the stored email when the claim changes, without changing the id", async () => {
    const before_ = await upsertUserFromClaims(pool, { keycloakSubject, email: "old@example.com" });
    const after_ = await upsertUserFromClaims(pool, { keycloakSubject, email: "new@example.com" });

    assert.equal(after_.id, before_.id);
    assert.equal(after_.email, "new@example.com");
    const { rows } = await pool.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [after_.id]);
    assert.equal(rows[0]?.email, "new@example.com");
  });
});
