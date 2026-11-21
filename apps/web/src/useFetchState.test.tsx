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

  it("waits 5 seconds when the API named no wait", async () => {
    const fetcher = vi.fn<() => Promise<{ value: number }>>().mockRejectedValueOnce(tooManyRequests()).mockResolvedValueOnce({ value: 2 });
    const { result } = renderHook(() => useFetchState(fetcher, ["k"]));
    await flush();
    expect(result.current.status).toBe("error");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ status: "ok", value: 2 });
  });

  it("drops a pending retry once deps change", async () => {
    const fetcher = vi.fn<(month: string) => Promise<{ value: number }>>((month) =>
      month === "a" ? Promise.reject(tooManyRequests(5)) : Promise.resolve({ value: 20 }),
    );
    const { result, rerender } = renderHook(({ month }: { month: string }) => useFetchState(() => fetcher(month), [month]), {
      initialProps: { month: "a" },
    });
    await flush();
    expect(result.current.status).toBe("error");

    rerender({ month: "b" });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await flush();
    expect(fetcher.mock.calls.map(([m]) => m)).toEqual(["a", "b"]);
    expect(result.current).toMatchObject({ status: "ok", value: 20 });
  });

  it("ignores a retry's late answer once deps change", async () => {
    let resolveLate: (value: { value: number }) => void = () => {};
    const late = new Promise<{ value: number }>((resolve) => {
      resolveLate = resolve;
    });
    let callsForA = 0;
    const fetcher = vi.fn<(month: string) => Promise<{ value: number }>>((month) => {
      if (month === "a") {
        callsForA += 1;
        return callsForA === 1 ? Promise.reject(tooManyRequests(5)) : late;
      }
      return Promise.resolve({ value: 20 });
    });
    const { result, rerender } = renderHook(({ month }: { month: string }) => useFetchState(() => fetcher(month), [month]), {
      initialProps: { month: "a" },
    });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(callsForA).toBe(2);

    rerender({ month: "b" });
    await flush();
    expect(result.current).toMatchObject({ status: "ok", value: 20 });

    resolveLate({ value: 10 });
    await flush();
    expect(result.current).toMatchObject({ status: "ok", value: 20 });
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
