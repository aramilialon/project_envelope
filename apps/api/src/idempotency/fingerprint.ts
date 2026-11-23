/**
 * The fingerprint of a request under an `Idempotency-Key` (#559, ADR 0020): sha256 of
 * `JSON.stringify([method, route pattern, path parameters, query, canonical body, user id])`.
 * Two requests are "the same" exactly when their fingerprints are equal: the same key with another
 * body, route, account or member is a 409 `id_conflict`.
 *
 * The canonical form makes the fingerprint independent of how a client orders its object keys,
 * and of the letter case of the ids in the path:
 * - an object becomes `["o", [key, value], ...]`, its keys sorted, built as key/value pairs and
 *   never by assigning `copy[key] = value`, which would drop an own `__proto__` key;
 * - an array becomes `["a", ...items]`, so it can never look like an object;
 * - a string, a boolean or null stays as it is; a number must be finite (JSON.parse reads 1e400 as
 *   Infinity, which JSON.stringify would write as null);
 * - nesting deeper than `MAX_BODY_DEPTH` is refused, so a hostile body is a 400, not a stack
 *   overflow and a 500.
 */
import { createHash } from "node:crypto";

import { ValidationError } from "@envelope/core";

import { isUuid } from "../ids.ts";

/** Deeper than any body the API takes (a split inside a transaction is depth 3). */
export const MAX_BODY_DEPTH = 32;

export interface FingerprintInput {
  readonly method: string;
  /** The route pattern, `request.routeOptions.url`. */
  readonly route: string;
  readonly params: unknown;
  readonly query: unknown;
  readonly body: unknown;
  readonly userId: string;
}

function refuse(reason: string): ValidationError {
  return new ValidationError("invalid_body", `the body cannot be fingerprinted: ${reason}`, {});
}

/**
 * The canonical form of a parsed JSON value (see the module comment).
 *
 * @throws ValidationError `invalid_body` for a non-finite number, a value JSON cannot hold, or
 *   nesting deeper than `MAX_BODY_DEPTH`.
 */
export function canonicalJson(value: unknown, depth = 0): unknown {
  if (depth > MAX_BODY_DEPTH) {
    throw refuse("nested too deeply");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw refuse("a number is out of range");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return ["a", ...value.map((item) => canonicalJson(item, depth + 1))];
  }
  if (typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson((value as Record<string, unknown>)[key], depth + 1)]);
    return ["o", ...entries];
  }
  throw refuse("a value is not JSON");
}

/** Path parameters with their ids in lower case: `/accounts/ABC…` and `/accounts/abc…` name the same row. */
function canonicalParams(params: unknown): unknown {
  if (typeof params !== "object" || params === null) {
    return canonicalJson({});
  }
  const lowered = Object.entries(params as Record<string, unknown>).map(([key, value]): [string, unknown] => [
    key,
    isUuid(value) ? value.toLowerCase() : value,
  ]);
  return canonicalJson(Object.fromEntries(lowered));
}

/** sha256 of the request (see the module comment), 32 bytes. @throws ValidationError as `canonicalJson`. */
export function requestFingerprint(input: FingerprintInput): Buffer {
  const parts = [
    input.method.toUpperCase(),
    input.route,
    canonicalParams(input.params),
    canonicalJson(input.query ?? {}),
    canonicalJson(input.body === undefined ? null : input.body),
    input.userId,
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest();
}

/** sha256 of `parts`, each in its canonical form: the fingerprint of an assignment batch's request. */
export function valueFingerprint(parts: readonly unknown[]): Buffer {
  return createHash("sha256").update(JSON.stringify(canonicalJson(parts))).digest();
}
