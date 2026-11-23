import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "@envelope/core";

import { canonicalJson, MAX_BODY_DEPTH, requestFingerprint, valueFingerprint, type FingerprintInput } from "./fingerprint.ts";

const base: FingerprintInput = {
  method: "POST",
  route: "/workspaces/:workspaceId/accounts/:accountId/transactions",
  params: { workspaceId: "0b6f3c2e-8d1a-4f5e-9c7b-2a1d3e4f5a6b", accountId: "1c7a4d3f-9e2b-4a6f-8d8c-3b2e4f5a6b7c" },
  query: {},
  body: { occurredAt: "2026-09-10", payee: "Shop", splits: [{ categoryId: null, amountCents: -1250 }] },
  userId: "2d8b5e4a-0f3c-4b7a-9e9d-4c3f5a6b7c8d",
};

function refusedAsInvalidBody(error: unknown): boolean {
  assert.ok(isValidationError(error));
  assert.equal(error.code, "invalid_body");
  assert.deepEqual(error.details, {});
  return true;
}

describe("requestFingerprint (#559)", () => {
  it("is 32 bytes and the same for the same request", () => {
    const a = requestFingerprint(base);
    assert.equal(a.length, 32);
    assert.ok(a.equals(requestFingerprint({ ...base })));
  });

  it("does not depend on the order of an object's keys, at any depth", () => {
    const reordered = requestFingerprint({
      ...base,
      body: { splits: [{ amountCents: -1250, categoryId: null }], payee: "Shop", occurredAt: "2026-09-10" },
    });
    assert.ok(reordered.equals(requestFingerprint(base)));
  });

  it("does depend on the order of an array's items", () => {
    const twoSplits = (first: number, second: number) => ({
      ...base,
      body: { splits: [{ amountCents: first }, { amountCents: second }] },
    });
    assert.ok(!requestFingerprint(twoSplits(1, 2)).equals(requestFingerprint(twoSplits(2, 1))));
  });

  it("tells every part of the request apart: body, route, path, query, method and user", () => {
    const fingerprint = requestFingerprint(base);
    const variants: FingerprintInput[] = [
      { ...base, body: { ...(base.body as object), payee: "Other shop" } },
      { ...base, route: "/workspaces/:workspaceId/transfers" },
      { ...base, params: { ...(base.params as object), accountId: "3e9c6f5b-1a4d-4c8b-8f0e-5d4a6b7c8d9e" } },
      { ...base, query: { dryRun: "true" } },
      { ...base, method: "PUT" },
      { ...base, userId: "4f0d7a6c-2b5e-4d9c-9a1f-6e5b7c8d9e0f" },
    ];
    for (const variant of variants) {
      assert.ok(!requestFingerprint(variant).equals(fingerprint), JSON.stringify(variant));
    }
  });

  it("reads path ids whatever their letter case", () => {
    const upper = {
      ...base,
      params: { workspaceId: "0B6F3C2E-8D1A-4F5E-9C7B-2A1D3E4F5A6B", accountId: "1C7A4D3F-9E2B-4A6F-8D8C-3B2E4F5A6B7C" },
    };
    assert.ok(requestFingerprint(upper).equals(requestFingerprint(base)));
  });

  it("keeps an own __proto__ key, so a body that adds one is another request", () => {
    const withProto = JSON.parse(`{"occurredAt":"2026-09-10","payee":"Shop","splits":[{"categoryId":null,"amountCents":-1250}],"__proto__":{"x":1}}`);
    assert.ok(Object.hasOwn(withProto, "__proto__"));
    assert.ok(!requestFingerprint({ ...base, body: withProto }).equals(requestFingerprint(base)));
  });

  it("never mistakes an array for an object, or a string for a number", () => {
    assert.notDeepEqual(canonicalJson([["a", 1]]), canonicalJson({ a: 1 }));
    assert.ok(!valueFingerprint(["1"]).equals(valueFingerprint([1])));
    assert.ok(!valueFingerprint([null]).equals(valueFingerprint([{}])));
  });

  it("treats a missing body as null", () => {
    const { body: _ignored, ...withoutBody } = base;
    assert.ok(requestFingerprint({ ...withoutBody, body: undefined }).equals(requestFingerprint({ ...withoutBody, body: null })));
  });

  it("refuses a non-finite number as invalid_body", () => {
    for (const value of [Infinity, -Infinity, NaN, JSON.parse("1e400")]) {
      assert.throws(() => requestFingerprint({ ...base, body: { amountCents: value } }), refusedAsInvalidBody);
    }
  });

  it("refuses nesting deeper than its limit as invalid_body, without overflowing the stack", () => {
    const deep = (depth: number): unknown => JSON.parse(`${"[".repeat(depth)}1${"]".repeat(depth)}`);
    assert.doesNotThrow(() => requestFingerprint({ ...base, body: deep(MAX_BODY_DEPTH) }));
    assert.throws(() => requestFingerprint({ ...base, body: deep(MAX_BODY_DEPTH + 1) }), refusedAsInvalidBody);
    assert.throws(() => requestFingerprint({ ...base, body: deep(200_000) }), refusedAsInvalidBody);
  });
});
