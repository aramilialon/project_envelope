import { currencyDecimals, formatMoney, parseAmount } from "@envelope/core";
import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";

import { listAccounts, type Account } from "../accounts/api.ts";
import { useBudgetMonth } from "../budget/useBudgetMonth.ts";
import { currentMonthIn } from "../workspaceDate.ts";
import { useWorkspaces } from "../workspaces/useWorkspaces.ts";
import { createTransaction } from "./api.ts";
import "./QuickEntryOverlay.css";

interface Props {
  readonly workspaceId: string;
  onClose(): void;
  /** Lets `AppLayout.tsx` tell the screen behind the overlay to refetch (`BudgetDataVersionContext`) — this component's own `budgetMonth` state is a separate instance, read only for its own chips. */
  onSaved(): void;
}

interface Saved {
  readonly amountCents: number;
  readonly payee: string;
  readonly accountName: string;
  readonly categoryName: string;
  readonly available: number;
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function decimalSeparator(locale: string): string {
  return new Intl.NumberFormat(locale).formatToParts(1.1).find((p) => p.type === "decimal")?.value ?? ".";
}

function currencySymbol(locale: string, currency: string): { readonly symbol: string; readonly before: boolean } {
  const parts = new Intl.NumberFormat(locale, { style: "currency", currency }).formatToParts(0);
  return { symbol: parts.find((p) => p.type === "currency")?.value ?? currency, before: parts[0]?.type === "currency" };
}

/**
 * The phone tab bar's own central button (`#367`, design.md's "Mobile-specific features": "Quick
 * expense entry in three taps" — built here for the web app too, since the phone tab bar's own
 * central button already exists for it, `docs/ux/mockups/account-register.html`'s own `qeHtml()`
 * the reference). Amount keypad, place (a plain text field, not the mockup's own fixed suggested
 * chips — nothing in this app remembers frequent payees yet, the same gap `TransactionForm.tsx`
 * already has), category with its own available amount, account — in that visual order, matching
 * the mockup. Always an outflow, dated today; no split, no transfer, no editing an existing
 * transaction — "three taps" is the point.
 *
 * Rendered by `AppLayout.tsx` itself, not a route: closing it must return to exactly whatever
 * screen was open underneath, scroll position and all, which a route's own unmount/remount would
 * lose. `canWrite` gating (`#61`) happens one level up, in `AppLayout.tsx` — the button itself is
 * hidden for a `read_only` member, so this component can assume write access once it opens.
 */
export default function QuickEntryOverlay({ workspaceId, onClose, onSaved }: Props) {
  const intl = useIntl();
  const auth = useAuth();
  const workspaces = useWorkspaces();
  const currentWorkspace = workspaces.status === "ok" ? workspaces.workspaces.find((w) => w.id === workspaceId) : undefined;
  const currency = currentWorkspace?.baseCurrency ?? "EUR";
  const timeZone = currentWorkspace?.timeZone;
  const month = currentMonthIn(timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const budgetMonth = useBudgetMonth(workspaceId, month);

  const [accountsState, setAccountsState] = useState<{ status: "loading" } | { status: "error" } | { status: "ok"; accounts: readonly Account[] }>({
    status: "loading",
  });
  const [amountStr, setAmountStr] = useState("");
  const [payee, setPayee] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);

  useEffect(() => {
    const accessToken = auth.user?.access_token;
    if (!accessToken) {
      return;
    }
    let cancelled = false;
    listAccounts(accessToken, workspaceId)
      .then((accounts) => {
        if (!cancelled) setAccountsState({ status: "ok", accounts });
      })
      .catch(() => {
        if (!cancelled) setAccountsState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [auth.user?.access_token, workspaceId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const onBudgetAccounts =
    accountsState.status === "ok" ? accountsState.accounts.filter((a) => a.onBudget && a.closedAt === null) : [];
  const categories = budgetMonth.status === "ok" ? budgetMonth.groups.flatMap((g) => g.categories).filter((c) => !c.isPaymentCategory) : [];
  const selectedAccountId = accountId || onBudgetAccounts[0]?.id || "";

  const money = (cents: number) => formatMoney(cents, { locale: intl.locale, currency });
  const sep = decimalSeparator(intl.locale);
  const { symbol, before } = currencySymbol(intl.locale, currency);
  const decimals = currencyDecimals(currency);

  let cents = 0;
  try {
    cents = amountStr.trim() ? parseAmount(amountStr, { locale: intl.locale, currency }) : 0;
  } catch {
    cents = 0;
  }

  function pressKey(key: string) {
    if (key === "del") {
      setAmountStr((s) => s.slice(0, -1));
      return;
    }
    if (key === sep) {
      setAmountStr((s) => (s.includes(sep) ? s : `${s || "0"}${sep}`));
      return;
    }
    setAmountStr((s) => {
      if (s.length >= 8) return s;
      const parts = s.split(sep);
      if (parts[1] && parts[1].length >= decimals) return s;
      return s + key;
    });
  }

  function reset() {
    setAmountStr("");
    setPayee("");
    setCategoryId("");
    setAccountId("");
    setError(null);
    setSaved(null);
  }

  async function handleSave() {
    const accessToken = auth.user?.access_token;
    if (!accessToken || cents <= 0 || !categoryId || !selectedAccountId) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createTransaction(accessToken, workspaceId, selectedAccountId, {
        occurredAt: today(),
        ...(payee.trim() ? { payee: payee.trim() } : {}),
        splits: [{ categoryId, amountCents: -cents }],
      });
      const category = categories.find((c) => c.categoryId === categoryId);
      const account = onBudgetAccounts.find((a) => a.id === selectedAccountId);
      setSaved({
        amountCents: cents,
        payee: payee.trim(),
        accountName: account?.name ?? "",
        categoryName: category?.name ?? "",
        available: (category?.available ?? 0) - cents,
      });
      budgetMonth.refetch();
      onSaved();
    } catch {
      setError(intl.formatMessage({ id: "quickEntry.error", defaultMessage: "We could not save this expense." }));
    } finally {
      setSubmitting(false);
    }
  }

  const loading = accountsState.status === "loading" || budgetMonth.status === "loading" || workspaces.status === "loading";
  const failed = accountsState.status === "error" || budgetMonth.status === "error" || workspaces.status === "error";

  return (
    <div className="quick-entry" role="dialog" aria-modal="true" aria-label={intl.formatMessage({ id: "quickEntry.title", defaultMessage: "New expense" })}>
      {saved ? (
        <div className="qe">
          <div className="qe-top">
            <h3>{intl.formatMessage({ id: "quickEntry.savedTitle", defaultMessage: "Expense saved" })}</h3>
          </div>
          <div className="toast">
            {saved.payee
              ? intl.formatMessage(
                  { id: "quickEntry.savedSummaryWithPayee", defaultMessage: "{amount} from {payee} with {account}." },
                  { amount: money(saved.amountCents), payee: saved.payee, account: saved.accountName },
                )
              : intl.formatMessage(
                  { id: "quickEntry.savedSummary", defaultMessage: "{amount} with {account}." },
                  { amount: money(saved.amountCents), account: saved.accountName },
                )}{" "}
            {intl.formatMessage(
              { id: "quickEntry.savedAfter", defaultMessage: "{category} now has {available} available." },
              { category: saved.categoryName, available: money(saved.available) },
            )}
            {saved.available < 0 && (
              <> {intl.formatMessage({ id: "quickEntry.savedOverspent", defaultMessage: "It is overspent." })}</>
            )}
          </div>
          <button type="button" className="btn primary qe-save" onClick={reset}>
            {intl.formatMessage({ id: "quickEntry.another", defaultMessage: "Another expense" })}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {intl.formatMessage({ id: "quickEntry.close", defaultMessage: "Close" })}
          </button>
        </div>
      ) : loading ? (
        <p role="status">{intl.formatMessage({ id: "quickEntry.loading", defaultMessage: "Loading…" })}</p>
      ) : failed ? (
        <p role="alert">{intl.formatMessage({ id: "quickEntry.loadError", defaultMessage: "We could not load your accounts and categories." })}</p>
      ) : onBudgetAccounts.length === 0 || categories.length === 0 ? (
        <p role="alert">
          {intl.formatMessage({
            id: "quickEntry.nothingYet",
            defaultMessage: "Add an on-budget account and a category first.",
          })}
        </p>
      ) : (
        <div className="qe">
          <div className="qe-top">
            <button type="button" className="ph-back" onClick={onClose}>
              {intl.formatMessage({ id: "common.action.cancel", defaultMessage: "Cancel" })}
            </button>
            <h3>{intl.formatMessage({ id: "quickEntry.newExpense", defaultMessage: "New expense" })}</h3>
            <span style={{ width: 60 }} />
          </div>
          <div className={`qe-amt${cents ? "" : " zero"}`} aria-live="polite">
            {before ? `${symbol}${amountStr || `0${sep}${"0".repeat(decimals)}`}` : `${amountStr || `0${sep}${"0".repeat(decimals)}`} ${symbol}`}
          </div>

          <h5>{intl.formatMessage({ id: "quickEntry.place", defaultMessage: "Where" })}</h5>
          <label className="sr-only" htmlFor="qe-payee">
            {intl.formatMessage({ id: "quickEntry.place", defaultMessage: "Where" })}
          </label>
          <input id="qe-payee" type="text" value={payee} onChange={(event) => setPayee(event.target.value)} />

          <h5>{intl.formatMessage({ id: "quickEntry.category", defaultMessage: "Category" })}</h5>
          <div className="chips2">
            {categories.map((c) => (
              <button
                type="button"
                key={c.categoryId}
                className="chip2"
                aria-pressed={categoryId === c.categoryId}
                onClick={() => setCategoryId(c.categoryId)}
              >
                {c.name}
                <small>{money(c.available)}</small>
              </button>
            ))}
          </div>

          <h5>{intl.formatMessage({ id: "quickEntry.with", defaultMessage: "With" })}</h5>
          <div className="chips2">
            {onBudgetAccounts.map((a) => (
              <button type="button" key={a.id} className="chip2" aria-pressed={selectedAccountId === a.id} onClick={() => setAccountId(a.id)}>
                {a.name}
              </button>
            ))}
          </div>

          <div className="keys">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", sep, "0", "del"].map((key) => (
              <button
                type="button"
                key={key}
                onClick={() => pressKey(key)}
                aria-label={key === "del" ? intl.formatMessage({ id: "quickEntry.backspace", defaultMessage: "Delete a digit" }) : undefined}
              >
                {key === "del" ? "⌫" : key}
              </button>
            ))}
          </div>

          {error && (
            <p className="hint bad" role="alert">
              {error}
            </p>
          )}

          <button
            type="button"
            className="btn primary qe-save"
            disabled={submitting || cents <= 0 || !categoryId}
            onClick={() => void handleSave()}
          >
            {cents > 0
              ? intl.formatMessage({ id: "quickEntry.save", defaultMessage: "Save {amount}" }, { amount: money(cents) })
              : intl.formatMessage({ id: "quickEntry.saveBare", defaultMessage: "Save" })}
          </button>
        </div>
      )}
    </div>
  );
}
