import { formatMoney } from "@envelope/core";
import { useState } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";
import { useParams } from "react-router-dom";

import { ACCOUNT_TYPE_LABELS } from "../accounts/accountType.ts";
import { useWorkspaces } from "../workspaces/useWorkspaces.ts";
import { updateTransaction, type Transaction, type TransactionStatus } from "./api.ts";
import { categoryLabel } from "./categoryLabel.ts";
import { totalOf } from "./transactionAmount.ts";
import TransactionForm from "./TransactionForm.tsx";
import { useAccountRegister } from "./useAccountRegister.ts";
import "./AccountRegisterScreen.css";

type Filter = "all" | "pending" | "cleared" | "reconciled";

function rowLabel(transaction: Transaction, categories: Parameters<typeof categoryLabel>[1], unassignedLabel: string, splitLabel: string, transferLabel: string): string {
  if (transaction.transferId !== null) {
    return transferLabel;
  }
  if (transaction.splits.length > 1) {
    return splitLabel;
  }
  return categoryLabel(transaction.splits[0]?.categoryId ?? null, categories, unassignedLabel);
}

/**
 * The account register (#54): reached by clicking an account in the sidebar ledger
 * (`AppLayout`). Balances, filter tabs with counts, search, the transaction list with a running
 * balance (newest first), and the "+ New transaction"/edit side panel (`TransactionForm`) for
 * outflows, inflows, transfers and splits. "Import" and "Reconcile", also drawn in the mockup,
 * are left out — they have no screen yet (`#59`, `#60`), the same reasoning `AppLayout` already
 * uses for its own omitted buttons. A reconciled transaction opens a read-only summary instead
 * of the form: `apps/api` has no endpoint to unlock one yet.
 */
export default function AccountRegisterScreen() {
  const intl = useIntl();
  const auth = useAuth();
  const { workspaceId, accountId } = useParams<{ workspaceId: string; accountId: string }>();
  const workspaces = useWorkspaces();
  const state = useAccountRegister(workspaceId!, accountId!);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<"new" | { transaction: Transaction } | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  if (state.status === "loading") {
    return <p role="status">{intl.formatMessage({ id: "register.loading", defaultMessage: "Loading this account…" })}</p>;
  }

  if (state.status === "error") {
    return <p role="alert">{intl.formatMessage({ id: "register.error", defaultMessage: "We could not load this account." })}</p>;
  }

  const { account, accounts, categories, transactions } = state;
  const currency = workspaces.status === "ok" ? workspaces.workspaces.find((w) => w.id === workspaceId)?.baseCurrency : undefined;
  const money = (cents: number) => formatMoney(cents, { locale: intl.locale, currency: currency ?? "EUR" });
  const unassignedLabel = intl.formatMessage({ id: "transactions.form.unassigned", defaultMessage: "Ready to assign" });
  const transferLabel = intl.formatMessage({ id: "register.transfer", defaultMessage: "Transfer" });

  const chronological = [...transactions].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const withBalance = chronological
    .reduce<{ transaction: Transaction; balance: number }[]>((rows, t) => {
      const previousBalance = rows.length > 0 ? rows[rows.length - 1]!.balance : 0;
      return [...rows, { transaction: t, balance: previousBalance + totalOf(t) }];
    }, [])
    .toReversed();

  const counts = { all: transactions.length, pending: 0, cleared: 0, reconciled: 0 };
  for (const t of transactions) {
    counts[t.status]++;
  }
  const total = withBalance.length > 0 ? withBalance[0]!.balance : 0;
  const pendingTotal = chronological.filter((t) => t.status === "pending").reduce((sum, t) => sum + totalOf(t), 0);

  function matchesFilter(status: TransactionStatus): boolean {
    return filter === "all" || filter === status;
  }

  function matchesSearch(t: Transaction): boolean {
    if (!search.trim()) {
      return true;
    }
    const splitLabel = intl.formatMessage({ id: "register.split", defaultMessage: "{n} categories" }, { n: t.splits.length });
    const haystack = [
      t.payee ?? "",
      t.memo ?? "",
      rowLabel(t, categories, unassignedLabel, splitLabel, transferLabel),
      ...t.splits.map((s) => categoryLabel(s.categoryId, categories, unassignedLabel)),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  }

  const visible = withBalance.filter((row) => matchesFilter(row.transaction.status) && matchesSearch(row.transaction));

  async function toggleStatus(t: Transaction) {
    const accessToken = auth.user?.access_token;
    if (!accessToken || t.status === "reconciled") {
      return;
    }
    setTogglingId(t.id);
    try {
      await updateTransaction(accessToken, workspaceId!, accountId!, t.id, {
        status: t.status === "pending" ? "cleared" : "pending",
      });
      state.refetch();
    } finally {
      setTogglingId(null);
    }
  }

  const FILTERS: readonly [Filter, string][] = [
    ["all", intl.formatMessage({ id: "register.filter.all", defaultMessage: "All" })],
    ["pending", intl.formatMessage({ id: "register.filter.pending", defaultMessage: "Pending" })],
    ["cleared", intl.formatMessage({ id: "register.filter.cleared", defaultMessage: "Cleared" })],
    ["reconciled", intl.formatMessage({ id: "register.filter.reconciled", defaultMessage: "Reconciled" })],
  ];

  return (
    <div className="register-screen">
      <div className="acc-head">
        <div>
          <h1>{account.name}</h1>
          <p className="sub">
            {account.onBudget
              ? intl.formatMessage({ id: "register.onBudget", defaultMessage: "On-budget account" })
              : intl.formatMessage({ id: "register.offBudget", defaultMessage: "Off-budget account" })}
            {" · "}
            {intl.formatMessage(ACCOUNT_TYPE_LABELS[account.type])}
          </p>
        </div>
        <div className="bal">
          <div>
            <small>{intl.formatMessage({ id: "register.cleared", defaultMessage: "Cleared" })}</small>
            <span className="n">{money(total - pendingTotal)}</span>
          </div>
          <div>
            <small>{intl.formatMessage({ id: "register.pending", defaultMessage: "Pending" })}</small>
            <span className="n">{money(pendingTotal)}</span>
          </div>
          <div className="main">
            <small>{intl.formatMessage({ id: "register.total", defaultMessage: "Balance" })}</small>
            <span className="n">{money(total)}</span>
          </div>
        </div>
      </div>

      <div className="reg-tools">
        <div className="tabs" role="group" aria-label={intl.formatMessage({ id: "register.filter.label", defaultMessage: "Filter transactions" })}>
          {FILTERS.map(([key, label]) => (
            <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {label} <span className="count">{counts[key]}</span>
            </button>
          ))}
        </div>
        <div className="right">
          <label className="search">
            <span className="sr-only">{intl.formatMessage({ id: "register.search", defaultMessage: "Search" })}</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={intl.formatMessage({ id: "register.search.placeholder", defaultMessage: "Search payee, category, memo" })}
            />
          </label>
          <button type="button" className="btn primary" onClick={() => setOpen("new")}>
            {intl.formatMessage({ id: "register.new", defaultMessage: "New transaction" })}
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="empty">{intl.formatMessage({ id: "register.empty", defaultMessage: "No transactions match this filter." })}</p>
      ) : (
        <table className="register-table">
          <thead>
            <tr>
              <th aria-hidden="true"></th>
              <th>{intl.formatMessage({ id: "register.column.date", defaultMessage: "Date" })}</th>
              <th>{intl.formatMessage({ id: "register.column.payee", defaultMessage: "Payee" })}</th>
              <th>{intl.formatMessage({ id: "register.column.category", defaultMessage: "Category" })}</th>
              <th className="n">{intl.formatMessage({ id: "register.column.outflow", defaultMessage: "Outflow" })}</th>
              <th className="n">{intl.formatMessage({ id: "register.column.inflow", defaultMessage: "Inflow" })}</th>
              <th className="n">{intl.formatMessage({ id: "register.column.balance", defaultMessage: "Balance" })}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(({ transaction, balance }) => {
              const amount = totalOf(transaction);
              const splitLabel = intl.formatMessage({ id: "register.split", defaultMessage: "{n} categories" }, { n: transaction.splits.length });
              return (
                <tr key={transaction.id}>
                  <td>
                    <button
                      type="button"
                      className={`status status-${transaction.status}`}
                      disabled={transaction.status === "reconciled" || togglingId === transaction.id}
                      aria-label={
                        transaction.status === "reconciled"
                          ? intl.formatMessage({ id: "register.status.reconciled", defaultMessage: "Reconciled" })
                          : intl.formatMessage(
                              { id: "register.status.toggle", defaultMessage: "{status}: change status" },
                              {
                                status:
                                  transaction.status === "pending"
                                    ? intl.formatMessage({ id: "register.status.pending", defaultMessage: "Pending" })
                                    : intl.formatMessage({ id: "register.status.cleared", defaultMessage: "Cleared" }),
                              },
                            )
                      }
                      onClick={() => void toggleStatus(transaction)}
                    >
                      {transaction.status === "reconciled" ? "🔒" : transaction.status === "cleared" ? "●" : "○"}
                    </button>
                  </td>
                  <td>
                    <button type="button" className="open-row" onClick={() => setOpen({ transaction })}>
                      {transaction.budgetDate}
                    </button>
                  </td>
                  <td>
                    <button type="button" className="open-row" onClick={() => setOpen({ transaction })}>
                      {transaction.payee ?? ""}
                      {transaction.memo && <small>{transaction.memo}</small>}
                    </button>
                  </td>
                  <td>
                    <button type="button" className="open-row" onClick={() => setOpen({ transaction })}>
                      {rowLabel(transaction, categories, unassignedLabel, splitLabel, transferLabel)}
                    </button>
                  </td>
                  <td className="n">{amount < 0 ? money(-amount) : ""}</td>
                  <td className="n">{amount > 0 ? money(amount) : ""}</td>
                  <td className="n">{money(balance)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {open === "new" && (
        <TransactionForm
          workspaceId={workspaceId!}
          accountId={accountId!}
          accounts={accounts}
          categories={categories}
          currency={currency ?? "EUR"}
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null);
            state.refetch();
          }}
        />
      )}
      {open !== null && open !== "new" && open.transaction.status === "reconciled" && (
        <div className="side-panel" role="dialog" aria-modal="true">
          <div className="panel-head">
            <h2>{open.transaction.payee ?? intl.formatMessage({ id: "register.transfer", defaultMessage: "Transfer" })}</h2>
            <button type="button" className="plain" onClick={() => setOpen(null)}>
              {intl.formatMessage({ id: "common.action.close", defaultMessage: "× Close" })}
            </button>
          </div>
          <p className="hint">
            {intl.formatMessage({
              id: "register.locked",
              defaultMessage: "This transaction is reconciled and locked. Unlocking one has no screen yet.",
            })}
          </p>
        </div>
      )}
      {open !== null && open !== "new" && open.transaction.status !== "reconciled" && (
        <TransactionForm
          workspaceId={workspaceId!}
          accountId={accountId!}
          accounts={accounts}
          categories={categories}
          currency={currency ?? "EUR"}
          transaction={open.transaction}
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null);
            state.refetch();
          }}
        />
      )}
    </div>
  );
}
