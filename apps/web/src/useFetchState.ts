import { useCallback, useEffect, useState } from "react";

import { isTooManyRequests, retryAfterSeconds } from "./apiErrors.ts";

/**
 * `error` carries what the fetcher threw, so a screen can tell a rate-limit refusal (#683,
 * `tooManyRequestsMessage`) from any other failure and say how long to wait.
 */
export type FetchState<T> = { readonly status: "loading" } | { readonly status: "error"; readonly error: unknown } | ({ readonly status: "ok" } & T);

/** How many times a load refused over the API's rate limit is retried on its own (#683). */
export const RATE_LIMIT_MAX_RETRIES = 2;
/** The longest wait before such a retry, whatever `Retry-After` says. */
export const RATE_LIMIT_MAX_WAIT_SECONDS = 60;
/** The wait when the API named none. */
export const RATE_LIMIT_DEFAULT_WAIT_SECONDS = 5;

export interface UseFetchStateOptions {
  /**
   * Resets to `{ status: "loading" }` the instant `deps` changes, not just on first mount —
   * appropriate when the previous data would be actively wrong against the new deps, not just
   * stale (`useBudgetMonthEvents`'s own case: a different month's events drawn against the
   * wrong day axis and "today" line). Most hooks leave this `false`, the default: swapping
   * straight to the new data once it arrives, without flashing back to a spinner first.
   */
  readonly resetOnDepsChange?: boolean;
}

/**
 * The loading/error/ok shape every data-fetching hook in this app follows: calls `fetcher()`
 * whenever `deps` changes, ignores a stale response if `deps` changed again before it resolved,
 * and exposes `refetch` to re-run it on demand without a real dependency change (an internal
 * generation counter, folded into the effect's own deps). `fetcher` returning `undefined` means
 * "not ready yet" (typically no access token yet): the hook does nothing and stays as it was.
 * `fetcher` rejecting, or throwing inside its own `.then`, lands in `error` — the way
 * `useAccountRegister`'s own extra "was this account actually found" check works.
 *
 * A rejection that is the API refusing the load over its rate limit (#566, 429
 * `too_many_requests`) lands in `error` too, so the screen can show the wait
 * (`tooManyRequestsMessage(intl, state.error)`), and the hook calls `fetcher()` again after the
 * API's `retryAfterSeconds` (at most `RATE_LIMIT_MAX_WAIT_SECONDS`), up to
 * `RATE_LIMIT_MAX_RETRIES` times; a success then replaces the error as usual (#683). Only loads
 * go through here: writes are never retried on their own.
 *
 * `deps` are primitives only (ids, tokens, months — never an object or array), joined into one
 * string key: both the effect's own dependency array and, when `resetOnDepsChange` is set,
 * detecting a change during render.
 */
export function useFetchState<T extends object>(
  fetcher: () => Promise<T> | undefined,
  deps: readonly (string | number | boolean | undefined)[],
  options: UseFetchStateOptions = {},
): FetchState<T> & { refetch(): void } {
  const [state, setState] = useState<FetchState<T>>({ status: "loading" });
  const [generation, setGeneration] = useState(0);
  const key = deps.join("|");

  // React's own "adjusting state when a prop changes" pattern (during render, not an effect), so
  // a reset takes effect before any stale data drawn against the old deps ever paints.
  const [resetForKey, setResetForKey] = useState(key);
  if (key !== resetForKey) {
    setResetForKey(key);
    if (options.resetOnDepsChange) {
      setState({ status: "loading" });
    }
  }

  useEffect(() => {
    const promise = fetcher();
    if (!promise) {
      return;
    }
    let cancelled = false;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (pending: Promise<T>) => {
      pending
        .then((result) => {
          if (!cancelled) {
            setState({ status: "ok", ...result });
          }
        })
        .catch((caught: unknown) => {
          if (cancelled) {
            return;
          }
          setState({ status: "error", error: caught });
          if (isTooManyRequests(caught) && retries < RATE_LIMIT_MAX_RETRIES) {
            retries += 1;
            const seconds = Math.min(retryAfterSeconds(caught) ?? RATE_LIMIT_DEFAULT_WAIT_SECONDS, RATE_LIMIT_MAX_WAIT_SECONDS);
            retryTimer = setTimeout(() => {
              const next = fetcher();
              if (next && !cancelled) {
                settle(next);
              }
            }, seconds * 1000);
          }
        });
    };
    settle(promise);
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
    // `fetcher` closes over exactly `deps` (the caller's own discipline, same as every hook this
    // replaces); `key` already represents it, so re-running on `key`/`generation` alone is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, generation]);

  const refetch = useCallback(() => setGeneration((g) => g + 1), []);

  return { ...state, refetch };
}
