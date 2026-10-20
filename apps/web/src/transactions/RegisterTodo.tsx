import { useIntl } from "react-intl";

import "../budget/Todo.css";
import { shortDate } from "../format.ts";
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

/**
 * The account register's own "To do" list (#337): reuses the budget month's own `.todo`/`.todo-i`
 * structure and tokens (`Todo.css`), with this screen's own two actions instead — Record, Mark —
 * never `@envelope/core`'s `computeTodos` (a different list, `registerTodo.ts`).
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
      })}
      {hiddenCount > 0 && (
        <p className="todo-more">{intl.formatMessage({ id: "budget.todo.more", defaultMessage: "+{count} more" }, { count: hiddenCount })}</p>
      )}
    </div>
  );
}
