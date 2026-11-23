import { afterEach, describe, expect, it, vi } from "vitest";

import { listTransactionsForAccount, type Transaction } from "./api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function transaction(id: string): Transaction {
  return { id, splits: [{ id: `${id}-s`, categoryId: null, amountCents: 100, memo: null }] } as unknown as Transaction;
}

describe("listTransactionsForAccount (#560)", () => {
  it("follows nextCursor to the last page and returns every transaction in order", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ transactions: [transaction("t1"), transaction("t2")], nextCursor: "c+/1=" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ transactions: [transaction("t3")], nextCursor: null })));
    vi.stubGlobal("fetch", fetchMock);

    const transactions = await listTransactionsForAccount("t", "ws-1", "a1");

    expect(transactions.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toMatch(/\/workspaces\/ws-1\/accounts\/a1\/transactions\?limit=500$/);
    expect(urls[1]).toMatch(/\/workspaces\/ws-1\/accounts\/a1\/transactions\?limit=500&cursor=c%2B%2F1%3D$/);
  });

  it("asks once for an account whose transactions fit on one page", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ transactions: [], nextCursor: null })));
    vi.stubGlobal("fetch", fetchMock);

    expect(await listTransactionsForAccount("t", "ws-1", "a1")).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
