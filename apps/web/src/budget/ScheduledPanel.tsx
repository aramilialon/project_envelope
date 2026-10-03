import { formatMoney, monthOf, nextMonth, parseAmount } from "@envelope/core";
import { useState, type FormEvent } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";

import { useAccounts } from "../accounts/useAccounts.ts";
import SideSheet from "../layout/SideSheet.tsx";
import { upsertGoal, type RepeatInterval } from "../targets/api.ts";
import { useTargets } from "../targets/useTargets.ts";
import { todayIsoIn } from "../workspaceDate.ts";
import { createScheduledTransaction, recordScheduledTransaction, skipScheduledTransaction, type RecurUnit, type ScheduledTransaction } from "./api.ts";
import type { BudgetGroup } from "./useBudgetMonth.ts";
import { useScheduledTransactions } from "./useScheduledTransactions.ts";
import "./ScheduledPanel.css";

/** `GoalInput.every` only accepts these — a scheduled item recurring every other month count, or by day/year, cannot become a "repeating" target (design.md's own target kinds are month-based only); "Use as target" is left out for those, rather than inventing an unsupported shape. */
const MONTHLY_REPEAT_INTERVALS: readonly RepeatInterval[] = [2, 3, 4, 6, 12, 24];
const RECUR_UNITS: readonly RecurUnit[] = ["day", "month", "year"];

interface Props {
  readonly workspaceId: string;
  readonly month: string;
  readonly groups: readonly BudgetGroup[];
  readonly currency: string;
  readonly timeZone: string | undefined;
  onClose(): void;
  /** Called once Record, Skip or a new scheduled transaction actually changes something — the budget month needs refetching. */
  onChanged(): void;
}

function splitTotal(s: ScheduledTransaction): number {
  return s.splits.reduce((sum, split) => sum + split.amountCents, 0);
}

/**
 * The "Scheduled" side sheet (#330, design.md's "Scheduled transactions"): money reserved this
 * month, "To record" (overdue) and "By the end of the month" groups, each item with Record and
 * Skip; a preview of next month's reservations against each category's own target; "+ New
 * scheduled transaction". `apps/api` has no single endpoint to list reservations by month (only
 * every scheduled transaction, `listScheduledTransactions`), so the grouping happens here.
 *
 * Scheduled income has no backend support yet (`#347`) — every scheduled transaction is an
 * expense (a single category, design.md's own "payee, category, account, amount, next date,
 * repeat"); the mockup's own "Expected income" group and the income/expense toggle on "+ New
 * scheduled transaction" are left out until then.
 */
export default function ScheduledPanel({ workspaceId, month, groups, currency, timeZone, onClose, onChanged }: Props) {
  const intl = useIntl();
  const auth = useAuth();
  const scheduled = useScheduledTransactions(workspaceId);
  const accounts = useAccounts(workspaceId);
  const [showNew, setShowNew] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const categories = groups.flatMap((g) => g.categories.filter((c) => !c.isPaymentCategory).map((c) => ({ ...c, groupName: g.name })));
  const categoryNameById = new Map(categories.map((c) => [c.categoryId, c.name] as const));
  const money = (cents: number) => formatMoney(cents, { locale: intl.locale, currency });

  const today = timeZone ? todayIsoIn(timeZone) : undefined;
  const list = scheduled.status === "ok" ? scheduled.scheduledTransactions : [];
  const thisMonth = list.filter((s) => monthOf(s.nextDueDate) === month);
  const overdue = thisMonth.filter((s) => today !== undefined && s.nextDueDate < today);
  const dueThisMonth = thisMonth.filter((s) => !overdue.includes(s));
  const reservedThisMonth = thisMonth.reduce((sum, s) => sum + splitTotal(s), 0);

  const theNextMonth = nextMonth(month);
  const nextMonthItems = list.filter((s) => monthOf(s.nextDueDate) === theNextMonth);
  const nextMonthByCategory = new Map<string, { amountCents: number; recurEvery: number; recurUnit: RecurUnit; count: number }>();
  for (const s of nextMonthItems) {
    for (const split of s.splits) {
      const existing = nextMonthByCategory.get(split.categoryId);
      nextMonthByCategory.set(split.categoryId, {
        amountCents: (existing?.amountCents ?? 0) + split.amountCents,
        recurEvery: s.recurEvery,
        recurUnit: s.recurUnit,
        count: (existing?.count ?? 0) + 1,
      });
    }
  }
  const nextMonthTargets = useTargets(workspaceId, theNextMonth, [...nextMonthByCategory.keys()]);
  const nextMonthTotal = [...nextMonthByCategory.values()].reduce((sum, v) => sum + v.amountCents, 0);

  async function withBusy(id: string, action: () => Promise<void>) {
    setBusyId(id);
    try {
      await action();
      scheduled.refetch();
      onChanged();
    } finally {
      setBusyId(null);
    }
  }

  async function handleRecord(s: ScheduledTransaction) {
    const accessToken = auth.user?.access_token;
    if (!accessToken) {
      return;
    }
    await withBusy(s.id, () => recordScheduledTransaction(accessToken, workspaceId, s.id).then(() => undefined));
  }

  async function handleSkip(s: ScheduledTransaction) {
    const accessToken = auth.user?.access_token;
    if (!accessToken) {
      return;
    }
    await withBusy(s.id, () => skipScheduledTransaction(accessToken, workspaceId, s.id).then(() => undefined));
  }

  async function handleUseAsTarget(categoryId: string) {
    const accessToken = auth.user?.access_token;
    const info = nextMonthByCategory.get(categoryId);
    if (!accessToken || !info) {
      return;
    }
    const input =
      info.recurUnit === "month" && info.recurEvery === 1
        ? { kind: "monthly" as const, amountCents: info.amountCents }
        : info.recurUnit === "month" && info.count === 1 && (MONTHLY_REPEAT_INTERVALS as readonly number[]).includes(info.recurEvery)
          ? { kind: "repeating" as const, amountCents: info.amountCents, dueMonth: theNextMonth, every: info.recurEvery as RepeatInterval }
          : { kind: "monthly" as const, amountCents: info.amountCents };
    await upsertGoal(accessToken, workspaceId, categoryId, input);
    onChanged();
  }

  function schedRow(s: ScheduledTransaction) {
    const isLate = overdue.includes(s);
    const categoryNames = s.splits.map((split) => categoryNameById.get(split.categoryId) ?? "").join(", ");
    const account = accounts.status === "ok" ? accounts.accounts.find((a) => a.id === s.accountId) : undefined;
    return (
      <div className={`sch${isLate ? " late" : ""}`} key={s.id}>
        <small className="n">{new Intl.DateTimeFormat(intl.locale, { day: "numeric", month: "short" }).format(new Date(`${s.nextDueDate}T00:00:00`))}</small>
        <span>
          <b>{s.payee ?? categoryNames}</b>
          <small>
            {[s.payee ? categoryNames : null, account?.name].filter(Boolean).join(" · ")}
          </small>
        </span>
        <span className="n">{money(-splitTotal(s))}</span>
        <span className="sch-b">
          <button type="button" className="plain" disabled={busyId === s.id} onClick={() => void handleRecord(s)}>
            {intl.formatMessage({ id: "scheduled.record", defaultMessage: "Record" })}
          </button>
          <button type="button" className="plain quiet" disabled={busyId === s.id} onClick={() => void handleSkip(s)}>
            {intl.formatMessage({ id: "scheduled.skip", defaultMessage: "Skip" })}
          </button>
        </span>
      </div>
    );
  }

  const title = intl.formatMessage({ id: "scheduled.title", defaultMessage: "Scheduled" });

  return (
    <SideSheet title={title} onClose={onClose}>
      <div className="scheduled-panel">
        <div className="gstats">
          <div>
            <small>{intl.formatMessage({ id: "scheduled.reservedThisMonth", defaultMessage: "Reserved this month" })}</small>
            <b className="n">{money(reservedThisMonth)}</b>
          </div>
          <div>
            <small>{intl.formatMessage({ id: "scheduled.toRecordCount", defaultMessage: "To record" })}</small>
            <b className="n">{overdue.length}</b>
          </div>
          <div>
            <small>{intl.formatMessage({ id: "scheduled.expectedNextMonth", defaultMessage: "Expected next month" })}</small>
            <b className="n">{money(nextMonthTotal)}</b>
          </div>
        </div>

        <p className="explain">
          {intl.formatMessage({
            id: "scheduled.explain",
            defaultMessage: "A scheduled transaction reserves its own money in its category from the first day of the month: the available amount already shows it taken out. Recording it turns the reservation into a transaction; the available amount does not change.",
          })}
        </p>

        {overdue.length > 0 && (
          <div className="sec">
            <h5>{intl.formatMessage({ id: "scheduled.toRecord", defaultMessage: "To record" })}</h5>
            {overdue.map(schedRow)}
          </div>
        )}

        <div className="sec">
          <h5>{intl.formatMessage({ id: "scheduled.byEndOfMonth", defaultMessage: "By the end of the month" })}</h5>
          {dueThisMonth.length > 0 ? (
            dueThisMonth.map(schedRow)
          ) : (
            <span style={{ color: "var(--muted)" }}>{intl.formatMessage({ id: "scheduled.none", defaultMessage: "None." })}</span>
          )}
        </div>

        <div className="sec">
          <h5>{intl.formatMessage({ id: "scheduled.nextMonthPreview", defaultMessage: "Preview: the start of next month" })}</h5>
          {nextMonthByCategory.size === 0 ? (
            <span style={{ color: "var(--muted)" }}>
              {intl.formatMessage({ id: "scheduled.nextMonthNone", defaultMessage: "Nothing scheduled yet." })}
            </span>
          ) : (
            [...nextMonthByCategory.entries()].map(([categoryId, info]) => {
              const progress = nextMonthTargets.status === "ok" ? nextMonthTargets.progressByCategory.get(categoryId) : undefined;
              const within = progress !== undefined && progress.asks >= info.amountCents;
              const canUseAsTarget =
                progress === undefined &&
                info.recurUnit === "month" &&
                (info.recurEvery === 1 || (info.count === 1 && (MONTHLY_REPEAT_INTERVALS as readonly number[]).includes(info.recurEvery)));
              return (
                <div className="qa static" key={categoryId}>
                  <span>{categoryNameById.get(categoryId) ?? ""}</span>
                  <span className="dots" />
                  <span className={`n${progress === undefined || !within ? " need" : ""}`}>
                    {progress === undefined
                      ? intl.formatMessage({ id: "scheduled.noTarget", defaultMessage: "No target" })
                      : within
                        ? intl.formatMessage({ id: "scheduled.withinTarget", defaultMessage: "Within the target" })
                        : intl.formatMessage(
                            { id: "scheduled.targetMissing", defaultMessage: "The target asks {asks}: {missing} missing" },
                            { asks: money(progress.asks), missing: money(info.amountCents - progress.asks) },
                          )}
                    {canUseAsTarget && (
                      <button type="button" className="plain" style={{ marginLeft: 8 }} onClick={() => void handleUseAsTarget(categoryId)}>
                        {intl.formatMessage({ id: "scheduled.useAsTarget", defaultMessage: "Use as target" })}
                      </button>
                    )}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {showNew ? (
          <NewScheduledTransactionForm
            workspaceId={workspaceId}
            categories={categories}
            currency={currency}
            onCancel={() => setShowNew(false)}
            onSaved={() => {
              setShowNew(false);
              scheduled.refetch();
              onChanged();
            }}
          />
        ) : (
          <button type="button" className="btn" style={{ alignSelf: "flex-start" }} onClick={() => setShowNew(true)}>
            {intl.formatMessage({ id: "scheduled.new", defaultMessage: "+ New scheduled transaction" })}
          </button>
        )}
      </div>
    </SideSheet>
  );
}

interface CategoryOption {
  readonly categoryId: string;
  readonly name: string;
  readonly groupName: string;
}

interface NewFormProps {
  readonly workspaceId: string;
  readonly categories: readonly CategoryOption[];
  readonly currency: string;
  onCancel(): void;
  onSaved(): void;
}

function NewScheduledTransactionForm({ workspaceId, categories, currency, onCancel, onSaved }: NewFormProps) {
  const intl = useIntl();
  const auth = useAuth();
  const accounts = useAccounts(workspaceId);
  const onBudgetAccounts = accounts.status === "ok" ? accounts.accounts.filter((a) => a.onBudget && a.closedAt === null) : [];

  const [payee, setPayee] = useState("");
  const [categoryId, setCategoryId] = useState(categories[0]?.categoryId ?? "");
  // Not initialized from `onBudgetAccounts[0]` directly: that list is still empty on the first
  // render, before `useAccounts` resolves, and `useState`'s own initial value is captured once,
  // at mount, never recomputed once the real list arrives.
  const [chosenAccountId, setChosenAccountId] = useState("");
  const accountId = chosenAccountId || onBudgetAccounts[0]?.id || "";
  const [amountText, setAmountText] = useState("");
  const [nextDueDate, setNextDueDate] = useState("");
  const [recurEvery, setRecurEvery] = useState("1");
  const [recurUnit, setRecurUnit] = useState<RecurUnit>("month");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  let amount: number | null = null;
  try {
    amount = amountText.trim() ? parseAmount(amountText, { locale: intl.locale, currency }) : null;
  } catch {
    amount = null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accessToken = auth.user?.access_token;
    if (!accessToken) {
      return;
    }
    setError(null);
    if (!payee.trim()) {
      setError(intl.formatMessage({ id: "scheduled.needPayee", defaultMessage: "Write who this payment goes to." }));
      return;
    }
    if (!categoryId || !accountId) {
      setError(intl.formatMessage({ id: "scheduled.needCategoryAccount", defaultMessage: "Choose a category and an account." }));
      return;
    }
    if (amount === null || amount <= 0) {
      setError(intl.formatMessage({ id: "scheduled.needAmount", defaultMessage: "Enter an amount, for example 20 or 20.00." }));
      return;
    }
    if (!nextDueDate) {
      setError(intl.formatMessage({ id: "scheduled.needDate", defaultMessage: "Choose the next date." }));
      return;
    }
    const every = Number(recurEvery);
    if (!Number.isInteger(every) || every <= 0) {
      setError(intl.formatMessage({ id: "scheduled.needRecurrence", defaultMessage: "The repeat interval must be a positive whole number." }));
      return;
    }
    setSubmitting(true);
    try {
      await createScheduledTransaction(accessToken, workspaceId, {
        accountId,
        payee: payee.trim(),
        nextDueDate,
        recurEvery: every,
        recurUnit,
        categoryId,
        amountCents: amount,
      });
      onSaved();
    } catch {
      setError(intl.formatMessage({ id: "scheduled.error", defaultMessage: "We could not save this scheduled transaction." }));
      setSubmitting(false);
    }
  }

  return (
    <form className="sec" onSubmit={(event) => void handleSubmit(event)}>
      <h5>{intl.formatMessage({ id: "scheduled.new", defaultMessage: "+ New scheduled transaction" })}</h5>
      <div className="field">
        <label htmlFor="sch-payee">{intl.formatMessage({ id: "scheduled.payee", defaultMessage: "Payee" })}</label>
        <input id="sch-payee" type="text" value={payee} onChange={(event) => setPayee(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="sch-category">{intl.formatMessage({ id: "scheduled.category", defaultMessage: "Category" })}</label>
        <select id="sch-category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
          {categories.map((c) => (
            <option value={c.categoryId} key={c.categoryId}>
              {c.groupName} · {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="sch-account">{intl.formatMessage({ id: "scheduled.account", defaultMessage: "Account" })}</label>
        <select id="sch-account" value={accountId} onChange={(event) => setChosenAccountId(event.target.value)}>
          {onBudgetAccounts.map((a) => (
            <option value={a.id} key={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="sch-amount">{intl.formatMessage({ id: "scheduled.amount", defaultMessage: "Amount" })}</label>
        <input id="sch-amount" type="text" inputMode="decimal" value={amountText} onChange={(event) => setAmountText(event.target.value)} placeholder="0.00" />
      </div>
      <div className="field">
        <label htmlFor="sch-due">{intl.formatMessage({ id: "scheduled.nextDate", defaultMessage: "Next date" })}</label>
        <input id="sch-due" type="date" value={nextDueDate} onChange={(event) => setNextDueDate(event.target.value)} />
      </div>
      <div className="two">
        <div className="field">
          <label htmlFor="sch-every">{intl.formatMessage({ id: "scheduled.every", defaultMessage: "Repeats every" })}</label>
          <input id="sch-every" type="text" inputMode="numeric" value={recurEvery} onChange={(event) => setRecurEvery(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="sch-unit">{intl.formatMessage({ id: "scheduled.unit", defaultMessage: "Unit" })}</label>
          <select id="sch-unit" value={recurUnit} onChange={(event) => setRecurUnit(event.target.value as RecurUnit)}>
            {RECUR_UNITS.map((unit) => (
              <option value={unit} key={unit}>
                {intl.formatMessage(
                  { id: `scheduled.unit.${unit}`, defaultMessage: unit === "day" ? "Days" : unit === "month" ? "Months" : "Years" },
                )}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <p className="hint bad" role="alert">
          {error}
        </p>
      )}

      <div className="row-btns">
        <button type="button" className="btn" onClick={onCancel}>
          {intl.formatMessage({ id: "common.action.cancel", defaultMessage: "Cancel" })}
        </button>
        <button type="submit" className="btn primary" disabled={submitting}>
          {intl.formatMessage({ id: "scheduled.save", defaultMessage: "Save" })}
        </button>
      </div>
    </form>
  );
}
