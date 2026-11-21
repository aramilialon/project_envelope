import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./apiFetch.ts";
import { RATE_LIMIT_MAX_RETRIES, useFetchState } from "./useFetchState.ts";

function tooManyRequests(retryAfterSeconds?: number): ApiError {
  return new ApiError("GET /x failed: 429", 429, "too_many_requests", retryAfterSeconds === undefined ? {} : { retryAfterSeconds });
}

/** Lets the fetcher's promise chain settle inside `act`. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useFetchState over the API's rate limit (#683)", () => {
  it("waits the API's retryAfterSeconds, retries, and recovers", async () => {
    const fetcher = vi.fn<() => Promise<{ value: number }>>().mockRejectedValueOnce(tooManyRequests(3)).mockResolvedValueOnce({ value: 7 });
    const { result } = renderHook(() => useFetchState(fetcher, ["k"]));
    await flush();

    expect(result.current.status).toBe("error");
    expect(result.current.status === "error" && result.current.error).toBeInstanceOf(ApiError);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2999);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ status: "ok", value: 7 });
  });

  it("caps the wait at 60 seconds whatever the API asked", async () => {
    const fetcher = vi.fn<() => Promise<{ value: number }>>().mockRejectedValueOnce(tooManyRequests(3600)).mockResolvedValueOnce({ value: 1 });
    const { result } = renderHook(() => useFetchState(fetcher, ["k"]));
    await flush();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("ok");
  });

  it("gives up after a bounded number of retries and stays in error", async () => {
    const fetcher = vi.fn<() => Promise<{ value: number }>>().mockRejectedValue(tooManyRequests(1));
    const { result } = renderHook(() => useFetchState(fetcher, ["k"]));
    await flush();

    for (let i = 0; i < RATE_LIMIT_MAX_RETRIES + 3; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      await flush();
    }
    expect(fetcher).toHaveBeenCalledTimes(1 + RATE_LIMIT_MAX_RETRIES);
    expect(result.current.status).toBe("error");
  });

  it("does not retry any other failure", async () => {
    const fetcher = vi.fn<() => Promise<{ value: number }>>().mockRejectedValue(new ApiError("GET /x failed: 500", 500, "internal", {}));
    renderHook(() => useFetchState(fetcher, ["k"]));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("drops a pending retry once unmounted", async () => {
    const fetcher = vi.fn<() => Promise<{ value: number }>>().mockRejectedValueOnce(tooManyRequests(5)).mockResolvedValueOnce({ value: 1 });
    const { unmount } = renderHook(() => useFetchState(fetcher, ["k"]));
    await flush();
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
