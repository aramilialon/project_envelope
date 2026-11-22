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
      cashOverspending={0}
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
    const { onAssignFromUnassigned } = renderDetail({ available: -25_433, cashOverspending: 25_433, uncovered: 24_567, owed: 24_567, hasStartingBalance: true });

    const row = (label: string) => screen.getByText(label).closest(".qa")!;
    expect(row("Card balance")).toHaveTextContent("€245.67");
    expect(row("Set aside")).toHaveTextContent("€0.00");
    expect(row("Paid beyond what was set aside")).toHaveTextContent("€254.33");
    expect(row("Paid beyond what was set aside").querySelector(".warnl")).toBeNull();
    expect(row("To cover")).toHaveTextContent("€500.00");
    expect(screen.queryByText("Credit on the card")).not.toBeInTheDocument();
    expect(screen.queryByText(/[-−]€/)).not.toBeInTheDocument(); // "Set aside to pay the card" too

    fireEvent.click(screen.getByRole("button", { name: "Assign €500.00 from unassigned money" }));
    expect(onAssignFromUnassigned).toHaveBeenCalled();
  });

  it("explains what was paid beyond what was set aside first, then the starting balance, without saying it takes nothing from unassigned money (#699)", () => {
    renderDetail({ available: -25_433, cashOverspending: 25_433, uncovered: 24_567, owed: 24_567, hasStartingBalance: true });

    const sentences = [...document.querySelectorAll(".explain")].map((p) => p.textContent);
    expect(sentences).toEqual([
      "The card was paid €254.33 more than was set aside for it. Cover it here this month, or it comes out of next month's unassigned money.",
      "Some of this debt was already there when you added the card — its starting balance. Assign money to this category a bit at a time to cover it.",
    ]);
    expect(screen.queryByText(/takes nothing from unassigned money/)).not.toBeInTheDocument();
  });

  it("a card paid exactly its debt from cash (owed 0, available −€300): only the paid-beyond sentence, and €300.00 to cover (#699)", () => {
    renderDetail({ available: -30_000, cashOverspending: 30_000, uncovered: 0, owed: 0, hasStartingBalance: true });

    const sentences = [...document.querySelectorAll(".explain")].map((p) => p.textContent);
    expect(sentences).toEqual([
      "The card was paid €300.00 more than was set aside for it. Cover it here this month, or it comes out of next month's unassigned money.",
    ]);
    const row = (label: string) => screen.getByText(label).closest(".qa")!;
    expect(row("Card balance")).toHaveTextContent("€0.00");
    expect(row("Set aside")).toHaveTextContent("€0.00");
    expect(row("Paid beyond what was set aside")).toHaveTextContent("€300.00");
    expect(row("To cover")).toHaveTextContent("€300.00");
    expect(screen.getByRole("button", { name: "Assign €300.00 from unassigned money" })).toBeInTheDocument();
  });

  it("a card in credit holding its payment category at minus the credit: nothing to cover, no paid-beyond line (#660)", () => {
    renderDetail({ available: -3_000, cashOverspending: 0, uncovered: 0, owed: -3_000 });

    expect(screen.queryByText(/more than was set aside for it/)).not.toBeInTheDocument();
    expect(screen.queryByText("To cover")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Assign/ })).not.toBeInTheDocument();
  });

  it("a card in credit with nothing to cover says it is in credit, never 'fully covered by money set aside' (#660)", () => {
    renderDetail({ available: -3_000, cashOverspending: 0, uncovered: 0, owed: -3_000 });

    const sentences = [...document.querySelectorAll(".explain")].map((p) => p.textContent);
    expect(sentences).toEqual(["The card is in credit by €30.00. Card spending uses up this credit first; there is nothing to cover."]);
    expect(screen.queryByText(/fully covered/)).not.toBeInTheDocument();
  });

  it("a card in credit with money set aside too still says it is in credit (#660)", () => {
    renderDetail({ available: 2_000, cashOverspending: 0, uncovered: 0, owed: -1_000 });

    expect(screen.getByText("The card is in credit by €10.00. Card spending uses up this credit first; there is nothing to cover.")).toBeInTheDocument();
    expect(screen.queryByText(/fully covered/)).not.toBeInTheDocument();
  });

  it("a card in credit by €10 with its payment category at −€50: €40.00 paid beyond and to cover (#660)", () => {
    renderDetail({ available: -5_000, cashOverspending: 4_000, uncovered: 0, owed: -1_000 });

    const sentences = [...document.querySelectorAll(".explain")].map((p) => p.textContent);
    expect(sentences).toEqual([
      "The card was paid €50.00 more than was set aside. €10.00 of it is still on the card as credit. If the other €40.00 is still uncovered when the month ends, it comes out of next month's unassigned money.",
    ]);
    const row = (label: string) => screen.getByText(label).closest(".qa")!;
    expect(row("Paid beyond what was set aside")).toHaveTextContent("€40.00");
    expect(row("To cover")).toHaveTextContent("€40.00");
    // The credit takes the card balance's place: one positive line, no negative balance beside it.
    const labels = [...document.querySelectorAll(".qa > span:first-child")].map((s) => s.textContent);
    expect(labels).toEqual(["Credit on the card", "Set aside", "Paid beyond what was set aside", "To cover"]);
    expect(row("Credit on the card")).toHaveTextContent("€10.00");
    expect(screen.queryByText("Card balance")).not.toBeInTheDocument();
    expect(screen.queryByText(/[-−]€/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assign €40.00 from unassigned money" })).toBeInTheDocument();
  });

  it("keeps the starting-balance sentence whole when nothing was paid beyond what was set aside", () => {
    renderDetail({ available: 0, uncovered: 50_000, owed: 50_000, hasStartingBalance: true });
    expect(screen.getByText(/It does not come from new spending, so it takes nothing from unassigned money\./)).toBeInTheDocument();
    expect(screen.queryByText(/more than was set aside for it/)).not.toBeInTheDocument();
  });

  it("a card known to owe nothing, with nothing to cover: says it owes nothing, not 'fully covered by money set aside' (#660)", () => {
    renderDetail({ available: 2_000, uncovered: 0, owed: 0 });

    const sentences = [...document.querySelectorAll(".explain")].map((p) => p.textContent);
    expect(sentences).toEqual(["The card owes nothing right now; there is nothing to cover."]);
    expect(screen.queryByText("To cover")).not.toBeInTheDocument();
  });

  it("a card whose balance is not known keeps the generic 'fully covered' sentence", () => {
    renderDetail({ available: 2_000, uncovered: 0, owed: undefined });
    expect(screen.getByText(/fully covered by money set aside/)).toBeInTheDocument();
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
