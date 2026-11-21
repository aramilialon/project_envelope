import { createIntl } from "react-intl";
import { describe, expect, it } from "vitest";

import { tooManyRequestsMessage } from "./apiErrors.ts";
import { ApiError } from "./apiFetch.ts";

const intl = createIntl({ locale: "en", defaultLocale: "en", messages: {} });

describe("tooManyRequestsMessage (#566)", () => {
  it("says how long to wait when the API said so", () => {
    expect(tooManyRequestsMessage(intl, new ApiError("POST failed: 429", 429, "too_many_requests", { retryAfterSeconds: 42 }))).toBe(
      "Too many requests in a short time. Try again in 42 seconds.",
    );
    expect(tooManyRequestsMessage(intl, new ApiError("POST failed: 429", 429, "too_many_requests", { retryAfterSeconds: 1 }))).toBe(
      "Too many requests in a short time. Try again in 1 second.",
    );
  });

  it("still names the problem without a wait", () => {
    expect(tooManyRequestsMessage(intl, new ApiError("POST failed: 429", 429, "too_many_requests", {}))).toBe(
      "Too many requests in a short time. Try again in a moment.",
    );
  });

  it("leaves any other failure to the caller", () => {
    expect(tooManyRequestsMessage(intl, new ApiError("POST failed: 400", 400, "text_too_long", { max: 10 }))).toBeUndefined();
    expect(tooManyRequestsMessage(intl, new Error("network"))).toBeUndefined();
  });
});
