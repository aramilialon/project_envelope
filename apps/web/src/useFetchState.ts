import { useCallback, useEffect, useState } from "react";

export type FetchState<T> = { readonly status: "loading" } | { readonly status: "error" } | ({ readonly status: "ok" } & T);

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
    promise
      .then((result) => {
        if (!cancelled) {
          setState({ status: "ok", ...result });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
    // `fetcher` closes over exactly `deps` (the caller's own discipline, same as every hook this
    // replaces); `key` already represents it, so re-running on `key`/`generation` alone is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, generation]);

  const refetch = useCallback(() => setGeneration((g) => g + 1), []);

  return { ...state, refetch };
}
