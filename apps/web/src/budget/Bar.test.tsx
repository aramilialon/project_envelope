import type { Bar as BarGeometry } from "@envelope/core";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Bar from "./Bar.tsx";

describe("Bar (#324)", () => {
  it("renders an empty track when there is no budget", () => {
    const bar: BarGeometry = { kind: "category", hasBudget: false, spentPercent: 0, reserved: undefined, tail: undefined };
    const { container } = render(<Bar bar={bar} />);
    expect(container.querySelector(".tr.empty")).not.toBeNull();
    expect(container.querySelector(".tail")).toBeNull();
  });

  it("renders the spent portion of the track", () => {
    const bar: BarGeometry = { kind: "category", hasBudget: true, spentPercent: 50, reserved: undefined, tail: undefined };
    const { container } = render(<Bar bar={bar} />);
    const spent = container.querySelector(".sp");
    expect(spent).not.toBeNull();
    expect((spent as HTMLElement).style.width).toBe("50%");
    expect(container.querySelector(".tr.empty")).toBeNull();
  });

  it("renders a reserved stripe positioned after the spent portion", () => {
    const bar: BarGeometry = {
      kind: "category",
      hasBudget: true,
      spentPercent: 30,
      reserved: { leftPercent: 30, widthPercent: 20 },
      tail: undefined,
    };
    const { container } = render(<Bar bar={bar} />);
    const reserved = container.querySelector(".rs") as HTMLElement;
    expect(reserved.style.left).toBe("30%");
    expect(reserved.style.width).toBe("20%");
  });

  it("renders a cash-overspending tail as a solid red block", () => {
    const bar: BarGeometry = { kind: "category", hasBudget: true, spentPercent: 100, reserved: undefined, tail: { kind: "cash", widthPercent: 7 } };
    const { container } = render(<Bar bar={bar} />);
    const tail = container.querySelector(".tail") as HTMLElement;
    expect(tail.classList.contains("cash")).toBe(true);
    expect(tail.style.left).toBe("82%");
    expect(tail.style.width).toBe("7%");
  });

  it("renders a credit-overspending tail", () => {
    const bar: BarGeometry = { kind: "category", hasBudget: true, spentPercent: 100, reserved: undefined, tail: { kind: "credit", widthPercent: 10 } };
    const { container } = render(<Bar bar={bar} />);
    expect(container.querySelector(".tail.credit")).not.toBeNull();
  });

  it("renders an uncovered reservation as a dashed 'short' tail", () => {
    const bar: BarGeometry = { kind: "category", hasBudget: true, spentPercent: 0, reserved: { leftPercent: 0, widthPercent: 100 }, tail: { kind: "short", widthPercent: 18 } };
    const { container } = render(<Bar bar={bar} />);
    expect(container.querySelector(".tail.short")).not.toBeNull();
  });

  it("renders a payment category with nothing uncovered as a plain track", () => {
    const bar: BarGeometry = { kind: "payment", uncovered: undefined };
    const { container } = render(<Bar bar={bar} />);
    expect(container.querySelector(".uc")).toBeNull();
    expect(container.querySelector(".tr")).not.toBeNull();
  });

  it("renders a payment category's uncovered debt", () => {
    const bar: BarGeometry = { kind: "payment", uncovered: { leftPercent: 40, widthPercent: 60 } };
    const { container } = render(<Bar bar={bar} />);
    const uc = container.querySelector(".uc") as HTMLElement;
    expect(uc.style.left).toBe("40%");
    expect(uc.style.width).toBe("60%");
  });
});
