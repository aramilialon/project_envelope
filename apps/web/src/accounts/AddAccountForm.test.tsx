import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import * as accountsApi from "./api.ts";
import AddAccountForm from "./AddAccountForm.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

function renderForm(onCreated = vi.fn(), onClose = vi.fn()) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  renderWithIntl(<AddAccountForm workspaceId="ws-1" baseCurrency="EUR" onClose={onClose} onCreated={onCreated} />);
  return { onCreated, onClose };
}

describe("AddAccountForm (#51)", () => {
  it("creates a plain account with no starting balance", async () => {
    const createAccount = vi.spyOn(accountsApi, "createAccount").mockResolvedValue({
      id: "a1",
      workspaceId: "ws-1",
      name: "Savings",
      type: "savings",
      currency: "EUR",
      onBudget: true,
      paymentCategoryId: null,
      closedAt: null,
      createdAt: "2026-01-01",
    });
    const { onCreated } = renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Savings" } });
    fireEvent.click(screen.getByRole("radio", { name: "Savings" }));
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    await waitFor(() =>
      expect(createAccount).toHaveBeenCalledWith("t", "ws-1", {
        name: "Savings",
        type: "savings",
        currency: "EUR",
        onBudget: true,
      }),
    );
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it("only shows the amount owed when the type is an on-budget credit card", () => {
    renderForm();

    expect(screen.queryByLabelText(/owe on this card/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Credit card" }));
    expect(screen.getByLabelText(/owe on this card/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("On budget"));
    expect(screen.queryByLabelText(/owe on this card/)).not.toBeInTheDocument();
  });

  it("negates the entered amount owed into a starting balance", async () => {
    const createAccount = vi.spyOn(accountsApi, "createAccount").mockResolvedValue({
      id: "a1",
      workspaceId: "ws-1",
      name: "Visa",
      type: "credit_card",
      currency: "EUR",
      onBudget: true,
      paymentCategoryId: "c1",
      closedAt: null,
      createdAt: "2026-01-01",
    });
    renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Visa" } });
    fireEvent.click(screen.getByRole("radio", { name: "Credit card" }));
    fireEvent.change(screen.getByLabelText(/owe on this card/), { target: { value: "123.45" } });
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    await waitFor(() =>
      expect(createAccount).toHaveBeenCalledWith("t", "ws-1", {
        name: "Visa",
        type: "credit_card",
        currency: "EUR",
        onBudget: true,
        startingBalanceCents: -12345,
      }),
    );
  });

  it("rejects an unparseable amount without submitting", async () => {
    const createAccount = vi.spyOn(accountsApi, "createAccount");
    renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Visa" } });
    fireEvent.click(screen.getByRole("radio", { name: "Credit card" }));
    fireEvent.change(screen.getByLabelText(/owe on this card/), { target: { value: "not a number" } });
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid amount.");
    expect(createAccount).not.toHaveBeenCalled();
  });

  it("calls onClose when cancelled", () => {
    const { onClose } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
