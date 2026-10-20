import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

describe("accounts routes", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let token: string;

  before(async () => {
    ({ superuserPool, realm, app, workspaceId, token } = await setupIntegrationTest());
  });

  after(async () => {
    await teardownIntegrationTest({ superuserPool, realm, app, workspaceId, token });
  });

  it("rejects a request with no token", async () => {
    const response = await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/accounts` });
    assert.equal(response.statusCode, 401);
  });

  it("creates, lists and closes an account", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: auth,
      payload: { name: "Checking", type: "checking", currency: "EUR" },
    });
    assert.equal(created.statusCode, 201);
    const account = created.json();
    assert.equal(account.name, "Checking");
    assert.equal(account.onBudget, true);
    assert.equal(account.paymentCategoryId, null);

    const listed = await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/accounts`, headers: auth });
    assert.equal(listed.statusCode, 200);
    assert.ok(listed.json().accounts.some((a: { id: string }) => a.id === account.id));

    const closed = await app.fastify.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/accounts/${account.id}/close`,
      headers: auth,
    });
    assert.equal(closed.statusCode, 200);
    assert.ok(closed.json().closedAt);

    const closedAgain = await app.fastify.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/accounts/${account.id}/close`,
      headers: auth,
    });
    assert.equal(closedAgain.statusCode, 404);
  });

  it("creating an on-budget credit card links a payment category", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Visa", type: "credit_card", currency: "EUR" },
    });
    assert.equal(response.statusCode, 201);
    assert.ok(response.json().paymentCategoryId);
  });

  it("rejects an invalid account body", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "", type: "not-a-type", currency: "EUR" },
    });
    assert.equal(response.statusCode, 400);
  });
});
