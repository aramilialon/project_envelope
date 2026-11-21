import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { MAX_FREE_TEXT_LENGTH } from "@envelope/core";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

describe("transactions routes", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let accountId: string;
  let savingsAccountId: string;
  let offBudgetAccountId: string;
  let categoryId: string;
  let token: string;

  before(async () => {
    ({ superuserPool, realm, app, workspaceId, token } = await setupIntegrationTest());

    const account = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspaceId],
    );
    accountId = account.rows[0]!.id;
    const savingsAccount = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Savings', 'savings', 'EUR') RETURNING id",
      [workspaceId],
    );
    savingsAccountId = savingsAccount.rows[0]!.id;
    const offBudgetAccount = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Brokerage', 'savings', 'EUR', false) RETURNING id",
      [workspaceId],
    );
    offBudgetAccountId = offBudgetAccount.rows[0]!.id;
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
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
    });
    assert.equal(response.statusCode, 401);
  });

  it("creates, lists and updates a transaction", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-09-20", payee: "Grocery store", splits: [{ categoryId, amountCents: -4200 }] },
    });
    assert.equal(created.statusCode, 201);
    const transaction = created.json();
    assert.equal(transaction.budgetDate, "2026-09-20");

    const listed = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: auth,
    });
    assert.equal(listed.statusCode, 200);
    assert.ok(listed.json().transactions.some((t: { id: string }) => t.id === transaction.id));

    const updated = await app.fastify.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions/${transaction.id}`,
      headers: auth,
      payload: { status: "cleared" },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().status, "cleared");
  });

  it("rejects an empty splits array with a translatable error, never a raw message", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { occurredAt: "2026-09-20", splits: [] },
    });
    assert.equal(response.statusCode, 400);
  });

  it("rejects splits that do not add up to the declared total", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { occurredAt: "2026-09-20", amountCents: -1000, splits: [{ categoryId, amountCents: -900 }] },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "split_mismatch");
  });

  it("rejects a split naming an unknown category, instead of a raw 500", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { occurredAt: "2026-09-20", splits: [{ categoryId: randomUUID(), amountCents: -100 }] },
    });
    assert.equal(response.statusCode, 400);
  });

  it("refuses to update a reconciled transaction", async () => {
    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { occurredAt: "2026-09-20", status: "reconciled", splits: [{ categoryId, amountCents: -100 }] },
    });
    const transaction = created.json();

    const response = await app.fastify.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions/${transaction.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { payee: "Too late" },
    });
    assert.equal(response.statusCode, 409);
  });

  it("updating an unknown transaction is a 404", async () => {
    const response = await app.fastify.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions/${randomUUID()}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { payee: "Nobody" },
    });
    assert.equal(response.statusCode, 404);
  });

  it("creates a transfer, visible from both accounts' own transaction list", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/transfers`,
      headers: auth,
      payload: {
        sourceAccountId: accountId,
        destinationAccountId: savingsAccountId,
        occurredAt: "2026-09-21",
        amountCents: 3000,
      },
    });
    assert.equal(created.statusCode, 201);
    const transfer = created.json();
    assert.equal(transfer.source.transferId, transfer.destination.id);

    const sourceList = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: auth,
    });
    assert.ok(sourceList.json().transactions.some((t: { id: string }) => t.id === transfer.source.id));

    const destinationList = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts/${savingsAccountId}/transactions`,
      headers: auth,
    });
    assert.ok(destinationList.json().transactions.some((t: { id: string }) => t.id === transfer.destination.id));
  });

  it("names the account of a transfer's other leg on each leg, and null on a plain transaction (#599)", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/transfers`,
      headers: auth,
      payload: { sourceAccountId: accountId, destinationAccountId: savingsAccountId, occurredAt: "2026-09-22", amountCents: 1200 },
    });
    assert.equal(created.statusCode, 201);
    const transfer = created.json();
    assert.equal(transfer.source.transferAccountId, savingsAccountId);
    assert.equal(transfer.destination.transferAccountId, accountId);

    type Listed = { id: string; transferAccountId: string | null; transferId: string | null };
    const sourceList = await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`, headers: auth });
    const listed: Listed[] = sourceList.json().transactions;
    assert.equal(listed.find((t) => t.id === transfer.source.id)?.transferAccountId, savingsAccountId);
    for (const t of listed.filter((t) => t.transferId === null)) {
      assert.equal(t.transferAccountId, null);
    }
    const destinationList = await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/accounts/${savingsAccountId}/transactions`, headers: auth });
    assert.equal((destinationList.json().transactions as Listed[]).find((t) => t.id === transfer.destination.id)?.transferAccountId, accountId);
  });

  it("rejects a transfer to the same account with a translatable error", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/transfers`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        sourceAccountId: accountId,
        destinationAccountId: accountId,
        occurredAt: "2026-09-21",
        amountCents: 1000,
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "duplicate_account");
  });

  it("refuses a transfer between accounts in different currencies, storing nothing (#652)", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const dollars = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'US broker', 'brokerage', 'USD', false) RETURNING id",
      [workspaceId],
    );
    const dollarAccountId = dollars.rows[0]!.id;
    const stored = await superuserPool.query("SELECT 1 FROM transactions WHERE workspace_id = $1", [workspaceId]);

    for (const [sourceAccountId, destinationAccountId] of [
      [accountId, dollarAccountId],
      [dollarAccountId, accountId],
      [offBudgetAccountId, dollarAccountId],
    ]) {
      const response = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/transfers`,
        headers: auth,
        payload: { sourceAccountId, destinationAccountId, occurredAt: "2026-09-21", amountCents: 100_000, categoryId },
      });
      assert.equal(response.statusCode, 400);
      const sourceCurrency = sourceAccountId === dollarAccountId ? "USD" : "EUR";
      const destinationCurrency = destinationAccountId === dollarAccountId ? "USD" : "EUR";
      assert.deepEqual(response.json(), { error: "currency_mismatch", details: { sourceCurrency, destinationCurrency } });
    }

    const storedAfter = await superuserPool.query("SELECT 1 FROM transactions WHERE workspace_id = $1", [workspaceId]);
    assert.equal(storedAfter.rowCount, stored.rowCount);
  });

  it("creates a transfer to an off-budget account with a category on the on-budget leg (#378)", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/transfers`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        sourceAccountId: accountId,
        destinationAccountId: offBudgetAccountId,
        occurredAt: "2026-09-21",
        amountCents: 2000,
        categoryId,
      },
    });
    assert.equal(response.statusCode, 201);
    const transfer = response.json();
    assert.equal(transfer.source.splits[0].categoryId, categoryId);
    assert.equal(transfer.destination.splits[0].categoryId, null);
  });

  it("rejects a transfer to an off-budget account with no category, with a translatable error (#378)", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/transfers`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        sourceAccountId: accountId,
        destinationAccountId: offBudgetAccountId,
        occurredAt: "2026-09-21",
        amountCents: 1000,
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "uncategorized_transaction");
  });

  it("rejects a transfer naming an unknown categoryId (#378)", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/transfers`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        sourceAccountId: accountId,
        destinationAccountId: offBudgetAccountId,
        occurredAt: "2026-09-21",
        amountCents: 1000,
        categoryId: randomUUID(),
      },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /does not name a category of this workspace/);
  });

  it("deletes a transaction (#403)", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-09-22", payee: "To delete", splits: [{ categoryId, amountCents: -500 }] },
    });
    const transaction = created.json();

    const deleted = await app.fastify.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions/${transaction.id}`,
      headers: auth,
    });
    assert.equal(deleted.statusCode, 204);

    const listed = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: auth,
    });
    assert.ok(!listed.json().transactions.some((t: { id: string }) => t.id === transaction.id));
  });

  it("deletes both legs of a transfer together, never just one (#403)", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/transfers`,
      headers: auth,
      payload: { sourceAccountId: accountId, destinationAccountId: savingsAccountId, occurredAt: "2026-09-22", amountCents: 1500 },
    });
    const transfer = created.json();

    const deleted = await app.fastify.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions/${transfer.source.id}`,
      headers: auth,
    });
    assert.equal(deleted.statusCode, 204);

    const destinationList = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts/${savingsAccountId}/transactions`,
      headers: auth,
    });
    assert.ok(!destinationList.json().transactions.some((t: { id: string }) => t.id === transfer.destination.id));
  });

  it("refuses to delete a reconciled transaction (#403)", async () => {
    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { occurredAt: "2026-09-22", status: "reconciled", splits: [{ categoryId, amountCents: -100 }] },
    });
    const transaction = created.json();

    const response = await app.fastify.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions/${transaction.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 409);
  });

  it("refuses to delete a transfer when its other leg is reconciled, even though the requested leg itself is not (#403)", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/transfers`,
      headers: auth,
      payload: { sourceAccountId: accountId, destinationAccountId: savingsAccountId, occurredAt: "2026-09-22", amountCents: 750 },
    });
    const transfer = created.json();
    await superuserPool.query("UPDATE transactions SET status = 'reconciled' WHERE id = $1", [transfer.destination.id]);

    const response = await app.fastify.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions/${transfer.source.id}`,
      headers: auth,
    });
    assert.equal(response.statusCode, 409);
  });

  it("deleting an unknown transaction is a 404 (#403)", async () => {
    const response = await app.fastify.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions/${randomUUID()}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 404);
  });

  describe("free-text length limit (#507)", () => {
    const auth = () => ({ authorization: `Bearer ${token}` });
    const atLimit = "m".repeat(MAX_FREE_TEXT_LENGTH);
    const tooLong = "m".repeat(MAX_FREE_TEXT_LENGTH + 1);
    const expected = (field: string) => ({ error: "text_too_long", details: { field, max: MAX_FREE_TEXT_LENGTH } });

    it("accepts a payee, memo and split memo at the limit, and rejects each one character over it", async () => {
      const url = `/workspaces/${workspaceId}/accounts/${accountId}/transactions`;
      const accepted = await app.fastify.inject({
        method: "POST",
        url,
        headers: auth(),
        payload: { occurredAt: "2026-09-21", payee: atLimit, memo: atLimit, splits: [{ categoryId, amountCents: -100, memo: atLimit }] },
      });
      assert.equal(accepted.statusCode, 201);
      const transactionId = accepted.json().id;

      for (const [payload, field] of [
        [{ payee: tooLong }, "payee"],
        [{ memo: tooLong }, "memo"],
        [{ splits: [{ categoryId, amountCents: -100 }, { categoryId, amountCents: -100, memo: tooLong }] }, "splits[1].memo"],
      ] as const) {
        const created = await app.fastify.inject({
          method: "POST",
          url,
          headers: auth(),
          payload: { occurredAt: "2026-09-21", splits: [{ categoryId, amountCents: -100 }], ...payload },
        });
        assert.equal(created.statusCode, 400, field);
        assert.deepEqual(created.json(), expected(field));

        const updated = await app.fastify.inject({ method: "PATCH", url: `${url}/${transactionId}`, headers: auth(), payload });
        assert.equal(updated.statusCode, 400, field);
        assert.deepEqual(updated.json(), expected(field));
      }

      // None of the rejected updates touched the stored row.
      const stored = await superuserPool.query<{ payee: string; memo: string }>("SELECT payee, memo FROM transactions WHERE id = $1", [
        transactionId,
      ]);
      assert.deepEqual(stored.rows[0], { payee: atLimit, memo: atLimit });
      const storedSplits = await superuserPool.query<{ memo: string }>("SELECT memo FROM splits WHERE transaction_id = $1", [transactionId]);
      assert.deepEqual(storedSplits.rows, [{ memo: atLimit }]);

      const updatedAtLimit = await app.fastify.inject({
        method: "PATCH",
        url: `${url}/${transactionId}`,
        headers: auth(),
        payload: { memo: "n".repeat(MAX_FREE_TEXT_LENGTH) },
      });
      assert.equal(updatedAtLimit.statusCode, 200);
    });

    it("accepts a transfer payee and memo at the limit, and rejects each one character over it", async () => {
      const transfer = (text: Record<string, string>) =>
        app.fastify.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/transfers`,
          headers: auth(),
          payload: { sourceAccountId: accountId, destinationAccountId: savingsAccountId, occurredAt: "2026-09-21", amountCents: 100, ...text },
        });

      const accepted = await transfer({ payee: atLimit, memo: atLimit });
      assert.equal(accepted.statusCode, 201);

      for (const field of ["payee", "memo"] as const) {
        const response = await transfer({ [field]: tooLong });
        assert.equal(response.statusCode, 400, field);
        assert.deepEqual(response.json(), expected(field));
      }
    });
  });
});
