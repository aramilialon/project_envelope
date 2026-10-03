import { amountNeededToCover, currencyDecimals, formatMoney, parseAmount } from "@envelope/core";
import { useState, type FormEvent, type ReactNode } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";

import SideSheet from "../layout/SideSheet.tsx";
import { createAssignments } from "./api.ts";
import type { BudgetGroup, BudgetGroupCategory } from "./useBudgetMonth.ts";
import "./MoveMoneyForm.css";

/** The select value standing for unassigned money — never a real category id (those are UUIDs). */
const UNASSIGNED = "unassigned";

export type MoveMoneyInitial =
  /** "Assign" in the band's unassigned-money box: from unassigned, destination not chosen yet. */
  | { readonly kind: "assign" }
  /** "Move money" from a category's own row: preselects it as the destination and the amount it is missing. */
  | { readonly kind: "moveTo"; readonly categoryId: string }
  /**
   * "Assign €X from unassigned money" on a card's payment category row (#329): like `moveTo`,
   * but the source is always unassigned money, never another category — the user asked for that
   * source by name, so it is never silently swapped for one that can cover the gap.
   */
  | { readonly kind: "assignTo"; readonly categoryId: string };

interface Props {
  readonly workspaceId: string;
  readonly month: string;
  readonly unassignedCents: number;
  readonly assignedInFutureCents: number;
  readonly groups: readonly BudgetGroup[];
  readonly currency: string;
  readonly initial: MoveMoneyInitial;
  onClose(): void;
  /** Called once the move actually happens — the budget month needs refetching. */
  onChanged(): void;
}

function plainAmount(cents: number, locale: string, currency: string): string {
  const decimals = currencyDecimals(currency);
  return new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(cents / 10 ** decimals);
}

function shiftMonth(month: string, delta: number): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7)) + delta;
  const zeroBased = monthNumber - 1;
  const wrappedYear = year + Math.floor(zeroBased / 12);
  const wrappedMonth = ((zeroBased % 12) + 12) % 12;
  return `${wrappedYear}-${String(wrappedMonth + 1).padStart(2, "0")}`;
}

function monthLabel(month: string, locale: string): string {
  const date = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(date);
}

function flatten(groups: readonly BudgetGroup[]): Map<string, BudgetGroupCategory & { readonly groupName: string }> {
  const byId = new Map<string, BudgetGroupCategory & { readonly groupName: string }>();
  for (const group of groups) {
    for (const category of group.categories) {
      byId.set(category.categoryId, { ...category, groupName: group.name });
    }
  }
  return byId;
}

/** A source that can cover `gap` on its own, the same pick `docs/ux/mockups/budget-month.html`'s own `openMove` makes: the first one found, excluding the destination itself. */
function autoSource(byId: Map<string, BudgetGroupCategory>, excludeId: string, gap: number): string | undefined {
  for (const [id, category] of byId) {
    if (id !== excludeId && category.available >= gap) {
      return id;
    }
  }
  return undefined;
}

/**
 * The "Assign / Move money" side sheet (#328, design.md's "Assign / Move money"): one form for
 * both "Assign" (the band's unassigned-money box) and "Move money" (a category's own row, #327) —
 * From (unassigned money or a category with money), To (a category, or unassigned money when
 * moving from a category), the month (this one or one of the next two, only when assigning from
 * unassigned money), amount, and a live preview of both sides before/after. One ledger entry
 * (`POST /assignments`, the same endpoint #327's row-detail editing already uses).
 */
export default function MoveMoneyForm({ workspaceId, month, unassignedCents, assignedInFutureCents, groups, currency, initial, onClose, onChanged }: Props) {
  const intl = useIntl();
  const auth = useAuth();
  const byId = flatten(groups);

  const initialState = (() => {
    if (initial.kind === "assign") {
      return { from: UNASSIGNED, to: "", targetMonth: month, amount: "" };
    }
    const category = byId.get(initial.categoryId);
    const gap = category ? amountNeededToCover(category) : 0;
    const amount = gap > 0 ? plainAmount(gap, intl.locale, currency) : "";
    if (initial.kind === "assignTo") {
      return { from: UNASSIGNED, to: initial.categoryId, targetMonth: month, amount };
    }
    const source = gap > 0 && gap > unassignedCents ? autoSource(byId, initial.categoryId, gap) : undefined;
    return { from: source ?? UNASSIGNED, to: initial.categoryId, targetMonth: month, amount };
  })();

  const [from, setFrom] = useState(initialState.from);
  const [to, setTo] = useState(initialState.to);
  const [targetMonth, setTargetMonth] = useState(initialState.targetMonth);
  const [amountText, setAmountText] = useState(initialState.amount);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const money = (cents: number) => formatMoney(cents, { locale: intl.locale, currency });
  const nameOf = (id: string) => byId.get(id)?.name ?? "";

  const isAssign = from === UNASSIGNED;
  const showMonth = isAssign && to !== "" && to !== UNASSIGNED;

  let amount: number | null = null;
  try {
    amount = amountText.trim() ? parseAmount(amountText, { locale: intl.locale, currency }) : null;
  } catch {
    amount = null;
  }

  let error: string | null = null;
  if (to === "") {
    error = intl.formatMessage({ id: "moveMoney.needTo", defaultMessage: "Choose where to put the money." });
  } else if (from === to) {
    error = intl.formatMessage({ id: "moveMoney.sameSourceAndDestination", defaultMessage: "The source and destination are the same." });
  } else if (amount === null || amount <= 0) {
    error = intl.formatMessage({ id: "moveMoney.needAmount", defaultMessage: "Enter an amount, for example 20 or 20.00." });
  } else if (from !== UNASSIGNED) {
    const sourceAvailable = Math.max(0, byId.get(from)?.available ?? 0);
    if (amount > sourceAvailable) {
      error =
        sourceAvailable > 0
          ? intl.formatMessage(
              { id: "moveMoney.notEnoughInSource", defaultMessage: "{name} has only {available} available." },
              { name: nameOf(from), available: money(sourceAvailable) },
            )
          : intl.formatMessage({ id: "moveMoney.nothingInSource", defaultMessage: "{name} has no money available to move." }, { name: nameOf(from) });
    }
  }

  const effectiveMonth = showMonth ? targetMonth : month;
  const warn = isAssign && amount !== null && amount > unassignedCents;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accessToken = auth.user?.access_token;
    if (!accessToken || error || amount === null) {
      return;
    }
    setSubmitError(null);
    setSubmitting(true);
    try {
      await createAssignments(accessToken, workspaceId, [
        {
          month: effectiveMonth,
          sourceCategoryId: from === UNASSIGNED ? null : from,
          destinationCategoryId: to === UNASSIGNED ? null : to,
          amountCents: amount,
        },
      ]);
      onChanged();
    } catch {
      setSubmitError(intl.formatMessage({ id: "moveMoney.error", defaultMessage: "We could not move this money." }));
      setSubmitting(false);
    }
  }

  function fromOptions() {
    return (
      <>
        <option value={UNASSIGNED}>
          {intl.formatMessage({ id: "moveMoney.unassignedOption", defaultMessage: "Unassigned ({amount})" }, { amount: money(unassignedCents) })}
        </option>
        {groups.map((group) => {
          const options = group.categories.filter((c) => c.available > 0 || c.categoryId === from);
          if (options.length === 0) {
            return null;
          }
          return (
            <optgroup label={group.name} key={group.id}>
              {options.map((c) => (
                <option value={c.categoryId} key={c.categoryId}>
                  {c.name} ({money(c.available)})
                </option>
              ))}
            </optgroup>
          );
        })}
      </>
    );
  }

  function toOptions() {
    return (
      <>
        {to === "" && <option value="">{intl.formatMessage({ id: "moveMoney.chooseCategory", defaultMessage: "Choose a category" })}</option>}
        {!isAssign && <option value={UNASSIGNED}>{intl.formatMessage({ id: "moveMoney.unassigned", defaultMessage: "Unassigned" })}</option>}
        {groups.map((group) => (
          <optgroup label={group.name} key={group.id}>
            {group.categories.map((c) => (
              <option value={c.categoryId} key={c.categoryId}>
                {c.name} ({money(c.available)})
              </option>
            ))}
          </optgroup>
        ))}
      </>
    );
  }

  function balanceLine(key: string, label: string, before: number, after: number) {
    return (
      <div className="ba" key={key}>
        <span>{label}</span>
        <span className="n">
          {money(before)} → <b>{money(after)}</b>
        </span>
      </div>
    );
  }

  function preview(): ReactNode {
    if (error) {
      return <span className="err">{error}</span>;
    }
    if (amount === null) {
      return null;
    }
    const lines: ReactNode[] = [];
    lines.push(
      from === UNASSIGNED
        ? balanceLine("from", intl.formatMessage({ id: "moveMoney.unassigned", defaultMessage: "Unassigned" }), unassignedCents, unassignedCents - amount)
        : balanceLine("from", nameOf(from), byId.get(from)!.available, byId.get(from)!.available - amount),
    );
    if (to === UNASSIGNED) {
      lines.push(balanceLine("to", intl.formatMessage({ id: "moveMoney.unassigned", defaultMessage: "Unassigned" }), unassignedCents, unassignedCents + amount));
    } else if (showMonth && targetMonth !== month) {
      lines.push(
        balanceLine(
          "to",
          intl.formatMessage({ id: "moveMoney.assignedToFuture", defaultMessage: "Already assigned to {month}" }, { month: monthLabel(targetMonth, intl.locale) }),
          assignedInFutureCents,
          assignedInFutureCents + amount,
        ),
      );
    } else {
      const destination = byId.get(to)!;
      lines.push(balanceLine("to", nameOf(to), destination.available, destination.available + amount));
      const gap = amountNeededToCover(destination);
      if (gap > 0) {
        lines.push(
          <div className="ba note" key="gap">
            {amount >= gap
              ? destination.isPaymentCategory
                ? intl.formatMessage({ id: "moveMoney.cardDebtCovered", defaultMessage: "The card's debt is fully covered." })
                : destination.cashOverspending > 0 || destination.creditOverspending > 0
                  ? intl.formatMessage({ id: "moveMoney.overspendingCovered", defaultMessage: "The overspending is covered." })
                  : intl.formatMessage({ id: "moveMoney.reservationCovered", defaultMessage: "The scheduled transactions are covered." })
              : intl.formatMessage({ id: "moveMoney.stillMissing", defaultMessage: "{missing} is still missing." }, { missing: money(gap - amount) })}
          </div>,
        );
      }
    }
    if (warn) {
      lines.push(
        <div className="ba note warn" key="warn">
          {intl.formatMessage({
            id: "moveMoney.unassignedBelowZero",
            defaultMessage: "Unassigned will go below zero: you are assigning money that has not arrived yet.",
          })}
        </div>,
      );
    }
    return lines;
  }

  const title = isAssign
    ? intl.formatMessage({ id: "moveMoney.assignTitle", defaultMessage: "Assign" })
    : intl.formatMessage({ id: "moveMoney.moveTitle", defaultMessage: "Move money" });

  return (
    <SideSheet title={title} onClose={onClose}>
      <form className="move-money-form" onSubmit={(event) => void handleSubmit(event)}>
        <p className="explain">
          {isAssign
            ? intl.formatMessage({
                id: "moveMoney.assignExplain",
                defaultMessage: "Give a category some of the money that has arrived and is not assigned yet, for this month or a future one.",
              })
            : intl.formatMessage({
                id: "moveMoney.moveExplain",
                defaultMessage: "Move money already assigned from one category to another, or back to unassigned.",
              })}
        </p>

        <div className="field">
          <label htmlFor="mv-from">{intl.formatMessage({ id: "moveMoney.from", defaultMessage: "From" })}</label>
          <select
            id="mv-from"
            value={from}
            onChange={(event) => {
              const value = event.target.value;
              setFrom(value);
              if (value === UNASSIGNED && to === UNASSIGNED) {
                setTo("");
              }
            }}
          >
            {fromOptions()}
          </select>
        </div>

        <div className="field">
          <label htmlFor="mv-to">{intl.formatMessage({ id: "moveMoney.to", defaultMessage: "To" })}</label>
          <select id="mv-to" value={to} onChange={(event) => setTo(event.target.value)}>
            {toOptions()}
          </select>
        </div>

        {showMonth && (
          <div className="field">
            <label htmlFor="mv-month">{intl.formatMessage({ id: "moveMoney.forMonth", defaultMessage: "For the month" })}</label>
            <select id="mv-month" value={targetMonth} onChange={(event) => setTargetMonth(event.target.value)}>
              {[month, shiftMonth(month, 1), shiftMonth(month, 2)].map((m) => (
                <option value={m} key={m}>
                  {m === month
                    ? monthLabel(m, intl.locale)
                    : intl.formatMessage({ id: "moveMoney.futureMonthOption", defaultMessage: "{month} (future month)" }, { month: monthLabel(m, intl.locale) })}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="field">
          <label htmlFor="mv-amount">{intl.formatMessage({ id: "moveMoney.amount", defaultMessage: "Amount" })}</label>
          <input id="mv-amount" type="text" inputMode="decimal" value={amountText} onChange={(event) => setAmountText(event.target.value)} placeholder="0.00" />
        </div>

        <div className="preview" aria-live="polite">
          {preview()}
        </div>

        {submitError && (
          <p className="hint bad" role="alert">
            {submitError}
          </p>
        )}

        <div className="row-btns">
          <button type="button" className="btn" onClick={onClose}>
            {intl.formatMessage({ id: "common.action.cancel", defaultMessage: "Cancel" })}
          </button>
          <button type="submit" className="btn primary" disabled={submitting || error !== null}>
            {isAssign
              ? intl.formatMessage({ id: "moveMoney.submitAssign", defaultMessage: "Assign {amount}" }, { amount: amount !== null ? money(amount) : "" })
              : intl.formatMessage({ id: "moveMoney.submitMove", defaultMessage: "Move {amount}" }, { amount: amount !== null ? money(amount) : "" })}
          </button>
        </div>
      </form>
    </SideSheet>
  );
}
