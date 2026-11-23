import { describe, expect, it } from "vitest";

import type { Transaction, TransactionStatus } from "./api.ts";
import { balanceRowOf } from "./transactionAmount.ts";

function transaction(status: TransactionStatus): Transaction {
  return {
    id: "t1",
    workspaceId: "w1",
    accountId: "a1",
    occurredAt: "2026-11-05T10:00:00Z",
    budgetDate: "2026-11-05",
    payee: "Payee",
    memo: null,
    status,
    transferId: null,
    transferAccountId: null,
    externalId: null,
    tradeId: null,
    trade: null,
    createdAt: "2026-11-05T10:00:00Z",
    splits: [
      { id: "s1", categoryId: "c1", amountCents: -3_000, memo: null },
      { id: "s2", categoryId: "c2", amountCents: -1_500, memo: null },
    ],
  };
}

describe("balanceRowOf (#702)", () => {
  it("reads the budget date and the total of the splits", () => {
    expect(balanceRowOf(transaction("cleared"))).toEqual({ date: "2026-11-05", amountCents: -4_500, pending: false });
  });

  it("counts a reconciled transaction as cleared, only a pending one as pending", () => {
    expect(balanceRowOf(transaction("reconciled")).pending).toBe(false);
    expect(balanceRowOf(transaction("pending")).pending).toBe(true);
  });
});
