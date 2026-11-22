import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { requireIntegrationTestEnv, setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

requireIntegrationTestEnv();

interface Split {
  readonly id: string;
  readonly categoryId: string | null;
  readonly amountCents: number;
  readonly memo: string | null;
}

interface Transaction {
  readonly id: string;
  readonly accountId: string;
  readonly occurredAt: string;
  readonly budgetDate: string;
  readonly payee: string | null;
  readonly memo: string | null;
  readonly status: string;
  readonly splits: readonly Split[];
}

interface ErrorBody {
  readonly error: string;
  readonly details?: Record<string, unknown>;
}

/**
 * `PATCH .../transactions/:transactionId` refuses what it used to drop without a word, takes a new
 * amount alone and a new date, and the create routes refuse a date that does not exist (#655).
 * The workspace is in Pacific/Auckland, 13 hours ahead of UTC in October, so a date anchored to
 * UTC instead of the workspace's time zone would show up.
 */
describe("editing a transaction: strict body, amount and date (#655)", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let token: string;
  let checkingId: string;
  let savingsId: string;
  let groceriesId: string;
  let homeId: string;

  async function request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, payload?: unknown): Promise<{ status: number; body: T }> {
    const response = await app.fastify.inject({
      method,
      url: `/workspaces/${workspaceId}${path}`,
      headers: { authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    return { status: response.statusCode, body: response.body === "" ? (undefined as T) : (response.json() as T) };
  }

  async function create(accountId: string, payload: Record<string, unknown>): Promise<Transaction> {
    const created = await request<Transaction>("POST", `/accounts/${accountId}/transactions`, payload);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body;
  }

  async function reread(transaction: Transaction): Promise<Transaction | undefined> {
    const listed = await request<{ transactions: Transaction[] }>("GET", `/accounts/${transaction.accountId}/transactions`);
    return listed.body.transactions.find((t) => t.id === transaction.id);
  }

  async function count(): Promise<number> {
    const { rows } = await superuserPool.query<{ n: number }>("SELECT count(*)::int AS n FROM transactions WHERE workspace_id = $1", [workspaceId]);
    return rows[0]!.n;
  }

  function patch(transaction: Transaction, payload: unknown, accountId = transaction.accountId) {
    return request<Transaction & ErrorBody>("PATCH", `/accounts/${accountId}/transactions/${transaction.id}`, payload);
  }

  /** Sends an edit, checks it was refused with `status` and `error`, and that the transaction did not change. */
  async function assertRefused(transaction: Transaction, payload: unknown, status: number, error: string): Promise<ErrorBody> {
    const before = await reread(transaction);
    const refused = await patch(transaction, payload);
    assert.equal(refused.status, status, `${JSON.stringify(payload)}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error, error, JSON.stringify(payload));
    assert.deepEqual(await reread(transaction), before);
    return refused.body;
  }

  before(async () => {
    ({ superuserPool, realm, app, workspaceId, token } = await setupIntegrationTest());
    await superuserPool.query("UPDATE workspaces SET time_zone = 'Pacific/Auckland' WHERE id = $1", [workspaceId]);
    const accounts = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR'), ($1, 'Savings', 'savings', 'EUR') RETURNING id",
      [workspaceId],
    );
    checkingId = accounts.rows[0]!.id;
    savingsId = accounts.rows[1]!.id;
    const group = await superuserPool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspaceId],
    );
    const categories = await superuserPool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1), ($1, $2, 'Home', 2) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    groceriesId = categories.rows[0]!.id;
    homeId = categories.rows[1]!.id;
  });

  after(async () => {
    await teardownIntegrationTest({ superuserPool, realm, app, workspaceId, token });
  });

  describe("a strict body", () => {
    let transaction: Transaction;

    before(async () => {
      transaction = await create(checkingId, { occurredAt: "2026-10-05", payee: "Market", splits: [{ categoryId: groceriesId, amountCents: -2_500 }] });
    });

    it("refuses an unknown or misspelt field with unknown_field, naming it", async () => {
      for (const field of ["foo", "Payee", "category"]) {
        const body = await assertRefused(transaction, { payee: "Other", [field]: "x" }, 400, "unknown_field");
        assert.deepEqual(body.details, { field });
      }
    });

    it("refuses a field the edit cannot change with unknown_field, naming it", async () => {
      for (const [field, value] of [
        ["accountId", savingsId],
        ["id", transaction.id],
        ["transferId", null],
        ["tradeId", null],
        ["budgetDate", "2026-10-06"],
        ["workspaceId", workspaceId],
        ["externalId", "abc"],
      ] as const) {
        const body = await assertRefused(transaction, { [field]: value }, 400, "unknown_field");
        assert.deepEqual(body.details, { field });
      }
    });

    it("refuses a status that is none of the three, and a field of the wrong type, with invalid_field", async () => {
      for (const [field, value] of [
        ["status", "done"],
        ["status", null],
        ["status", 1],
        ["payee", 42],
        ["payee", null],
        ["memo", ["note"]],
        ["amountCents", "100"],
        ["amountCents", null],
        ["occurredAt", 20261006],
      ] as const) {
        const body = await assertRefused(transaction, { [field]: value }, 400, "invalid_field");
        assert.deepEqual(body.details, { field });
      }
    });

    it("refuses a body that is not a JSON object with invalid_body", async () => {
      for (const payload of [[], ["payee"], null, "payee", 7]) {
        await assertRefused(transaction, payload, 400, "invalid_body");
      }
    });

    it("still takes every field it knows", async () => {
      const edited = await patch(transaction, { payee: "Corner shop", memo: "Bread", status: "cleared" });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.equal(edited.body.payee, "Corner shop");
      assert.equal(edited.body.memo, "Bread");
      assert.equal(edited.body.status, "cleared");
    });
  });

  describe("the account in the path", () => {
    it("answers 404 to an edit or a delete through an account that does not hold the transaction, changing nothing", async () => {
      const transaction = await create(checkingId, { occurredAt: "2026-10-05", splits: [{ categoryId: groceriesId, amountCents: -700 }] });
      const before = await reread(transaction);

      const edited = await patch(transaction, { memo: "Wrong account" }, savingsId);
      assert.equal(edited.status, 404, JSON.stringify(edited.body));
      const deleted = await request("DELETE", `/accounts/${savingsId}/transactions/${transaction.id}`);
      assert.equal(deleted.status, 404);
      assert.deepEqual(await reread(transaction), before);
    });

    it("answers 404 through an account that does not hold the transaction before refusing an unknown category", async () => {
      const transaction = await create(checkingId, { occurredAt: "2026-10-05", splits: [{ categoryId: groceriesId, amountCents: -700 }] });
      const before = await reread(transaction);

      const edited = await patch(transaction, { splits: [{ categoryId: "00000000-0000-4000-8000-000000000655", amountCents: -700 }] }, savingsId);
      assert.equal(edited.status, 404, JSON.stringify(edited.body));
      assert.deepEqual(await reread(transaction), before);
    });
  });

  describe("an unknown category", () => {
    const unknown = "00000000-0000-4000-8000-000000000655";

    it("is refused with 400 naming it, through the transaction's own open account", async () => {
      const transaction = await create(checkingId, { occurredAt: "2026-10-05", splits: [{ categoryId: groceriesId, amountCents: -700 }] });
      for (const categoryId of [unknown, "not-a-uuid"]) {
        const refused = await assertRefused(transaction, { splits: [{ categoryId, amountCents: -700 }] }, 400, `categoryId "${categoryId}" does not name a category of this workspace`);
        assert.equal(refused.details, undefined);
      }
    });

    it("answers account_closed first on a closed account's transaction", async () => {
      const { rows } = await superuserPool.query<{ id: string }>(
        "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Closed 655', 'checking', 'EUR') RETURNING id",
        [workspaceId],
      );
      const transaction = await create(rows[0]!.id, { occurredAt: "2026-10-05", splits: [{ categoryId: groceriesId, amountCents: -700 }] });
      await superuserPool.query("UPDATE accounts SET closed_at = now() WHERE id = $1", [rows[0]!.id]);

      await assertRefused(transaction, { splits: [{ categoryId: unknown, amountCents: -700 }] }, 409, "account_closed");
    });
  });

  describe("a new amount alone", () => {
    it("rewrites the one split of a transaction in place, keeping its category and memo", async () => {
      const transaction = await create(checkingId, {
        occurredAt: "2026-10-05",
        splits: [{ categoryId: groceriesId, amountCents: -1_000, memo: "Fruit" }],
      });

      const edited = await patch(transaction, { amountCents: -1_234 });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.deepEqual(edited.body.splits, [{ ...transaction.splits[0]!, amountCents: -1_234 }]);
    });

    it("takes a zero amount and a large one, as a new split would", async () => {
      const transaction = await create(checkingId, { occurredAt: "2026-10-05", splits: [{ categoryId: groceriesId, amountCents: -1 }] });
      for (const amountCents of [0, -999_999_999_99]) {
        const edited = await patch(transaction, { amountCents });
        assert.equal(edited.status, 200, JSON.stringify(edited.body));
        assert.equal(edited.body.splits[0]!.amountCents, amountCents);
      }
    });

    it("refuses an amount that is not a whole number of cents, or is beyond the cap, changing nothing", async () => {
      const transaction = await create(checkingId, { occurredAt: "2026-10-05", splits: [{ categoryId: groceriesId, amountCents: -1 }] });
      await assertRefused(transaction, { amountCents: -10.5 }, 400, "invalid_amount");
      await assertRefused(transaction, { amountCents: -1_000_000_000_001 }, 400, "amount_too_large");
    });

    it("refuses a new amount alone on a transaction with several splits with amount_needs_splits", async () => {
      const transaction = await create(checkingId, {
        occurredAt: "2026-10-05",
        splits: [
          { categoryId: groceriesId, amountCents: -1_000 },
          { categoryId: homeId, amountCents: -500 },
        ],
      });
      const body = await assertRefused(transaction, { amountCents: -2_000 }, 400, "amount_needs_splits");
      assert.deepEqual(body.details, { splitCount: 2 });

      const withSplits = await patch(transaction, {
        amountCents: -2_000,
        splits: [
          { categoryId: groceriesId, amountCents: -1_500 },
          { categoryId: homeId, amountCents: -500 },
        ],
      });
      assert.equal(withSplits.status, 200, JSON.stringify(withSplits.body));
    });
  });

  describe("a new date", () => {
    it("moves the transaction to midnight of the new date in the workspace's time zone, into another budget month", async () => {
      const transaction = await create(checkingId, { occurredAt: "2026-09-29", splits: [{ categoryId: groceriesId, amountCents: -800 }] });

      const edited = await patch(transaction, { occurredAt: "2026-10-01" });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.equal(edited.body.budgetDate, "2026-10-01");
      // Midnight in Auckland (UTC+13 from 27 September 2026) is 11:00 UTC the day before.
      assert.equal(edited.body.occurredAt, "2026-09-30T11:00:00.000Z");
      assert.deepEqual(edited.body.splits, transaction.splits);

      const september = await request<{ activity?: number; categories: { categoryId: string; activity: number }[] }>("GET", "/budget-months/2026-09");
      const october = await request<{ categories: { categoryId: string; activity: number }[] }>("GET", "/budget-months/2026-10");
      assert.equal(september.status, 200, JSON.stringify(september.body));
      assert.equal(october.status, 200, JSON.stringify(october.body));
      const activity = (month: { categories: { categoryId: string; activity: number }[] }) =>
        month.categories.find((c) => c.categoryId === groceriesId)?.activity;
      assert.equal(activity(september.body) ?? 0, 0);
      assert.ok((activity(october.body) ?? 0) <= -800, "the October activity holds the moved transaction");
    });

    it("refuses a date that does not exist, or is not written YYYY-MM-DD, with invalid_date", async () => {
      const transaction = await create(checkingId, { occurredAt: "2026-10-05", splits: [{ categoryId: groceriesId, amountCents: -1 }] });
      for (const occurredAt of ["2026-02-30", "2026-13-45", "2026-02-29", "not-a-date", "2026-1-5", "2026-10-05T10:00:00Z", ""]) {
        await assertRefused(transaction, { occurredAt }, 400, "invalid_date");
      }
    });
  });

  describe("a new transaction or transfer with a date that does not exist (#655)", () => {
    it("is refused with invalid_date, storing nothing", async () => {
      const before = await count();
      for (const occurredAt of ["2026-02-30", "2026-13-45", "2026-02-29", "not-a-date", "2026-1-5"]) {
        const transaction = await request<ErrorBody>("POST", `/accounts/${checkingId}/transactions`, {
          occurredAt,
          splits: [{ categoryId: groceriesId, amountCents: -100 }],
        });
        assert.equal(transaction.status, 400, `${occurredAt}: ${JSON.stringify(transaction.body)}`);
        assert.equal(transaction.body.error, "invalid_date");
        assert.deepEqual(transaction.body.details, { value: occurredAt });

        const transfer = await request<ErrorBody>("POST", "/transfers", {
          sourceAccountId: checkingId,
          destinationAccountId: savingsId,
          occurredAt,
          amountCents: 100,
        });
        assert.equal(transfer.status, 400, `${occurredAt}: ${JSON.stringify(transfer.body)}`);
        assert.equal(transfer.body.error, "invalid_date");
      }
      assert.equal(await count(), before);
    });

    it("still takes a leap day that exists, and an instant with an offset on a real date", async () => {
      await create(checkingId, { occurredAt: "2028-02-29", splits: [{ categoryId: groceriesId, amountCents: -100 }] });
      const instant = await create(checkingId, { occurredAt: "2026-10-05T10:30:00+13:00", splits: [{ categoryId: groceriesId, amountCents: -100 }] });
      assert.equal(instant.budgetDate, "2026-10-05");
    });

    it("refuses an instant on a date that does not exist, or at a time that does not exist, with invalid_date", async () => {
      const before = await count();
      for (const occurredAt of ["2026-02-30T10:00:00Z", "2026-10-05T25:00:00Z", "2026-1-5T10:00:00Z", "2026-10-05 10:00"]) {
        const refused = await request<ErrorBody>("POST", `/accounts/${checkingId}/transactions`, {
          occurredAt,
          splits: [{ categoryId: groceriesId, amountCents: -100 }],
        });
        assert.equal(refused.status, 400, `${occurredAt}: ${JSON.stringify(refused.body)}`);
        assert.equal(refused.body.error, "invalid_date", occurredAt);
      }
      assert.equal(await count(), before);
    });
  });
});
