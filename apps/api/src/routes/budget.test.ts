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

describe("budget routes", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let accountId: string;
  let categoryId: string;
  let token: string;

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

    token = await realm.getUserToken();
    await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/budget-months/2026-09`,
      headers: { authorization: `Bearer ${token}` },
    });
    const subject = decodeJwt(token).sub;
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [
      subject,
    ]);
    const userId = rows[0]?.id;
    assert.ok(userId, "expected the user mapper to have created a local user for this token's subject");
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [
      userId,
      workspaceId,
    ]);
  });

  after(async () => {
    await app.close();
    await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await realm.teardown();
    await superuserPool.end();
  });

  it("rejects a request with no token", async () => {
    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/budget-months/2026-09`,
    });
    assert.equal(response.statusCode, 401);
  });

  it("computes the budget month from income, an assignment and a categorized transaction", async () => {
    const auth = { authorization: `Bearer ${token}` };

    await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-09-01", splits: [{ categoryId: null, amountCents: 100_000 }] },
    });
    await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignments`,
      headers: auth,
      payload: {
        entries: [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 40_000 }],
      },
    });
    await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-09-10", splits: [{ categoryId, amountCents: -10_000 }] },
    });

    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/budget-months/2026-09`,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.unassigned, 60_000);
    const groceries = body.categories.find((c: { categoryId: string }) => c.categoryId === categoryId);
    assert.equal(groceries.name, "Groceries");
    assert.equal(groceries.available, 30_000);
  });

  it("rejects an invalid month with a translatable error", async () => {
    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/budget-months/not-a-month`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_month");
  });

  it("lists unassigned money as a problem, and does not flag a category that is not overspent", async () => {
    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/budget-months/2026-09/problems`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200);
    const problems = response.json().problems as Array<{ kind: string; categoryId?: string }>;
    assert.ok(problems.some((p) => p.kind === "unassigned_money"));
    assert.ok(!problems.some((p) => p.categoryId === categoryId));
  });

  it("lists an overspent category as a problem", async () => {
    const auth = { authorization: `Bearer ${token}` };
    await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-09-15", splits: [{ categoryId, amountCents: -50_000 }] },
    });

    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/budget-months/2026-09/problems`,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    const problems = response.json().problems as Array<{ kind: string; categoryId?: string; amountCents: number }>;
    const problem = problems.find((p) => p.categoryId === categoryId);
    assert.equal(problem?.kind, "overspent_category");
    assert.equal(problem?.amountCents, 20_000); // 40000 assigned - 10000 - 50000 spent = -20000 available
  });

  describe("GET /budget-months/:month/events", () => {
    const auth = () => ({ authorization: `Bearer ${token}` });

    it("returns a recorded transaction's own event, with its category and signed amount", async () => {
      await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
        headers: auth(),
        payload: { occurredAt: "2026-10-05", status: "cleared", splits: [{ categoryId, amountCents: -1_200 }] },
      });

      const response = await app.fastify.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/budget-months/2026-10/events`,
        headers: auth(),
      });
      assert.equal(response.statusCode, 200);
      const events = response.json().events as Array<{ date: string; amountCents: number; categoryId: string | null; kind: string }>;
      const event = events.find((e) => e.categoryId === categoryId && e.amountCents === -1_200);
      assert.ok(event, "expected the recorded transaction's own event");
      assert.equal(event?.date, "2026-10-05");
      assert.equal(event?.kind, "recorded");
    });

    it("marks a pending transaction's event as pending, not recorded", async () => {
      await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
        headers: auth(),
        payload: { occurredAt: "2026-10-06", status: "pending", splits: [{ categoryId, amountCents: -300 }] },
      });

      const response = await app.fastify.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/budget-months/2026-10/events`,
        headers: auth(),
      });
      const events = response.json().events as Array<{ amountCents: number; kind: string }>;
      const event = events.find((e) => e.amountCents === -300);
      assert.equal(event?.kind, "pending");
    });

    it("produces one event per split for a split transaction", async () => {
      const otherCategory = await superuserPool.query<{ id: string }>(
        "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, (SELECT group_id FROM categories WHERE id = $2), 'Fuel', 2) RETURNING id",
        [workspaceId, categoryId],
      );
      const otherCategoryId = otherCategory.rows[0]!.id;

      await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
        headers: auth(),
        payload: {
          occurredAt: "2026-10-07",
          splits: [
            { categoryId, amountCents: -111 },
            { categoryId: otherCategoryId, amountCents: -222 },
          ],
        },
      });

      const response = await app.fastify.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/budget-months/2026-10/events`,
        headers: auth(),
      });
      const events = response.json().events as Array<{ amountCents: number; categoryId: string | null }>;
      assert.ok(events.some((e) => e.categoryId === categoryId && e.amountCents === -111));
      assert.ok(events.some((e) => e.categoryId === otherCategoryId && e.amountCents === -222));
    });

    it("returns a scheduled transaction's own event, with its scheduledTransactionId and a negative amount", async () => {
      await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/scheduled-transactions`,
        headers: auth(),
        payload: {
          accountId,
          payee: "Boiler service",
          nextDueDate: "2026-10-20",
          recurEvery: 1,
          recurUnit: "month",
          splits: [{ categoryId, amountCents: 9_000 }],
        },
      });

      const response = await app.fastify.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/budget-months/2026-10/events`,
        headers: auth(),
      });
      const events = response.json().events as Array<{
        date: string;
        amountCents: number;
        payee: string | null;
        kind: string;
        scheduledTransactionId?: string;
      }>;
      const event = events.find((e) => e.payee === "Boiler service");
      assert.ok(event, "expected the scheduled transaction's own event");
      assert.equal(event?.date, "2026-10-20");
      assert.equal(event?.amountCents, -9_000);
      assert.equal(event?.kind, "scheduled");
      assert.ok(event?.scheduledTransactionId);
    });

    it("the accountId filter restricts events to that one account", async () => {
      const otherAccount = await superuserPool.query<{ id: string }>(
        "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Cash', 'cash', 'EUR') RETURNING id",
        [workspaceId],
      );
      const otherAccountId = otherAccount.rows[0]!.id;
      await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts/${otherAccountId}/transactions`,
        headers: auth(),
        payload: { occurredAt: "2026-10-08", splits: [{ categoryId, amountCents: -400 }] },
      });

      const response = await app.fastify.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/budget-months/2026-10/events?accountId=${otherAccountId}`,
        headers: auth(),
      });
      const events = response.json().events as Array<{ amountCents: number }>;
      assert.ok(events.some((e) => e.amountCents === -400));
      assert.ok(!events.some((e) => e.amountCents === -1_200)); // the first test's own event, on accountId instead
    });

    it("a transfer between two on-budget cash accounts is invisible workspace-wide, but shows (signed) filtered to either account", async () => {
      const savings = await superuserPool.query<{ id: string }>(
        "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Savings', 'savings', 'EUR') RETURNING id",
        [workspaceId],
      );
      const savingsId = savings.rows[0]!.id;
      await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/transfers`,
        headers: auth(),
        payload: { sourceAccountId: accountId, destinationAccountId: savingsId, occurredAt: "2026-10-09", amountCents: 5_000 },
      });

      const workspaceWide = await app.fastify.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/budget-months/2026-10/events`,
        headers: auth(),
      });
      const wideEvents = workspaceWide.json().events as Array<{ amountCents: number }>;
      assert.ok(!wideEvents.some((e) => Math.abs(e.amountCents) === 5_000), "a cash-to-cash transfer must not appear workspace-wide");

      const fromSource = await app.fastify.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/budget-months/2026-10/events?accountId=${accountId}`,
        headers: auth(),
      });
      assert.ok((fromSource.json().events as Array<{ amountCents: number }>).some((e) => e.amountCents === -5_000));

      const fromDestination = await app.fastify.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/budget-months/2026-10/events?accountId=${savingsId}`,
        headers: auth(),
      });
      assert.ok((fromDestination.json().events as Array<{ amountCents: number }>).some((e) => e.amountCents === 5_000));
    });

    it("a transfer to an off-budget account only shows the on-budget leg workspace-wide", async () => {
      const offBudget = await superuserPool.query<{ id: string }>(
        "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Brokerage', 'savings', 'EUR', false) RETURNING id",
        [workspaceId],
      );
      const offBudgetId = offBudget.rows[0]!.id;
      await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/transfers`,
        headers: auth(),
        payload: { sourceAccountId: accountId, destinationAccountId: offBudgetId, occurredAt: "2026-10-10", amountCents: 6_000 },
      });

      const response = await app.fastify.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/budget-months/2026-10/events`,
        headers: auth(),
      });
      const events = response.json().events as Array<{ amountCents: number }>;
      assert.ok(events.some((e) => e.amountCents === -6_000), "the on-budget (source) leg must still show");
      assert.ok(!events.some((e) => e.amountCents === 6_000), "the off-budget (destination) leg must not show");
    });

    it("a transfer to a credit card only shows the cash leg workspace-wide", async () => {
      const card = await superuserPool.query<{ id: string }>(
        "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Visa', 'credit_card', 'EUR') RETURNING id",
        [workspaceId],
      );
      const cardId = card.rows[0]!.id;
      await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/transfers`,
        headers: auth(),
        payload: { sourceAccountId: accountId, destinationAccountId: cardId, occurredAt: "2026-10-11", amountCents: 7_000 },
      });

      const response = await app.fastify.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/budget-months/2026-10/events`,
        headers: auth(),
      });
      const events = response.json().events as Array<{ amountCents: number }>;
      assert.ok(events.some((e) => e.amountCents === -7_000), "the cash (source) leg must still show");
      assert.ok(!events.some((e) => e.amountCents === 7_000), "the card's own leg must not show");
    });

    it("a credit card's own 'Starting balance' transaction produces no event, with or without accountId", async () => {
      const created = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts`,
        headers: auth(),
        payload: { name: "Amex", type: "credit_card", currency: "EUR", onBudget: true, startingBalanceCents: -84_500 },
      });
      const cardId = created.json().id as string;

      const workspaceWide = await app.fastify.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/budget-months/2026-10/events`,
        headers: auth(),
      });
      const perAccount = await app.fastify.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/budget-months/2026-10/events?accountId=${cardId}`,
        headers: auth(),
      });
      for (const response of [workspaceWide, perAccount]) {
        const events = response.json().events as Array<{ amountCents: number }>;
        assert.ok(!events.some((e) => e.amountCents === -84_500 || e.amountCents === 84_500), "the starting balance must never become an event");
      }
    });

    it("a cash account's own income still produces an event, even though it is also a single, categoryless split", async () => {
      await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
        headers: auth(),
        payload: { occurredAt: "2026-10-12", splits: [{ categoryId: null, amountCents: 50_000 }] },
      });

      const response = await app.fastify.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/budget-months/2026-10/events`,
        headers: auth(),
      });
      const events = response.json().events as Array<{ amountCents: number; categoryId: string | null }>;
      assert.ok(events.some((e) => e.amountCents === 50_000 && e.categoryId === null), "a cash account's own income is a real event, unlike a card's starting balance");
    });
  });
});
