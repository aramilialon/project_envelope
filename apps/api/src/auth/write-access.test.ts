import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

interface Endpoint {
  readonly name: string;
  readonly method: "POST" | "PATCH" | "PUT" | "DELETE";
  readonly path: string;
  readonly payload?: Record<string, unknown>;
}

/**
 * Every write endpoint added in 0.1.3 (#24). Fixture ids are filled in by
 * `before()` once every dependency (an account, a category, a transaction, an
 * assignment batch...) exists to reference.
 */
function endpoints(ids: {
  workspaceId: string;
  accountId: string;
  accountToCloseId: string;
  groupId: string;
  groupToArchiveId: string;
  categoryId: string;
  categoryToArchiveId: string;
  goalCategoryId: string;
  transactionId: string;
  batchId: string;
  entryId: string;
}): Endpoint[] {
  const w = ids.workspaceId;
  return [
    { name: "create account", method: "POST", path: `/workspaces/${w}/accounts`, payload: { name: "New", type: "checking", currency: "EUR" } },
    { name: "close account", method: "PATCH", path: `/workspaces/${w}/accounts/${ids.accountToCloseId}/close` },
    { name: "create category group", method: "POST", path: `/workspaces/${w}/category-groups`, payload: { name: "New group" } },
    { name: "archive category group", method: "PATCH", path: `/workspaces/${w}/category-groups/${ids.groupToArchiveId}/archive` },
    { name: "reorder category groups", method: "PUT", path: `/workspaces/${w}/category-groups/reorder`, payload: { groupIds: [ids.groupId, ids.groupToArchiveId] } },
    { name: "create category", method: "POST", path: `/workspaces/${w}/categories`, payload: { name: "New category", groupId: ids.groupId } },
    { name: "archive category", method: "PATCH", path: `/workspaces/${w}/categories/${ids.categoryToArchiveId}/archive` },
    { name: "reorder categories", method: "PUT", path: `/workspaces/${w}/category-groups/${ids.groupId}/categories/reorder`, payload: { categoryIds: [ids.categoryId] } },
    { name: "create transaction", method: "POST", path: `/workspaces/${w}/accounts/${ids.accountId}/transactions`, payload: { occurredAt: "2026-09-15", splits: [{ categoryId: ids.categoryId, amountCents: -100 }] } },
    { name: "update transaction", method: "PATCH", path: `/workspaces/${w}/accounts/${ids.accountId}/transactions/${ids.transactionId}`, payload: { memo: "changed" } },
    { name: "create transfer", method: "POST", path: `/workspaces/${w}/transfers`, payload: { sourceAccountId: ids.accountId, destinationAccountId: ids.accountToCloseId, occurredAt: "2026-09-15", amountCents: 100 } },
    { name: "create assignment batch", method: "POST", path: `/workspaces/${w}/assignments`, payload: { entries: [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: ids.categoryId, amountCents: 100 }] } },
    { name: "undo assignment batch", method: "POST", path: `/workspaces/${w}/assignment-batches/${ids.batchId}/undo` },
    { name: "undo assignment entry", method: "POST", path: `/workspaces/${w}/assignments/${ids.entryId}/undo` },
    { name: "set goal", method: "PUT", path: `/workspaces/${w}/categories/${ids.goalCategoryId}/goal`, payload: { kind: "monthly", amountCents: 1000 } },
    { name: "delete goal", method: "DELETE", path: `/workspaces/${w}/categories/${ids.goalCategoryId}/goal` },
    { name: "quick assign", method: "POST", path: `/workspaces/${w}/quick-assign`, payload: { month: "2026-09", scope: { kind: "all" }, mode: "cover_overspending" } },
  ];
}

describe("write access, restricted to owner and editor (#24)", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let readOnlyToken: string;
  let editorToken: string;
  let ids: Parameters<typeof endpoints>[0];

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

    workspaceId = randomUUID();
    await superuserPool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Mine', 'EUR', 'Europe/Rome')",
      [workspaceId],
    );

    const ownerToken = await realm.getUserToken();
    readOnlyToken = await realm.getTokenForNewUser();
    editorToken = await realm.getTokenForNewUser();

    // A throwaway request per token lets the user-mapper preHandler create each local users row.
    for (const token of [ownerToken, readOnlyToken, editorToken]) {
      await app.fastify.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/accounts`,
        headers: { authorization: `Bearer ${token}` },
      });
    }
    async function localUserId(token: string): Promise<string> {
      const subject = decodeJwt(token).sub;
      const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [
        subject,
      ]);
      const userId = rows[0]?.id;
      assert.ok(userId, "expected the user mapper to have created a local user for this token's subject");
      return userId;
    }
    await superuserPool.query(
      `INSERT INTO memberships (user_id, workspace_id, role) VALUES
         ($1, $4, 'owner'), ($2, $4, 'read_only'), ($3, $4, 'editor')`,
      [await localUserId(ownerToken), await localUserId(readOnlyToken), await localUserId(editorToken), workspaceId],
    );

    const auth = { authorization: `Bearer ${ownerToken}` };
    const account = await app.fastify
      .inject({ method: "POST", url: `/workspaces/${workspaceId}/accounts`, headers: auth, payload: { name: "Checking", type: "checking", currency: "EUR" } })
      .then((r) => r.json());
    const accountToClose = await app.fastify
      .inject({ method: "POST", url: `/workspaces/${workspaceId}/accounts`, headers: auth, payload: { name: "To close", type: "checking", currency: "EUR" } })
      .then((r) => r.json());
    const group = await app.fastify
      .inject({ method: "POST", url: `/workspaces/${workspaceId}/category-groups`, headers: auth, payload: { name: "Home" } })
      .then((r) => r.json());
    const groupToArchive = await app.fastify
      .inject({ method: "POST", url: `/workspaces/${workspaceId}/category-groups`, headers: auth, payload: { name: "To archive" } })
      .then((r) => r.json());
    const category = await app.fastify
      .inject({ method: "POST", url: `/workspaces/${workspaceId}/categories`, headers: auth, payload: { name: "Groceries", groupId: group.id } })
      .then((r) => r.json());
    const categoryToArchive = await app.fastify
      .inject({ method: "POST", url: `/workspaces/${workspaceId}/categories`, headers: auth, payload: { name: "To archive", groupId: group.id } })
      .then((r) => r.json());
    const goalCategory = await app.fastify
      .inject({ method: "POST", url: `/workspaces/${workspaceId}/categories`, headers: auth, payload: { name: "Goal target", groupId: group.id } })
      .then((r) => r.json());
    const transaction = await app.fastify
      .inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts/${account.id}/transactions`,
        headers: auth,
        payload: { occurredAt: "2026-09-01", splits: [{ categoryId: category.id, amountCents: -500 }] },
      })
      .then((r) => r.json());
    const batch = await app.fastify
      .inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/assignments`,
        headers: auth,
        payload: { entries: [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: category.id, amountCents: 200 }] },
      })
      .then((r) => r.json());

    ids = {
      workspaceId,
      accountId: account.id,
      accountToCloseId: accountToClose.id,
      groupId: group.id,
      groupToArchiveId: groupToArchive.id,
      categoryId: category.id,
      categoryToArchiveId: categoryToArchive.id,
      goalCategoryId: goalCategory.id,
      transactionId: transaction.id,
      batchId: batch.entries[0].batchId,
      entryId: batch.entries[0].id,
    };
  });

  after(async () => {
    await app.close();
    await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await realm.teardown();
    await superuserPool.end();
  });

  it("rejects a read-only member with 403 on every write endpoint added in this milestone", async () => {
    for (const endpoint of endpoints(ids)) {
      const response = await app.fastify.inject({
        method: endpoint.method,
        url: endpoint.path,
        headers: { authorization: `Bearer ${readOnlyToken}` },
        ...(endpoint.payload !== undefined ? { payload: endpoint.payload } : {}),
      });
      assert.equal(response.statusCode, 403, `${endpoint.name} (read-only)`);
    }
  });

  it("does not reject an editor with 403 on a representative sample of write endpoints", async () => {
    const auth = { authorization: `Bearer ${editorToken}` };
    for (const name of ["create account", "create category", "create transaction", "create assignment batch", "set goal", "quick assign"]) {
      const endpoint = endpoints(ids).find((e) => e.name === name);
      assert.ok(endpoint, name);
      const response = await app.fastify.inject({
        method: endpoint.method,
        url: endpoint.path,
        headers: auth,
        ...(endpoint.payload !== undefined ? { payload: endpoint.payload } : {}),
      });
      assert.notEqual(response.statusCode, 403, `${name} (editor)`);
    }
  });

  it("still allows a read-only member to read everything, including the unresolved-problems list", async () => {
    const auth = { authorization: `Bearer ${readOnlyToken}` };
    for (const path of [
      `/workspaces/${workspaceId}/accounts`,
      `/workspaces/${workspaceId}/categories`,
      `/workspaces/${workspaceId}/budget-months/2026-09`,
      `/workspaces/${workspaceId}/budget-months/2026-09/problems`,
      `/workspaces/${workspaceId}/days-of-buffer`,
    ]) {
      const response = await app.fastify.inject({ method: "GET", url: path, headers: auth });
      assert.equal(response.statusCode, 200, path);
    }
  });
});
