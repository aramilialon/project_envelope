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
