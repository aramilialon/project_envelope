import { MAX_AMOUNT_CENTS } from "@envelope/core";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../apiFetch.ts";
import { AMOUNT_TOO_LARGE_EUR, renderWithIntl, typedAmount } from "../test-utils.tsx";
import * as accountsApi from "./api.ts";
import AddAccountForm from "./AddAccountForm.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

function renderForm(onCreated = vi.fn(), onClose = vi.fn(), taxCountry: string | null = null) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  renderWithIntl(
    <AddAccountForm workspaceId="ws-1" baseCurrency="EUR" taxCountry={taxCountry} onClose={onClose} onCreated={onCreated} />,
  );
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

  it("only shows the amount owed once the type is a credit card", () => {
    renderForm();

    expect(screen.queryByLabelText(/owe on this card/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Credit card" }));
    expect(screen.getByLabelText(/owe on this card/)).toBeInTheDocument();
  });

  it("shows the 'On budget' choice only for a savings account — every other type is always on budget (#402)", async () => {
    const createAccount = vi.spyOn(accountsApi, "createAccount").mockResolvedValue({
      id: "a1",
      workspaceId: "ws-1",
      name: "Wallet",
      type: "cash",
      currency: "EUR",
      onBudget: true,
      paymentCategoryId: null,
      closedAt: null,
      createdAt: "2026-01-01",
    });
    renderForm();

    expect(screen.queryByLabelText("On budget")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Savings" }));
    expect(screen.getByLabelText("On budget")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Checking" }));
    expect(screen.queryByLabelText("On budget")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Cash" }));
    expect(screen.queryByLabelText("On budget")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Credit card" }));
    expect(screen.queryByLabelText("On budget")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Cash" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Wallet" } });
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    await waitFor(() =>
      expect(createAccount).toHaveBeenCalledWith(
        "t",
        "ws-1",
        expect.objectContaining({ type: "cash", onBudget: true }),
      ),
    );
  });

  it("names and explains each account type", () => {
    renderForm();

    expect(screen.getByText("Salary, bills, debit card")).toBeInTheDocument();
    expect(screen.getByText("Money set aside, on or off budget as you choose")).toBeInTheDocument();
    expect(screen.getByText("Your wallet")).toBeInTheDocument();
    expect(screen.getByText("Debt you pay off, with its own payment category")).toBeInTheDocument();
    expect(screen.getByText("Investments, always off budget")).toBeInTheDocument();
  });

  it("creates a brokerage account off budget, with no 'On budget' choice (#74)", async () => {
    const createAccount = vi.spyOn(accountsApi, "createAccount").mockResolvedValue({
      id: "a1",
      workspaceId: "ws-1",
      name: "Broker",
      type: "brokerage",
      currency: "EUR",
      onBudget: false,
      paymentCategoryId: null,
      closedAt: null,
      createdAt: "2026-01-01",
    });
    renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Broker" } });
    fireEvent.click(screen.getByRole("radio", { name: "Brokerage" }));
    expect(screen.queryByLabelText("On budget")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/owe on this card/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    await waitFor(() =>
      expect(createAccount).toHaveBeenCalledWith("t", "ws-1", {
        name: "Broker",
        type: "brokerage",
        currency: "EUR",
        onBudget: false,
      }),
    );
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

  it("says how large an amount owed can be when the typed one is above the cap (#651)", async () => {
    const createAccount = vi.spyOn(accountsApi, "createAccount");
    renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Visa" } });
    fireEvent.click(screen.getByRole("radio", { name: "Credit card" }));
    fireEvent.change(screen.getByLabelText(/owe on this card/), { target: { value: typedAmount(MAX_AMOUNT_CENTS + 1) } });
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(AMOUNT_TOO_LARGE_EUR);
    expect(createAccount).not.toHaveBeenCalled();
    createAccount.mockRestore();
  });

  it("says the same when the API answers amount_too_large for the starting balance (#651)", async () => {
    const createAccount = vi
      .spyOn(accountsApi, "createAccount")
      .mockRejectedValue(
        new ApiError("POST failed: 400", 400, "amount_too_large", { label: "startingBalance", max: MAX_AMOUNT_CENTS, value: String(-MAX_AMOUNT_CENTS - 1) }),
      );
    const { onCreated } = renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Visa" } });
    fireEvent.click(screen.getByRole("radio", { name: "Credit card" }));
    fireEvent.change(screen.getByLabelText(/owe on this card/), { target: { value: typedAmount(MAX_AMOUNT_CENTS) } });
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(AMOUNT_TOO_LARGE_EUR);
    expect(onCreated).not.toHaveBeenCalled();
    createAccount.mockRestore();
  });

  it("clears a previous error when the account type changes", async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Visa" } });
    fireEvent.click(screen.getByRole("radio", { name: "Credit card" }));
    fireEvent.change(screen.getByLabelText(/owe on this card/), { target: { value: "not a number" } });
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid amount.");

    fireEvent.click(screen.getByRole("radio", { name: "Brokerage" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  const BROKER = {
    id: "a1",
    workspaceId: "ws-1",
    name: "Broker",
    type: "brokerage" as const,
    currency: "EUR",
    onBudget: false,
    paymentCategoryId: null,
    closedAt: null,
    createdAt: "2026-01-01",
  };
  const AGENT_LABEL = "The broker is an Italian withholding agent";

  it("asks a brokerage account's tax regime only in an IT workspace, with no regime preselected (#508)", () => {
    renderForm(vi.fn(), vi.fn(), "IT");

    expect(screen.queryByRole("group", { name: "Tax regime" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Brokerage" }));
    const group = screen.getByRole("group", { name: "Tax regime" });
    expect(group).toHaveAccessibleDescription(
      "How gains on this account are taxed. Your broker's contract or tax statements say which one.",
    );
    for (const [name, hint] of [
      ["Self-declared", "You report gains and losses in your tax return"],
      ["Administered", "The broker works out and withholds the tax on each gain"],
      ["Managed", "A manager runs the account under a mandate and taxes the result"],
    ] as const) {
      const radio = screen.getByRole("radio", { name });
      expect(radio).not.toBeChecked();
      expect(radio).toHaveAccessibleDescription(hint);
    }

    fireEvent.click(screen.getByRole("radio", { name: "Savings" }));
    expect(screen.queryByRole("group", { name: "Tax regime" })).not.toBeInTheDocument();
  });

  it("asks about the withholding agent only for a self-declared regime", () => {
    renderForm(vi.fn(), vi.fn(), "IT");
    fireEvent.click(screen.getByRole("radio", { name: "Brokerage" }));
    expect(screen.queryByLabelText(AGENT_LABEL, { exact: false })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Self-declared" }));
    const checkbox = screen.getByRole("checkbox", { name: new RegExp(AGENT_LABEL) });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toHaveAccessibleDescription("It withholds Italian tax at source on dividends, coupons and fund income.");

    for (const name of ["Administered", "Managed"]) {
      fireEvent.click(screen.getByRole("radio", { name }));
      expect(screen.queryByRole("checkbox", { name: new RegExp(AGENT_LABEL) })).not.toBeInTheDocument();
    }
  });

  it("does not ask for a tax regime outside an IT workspace", () => {
    renderForm(vi.fn(), vi.fn(), null);
    fireEvent.click(screen.getByRole("radio", { name: "Brokerage" }));
    expect(screen.queryByRole("group", { name: "Tax regime" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: new RegExp(AGENT_LABEL) })).not.toBeInTheDocument();
  });

  it("requires the regime, then sends an administered account's broker as a withholding agent", async () => {
    const createAccount = vi.spyOn(accountsApi, "createAccount").mockResolvedValue(BROKER);
    renderForm(vi.fn(), vi.fn(), "IT");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Broker" } });
    fireEvent.click(screen.getByRole("radio", { name: "Brokerage" }));
    expect(screen.getByRole("button", { name: "Add account" })).toBeDisabled();

    fireEvent.click(screen.getByRole("radio", { name: "Administered" }));
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    await waitFor(() =>
      expect(createAccount).toHaveBeenCalledWith("t", "ws-1", {
        name: "Broker",
        type: "brokerage",
        currency: "EUR",
        onBudget: false,
        taxRegime: "administered",
        domesticWithholdingAgent: true,
      }),
    );
  });

  it("sends a self-declared account's withholding agent as checked", async () => {
    const createAccount = vi.spyOn(accountsApi, "createAccount").mockResolvedValue(BROKER);
    renderForm(vi.fn(), vi.fn(), "IT");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Broker" } });
    fireEvent.click(screen.getByRole("radio", { name: "Brokerage" }));
    fireEvent.click(screen.getByRole("radio", { name: "Self-declared" }));
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    await waitFor(() =>
      expect(createAccount).toHaveBeenCalledWith(
        "t",
        "ws-1",
        expect.objectContaining({ taxRegime: "self_declared", domesticWithholdingAgent: false }),
      ),
    );
  });

  it("names the API's tax-settings refusals", async () => {
    useAuth.mockReturnValue({ user: { access_token: "t" } });
    for (const [code, message] of [
      ["tax_regime_required", "Choose this account's tax regime."],
      ["tax_regime_not_applicable", "A tax regime applies only to a brokerage account in a workspace whose tax country is Italy."],
      [
        "tax_regime_requires_withholding_agent",
        "An administered or managed account needs a broker that is an Italian withholding agent.",
      ],
    ] as const) {
      vi.spyOn(accountsApi, "createAccount").mockRejectedValueOnce(new accountsApi.AccountTaxError(code));
      const { unmount } = renderWithIntl(
        <AddAccountForm workspaceId="ws-1" baseCurrency="EUR" taxCountry="IT" onClose={vi.fn()} onCreated={vi.fn()} />,
      );
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Broker" } });
      fireEvent.click(screen.getByRole("radio", { name: "Brokerage" }));
      fireEvent.click(screen.getByRole("radio", { name: "Managed" }));
      fireEvent.click(screen.getByRole("button", { name: "Add account" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      unmount();
    }
  });

  it("calls onClose when cancelled", () => {
    const { onClose } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
