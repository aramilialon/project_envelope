import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import PaymentCategoryDetail from "./PaymentCategoryDetail.tsx";

function renderDetail(overrides: Partial<Parameters<typeof PaymentCategoryDetail>[0]> = {}) {
  const onClose = vi.fn();
  const onAssignFromUnassigned = vi.fn();
  const onMoveMoneyHere = vi.fn();
  renderWithIntl(
    <PaymentCategoryDetail
      categoryName="Visa payment"
      available={50_000}
      uncovered={0}
      owed={0}
      currency="EUR"
      onClose={onClose}
      onAssignFromUnassigned={onAssignFromUnassigned}
      onMoveMoneyHere={onMoveMoneyHere}
      {...overrides}
    />,
  );
  return { onClose, onAssignFromUnassigned, onMoveMoneyHere };
}

describe("PaymentCategoryDetail (#329)", () => {
  it("a card paid beyond what was set aside: its real debt, set aside never negative, a neutral line for the excess, and the whole amount to cover (#699)", () => {
    // The domain guide's worked example: opened owing €500, €45.67 spent on it (covered), €300
    // paid from checking, nothing assigned to the payment category.
    const { onAssignFromUnassigned } = renderDetail({ available: -25_433, uncovered: 24_567, owed: 24_567, hasStartingBalance: true });

    const row = (label: string) => screen.getByText(label).closest(".qa")!;
    expect(row("Card balance")).toHaveTextContent("€245.67");
    expect(row("Set aside")).toHaveTextContent("€0.00");
    expect(row("Paid beyond what was set aside")).toHaveTextContent("€254.33");
    expect(row("Paid beyond what was set aside").querySelector(".warnl")).toBeNull();
    expect(row("To cover")).toHaveTextContent("€500.00");
    expect(screen.queryByText(/[-−]€/)).not.toBeInTheDocument(); // "Set aside to pay the card" too

    fireEvent.click(screen.getByRole("button", { name: "Assign €500.00 from unassigned money" }));
    expect(onAssignFromUnassigned).toHaveBeenCalled();
  });

  it("shows money set aside, and a generic 'fully covered' sentence when nothing is uncovered", () => {
    renderDetail({ available: 50_000, uncovered: 0, owed: 40_000 });

    expect(screen.getByText("€500.00")).toBeInTheDocument();
    expect(screen.getByText(/fully covered by money set aside/)).toBeInTheDocument();
    expect(screen.queryByText("Card balance")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Assign/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move money here" })).not.toBeInTheDocument();
  });

  it("shows the debt meter and a generic 'some debt uncovered' sentence when it is not", () => {
    renderDetail({ available: 30_000, uncovered: 12_000, owed: 42_000 });

    expect(screen.getByText(/Some of the card's debt has no money set aside yet/)).toBeInTheDocument();
    expect(screen.getByText("Card balance")).toBeInTheDocument();
    expect(screen.getByText("€420.00")).toBeInTheDocument(); // owed
    expect(screen.getByText("€120.00")).toBeInTheDocument(); // uncovered, "To cover"
    expect(screen.queryByText("Paid beyond what was set aside")).not.toBeInTheDocument();
  });

  it("shows the starting-balance sentence when the card has one, even with named categories also given (#355)", () => {
    renderDetail({
      available: 30_000,
      uncovered: 12_000,
      owed: 42_000,
      hasStartingBalance: true,
      overspendingBy: [{ categoryId: "c1", name: "Groceries", amount: 3_000 }],
    });

    expect(screen.getByText(/already there when you added the card/)).toBeInTheDocument();
    expect(screen.queryByText(/comes from card spending beyond what was available/)).not.toBeInTheDocument();
  });

  it("names the categories whose card spending caused the uncovered debt (#355)", () => {
    renderDetail({
      available: 30_000,
      uncovered: 12_000,
      owed: 42_000,
      overspendingBy: [
        { categoryId: "c1", name: "Groceries", amount: 3_000 },
        { categoryId: "c2", name: "Fun", amount: 9_000 },
      ],
    });

    const explain = screen.getByText(/comes from card spending beyond what was available/);
    expect(explain).toHaveTextContent("Groceries (€30.00)");
    expect(explain).toHaveTextContent("Fun (€90.00)");
  });

  it("'Assign from unassigned money' calls onAssignFromUnassigned", () => {
    const { onAssignFromUnassigned } = renderDetail({ available: 0, uncovered: 5_000, owed: 5_000 });
    fireEvent.click(screen.getByRole("button", { name: "Assign €50.00 from unassigned money" }));
    expect(onAssignFromUnassigned).toHaveBeenCalled();
  });

  it("'Move money here' calls onMoveMoneyHere", () => {
    const { onMoveMoneyHere } = renderDetail({ available: 0, uncovered: 5_000, owed: 5_000 });
    fireEvent.click(screen.getByRole("button", { name: "Move money here" }));
    expect(onMoveMoneyHere).toHaveBeenCalled();
  });

  it("the '× Close' button calls onClose", () => {
    const { onClose } = renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "× Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
