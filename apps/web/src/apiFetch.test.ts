import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiFetch } from "./apiFetch.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch on a 429 (#683)", () => {
  it("does not retry a write: it throws the rate-limit error after one request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "too_many_requests", details: { retryAfterSeconds: 12 } }), {
        status: 429,
        headers: { "Retry-After": "12" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const caught = await apiFetch("t", "POST", "/workspaces/ws-1/transactions", { amount: 1 }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({ status: 429, code: "too_many_requests", details: { retryAfterSeconds: 12 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("takes the wait from Retry-After when the body has none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "too_many_requests" }), { status: 429, headers: { "Retry-After": "8" } })),
    );
    const caught = await apiFetch("t", "GET", "/workspaces").catch((e: unknown) => e);
    expect(caught).toMatchObject({ code: "too_many_requests", details: { retryAfterSeconds: 8 } });
  });
});

describe("apiFetch's error code", () => {
  it("takes the body's own code when its error is a sentence (#657)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: "this transaction is the cash leg of a trade: its amount is set by the trade", code: "trade_owned_transaction" }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const caught = await apiFetch("t", "PATCH", "/workspaces/ws-1/accounts/acc-1/transactions/t-1", { amountCents: 1 }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({ status: 409, code: "trade_owned_transaction" });
  });

  it("falls back to the body's error when it has no code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "account_closed" }), { status: 409 })));
    const caught = await apiFetch("t", "GET", "/workspaces").catch((e: unknown) => e);
    expect(caught).toMatchObject({ status: 409, code: "account_closed" });
  });
});
