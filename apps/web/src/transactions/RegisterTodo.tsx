import { useIntl } from "react-intl";

import "../budget/Todo.css";
import type { RegisterTodoItem } from "./registerTodo.ts";

interface Props {
  readonly items: readonly RegisterTodoItem[];
  readonly money: (cents: number) => string;
  readonly locale: string;
  /** Shows only the first `limit` items plus "+N more" — the phone layout (design.md: "the first two things to do under the balance"). Every item shows on the desktop, without this prop. */
  readonly limit?: number;
  onRecord(scheduledTransactionId: string): void;
  onMark(transactionId: string): void;
}

function shortDate(iso: string, locale: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * The account register's own "To do" list (#337): reuses the budget month's own `.todo`/`.todo-i`
 * structure and tokens (`Todo.css`), with this screen's own three actions instead — Record,
 * Mark, Reconcile — never `@envelope/core`'s `computeTodos` (a different list, `registerTodo.ts`).
 * "Reconcile" stays informational only, like every `Todo.tsx` item was before it had a
 * destination to open into: the reconciliation flow itself is `#60`'s own job, not this one's.
 */
export default function RegisterTodo({ items, money, locale, limit, onRecord, onMark }: Props) {
  const intl = useIntl();
  const shown = limit === undefined ? items : items.slice(0, limit);
  const hiddenCount = items.length - shown.length;

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="todo">
      <h5>
        {intl.formatMessage({ id: "register.todo.heading", defaultMessage: "To do" })}
        <span>{intl.formatMessage({ id: "budget.todo.count", defaultMessage: "{count, plural, one {# thing} other {# things}}" }, { count: items.length })}</span>
      </h5>
      {shown.map((item) => {
        if (item.kind === "recordOverdue") {
          return (
            <button key={`record:${item.scheduledTransactionId}`} type="button" className="todo-i" onClick={() => onRecord(item.scheduledTransactionId)}>
              <span className="dot" />
              <span>
                <b>{intl.formatMessage({ id: "register.todo.record.title", defaultMessage: "Record {payee}" }, { payee: item.payee })}</b>
                <small>
                  {intl.formatMessage(
                    { id: "register.todo.record.sub", defaultMessage: "scheduled for {date}, not yet in the account" },
                    { date: shortDate(item.date, locale) },
                  )}
                </small>
              </span>
              <span className="n">{money(item.amountCents)}</span>
            </button>
          );
        }
        if (item.kind === "markPending") {
          return (
            <button key={`mark:${item.transactionId}`} type="button" className="todo-i" onClick={() => onMark(item.transactionId)}>
              <span className="dot" />
              <span>
                <b>{intl.formatMessage({ id: "register.todo.mark.title", defaultMessage: "Mark {payee}" }, { payee: item.payee })}</b>
                <small>
                  {intl.formatMessage(
                    { id: "register.todo.mark.sub", defaultMessage: "{date}, still awaiting the bank" },
                    { date: shortDate(item.date, locale) },
                  )}
                </small>
              </span>
              <span className="n">{money(item.amountCents)}</span>
            </button>
          );
        }
        return (
          <div key="reconcile" className="todo-i">
            <span className="dot" />
            <span>
              <b>{intl.formatMessage({ id: "register.todo.reconcile.title", defaultMessage: "Reconcile the account" })}</b>
              <small>
                {intl.formatMessage(
                  { id: "register.todo.reconcile.sub", defaultMessage: "{count, plural, one {# transaction} other {# transactions}} cleared" },
                  { count: item.clearedCount },
                )}
              </small>
            </span>
            <span className="n">{money(item.clearedCents)}</span>
          </div>
        );
      })}
      {hiddenCount > 0 && (
        <p className="todo-more">{intl.formatMessage({ id: "budget.todo.more", defaultMessage: "+{count} more" }, { count: hiddenCount })}</p>
      )}
    </div>
  );
}
