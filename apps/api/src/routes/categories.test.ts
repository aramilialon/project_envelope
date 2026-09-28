import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { decodeJwt } from "jose";

import { buildApp, type App } from "../app.ts";
import { loadConfig } from "../config.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { setUpKeycloakTestRealm, type KeycloakTestRealm } from "../test-helpers/keycloak.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}
if (!process.env.KEYCLOAK_ADMIN_PASSWORD) {
  throw new Error("Set KEYCLOAK_ADMIN_PASSWORD (the value from infra/.env) before running the integration tests");
}

describe("categories routes", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let token: string;

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    realm = await setUpKeycloakTestRealm();

    app = buildApp(
      loadConfig({
        APP_DATABASE_URL: appConnectionString(databaseUrl),
        KEYCLOAK_ISSUER: realm.issuer,
        KEYCLOAK_AUDIENCE: realm.audience,
      }),
    );

    workspaceId = randomUUID();
    await superuserPool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Mine', 'EUR', 'Europe/Rome')",
      [workspaceId],
    );

    token = await realm.getUserToken();
    await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/categories`,
      headers: { authorization: `Bearer ${token}` },
    });
    const subject = decodeJwt(token).sub;
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [
      subject,
    ]);
    const userId = rows[0]?.id;
    assert.ok(userId, "expected the user mapper to have created a local user for this token's subject");
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [
      userId,
      workspaceId,
    ]);
  });

  after(async () => {
    await app.close();
    await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await realm.teardown();
    await superuserPool.end();
  });

  it("rejects a request with no token", async () => {
    const response = await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/category-groups` });
    assert.equal(response.statusCode, 401);
  });

  it("creates a group, a category in it, lists and archives both", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const group = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/category-groups`,
      headers: auth,
      payload: { name: "Home" },
    });
    assert.equal(group.statusCode, 201);
    const groupId = group.json().id;

    const category = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/categories`,
      headers: auth,
      payload: { name: "Rent", groupId },
    });
    assert.equal(category.statusCode, 201);
    const categoryId = category.json().id;

    const groups = await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/category-groups`, headers: auth });
    assert.ok(groups.json().groups.some((g: { id: string }) => g.id === groupId));

    const categories = await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/categories`, headers: auth });
    assert.ok(categories.json().categories.some((c: { id: string }) => c.id === categoryId));

    const archivedGroup = await app.fastify.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/category-groups/${groupId}/archive`,
      headers: auth,
    });
    assert.equal(archivedGroup.statusCode, 200);
    assert.equal(archivedGroup.json().archived, true);

    const archivedCategory = await app.fastify.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/categories/${categoryId}/archive`,
      headers: auth,
    });
    assert.equal(archivedCategory.statusCode, 200);
    assert.equal(archivedCategory.json().archived, true);
  });

  it("rejects creating a category with an unknown groupId", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/categories`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Orphan", groupId: randomUUID() },
    });
    assert.equal(response.statusCode, 400);
  });

  it("reorders categories within a group", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const group = await app.fastify
      .inject({ method: "POST", url: `/workspaces/${workspaceId}/category-groups`, headers: auth, payload: { name: "Reorder" } })
      .then((r) => r.json());
    const first = await app.fastify
      .inject({ method: "POST", url: `/workspaces/${workspaceId}/categories`, headers: auth, payload: { name: "First", groupId: group.id } })
      .then((r) => r.json());
    const second = await app.fastify
      .inject({ method: "POST", url: `/workspaces/${workspaceId}/categories`, headers: auth, payload: { name: "Second", groupId: group.id } })
      .then((r) => r.json());

    const reordered = await app.fastify.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/category-groups/${group.id}/categories/reorder`,
      headers: auth,
      payload: { categoryIds: [second.id, first.id] },
    });
    assert.equal(reordered.statusCode, 200);
    assert.deepEqual(
      reordered.json().categories.map((c: { id: string }) => c.id),
      [second.id, first.id],
    );
  });
});
