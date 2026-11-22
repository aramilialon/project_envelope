/**
 * A closed account takes no writes (#729, ADR 0018): every route that writes to an account's
 * transactions, splits, trades, scheduled transactions or reconciliations answers 409
 * `account_closed` once it is closed, through migration 0033's trigger and `toErrorReply`, and
 * leaves every row as it was. Imports are refused before staging; a sync change to a closed
 * account's transaction is refused alone, the rest of the upload still applying.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { type App } from "../app.ts";
import { writesToClosedAccount } from "../sync/apply.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

describe("writes to a closed account (#729)", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let token: string;
  let categoryId: string;
  const instrumentIds: string[] = [];
  /** Workspaces the test user is not a member of, removed after the run. */
  const foreignWorkspaceIds: string[] = [];
  const units = (value: number): number => Math.round(value * 1e8);
  const price = (value: number): number => Math.round(value * 1e6);

  before(async () => {
    ({ superuserPool, realm, app, workspaceId, token } = await setupIntegrationTest());
    const group = await inject("POST", "/category-groups", { name: "Home" });
    const category = await inject("POST", "/categories", { name: "Groceries", groupId: group.json().id });
    categoryId = category.json().id;
  });

  after(async () => {
    // Deleting the workspace removes its closed accounts' rows too (the trigger lets a cascade
    // through); only then can the instruments its trades referenced go.
    await superuserPool.query("DELETE FROM workspaces WHERE id = ANY($1)", [[workspaceId, ...foreignWorkspaceIds]]);
    await superuserPool.query("DELETE FROM instruments WHERE id = ANY($1)", [instrumentIds]);
    await teardownIntegrationTest({ superuserPool, realm, app, workspaceId, token });
  });

  async function inject(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, payload?: unknown) {
    return app.fastify.inject({
      method,
      url: `/workspaces/${workspaceId}${path}`,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  async function account(type: "checking" | "brokerage" = "checking"): Promise<string> {
    const response = await inject("POST", "/accounts", { name: `Account ${randomUUID().slice(0, 8)}`, type, currency: "EUR" });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().id;
  }

  async function transaction(accountId: string, occurredAt: string, amountCents: number): Promise<{ id: string; splits: { id: string }[] }> {
    const response = await inject("POST", `/accounts/${accountId}/transactions`, { occurredAt, splits: [{ categoryId, amountCents }] });
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  }

  async function close(accountId: string): Promise<void> {
    const response = await inject("PATCH", `/accounts/${accountId}/close`);
    assert.equal(response.statusCode, 200, response.body);
  }

  /** Closed without the close's own checks: a schedule refuses a close, but data from before #729 may hold one. */
  async function closeDirectly(accountId: string): Promise<void> {
    await superuserPool.query("UPDATE accounts SET closed_at = now() WHERE id = $1", [accountId]);
  }

  /** Every row of the workspace the guarded tables hold, with what a refused edit could have changed. */
  async function snapshot(): Promise<unknown> {
    const { rows } = await superuserPool.query(
      `SELECT
         (SELECT json_agg(t ORDER BY t.id) FROM (SELECT id, account_id, occurred_at, payee, memo, status, transfer_id, reconciliation_id
            FROM transactions WHERE workspace_id = $1) t) AS transactions,
         (SELECT json_agg(s ORDER BY s.id) FROM (SELECT id, transaction_id, category_id, amount_cents, memo
            FROM splits WHERE workspace_id = $1) s) AS splits,
         (SELECT json_agg(t ORDER BY t.id) FROM (SELECT id, account_id, trade_date, quantity_e8, memo
            FROM trades WHERE workspace_id = $1) t) AS trades,
         (SELECT json_agg(s ORDER BY s.id) FROM (SELECT id, account_id, payee, next_due_date
            FROM scheduled_transactions WHERE workspace_id = $1) s) AS scheduled,
         (SELECT count(*)::int FROM reconciliations WHERE workspace_id = $1) AS reconciliations,
         (SELECT count(*)::int FROM staged_transactions WHERE workspace_id = $1) AS staged`,
      [workspaceId],
    );
    return rows[0];
  }

  /** Sends a write and checks it was refused as `account_closed` with nothing changed. */
  async function assertRefused(write: () => Promise<{ statusCode: number; body: string; json: () => unknown }>): Promise<void> {
    const before = await snapshot();
    const response = await write();
    assert.equal(response.statusCode, 409, response.body);
    assert.deepEqual(response.json(), { error: "account_closed" });
    assert.deepEqual(await snapshot(), before);
  }

  describe("transactions", () => {
    let closedId: string;
    let rowId: string;

    before(async () => {
      closedId = await account();
      const row = await transaction(closedId, "2026-09-01", 2_000);
      await transaction(closedId, "2026-09-02", -2_000);
      rowId = row.id;
      await close(closedId);
    });

    it("refuses a new transaction", async () => {
      await assertRefused(() => inject("POST", `/accounts/${closedId}/transactions`, { occurredAt: "2026-09-03", splits: [{ categoryId, amountCents: -5 }] }));
    });

    it("refuses editing a transaction's payee or memo, its status, and its splits", async () => {
      const path = `/accounts/${closedId}/transactions/${rowId}`;
      await assertRefused(() => inject("PATCH", path, { memo: "later" }));
      await assertRefused(() => inject("PATCH", path, { payee: "Someone" }));
      await assertRefused(() => inject("PATCH", path, { status: "cleared" }));
      await assertRefused(() => inject("PATCH", path, { splits: [{ categoryId, amountCents: 1_500 }, { categoryId, amountCents: 500 }] }));
    });

    it("refuses a new date or a new amount alone as account_closed, before any check that would refuse it for another reason (#655)", async () => {
      const path = `/accounts/${closedId}/transactions/${rowId}`;
      await assertRefused(() => inject("PATCH", path, { occurredAt: "2026-09-04" }));
      await assertRefused(() => inject("PATCH", path, { amountCents: 1_800 }));
      // Would be invalid_amount, split_mismatch, direct_reconciliation_not_allowed on an open account.
      await assertRefused(() => inject("PATCH", path, { amountCents: 10.5 }));
      await assertRefused(() => inject("PATCH", path, { amountCents: 1, splits: [{ categoryId, amountCents: 2 }] }));
      await assertRefused(() => inject("PATCH", path, { status: "reconciled" }));
    });

    it("refuses deleting a transaction", async () => {
      await assertRefused(() => inject("DELETE", `/accounts/${closedId}/transactions/${rowId}`));
    });

    it("answers a sync change to a closed account's split as one to a closed account", async () => {
      // No field of `splits` is a sync field yet; the check is in place before one is.
      const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM splits WHERE transaction_id = $1", [rowId]);
      assert.equal(await writesToClosedAccount(superuserPool, workspaceId, "splits.memo", rows[0]!.id), true);
      assert.equal(await writesToClosedAccount(superuserPool, workspaceId, "categories.name", rowId), false);
    });
  });

  describe("transfers", () => {
    let closedId: string;
    let openA: string;
    let openB: string;
    let openLegId: string;

    before(async () => {
      openA = await account();
      openB = await account();
      closedId = await account();
      await transaction(closedId, "2026-09-01", 3_000);
      // The closed account's money went to the open one before it closed.
      const transfer = await inject("POST", "/transfers", {
        sourceAccountId: closedId,
        destinationAccountId: openA,
        occurredAt: "2026-09-02",
        amountCents: 3_000,
      });
      assert.equal(transfer.statusCode, 201, transfer.body);
      openLegId = transfer.json().destination.id;
      await close(closedId);
    });

    it("refuses a transfer into or out of a closed account", async () => {
      const transfer = (sourceAccountId: string, destinationAccountId: string) => () =>
        inject("POST", "/transfers", { sourceAccountId, destinationAccountId, occurredAt: "2026-09-05", amountCents: 100 });
      await assertRefused(transfer(openB, closedId));
      await assertRefused(transfer(closedId, openB));
    });

    it("refuses changing the amount of an open account's leg, which would change the closed account's leg too", async () => {
      await assertRefused(() => inject("PATCH", `/accounts/${openA}/transactions/${openLegId}`, { splits: [{ categoryId: null, amountCents: 2_000 }] }));
    });

    it("refuses moving the open leg to a new date, which would move the closed account's leg too, before any other check (#655)", async () => {
      const path = `/accounts/${openA}/transactions/${openLegId}`;
      await assertRefused(() => inject("PATCH", path, { occurredAt: "2026-09-08" }));
      await assertRefused(() => inject("PATCH", path, { amountCents: 2_500 }));
      // Would be unsupported_transaction (two splits on a transfer leg) on an open pair.
      await assertRefused(() =>
        inject("PATCH", path, { occurredAt: "2026-09-08", splits: [{ categoryId: null, amountCents: 1_000 }, { categoryId: null, amountCents: 2_000 }] }),
      );
    });

    it("still lets the open leg's memo change with the date both legs already have (#655)", async () => {
      const response = await inject("PATCH", `/accounts/${openA}/transactions/${openLegId}`, { occurredAt: "2026-09-02", memo: "Same day" });
      assert.equal(response.statusCode, 200, response.body);
    });

    it("refuses deleting a transfer with a leg on a closed account, from the open leg", async () => {
      await assertRefused(() => inject("DELETE", `/accounts/${openA}/transactions/${openLegId}`));
    });

    it("still lets the open leg's own memo change: it writes nothing to the closed account", async () => {
      const response = await inject("PATCH", `/accounts/${openA}/transactions/${openLegId}`, { memo: "From the old account" });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().memo, "From the old account");
    });
  });

  describe("trades", () => {
    let closedId: string;
    let openId: string;
    let portfolioId: string;
    let instrumentId: string;
    let buyId: string;
    let sellId: string;
    let openFeeId: string;
    let splitInstrumentId: string;
    let openSplitRowId: string;

    before(async () => {
      closedId = await account("brokerage");
      openId = await account("brokerage");
      const { rows: portfolios } = await superuserPool.query<{ id: string }>(
        "INSERT INTO portfolios (workspace_id, name) VALUES ($1, $2) RETURNING id",
        [workspaceId, `Portfolio ${randomUUID()}`],
      );
      portfolioId = portfolios[0]!.id;
      const { rows: instruments } = await superuserPool.query<{ id: string }>(
        `INSERT INTO instruments (isin, ticker, exchange, name, type, currency, price_factor_e6)
         VALUES (NULL, $1, 'XMIL', 'Test fund', 'fund', 'EUR', 1000000) RETURNING id`,
        [`T${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`],
      );
      instrumentId = instruments[0]!.id;
      instrumentIds.push(instrumentId);
      const common = { accountId: closedId, portfolioId, instrumentId, quantityE8: units(2), priceE6: price(50) };
      const buy = await inject("POST", "/trades", { ...common, type: "buy", tradeDate: "2026-03-02" });
      assert.equal(buy.statusCode, 201, buy.body);
      buyId = buy.json().trades[0].id;
      const sell = await inject("POST", "/trades", { ...common, type: "sell", tradeDate: "2026-03-03" });
      assert.equal(sell.statusCode, 201, sell.body);
      sellId = sell.json().trades[0].id;
      // The open account holds units it could transfer.
      const held = await inject("POST", "/trades", {
        type: "transfer",
        instrumentId,
        tradeDate: "2026-02-10",
        quantityE8: units(5),
        to: { accountId: openId, portfolioId, costBasisCents: 25_000 },
      });
      assert.equal(held.statusCode, 201, held.body);
      const fee = await inject("POST", "/trades", { type: "fee", accountId: openId, portfolioId, tradeDate: "2026-04-01", feesCents: 250 });
      assert.equal(fee.statusCode, 201, fee.body);
      openFeeId = fee.json().trades[0].id;

      // A second instrument both accounts held on a split's date, the closed one selling out after it.
      const { rows: splitInstruments } = await superuserPool.query<{ id: string }>(
        `INSERT INTO instruments (isin, ticker, exchange, name, type, currency, price_factor_e6)
         VALUES (NULL, $1, 'XMIL', 'Split fund', 'fund', 'EUR', 1000000) RETURNING id`,
        [`S${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`],
      );
      splitInstrumentId = splitInstruments[0]!.id;
      instrumentIds.push(splitInstrumentId);
      const splitBuy = await inject("POST", "/trades", {
        type: "buy",
        accountId: closedId,
        portfolioId,
        instrumentId: splitInstrumentId,
        tradeDate: "2026-05-04",
        quantityE8: units(1),
        priceE6: price(10),
      });
      assert.equal(splitBuy.statusCode, 201, splitBuy.body);
      const openHolding = await inject("POST", "/trades", {
        type: "transfer",
        instrumentId: splitInstrumentId,
        tradeDate: "2026-05-04",
        quantityE8: units(1),
        to: { accountId: openId, portfolioId, costBasisCents: 1_000 },
      });
      assert.equal(openHolding.statusCode, 201, openHolding.body);
      const split = await inject("POST", "/trades", { type: "split", instrumentId: splitInstrumentId, tradeDate: "2026-05-05", splitFrom: 1, splitTo: 2 });
      assert.equal(split.statusCode, 201, split.body);
      const splitRows = split.json().trades as { id: string; accountId: string }[];
      assert.deepEqual(splitRows.map((row) => row.accountId).sort(), [closedId, openId].sort());
      openSplitRowId = splitRows.find((row) => row.accountId === openId)!.id;
      const splitSell = await inject("POST", "/trades", {
        type: "sell",
        accountId: closedId,
        portfolioId,
        instrumentId: splitInstrumentId,
        tradeDate: "2026-05-06",
        quantityE8: units(2),
        priceE6: price(5),
      });
      assert.equal(splitSell.statusCode, 201, splitSell.body);
      await close(closedId);
    });

    it("refuses a new trade on a closed account", async () => {
      await assertRefused(() =>
        inject("POST", "/trades", { type: "fee", accountId: closedId, portfolioId, tradeDate: "2026-09-01", feesCents: 100 }),
      );
    });

    it("refuses a transfer of securities into a closed account", async () => {
      await assertRefused(() =>
        inject("POST", "/trades", {
          type: "transfer",
          instrumentId,
          tradeDate: "2026-09-01",
          quantityE8: units(1),
          from: { accountId: openId, portfolioId },
          to: { accountId: closedId, portfolioId },
        }),
      );
    });

    it("refuses editing a closed account's trade, or moving one into it", async () => {
      await assertRefused(() => inject("PATCH", `/trades/${buyId}`, { memo: "later" }));
      await assertRefused(() => inject("PATCH", `/trades/${openFeeId}`, { accountId: closedId }));
    });

    it("answers a sync change to a closed account's trade as one to a closed account, and not one to an open account's trades", async () => {
      // No field of `trades` is a sync field yet; the check is in place before one is.
      assert.equal(await writesToClosedAccount(superuserPool, workspaceId, "trades.memo", buyId), true);
      assert.equal(await writesToClosedAccount(superuserPool, workspaceId, "trades.memo", openFeeId), false);
      const { rows } = await superuserPool.query<{ id: string }>(
        "SELECT id FROM trades WHERE workspace_id = $1 AND account_id = $2 AND type = 'transfer' AND transfer_trade_id IS NULL",
        [workspaceId, openId],
      );
      assert.equal(await writesToClosedAccount(superuserPool, workspaceId, "trades.memo", rows[0]!.id), false);
    });

    it("refuses deleting a closed account's trade", async () => {
      await assertRefused(() => inject("DELETE", `/trades/${sellId}`));
    });

    // A split is one row per holding, in every account: one dated while the closed account held
    // the instrument writes a row of the closed account too (ADR 0018, "Consequences").
    it("refuses a split backdated to when the closed account held the instrument", async () => {
      await assertRefused(() => inject("POST", "/trades", { type: "split", instrumentId, tradeDate: "2026-03-03", splitFrom: 1, splitTo: 2 }));
    });

    it("refuses editing or deleting a split that has a row on the closed account, from an open account's row", async () => {
      // An edit of a split edits every row it stands for, the closed account's included. Deleting
      // it would also fail the replay (the closed account sold the units the split gave it): the
      // closed account is answered first (#741).
      await assertRefused(() => inject("PATCH", `/trades/${openSplitRowId}`, { memo: "Ratio confirmed" }));
      await assertRefused(() => inject("PATCH", `/trades/${openSplitRowId}`, { splitTo: 3 }));
      await assertRefused(() => inject("DELETE", `/trades/${openSplitRowId}`));
    });

    // #741: each of these would also fail the position replay; the closed account is answered
    // first, never "insufficient_quantity" or "split_missing_for_portfolio".
    it("refuses a write the replay would refuse too as account_closed: a sell's quantity or date, a buy's delete, a new sell (#741)", async () => {
      await assertRefused(() => inject("PATCH", `/trades/${sellId}`, { quantityE8: units(3) }));
      await assertRefused(() => inject("PATCH", `/trades/${sellId}`, { tradeDate: "2026-03-01" }));
      await assertRefused(() => inject("DELETE", `/trades/${buyId}`));
      await assertRefused(() =>
        inject("POST", "/trades", {
          type: "sell",
          accountId: closedId,
          portfolioId,
          instrumentId,
          tradeDate: "2026-09-01",
          quantityE8: units(1),
          priceE6: price(50),
        }),
      );
      await assertRefused(() =>
        inject("POST", "/trades", {
          type: "transfer",
          instrumentId,
          tradeDate: "2026-09-01",
          quantityE8: units(1),
          from: { accountId: closedId, portfolioId },
          to: { accountId: openId, portfolioId },
        }),
      );
    });

    it("still answers a sell beyond the holdings on an open account with insufficient_quantity (#741)", async () => {
      const before = await snapshot();
      const response = await inject("POST", "/trades", {
        type: "sell",
        accountId: openId,
        portfolioId,
        instrumentId,
        tradeDate: "2026-09-01",
        quantityE8: units(50),
        priceE6: price(50),
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().error, "insufficient_quantity");
      assert.deepEqual(await snapshot(), before);
    });

    it("answers the same write insufficient_quantity while the account is open, and account_closed once it is closed (#741)", async () => {
      const accountId = await account("brokerage");
      const common = { accountId, portfolioId, instrumentId, priceE6: price(50) };
      const buy = await inject("POST", "/trades", { ...common, type: "buy", tradeDate: "2026-06-01", quantityE8: units(1) });
      assert.equal(buy.statusCode, 201, buy.body);
      const sell = await inject("POST", "/trades", { ...common, type: "sell", tradeDate: "2026-06-02", quantityE8: units(1) });
      assert.equal(sell.statusCode, 201, sell.body);
      const tradeId = sell.json().trades[0].id as string;

      const writes = [
        () => inject("PATCH", `/trades/${tradeId}`, { quantityE8: units(2) }),
        () => inject("DELETE", `/trades/${buy.json().trades[0].id as string}`),
        () => inject("POST", "/trades", { ...common, type: "sell", tradeDate: "2026-06-03", quantityE8: units(1) }),
      ];
      for (const write of writes) {
        const open = await write();
        assert.equal(open.statusCode, 400, open.body);
        assert.equal(open.json().error, "insufficient_quantity");
      }

      await close(accountId);
      for (const write of writes) {
        await assertRefused(write);
      }
    });

    it("answers a closed account of another workspace as unknown_account, never account_closed, so its state does not leak (#741)", async () => {
      const foreignWorkspaceId = randomUUID();
      foreignWorkspaceIds.push(foreignWorkspaceId);
      await superuserPool.query(
        "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Foreign', 'EUR', 'Europe/Rome')",
        [foreignWorkspaceId],
      );
      const { rows } = await superuserPool.query<{ id: string }>(
        `INSERT INTO accounts (workspace_id, name, type, currency, on_budget, closed_at)
         VALUES ($1, 'Foreign brokerage', 'brokerage', 'EUR', false, now()) RETURNING id`,
        [foreignWorkspaceId],
      );
      const foreignClosedId = rows[0]!.id;

      const writes = [
        () => inject("POST", "/trades", { type: "fee", accountId: foreignClosedId, portfolioId, tradeDate: "2026-09-01", feesCents: 100 }),
        () =>
          inject("POST", "/trades", {
            type: "sell",
            accountId: foreignClosedId,
            portfolioId,
            instrumentId,
            tradeDate: "2026-09-01",
            quantityE8: units(1),
            priceE6: price(50),
          }),
        () =>
          inject("POST", "/trades", {
            type: "transfer",
            instrumentId,
            tradeDate: "2026-09-01",
            quantityE8: units(1),
            from: { accountId: openId, portfolioId },
            to: { accountId: foreignClosedId, portfolioId },
          }),
        () => inject("PATCH", `/trades/${openFeeId}`, { accountId: foreignClosedId }),
      ];
      for (const write of writes) {
        const before = await snapshot();
        const response = await write();
        assert.equal(response.statusCode, 400, response.body);
        assert.equal(response.json().error, "unknown_account", response.body);
        assert.deepEqual(await snapshot(), before);
      }
    });
  });

  describe("imports", () => {
    let closedId: string;
    let openId: string;
    let stagedId: string;
    const mapping = { hasHeaderRow: true, dateColumn: 0, dateFormat: "YYYY-MM-DD", descriptionColumn: 1, decimalSeparator: ".", amountColumn: 2 };

    before(async () => {
      closedId = await account();
      openId = await account();
      // Staged while it was open: the confirmation comes after the close.
      const staged = await inject("POST", `/accounts/${closedId}/import`, { content: "Date,Description,Amount\n2026-09-15,Grocery store,-42.50\n", mapping });
      assert.equal(staged.statusCode, 201, staged.body);
      stagedId = staged.json().staged[0].id;
      await close(closedId);
    });

    it("refuses staging an import into a closed account before reading the file", async () => {
      await assertRefused(() => inject("POST", `/accounts/${closedId}/import`, { content: "Date,Description,Amount\n2026-09-16,Shop,-1.00\n", mapping }));
    });

    it("refuses confirming a row staged into it before it closed", async () => {
      await assertRefused(() =>
        inject("POST", `/accounts/${closedId}/staged-transactions/confirm`, { decisions: [{ stagedTransactionId: stagedId, kind: "category", categoryId }] }),
      );
    });

    it("refuses confirming a row of an open account as a transfer with a closed one", async () => {
      const staged = await inject("POST", `/accounts/${openId}/import`, { content: "Date,Description,Amount\n2026-09-17,Move,-5.00\n", mapping });
      assert.equal(staged.statusCode, 201, staged.body);
      const openStagedId = staged.json().staged[0].id;
      await assertRefused(() =>
        inject("POST", `/accounts/${openId}/staged-transactions/confirm`, {
          decisions: [{ stagedTransactionId: openStagedId, kind: "transfer", otherAccountId: closedId }],
        }),
      );
    });
  });

  describe("reconciliation", () => {
    let closedId: string;
    let reconciledId: string;

    before(async () => {
      closedId = await account();
      const inflow = await transaction(closedId, "2026-09-01", 4_000);
      const outflow = await transaction(closedId, "2026-09-02", -4_000);
      reconciledId = inflow.id;
      for (const row of [inflow, outflow]) {
        const cleared = await inject("PATCH", `/accounts/${closedId}/transactions/${row.id}`, { status: "cleared" });
        assert.equal(cleared.statusCode, 200, cleared.body);
      }
      const reconciled = await inject("POST", `/accounts/${closedId}/reconciliations`, {
        date: "2026-09-02",
        statementBalanceCents: 0,
        tickedTransactionIds: [inflow.id, outflow.id],
      });
      assert.equal(reconciled.statusCode, 201, reconciled.body);
      await close(closedId);
    });

    it("refuses reconciling a closed account", async () => {
      await assertRefused(() => inject("POST", `/accounts/${closedId}/reconciliations`, { date: "2026-09-30", statementBalanceCents: 0, tickedTransactionIds: [] }));
    });

    it("refuses unlocking a closed account's reconciled transaction", async () => {
      await assertRefused(() => inject("POST", `/transactions/${reconciledId}/unlock-reconciliation`));
    });
  });

  describe("scheduled transactions", () => {
    let closedId: string;
    let scheduledId: string;

    before(async () => {
      closedId = await account();
      const scheduled = await inject("POST", "/scheduled-transactions", {
        accountId: closedId,
        payee: "Landlord",
        nextDueDate: "2026-09-01",
        recurEvery: 1,
        recurUnit: "month",
        splits: [{ categoryId, amountCents: 900 }],
      });
      assert.equal(scheduled.statusCode, 201, scheduled.body);
      scheduledId = scheduled.json().id;
      await closeDirectly(closedId);
    });

    it("refuses a new scheduled transaction on a closed account", async () => {
      await assertRefused(() =>
        inject("POST", "/scheduled-transactions", {
          accountId: closedId,
          nextDueDate: "2027-01-01",
          recurEvery: 1,
          recurUnit: "month",
          splits: [{ categoryId, amountCents: 100 }],
        }),
      );
    });

    it("refuses editing, skipping, recording and deleting one", async () => {
      await assertRefused(() => inject("PATCH", `/scheduled-transactions/${scheduledId}`, { payee: "Someone else" }));
      await assertRefused(() => inject("POST", `/scheduled-transactions/${scheduledId}/skip`));
      await assertRefused(() => inject("POST", `/scheduled-transactions/${scheduledId}/record`));
      await assertRefused(() => inject("DELETE", `/scheduled-transactions/${scheduledId}`));
    });
  });

  describe("sync", () => {
    it("refuses a change to a closed account's transaction alone, still applying the rest of the upload", async () => {
      const closedId = await account();
      const openId = await account();
      const closedRow = await transaction(closedId, "2026-09-01", 0);
      const openRow = await transaction(openId, "2026-09-01", 700);
      await close(closedId);

      const hlc = { physical: Date.now(), counter: 0, deviceId: "phone" };
      const refusedId = randomUUID();
      const appliedId = randomUUID();
      const response = await inject("POST", "/changes", {
        changes: [
          { id: refusedId, entityId: closedRow.id, fieldName: "transactions.memo", hlc, value: "late note" },
          { id: randomUUID(), entityId: closedRow.id, fieldName: "transactions.payee", hlc, value: "Someone" },
          { id: appliedId, entityId: openRow.id, fieldName: "transactions.memo", hlc, value: "on time" },
        ],
      });
      assert.equal(response.statusCode, 201, response.body);
      const outcomes = (response.json() as { results: { outcome: string }[] }).results.map((result) => result.outcome);
      assert.deepEqual(outcomes, ["account_closed", "account_closed", "applied"]);

      const { rows } = await superuserPool.query<{ id: string; memo: string | null; payee: string | null }>(
        "SELECT id, memo, payee FROM transactions WHERE id = ANY($1)",
        [[closedRow.id, openRow.id]],
      );
      const byId = new Map(rows.map((row) => [row.id, row]));
      assert.equal(byId.get(closedRow.id)?.memo, null);
      assert.equal(byId.get(closedRow.id)?.payee, null);
      assert.equal(byId.get(openRow.id)?.memo, "on time");
      // A refused change is never recorded: a retry once the account reopens (#705) can still apply.
      const { rows: recorded } = await superuserPool.query("SELECT 1 FROM change_log WHERE workspace_id = $1 AND id = $2", [workspaceId, refusedId]);
      assert.equal(recorded.length, 0);
    });
  });
});
