import type { IntlShape } from "react-intl";

import { ApiError } from "./apiFetch.ts";

/**
 * Whether `caught` is the API refusing a write to a closed account (#729, ADR 0018: 409
 * `account_closed`): a row of the account itself, or a transfer whose other leg is on it.
 */
export function isAccountClosed(caught: unknown): caught is ApiError {
  return caught instanceof ApiError && caught.code === "account_closed";
}

/** Whether `caught` is the API refusing a request over one of its rate limits (#566, 429 `too_many_requests`). */
export function isTooManyRequests(caught: unknown): caught is ApiError {
  return caught instanceof ApiError && caught.code === "too_many_requests";
}

/**
 * How many seconds the API asked to wait before trying a refused request again
 * (`details.retryAfterSeconds`, #566), or undefined when it is not a rate-limit refusal or the
 * API sent no usable wait.
 */
export function retryAfterSeconds(caught: unknown): number | undefined {
  if (!isTooManyRequests(caught)) {
    return undefined;
  }
  const seconds = Number(caught.details.retryAfterSeconds);
  return Number.isInteger(seconds) && seconds > 0 ? seconds : undefined;
}

/**
 * The message for a request the API refused as over one of its rate limits (#566, 429
 * `too_many_requests`), saying how long to wait when the API said so; undefined for any other
 * failure, which the caller describes itself. Saves show it in place of their own error (they are
 * never retried automatically); loads show it while `useFetchState` waits to retry them (#683).
 */
export function tooManyRequestsMessage(intl: IntlShape, caught: unknown): string | undefined {
  if (!isTooManyRequests(caught)) {
    return undefined;
  }
  const seconds = retryAfterSeconds(caught);
  if (seconds !== undefined) {
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
