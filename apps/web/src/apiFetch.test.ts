import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiFetch } from "./apiFetch.ts";
import { createAssignments } from "./budget/api.ts";
import { createTransaction, createTransfer } from "./transactions/api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch headers (#559)", () => {
  it("sends the headers it is given beside the bearer token and the JSON content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("t", "POST", "/workspaces/ws-1/transfers", { amountCents: 1 }, { "Idempotency-Key": "key-1" });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: "Bearer t",
      "Content-Type": "application/json",
      "Idempotency-Key": "key-1",
    });
  });

  it("sends only the bearer token when given none", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("t", "GET", "/workspaces");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: "Bearer t" });
  });
});

describe("createTransaction, createTransfer and createAssignments (#559)", () => {
  it("send the Idempotency-Key a form gives them", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await createTransaction("t", "ws-1", "acc-1", { occurredAt: "2026-09-01", splits: [] }, "key-1");
    await createTransfer("t", "ws-1", { sourceAccountId: "a", destinationAccountId: "b", occurredAt: "2026-09-01", amountCents: 1 }, "key-2");
    await createTransaction("t", "ws-1", "acc-1", { occurredAt: "2026-09-01", splits: [] });

    const keys = fetchMock.mock.calls.map((call) => (call[1]?.headers as Record<string, string>)["Idempotency-Key"]);
    expect(keys).toEqual(["key-1", "key-2", undefined]);
  });

  it("sends a batch of assignments under a batchId of its own, or the one the caller gives", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const entries = [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: "c1", amountCents: 100 }];

    await createAssignments("t", "ws-1", entries);
    await createAssignments("t", "ws-1", entries);
    await createAssignments("t", "ws-1", entries, "batch-1");

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1]?.body as string) as { batchId: string; entries: unknown });
    expect(bodies[0]?.batchId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(bodies[1]?.batchId).not.toBe(bodies[0]?.batchId);
    expect(bodies[2]).toEqual({ batchId: "batch-1", entries });
  });
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
