import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

describe("categories routes", () => {
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
