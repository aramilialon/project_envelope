import type { TodoItem } from "@envelope/core";
import { useIntl } from "react-intl";
import "./Todo.css";

interface Props {
  readonly items: readonly TodoItem[];
  readonly categoryNameById: ReadonlyMap<string, string>;
  readonly money: (cents: number) => string;
  readonly locale: string;
  /** Shows only the first `limit` items plus "+N more" (the phone layout, `#331`: "the first three things to do, with how many more"). Every item still shows on the desktop, without this prop. */
  readonly limit?: number;
  /**
   * Makes each item (but `overassigned`, which names no single destination) a button instead of
   * plain text, opening the item's own category — or, for `targetsNeeded`, the "Targets" panel,
   * since several categories can share one such item (the phone layout, `#331`). The desktop
   * leaves this out: a row's own detail already opens by tapping the row itself, and `#330`'s
   * own "Scheduled" panel is already a toolbar action, so a to-do item staying informational-only
   * there is deliberate, not a gap (`#326`'s own docblock already said so).
   */
  readonly onItemClick?: (item: TodoItem) => void;
}

/** A dot's own colour: red for cash (needs new money now), amber for a card, a reservation shortfall or uncovered debt; none for the rest. */
function dotClass(kind: TodoItem["kind"]): string {
  if (kind === "overassigned" || kind === "cashOverspending") return "dot r";
  if (kind === "cardOverspending" || kind === "reservationShortfall" || kind === "cardDebtUncovered") return "dot w";
  return "dot";
}

function shortDate(iso: string, locale: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

interface Sentence {
  readonly title: string;
  readonly sub: string;
}

function sentenceFor(item: TodoItem, categoryNameById: ReadonlyMap<string, string>, locale: string, intl: ReturnType<typeof useIntl>): Sentence {
  const categoryName = (id: string) => categoryNameById.get(id) ?? id;

  switch (item.kind) {
    case "overassigned":
      return {
        title: intl.formatMessage({ id: "budget.todo.overassigned.title", defaultMessage: "You assigned more than you have" }),
        sub: intl.formatMessage({ id: "budget.todo.overassigned.sub", defaultMessage: "take money back from a category" }),
      };
    case "cashOverspending":
      return {
        title: intl.formatMessage({ id: "budget.todo.cover.title", defaultMessage: "Cover {category}" }, { category: categoryName(item.categoryId) }),
        sub: intl.formatMessage({ id: "budget.todo.cashOverspending.sub", defaultMessage: "overspent in cash: cover it before the month ends" }),
      };
    case "cardOverspending":
      return {
        title: intl.formatMessage({ id: "budget.todo.cover.title", defaultMessage: "Cover {category}" }, { category: categoryName(item.categoryId) }),
        sub: intl.formatMessage({ id: "budget.todo.cardOverspending.sub", defaultMessage: "overspent with a card: otherwise it stays as card debt" }),
      };
    case "scheduledOverdue":
      return {
        title: intl.formatMessage({ id: "budget.todo.scheduledOverdue.title", defaultMessage: "Record {payee}" }, { payee: item.payee }),
        sub: intl.formatMessage(
          { id: "budget.todo.scheduledOverdue.sub", defaultMessage: "scheduled for {date}, not yet in the account" },
          { date: shortDate(item.date, locale) },
        ),
      };
    case "reservationShortfall":
      return {
        title: intl.formatMessage(
          { id: "budget.todo.reservationShortfall.title", defaultMessage: "{category}: not enough for what is scheduled" },
          { category: categoryName(item.categoryId) },
        ),
        sub: intl.formatMessage({ id: "budget.todo.reservationShortfall.sub", defaultMessage: "still missing" }),
      };
    case "cardDebtUncovered":
      return {
        title: intl.formatMessage(
          { id: "budget.todo.cardDebtUncovered.title", defaultMessage: "Debt to cover: {category}" },
          { category: categoryName(item.categoryId) },
        ),
        sub: intl.formatMessage({ id: "budget.todo.cardDebtUncovered.sub", defaultMessage: "card spending with no money set aside for it" }),
      };
    case "targetsNeeded":
      return {
        title:
          item.categoryIds.length === 1
            ? intl.formatMessage(
                { id: "budget.todo.targetsNeeded.title.one", defaultMessage: "Fund the {category} target" },
                { category: categoryName(item.categoryIds[0]!) },
              )
            : intl.formatMessage(
                { id: "budget.todo.targetsNeeded.title.many", defaultMessage: "Fund {count} targets" },
                { count: item.categoryIds.length },
              ),
        sub: intl.formatMessage({ id: "budget.todo.targetsNeeded.sub", defaultMessage: "what is still missing this month" }),
      };
  }
}

/**
 * The budget month's own "To do" list (`@envelope/core`'s `computeTodos`, #326), replacing the
 * old one-line notices (#61): what needs attention this month, each with its own amount. Not yet
 * interactive — opening a category's own row (#327), recording a scheduled transaction (#330) and
 * funding targets for an arbitrary subset of categories have no destination to open into yet, so
 * each row is informational only, the same way an ordinary category row is until #327 lands.
 */
export default function Todo({ items, categoryNameById, money, locale, limit, onItemClick }: Props) {
  const intl = useIntl();
  const shown = limit === undefined ? items : items.slice(0, limit);
  const hiddenCount = items.length - shown.length;

  return (
    <div className="todo">
      <h5>
        {intl.formatMessage({ id: "budget.todo.heading", defaultMessage: "To do" })}
        {items.length > 0 && (
          <span>{intl.formatMessage({ id: "budget.todo.count", defaultMessage: "{count, plural, one {# thing} other {# things}}" }, { count: items.length })}</span>
        )}
      </h5>
      {items.length === 0 ? (
        <p className="explain">{intl.formatMessage({ id: "budget.todo.empty", defaultMessage: "Nothing to fix this month." })}</p>
      ) : (
        <>
          {shown.map((item) => {
            const { title, sub } = sentenceFor(item, categoryNameById, locale, intl);
            const key = item.kind === "scheduledOverdue" ? `scheduledOverdue:${item.scheduledTransactionId}` : item.kind === "overassigned" ? "overassigned" : item.kind === "targetsNeeded" ? `targetsNeeded:${item.categoryIds.join(",")}` : `${item.kind}:${item.categoryId}`;
            const clickable = onItemClick && item.kind !== "overassigned";
            const content = (
              <>
                <span className={dotClass(item.kind)} />
                <span>
                  <b>{title}</b>
                  <small>{sub}</small>
                </span>
                <span className="n">{money(item.amountCents)}</span>
              </>
            );
            return clickable ? (
              <button key={key} type="button" className="todo-i" onClick={() => onItemClick(item)}>
                {content}
              </button>
            ) : (
              <div key={key} className="todo-i">
                {content}
              </div>
            );
          })}
          {hiddenCount > 0 && (
            <p className="todo-more">{intl.formatMessage({ id: "budget.todo.more", defaultMessage: "+{count} more" }, { count: hiddenCount })}</p>
          )}
        </>
      )}
    </div>
  );
}
