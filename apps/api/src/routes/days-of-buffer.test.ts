import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

describe("days of buffer routes", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let accountId: string;
  let categoryId: string;
  let token: string;

  before(async () => {
    ({ superuserPool, realm, app, workspaceId, token } = await setupIntegrationTest());

    const account = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspaceId],
    );
    accountId = account.rows[0]!.id;
    const group = await superuserPool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspaceId],
    );
    const category = await superuserPool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    categoryId = category.rows[0]!.id;
  });

  after(async () => {
    await teardownIntegrationTest({ superuserPool, realm, app, workspaceId, token });
  });

  it("rejects a request with no token", async () => {
    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/days-of-buffer`,
    });
    assert.equal(response.statusCode, 401);
  });

  it("computes days of buffer from real transactions, for a given asOf", async () => {
    const auth = { authorization: `Bearer ${token}` };

    await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-08-01", splits: [{ categoryId: null, amountCents: 10_000 }] },
    });
    await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-08-05", splits: [{ categoryId, amountCents: -4_000 }] },
    });
    await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-08-10", splits: [{ categoryId, amountCents: -6_000 }] },
    });

    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/days-of-buffer?asOf=2026-08-10`,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.asOf, "2026-08-10");
    assert.equal(body.daysOfBuffer, (4 * 4_000 + 9 * 6_000) / 10_000);
  });

  it("defaults asOf to today in the workspace's own time zone when not given", async () => {
    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/days-of-buffer`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().asOf, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("rejects an invalid asOf with a translatable error", async () => {
    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/days-of-buffer?asOf=not-a-date`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_date");
  });
});
