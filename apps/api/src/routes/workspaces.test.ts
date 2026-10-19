import assert from "node:assert/strict";
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

describe("workspaces routes (#394)", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let token: string;
  const createdWorkspaceIds: string[] = [];

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

    token = await realm.getUserToken();
    // Maps this token's subject to a local user row (the user-mapper preHandler does this on
    // any authenticated call — any endpoint would do, `/me/workspaces` is the lightest one).
    await app.fastify.inject({ method: "GET", url: "/me/workspaces", headers: { authorization: `Bearer ${token}` } });
  });

  after(async () => {
    await app.close();
    for (const id of createdWorkspaceIds) {
      await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [id]);
    }
    await realm.teardown();
    await superuserPool.end();
  });

  it("rejects a request with no token", async () => {
    const response = await app.fastify.inject({ method: "POST", url: "/workspaces", payload: { name: "Mine", baseCurrency: "EUR", timeZone: "Europe/Rome" } });
    assert.equal(response.statusCode, 401);
  });

  it("creates a workspace with the signed-in user as its own owner", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: "/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Famiglia", baseCurrency: "EUR", timeZone: "Europe/Rome" },
    });
    assert.equal(response.statusCode, 201);
    const workspace = response.json();
    assert.equal(workspace.name, "Famiglia");
    assert.equal(workspace.role, "owner");
    assert.equal(workspace.baseCurrency, "EUR");
    assert.equal(workspace.timeZone, "Europe/Rome");
    createdWorkspaceIds.push(workspace.id);

    const listed = await app.fastify.inject({
      method: "GET",
      url: "/me/workspaces",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.ok(listed.json().workspaces.some((w: { id: string }) => w.id === workspace.id));
  });

  it("rejects a request missing a required field", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: "/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Famiglia", baseCurrency: "EUR" },
    });
    assert.equal(response.statusCode, 400);
  });

  it("rejects an unknown currency code", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: "/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Famiglia", baseCurrency: "NOPE", timeZone: "Europe/Rome" },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_currency");
  });

  it("rejects an unknown IANA time zone", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: "/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Famiglia", baseCurrency: "EUR", timeZone: "Not/AZone" },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_time_zone");
  });

  it("deletes a workspace, and only its own owner may", async () => {
    const created = await app.fastify.inject({
      method: "POST",
      url: "/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "To delete", baseCurrency: "EUR", timeZone: "Europe/Rome" },
    });
    const workspace = created.json();

    const editorToken = await realm.getTokenForNewUser();
    await app.fastify.inject({ method: "GET", url: "/me/workspaces", headers: { authorization: `Bearer ${editorToken}` } });
    const editorSubject = decodeJwt(editorToken).sub;
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [editorSubject]);
    const editorUserId = rows[0]?.id;
    assert.ok(editorUserId, "expected the user mapper to have created a local user for this token's subject");
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'editor')", [
      editorUserId,
      workspace.id,
    ]);

    const refused = await app.fastify.inject({
      method: "DELETE",
      url: `/workspaces/${workspace.id}`,
      headers: { authorization: `Bearer ${editorToken}` },
    });
    assert.equal(refused.statusCode, 403);

    const deleted = await app.fastify.inject({
      method: "DELETE",
      url: `/workspaces/${workspace.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(deleted.statusCode, 204);

    const { rows: remaining } = await superuserPool.query("SELECT id FROM workspaces WHERE id = $1", [workspace.id]);
    assert.equal(remaining.length, 0);
  });

  it("deleting a workspace the caller does not belong to is a 403, the same as any other unknown one", async () => {
    const other = await superuserPool.query<{ id: string }>(
      "INSERT INTO workspaces (name, base_currency, time_zone) VALUES ('Not mine', 'EUR', 'Europe/Rome') RETURNING id",
    );
    createdWorkspaceIds.push(other.rows[0]!.id);

    const response = await app.fastify.inject({
      method: "DELETE",
      url: `/workspaces/${other.rows[0]!.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 403);
  });
});
