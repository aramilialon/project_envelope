import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { listWorkspaceMembers, listWorkspacesForUser } from "./repository.ts";

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

describe("listWorkspacesForUser (#50)", () => {
  let superuserPool: DbPool;
  let appPool: DbPool;

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    appPool = createPool(appConnectionString(databaseUrl));
  });

  after(async () => {
    await appPool.end();
    await superuserPool.end();
  });

  it("lists every workspace a user belongs to, with their own role, through the restricted envelope_app connection", async () => {
    const userId = (
      await superuserPool.query<{ id: string }>(
        "INSERT INTO users (keycloak_subject, email) VALUES ($1, $2) RETURNING id",
        [randomUUID(), `${randomUUID()}@example.com`],
      )
    ).rows[0]!.id;
    const own = await superuserPool.query<{ id: string }>(
      "INSERT INTO workspaces (name, base_currency, time_zone) VALUES ('Famiglia', 'EUR', 'UTC') RETURNING id",
    );
    const alsoOwn = await superuserPool.query<{ id: string }>(
      "INSERT INTO workspaces (name, base_currency, time_zone) VALUES ('Personale', 'EUR', 'UTC') RETURNING id",
    );
    const notOwn = await superuserPool.query<{ id: string }>(
      "INSERT INTO workspaces (name, base_currency, time_zone) VALUES ('Not mine', 'EUR', 'UTC') RETURNING id",
    );
    await superuserPool.query(
      "INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'read_only')",
      [userId, own.rows[0]!.id, alsoOwn.rows[0]!.id],
    );

    const workspaces = await listWorkspacesForUser(appPool, userId);

    assert.deepEqual(workspaces, [
      { id: own.rows[0]!.id, name: "Famiglia", role: "owner", baseCurrency: "EUR" },
      { id: alsoOwn.rows[0]!.id, name: "Personale", role: "read_only", baseCurrency: "EUR" },
    ]);
    assert.ok(
      !workspaces.some((w) => w.id === notOwn.rows[0]!.id),
      "a workspace this user does not belong to must never be listed",
    );
  });

  it("returns an empty list for a user with no memberships", async () => {
    const userId = (
      await superuserPool.query<{ id: string }>(
        "INSERT INTO users (keycloak_subject, email) VALUES ($1, $2) RETURNING id",
        [randomUUID(), `${randomUUID()}@example.com`],
      )
    ).rows[0]!.id;

    assert.deepEqual(await listWorkspacesForUser(appPool, userId), []);
  });
});
