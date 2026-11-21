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
  it("turns a 409 account_not_empty into an AccountNotEmptyError with the balance and the securities flag", async () => {
    respond(409, { error: "account_not_empty", details: { balanceCents: -2_500, holdsPositions: true } });

    const caught = await closeAccount("t", "ws-1", "a1").catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(AccountNotEmptyError);
    expect(caught).toMatchObject({ balanceCents: -2_500, holdsPositions: true });
  });

  it("leaves any other failure as the ApiError apiFetch throws", async () => {
    respond(404, { error: "account not found, or already closed" });

    const caught = await closeAccount("t", "ws-1", "a1").catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).not.toBeInstanceOf(AccountNotEmptyError);
    expect(caught).toMatchObject({ status: 404 });
  });
});
