/**
 * The walk's predictions for a write to a closed account (#735, ADR 0018) and for the tax regime
 * rules of its `IT` workspace (#676), on a model alone: which refusal wins when an operation would
 * be refused for more than one reason is the API's order of checks, and a wrong order here would
 * make the walk fail on a correct API, or miss a check moved behind another.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InstrumentCatalog, WorkspaceModel, type TransactionJson, type WalkUser } from "./model.ts";
import { predictOperation, WALK_TAX_COUNTRY, type Params } from "./operations.ts";

const user: WalkUser = { userId: "u", token: async () => "token" };

function transaction(fields: Pick<TransactionJson, "id" | "accountId"> & Partial<TransactionJson>): TransactionJson {
  return {
    occurredAt: "2025-10-01T10:00:00.000Z",
    budgetDate: "2025-10-01",
    payee: null,
    memo: null,
    status: "pending",
    transferId: null,
    tradeId: null,
    splits: [{ categoryId: null, amountCents: -1_000, memo: null }],
    ...fields,
  };
}

/** A household with a checking account (a1), a groceries category (c1) and a closed card (a2, its payment category c2). */
function household(): WorkspaceModel {
  const model = new WorkspaceModel("household", "workspace", { owner: user, editor: user, read_only: user }, new InstrumentCatalog());
  model.addAccount({ id: "checking", type: "checking", onBudget: true, currency: "EUR", paymentCategoryId: null });
  model.addCategory({ id: "groceries", name: "Groceries" });
  const card = model.addAccount({ id: "card", type: "credit_card", onBudget: true, currency: "EUR", paymentCategoryId: "card-payment" });
  model.addTransaction(transaction({ id: "spent", accountId: "card" }));
  model.addTransaction(transaction({ id: "leg", accountId: "card", tradeId: "trade" }));
  card.closed = true;
  return model;
}

function predict(model: WorkspaceModel, kind: string, params: Params) {
  return predictOperation(kind, model, params, new Map([[model.persona, model]]));
}

const CLOSED = { kind: "refuse", status: 409, code: "account_closed" };

describe("the walk's prediction for a write to a closed account (#735)", () => {
  it("refuses a new transaction on it, but a card's income first as such (the API checks it before the database refuses the write)", () => {
    const model = household();
    const spend = { account: "a2", occurredAt: "2025-10-01", splits: [{ category: "c1", amountCents: -500 }] };
    assert.deepEqual(predict(model, "spend", spend), CLOSED);
    assert.deepEqual(predict(model, "income", { ...spend, splits: [{ category: null, amountCents: 500 }] }), {
      kind: "refuse",
      status: 400,
      code: "card_income_not_supported",
    });
  });

  it("refuses a transfer with either leg on it", () => {
    const model = household();
    assert.deepEqual(predict(model, "cardPayment", { source: "a1", destination: "a2", amountCents: 500, occurredAt: "2025-10-01" }), CLOSED);
  });

  it("refuses an edit of its transaction as closed first, a delete as trade-owned first", () => {
    const model = household();
    assert.deepEqual(predict(model, "editTransaction", { tx: "t1", change: "memo", value: "memo 1" }), CLOSED);
    assert.deepEqual(predict(model, "editLegAmount", { tx: "t2", amountCents: -5 }), CLOSED);
    assert.deepEqual(predict(model, "deleteLeg", { tx: "t2" }), { kind: "refuse", status: 409, code: "trade_owned_transaction" });
  });

  it("refuses closing it again as not found, and closes an open account that is empty", () => {
    const model = household();
    assert.deepEqual(predict(model, "closeAccount", { account: "a2" }), { kind: "refuse", status: 404 });
    assert.deepEqual(predict(model, "closeAccount", { account: "a1" }), { kind: "accept" });
  });

  it("refuses closing an account with money on it, with the figures the rule read", () => {
    const model = household();
    model.addTransaction(transaction({ id: "rent", accountId: "checking", splits: [{ categoryId: "groceries", amountCents: -2_500, memo: null }] }));
    assert.deepEqual(predict(model, "closeAccount", { account: "a1" }), {
      kind: "refuse",
      status: 409,
      code: "account_not_empty",
      details: {
        balanceCents: -2_500,
        holdsPositions: false,
        laterRows: { count: 0, firstDate: null },
        scheduled: { count: 0, scheduledTransactionId: null, nextDueDate: null },
      },
    });
  });
});

/** An `IT` investor with an administered broker (a1, a withholding agent) and a self-declared one (a2, not one). */
function investor(): WorkspaceModel {
  const instruments = new InstrumentCatalog();
  instruments.add({ handle: "i1", id: "stock", type: "stock", currency: "EUR", priceFactorE6: 1_000_000 });
  const model = new WorkspaceModel("investor", "workspace", { owner: user, editor: user, read_only: user }, instruments);
  model.taxCountry = WALK_TAX_COUNTRY;
  const account = { type: "brokerage", onBudget: false, currency: "EUR", paymentCategoryId: null } as const;
  model.addAccount({ ...account, id: "agent", domesticWithholdingAgent: true }, [{ validFrom: "2025-09-01", regime: "administered" }]);
  model.addAccount({ ...account, id: "foreign", domesticWithholdingAgent: false }, [{ validFrom: "2025-09-01", regime: "self_declared" }]);
  model.addPortfolio("portfolio");
  return model;
}

describe("the walk's prediction of the tax regime rules (#676)", () => {
  const managedTax = { type: "tax", portfolio: "p1", instrument: null, tradeDate: "2026-02-10", taxKind: "managed_result_tax", amounts: { grossCents: 1_000 } };

  it("refuses a tax kind the regime in force does not allow", () => {
    assert.deepEqual(predict(investor(), "tax", { ...managedTax, account: "a1" }), { kind: "refuse", status: 400, code: "tax_kind_not_allowed_in_regime" });
  });

  it("refuses a change to a regime that needs a withholding agent on a broker that is not one", () => {
    assert.deepEqual(predict(investor(), "addTaxRegime", { account: "a2", regime: "managed", validFrom: "2026-01-01" }), {
      kind: "refuse",
      status: 400,
      code: "tax_regime_requires_withholding_agent",
    });
  });

  it("refuses a change that does not start on 1 January, an emptied history, and a new account without its settings", () => {
    const model = investor();
    assert.deepEqual(predict(model, "addTaxRegime", { account: "a1", regime: "managed", validFrom: "2026-03-01" }), {
      kind: "refuse",
      status: 400,
      code: "tax_regime_change_not_year_start",
    });
    assert.deepEqual(predict(model, "replaceTaxRegimes", { account: "a1", history: [] }), { kind: "refuse", status: 400, code: "tax_regime_required" });
    assert.deepEqual(predict(model, "createAccount", { type: "brokerage", onBudget: false, name: "b", taxRegime: "self_declared", taxRegimeValidFrom: "2025-10-01" }), {
      kind: "refuse",
      status: 400,
      code: "tax_regime_required",
    });
  });

  it("refuses a change that would break a trade the account already has, and accepts it once the trade is gone", () => {
    const model = investor();
    model.addTrades([
      {
        id: "managed-tax",
        accountId: "agent",
        portfolioId: "portfolio",
        instrumentId: null,
        type: "tax",
        tradeDate: "2026-02-10",
        occurredAt: null,
        quantityE8: 0,
        priceE6: 0,
        grossCents: 1_000,
        feesCents: 0,
        transactionTaxCents: 0,
        accruedInterestCents: 0,
        withholdingForeignCents: 0,
        withholdingDomesticCents: 0,
        gainTaxCents: 0,
        taxKind: "managed_result_tax",
        costBasisCents: null,
        splitFrom: null,
        splitTo: null,
        transferTradeId: null,
        memo: null,
        createdAt: "2026-02-10T10:00:00.000Z",
        cashCents: -1_000,
        cashTransactionId: null,
        locked: false,
      },
    ]);
    // The account's history is made managed by hand, as if the trade came in under it.
    model.account("a1").taxRegimes = [{ validFrom: "2025-09-01", regime: "managed" }];
    const back = { account: "a1", history: [{ validFrom: "2025-09-01", regime: "administered" }] };
    assert.deepEqual(predict(model, "replaceTaxRegimes", back), { kind: "refuse", status: 400, code: "tax_regime_conflicts_with_trade" });
    model.removeTrades(["tr1"]);
    assert.deepEqual(predict(model, "replaceTaxRegimes", back), { kind: "accept" });
  });

  it("leaves a closed account's regime history writable (ADR 0018)", () => {
    const model = investor();
    model.account("a1").closed = true;
    assert.deepEqual(predict(model, "addTaxRegime", { account: "a1", regime: "managed", validFrom: "2026-01-01" }), { kind: "accept" });
  });

  it("refuses a regime in a workspace with no tax country as not applicable", () => {
    const model = investor();
    model.taxCountry = null;
    assert.deepEqual(predict(model, "addTaxRegime", { account: "a1", regime: "administered", validFrom: "2026-01-01" }), {
      kind: "refuse",
      status: 400,
      code: "tax_regime_not_applicable",
    });
  });
});
