// Entry point of @envelope/core: everything the apps are allowed to use.
export type { ValidationErrorCode } from "./errors.ts";
export { isValidationError, ValidationError } from "./errors.ts";
export type { Cents, CurrencyCode, Locale } from "./money.ts";
export {
  assertAmount,
  assertCents,
  assertTotal,
  currencyDecimals,
  formatMoney,
  MAX_AMOUNT_CENTS,
  parseAmount,
  parseBalance,
  sumCents,
} from "./money.ts";
export type { Price, PriceFactor, Quantity } from "./portfolio/quantity.ts";
export {
  amountOf,
  assertPrice,
  assertPriceFactor,
  assertQuantity,
  formatPrice,
  formatQuantity,
  ONE_UNIT,
  parsePrice,
  parseQuantity,
  PRICE_DECIMALS,
  PRICE_FACTOR_DECIMALS,
  PRICE_FACTOR_HUNDREDTH,
  PRICE_FACTOR_ONE,
  priceFrom,
  proportionalCost,
  QUANTITY_DECIMALS,
  quantityFor,
  toPrice,
  toPriceFactor,
  toQuantity,
} from "./portfolio/quantity.ts";
export type {
  AccountCharge,
  AccountPosition,
  AccountSummary,
  DerivedResults,
  PortfolioPosition,
  PortfolioSummary,
  Positions,
  PositionSummary,
  PositionTotals,
  PositionTrade,
  TaxKind,
  TradeChange,
  TradeType,
} from "./portfolio/positions.ts";
export {
  applyTradeChanges,
  computePositions,
  derivedResults,
  summarizeByAccount,
  summarizeByPortfolio,
  validatePositionHistory,
  valuePosition,
} from "./portfolio/positions.ts";
export type { AccountRegime, RegimeChange, RegimeCheckedTrade, TradeRegimeContext } from "./portfolio/trades.ts";
export { checkAccountTradesAgainstRegime, checkRegimeChange, checkTradeEntry, checkTradeRegime, tradeCashCents } from "./portfolio/trades.ts";
export { assertTextLength, MAX_FREE_TEXT_LENGTH, MAX_NAME_LENGTH, textLength } from "./text.ts";
export type { LocalDate, Month, RecurUnit } from "./month.ts";
export { advanceDate, assertDate, assertMonth, compareMonths, daysBetween, monthOf, monthRange, shiftMonth } from "./month.ts";
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
export { parseCsv, splitCsvLine } from "./import/csv.ts";
export { parseOfx } from "./import/ofx.ts";
export type { QifDateFormat, QifDecimalSeparator, QifHints } from "./import/qif.ts";
export { parseQif } from "./import/qif.ts";
export { parseCamt053 } from "./import/camt053.ts";
export type { Hlc } from "./sync/hlc.ts";
export { compareHlc, nextHlc } from "./sync/hlc.ts";
export type { Bar, BarSegment, CategoryBar, PaymentCategoryBar, TailKind } from "./presentation/bars.ts";
export { computeCategoryBar, computePaymentCategoryBar, TAIL_PERCENT, TRACK_PERCENT } from "./presentation/bars.ts";
export type {
  TimelineCurrent,
  TimelineDayTick,
  TimelineDirection,
  TimelineEvent,
  TimelineEventStatus,
  TimelineInput,
  TimelineLayout,
  TimelinePoint,
  TimelineSegment,
  TimelineStepDirection,
  TimelineValueTick,
} from "./presentation/timeline.ts";
export { computeTimeline } from "./presentation/timeline.ts";
export type { CategoryTargetNeed, OverdueScheduledItem, TodoItem, TodosInput } from "./presentation/todos.ts";
export { amountNeededToCover, computeTodos, reservationShortfall } from "./presentation/todos.ts";
export { computeProjectedBalance } from "./presentation/projectedBalance.ts";
export type { AvailableChange, TransferCategoryRule, TransferEnd } from "./presentation/transferCategory.ts";
export { availableAfterInflow, transferCategoryRule } from "./presentation/transferCategory.ts";
export type { BudgetProblem, BudgetProblemCategory, BudgetProblemInput, BudgetProblemKind } from "./presentation/budgetProblems.ts";
export { computeBudgetProblems } from "./presentation/budgetProblems.ts";
export type { AccountsPanelGroups, PanelAccount } from "./presentation/accountsPanel.ts";
export { groupAccountsForPanel } from "./presentation/accountsPanel.ts";
export type { InstrumentInput, InstrumentSearch, InstrumentTextField, InstrumentType, NormalizedInstrument } from "./portfolio/instrument.ts";
export {
  assertIsin,
  INSTRUMENT_FIELD_MAX_LENGTH,
  INSTRUMENT_SEARCH_MIN_PREFIX,
  INSTRUMENT_TYPES,
  isInstrumentType,
  isinCheckDigit,
  isValidIsin,
  normalizeInstrument,
  parseInstrumentSearch,
} from "./portfolio/instrument.ts";
export type {
  AccountTaxSettings,
  TaxRegime,
  TaxRegimeChange,
  TaxRegimeEntry,
  WithholdingAgentChange,
} from "./portfolio/tax-regime.ts";
export {
  assertWithholdingAgentFor,
  isTaxRegime,
  regimeAt,
  TAX_REGIME_COUNTRY,
  TAX_REGIMES,
  validateAccountTaxSettings,
  validateTaxRegimeChange,
  validateTaxRegimeHistory,
  validateWithholdingAgentChange,
} from "./portfolio/tax-regime.ts";
