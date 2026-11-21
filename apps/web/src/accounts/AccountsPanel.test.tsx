import { fireEvent, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import * as transactionsApi from "../transactions/api.ts";
import type { Transaction } from "../transactions/api.ts";
import * as accountsApi from "./api.ts";
import type { Account } from "./api.ts";
import AccountsPanel from "./AccountsPanel.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

function account(id: string, name: string, overrides: Partial<Account> = {}): Account {
  return {
    id,
    workspaceId: "ws-1",
    name,
    type: "checking",
    currency: "EUR",
    onBudget: true,
    paymentCategoryId: null,
    closedAt: null,
    createdAt: "2026-01-01",
    ...overrides,
  };
}

function transactionOf(amountCents: number): Transaction {
  return {
    id: `t-${amountCents}`,
    workspaceId: "ws-1",
    accountId: "",
    occurredAt: "2026-09-01",
    budgetDate: "2026-09-01",
    payee: null,
    memo: null,
    status: "cleared",
    transferId: null,
    transferAccountId: null,
    externalId: null,
    createdAt: "2026-09-01",
    splits: [{ id: "s", categoryId: null, amountCents, memo: null }],
  } as unknown as Transaction;
}

const CHECKING = account("checking", "Checking");
const SAVINGS = account("savings", "Savings");
const BROKER = account("broker", "Broker", { type: "savings", onBudget: false });
const VISA = account("visa", "Visa", { type: "credit_card" });
const OLD = account("old", "Old account", { closedAt: "2026-02-01" });

const BALANCES: Record<string, number> = { checking: 341_258, savings: 800_000, broker: 2_150_000, visa: -64_230, old: 0 };

function renderPanel(
  options: {
    accounts?: Account[];
    currentAccountId?: string;
    onClose?: () => void;
    balances?: Record<string, number>;
    /** Accounts whose transactions never arrive, so their balance stays unknown. */
    pending?: string[];
  } = {},
) {
  const balances = options.balances ?? BALANCES;
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  vi.spyOn(accountsApi, "listAccounts").mockResolvedValue(options.accounts ?? [CHECKING, SAVINGS, BROKER, VISA, OLD]);
  const listTransactions = vi
    .spyOn(transactionsApi, "listTransactionsForAccount")
    .mockImplementation((_token, _workspaceId, accountId) =>
      options.pending?.includes(accountId) ? new Promise(() => {}) : Promise.resolve([transactionOf(balances[accountId] ?? 0)]),
    );
  const onClose = options.onClose ?? vi.fn();
  const rendered = renderWithIntl(
    <MemoryRouter initialEntries={["/ws-1"]}>
      <AccountsPanel workspaceId="ws-1" currency="EUR" currentAccountId={options.currentAccountId} refreshKey="" onClose={onClose} />
      <Routes>
        <Route path="/:workspaceId" element={<p>Budget screen</p>} />
        <Route path="/:workspaceId/accounts" element={<p>Accounts screen</p>} />
        <Route path="/:workspaceId/accounts/:accountId" element={<p>Register screen</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return { ...rendered, onClose, listTransactions };
}

describe("AccountsPanel (#412)", () => {
  it("shows the workspace's net worth at its head: every open account, off budget and card debt included", async () => {
    renderPanel();

    // 3,412.58 + 8,000.00 + 21,500.00 − 642.30
    expect(await screen.findByText("€32,270.28")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Net worth" })).toBeInTheDocument();
  });

  it("groups accounts as on budget, credit cards and off budget, leaving closed accounts out", async () => {
    renderPanel();

    // The rows arrive with the account list, their amounts only with the balances fetched after
    // it: the net worth shows once every balance is in.
    await screen.findByText("€32,270.28");
    const onBudget = screen.getByRole("region", { name: "On budget" });
    expect(within(onBudget).getAllByRole("button").map((b) => b.textContent)).toEqual(["Checking€3,412.58", "Savings€8,000.00"]);
    expect(within(screen.getByRole("region", { name: "Credit cards" })).getByRole("button")).toHaveTextContent("Visa-€642.30");
    expect(within(screen.getByRole("region", { name: "Off budget" })).getByRole("button")).toHaveTextContent("Brokeroff budget€21,500.00");
    expect(screen.queryByText("Old account")).not.toBeInTheDocument();
  });

  it("leaves out a group with no accounts in it", async () => {
    renderPanel({ accounts: [CHECKING] });

    await screen.findByRole("region", { name: "On budget" });
    expect(screen.queryByRole("region", { name: "Credit cards" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Off budget" })).not.toBeInTheDocument();
  });

  it("says so when there are no accounts yet", async () => {
    renderPanel({ accounts: [] });

    expect(await screen.findByText("No accounts yet.")).toBeInTheDocument();
  });

  it("switches the main content to an account's own register, without closing itself", async () => {
    const { onClose } = renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /^Savings/ }));

    expect(await screen.findByText("Register screen")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("marks the account whose register is showing as current", async () => {
    renderPanel({ currentAccountId: "visa" });

    expect(await screen.findByRole("button", { name: /^Visa/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /^Checking/ })).not.toHaveAttribute("aria-current");
  });

  it("links to the full Accounts screen at its foot", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("link", { name: "Go to the Accounts screen →" }));

    expect(await screen.findByText("Accounts screen")).toBeInTheDocument();
  });

  it("closes from its own button and on Escape", async () => {
    const { onClose } = renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "× Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("shows no net worth until every balance is in", async () => {
    useAuth.mockReturnValue({ user: { access_token: "t" } });
    vi.spyOn(accountsApi, "listAccounts").mockResolvedValue([CHECKING]);
    vi.spyOn(transactionsApi, "listTransactionsForAccount").mockReturnValue(new Promise(() => {}));
    renderWithIntl(
      <MemoryRouter>
        <AccountsPanel workspaceId="ws-1" currency="EUR" currentAccountId={undefined} refreshKey="" onClose={vi.fn()} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("button", { name: /^Checking/ })).toBeInTheDocument();
    expect(screen.queryByText(/€/)).not.toBeInTheDocument();
  });
});

describe("AccountsPanel: currencies and securities (#652)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const US_BROKER = account("us-broker", "US broker", { type: "brokerage", onBudget: false, currency: "USD" });
  const CHF_SAVINGS = account("chf", "Swiss savings", { type: "savings", onBudget: false, currency: "CHF" });

  it("shows each balance in its account's own currency, and adds only the base currency's into the net worth", async () => {
    vi.spyOn(accountsApi, "holdsSecurities").mockResolvedValue(false);
    renderPanel({ accounts: [CHECKING, US_BROKER, CHF_SAVINGS], balances: { checking: 100_000, "us-broker": 300_000, chf: 50_000 } });

    // Shown once every balance is in, as the net worth itself is.
    expect(await screen.findByText("Not included: CHF 500.00 and $3,000.00 (no exchange rates yet)")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /^US broker/ })).getByText("$3,000.00")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /^Swiss savings/ })).getByText("CHF 500.00")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /^Checking/ })).getByText("€1,000.00")).toBeInTheDocument();
    // The net worth is the checking account alone, never 1,000 + 3,000 + 500.
    expect(screen.getAllByText("€1,000.00")).toHaveLength(2);
    expect(screen.queryByText("Net worth does not include securities (no prices yet)")).not.toBeInTheDocument();
  });

  it("has no note when every account is in the base currency", async () => {
    renderPanel();

    expect(await screen.findByText("€32,270.28")).toBeInTheDocument();
    expect(screen.queryByText(/^Not included/)).not.toBeInTheDocument();
  });

  it("says securities are not included whenever a brokerage account holds some", async () => {
    const EU_BROKER = account("eu-broker", "Broker", { type: "brokerage", onBudget: false });
    const holds = vi.spyOn(accountsApi, "holdsSecurities").mockResolvedValue(true);
    renderPanel({ accounts: [CHECKING, EU_BROKER], balances: { checking: 100_000, "eu-broker": 20_000 } });

    expect(await screen.findByText("Net worth does not include securities (no prices yet)")).toBeInTheDocument();
    expect(holds).toHaveBeenCalledWith("t", "ws-1", "eu-broker");
    expect(holds).toHaveBeenCalledTimes(1);
  });

  it("says nothing about securities until the net worth itself is shown", async () => {
    const EU_BROKER = account("eu-broker", "Broker", { type: "brokerage", onBudget: false });
    const holds = vi.spyOn(accountsApi, "holdsSecurities").mockResolvedValue(true);
    renderPanel({ accounts: [CHECKING, EU_BROKER], pending: ["checking"] });

    // The account list is in, but the checking account's balance never arrives.
    expect(await screen.findByRole("button", { name: /^Broker/ })).toBeInTheDocument();
    await vi.waitFor(() => expect(holds).toHaveBeenCalled());
    await holds.mock.results[0]!.value;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Net worth does not include securities (no prices yet)")).not.toBeInTheDocument();
  });

  it("says nothing about securities when no brokerage account holds any", async () => {
    const EU_BROKER = account("eu-broker", "Broker", { type: "brokerage", onBudget: false });
    const holds = vi.spyOn(accountsApi, "holdsSecurities").mockResolvedValue(false);
    renderPanel({ accounts: [CHECKING, EU_BROKER], balances: { checking: 100_000, "eu-broker": 20_000 } });

    expect(await screen.findByText("€1,200.00")).toBeInTheDocument();
    expect(holds).toHaveBeenCalled();
    expect(screen.queryByText("Net worth does not include securities (no prices yet)")).not.toBeInTheDocument();
  });

  it("asks about securities only for brokerage accounts", async () => {
    const holds = vi.spyOn(accountsApi, "holdsSecurities").mockResolvedValue(true);
    renderPanel();

    expect(await screen.findByText("€32,270.28")).toBeInTheDocument();
    expect(holds).not.toHaveBeenCalled();
    expect(screen.queryByText("Net worth does not include securities (no prices yet)")).not.toBeInTheDocument();
  });
});

describe("holdsSecurities (#652)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is true only when a position has a quantity other than zero", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ positions: [{ quantityE8: 0 }], summaries: [] }), { status: 200 }));
    expect(await accountsApi.holdsSecurities("t", "ws-1", "broker")).toBe(false);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ positions: [{ quantityE8: 0 }, { quantityE8: 150_000_000 }], summaries: [] }), { status: 200 }));
    expect(await accountsApi.holdsSecurities("t", "ws-1", "broker")).toBe(true);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/workspaces\/ws-1\/accounts\/broker\/positions$/);
  });
});
