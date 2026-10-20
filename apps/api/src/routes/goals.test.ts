import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

describe("goals routes", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let categoryId: string;
  let token: string;

  before(async () => {
    ({ superuserPool, realm, app, workspaceId, token } = await setupIntegrationTest());

    const group = await superuserPool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspaceId],
    );
    const category = await superuserPool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Holidays', 1) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    categoryId = category.rows[0]!.id;
  });

  after(async () => {
    await teardownIntegrationTest({ superuserPool, realm, app, workspaceId, token });
  });

  it("rejects a request with no token", async () => {
    const response = await app.fastify.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/categories/${categoryId}/goal`,
      payload: { kind: "monthly", amountCents: 1000 },
    });
    assert.equal(response.statusCode, 401);
  });

  it("sets, reads with progress, and deletes a goal", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const set = await app.fastify.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/categories/${categoryId}/goal`,
      headers: auth,
      payload: { kind: "monthly", amountCents: 60000 },
    });
    assert.equal(set.statusCode, 200);
    assert.equal(set.json().kind, "monthly");

    const read = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/categories/${categoryId}/goal?month=2026-09`,
      headers: auth,
    });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().asks, 60000);
    assert.equal(read.json().missing, 60000); // nothing assigned yet

    const removed = await app.fastify.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/categories/${categoryId}/goal`,
      headers: auth,
    });
    assert.equal(removed.statusCode, 204);

    const readAfterDelete = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/categories/${categoryId}/goal?month=2026-09`,
      headers: auth,
    });
    assert.equal(readAfterDelete.statusCode, 404);
  });

  it("rejects a repeating goal missing every", async () => {
    const response = await app.fastify.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/categories/${categoryId}/goal`,
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: "repeating", amountCents: 60000, dueMonth: "2026-12" },
    });
    assert.equal(response.statusCode, 400);
  });

  it("rejects a monthly goal that also sets dueMonth", async () => {
    const response = await app.fastify.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/categories/${categoryId}/goal`,
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: "monthly", amountCents: 60000, dueMonth: "2026-12" },
    });
    assert.equal(response.statusCode, 400);
  });

  it("rejects a goal for an unknown category", async () => {
    const response = await app.fastify.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/categories/${randomUUID()}/goal`,
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: "monthly", amountCents: 60000 },
    });
    assert.equal(response.statusCode, 400);
  });

  it("rejects a GET with no month", async () => {
    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/categories/${categoryId}/goal`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 400);
  });
});
