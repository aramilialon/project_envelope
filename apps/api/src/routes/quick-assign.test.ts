import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { MAX_AMOUNT_CENTS } from "@envelope/core";

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

// A category's computed amount can be above the cap on a single amount (ADR 0002, #651), made of
// several amounts that are each within it: quick assign splits it into entries of at most the cap,
// in one batch that still undoes together, instead of failing.
describe("quick assign above the cap on a single amount (#651)", () => {
  const CAP = MAX_AMOUNT_CENTS;
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let accountId: string;
  let overspentId: string;
  let repeatedId: string;
  let token: string;

  interface Entry {
    readonly batchId: string;
    readonly destinationCategoryId: string;
    readonly amountCents: number;
  }

  async function post(path: string, payload: Record<string, unknown>) {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}${path}`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${response.statusCode} ${response.body}`);
    return response;
  }

  async function available(month: string, categoryId: string): Promise<number | undefined> {
    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/budget-months/${month}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    const categories = response.json().categories as Array<{ categoryId: string; available: number }>;
    return categories.find((c) => c.categoryId === categoryId)?.available;
  }

  /** The entries for one category: each at most the cap, all in one batch, adding up to `total`. */
  function assertSplit(entries: Entry[], categoryId: string, total: number): Entry[] {
    const ours = entries.filter((e) => e.destinationCategoryId === categoryId);
    assert.deepEqual(
      ours.map((e) => e.amountCents),
      [CAP, total - CAP],
    );
    assert.equal(new Set(entries.map((e) => e.batchId)).size, 1);
    return ours;
  }

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
    const insertCategory = async (name: string, sortOrder: number) =>
      (
        await superuserPool.query<{ id: string }>(
          "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, $3, $4) RETURNING id",
          [workspaceId, group.rows[0]!.id, name, sortOrder],
        )
      ).rows[0]!.id;
    overspentId = await insertCategory("Renovation", 1);
    repeatedId = await insertCategory("Property", 2);
    // Six income transactions at the cap: enough unassigned money for every case below.
    for (let day = 1; day <= 6; day++) {
      await post(`/accounts/${accountId}/transactions`, {
        occurredAt: `2026-09-0${day}`,
        splits: [{ categoryId: null, amountCents: CAP }],
      });
    }
  });

  after(async () => {
    await teardownIntegrationTest({ superuserPool, realm, app, workspaceId, token });
  });

  it("cover_overspending: overspending above the cap is covered in entries of at most the cap, undone together", async () => {
    const overspent = CAP + CAP / 2;
    for (const amountCents of [-CAP, -CAP / 2]) {
      await post(`/accounts/${accountId}/transactions`, { occurredAt: "2026-09-10", splits: [{ categoryId: overspentId, amountCents }] });
    }
    assert.equal(await available("2026-09", overspentId), -overspent);

    const response = await post("/quick-assign", { month: "2026-09", scope: { kind: "all" }, mode: "cover_overspending" });
    assert.equal(response.statusCode, 201);
    const entries = response.json().entries as Entry[];
    assertSplit(entries, overspentId, overspent);
    assert.equal(await available("2026-09", overspentId), 0);

    await post(`/assignment-batches/${entries[0]!.batchId}/undo`, {});
    assert.equal(await available("2026-09", overspentId), -overspent);
  });

  it("repeat_assigned: last month's assigned amount above the cap is assigned again in entries of at most the cap", async () => {
    const assigned = CAP + CAP / 2;
    await post("/assignments", {
      entries: [
        { month: "2026-09", sourceCategoryId: null, destinationCategoryId: repeatedId, amountCents: CAP },
        { month: "2026-09", sourceCategoryId: null, destinationCategoryId: repeatedId, amountCents: CAP / 2 },
      ],
    });

    const response = await post("/quick-assign", { month: "2026-10", scope: { kind: "all" }, mode: "repeat_assigned" });
    assert.equal(response.statusCode, 201);
    assertSplit(response.json().entries as Entry[], repeatedId, assigned);
  });
});
