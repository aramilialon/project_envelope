import { currencyDecimals, formatMoney } from "@envelope/core";
import { useState } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";
import { useParams } from "react-router-dom";

import { ACCOUNT_TYPE_LABELS } from "../accounts/accountType.ts";
import { usePhoneWidth } from "../layout/usePhoneWidth.ts";
import { useWorkspaces } from "../workspaces/useWorkspaces.ts";
import { todayIsoIn } from "../workspaceDate.ts";
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

/** "11 Oct" — never the raw "YYYY-MM-DD" the API returns. */
function shortDate(iso: string, locale: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** A day-group header on the phone layout: "Friday, 9 October". */
function longDay(iso: string, locale: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** A plain formatted number, no currency symbol — the desktop table's own Outflow/Inflow/Balance cells, whose column header already says what they are. */
function plainAmount(cents: number, locale: string, currency: string): string {
  const decimals = currencyDecimals(currency);
  return new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(cents / 10 ** decimals);
}

function StatusIcon({ status }: { readonly status: TransactionStatus }) {
  if (status === "reconciled") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="5" y="11" width="14" height="10" rx="1" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
    );
  }
  if (status === "cleared") {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="currentColor" stroke="none" />
        <path d="m8 12.5 2.6 2.6L16.5 9" stroke="var(--paper)" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}

/**
 * The account register (#54, #323, #333): reached from the Accounts screen. Balances, filter
 * tabs with counts, search, the transaction list with a running balance (newest first), and the
 * "+ New transaction"/edit side panel (`TransactionForm`) for outflows, inflows, transfers and
 * splits. "Import" and "Reconcile", also drawn in the mockup, are left out — they have no screen
 * yet (`#59`, `#60`). A reconciled transaction opens a read-only summary instead of the form:
 * `apps/api` has no endpoint to unlock one yet.
 *
 * Two list renderings share the same data (`visible`): a table at desktop width, and below
 * 600px a day-grouped list (`docs/ux/mockups/account-register.html`'s own "Phone" view) — a
 * table simply has no narrow-width shape of its own, unlike the budget month's bars. Which one
 * is visible is plain CSS (`AccountRegisterScreen.css`), not a `matchMedia` check, so there is no
 * flash of the wrong one while React decides. The projected balance at month end (`#337`) and
 * this account's own timeline/"To do" (`#337`) are not this issue's job.
 */
export default function AccountRegisterScreen() {
  const intl = useIntl();
  const auth = useAuth();
  const { workspaceId, accountId } = useParams<{ workspaceId: string; accountId: string }>();
  const workspaces = useWorkspaces();
  const state = useAccountRegister(workspaceId!, accountId!);
  const isPhone = usePhoneWidth();
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
  const currentWorkspace = workspaces.status === "ok" ? workspaces.workspaces.find((w) => w.id === workspaceId) : undefined;
  const currency = currentWorkspace?.baseCurrency;
  const resolvedCurrency = currency ?? "EUR";
  const money = (cents: number) => formatMoney(cents, { locale: intl.locale, currency: resolvedCurrency });
  const plain = (cents: number) => plainAmount(cents, intl.locale, resolvedCurrency);
  const unassignedLabel = intl.formatMessage({ id: "transactions.form.unassigned", defaultMessage: "Unassigned" });
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

  function statusAriaLabel(status: TransactionStatus): string {
    return status === "reconciled"
      ? intl.formatMessage({ id: "register.status.reconciled", defaultMessage: "Reconciled" })
      : intl.formatMessage(
          { id: "register.status.toggle", defaultMessage: "{status}: change status" },
          {
            status:
              status === "pending"
                ? intl.formatMessage({ id: "register.status.pending", defaultMessage: "Pending" })
                : intl.formatMessage({ id: "register.status.cleared", defaultMessage: "Cleared" }),
          },
        );
  }

  // A reasonable guess in the browser's own zone while the workspace's own has not loaded yet
  // (this just picks which day header reads "Today" — a display nicety, not business logic).
  const today = todayIsoIn(currentWorkspace?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const groups: { day: string; rows: typeof visible }[] = [];
  for (const row of visible) {
    const day = row.transaction.budgetDate;
    const last = groups[groups.length - 1];
    if (last && last.day === day) {
      last.rows.push(row);
    } else {
      groups.push({ day, rows: [row] });
    }
  }

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
        <div className="acc-bal" aria-label={intl.formatMessage({ id: "register.balances", defaultMessage: "Account balances" })}>
          <small>{intl.formatMessage({ id: "register.total", defaultMessage: "Balance" })}</small>
          <span className="big n">{money(total)}</span>
          <div className="acc-facts">
            <span>
              {intl.formatMessage({ id: "register.cleared", defaultMessage: "Cleared" })} <b className="n">{money(total - pendingTotal)}</b>
            </span>
            <span>
              {intl.formatMessage({ id: "register.pending", defaultMessage: "Pending" })} <b className="n">{money(pendingTotal)}</b>
            </span>
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
      ) : isPhone ? (
        <div className="phone-register">
          {groups.map(({ day, rows }) => (
            <div key={day}>
              <div className="ph-day">{day === today ? intl.formatMessage({ id: "register.today", defaultMessage: "Today" }) : longDay(day, intl.locale)}</div>
              {rows.map(({ transaction }) => {
                const amount = totalOf(transaction);
                const splitLabel = intl.formatMessage({ id: "register.split", defaultMessage: "{n} categories" }, { n: transaction.splits.length });
                const subtitle = rowLabel(transaction, categories, unassignedLabel, splitLabel, transferLabel) + (transaction.memo ? ` · ${transaction.memo}` : "");
                return (
                  <div key={transaction.id} className="ph-tx">
                    <button type="button" className="open" onClick={() => setOpen({ transaction })}>
                      <span className="who">
                        <b>{transaction.payee ?? ""}</b>
                        <small>{subtitle}</small>
                      </span>
                      <span className={`amt n${amount > 0 ? " in" : ""}`}>{money(amount)}</span>
                    </button>
                    <button
                      type="button"
                      className={`st status-${transaction.status}`}
                      disabled={transaction.status === "reconciled" || togglingId === transaction.id}
                      aria-label={statusAriaLabel(transaction.status)}
                      onClick={() => void toggleStatus(transaction)}
                    >
                      <StatusIcon status={transaction.status} />
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
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
                      aria-label={statusAriaLabel(transaction.status)}
                      onClick={() => void toggleStatus(transaction)}
                    >
                      <StatusIcon status={transaction.status} />
                    </button>
                  </td>
                  <td>
                    <button type="button" className="open-row" onClick={() => setOpen({ transaction })}>
                      {shortDate(transaction.budgetDate, intl.locale)}
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
                  <td className="n">{amount < 0 ? plain(-amount) : ""}</td>
                  <td className="n">{amount > 0 ? plain(amount) : ""}</td>
                  <td className="n">{plain(balance)}</td>
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
          currency={resolvedCurrency}
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null);
            state.refetch();
          }}
        />
      )}
      {open !== null && open !== "new" && open.transaction.status === "reconciled" && (
        <div className="side-sheet" role="dialog" aria-modal="true">
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
          currency={resolvedCurrency}
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
