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
 * 1. Only money that has already come in can be assigned: income dated in
 *    future months does not count.
 * 2. A category's positive available balance rolls over to the next month.
 * 3. Money assigned to future months is already assigned: it reduces
 *    unassigned money immediately.
 * 4. Spending on a credit card, as far as the category covers it, moves the
 *    same amount from the category to the card's payment category: the money
 *    is set aside to pay the card. A refund on the card moves it back.
 * 5. A card payment (a transfer from a cash account to the card) is spending
 *    of the payment category.
 * 6. A category still negative at the end of a month starts the next month at
 *    zero. The overspending is split in two:
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
 * 8. A transfer between two cards' payment categories (design.md, "Credit
 *    cards") moves money from the source into the destination, up to what the
 *    source actually holds — never pushing it negative. A part the source
 *    cannot cover is never cash overspending (nothing real moved): it only
 *    ever shows up as the source's own uncovered debt (`CardBalance`).
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
import { assertCents } from "../money.ts";
import type { Month } from "../month.ts";
import { assertMonth, compareMonths, monthRange } from "../month.ts";

/** Money that came into unassigned money in a month (salary, starting balance…). */
export interface Income {
  readonly month: Month;
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
 * A card's real, external balance (from its own account's transactions,
 * including any starting balance) as of the requested month — not derived
 * from activity or card payments. Used only to compute `uncovered`; never
 * stored or carried across months by this function.
 */
export interface CardBalance {
  readonly paymentCategoryId: string;
  /** Positive: amount currently owed on the card. */
  readonly owed: Cents;
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
 * A transfer between two on-budget credit cards' own payment categories (design.md, "Credit
 * cards"): moves up to `amount`, capped at what the source payment category actually holds, into
 * the destination's. Unlike a `ScheduledItem`, this is a real recorded event, carrying its own
 * `month` and walked across months exactly like an `Assignment` or a `CardPayment`.
 */
export interface CardTransfer {
  readonly sourcePaymentCategoryId: string;
  readonly destinationPaymentCategoryId: string;
  readonly month: Month;
  /** Always positive: the amount requested, not necessarily the amount that actually moves. */
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
}

export interface CategoryMonth {
  readonly categoryId: string;
  /** Available balance carried over from the previous month (never negative). */
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
  /** Rest of a negative `available` (taken from unassigned money next month if left uncovered). */
  readonly cashOverspending: Cents;
  /**
   * Money reserved by scheduled transactions not yet recorded (`BudgetInput.scheduledItems`);
   * `available` already has this subtracted. A category can go negative from this alone
   * without it counting as overspending — see rule 7 above.
   */
  readonly reserved: Cents;
  /**
   * Payment categories only: how much of the card's real balance (`BudgetInput.cardBalances`)
   * assigned money does not cover yet — `max(0, owed - available)`. Derived fresh every call,
   * never persisted or carried to the next month; 0 when no `cardBalances` entry is given.
   */
  readonly uncovered: Cents;
  /**
   * Payment categories only (#355): which ordinary categories' credit overspending this month is
   * attributable to this specific card, and how much — `apps/web`'s own "the uncovered debt comes
   * from card spending beyond what was available" sentence names them. A category overspent
   * across more than one card attributes to each in the same stable order `movedToPayment`
   * already uses internally, each card absorbing up to its own outflow before the next one's own
   * contributes — a presentational breakdown only, independent of `movedToPayment`/`uncovered`.
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
  /** Money already assigned to months after this one. */
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
  for (const item of input.income) {
    assertMonth(item.month);
    assertCents(item.amount, "income");
  }
  for (const item of input.assignments) {
    assertMonth(item.month);
    assertCents(item.amount);
    if (!regular.has(item.categoryId) && !payment.has(item.categoryId)) unknown(item.categoryId);
  }
  for (const item of input.activity) {
    assertMonth(item.month);
    assertCents(item.amount);
    if (!regular.has(item.categoryId)) unknown(item.categoryId);
    if (item.paymentCategoryId !== undefined && !payment.has(item.paymentCategoryId)) unknown(item.paymentCategoryId);
  }
  for (const item of input.cardPayments ?? []) {
    assertMonth(item.month);
    assertCents(item.amount, "card payment");
    if (!payment.has(item.paymentCategoryId)) unknown(item.paymentCategoryId);
  }
  const seenBalances = new Set<string>();
  for (const item of input.cardBalances ?? []) {
    assertCents(item.owed, "card balance");
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
    assertCents(item.amount, "scheduled item");
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
    assertCents(item.amount, "card transfer");
    if (item.amount <= 0) {
      throw new ValidationError("invalid_amount", "a card transfer's amount must be positive", {
        label: "card transfer",
        value: String(item.amount),
      });
    }
    if (!payment.has(item.sourcePaymentCategoryId)) unknown(item.sourcePaymentCategoryId);
    if (!payment.has(item.destinationPaymentCategoryId)) unknown(item.destinationPaymentCategoryId);
  }
}

interface MonthState {
  readonly categories: CategoryMonth[];
  readonly paymentCategories: CategoryMonth[];
}

/**
 * Computes every payment category's figures for one month, including rule 8's card-to-card
 * transfers. A first pass settles each payment category's own carried/assigned/activity before
 * any transfer; a second pass applies this month's transfers in a stable order (source, then
 * destination), capping each one at the source's own remaining available so a source funding
 * several transfers in the same month runs out deterministically.
 */
function computePaymentCategories(
  paymentIds: readonly string[],
  m: Month,
  carried: ReadonlyMap<string, Cents>,
  movedToPayment: ReadonlyMap<string, Cents>,
  data: {
    assignedBy: ReadonlyMap<string, Cents>;
    paymentsBy: ReadonlyMap<string, Cents>;
    cardBalanceBy: ReadonlyMap<string, Cents>;
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

  const transferDelta = new Map<string, Cents>();
  const transfers = [...(data.cardTransfersBy.get(m) ?? [])].sort((a, b) => {
    if (a.sourcePaymentCategoryId !== b.sourcePaymentCategoryId) {
      return a.sourcePaymentCategoryId < b.sourcePaymentCategoryId ? -1 : 1;
    }
    return a.destinationPaymentCategoryId < b.destinationPaymentCategoryId ? -1 : 1;
  });
  for (const t of transfers) {
    const remaining = availableById.get(t.sourcePaymentCategoryId) ?? 0;
    const moved = Math.max(0, Math.min(t.amount, remaining));
    availableById.set(t.sourcePaymentCategoryId, remaining - moved);
    addTo(transferDelta, t.sourcePaymentCategoryId, -moved);
    addTo(transferDelta, t.destinationPaymentCategoryId, moved);
  }

  return pre.map((p): CategoryMonth => {
    const delta = transferDelta.get(p.id) ?? 0;
    const activity = p.activity + delta;
    const available = p.available + delta;
    const owed = data.cardBalanceBy.get(p.id);
    // Paying more than the payment category holds spends cash that had no job: cash
    // overspending. A card-to-card transfer never pushes `available` below zero (it is
    // already capped above), so it never contributes to this on its own.
    return {
      categoryId: p.id,
      carriedOver: p.carriedOver,
      assigned: p.assigned,
      activity,
      available,
      creditOverspending: 0,
      cashOverspending: Math.max(0, -available),
      // Payment categories never receive a scheduled item directly (rule 7: a scheduled
      // card expense reserves in its own spending category, the same as a cash one).
      reserved: 0,
      // max(0, available): an overpayment already reduces available and next month's
      // unassigned (cashOverspending); counting its negative available again here
      // would double the same shortfall into both mechanisms.
      uncovered: owed === undefined ? 0 : Math.max(0, owed - Math.max(0, available)),
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
    cardBalanceBy: ReadonlyMap<string, Cents>;
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

  const categories = input.categoryIds.map((id): CategoryMonth => {
    const carriedOver = carried.get(id) ?? 0;
    const assigned = data.assignedBy.get(key(id, m)) ?? 0;
    const activity = data.activityBy.get(key(id, m)) ?? 0;
    const available = carriedOver + assigned + activity;
    const overspent = Math.max(0, -available);

    // Net credit card activity of this category, card by card, in a stable order.
    const byCard = [...(data.creditBy.get(key(id, m)) ?? new Map<string, Cents>())].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    let cardOutflow = 0;
    for (const [paymentId, net] of byCard) {
      if (net > 0) addTo(movedToPayment, paymentId, -net); // Net refund: the money goes back to the category.
      else cardOutflow += -net;
    }

    // Rule 6: overspending is attributed to card spending first.
    const creditOverspending = Math.min(overspent, cardOutflow);
    const cashOverspending = overspent - creditOverspending;

    // #355: attribute creditOverspending to the specific card(s) it came from, in the same
    // stable order, each card absorbing up to its own outflow before the next one's own
    // contributes. Independent of the `movedToPayment` allocation below.
    let remainingOverspending = creditOverspending;
    for (const [paymentId, net] of byCard) {
      if (net >= 0 || remainingOverspending === 0) continue;
      const attributed = Math.min(-net, remainingOverspending);
      remainingOverspending -= attributed;
      if (attributed > 0) {
        const byCategory = overspendingByCard.get(paymentId) ?? new Map<string, Cents>();
        addTo(byCategory, id, attributed);
        overspendingByCard.set(paymentId, byCategory);
      }
    }

    // Rule 4: the covered part of card spending moves to the payment categories.
    let toCover = cardOutflow - creditOverspending;
    for (const [paymentId, net] of byCard) {
      if (net >= 0 || toCover === 0) continue;
      const covered = Math.min(-net, toCover);
      addTo(movedToPayment, paymentId, covered);
      toCover -= covered;
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
  for (const a of input.activity) {
    addTo(activityBy, key(a.categoryId, a.month), a.amount);
    if (a.paymentCategoryId !== undefined) {
      const k = key(a.categoryId, a.month);
      const cards = creditBy.get(k) ?? new Map<string, Cents>();
      addTo(cards, a.paymentCategoryId, a.amount);
      creditBy.set(k, cards);
    }
  }
  for (const p of input.cardPayments ?? []) addTo(paymentsBy, key(p.paymentCategoryId, p.month), p.amount);
  const cardBalanceBy = new Map<string, Cents>();
  const hasStartingBalanceBy = new Map<string, boolean>();
  for (const b of input.cardBalances ?? []) {
    cardBalanceBy.set(b.paymentCategoryId, b.owed);
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
    cardBalanceBy,
    reservedBy: new Map<string, Cents>(),
    cardTransfersBy,
    hasStartingBalanceBy,
  };

  // 2. Find the first month with data: the computation starts there.
  let firstMonth = month;
  for (const item of [
    ...input.income,
    ...input.assignments,
    ...input.activity,
    ...(input.cardPayments ?? []),
    ...(input.cardTransfers ?? []),
  ]) {
    if (compareMonths(item.month, firstMonth) < 0) firstMonth = item.month;
  }

  // 3. Walk the months before the requested one, closing each of them.
  const carried = new Map<string, Cents>();
  let cashOverspentTotal = 0;
  let overspentLastMonth = 0;
  for (const m of monthRange(firstMonth, month).slice(0, -1)) {
    const state = computeMonth(input, m, carried, data);
    let cashOverspentThisMonth = 0;
    for (const c of [...state.categories, ...state.paymentCategories]) {
      // Rule 2 and rule 6: positive balances roll over, negative ones restart at zero.
      carried.set(c.categoryId, Math.max(0, c.available));
      cashOverspentThisMonth += c.cashOverspending;
    }
    cashOverspentTotal += cashOverspentThisMonth;
    overspentLastMonth = cashOverspentThisMonth;
  }

  // 4. The requested month, still open. Reservations (rule 7) apply only here, never to the
  // earlier months just closed above.
  const current = computeMonth(input, month, carried, { ...data, reservedBy });

  // 5. Unassigned = income so far − everything assigned (future too) − past cash overspending.
  let incomeSoFar = 0;
  for (const item of input.income) {
    if (compareMonths(item.month, month) <= 0) incomeSoFar += item.amount;
  }
  let assignedTotal = 0;
  let assignedInFuture = 0;
  for (const a of input.assignments) {
    assignedTotal += a.amount;
    if (compareMonths(a.month, month) > 0) assignedInFuture += a.amount;
  }

  const unassigned = incomeSoFar - assignedTotal - cashOverspentTotal;
  assertCents(unassigned, "unassigned");

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
