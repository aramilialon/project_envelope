/**
 * Turns individual transactions into the monthly totals used by
 * `computeBudgetMonth`.
 *
 * Accounts are either "cash" (checking, savings, cash, prepaid cards: money
 * the user owns) or "credit" (credit cards: money borrowed). On-budget
 * accounts take part in the budget; off-budget accounts (investments,
 * mortgages) do not.
 *
 * Rules:
 * - Transactions of off-budget accounts are ignored. A transfer between an
 *   on-budget and an off-budget account is budget activity on the on-budget
 *   side:
 *   - with a category (for example "Investments") or splits, it is ordinary
 *     activity of that category, whichever its direction;
 *   - money coming in from the off-budget account with no category (or in
 *     UNASSIGNED) is income to assign, in the month of its date, like any
 *     other income (#598);
 *   - money going out to the off-budget account needs a real category:
 *     without one, or in UNASSIGNED, it is "uncategorized_transaction";
 *   - on a credit card, with no category or in UNASSIGNED, either way, it is
 *     "unsupported_transaction" (see the limitation below). For an outgoing
 *     card leg with no category the core answers "unsupported_transaction",
 *     while the API refuses every on-budget to off-budget transfer without a
 *     category earlier, with "uncategorized_transaction".
 * - A transaction in the UNASSIGNED category on a cash account is income.
 * - Every other transaction on an on-budget account needs a category, or
 *   splits whose amounts add up to the transaction amount.
 * - Spending and refunds on a credit card carry the card's payment category,
 *   so the budget can move the covered money to it.
 * - A transfer between two on-budget accounts is stored as two transactions,
 *   one per account, and needs no category:
 *   - cash to cash: no budget effect;
 *   - cash to credit card: a card payment, counted once, from the card side;
 *   - credit card to credit card: a card-to-card transfer (design.md, "Credit cards"), counted
 *     once, from the outflow (negative) leg.
 *
 * Limitation of this version: income on a credit card (for example cashback)
 * is not modeled as a transaction here, and is refused as
 * "unsupported_transaction"; design.md ("Credit cards") plans it as an income
 * transaction plus a card payment. The API refuses it at write time
 * ("card_income_not_supported", #548) so a stored row cannot break the month. A
 * card's starting balance is not an Activity at all — see `CardBalance` in
 * budget-month.ts.
 *
 * Every amount written is capped at `MAX_AMOUNT_CENTS` (ADR 0002), so the
 * sizes of a workspace's on-budget transactions add up to a safe integer in
 * practice. If they do not (amounts stored before the cap), the aggregation
 * stops with "amount_total_overflow" naming the transactions to look at,
 * rather than letting a budget figure lose precision.
 */

import { ValidationError } from "../errors.ts";
import type { Cents } from "../money.ts";
import { assertCents, MAX_AMOUNT_CENTS } from "../money.ts";
import type { LocalDate } from "../month.ts";
import { monthOf } from "../month.ts";
import type { Activity, CardPayment, CardTransfer, Income } from "./budget-month.ts";

/** How many transactions an "amount_total_overflow" names at most. */
const MAX_NAMED_TRANSACTIONS = 20;

/**
 * The error for on-budget transactions whose sizes add up beyond the safe range: it names, in
 * `details.transactionIds` (comma-separated), the ones above the cap, or the largest ones if none
 * is, and how many it names in `details.count`.
 */
function totalOverflow(transactions: readonly BudgetTransaction[], byId: ReadonlyMap<string, BudgetAccount>): ValidationError {
  const onBudget = transactions.filter((t) => byId.get(t.accountId)?.onBudget === true);
  const overCap = onBudget.filter((t) => Math.abs(t.amount) > MAX_AMOUNT_CENTS);
  const named = (overCap.length > 0 ? overCap : [...onBudget].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)))
    .slice(0, MAX_NAMED_TRANSACTIONS)
    .map((t) => t.id);
  return new ValidationError("amount_total_overflow", "the on-budget transactions add up beyond the safe range of minor units", {
    label: "transactions",
    transactionIds: named.join(","),
    count: named.length,
  });
}

/** Category id that marks income: money that stays unassigned until the user assigns it. */
export const UNASSIGNED = "unassigned";

export interface BudgetAccount {
  readonly id: string;
  readonly type: "cash" | "credit";
  readonly onBudget: boolean;
  /** Required for on-budget credit cards: the category that holds the money to pay the card. */
  readonly paymentCategoryId?: string;
}

export interface Split {
  readonly categoryId: string;
  readonly amount: Cents;
}

export interface BudgetTransaction {
  readonly id: string;
  readonly accountId: string;
  /** Date in the workspace's time zone. */
  readonly date: LocalDate;
  /** Outflows are negative, inflows positive. */
  readonly amount: Cents;
  readonly categoryId?: string;
  /** Set when the transaction is one side of a transfer between two accounts. */
  readonly transferAccountId?: string;
  readonly splits?: readonly Split[];
}

export interface AggregatedTransactions {
  readonly income: Income[];
  readonly activity: Activity[];
  readonly cardPayments: CardPayment[];
  readonly cardTransfers: CardTransfer[];
}

function indexAccounts(accounts: readonly BudgetAccount[]): Map<string, BudgetAccount> {
  const byId = new Map<string, BudgetAccount>();
  for (const account of accounts) {
    if (byId.has(account.id)) {
      throw new ValidationError("duplicate_account", `duplicate account: "${account.id}"`, { accountId: account.id });
    }
    if (account.type === "credit" && account.onBudget && account.paymentCategoryId === undefined) {
      throw new ValidationError(
        "missing_payment_category",
        `on-budget credit card "${account.id}" has no payment category`,
        { accountId: account.id },
      );
    }
    byId.set(account.id, account);
  }
  return byId;
}

function findAccount(byId: ReadonlyMap<string, BudgetAccount>, id: string): BudgetAccount {
  const account = byId.get(id);
  if (account === undefined) {
    throw new ValidationError("unknown_account", `unknown account: "${id}"`, { accountId: id });
  }
  return account;
}

/**
 * Aggregates transactions into income, category activity and card payments.
 *
 * @throws ValidationError for unknown accounts, invalid dates or amounts,
 *   uncategorized transactions, splits that do not add up, and unsupported cases.
 */
export function aggregateTransactions(
  accounts: readonly BudgetAccount[],
  transactions: readonly BudgetTransaction[],
): AggregatedTransactions {
  const byId = indexAccounts(accounts);
  const income: Income[] = [];
  const activity: Activity[] = [];
  const cardPayments: CardPayment[] = [];
  const cardTransfers: CardTransfer[] = [];

  let magnitude = 0;
  for (const t of transactions) {
    const account = findAccount(byId, t.accountId);
    const month = monthOf(t.date);
    if (!Number.isInteger(t.amount)) assertCents(t.amount);
    if (!account.onBudget) continue;
    magnitude += Math.abs(t.amount);
    if (!Number.isSafeInteger(magnitude)) throw totalOverflow(transactions, byId);

    if (t.transferAccountId !== undefined) {
      const other = findAccount(byId, t.transferAccountId);
      if (other.onBudget) {
        if (account.type === "credit" && other.type === "credit") {
          // Emitted once, from the outflow (negative) leg only, so the pair is not
          // double-counted. Both sides are on-budget credit cards, so both are guaranteed a
          // payment category (indexAccounts already validated it).
          if (t.amount < 0 && account.paymentCategoryId !== undefined && other.paymentCategoryId !== undefined) {
            cardTransfers.push({
              sourcePaymentCategoryId: account.paymentCategoryId,
              destinationPaymentCategoryId: other.paymentCategoryId,
              month,
              amount: -t.amount,
            });
          }
          continue;
        }
        if (account.type === "credit" && account.paymentCategoryId !== undefined) {
          // The card side of a payment: an inflow on the card is money paid to it.
          cardPayments.push({ paymentCategoryId: account.paymentCategoryId, month, amount: t.amount });
        }
        continue; // cash to cash, or the cash side of a card payment
      }
      // A transfer to or from an off-budget account is budget activity on the on-budget leg. With
      // a real category (or splits) it is ordinary activity: continue with the category below.
      // Without one, money coming in from the off-budget account is income to assign (#598);
      // money going out to it needs a real category, and a card leg is not supported yet.
      const hasSplits = t.splits !== undefined && t.splits.length > 0;
      if (!hasSplits && (t.categoryId === undefined || t.categoryId === UNASSIGNED)) {
        if (account.type === "credit") {
          throw new ValidationError(
            "unsupported_transaction",
            `an uncategorized transfer between a credit card and an off-budget account is not supported yet (transaction "${t.id}")`,
            { transactionId: t.id },
          );
        }
        if (t.amount > 0) {
          income.push({ month, date: t.date, amount: t.amount });
          continue;
        }
        throw new ValidationError(
          "uncategorized_transaction",
          `transaction "${t.id}" moves money to an off-budget account and has no category`,
          { transactionId: t.id },
        );
      }
    }

    const card = account.type === "credit" ? account.paymentCategoryId : undefined;
    const withCard = (a: Omit<Activity, "paymentCategoryId">): Activity =>
      card === undefined ? a : { ...a, paymentCategoryId: card };

    if (t.splits !== undefined && t.splits.length > 0) {
      let total = 0;
      for (const split of t.splits) {
        assertCents(split.amount);
        total += split.amount;
      }
      if (total !== t.amount) {
        throw new ValidationError(
          "split_mismatch",
          `splits of transaction "${t.id}" add up to ${total} instead of ${t.amount}`,
          { transactionId: t.id, splitTotal: total, amount: t.amount },
        );
      }
      for (const split of t.splits) {
        if (split.categoryId === UNASSIGNED) {
          throw new ValidationError(
            "unsupported_transaction",
            `income cannot be part of a split (transaction "${t.id}")`,
            { transactionId: t.id },
          );
        }
        activity.push(withCard({ categoryId: split.categoryId, month, amount: split.amount }));
      }
      continue;
    }

    if (t.categoryId === undefined) {
      throw new ValidationError("uncategorized_transaction", `transaction "${t.id}" has no category`, {
        transactionId: t.id,
      });
    }

    if (t.categoryId === UNASSIGNED) {
      if (account.type === "credit") {
        throw new ValidationError(
          "unsupported_transaction",
          `income on a credit card is not supported yet (transaction "${t.id}")`,
          { transactionId: t.id },
        );
      }
      income.push({ month, date: t.date, amount: t.amount });
      continue;
    }

    activity.push(withCard({ categoryId: t.categoryId, month, amount: t.amount }));
  }

  return { income, activity, cardPayments, cardTransfers };
}
