import { formatMoney, parseAmount } from "@envelope/core";
import { useState } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";
import { Link, useParams } from "react-router-dom";

import { updateTransaction } from "../transactions/api.ts";
import { useWorkspaces } from "../workspaces/useWorkspaces.ts";
import { todayIsoIn } from "../workspaceDate.ts";
import { reconcileAccount, type CandidateTransaction, type ReconciliationRecord } from "./api.ts";
import { computeTally, findSuggestion } from "./reconciliationTally.ts";
import { useReconciliation } from "./useReconciliation.ts";
import "./ReconciliationScreen.css";

function shortDate(iso: string, locale: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * The reconciliation screen (#60, design.md "Import and reconciliation"), reached from the
 * account register's own "Reconcile" to-do item: enter the statement's closing balance and
 * date, untick any cleared transaction the statement does not show yet, tick a pending one the
 * bank already cleared, and either lock everything once the difference is zero or resolve a real
 * one with a one-click clue (a pending or unticked transaction of the exact same amount) or an
 * adjustment transaction. Follows `docs/ux/mockups/import-reconciliation.html`'s own `#view-rec`
 * layout and copy, with two differences from the literal mockup:
 *
 * - Ticking a pending transaction's checkbox calls the existing "mark cleared" endpoint right
 *   away (`PATCH .../transactions/:id`) and refetches, rather than only flipping local state —
 *   `POST .../reconciliations` only accepts already-*cleared* transaction ids
 *   (`reconcileAccount`'s own `unknown_transaction` check), so there is no "pending, but ticked"
 *   state to submit in the first place.
 * - The mockup's "Add an adjustment" button has no category step of its own; design.md requires
 *   one ("its category is chosen by the user, unassigned money by default"), so confirming it
 *   opens a small inline category picker before the call.
 *
 * The tally and difference are computed client-side (`reconciliationTally.ts`) from the already
 * fetched candidates, so ticking, unticking and typing the statement balance feel instant; only
 * submitting (lock or adjustment) calls the server, which is the authoritative check.
 */
export default function ReconciliationScreen() {
  const intl = useIntl();
  const auth = useAuth();
  const { workspaceId, accountId } = useParams<{ workspaceId: string; accountId: string }>();
  const workspaces = useWorkspaces();
  const currentWorkspace = workspaces.status === "ok" ? workspaces.workspaces.find((w) => w.id === workspaceId) : undefined;
  const timeZone = currentWorkspace?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const currency = currentWorkspace?.baseCurrency ?? "EUR";

  const [date, setDate] = useState(() => todayIsoIn(timeZone));
  const [statementStr, setStatementStr] = useState("");
  const [offIds, setOffIds] = useState<ReadonlySet<string>>(new Set());
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [showAdjustment, setShowAdjustment] = useState(false);
  const [adjustmentCategoryId, setAdjustmentCategoryId] = useState("");
  const [adjustmentMemo, setAdjustmentMemo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState<{ reconciliation: ReconciliationRecord; count: number } | null>(null);

  const state = useReconciliation(workspaceId!, accountId!, date);

  // The eligible set is defined relative to `date`; a previous tick/untick choice could
  // reference a transaction no longer in it, so changing the date starts the tally fresh
  // (`handleDateChange`, not a date-watching effect, does the reset).
  function handleDateChange(nextDate: string) {
    setDate(nextDate);
    setOffIds(new Set());
  }

  if (state.status === "loading") {
    return <p role="status">{intl.formatMessage({ id: "reconcile.loading", defaultMessage: "Loading this account…" })}</p>;
  }
  if (state.status === "error") {
    return <p role="alert">{intl.formatMessage({ id: "reconcile.error", defaultMessage: "We could not load this account." })}</p>;
  }

  const { account, categories, candidates } = state;
  const money = (cents: number) => formatMoney(cents, { locale: intl.locale, currency });
  const openCategories = categories.filter((c) => !c.archived);

  let statementCents: number | null = null;
  try {
    statementCents = statementStr.trim() ? parseAmount(statementStr, { locale: intl.locale, currency }) : null;
  } catch {
    statementCents = null;
  }
  const invalidStatement = statementStr.trim() !== "" && statementCents === null;

  const tally = computeTally(candidates.lastReconciledBalanceCents, candidates.clearedTransactions, offIds, statementCents);
  const tickedCount = candidates.clearedTransactions.filter((t) => !offIds.has(t.id)).length;
  const unticked = candidates.clearedTransactions.filter((t) => offIds.has(t.id));
  const suggestion = findSuggestion(candidates.pendingTransactions, unticked, tally.differenceCents, date);

  async function handleTogglePending(transaction: CandidateTransaction) {
    const accessToken = auth.user?.access_token;
    if (!accessToken) {
      return;
    }
    setMarkingId(transaction.id);
    try {
      await updateTransaction(accessToken, workspaceId!, accountId!, transaction.id, { status: "cleared" });
      state.refetch();
    } finally {
      setMarkingId(null);
    }
  }

  function toggleOff(id: string) {
    setOffIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function handleApplySuggestion() {
    if (!suggestion) {
      return;
    }
    if (suggestion.kind === "pending") {
      await handleTogglePending(suggestion.transaction);
    } else {
      toggleOff(suggestion.transaction.id);
    }
  }

  async function handleLock() {
    if (statementCents === null) {
      return;
    }
    const accessToken = auth.user?.access_token;
    if (!accessToken) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const tickedIds = candidates.clearedTransactions.filter((t) => !offIds.has(t.id)).map((t) => t.id);
      const result = await reconcileAccount(accessToken, workspaceId!, accountId!, {
        date,
        statementBalanceCents: statementCents,
        tickedTransactionIds: tickedIds,
      });
      if (result.outcome === "reconciled") {
        setLocked({ reconciliation: result.reconciliation, count: tickedIds.length });
      } else {
        setError(intl.formatMessage({ id: "reconcile.outOfDate", defaultMessage: "Something changed in this account; refresh and try again." }));
        state.refetch();
      }
    } catch {
      setError(intl.formatMessage({ id: "reconcile.error.save", defaultMessage: "We could not complete this reconciliation." }));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAdjustmentConfirm() {
    if (tally.differenceCents === null || tally.differenceCents === 0) {
      return;
    }
    const accessToken = auth.user?.access_token;
    if (!accessToken || statementCents === null) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const tickedIds = candidates.clearedTransactions.filter((t) => !offIds.has(t.id)).map((t) => t.id);
      const result = await reconcileAccount(accessToken, workspaceId!, accountId!, {
        date,
        statementBalanceCents: statementCents,
        tickedTransactionIds: tickedIds,
        adjustment: { categoryId: adjustmentCategoryId || null, ...(adjustmentMemo.trim() ? { memo: adjustmentMemo.trim() } : {}) },
      });
      if (result.outcome === "reconciled") {
        setLocked({ reconciliation: result.reconciliation, count: tickedIds.length + 1 });
      } else {
        setError(intl.formatMessage({ id: "reconcile.outOfDate", defaultMessage: "Something changed in this account; refresh and try again." }));
        state.refetch();
      }
    } catch {
      setError(intl.formatMessage({ id: "reconcile.error.save", defaultMessage: "We could not complete this reconciliation." }));
    } finally {
      setSubmitting(false);
    }
  }

  const backHref = `/${workspaceId}/accounts/${accountId}`;

  if (locked) {
    return (
      <div className="reconcile-screen">
        <div className="done-box">
          <h4>{intl.formatMessage({ id: "reconcile.done.title", defaultMessage: "Reconciliation complete" })}</h4>
          <p>
            {intl.formatMessage(
              {
                id: "reconcile.done.body",
                defaultMessage: "{count, plural, one {# transaction} other {# transactions}} locked. The reconciled balance on {date} is {amount}.",
              },
              { count: locked.count, date: shortDate(locked.reconciliation.reconciledAt, intl.locale), amount: money(locked.reconciliation.statementBalanceCents) },
            )}
          </p>
          <div className="row-btns">
            <Link className="btn primary" to={backHref}>
              {intl.formatMessage({ id: "reconcile.done.back", defaultMessage: "Back to the account" })}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="reconcile-screen">
      <Link className="crumb-back" to={backHref}>
        ← {account.name}
      </Link>
      <h1 className="page-h">{intl.formatMessage({ id: "reconcile.title", defaultMessage: "Reconcile with your bank" })}</h1>
      <p className="hint">
        {intl.formatMessage({
          id: "reconcile.intro",
          defaultMessage: "Compare the bank statement's balance with what's cleared in envelope. If they match, the transactions get locked: the balance up to that date never changes again by mistake.",
        })}
      </p>

      {error && <p className="hint bad" role="alert">{error}</p>}

      <div className="rec-grid">
        <div className="rlist">
          <div className="sec">
            <h5>
              <span>{intl.formatMessage({ id: "reconcile.cleared.heading", defaultMessage: "Cleared since the last reconciliation" })}</span>
              <span className="n">{candidates.clearedTransactions.length}</span>
            </h5>
            <p className="hint">{intl.formatMessage({ id: "reconcile.cleared.hint", defaultMessage: "Untick any that the statement does not show." })}</p>
            {candidates.clearedTransactions.map((t) => {
              const off = offIds.has(t.id);
              const highlighted = suggestion?.kind === "unticked" && suggestion.transaction.id === t.id;
              return (
                <label key={t.id} className={`rl${off ? " off" : ""}${highlighted ? " hl" : ""}`}>
                  <input type="checkbox" checked={!off} onChange={() => toggleOff(t.id)} />
                  <span className="n">{shortDate(t.occurredAt, intl.locale)}</span>
                  <span>{t.payee ?? ""}</span>
                  <span className="n r">{money(t.amountCents)}</span>
                </label>
              );
            })}
          </div>
          {candidates.pendingTransactions.length > 0 && (
            <div className="sec" style={{ marginTop: 18 }}>
              <h5>
                <span>{intl.formatMessage({ id: "reconcile.pending.heading", defaultMessage: "Pending" })}</span>
                <span className="n">{candidates.pendingTransactions.length}</span>
              </h5>
              <p className="hint">{intl.formatMessage({ id: "reconcile.pending.hint", defaultMessage: "These don't count until you tick them as cleared." })}</p>
              {candidates.pendingTransactions.map((t) => {
                const highlighted = suggestion?.kind === "pending" && suggestion.transaction.id === t.id;
                return (
                  <label key={t.id} className={`rl off${highlighted ? " hl" : ""}`}>
                    <input type="checkbox" checked={false} disabled={markingId === t.id} onChange={() => void handleTogglePending(t)} />
                    <span className="n">{shortDate(t.occurredAt, intl.locale)}</span>
                    <span>{t.payee ?? ""}</span>
                    <span className="n r">{money(t.amountCents)}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <aside className="recon" aria-label={intl.formatMessage({ id: "reconcile.tally.label", defaultMessage: "Tally" })}>
          <div className="two">
            <div className="field">
              <label htmlFor="rec-amt">{intl.formatMessage({ id: "reconcile.statement.balance", defaultMessage: "Statement balance" })}</label>
              <span className="money-in">
                <input id="rec-amt" type="text" inputMode="decimal" value={statementStr} onChange={(event) => setStatementStr(event.target.value)} placeholder="0.00" />
              </span>
            </div>
            <div className="field">
              <label htmlFor="rec-date">{intl.formatMessage({ id: "reconcile.statement.date", defaultMessage: "As of" })}</label>
              <input id="rec-date" type="date" value={date} onChange={(event) => handleDateChange(event.target.value)} />
            </div>
          </div>

          <div className="sec">
            <div className="qa">
              <span>{intl.formatMessage({ id: "reconcile.tally.last", defaultMessage: "Last reconciled balance" })}</span>
              <span className="dots" />
              <span className="n">{money(candidates.lastReconciledBalanceCents)}</span>
            </div>
            <div className="qa">
              <span>{intl.formatMessage({ id: "reconcile.tally.ticked", defaultMessage: "Ticked cleared transactions" })}</span>
              <span className="dots" />
              <span className="n">{money(tally.clearedBalanceCents - candidates.lastReconciledBalanceCents)}</span>
            </div>
            <div className="qa total">
              <span>{intl.formatMessage({ id: "reconcile.tally.cleared", defaultMessage: "Cleared balance" })}</span>
              <span className="dots" />
              <span className="n">{money(tally.clearedBalanceCents)}</span>
            </div>
          </div>

          <div className="diff">
            <span>{intl.formatMessage({ id: "reconcile.difference", defaultMessage: "Difference" })}</span>
            <b className={`n ${tally.differenceCents === 0 ? "zero" : "bad"}`} aria-live="polite">
              {tally.differenceCents === null ? "–" : money(tally.differenceCents)}
            </b>
          </div>

          {invalidStatement ? (
            <span className="hint bad">{intl.formatMessage({ id: "reconcile.invalidAmount", defaultMessage: "Enter the amount as shown on your statement, for example 1,234.56." })}</span>
          ) : statementCents === null ? (
            <span className="hint">{intl.formatMessage({ id: "reconcile.enterStatement", defaultMessage: "Enter the statement balance to see the difference." })}</span>
          ) : tally.differenceCents === 0 ? (
            <>
              <span className="ok">{intl.formatMessage({ id: "reconcile.ok", defaultMessage: "Everything matches." })}</span>
              <button type="button" className="btn primary" disabled={submitting} onClick={() => void handleLock()}>
                {intl.formatMessage({ id: "reconcile.lock", defaultMessage: "Lock {count, plural, one {# transaction} other {# transactions}}" }, { count: tickedCount })}
              </button>
            </>
          ) : (
            <>
              <div className="clue">
                {suggestion ? (
                  suggestion.kind === "pending" ? (
                    intl.formatMessage(
                      { id: "reconcile.clue.pending", defaultMessage: "The difference equals {payee} from {date} ({amount}), still pending: maybe the bank already recorded it." },
                      { payee: suggestion.transaction.payee ?? "", date: shortDate(suggestion.transaction.occurredAt, intl.locale), amount: money(suggestion.transaction.amountCents) },
                    )
                  ) : (
                    intl.formatMessage(
                      { id: "reconcile.clue.unticked", defaultMessage: "The difference equals {payee} from {date}, which you removed from the tally." },
                      { payee: suggestion.transaction.payee ?? "", date: shortDate(suggestion.transaction.occurredAt, intl.locale) },
                    )
                  )
                ) : (
                  intl.formatMessage({
                    id: "reconcile.clue.none",
                    defaultMessage: "Check the transactions one by one against the statement. If the difference is real (for example a forgotten fee), add it as a transaction.",
                  })
                )}
                {suggestion && (
                  <div style={{ marginTop: 8 }}>
                    <button type="button" className="btn" disabled={submitting} onClick={() => void handleApplySuggestion()}>
                      {suggestion.kind === "pending"
                        ? intl.formatMessage({ id: "reconcile.clue.markCleared", defaultMessage: "Mark it as cleared" })
                        : intl.formatMessage({ id: "reconcile.clue.retick", defaultMessage: "Put it back in the tally" })}
                    </button>
                  </div>
                )}
              </div>
              {!showAdjustment ? (
                <button type="button" className="btn" onClick={() => setShowAdjustment(true)}>
                  {intl.formatMessage({ id: "reconcile.adjustment.add", defaultMessage: "Add an adjustment of {amount}" }, { amount: money(tally.differenceCents ?? 0) })}
                </button>
              ) : (
                <div className="adjustment">
                  <div className="field">
                    <label htmlFor="rec-adj-cat">{intl.formatMessage({ id: "reconcile.adjustment.category", defaultMessage: "Category" })}</label>
                    <select id="rec-adj-cat" value={adjustmentCategoryId} onChange={(event) => setAdjustmentCategoryId(event.target.value)}>
                      <option value="">{intl.formatMessage({ id: "transactions.form.unassigned", defaultMessage: "Unassigned" })}</option>
                      {openCategories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="rec-adj-memo">{intl.formatMessage({ id: "reconcile.adjustment.memo", defaultMessage: "Memo (optional)" })}</label>
                    <input id="rec-adj-memo" type="text" value={adjustmentMemo} onChange={(event) => setAdjustmentMemo(event.target.value)} />
                  </div>
                  <div className="row-btns">
                    <button type="button" className="btn" disabled={submitting} onClick={() => setShowAdjustment(false)}>
                      {intl.formatMessage({ id: "reconcile.adjustment.cancel", defaultMessage: "Cancel" })}
                    </button>
                    <button type="button" className="btn primary" disabled={submitting} onClick={() => void handleAdjustmentConfirm()}>
                      {intl.formatMessage({ id: "reconcile.adjustment.confirm", defaultMessage: "Confirm the adjustment" })}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
