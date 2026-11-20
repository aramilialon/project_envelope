/**
 * The walk's model hands out the same handles for the rows of one request whatever order the API
 * returns them in (#80): a transfer's two legs and a split's rows tie on random ids, and a seed is
 * a reproduction only if its handles do not depend on them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InstrumentCatalog, WorkspaceModel, type TradeJson, type WalkUser } from "./model.ts";

const user: WalkUser = { userId: "u", token: async () => "token" };

function freshModel(): WorkspaceModel {
  const instruments = new InstrumentCatalog();
  instruments.add({ handle: "i1", id: "instrument-1", type: "stock", currency: "EUR", priceFactorE6: 1_000_000 });
  const model = new WorkspaceModel("investor", "workspace", { owner: user, editor: user, read_only: user }, instruments);
  model.addAccount({ id: "account-1", type: "brokerage", onBudget: false, currency: "EUR", paymentCategoryId: null });
  model.addAccount({ id: "account-2", type: "brokerage", onBudget: false, currency: "EUR", paymentCategoryId: null });
  model.addPortfolio("portfolio-1");
  model.addPortfolio("portfolio-2");
  return model;
}

function trade(fields: Pick<TradeJson, "id" | "type" | "accountId" | "portfolioId" | "quantityE8"> & Partial<TradeJson>): TradeJson {
  return {
    instrumentId: "instrument-1",
    tradeDate: "2026-03-17",
    occurredAt: null,
    priceE6: 0,
    grossCents: 0,
    feesCents: 0,
    transactionTaxCents: 0,
    accruedInterestCents: 0,
    withholdingForeignCents: 0,
    withholdingDomesticCents: 0,
    gainTaxCents: 0,
    taxKind: null,
    costBasisCents: null,
    splitFrom: null,
    splitTo: null,
    transferTradeId: null,
    memo: null,
    createdAt: "2026-03-17T10:00:00.000Z",
    cashCents: 0,
    cashTransactionId: null,
    locked: false,
    ...fields,
  };
}

function handlesById(model: WorkspaceModel, records: readonly TradeJson[]): Record<string, string> {
  return Object.fromEntries(model.addTrades(records).map((entity) => [entity.record.id, entity.handle]));
}

describe("WorkspaceModel.addTrades (#80)", () => {
  // Ids sort the opposite way to the order the model wants, so an id order would show.
  const transfer = [
    trade({ id: "f-in", type: "transfer", accountId: "account-2", portfolioId: "portfolio-2", quantityE8: 100, transferTradeId: "e-out" }),
    trade({ id: "e-out", type: "transfer", accountId: "account-1", portfolioId: "portfolio-1", quantityE8: -100, transferTradeId: "f-in" }),
  ];
  const split = [
    trade({ id: "d-split", type: "split", accountId: "account-2", portfolioId: "portfolio-2", quantityE8: 0, splitFrom: 1, splitTo: 2 }),
    trade({ id: "c-split", type: "split", accountId: "account-1", portfolioId: "portfolio-2", quantityE8: 0, splitFrom: 1, splitTo: 2 }),
    trade({ id: "b-split", type: "split", accountId: "account-1", portfolioId: "portfolio-1", quantityE8: 0, splitFrom: 1, splitTo: 2 }),
  ];

  for (const [name, rows] of [
    ["a transfer's two legs", transfer],
    ["a split's rows", split],
  ] as const) {
    it(`gives ${name} the same handles in whatever order they come back`, () => {
      const forward = handlesById(freshModel(), rows);
      const reversed = handlesById(freshModel(), [...rows].reverse());
      assert.deepEqual(reversed, forward);
    });
  }

  it("gives a transfer's outgoing leg the first handle", () => {
    assert.deepEqual(handlesById(freshModel(), transfer), { "e-out": "tr1", "f-in": "tr2" });
  });

  it("gives a split's rows handles by account, then portfolio", () => {
    assert.deepEqual(handlesById(freshModel(), split), { "b-split": "tr1", "c-split": "tr2", "d-split": "tr3" });
  });
});
