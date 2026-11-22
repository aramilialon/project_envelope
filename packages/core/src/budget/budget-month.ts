/**
 * Computes one month of an envelope budget.
 *
 * Given the lists of income, assignments, activity and credit card payments,
 * it computes for a month:
 * - unassigned money: money that has come in but is not assigned yet;
 * - for every category: assigned, activity of the month and available;
 * - for every credit card: its payment category, which holds the money set
 *   aside to pay the card.
 *
 * Rules:
 * 1. Only money that has already been received can be assigned, and a month's
 *    unassigned money never includes income dated after it. For the requested
 *    month M and every month N from M on, let
 *      cum(N) = income dated up to the earlier of (the end of N, today)
 *               − everything assigned to months up to N
 *               − cash overspending of the months before M,
 *    where a month N after M counts only its positive income: negative income
 *    (money going out of Unassigned, such as an overdraft recorded there)
 *    counts from its own month on, like cash overspending, and is never
 *    charged to earlier months (#782).
 *    Unassigned money in M is the smallest cum(N), N from M to the latest
 *    month with any data: M's money already assigned ahead to a later month
 *    is gone from M (rule 3), but a later month's assignment paid for by that
 *    later month's own income is not blamed on M (#488). Income dated after
 *    today counts nowhere until its date: it is expected income, not money
 *    received. The same holds for every positive activity amount (a refund, a
 *    categorized transfer in from an off-budget account), split by split
 *    (#668): dated after today, it counts nowhere — not in its category, not
 *    in any month, and on a card it moves nothing between the category and the
 *    payment category — until its date. Spending dated after today does count,
 *    against its category, from its own month on (the cautious side). `today`
 *    is an input (`BudgetInput.today`), so the function stays pure.
 * 2. A category's positive available balance rolls over to the next month.
 * 3. Money assigned to future months is already assigned: it reduces
 *    unassigned money immediately, as far as the later months' own income
 *    does not pay for it (`assignedInFuture` is the part that M's money pays).
 * 4. Spending on a credit card, as far as the category covers it, moves the
 *    same amount from the category to the card's payment category: the money
 *    is set aside to pay the card. A refund on the card moves it back. When a
 *    category spent on more than one card and covers only part of it (#731),
 *    the covered part goes first to the cards that still need money — whose
 *    real balance at the end of the month is above what their payment category
 *    holds so far (carried over, assigned, less payments, plus what earlier
 *    categories moved in), each up to that need and to its own spending — then
 *    to the others, each up to its own spending; cards in id order, categories
 *    in `categoryIds` order. The part of each card's spending left uncovered is
 *    that category's credit overspending on that card (`overspendingBy`).
 * 5. A card payment (a transfer from a cash account to the card) is spending
 *    of the payment category.
 * 6. A category still negative at the end of a month starts the next month at
 *    zero (for a payment category, see rule 9). The overspending is split in
 *    two:
 *    - credit overspending: the part paid with a credit card. It is new debt
 *      on the card, not covered by the payment category, and does NOT touch
 *      unassigned money;
 *    - cash overspending: the rest. That money has already left an account,
 *      so it is taken from unassigned money the following month.
 *    The overspending is attributed to credit card spending first, up to the
 *    amount spent with cards in that category and month.
 * 7. A scheduled transaction not yet recorded reserves its amount in its
 *    category for the month being computed (design.md, "Scheduled
 *    transactions"): `available` is net of it, but a reservation beyond what
 *    a category can cover is a warning, not overspending — nothing has
 *    actually happened yet, so it never feeds `creditOverspending`/
 *    `cashOverspending` or the next month's carried-over balance.
 *    Reservations never carry over: they only ever apply to the month
 *    actually requested, not to the earlier months this function also closes
 *    out along the way.
 * 8. A transfer from one card to another (design.md, "Credit cards"; #732):
 *    card B pays T of card A's debt, so B is charged T (the outflow leg) and A
 *    is paid T (the inflow leg). Money follows the debt: what A's payment
 *    category holds beyond what A still owes at the end of the month moves to
 *    B's, moved = min(T, max(0, A.available − A.owed)), with A.available the
 *    payment category's available before this transfer and A.owed signed (a
 *    card in credit releases its credit too, rule 9). A part that does not
 *    move is never cash overspending: it shows up only as B's uncovered debt,
 *    derived from B's real balance (`CardBalance`). A month's transfers are
 *    applied in date order, then id, each one reading the available the
 *    earlier ones left. Money assigned to B is never moved on by the transfer,
 *    so following the "To do" list once settles both cards.
 * 9. A card in credit (#660): when a card's real balance at the end of a month
 *    is negative (a refund after the card was paid), its payment category can
 *    be negative by up to that credit without it being overspending. With
 *    credit = max(0, −owed at the end of the month), the payment category's
 *    cash overspending is max(0, −available − credit): only the part beyond
 *    the card's credit is cash taken from next month's unassigned money. The
 *    rest carries over as a negative balance and returns to zero as the
 *    credit is spent with the card (covered card spending moves money in, as
 *    ever). The card's balance at the end of every month comes from its own
 *    transactions (`CardBalance.transactions`, `owedAsOf`).
 *
 * Coverage is decided on the month's final numbers: assigning more money to a
 * category later in the month also funds the credit card spending made
 * earlier, exactly as if the money had been there from the start.
 *
 * The function is "pure": it reads no database or network, receives
 * everything as parameters and returns a result. That makes it easy to test,
 * and it runs the same on the server, in the browser and on the phone.
 */

import { ValidationError } from "../errors.ts";
import type { Cents } from "../money.ts";
import { assertCents, assertTotal } from "../money.ts";
import type { LocalDate, Month } from "../month.ts";
import { assertDate, assertMonth, compareMonths, monthOf, monthRange, shiftMonth } from "../month.ts";
import type { CardTransaction } from "./card-balance.ts";

/** Money that came into unassigned money in a month (salary, starting balance…). */
export interface Income {
  readonly month: Month;
  /**
   * The day it came in, in the workspace's time zone, inside `month`. Compared with
   * `BudgetInput.today` (rule 1); without it, the income counts as received on the first day of
   * its month.
   */
  readonly date?: LocalDate;
  readonly amount: Cents;
}

/** Money assigned to a category (or to a payment category) for a month. Negative = money taken out. */
export interface Assignment {
  readonly categoryId: string;
  readonly month: Month;
  readonly amount: Cents;
}

/**
 * Activity of a category in a month: spending is negative, refunds positive.
 * When the money moved on a credit card, `paymentCategoryId` names that card's
 * payment category; otherwise the activity was on a cash account.
 */
export interface Activity {
  readonly categoryId: string;
  readonly month: Month;
  /**
   * The day it happened, in the workspace's time zone, inside `month`. A positive amount dated after
   * `BudgetInput.today` counts nowhere until its date (rule 1, #668); without a date, it counts as
   * dated on the first day of its month. A negative amount counts whatever its date.
   */
  readonly date?: LocalDate;
  readonly amount: Cents;
  readonly paymentCategoryId?: string;
}

/** Money paid to a credit card in a month. Positive = payment; negative = cash taken from the card. */
export interface CardPayment {
  readonly paymentCategoryId: string;
  readonly month: Month;
  readonly amount: Cents;
}

/**
 * A card's real, external balance, given as its own account's transactions
 * (including any starting balance) — not derived from activity or card
 * payments. The balance at the end of each month (`owedAsOf`) gives
 * `uncovered` and `owed` for the requested month, and the card's credit for
 * every month (rule 9); never stored by this function.
 */
export interface CardBalance {
  readonly paymentCategoryId: string;
  /** Every transaction of the card's own account, in any order: what is owed at the end of a month is minus their sum up to it. */
  readonly transactions: readonly CardTransaction[];
  /**
   * Whether the card had a starting balance when its account was created (#355) — the amount
   * and date are already on the account/transaction itself, not reproduced here; a boolean is
   * enough to pick between the two specific "uncovered debt" sentences design.md describes.
   */
  readonly hasStartingBalance?: boolean;
}

/**
 * A scheduled transaction not yet recorded, reserving `amount` in its category for the month
 * being computed (design.md, "Scheduled transactions"). No `month` of its own: unlike income,
 * assignments and activity, a reservation is never walked across months — the caller passes
 * only the items that reserve against the one month `computeBudgetMonth` is asked for.
 */
export interface ScheduledItem {
  readonly categoryId: string;
  /** Always positive: the expense's own amount, not yet spent. */
  readonly amount: Cents;
}

/**
 * A transfer between two on-budget credit cards (design.md, "Credit cards"; rule 8, #732): one card
 * pays part of the other's debt. Money set aside moves from the payment category of the card that
 * was paid to the one of the card that was charged, up to what the paid card holds beyond what it
 * still owes. Unlike a `ScheduledItem`, this is a real recorded event, carrying its own `month` and
 * walked across months exactly like an `Assignment` or a `CardPayment`.
 */
export interface CardTransfer {
  /** The card whose debt was paid (the transfer's inflow leg): money set aside leaves its payment category. */
  readonly paidPaymentCategoryId: string;
  /** The card that was charged (the outflow leg): it now owes the amount, and its payment category receives what moves. */
  readonly chargedPaymentCategoryId: string;
  readonly month: Month;
  /** The transfer's day, in the workspace's time zone, inside `month`: a month's transfers apply in date order. */
  readonly date: LocalDate;
  /** A stable id (the outflow leg's transaction id): orders transfers dated the same day. */
  readonly id: string;
  /** Always positive: the amount transferred, not necessarily the amount of money set aside that moves. */
  readonly amount: Cents;
}

export interface BudgetInput {
  /** Regular categories. */
  readonly categoryIds: readonly string[];
  /** One payment category for each on-budget credit card. */
  readonly paymentCategoryIds?: readonly string[];
  readonly income: readonly Income[];
  readonly assignments: readonly Assignment[];
  readonly activity: readonly Activity[];
  readonly cardPayments?: readonly CardPayment[];
  readonly cardBalances?: readonly CardBalance[];
  /** Scheduled transactions not yet recorded, for the month being computed. */
  readonly scheduledItems?: readonly ScheduledItem[];
  /** Transfers between two cards' payment categories. */
  readonly cardTransfers?: readonly CardTransfer[];
  /**
   * Today, in the workspace's time zone (rule 1): income and positive activity dated after it have
   * not been received yet and count nowhere. Required, so that no caller silently counts every income as received.
   */
  readonly today: LocalDate;
}

export interface CategoryMonth {
  readonly categoryId: string;
  /**
   * Available balance carried over from the previous month. Never negative, except on a payment
   * category whose card was in credit at the end of the previous month (rule 9): down to minus
   * that credit.
   */
  readonly carriedOver: Cents;
  readonly assigned: Cents;
  /**
   * Regular category: its spending and refunds.
   * Payment category: money moved in from covered card spending, minus payments.
   */
  readonly activity: Cents;
  /** carriedOver + assigned + activity. Negative = overspent. */
  readonly available: Cents;
  /** Part of a negative `available` paid with credit cards (becomes card debt if left uncovered). */
  readonly creditOverspending: Cents;
  /**
   * Rest of a negative `available` (taken from unassigned money next month if left uncovered). On a
   * payment category, only the part beyond the card's credit (rule 9): `max(0, −available − credit)`.
   */
  readonly cashOverspending: Cents;
  /**
   * Money reserved by scheduled transactions not yet recorded (`BudgetInput.scheduledItems`);
   * `available` already has this subtracted. A category can go negative from this alone
   * without it counting as overspending — see rule 7 above.
   */
  readonly reserved: Cents;
  /**
   * Payment categories only: how much of the card's real balance (`BudgetInput.cardBalances`)
   * assigned money does not cover yet — `max(0, owed - max(0, available))`. A negative
   * `available` (the card was paid beyond what was set aside, or is in credit) covers nothing, so
   * it never counts here; the card's real debt is therefore `owed`, never `available + uncovered`.
   * Derived fresh every call, never persisted or carried to the next month; 0 when no
   * `cardBalances` entry is given.
   */
  readonly uncovered: Cents;
  /**
   * Payment categories only (#699): the card's real balance at the end of the month, what is owed
   * on it (`owedAsOf` over `CardBalance.transactions`; negative when the card is in credit) — the
   * debt the interface shows. Absent when no `cardBalances` entry is given for the card, and always
   * absent for an ordinary category.
   */
  readonly owed?: Cents;
  /**
   * Payment categories only (#355): which ordinary categories' credit overspending this month is
   * attributable to this specific card, and how much — `apps/web`'s own "the uncovered debt comes
   * from card spending beyond what was available" sentence names them. A category overspent
   * across more than one card attributes to each card its own spending less what was covered on
   * it (rule 4, #731), so the card named is the one whose spending is still uncovered.
   * Always present for a payment category (possibly empty), absent for an ordinary one.
   */
  readonly overspendingBy?: readonly { readonly categoryId: string; readonly amount: Cents }[];
  /**
   * Payment categories only (#355): whether the card had a starting balance when added —
   * `apps/web`'s own "the card already had €X of debt when you added it" sentence needs this to
   * pick between the two specific explanations design.md describes. Always present for a payment
   * category, absent for an ordinary one.
   */
  readonly hasStartingBalance?: boolean;
}

export interface BudgetMonth {
  readonly month: Month;
  readonly unassigned: Cents;
  /**
   * This month's money already assigned to months after this one: the part of those later
   * assignments that the later months' own income does not pay for (rule 1). Never negative.
   */
  readonly assignedInFuture: Cents;
  /** Cash overspending of the previous month, taken from unassigned money in this month. */
  readonly overspentLastMonth: Cents;
  /** Total credit overspending in this month's categories. */
  readonly creditOverspending: Cents;
  /** Total reserved by this month's categories (`CategoryMonth.reserved`, summed). */
  readonly reserved: Cents;
  readonly categories: readonly CategoryMonth[];
  readonly paymentCategories: readonly CategoryMonth[];
}

/** Key for "category + month" maps. */
function key(id: string, month: Month): string {
  return `${id}|${month}`;
}

/** Adds `amount` to the value at `mapKey`, starting from zero. Like `$h{$k} += $v` in Perl. */
function addTo(map: Map<string, Cents>, mapKey: string, amount: Cents): void {
  map.set(mapKey, (map.get(mapKey) ?? 0) + amount);
}

function validate(input: BudgetInput, month: Month): void {
  assertMonth(month);
  const regular = new Set<string>();
  const payment = new Set<string>();
  for (const [ids, set] of [
    [input.categoryIds, regular],
    [input.paymentCategoryIds ?? [], payment],
  ] as const) {
    for (const id of ids) {
      if (regular.has(id) || payment.has(id)) {
        throw new ValidationError("duplicate_category", `duplicate category: "${id}"`, { categoryId: id });
      }
      set.add(id);
    }
  }
  const unknown = (id: string): never => {
    throw new ValidationError("unknown_category", `unknown category: "${id}"`, { categoryId: id });
  };
  assertDate(input.today);
  // Every figure of a budget month is a sum of some of these amounts, so while the sum of their
  // sizes is a safe integer none of them can lose precision. Past that, the inputs themselves are
  // named as the cause ("amount_total_overflow"), never the figure that happened to overflow.
  let magnitude = 0;
  const count = (amount: Cents, label: string, details: Record<string, string | number>): void => {
    if (!Number.isInteger(amount)) {
      assertCents(amount, label);
    }
    magnitude += Math.abs(amount);
    assertTotal(magnitude, label, details);
  };
  for (const item of input.income) {
    assertMonth(item.month);
    count(item.amount, "income", { month: item.month });
    if (item.date !== undefined && monthOf(item.date) !== item.month) {
      throw new ValidationError("invalid_date", `income dated "${item.date}" is not in its month "${item.month}"`, {
        value: item.date,
      });
    }
  }
  for (const item of input.assignments) {
    assertMonth(item.month);
    count(item.amount, "assignment", { month: item.month, categoryId: item.categoryId });
    if (!regular.has(item.categoryId) && !payment.has(item.categoryId)) unknown(item.categoryId);
  }
  for (const item of input.activity) {
    assertMonth(item.month);
    count(item.amount, "activity", { month: item.month, categoryId: item.categoryId });
    if (!regular.has(item.categoryId)) unknown(item.categoryId);
    if (item.paymentCategoryId !== undefined && !payment.has(item.paymentCategoryId)) unknown(item.paymentCategoryId);
    if (item.date !== undefined && monthOf(item.date) !== item.month) {
      throw new ValidationError("invalid_date", `activity dated "${item.date}" is not in its month "${item.month}"`, {
        value: item.date,
      });
    }
  }
  for (const item of input.cardPayments ?? []) {
    assertMonth(item.month);
    count(item.amount, "card payment", { month: item.month, categoryId: item.paymentCategoryId });
    if (!payment.has(item.paymentCategoryId)) unknown(item.paymentCategoryId);
  }
  const seenBalances = new Set<string>();
  for (const item of input.cardBalances ?? []) {
    for (const transaction of item.transactions) {
      assertDate(transaction.date);
      count(transaction.amount, "card balance", { categoryId: item.paymentCategoryId });
    }
    if (!payment.has(item.paymentCategoryId)) unknown(item.paymentCategoryId);
    if (seenBalances.has(item.paymentCategoryId)) {
      throw new ValidationError(
        "duplicate_card_balance",
        `duplicate card balance: "${item.paymentCategoryId}"`,
        { paymentCategoryId: item.paymentCategoryId },
      );
    }
    seenBalances.add(item.paymentCategoryId);
  }
  for (const item of input.scheduledItems ?? []) {
    count(item.amount, "scheduled item", { categoryId: item.categoryId });
    if (item.amount <= 0) {
      throw new ValidationError("invalid_amount", "a scheduled item's amount must be positive", {
        label: "scheduled item",
        value: String(item.amount),
      });
    }
    if (!regular.has(item.categoryId)) unknown(item.categoryId);
  }
  for (const item of input.cardTransfers ?? []) {
    assertMonth(item.month);
    assertDate(item.date);
    count(item.amount, "card transfer", { month: item.month, categoryId: item.chargedPaymentCategoryId });
    if (item.amount <= 0) {
      throw new ValidationError("invalid_amount", "a card transfer's amount must be positive", {
        label: "card transfer",
        value: String(item.amount),
      });
    }
    if (monthOf(item.date) !== item.month) {
      throw new ValidationError("invalid_date", `card transfer dated "${item.date}" is not in its month "${item.month}"`, {
        value: item.date,
      });
    }
    if (!payment.has(item.paidPaymentCategoryId)) unknown(item.paidPaymentCategoryId);
    if (!payment.has(item.chargedPaymentCategoryId)) unknown(item.chargedPaymentCategoryId);
  }
}

interface MonthState {
  readonly categories: CategoryMonth[];
  readonly paymentCategories: CategoryMonth[];
}

/**
 * Computes every payment category's figures for one month, including rule 8's card-to-card
 * transfers. A first pass settles each payment category's own carried/assigned/activity before
 * any transfer; a second pass applies this month's transfers in date order, then id, each moving
 * from the paid card's payment category what it holds beyond what that card still owes.
 */
function computePaymentCategories(
  paymentIds: readonly string[],
  m: Month,
  carried: ReadonlyMap<string, Cents>,
  movedToPayment: ReadonlyMap<string, Cents>,
  data: {
    assignedBy: ReadonlyMap<string, Cents>;
    paymentsBy: ReadonlyMap<string, Cents>;
    /** Each card's signed balance at the end of `m` (rule 9); no entry when no `cardBalances` entry was given. */
    owedBy: ReadonlyMap<string, Cents>;
    cardTransfersBy: ReadonlyMap<Month, readonly CardTransfer[]>;
    hasStartingBalanceBy: ReadonlyMap<string, boolean>;
    overspendingByCard: ReadonlyMap<string, ReadonlyMap<string, Cents>>;
  },
): CategoryMonth[] {
  const pre = paymentIds.map((id) => {
    const carriedOver = carried.get(id) ?? 0;
    const assigned = data.assignedBy.get(key(id, m)) ?? 0;
    const activity = (movedToPayment.get(id) ?? 0) - (data.paymentsBy.get(key(id, m)) ?? 0);
    return { id, carriedOver, assigned, activity, available: carriedOver + assigned + activity };
  });
  const availableById = new Map(pre.map((p): [string, Cents] => [p.id, p.available]));

  // Rule 8 (#732): in date order, then id; each transfer reads the available the earlier ones left.
  const transferDelta = new Map<string, Cents>();
  const transfers = [...(data.cardTransfersBy.get(m) ?? [])].sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const t of transfers) {
    const held = availableById.get(t.paidPaymentCategoryId) ?? 0;
    // What the paid card still owes at the end of the month, signed; a card whose balance is not
    // given counts as owing nothing, so only what its payment category holds can move.
    const stillOwed = data.owedBy.get(t.paidPaymentCategoryId) ?? 0;
    const moved = Math.min(t.amount, Math.max(0, held - stillOwed));
    availableById.set(t.paidPaymentCategoryId, held - moved);
    availableById.set(t.chargedPaymentCategoryId, (availableById.get(t.chargedPaymentCategoryId) ?? 0) + moved);
    addTo(transferDelta, t.paidPaymentCategoryId, -moved);
    addTo(transferDelta, t.chargedPaymentCategoryId, moved);
  }

  return pre.map((p): CategoryMonth => {
    const delta = transferDelta.get(p.id) ?? 0;
    const activity = p.activity + delta;
    const available = p.available + delta;
    const owed = data.owedBy.get(p.id);
    // Paying more than the payment category holds spends cash that had no job: cash
    // overspending — but only beyond the card's own credit (rule 9): a negative available down to
    // minus the credit is money the card holds, not cash gone. A card-to-card transfer never
    // takes `available` below what the paid card owes (it is capped above), so it never
    // contributes to this on its own: below zero only down to the card's own credit.
    const credit = Math.max(0, -(owed ?? 0));
    return {
      categoryId: p.id,
      carriedOver: p.carriedOver,
      assigned: p.assigned,
      activity,
      available,
      creditOverspending: 0,
      cashOverspending: Math.max(0, -available - credit),
      // Payment categories never receive a scheduled item directly (rule 7: a scheduled
      // card expense reserves in its own spending category, the same as a cash one).
      reserved: 0,
      // max(0, available): a negative available (an overpayment, already cash overspending, or a
      // card in credit) covers no debt; counting it here would double the same shortfall.
      uncovered: owed === undefined ? 0 : Math.max(0, owed - Math.max(0, available)),
      ...(owed !== undefined ? { owed } : {}),
      overspendingBy: [...(data.overspendingByCard.get(p.id) ?? [])]
        .map(([categoryId, amount]) => ({ categoryId, amount }))
        .sort((a, b) => (a.categoryId < b.categoryId ? -1 : a.categoryId > b.categoryId ? 1 : 0)),
      hasStartingBalance: data.hasStartingBalanceBy.get(p.id) ?? false,
    };
  });
}

/**
 * Computes all categories for one month, starting from the balances carried
 * over from the previous month.
 */
function computeMonth(
  input: BudgetInput,
  m: Month,
  carried: ReadonlyMap<string, Cents>,
  data: {
    assignedBy: ReadonlyMap<string, Cents>;
    activityBy: ReadonlyMap<string, Cents>;
    creditBy: ReadonlyMap<string, ReadonlyMap<string, Cents>>;
    paymentsBy: ReadonlyMap<string, Cents>;
    owedBy: ReadonlyMap<string, Cents>;
    /** Only ever non-empty for the month actually requested (rule 7: reservations do not carry over). */
    reservedBy: ReadonlyMap<string, Cents>;
    cardTransfersBy: ReadonlyMap<Month, readonly CardTransfer[]>;
    hasStartingBalanceBy: ReadonlyMap<string, boolean>;
  },
): MonthState {
  const paymentIds = input.paymentCategoryIds ?? [];
  const movedToPayment = new Map<string, Cents>(paymentIds.map((id): [string, Cents] => [id, 0]));
  // #355: paymentCategoryId -> categoryId -> amount, built alongside movedToPayment below but
  // never read by it — a separate, presentational breakdown of creditOverspending by card.
  const overspendingByCard = new Map<string, Map<string, Cents>>();
  // Rule 4 (#731): what each card still needs before any category's covered spending moves in —
  // its real balance at the end of the month less what its payment category holds from carried,
  // assigned and paid. Unknown (no `cardBalances` entry): without limit, so cards keep id order.
  // What it still needs at any point is this less `movedToPayment` so far.
  const needBefore = new Map<string, Cents>(
    paymentIds.map((id): [string, Cents] => {
      const owed = data.owedBy.get(id);
      if (owed === undefined) return [id, Number.POSITIVE_INFINITY];
      const held = (carried.get(id) ?? 0) + (data.assignedBy.get(key(id, m)) ?? 0) - (data.paymentsBy.get(key(id, m)) ?? 0);
      return [id, owed - held];
    }),
  );
  const stillNeeds = (paymentId: string): Cents => Math.max(0, (needBefore.get(paymentId) ?? 0) - (movedToPayment.get(paymentId) ?? 0));

  // Net credit card activity of each category, card by card, in a stable order. Every net refund
  // goes back to its category before any coverage is shared out, so that a card's need already
  // counts the refunds of categories that come later: otherwise money assigned to the card would
  // shift an earlier category's coverage to another card, and following the "To do" list once
  // would leave the card short.
  const byCardOf = new Map<string, [string, Cents][]>();
  for (const id of input.categoryIds) {
    const byCard = [...(data.creditBy.get(key(id, m)) ?? new Map<string, Cents>())].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    byCardOf.set(id, byCard);
    for (const [paymentId, net] of byCard) {
      if (net > 0) addTo(movedToPayment, paymentId, -net); // Net refund: the money goes back to the category.
    }
  }

  const categories = input.categoryIds.map((id): CategoryMonth => {
    const carriedOver = carried.get(id) ?? 0;
    const assigned = data.assignedBy.get(key(id, m)) ?? 0;
    const activity = data.activityBy.get(key(id, m)) ?? 0;
    const available = carriedOver + assigned + activity;
    const overspent = Math.max(0, -available);

    const byCard = byCardOf.get(id) ?? [];
    let cardOutflow = 0;
    for (const [, net] of byCard) if (net < 0) cardOutflow += -net;

    // Rule 6: overspending is attributed to card spending first.
    const creditOverspending = Math.min(overspent, cardOutflow);
    const cashOverspending = overspent - creditOverspending;

    // Rule 4 (#731): the covered part of card spending moves to the payment categories, first to
    // the cards that still need money (each up to that need and its own spending), then to the
    // others (each up to the rest of its own spending), cards in id order.
    const coveredBy = new Map<string, Cents>();
    let toCover = cardOutflow - creditOverspending;
    for (const firstPass of [true, false]) {
      for (const [paymentId, net] of byCard) {
        if (net >= 0 || toCover === 0) continue;
        const room = -net - (coveredBy.get(paymentId) ?? 0);
        const covered = Math.min(room, toCover, firstPass ? stillNeeds(paymentId) : room);
        if (covered <= 0) continue;
        addTo(coveredBy, paymentId, covered);
        addTo(movedToPayment, paymentId, covered);
        toCover -= covered;
      }
    }

    // #355, #731: a card's share of the category's credit overspending is its own spending less
    // what was covered on it, so the card named is always the one whose spending is uncovered.
    for (const [paymentId, net] of byCard) {
      if (net >= 0) continue;
      const attributed = -net - (coveredBy.get(paymentId) ?? 0);
      if (attributed > 0) {
        const byCategory = overspendingByCard.get(paymentId) ?? new Map<string, Cents>();
        addTo(byCategory, id, attributed);
        overspendingByCard.set(paymentId, byCategory);
      }
    }

    // Rule 7: a reservation is subtracted from the reported available, but never counted as
    // overspending — overspent/creditOverspending/cashOverspending above already used the
    // available amount before this subtraction.
    const reserved = data.reservedBy.get(id) ?? 0;

    return {
      categoryId: id,
      carriedOver,
      assigned,
      activity,
      available: available - reserved,
      creditOverspending,
      cashOverspending,
      reserved,
      uncovered: 0,
    };
  });

  const paymentCategories = computePaymentCategories(paymentIds, m, carried, movedToPayment, { ...data, overspendingByCard });

  return { categories, paymentCategories };
}

/**
 * Whether money coming in dated `date` has been received by `today`, both days in the workspace's
 * time zone (rule 1): income, and every positive split (#668), counts from its own date on, never
 * before. The one rule the budget month and every preview of incoming money share (#650, #700).
 */
export function incomeReceived(date: LocalDate, today: LocalDate): boolean {
  return date <= today;
}

/**
 * Computes the state of the budget in the given month.
 *
 * @throws ValidationError if the data contains invalid months, amounts or categories.
 */
export function computeBudgetMonth(input: BudgetInput, month: Month): BudgetMonth {
  validate(input, month);

  // 1. Group the data by category and month.
  const assignedBy = new Map<string, Cents>();
  const activityBy = new Map<string, Cents>();
  const creditBy = new Map<string, Map<string, Cents>>();
  const paymentsBy = new Map<string, Cents>();
  for (const a of input.assignments) addTo(assignedBy, key(a.categoryId, a.month), a.amount);
  // Rule 1 (#668): money coming in dated after today counts nowhere until its date, split by split;
  // spending counts at once.
  const activity = input.activity.filter((a) => a.amount <= 0 || incomeReceived(a.date ?? `${a.month}-01`, input.today));
  for (const a of activity) {
    addTo(activityBy, key(a.categoryId, a.month), a.amount);
    if (a.paymentCategoryId !== undefined) {
      const k = key(a.categoryId, a.month);
      const cards = creditBy.get(k) ?? new Map<string, Cents>();
      addTo(cards, a.paymentCategoryId, a.amount);
      creditBy.set(k, cards);
    }
  }
  for (const p of input.cardPayments ?? []) addTo(paymentsBy, key(p.paymentCategoryId, p.month), p.amount);
  // Rule 9: each card's transactions summed by month, for its balance at the end of every month.
  const cardAmountsBy = new Map<string, Map<Month, Cents>>();
  const hasStartingBalanceBy = new Map<string, boolean>();
  for (const b of input.cardBalances ?? []) {
    const byMonth = new Map<Month, Cents>();
    for (const t of b.transactions) addTo(byMonth, monthOf(t.date), t.amount);
    cardAmountsBy.set(b.paymentCategoryId, byMonth);
    if (b.hasStartingBalance) hasStartingBalanceBy.set(b.paymentCategoryId, true);
  }
  const reservedBy = new Map<string, Cents>();
  for (const s of input.scheduledItems ?? []) addTo(reservedBy, s.categoryId, s.amount);
  const cardTransfersBy = new Map<Month, CardTransfer[]>();
  for (const t of input.cardTransfers ?? []) {
    const list = cardTransfersBy.get(t.month) ?? [];
    list.push(t);
    cardTransfersBy.set(t.month, list);
  }
  const data = {
    assignedBy,
    activityBy,
    creditBy,
    paymentsBy,
    reservedBy: new Map<string, Cents>(),
    cardTransfersBy,
    hasStartingBalanceBy,
  };

  // 2. Find the first month with data (the computation starts there) and the latest one (rule 1:
  // unassigned money is the smallest cumulative figure from the requested month up to it).
  let firstMonth = month;
  let lastMonth = month;
  for (const item of [
    ...input.income,
    ...input.assignments,
    ...input.activity,
    ...(input.cardPayments ?? []),
    ...(input.cardTransfers ?? []),
  ]) {
    if (compareMonths(item.month, firstMonth) < 0) firstMonth = item.month;
    if (compareMonths(item.month, lastMonth) > 0) lastMonth = item.month;
  }

  // Each card's balance at the end of a month (`owedAsOf`, in one pass): a running sum of its
  // transactions, started with everything dated before the first month and moved on one month at
  // a time, so `owedThrough` must be called once for each month from `firstMonth` on, in order.
  const cardRunning = new Map<string, Cents>();
  for (const [id, byMonth] of cardAmountsBy) {
    let before = 0;
    for (const [m, amount] of byMonth) if (compareMonths(m, firstMonth) < 0) before += amount;
    cardRunning.set(id, before);
  }
  const owedThrough = (m: Month): Map<string, Cents> => {
    const owedBy = new Map<string, Cents>();
    for (const [id, byMonth] of cardAmountsBy) {
      const running = (cardRunning.get(id) ?? 0) + (byMonth.get(m) ?? 0);
      cardRunning.set(id, running);
      owedBy.set(id, 0 - running); // not `-running`, which is -0 for a card with nothing on it
    }
    return owedBy;
  };

  // 3. Walk the months before the requested one, closing each of them.
  const carried = new Map<string, Cents>();
  let cashOverspentTotal = 0;
  let overspentLastMonth = 0;
  for (const m of monthRange(firstMonth, month).slice(0, -1)) {
    const state = computeMonth(input, m, carried, { ...data, owedBy: owedThrough(m) });
    let cashOverspentThisMonth = 0;
    for (const c of [...state.categories, ...state.paymentCategories]) {
      // Rule 2 and rule 6: positive balances roll over, overspending restarts at zero. Rule 9: a
      // payment category keeps the negative part its card's credit holds, that is everything
      // but its cash overspending (an ordinary category's overspending is all cash or credit).
      carried.set(c.categoryId, c.available < 0 ? c.available + c.cashOverspending + c.creditOverspending : c.available);
      cashOverspentThisMonth += c.cashOverspending;
    }
    cashOverspentTotal += cashOverspentThisMonth;
    overspentLastMonth = cashOverspentThisMonth;
  }

  // 4. The requested month, still open. Reservations (rule 7) apply only here, never to the
  // earlier months just closed above.
  const current = computeMonth(input, month, carried, { ...data, owedBy: owedThrough(month), reservedBy });

  // 5. Unassigned money (rule 1): the smallest cum(N) for N from the requested month to the
  // latest one with data, where cum(N) = income received by the end of N (and by today) −
  // everything assigned up to N − cash overspending of the months before the requested one, a
  // month after the requested one counting only its positive income (#782). A later month's own
  // unresolved overspending, and its own negative income, stay that month's concern (#489).
  const receivedBy = new Map<Month, Cents>();
  // #782: a later month counts only its positive income; its negative income counts from its own
  // month on and is never charged to an earlier one.
  const laterReceivedBy = new Map<Month, Cents>();
  for (const item of input.income) {
    if (!incomeReceived(item.date ?? `${item.month}-01`, input.today)) continue;
    addTo(receivedBy, item.month, item.amount);
    if (item.amount > 0) addTo(laterReceivedBy, item.month, item.amount);
  }
  const assignedByMonth = new Map<Month, Cents>();
  for (const a of input.assignments) addTo(assignedByMonth, a.month, a.amount);

  let cumulative = 0 - cashOverspentTotal; // not `-cashOverspentTotal`, which is -0 when there is none
  for (const [m, amount] of receivedBy) if (compareMonths(m, month) <= 0) cumulative += amount;
  for (const [m, amount] of assignedByMonth) if (compareMonths(m, month) <= 0) cumulative -= amount;
  const cumulativeInMonth = cumulative;
  let unassigned = cumulative;
  for (let m = shiftMonth(month, 1); compareMonths(m, lastMonth) <= 0; m = shiftMonth(m, 1)) {
    cumulative += (laterReceivedBy.get(m) ?? 0) - (assignedByMonth.get(m) ?? 0);
    if (cumulative < unassigned) unassigned = cumulative;
  }
  const assignedInFuture = cumulativeInMonth - unassigned;

  assertTotal(unassigned, "unassigned", { month });

  return {
    month,
    unassigned,
    assignedInFuture,
    overspentLastMonth,
    creditOverspending: current.categories.reduce((sum, c) => sum + c.creditOverspending, 0),
    reserved: current.categories.reduce((sum, c) => sum + c.reserved, 0),
    categories: current.categories,
    paymentCategories: current.paymentCategories,
  };
}
