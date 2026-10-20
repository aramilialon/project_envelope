import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

describe("assignments routes", () => {
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
      method: "POST",
      url: `/workspaces/${workspaceId}/assignments`,
      payload: { entries: [] },
    });
    assert.equal(response.statusCode, 401);
  });

  it("creates a batch and undoes it", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignments`,
      headers: auth,
      payload: {
        entries: [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 5000 }],
      },
    });
    assert.equal(created.statusCode, 201);
    const entry = created.json().entries[0];
    assert.equal(entry.destinationCategoryId, categoryId);
    assert.equal(entry.amountCents, 5000);

    const undone = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignment-batches/${entry.batchId}/undo`,
      headers: auth,
    });
    assert.equal(undone.statusCode, 201);
    assert.equal(undone.json().entries[0].reverses, entry.id);

    const undoneAgain = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignment-batches/${entry.batchId}/undo`,
      headers: auth,
    });
    assert.equal(undoneAgain.statusCode, 201);
    assert.deepEqual(undoneAgain.json().entries, []);
  });

  it("undoes a single row and reports already_reversed on a second try", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignments`,
      headers: auth,
      payload: {
        entries: [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 250 }],
      },
    });
    const entry = created.json().entries[0];

    const undone = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignments/${entry.id}/undo`,
      headers: auth,
    });
    assert.equal(undone.statusCode, 201);

    const again = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignments/${entry.id}/undo`,
      headers: auth,
    });
    assert.equal(again.statusCode, 409);
  });

  it("rejects an entry naming an unknown category", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignments`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        entries: [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: randomUUID(), amountCents: 100 }],
      },
    });
    assert.equal(response.statusCode, 400);
  });

  it("rejects an empty entries array", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignments`,
      headers: { authorization: `Bearer ${token}` },
      payload: { entries: [] },
    });
    assert.equal(response.statusCode, 400);
  });

  it("undoing an unknown batch is a 404", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignment-batches/${randomUUID()}/undo`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 404);
  });

  it("undoing an unknown entry is a 404", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignments/${randomUUID()}/undo`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 404);
  });
});
