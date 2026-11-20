import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { MAX_NAME_LENGTH } from "@envelope/core";

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

  it("creates a brokerage account off budget when onBudget is not sent (#74)", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Broker", type: "brokerage", currency: "EUR" },
    });
    assert.equal(response.statusCode, 201);
    const account = response.json();
    assert.equal(account.type, "brokerage");
    assert.equal(account.onBudget, false);
    assert.equal(account.paymentCategoryId, null);
  });

  it("creates a brokerage account sent explicitly off budget", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Broker off", type: "brokerage", currency: "EUR", onBudget: false },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().onBudget, false);
  });

  it("rejects an on-budget brokerage account with a stable code", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Broker on", type: "brokerage", currency: "EUR", onBudget: true },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "brokerage_on_budget");

    const listed = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.ok(!listed.json().accounts.some((a: { name: string }) => a.name === "Broker on"));
  });

  it("rejects an onBudget that is not a real boolean, storing nothing", async () => {
    for (const onBudget of ["false", 0, null]) {
      const name = `Not boolean ${String(onBudget)}`;
      const response = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name, type: "savings", currency: "EUR", onBudget },
      });
      assert.equal(response.statusCode, 400, `onBudget ${JSON.stringify(onBudget)}`);

      const listed = await app.fastify.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/accounts`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.ok(!listed.json().accounts.some((a: { name: string }) => a.name === name));
    }
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

  it("caps the account name at the name limit, counted in characters (#507)", async () => {
    const auth = { authorization: `Bearer ${token}` };
    // Emoji are two UTF-16 code units each: the limit counts characters, so this is exactly at it.
    const atLimit = "💶".repeat(MAX_NAME_LENGTH);
    const accepted = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: auth,
      payload: { name: atLimit, type: "checking", currency: "EUR" },
    });
    assert.equal(accepted.statusCode, 201);
    assert.equal(accepted.json().name, atLimit);

    const rejected = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: auth,
      payload: { name: "a".repeat(MAX_NAME_LENGTH + 1), type: "checking", currency: "EUR" },
    });
    assert.equal(rejected.statusCode, 400);
    assert.deepEqual(rejected.json(), { error: "text_too_long", details: { field: "name", max: MAX_NAME_LENGTH } });
  });
});
