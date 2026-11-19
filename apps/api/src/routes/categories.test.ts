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

  describe("renaming, and names already in use (#397)", () => {
    const auth = () => ({ authorization: `Bearer ${token}` });

    async function createGroup(name: string) {
      return app.fastify.inject({ method: "POST", url: `/workspaces/${workspaceId}/category-groups`, headers: auth(), payload: { name } });
    }

    async function createCategory(name: string, groupId: string) {
      return app.fastify.inject({ method: "POST", url: `/workspaces/${workspaceId}/categories`, headers: auth(), payload: { name, groupId } });
    }

    it("renames a group and a category, trimming the new name", async () => {
      const group = (await createGroup("Bills")).json();
      const category = (await createCategory("Power", group.id)).json();

      const renamedGroup = await app.fastify.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/category-groups/${group.id}`,
        headers: auth(),
        payload: { name: "  Home bills " },
      });
      assert.equal(renamedGroup.statusCode, 200);
      assert.equal(renamedGroup.json().name, "Home bills");

      const renamedCategory = await app.fastify.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/categories/${category.id}`,
        headers: auth(),
        payload: { name: "Power and gas" },
      });
      assert.equal(renamedCategory.statusCode, 200);
      assert.equal(renamedCategory.json().name, "Power and gas");
      assert.equal(renamedCategory.json().groupId, group.id);

      // Keeping its own name, just in another case, is not a clash with itself.
      const sameName = await app.fastify.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/categories/${category.id}`,
        headers: auth(),
        payload: { name: "power and gas" },
      });
      assert.equal(sameName.statusCode, 200);
    });

    it("refuses an empty name and an unknown id", async () => {
      const group = (await createGroup("Empty names")).json();
      const empty = await app.fastify.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/category-groups/${group.id}`,
        headers: auth(),
        payload: { name: "   " },
      });
      assert.equal(empty.statusCode, 400);

      const unknownGroup = await app.fastify.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/category-groups/${randomUUID()}`,
        headers: auth(),
        payload: { name: "Anything" },
      });
      assert.equal(unknownGroup.statusCode, 404);

      const unknownCategory = await app.fastify.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/categories/${randomUUID()}`,
        headers: auth(),
        payload: { name: "Anything" },
      });
      assert.equal(unknownCategory.statusCode, 404);
    });

    it("refuses a second category or group with the same name, whatever its case, as name_taken", async () => {
      const group = (await createGroup("Everyday")).json();
      await createCategory("Groceries", group.id);

      const duplicateCategory = await createCategory(" groceries", group.id);
      assert.equal(duplicateCategory.statusCode, 409);
      assert.equal(duplicateCategory.json().code, "name_taken");

      const duplicateGroup = await createGroup("EVERYDAY");
      assert.equal(duplicateGroup.statusCode, 409);
      assert.equal(duplicateGroup.json().code, "name_taken");

      const other = (await createCategory("Bakery", group.id)).json();
      const renamedOntoAnother = await app.fastify.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/categories/${other.id}`,
        headers: auth(),
        payload: { name: "Groceries" },
      });
      assert.equal(renamedOntoAnother.statusCode, 409);
      assert.equal(renamedOntoAnother.json().code, "name_taken");
    });

    it("allows the same category name in another group, and reusing an archived one's name", async () => {
      const first = (await createGroup("Holidays")).json();
      const second = (await createGroup("Gifts")).json();
      const archived = (await createCategory("Travel", first.id)).json();
      assert.equal((await createCategory("Travel", second.id)).statusCode, 201);

      await app.fastify.inject({ method: "PATCH", url: `/workspaces/${workspaceId}/categories/${archived.id}/archive`, headers: auth() });
      assert.equal((await createCategory("Travel", first.id)).statusCode, 201);
    });

    it("never renames a card's own payment category, nor the shared credit card payments group, nor another group onto its name", async () => {
      const card = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts`,
        headers: auth(),
        payload: { name: "Rename card", type: "credit_card", currency: "EUR" },
      });
      assert.equal(card.statusCode, 201);
      const paymentCategoryId = card.json().paymentCategoryId as string;
      const categories = await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/categories`, headers: auth() });
      const paymentGroupId = categories.json().categories.find((c: { id: string }) => c.id === paymentCategoryId).groupId as string;

      const category = await app.fastify.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/categories/${paymentCategoryId}`,
        headers: auth(),
        payload: { name: "Something else" },
      });
      assert.equal(category.statusCode, 409);
      assert.equal(category.json().code, "payment_category");

      const group = await app.fastify.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/category-groups/${paymentGroupId}`,
        headers: auth(),
        payload: { name: "Cards" },
      });
      assert.equal(group.statusCode, 409);
      assert.equal(group.json().code, "payment_group");

      const other = (await createGroup("Not the cards")).json();
      const ontoPaymentGroup = await app.fastify.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/category-groups/${other.id}`,
        headers: auth(),
        payload: { name: "credit card payments" },
      });
      assert.equal(ontoPaymentGroup.statusCode, 409);
      assert.equal(ontoPaymentGroup.json().code, "payment_group");
    });
  });
});
