import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FastifyRequest } from "fastify";

import { assertIdempotentReplyStored } from "./route.ts";

/** A request as the onSend hook sees it: with a claimed key, stored or not, or with none. */
function requestWith(claimed: { stored: boolean } | undefined): FastifyRequest {
  return (claimed ? { idempotencyKey: { workspaceId: "w", key: "k", ...claimed } } : {}) as FastifyRequest;
}

describe("assertIdempotentReplyStored (#559)", () => {
  it("refuses a success on a claimed key whose reply was never stored", () => {
    for (const status of [200, 201, 204, 302, 399]) {
      assert.throws(() => assertIdempotentReplyStored(requestWith({ stored: false }), status), {
        message: "an idempotent route replied without storing its reply",
      });
    }
  });

  it("lets a success through once its reply is stored", () => {
    assert.doesNotThrow(() => assertIdempotentReplyStored(requestWith({ stored: true }), 201));
  });

  it("lets a failure through: the request rolls back, key included", () => {
    for (const status of [400, 404, 409, 500]) {
      assert.doesNotThrow(() => assertIdempotentReplyStored(requestWith({ stored: false }), status));
    }
  });

  it("lets a request with no key through", () => {
    assert.doesNotThrow(() => assertIdempotentReplyStored(requestWith(undefined), 201));
  });
});
