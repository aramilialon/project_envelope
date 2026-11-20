import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { MAX_NAME_LENGTH } from "@envelope/core";

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

  it("sets and clears the tax country, and only its own owner may (#508)", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const created = await app.fastify.inject({
      method: "POST",
      url: "/workspaces",
      headers: auth,
      payload: { name: "Taxed", baseCurrency: "EUR", timeZone: "Europe/Rome" },
    });
    const workspace = created.json();
    createdWorkspaceIds.push(workspace.id);
    assert.equal(workspace.taxCountry, null);

    const patch = (payload: unknown, headers: Record<string, string> = auth) =>
      app.fastify.inject({ method: "PATCH", url: `/workspaces/${workspace.id}`, headers, payload: payload as object });
    const listedTaxCountry = async () => {
      const listed = await app.fastify.inject({ method: "GET", url: "/me/workspaces", headers: auth });
      return listed.json().workspaces.find((w: { id: string }) => w.id === workspace.id).taxCountry;
    };

    const set = await patch({ taxCountry: "IT" });
    assert.equal(set.statusCode, 200);
    assert.deepEqual(set.json(), {
      id: workspace.id,
      name: "Taxed",
      baseCurrency: "EUR",
      timeZone: "Europe/Rome",
      taxCountry: "IT",
    });
    assert.equal(await listedTaxCountry(), "IT");

    for (const taxCountry of ["XX", "it", "ITA", ""]) {
      const refused = await patch({ taxCountry });
      assert.equal(refused.statusCode, 400, taxCountry);
      assert.equal(refused.json().error, "invalid_tax_country", taxCountry);
    }
    for (const payload of [{}, { taxCountry: 39 }]) {
      assert.equal((await patch(payload)).statusCode, 400, JSON.stringify(payload));
    }
    assert.equal(await listedTaxCountry(), "IT");

    const editorToken = await realm.getTokenForNewUser();
    await app.fastify.inject({ method: "GET", url: "/me/workspaces", headers: { authorization: `Bearer ${editorToken}` } });
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [
      decodeJwt(editorToken).sub,
    ]);
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'editor')", [
      rows[0]!.id,
      workspace.id,
    ]);
    const byEditor = await patch({ taxCountry: null }, { authorization: `Bearer ${editorToken}` });
    assert.equal(byEditor.statusCode, 403);
    assert.equal(await listedTaxCountry(), "IT");

    const cleared = await patch({ taxCountry: null });
    assert.equal(cleared.statusCode, 200);
    assert.equal(await listedTaxCountry(), null);
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

  it("accepts a name at the name limit, and rejects one character more (#507)", async () => {
    const accepted = await app.fastify.inject({
      method: "POST",
      url: "/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "w".repeat(MAX_NAME_LENGTH), baseCurrency: "EUR", timeZone: "Europe/Rome" },
    });
    assert.equal(accepted.statusCode, 201);
    assert.equal(accepted.json().name, "w".repeat(MAX_NAME_LENGTH));
    createdWorkspaceIds.push(accepted.json().id);

    const response = await app.fastify.inject({
      method: "POST",
      url: "/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "w".repeat(MAX_NAME_LENGTH + 1), baseCurrency: "EUR", timeZone: "Europe/Rome" },
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "text_too_long", details: { field: "name", max: MAX_NAME_LENGTH } });
  });
});
