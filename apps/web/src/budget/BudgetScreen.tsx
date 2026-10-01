import { formatMoney } from "@envelope/core";
import { useState } from "react";
import { useIntl } from "react-intl";
import { useParams } from "react-router-dom";

import { useWorkspaces } from "../workspaces/useWorkspaces.ts";
import { useBudgetMonth, type BudgetGroup } from "./useBudgetMonth.ts";
import "./BudgetScreen.css";

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(month: string, delta: 1 | -1): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7)) + delta;
  if (monthNumber === 0) {
    return `${year - 1}-12`;
  }
  if (monthNumber === 13) {
    return `${year + 1}-01`;
  }
  return `${year}-${String(monthNumber).padStart(2, "0")}`;
}

function monthLabel(month: string, locale: string): string {
  const date = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(date);
}

function sum(group: BudgetGroup, field: "assigned" | "activity" | "available"): number {
  return group.categories.reduce((total, category) => total + category[field], 0);
}

/**
 * The budget month screen (#53): ready to assign, every category's assigned/activity/available
 * and rollover across months — `docs/ux/mockups/budget-month.html`'s own table, without yet
 * the parts that belong to other issues (editing an assigned amount and the Assign/Move money
 * form are `#56`; targets and quick assign `#55`; the card-debt detail `#57`; scheduled
 * reservations `#217`; days of buffer `#58`). The "Assign" button that mockup draws is left
 * out for the same reason `AppLayout`/`WorkspaceSwitcher` already leave out buttons with
 * nowhere to go yet: it opens that same `#56` form.
 */
export default function BudgetScreen() {
  const intl = useIntl();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const workspaces = useWorkspaces();
  const [month, setMonth] = useState(currentMonth);
  const state = useBudgetMonth(workspaceId!, month);

  if (state.status === "loading") {
    return <p role="status">{intl.formatMessage({ id: "budget.loading", defaultMessage: "Loading your budget…" })}</p>;
  }

  if (state.status === "error") {
    return (
      <p role="alert">{intl.formatMessage({ id: "budget.error", defaultMessage: "We could not load your budget." })}</p>
    );
  }

  const currency = workspaces.status === "ok" ? workspaces.workspaces.find((w) => w.id === workspaceId)?.baseCurrency : undefined;
  const money = (cents: number) => formatMoney(cents, { locale: intl.locale, currency: currency ?? "EUR" });

  const { budgetMonth, groups } = state;
  const totalAssigned = groups.reduce((total, g) => total + sum(g, "assigned"), 0);
  const totalActivity = groups.reduce((total, g) => total + sum(g, "activity"), 0);
  const totalAvailable = groups.reduce((total, g) => total + sum(g, "available"), 0);

  return (
    <div className="budget-screen">
      <div className="head">
        <div className="month">
          <button
            type="button"
            className="arrow"
            aria-label={intl.formatMessage({ id: "budget.month.previous", defaultMessage: "Previous month" })}
            onClick={() => setMonth((m) => shiftMonth(m, -1))}
          >
            ←
          </button>
          <h1>{monthLabel(month, intl.locale)}</h1>
          <button
            type="button"
            className="arrow"
            aria-label={intl.formatMessage({ id: "budget.month.next", defaultMessage: "Next month" })}
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
          >
            →
          </button>
        </div>
        <div className="facts">
          <span>
            {intl.formatMessage({ id: "budget.assignedInFuture", defaultMessage: "Already assigned to future months" })}{" "}
            <b>{money(budgetMonth.assignedInFuture)}</b>
          </span>
          <span>
            {intl.formatMessage({ id: "budget.reserved", defaultMessage: "Reserved for scheduled transactions" })}{" "}
            <b>{money(budgetMonth.reserved)}</b>
          </span>
        </div>
        <div className="rta">
          <span className="label">{intl.formatMessage({ id: "budget.unassigned", defaultMessage: "Ready to assign" })}</span>
          <span className={`amt${budgetMonth.unassigned < 0 ? " low" : ""}`}>{money(budgetMonth.unassigned)}</span>
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="empty">
          {intl.formatMessage({
            id: "budget.empty",
            defaultMessage: "No categories yet: add some from Workspace settings.",
          })}
        </p>
      ) : (
        <table className="budget-table">
          <thead>
            <tr>
              <th>{intl.formatMessage({ id: "budget.column.category", defaultMessage: "Category" })}</th>
              <th className="n">
                {intl.formatMessage({ id: "budget.column.assigned", defaultMessage: "Assigned" })}
                <span className="total">{money(totalAssigned)}</span>
              </th>
              <th className="n">
                {intl.formatMessage({ id: "budget.column.activity", defaultMessage: "Activity" })}
                <span className="total">{money(totalActivity)}</span>
              </th>
              <th className="n">
                {intl.formatMessage({ id: "budget.column.available", defaultMessage: "Available" })}
                <span className="total">{money(totalAvailable)}</span>
              </th>
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.id}>
              <tr className="group-row">
                <th scope="rowgroup">{group.name}</th>
                <td className="n">{money(sum(group, "assigned"))}</td>
                <td className="n">{money(sum(group, "activity"))}</td>
                <td className="n">{money(sum(group, "available"))}</td>
              </tr>
              {group.categories.map((category) => (
                <tr key={category.categoryId}>
                  <td>{category.name}</td>
                  <td className="n">{money(category.assigned)}</td>
                  <td className="n">{money(category.activity)}</td>
                  <td className={`n${category.available < 0 ? " neg" : ""}`}>{money(category.available)}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      )}
    </div>
  );
}
