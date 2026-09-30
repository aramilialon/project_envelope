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
  | "invalid_ofx_transaction"
  | "invalid_qif_transaction"
  | "invalid_camt053_entry"
  | "ambiguous_date_format"
  | "ambiguous_decimal_separator"
  | "unknown_transaction"
  | "direct_reconciliation_not_allowed";

export class ValidationError extends Error {
  readonly code: ValidationErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(code: ValidationErrorCode, message: string, details: Record<string, string | number> = {}) {
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
