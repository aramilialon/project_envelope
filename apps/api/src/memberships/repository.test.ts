import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { listWorkspaceMembers } from "./repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

describe("listWorkspaceMembers (#40)", () => {
  let pool: DbPool;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
  });

  after(async () => {
    await pool.end();
  });

  async function createUser(language: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO users (keycloak_subject, email, language) VALUES ($1, $2, $3) RETURNING id",
      [randomUUID(), `${randomUUID()}@example.com`, language],
    );
    return rows[0]!.id;
  }

  it("lists every member regardless of role, with their own language", async () => {
    const workspace = await pool.query<{ id: string }>(
      "INSERT INTO workspaces (name, base_currency, time_zone) VALUES ('Test', 'EUR', 'UTC') RETURNING id",
    );
    const workspaceId = workspace.rows[0]!.id;
    const owner = await createUser("en");
    const readOnly = await createUser("it");
    await pool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [owner, workspaceId]);
    await pool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'read_only')", [readOnly, workspaceId]);

    const members = await listWorkspaceMembers(pool, workspaceId);

    assert.deepEqual(
      members.map((m) => m.userId).sort(),
      [owner, readOnly].sort(),
    );
    assert.equal(members.find((m) => m.userId === readOnly)?.language, "it");
  });

  it("returns no members for a workspace with none", async () => {
    const workspace = await pool.query<{ id: string }>(
      "INSERT INTO workspaces (name, base_currency, time_zone) VALUES ('Empty', 'EUR', 'UTC') RETURNING id",
    );
    const members = await listWorkspaceMembers(pool, workspace.rows[0]!.id);
    assert.deepEqual(members, []);
  });
});
