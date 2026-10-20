import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

describe("quick assign routes", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let accountId: string;
  let groupId: string;
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
    groupId = group.rows[0]!.id;
    const category = await superuserPool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1) RETURNING id",
      [workspaceId, groupId],
    );
    categoryId = category.rows[0]!.id;
  });

  after(async () => {
    await teardownIntegrationTest({ superuserPool, realm, app, workspaceId, token });
  });

  it("rejects a request with no token", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/quick-assign`,
      payload: { month: "2026-09", scope: { kind: "all" }, mode: "fund_targets" },
    });
    assert.equal(response.statusCode, 401);
  });

  it("covers overspending for a category, scoped to all", async () => {
    const auth = { authorization: `Bearer ${token}` };
    await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-09-01", splits: [{ categoryId: null, amountCents: 100_000 }] },
    });
    await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-09-10", splits: [{ categoryId, amountCents: -5_000 }] },
    });

    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/quick-assign`,
      headers: auth,
      payload: { month: "2026-09", scope: { kind: "all" }, mode: "cover_overspending" },
    });
    assert.equal(response.statusCode, 201);
    const entries = response.json().entries as Array<{ destinationCategoryId: string; amountCents: number }>;
    const entry = entries.find((e) => e.destinationCategoryId === categoryId);
    assert.equal(entry?.amountCents, 5_000);
  });

  it("scopes to a single group", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/quick-assign`,
      headers: { authorization: `Bearer ${token}` },
      payload: { month: "2026-09", scope: { kind: "group", groupId }, mode: "cover_overspending" },
    });
    assert.equal(response.statusCode, 201);
  });

  it("rejects an unknown mode", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/quick-assign`,
      headers: { authorization: `Bearer ${token}` },
      payload: { month: "2026-09", scope: { kind: "all" }, mode: "not-a-mode" },
    });
    assert.equal(response.statusCode, 400);
  });

  it("rejects a group scope naming an unknown group", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/quick-assign`,
      headers: { authorization: `Bearer ${token}` },
      payload: { month: "2026-09", scope: { kind: "group", groupId: randomUUID() }, mode: "cover_overspending" },
    });
    assert.equal(response.statusCode, 400);
  });

  it("rejects an invalid month with a translatable error", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/quick-assign`,
      headers: { authorization: `Bearer ${token}` },
      payload: { month: "not-a-month", scope: { kind: "all" }, mode: "cover_overspending" },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_month");
  });
});
