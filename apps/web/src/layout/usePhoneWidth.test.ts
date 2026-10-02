import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { usePhoneWidth } from "./usePhoneWidth.ts";

const ORIGINAL_WIDTH = window.innerWidth;

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
}

describe("usePhoneWidth", () => {
  afterEach(() => {
    setWidth(ORIGINAL_WIDTH);
  });

  it("is false at desktop width", () => {
    setWidth(1440);
    const { result } = renderHook(() => usePhoneWidth());
    expect(result.current).toBe(false);
  });

  it("is true at or below 600px, read synchronously on the first render", () => {
    setWidth(390);
    const { result } = renderHook(() => usePhoneWidth());
    expect(result.current).toBe(true);
  });

  it("updates when the window is resized", () => {
    setWidth(1440);
    const { result } = renderHook(() => usePhoneWidth());
    expect(result.current).toBe(false);

    act(() => {
      setWidth(390);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(true);
  });
});
