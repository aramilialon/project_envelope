import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { MAX_AMOUNT_CENTS } from "@envelope/core";
import { decodeJwt } from "jose";

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

  describe("an amount that is not a valid goal amount (#701)", () => {
    const cases: readonly [string, Record<string, unknown>][] = [
      ["zero", { kind: "monthly", amountCents: 0 }],
      ["a negative amount", { kind: "balance", amountCents: -100 }],
      ["a negative amount on a dated goal", { kind: "by_date", amountCents: -1, dueMonth: "2026-12" }],
      ["a fraction of a minor unit", { kind: "monthly", amountCents: 100.5 }],
    ];

    for (const [name, payload] of cases) {
      it(`answers 400 invalid_goal_amount for ${name}, and stores nothing`, async () => {
        const response = await app.fastify.inject({
          method: "PUT",
          url: `/workspaces/${workspaceId}/categories/${categoryId}/goal`,
          headers: { authorization: `Bearer ${token}` },
          payload,
        });
        assert.equal(response.statusCode, 400, response.body);
        assert.deepEqual(response.json(), { error: "invalid_goal_amount", details: { field: "amountCents" } });

        const stored = await superuserPool.query("SELECT 1 FROM goals WHERE category_id = $1", [categoryId]);
        assert.equal(stored.rowCount, 0);
      });
    }

    for (const [name, amountCents] of [
      ["an amount above the cap", MAX_AMOUNT_CENTS + 1],
      ["an amount beyond the safe integer range", 1e300],
    ] as const) {
      it(`answers 400 amount_too_large for ${name}, like every other amount, and stores nothing`, async () => {
        const response = await app.fastify.inject({
          method: "PUT",
          url: `/workspaces/${workspaceId}/categories/${categoryId}/goal`,
          headers: { authorization: `Bearer ${token}` },
          payload: { kind: "repeating", amountCents, dueMonth: "2026-12", every: 12 },
        });
        assert.equal(response.statusCode, 400, response.body);
        assert.deepEqual(response.json(), {
          error: "amount_too_large",
          details: { label: "amount", max: MAX_AMOUNT_CENTS, value: String(amountCents) },
        });

        const stored = await superuserPool.query("SELECT 1 FROM goals WHERE category_id = $1", [categoryId]);
        assert.equal(stored.rowCount, 0);
      });
    }

    it("accepts 1 minor unit and the cap itself", async () => {
      for (const amountCents of [1, MAX_AMOUNT_CENTS]) {
        const response = await app.fastify.inject({
          method: "PUT",
          url: `/workspaces/${workspaceId}/categories/${categoryId}/goal`,
          headers: { authorization: `Bearer ${token}` },
          payload: { kind: "monthly", amountCents },
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().amountCents, amountCents);
      }
      await superuserPool.query("DELETE FROM goals WHERE category_id = $1", [categoryId]);
    });

    it("still answers a plain 400 for a missing amount", async () => {
      const response = await app.fastify.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/categories/${categoryId}/goal`,
        headers: { authorization: `Bearer ${token}` },
        payload: { kind: "monthly" },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "invalid goal: amountCents is required");
    });
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

  describe("GET /workspaces/:workspaceId/goals", () => {
    const otherWorkspaceIds: string[] = [];
    const auth = () => ({ authorization: `Bearer ${token}` });
    const list = (month: string | undefined, ws = workspaceId) =>
      app.fastify.inject({
        method: "GET",
        url: `/workspaces/${ws}/goals${month === undefined ? "" : `?month=${month}`}`,
        headers: auth(),
      });

    async function addCategory(ws: string, name: string): Promise<string> {
      const group = await superuserPool.query<{ id: string }>(
        "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, $2, 2) RETURNING id",
        [ws, `${name} group`],
      );
      const category = await superuserPool.query<{ id: string }>(
        "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, $3, 1) RETURNING id",
        [ws, group.rows[0]!.id, name],
      );
      return category.rows[0]!.id;
    }

    async function addWorkspace(role?: "read_only"): Promise<string> {
      const id = randomUUID();
      otherWorkspaceIds.push(id);
      await superuserPool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Other', 'EUR', 'Europe/Rome')", [id]);
      if (role) {
        const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [decodeJwt(token).sub]);
        await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, $3)", [rows[0]!.id, id, role]);
      }
      return id;
    }

    after(async () => {
      for (const id of otherWorkspaceIds) {
        await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [id]);
      }
    });

    it("lists every goal's progress for a month, each the same as the per-category GET", async () => {
      const monthly = await addCategory(workspaceId, "Groceries");
      const byDate = await addCategory(workspaceId, "Holidays 2027");
      const repeating = await addCategory(workspaceId, "Insurance");
      const balance = await addCategory(workspaceId, "Buffer");
      const withoutGoal = await addCategory(workspaceId, "No goal");
      const goals: [string, Record<string, unknown>][] = [
        [monthly, { kind: "monthly", amountCents: 40_000 }],
        [byDate, { kind: "by_date", amountCents: 360_000, dueMonth: "2027-06" }],
        [repeating, { kind: "repeating", amountCents: 60_000, dueMonth: "2026-12", every: 6 }],
        [balance, { kind: "balance", amountCents: 50_000 }],
      ];
      for (const [id, payload] of goals) {
        const set = await app.fastify.inject({ method: "PUT", url: `/workspaces/${workspaceId}/categories/${id}/goal`, headers: auth(), payload });
        assert.equal(set.statusCode, 200);
      }
      const assigned = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/assignments`,
        headers: auth(),
        payload: { entries: [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: monthly, amountCents: 10_000 }] },
      });
      assert.ok(assigned.statusCode < 300, `assignment failed: ${assigned.statusCode}`);

      const response = await list("2026-09");
      assert.equal(response.statusCode, 200);
      const listed = (response.json() as { goals: { goal: { categoryId: string } }[] }).goals;
      const byCategory = new Map(listed.map((p) => [p.goal.categoryId, p]));
      assert.equal(byCategory.has(withoutGoal), false);
      assert.deepEqual([...byCategory.keys()].sort(), goals.map(([id]) => id).sort());
      for (const [id] of goals) {
        const single = await app.fastify.inject({
          method: "GET",
          url: `/workspaces/${workspaceId}/categories/${id}/goal?month=2026-09`,
          headers: auth(),
        });
        assert.equal(single.statusCode, 200);
        assert.deepEqual(byCategory.get(id), single.json());
      }
    });

    it("rejects a request with no month", async () => {
      assert.equal((await list(undefined)).statusCode, 400);
    });

    it("rejects a malformed month", async () => {
      const response = await list("2026-13");
      assert.equal(response.statusCode, 400);
    });

    it("lets a read_only member read the goals", async () => {
      const readOnlyWorkspace = await addWorkspace("read_only");
      const category = await addCategory(readOnlyWorkspace, "Shared");
      await superuserPool.query("INSERT INTO goals (workspace_id, category_id, kind, amount_cents) VALUES ($1, $2, 'monthly', 5000)", [
        readOnlyWorkspace,
        category,
      ]);
      const response = await list("2026-09", readOnlyWorkspace);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(
        response.json().goals.map((p: { goal: { categoryId: string }; asks: number }) => [p.goal.categoryId, p.asks]),
        [[category, 5000]],
      );
    });

    it("never shows another workspace's goals", async () => {
      const foreign = await addWorkspace();
      const category = await addCategory(foreign, "Theirs");
      await superuserPool.query("INSERT INTO goals (workspace_id, category_id, kind, amount_cents) VALUES ($1, $2, 'monthly', 5000)", [
        foreign,
        category,
      ]);

      const mine = await list("2026-09");
      assert.equal(mine.statusCode, 200);
      assert.equal(
        mine.json().goals.some((p: { goal: { categoryId: string } }) => p.goal.categoryId === category),
        false,
      );
      const theirs = await list("2026-09", foreign);
      assert.ok(theirs.statusCode === 403 || theirs.statusCode === 404, `expected 403 or 404, got ${theirs.statusCode}`);
    });
  });
});
