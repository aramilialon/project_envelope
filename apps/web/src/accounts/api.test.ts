import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../apiFetch.ts";
import { AccountNotEmptyError, closeAccount } from "./api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function respond(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
}

describe("closeAccount (#703)", () => {
  it("turns a 409 account_not_empty into an AccountNotEmptyError with every reason in its details (#729)", async () => {
    respond(409, {
      error: "account_not_empty",
      details: { balanceCents: -2_500, laterRows: { count: 2, firstDate: "2027-03-01" }, holdsPositions: true, scheduled: { count: 1 } },
    });

    const caught = await closeAccount("t", "ws-1", "a1").catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(AccountNotEmptyError);
    expect((caught as AccountNotEmptyError).details).toEqual({
      balanceCents: -2_500,
      laterRows: { count: 2, firstDate: "2027-03-01" },
      holdsPositions: true,
      scheduled: { count: 1, scheduledTransactionId: null, nextDueDate: null },
    });
  });

  it("reads the scheduled transaction due first, its id and its next due date (#741)", async () => {
    respond(409, {
      error: "account_not_empty",
      details: { balanceCents: 0, scheduled: { count: 2, scheduledTransactionId: "s-1", nextDueDate: "2027-02-15" } },
    });

    const caught = await closeAccount("t", "ws-1", "a1").catch((e: unknown) => e);
    expect((caught as AccountNotEmptyError).details.scheduled).toEqual({ count: 2, scheduledTransactionId: "s-1", nextDueDate: "2027-02-15" });
  });

  it("reads the null fields of no scheduled transaction, and ignores a due date that is not a date", async () => {
    respond(409, {
      error: "account_not_empty",
      details: { balanceCents: 100, scheduled: { count: 0, scheduledTransactionId: null, nextDueDate: null } },
    });
    const empty = await closeAccount("t", "ws-1", "a1").catch((e: unknown) => e);
    expect((empty as AccountNotEmptyError).details.scheduled).toEqual({ count: 0, scheduledTransactionId: null, nextDueDate: null });

    respond(409, { error: "account_not_empty", details: { scheduled: { count: 1, scheduledTransactionId: 7, nextDueDate: "soon" } } });
    const odd = await closeAccount("t", "ws-1", "a1").catch((e: unknown) => e);
    expect((odd as AccountNotEmptyError).details.scheduled).toEqual({ count: 1, scheduledTransactionId: null, nextDueDate: null });
  });

  it("reads details the API left out as an empty account's", async () => {
    respond(409, { error: "account_not_empty", details: { balanceCents: 100 } });

    const caught = await closeAccount("t", "ws-1", "a1").catch((e: unknown) => e);
    expect((caught as AccountNotEmptyError).details).toEqual({
      balanceCents: 100,
      laterRows: { count: 0, firstDate: null },
      holdsPositions: false,
      scheduled: { count: 0, scheduledTransactionId: null, nextDueDate: null },
    });
  });

  it("leaves any other failure as the ApiError apiFetch throws", async () => {
    respond(404, { error: "account not found, or already closed" });

    const caught = await closeAccount("t", "ws-1", "a1").catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).not.toBeInstanceOf(AccountNotEmptyError);
    expect(caught).toMatchObject({ status: 404 });
  });
});
