import type { IntlShape } from "react-intl";

import { ApiError } from "./apiFetch.ts";

/**
 * The message for a request the API refused as over one of its rate limits (#566, 429
 * `too_many_requests`), saying how long to wait when the API said so; undefined for any other
 * failure, which the caller describes itself.
 */
export function tooManyRequestsMessage(intl: IntlShape, caught: unknown): string | undefined {
  if (!(caught instanceof ApiError) || caught.code !== "too_many_requests") {
    return undefined;
  }
  const seconds = Number(caught.details.retryAfterSeconds);
  if (Number.isInteger(seconds) && seconds > 0) {
    return intl.formatMessage(
      {
        id: "api.error.tooManyRequests",
        defaultMessage: "Too many requests in a short time. Try again in {seconds, plural, one {# second} other {# seconds}}.",
      },
      { seconds },
    );
  }
  return intl.formatMessage({
    id: "api.error.tooManyRequestsSoon",
    defaultMessage: "Too many requests in a short time. Try again in a moment.",
  });
}
