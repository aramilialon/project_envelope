import {
  computeCategoryBar,
  computePaymentCategoryBar,
  computeTimeline,
  computeTodos,
  formatMoney,
  type Bar as BarGeometry,
  type OverdueScheduledItem,
  type TimelineEvent,
  type TimelineEventStatus,
} from "@envelope/core";
import { useState } from "react";
import { useIntl } from "react-intl";
import { useParams } from "react-router-dom";

import { useBandSecondRow } from "../layout/useBandSecondRow.tsx";
import { usePhoneWidth } from "../layout/usePhoneWidth.ts";
import QuickAssignPanel from "../targets/QuickAssignPanel.tsx";
import TargetsPanel from "../targets/TargetsPanel.tsx";
import { useTargets } from "../targets/useTargets.ts";
import { useWorkspaces } from "../workspaces/useWorkspaces.ts";
import { currentMonthIn, todayIsoIn } from "../workspaceDate.ts";
import Bar from "./Bar.tsx";
import type { MonthEvent } from "./api.ts";
import MoveMoneyForm, { type MoveMoneyInitial } from "./MoveMoneyForm.tsx";
import PaymentCategoryDetail from "./PaymentCategoryDetail.tsx";
import RowDetail from "./RowDetail.tsx";
import Timeline from "./Timeline.tsx";
import { formatPayees } from "./timelineLabels.ts";
import Todo from "./Todo.tsx";
import { useBudgetMonth, type BudgetGroup, type BudgetGroupCategory } from "./useBudgetMonth.ts";
import { useBudgetMonthEvents } from "./useBudgetMonthEvents.ts";
import "./BudgetScreen.css";

type Panel = "quickAssign" | "targets" | null;
type Status = "credit" | "cash" | "short" | "pos" | "zero";

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

function barFor(category: BudgetGroupCategory): BarGeometry {
  return category.isPaymentCategory ? computePaymentCategoryBar(category) : computeCategoryBar(category);
}

/** The same precedence `Bar.tsx`'s own tail colour uses, reused here for the available-amount cell. */
function statusOf(category: BudgetGroupCategory, bar: BarGeometry): Status {
  if (bar.kind === "category" && bar.tail) {
    return bar.tail.kind;
  }
  return category.available > 0 ? "pos" : "zero";
}

function groupAvailable(group: BudgetGroup): number {
  return group.categories.reduce((total, c) => total + c.available, 0);
}

function groupOverspentCount(group: BudgetGroup): number {
  return group.categories.filter((c) => c.cashOverspending > 0 || c.creditOverspending > 0).length;
}

function daysInMonth(month: string): number {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  return new Date(year, monthNumber, 0).getDate();
}

/** Only set when the workspace's own time zone is known and `month` is the one actually showing on today's own calendar in it — otherwise there is no "today" line or overdue distinction to draw. */
function todayOf(month: string, timeZone: string | undefined): { iso: string; day: number } | undefined {
  if (timeZone === undefined || month !== currentMonthIn(timeZone)) {
    return undefined;
  }
  const iso = todayIsoIn(timeZone);
  return { iso, day: Number(iso.slice(8, 10)) };
}

function toTimelineEvents(events: readonly MonthEvent[], today: { iso: string } | undefined): TimelineEvent[] {
  return events.map((e): TimelineEvent => {
    const direction = e.amountCents >= 0 ? "in" : "out";
    const status: TimelineEventStatus = e.kind !== "scheduled" ? "recorded" : today !== undefined && e.date < today.iso ? "overdue" : "scheduled";
    return { day: Number(e.date.slice(8, 10)), amountCents: Math.abs(e.amountCents), direction, status, payee: e.payee ?? "" };
  });
}

function toOverdueScheduledItems(events: readonly MonthEvent[], today: { iso: string } | undefined): OverdueScheduledItem[] {
  if (today === undefined) {
    return [];
  }
  const items: OverdueScheduledItem[] = [];
  for (const e of events) {
    if (e.kind === "scheduled" && e.date < today.iso && e.scheduledTransactionId !== undefined && e.categoryId !== null) {
      items.push({ scheduledTransactionId: e.scheduledTransactionId, categoryId: e.categoryId, payee: e.payee ?? "", date: e.date, amountCents: Math.abs(e.amountCents) });
    }
  }
  return items;
}

/**
 * The budget month screen (#53, #55, #324): the band's second row (month navigation, the
 * "unassigned" box, the facts row) portals into `AppLayout`'s own band (`useBandSecondRow`) since
 * this is the only screen with one so far; below it, every category as a bar instead of the old
 * assigned/activity/available table, grouped, each with its own spent line and available amount
 * (`docs/design.md`, "Bars").
 *
 * Deferred, deliberately not this issue's job: a category's own target meter and reservation
 * clock status lines (need each category's target and scheduled transactions, not fetched here —
 * #327's row detail is the natural place to add them); a card's payment category "debt covered"
 * line when its debt is fully covered (`uncovered` is 0 in that case exactly the same as "no debt
 * at all" — the API has no separate field for the card's real balance — so nothing is shown
 * rather than guessing a figure; only "still to cover" is shown, since that debt is recoverable
 * from `available + uncovered`); the toolbar's filter tabs, Summary/Scheduled/Undo (need data or
 * forms no earlier issue built yet); the group name's summary side sheet — a group row is plain,
 * non-interactive text until then, not a button with nowhere to go.
 */
export default function BudgetScreen() {
  const intl = useIntl();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const workspaces = useWorkspaces();
  const currentWorkspace = workspaces.status === "ok" ? workspaces.workspaces.find((w) => w.id === workspaceId) : undefined;
  const timeZone = currentWorkspace?.timeZone;
  const isPhone = usePhoneWidth();

  // The initial month is a best guess in the *browser's* own time zone (the workspace's is not
  // known yet, before `workspaces` itself resolves) — corrected once, below, the moment it is, so
  // a workspace in a markedly different time zone never gets stuck showing the wrong month.
  // Done during render (React's own "adjusting state when a prop changes" pattern), not an
  // effect, so the correction takes effect before the wrong month's own data ever paints.
  const [month, setMonth] = useState(() => currentMonthIn(Intl.DateTimeFormat().resolvedOptions().timeZone));
  const [appliedWorkspaceMonth, setAppliedWorkspaceMonth] = useState(false);
  if (timeZone !== undefined && !appliedWorkspaceMonth) {
    setAppliedWorkspaceMonth(true);
    setMonth(currentMonthIn(timeZone));
  }

  const [panel, setPanel] = useState<Panel>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [openCategoryId, setOpenCategoryId] = useState<string | null>(null);
  const [moveMoney, setMoveMoney] = useState<MoveMoneyInitial | null>(null);
  const state = useBudgetMonth(workspaceId!, month);
  const eventsState = useBudgetMonthEvents(workspaceId!, month);
  const targetsState = useTargets(workspaceId!, month, state.status === "ok" ? state.budgetMonth.categories.map((c) => c.categoryId) : []);

  const currency = currentWorkspace?.baseCurrency;
  const money = (cents: number) => formatMoney(cents, { locale: intl.locale, currency: currency ?? "EUR" });

  const secondRow = useBandSecondRow(
    state.status === "ok" ? (
      <div className="bm">
        <div>
          <div className="mnav">
            <button
              type="button"
              className="arrow"
              aria-label={intl.formatMessage({ id: "budget.month.previous", defaultMessage: "Previous month" })}
              onClick={() => setMonth((m) => shiftMonth(m, -1))}
            >
              ←
            </button>
            <span>{intl.formatMessage({ id: "budget.monthNav.label", defaultMessage: "Month" })}</span>
            <button
              type="button"
              className="arrow"
              aria-label={intl.formatMessage({ id: "budget.month.next", defaultMessage: "Next month" })}
              onClick={() => setMonth((m) => shiftMonth(m, 1))}
            >
              →
            </button>
          </div>
          <h1 className="month">{monthLabel(month, intl.locale)}</h1>
        </div>
        <div className="rta">
          <div>
            <small>{intl.formatMessage({ id: "budget.unassigned", defaultMessage: "Unassigned" })}</small>
            <span className={`amt n${state.budgetMonth.unassigned < 0 ? " low" : ""}`}>{money(state.budgetMonth.unassigned)}</span>
          </div>
          <button type="button" className="btn primary" onClick={() => setMoveMoney({ kind: "assign" })}>
            {intl.formatMessage({ id: "budget.actions.assign", defaultMessage: "Assign" })}
          </button>
        </div>
        <div className="facts">
          <span>
            {intl.formatMessage({ id: "budget.reserved", defaultMessage: "Reserved for scheduled transactions" })}{" "}
            <b>{money(state.budgetMonth.reserved)}</b>
          </span>
          <span>
            {intl.formatMessage({ id: "budget.assignedInFuture", defaultMessage: "Already assigned to future months" })}{" "}
            <b>{money(state.budgetMonth.assignedInFuture)}</b>
          </span>
        </div>
      </div>
    ) : null,
  );

  if (state.status === "loading") {
    return (
      <>
        {secondRow}
        <p role="status">{intl.formatMessage({ id: "budget.loading", defaultMessage: "Loading your budget…" })}</p>
      </>
    );
  }

  if (state.status === "error") {
    return (
      <>
        {secondRow}
        <p role="alert">{intl.formatMessage({ id: "budget.error", defaultMessage: "We could not load your budget." })}</p>
      </>
    );
  }

  const { groups } = state;
  const today = todayOf(month, timeZone);
  const categoryNameById = new Map(
    [...state.budgetMonth.categories, ...state.budgetMonth.paymentCategories].map((c) => [c.categoryId, c.name] as const),
  );

  return (
    <div className="budget-screen">
      {secondRow}

      <div className="over">
        {!isPhone && (
          <Timeline
            // Only the timeline waits for the events fetch — an empty list draws just the axis
            // until it resolves (never nothing at all: `.time`'s own box never changes size, so
            // nothing around it jumps once the real marks arrive). Hidden below 600px entirely:
            // a compact rendering of its own is #331's job, not a shrunk copy of this one.
            layout={computeTimeline({
              daysInMonth: daysInMonth(month),
              today: today?.day,
              events: eventsState.status === "ok" ? toTimelineEvents(eventsState.events, today) : [],
              formatAmount: money,
              formatPayees: (payees, extra) => formatPayees(payees, extra, intl),
            })}
            monthLabel={monthLabel(month, intl.locale)}
            money={money}
          />
        )}
        <Todo
          items={computeTodos({
            unassignedCents: state.budgetMonth.unassigned,
            categories: state.budgetMonth.categories,
            paymentCategories: state.budgetMonth.paymentCategories,
            // Unlike the timeline, the "To do" list has plenty to show without the events fetch
            // (overspending, uncovered debt, targets) — only the overdue-scheduled entries need
            // it, so those are simply left out (not the whole list) until it resolves, or if it
            // fails outright.
            overdueScheduledItems: eventsState.status === "ok" ? toOverdueScheduledItems(eventsState.events, today) : [],
            targetsNeeded:
              targetsState.status === "ok"
                ? [...targetsState.progressByCategory.entries()]
                    .filter(([, progress]) => progress.missing > 0)
                    .map(([categoryId, progress]) => ({ categoryId, missingCents: progress.missing }))
                : [],
          })}
          categoryNameById={categoryNameById}
          money={money}
          locale={intl.locale}
        />
      </div>

      <div className="acts">
        <button type="button" className="btn" onClick={() => setPanel("targets")}>
          {intl.formatMessage({ id: "budget.actions.targets", defaultMessage: "Targets" })}
        </button>
        <button type="button" className="btn" onClick={() => setPanel("quickAssign")}>
          {intl.formatMessage({ id: "budget.actions.quickAssign", defaultMessage: "Quick assign" })}
        </button>
      </div>

      {groups.length === 0 ? (
        <p className="empty">
          {intl.formatMessage({
            id: "budget.empty",
            defaultMessage: "No categories yet: add some from Workspace settings.",
          })}
        </p>
      ) : (
        <div className="bars">
          {groups.map((group) => {
            const isCollapsed = collapsed[group.id] ?? false;
            const overspentCount = groupOverspentCount(group);
            return (
              <div key={group.id}>
                <div className="bgr">
                  <span className="gh">
                    <button
                      type="button"
                      className="chev"
                      aria-expanded={!isCollapsed}
                      aria-label={intl.formatMessage(
                        { id: isCollapsed ? "budget.group.expand" : "budget.group.collapse", defaultMessage: isCollapsed ? "Open {name}" : "Close {name}" },
                        { name: group.name },
                      )}
                      onClick={() => setCollapsed((c) => ({ ...c, [group.id]: !isCollapsed }))}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </button>
                    <span className="gname">{group.name}</span>
                    {overspentCount > 0 && <span className="count over n">{overspentCount}</span>}
                  </span>
                  <span className="n gsum">{money(groupAvailable(group))}</span>
                </div>
                {!isCollapsed &&
                  group.categories.map((category) => {
                    const bar = barFor(category);
                    const status = statusOf(category, bar);
                    const isOpen = openCategoryId === category.categoryId;
                    const rowContent = (
                      <>
                        <span className="cn">
                          <b>{category.name}</b>
                          <StatusLine category={category} money={money} intl={intl} />
                        </span>
                        <Bar bar={bar} />
                        <span className="av">
                          <span className={`amt-cell n ${status}`}>
                            {status === "cash" && (
                              <span className="sr">
                                {intl.formatMessage({ id: "budget.bar.overspentSr", defaultMessage: "Overspent:" })}
                              </span>
                            )}
                            {status === "credit" && (
                              <span className="tag">{intl.formatMessage({ id: "budget.bar.cardTag", defaultMessage: "Card" })}</span>
                            )}
                            {status === "short" && (
                              <span className="tag">{intl.formatMessage({ id: "budget.bar.reservedTag", defaultMessage: "Reserved" })}</span>
                            )}
                            {money(category.available)}
                          </span>
                        </span>
                      </>
                    );
                    return (
                      <div key={category.categoryId}>
                        <button
                          type="button"
                          className="brow"
                          aria-expanded={isOpen}
                          onClick={() => setOpenCategoryId(isOpen ? null : category.categoryId)}
                        >
                          {rowContent}
                        </button>
                        {isOpen &&
                          (category.isPaymentCategory ? (
                            <PaymentCategoryDetail
                              categoryName={category.name}
                              available={category.available}
                              uncovered={category.uncovered}
                              currency={currency ?? "EUR"}
                              onClose={() => setOpenCategoryId(null)}
                              onAssignFromUnassigned={() => setMoveMoney({ kind: "assignTo", categoryId: category.categoryId })}
                              onMoveMoneyHere={() => setMoveMoney({ kind: "moveTo", categoryId: category.categoryId })}
                            />
                          ) : (
                            <RowDetail
                              workspaceId={workspaceId!}
                              month={month}
                              categoryId={category.categoryId}
                              categoryName={category.name}
                              assigned={category.assigned}
                              currency={currency ?? "EUR"}
                              onClose={() => setOpenCategoryId(null)}
                              onChanged={() => state.refetch()}
                              onMoveMoney={() => setMoveMoney({ kind: "moveTo", categoryId: category.categoryId })}
                            />
                          ))}
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </div>
      )}

      {groups.length > 0 && (
        <div className="legend" aria-hidden="true">
          <span>
            <i style={{ background: "var(--spent)" }} />
            {intl.formatMessage({ id: "budget.legend.spent", defaultMessage: "spent" })}
          </span>
          <span>
            <i style={{ background: "var(--bar)" }} />
            {intl.formatMessage({ id: "budget.legend.available", defaultMessage: "still available" })}
          </span>
          <span>
            <i
              style={{
                background: "repeating-linear-gradient(90deg,var(--paper) 0 3px,transparent 3px 6px),var(--bar)",
              }}
            />
            {intl.formatMessage({ id: "budget.legend.reserved", defaultMessage: "reserved" })}
          </span>
          <span>
            <i style={{ background: "var(--red)" }} />
            {intl.formatMessage({ id: "budget.legend.cash", defaultMessage: "overspent in cash" })}
          </span>
          <span>
            <i
              style={{
                background: "repeating-linear-gradient(135deg,var(--hatch-bg) 0 4px,var(--hatch) 4px 6px)",
              }}
            />
            {intl.formatMessage({ id: "budget.legend.credit", defaultMessage: "overspent with a card, debt to cover" })}
          </span>
          <span>
            <i style={{ border: "1.5px dashed var(--warn)" }} />
            {intl.formatMessage({ id: "budget.legend.short", defaultMessage: "reserved beyond what is available" })}
          </span>
        </div>
      )}

      {panel === "targets" && (
        <TargetsPanel
          workspaceId={workspaceId!}
          month={month}
          categories={state.budgetMonth.categories}
          currency={currency ?? "EUR"}
          onClose={() => setPanel(null)}
          onChanged={() => state.refetch()}
        />
      )}
      {panel === "quickAssign" && (
        <QuickAssignPanel
          workspaceId={workspaceId!}
          month={month}
          groups={groups}
          onClose={() => setPanel(null)}
          onDone={() => {
            setPanel(null);
            state.refetch();
          }}
        />
      )}
      {moveMoney && (
        <MoveMoneyForm
          workspaceId={workspaceId!}
          month={month}
          unassignedCents={state.budgetMonth.unassigned}
          assignedInFutureCents={state.budgetMonth.assignedInFuture}
          groups={groups}
          currency={currency ?? "EUR"}
          initial={moveMoney}
          onClose={() => setMoveMoney(null)}
          onChanged={() => {
            setMoveMoney(null);
            state.refetch();
          }}
        />
      )}
    </div>
  );
}

interface StatusLineProps {
  readonly category: BudgetGroupCategory;
  readonly money: (cents: number) => string;
  readonly intl: ReturnType<typeof useIntl>;
}

/** The muted line under a category's name: what was spent of what it was given, or a card's own debt still to cover. */
function StatusLine({ category, money, intl }: StatusLineProps) {
  if (category.isPaymentCategory) {
    if (category.uncovered <= 0) {
      return null;
    }
    const debt = category.available + category.uncovered;
    return (
      <small className="spent n">
        {intl.formatMessage(
          { id: "budget.bar.debtToCover", defaultMessage: "{uncovered} to cover of {debt} of debt" },
          { uncovered: money(category.uncovered), debt: money(debt) },
        )}
      </small>
    );
  }

  const budget = Math.max(0, category.carriedOver + category.assigned);
  const spent = Math.max(0, -category.activity);

  if (spent > 0) {
    if (category.creditOverspending > 0) {
      return (
        <small className="spent n">
          {budget > 0
            ? intl.formatMessage(
                { id: "budget.bar.spentWithCardOf", defaultMessage: "{spent} spent with a card of {budget}" },
                { spent: money(spent), budget: money(budget) },
              )
            : intl.formatMessage({ id: "budget.bar.spentWithCard", defaultMessage: "{spent} spent with a card" }, { spent: money(spent) })}
        </small>
      );
    }
    return (
      <small className="spent n">
        {budget > 0
          ? intl.formatMessage({ id: "budget.bar.spentOf", defaultMessage: "{spent} spent of {budget}" }, { spent: money(spent), budget: money(budget) })
          : intl.formatMessage({ id: "budget.bar.spent", defaultMessage: "{spent} spent" }, { spent: money(spent) })}
      </small>
    );
  }
  if (budget > 0) {
    return (
      <small className="spent n">
        {intl.formatMessage({ id: "budget.bar.toSpend", defaultMessage: "{budget} to spend" }, { budget: money(budget) })}
      </small>
    );
  }
  return <small className="spent n">{intl.formatMessage({ id: "budget.bar.noActivity", defaultMessage: "No activity" })}</small>;
}
