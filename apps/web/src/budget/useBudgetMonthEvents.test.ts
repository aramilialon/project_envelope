import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as budgetApi from "./api.ts";
import type { MonthEvent } from "./api.ts";
import { useBudgetMonthEvents } from "./useBudgetMonthEvents.ts";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

describe("useBudgetMonthEvents (#326)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves to the requested month's own events", async () => {
    useAuth.mockReturnValue({ user: { access_token: "t" } });
    const events: MonthEvent[] = [{ date: "2026-09-05", amountCents: -1000, payee: "Supermarket", categoryId: "c1", kind: "recorded" }];
    vi.spyOn(budgetApi, "getBudgetMonthEvents").mockResolvedValue(events);

    const { result } = renderHook(({ month }) => useBudgetMonthEvents("ws-1", month), { initialProps: { month: "2026-09" } });
    expect(result.current).toEqual({ status: "loading" });
    await act(async () => {});
    expect(result.current).toEqual({ status: "ok", events });
  });

  it("goes back to loading on a month change, never showing the previous month's events against the new one", async () => {
    useAuth.mockReturnValue({ user: { access_token: "t" } });
    let resolveSeptember!: (events: MonthEvent[]) => void;
    const septemberEvents: MonthEvent[] = [{ date: "2026-09-05", amountCents: -1000, payee: "September thing", categoryId: "c1", kind: "recorded" }];
    const octoberEvents: MonthEvent[] = [{ date: "2026-10-05", amountCents: -2000, payee: "October thing", categoryId: "c1", kind: "recorded" }];
    vi.spyOn(budgetApi, "getBudgetMonthEvents").mockImplementationOnce(
      () => new Promise((resolve) => { resolveSeptember = resolve; }),
    );

    const { result, rerender } = renderHook(({ month }) => useBudgetMonthEvents("ws-1", month), { initialProps: { month: "2026-09" } });
    await act(async () => {
      resolveSeptember(septemberEvents);
    });
    expect(result.current).toEqual({ status: "ok", events: septemberEvents });

    // Switching to October: the hook must drop September's own events immediately, not keep
    // showing them while October's own request is still pending.
    vi.spyOn(budgetApi, "getBudgetMonthEvents").mockResolvedValue(octoberEvents);
    rerender({ month: "2026-10" });
    expect(result.current).toEqual({ status: "loading" });

    await act(async () => {});
    expect(result.current).toEqual({ status: "ok", events: octoberEvents });
  });
});
