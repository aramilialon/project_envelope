// Entry point of @envelope/core: everything the apps are allowed to use.
export type { ValidationErrorCode } from "./errors.ts";
export { isValidationError, ValidationError } from "./errors.ts";
export type { Cents, CurrencyCode, Locale } from "./money.ts";
export { assertCents, currencyDecimals, formatMoney, parseAmount, sumCents } from "./money.ts";
export type { LocalDate, Month, RecurUnit } from "./month.ts";
export { advanceDate, assertDate, assertMonth, compareMonths, daysBetween, monthOf, monthRange, nextMonth, previousMonth } from "./month.ts";
export type {
  Activity,
  Assignment,
  BudgetInput,
  BudgetMonth,
  CardBalance,
  CardPayment,
  CardTransfer,
  CategoryMonth,
  Income,
  ScheduledItem,
} from "./budget/budget-month.ts";
export { computeBudgetMonth } from "./budget/budget-month.ts";
export type { AggregatedTransactions, BudgetAccount, BudgetTransaction, Split } from "./budget/transactions.ts";
export { aggregateTransactions, UNASSIGNED } from "./budget/transactions.ts";
export type {
  BalanceTarget,
  ByDateTarget,
  CategoryTargetState,
  MonthlyTarget,
  RepeatingTarget,
  RepeatInterval,
  Target,
  TargetProgress,
} from "./budget/targets.ts";
export { computeTarget } from "./budget/targets.ts";
export type { BufferAccount, CashMovement } from "./budget/days-of-buffer.ts";
export { computeDaysOfBuffer } from "./budget/days-of-buffer.ts";
export type { DuplicateMatch, ExistingTransaction, ImportedTransaction } from "./import/duplicate-detection.ts";
export { detectDuplicates } from "./import/duplicate-detection.ts";
export type { ImportRow } from "./import/row.ts";
export type { CsvDateFormat, CsvMapping, CsvRow, DecimalSeparator } from "./import/csv.ts";
export { parseCsv } from "./import/csv.ts";
export { parseOfx } from "./import/ofx.ts";
export type { QifDateFormat, QifDecimalSeparator, QifHints } from "./import/qif.ts";
export { parseQif } from "./import/qif.ts";
export { parseCamt053 } from "./import/camt053.ts";
export type { Hlc } from "./sync/hlc.ts";
export { compareHlc, nextHlc } from "./sync/hlc.ts";
export type { Bar, BarSegment, CategoryBar, PaymentCategoryBar, TailKind } from "./presentation/bars.ts";
export { computeCategoryBar, computePaymentCategoryBar, TAIL_PERCENT, TRACK_PERCENT } from "./presentation/bars.ts";
export type {
  TimelineDayTick,
  TimelineDirection,
  TimelineEvent,
  TimelineEventStatus,
  TimelineInput,
  TimelineLabel,
  TimelineLayout,
  TimelineMark,
} from "./presentation/timeline.ts";
export { computeTimeline, MAX_LABEL_PAYEES } from "./presentation/timeline.ts";
export type { CategoryTargetNeed, OverdueScheduledItem, TodoItem, TodosInput } from "./presentation/todos.ts";
export { amountNeededToCover, computeTodos, reservationShortfall } from "./presentation/todos.ts";
