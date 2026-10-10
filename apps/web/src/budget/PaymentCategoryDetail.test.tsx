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
  it("shows money set aside, and a generic 'fully covered' sentence when nothing is uncovered", () => {
    renderDetail({ available: 50_000, uncovered: 0 });

    expect(screen.getByText("€500.00")).toBeInTheDocument();
    expect(screen.getByText(/fully covered by money set aside/)).toBeInTheDocument();
    expect(screen.queryByText("Card balance")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Assign/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move money here" })).not.toBeInTheDocument();
  });

  it("shows the debt meter and a generic 'some debt uncovered' sentence when it is not", () => {
    renderDetail({ available: 30_000, uncovered: 12_000 });

    expect(screen.getByText(/Some of the card's debt has no money set aside yet/)).toBeInTheDocument();
    expect(screen.getByText("Card balance")).toBeInTheDocument();
    expect(screen.getByText("€420.00")).toBeInTheDocument(); // 30,000 + 12,000 available+uncovered
    expect(screen.getByText("€120.00")).toBeInTheDocument(); // uncovered, "To cover"
  });

  it("shows the starting-balance sentence when the card has one, even with named categories also given (#355)", () => {
    renderDetail({
      available: 30_000,
      uncovered: 12_000,
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
    const { onAssignFromUnassigned } = renderDetail({ available: 0, uncovered: 5_000 });
    fireEvent.click(screen.getByRole("button", { name: "Assign €50.00 from unassigned money" }));
    expect(onAssignFromUnassigned).toHaveBeenCalled();
  });

  it("'Move money here' calls onMoveMoneyHere", () => {
    const { onMoveMoneyHere } = renderDetail({ available: 0, uncovered: 5_000 });
    fireEvent.click(screen.getByRole("button", { name: "Move money here" }));
    expect(onMoveMoneyHere).toHaveBeenCalled();
  });

  it("the '× Close' button calls onClose", () => {
    const { onClose } = renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "× Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
