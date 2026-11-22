/**
 * Errors raised by the core.
 *
 * The core never produces sentences meant for end users: those depend on the
 * user's language. Every error carries a stable machine-readable `code` plus
 * the values involved (`details`). The UI turns the code into a translated
 * message; `message` is an English description for developers and logs.
 */

export type ValidationErrorCode =
  | "invalid_amount"
  | "invalid_amount_format"
  | "amount_too_large"
  | "amount_total_overflow"
  | "invalid_goal_amount"
  | "invalid_month"
  | "invalid_date"
  | "duplicate_category"
  | "unknown_category"
  | "duplicate_account"
  | "unknown_account"
  | "missing_payment_category"
  | "duplicate_card_balance"
  | "uncategorized_transaction"
  | "split_mismatch"
  | "unsupported_transaction"
  | "card_income_not_supported"
  | "invalid_ofx_transaction"
  | "invalid_qif_transaction"
  | "invalid_camt053_entry"
  | "ambiguous_date_format"
  | "ambiguous_decimal_separator"
  | "unknown_transaction"
  | "direct_reconciliation_not_allowed"
  | "invalid_recurrence"
  | "invalid_currency"
  | "invalid_fx_rate"
  | "invalid_rates_file"
  | "invalid_time_zone"
  | "brokerage_on_budget"
  | "account_currency_not_base"
  | "invalid_quantity"
  | "invalid_quantity_format"
  | "invalid_quantity_step"
  | "invalid_price"
  | "invalid_price_format"
  | "invalid_price_factor"
  | "invalid_sale_quantity"
  | "invalid_trade"
  | "unknown_trade"
  | "insufficient_quantity"
  | "split_missing_for_portfolio"
  | "split_leaves_no_quantity"
  | "split_duplicate"
  | "split_ratio_mismatch"
  | "negative_amount_not_allowed"
  | "tax_kind_not_allowed_for_trade_type"
  | "accrued_interest_not_allowed"
  | "withholding_exceeds_gross"
  | "tax_kind_not_allowed_in_regime"
  | "domestic_withholding_requires_agent"
  | "account_not_brokerage"
  | "currency_mismatch"
  | "unknown_portfolio"
  | "portfolio_archived"
  | "unknown_instrument"
  | "split_without_holdings"
  | "invalid_isin"
  | "invalid_instrument_type"
  | "invalid_instrument_field"
  | "missing_instrument_identifier"
  | "missing_exchange"
  | "invalid_ticker"
  | "invalid_exchange"
  | "search_query_too_short"
  | "text_too_long"
  | "invalid_tax_country"
  | "tax_regime_required"
  | "tax_regime_not_applicable"
  | "tax_regime_change_not_year_start"
  | "tax_regime_duplicate_date"
  | "tax_regime_requires_withholding_agent"
  | "tax_regime_conflicts_with_trade"
  | "withholding_agent_already_set"
  | "duplicate_price"
  | "invalid_price_file"
  | "too_many_rows"
  | "invalid_locale"
  | "invalid_body"
  | "unknown_field"
  | "invalid_field"
  | "amount_needs_splits";

/**
 * A value in a `ValidationError`'s details. `null` stands for something the
 * error names but that has no value yet: the API's `tradeId` of a trade the
 * request itself is recording (#662).
 */
export type ValidationErrorDetail = string | number | null;

export class ValidationError extends Error {
  readonly code: ValidationErrorCode;
  readonly details: Readonly<Record<string, ValidationErrorDetail>>;

  constructor(code: ValidationErrorCode, message: string, details: Record<string, ValidationErrorDetail> = {}) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
    this.details = details;
  }
}

/** True if `error` is a ValidationError with the given code. Handy in tests and UI code. */
export function isValidationError(error: unknown, code?: ValidationErrorCode): error is ValidationError {
  return error instanceof ValidationError && (code === undefined || error.code === code);
}
