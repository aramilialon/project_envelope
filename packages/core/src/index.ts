// Entry point of @envelope/core: everything the apps are allowed to use.
export type { ValidationErrorCode, ValidationErrorDetail } from "./errors.ts";
export { isValidationError, ValidationError } from "./errors.ts";
export { isAssignedCountryCode, ISO_3166_1_ALPHA2_CODES } from "./country.ts";
export type { Cents, CurrencyCode, Locale } from "./money.ts";
export {
  assertAmount,
  assertCents,
  assertKnownCurrency,
  assertTotal,
  currencyDecimals,
  formatMoney,
  isKnownCurrency,
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
  PositionOptions,
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
  positionsAsOfDates,
  summarizeByAccount,
  summarizeByPortfolio,
  validatePositionHistory,
  valuePosition,
} from "./portfolio/positions.ts";
export type { PriceCandidate, PriceOrigin, ResolvedPrice } from "./portfolio/prices.ts";
export { priceSeriesAt, resolvePrice } from "./portfolio/prices.ts";
export type { PriceCsvRow, PriceFileProblem } from "./portfolio/price-csv.ts";
export { assertLocale, assertPriceDate, MAX_LOCALE_LENGTH, MAX_PRICE_CSV_ROWS, parsePriceCsv } from "./portfolio/price-csv.ts";
export type { AccountRegime, RegimeChange, RegimeCheckedTrade, TradeFigures, TradeRegimeContext } from "./portfolio/trades.ts";
export {
  checkAccountTradesAgainstRegime,
  checkRegimeChange,
  checkTradeEntry,
  checkTradeFigures,
  checkTradeRegime,
  tradeCashCents,
} from "./portfolio/trades.ts";
export type {
  ExternalFlow,
  MoneyWeightedInput,
  RateOutcome,
  ReturnOutcome,
  TimeWeightedInput,
  UnknownReturnReason,
  Valuation,
} from "./portfolio/returns.ts";
export { moneyWeightedRate, moneyWeightedReturn, timeWeightedRate, timeWeightedReturn, yearFraction } from "./portfolio/returns.ts";
export type { ExternalFlowKind, PriceLookup, TradeFlow } from "./portfolio/external-flows.ts";
export { externalFlows } from "./portfolio/external-flows.ts";
export type {
  MissingInput,
  MissingReason,
  MonthlyPerformanceInput,
  MonthPerformance,
  PerformanceTotals,
  PortfolioPerformance,
} from "./portfolio/performance.ts";
export { assertPerformanceRange, lastDayOfMonth, MAX_PERFORMANCE_MONTHS, monthlyPerformance } from "./portfolio/performance.ts";
export type { AmountInCurrency, Conversion, FxRate, FxRateTable, RateOnDate } from "./market-data/fx.ts";
export { convertAmount, convertSum, FX_BASE_CURRENCY, FX_RATE_DECIMALS, fxRateTable, rateOn, valueIn } from "./market-data/fx.ts";
export type { EcbRatesFileProblem, EcbReferenceRates } from "./market-data/ecb.ts";
export { ECB_RATES_FILE_MAX_CHARS, parseEcbReferenceRates } from "./market-data/ecb.ts";
export { assertTextLength, MAX_FREE_TEXT_LENGTH, MAX_NAME_LENGTH, textLength } from "./text.ts";
export type { LocalDate, Month, RecurUnit } from "./month.ts";
export { advanceDate, assertDate, assertMonth, compareMonths, daysBetween, monthOf, monthRange, shiftMonth, startOfLocalDay } from "./month.ts";
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
export { computeBudgetMonth, incomeReceived } from "./budget/budget-month.ts";
export type { CardTransaction } from "./budget/card-balance.ts";
export { owedAsOf } from "./budget/card-balance.ts";
export type { TimelineLeg } from "./budget/timeline-legs.ts";
export { countsOnWorkspaceTimeline, isStartingBalanceSplit } from "./budget/timeline-legs.ts";
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
export type { ImportOptions, ImportRow } from "./import/row.ts";
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
export type { CardDebt } from "./presentation/cardDebt.ts";
export { cardDebt } from "./presentation/cardDebt.ts";
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
export type { CardPartAsked, CategoryTargetNeed, OverdueScheduledItem, TodoItem, TodosInput } from "./presentation/todos.ts";
export { amountNeededToCover, cardAmountAsked, cardPartsAskedOnCategories, computeTodos, reservationShortfall } from "./presentation/todos.ts";
export type { AccountBalance, BalanceRow, NotYetRecordedAmount } from "./presentation/accountBalance.ts";
export { computeAccountBalance, isAfterToday } from "./presentation/accountBalance.ts";
export type { AvailableChange, InflowTiming, TransferCategoryRule, TransferEnd } from "./presentation/transferCategory.ts";
export { availableAfterInflow, transferCategoryRule } from "./presentation/transferCategory.ts";
export type { AssignedEntry, AssignedEntryErrorCode } from "./presentation/assignedEntry.ts";
export { parseAssignedEntry } from "./presentation/assignedEntry.ts";
export type { BudgetProblem, BudgetProblemCategory, BudgetProblemInput, BudgetProblemKind } from "./presentation/budgetProblems.ts";
export { computeBudgetProblems } from "./presentation/budgetProblems.ts";
export type { AccountsPanelGroups, ExcludedAmount, PanelAccount } from "./presentation/accountsPanel.ts";
export { groupAccountsForPanel } from "./presentation/accountsPanel.ts";
export type {
  InstrumentInput,
  InstrumentSearch,
  InstrumentTextField,
  InstrumentType,
  NormalizedInstrument,
  PrivateInstrumentInput,
} from "./portfolio/instrument.ts";
export {
  assertIsin,
  INSTRUMENT_FIELD_MAX_LENGTH,
  INSTRUMENT_SEARCH_MIN_PREFIX,
  INSTRUMENT_TYPES,
  isInstrumentType,
  isinCheckDigit,
  isValidIsin,
  normalizeInstrument,
  normalizePrivateInstrument,
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
