/** The accounts endpoints (#51): list, create and close an account in a workspace. */
import type { TaxRegime } from "@envelope/core";

import { ApiError, apiFetch, authHeaders } from "../apiFetch.ts";

const API_URL: string = import.meta.env.VITE_API_URL;

export type AccountType = "checking" | "savings" | "cash" | "credit_card" | "brokerage";

export interface Account {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly onBudget: boolean;
  readonly paymentCategoryId: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
}

export interface CreateAccountInput {
  readonly name: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly onBudget: boolean;
  /** Only meaningful for an on-budget credit card (`apps/api`'s own `createAccount` ignores it otherwise). */
  readonly startingBalanceCents?: number;
  /** Brokerage accounts only (#508); required, with `domesticWithholdingAgent`, in an "IT" workspace. */
  readonly taxRegime?: TaxRegime;
  readonly domesticWithholdingAgent?: boolean;
}

export async function listAccounts(accessToken: string, workspaceId: string): Promise<Account[]> {
  const response = await apiFetch(accessToken, "GET", `/workspaces/${workspaceId}/accounts`);
  const body = (await response.json()) as { accounts: Account[] };
  return body.accounts;
}

/** Why the API refused a brokerage account's tax settings (#508): `@envelope/core`'s stable codes. */
export type AccountTaxErrorCode = "tax_regime_required" | "tax_regime_not_applicable" | "tax_regime_requires_withholding_agent";

const ACCOUNT_TAX_ERROR_CODES: readonly string[] = [
  "tax_regime_required",
  "tax_regime_not_applicable",
  "tax_regime_requires_withholding_agent",
];

/** A 400 from creating an account, for one of the tax-settings codes the form can name. */
export class AccountTaxError extends Error {
  readonly code: AccountTaxErrorCode;

  constructor(code: AccountTaxErrorCode) {
    super(`account tax settings refused: ${code}`);
    this.code = code;
  }
}

/**
 * Creates an account. A 400 carrying one of the tax-settings codes becomes an `AccountTaxError`,
 * `amount_too_large` (a starting balance above the cap, #651) an `ApiError` with its code,
 * every other failure the same generic error `apiFetch` throws — so this uses a plain `fetch`,
 * since `apiFetch` throws before the body's own `code` could be read.
 */
export async function createAccount(
  accessToken: string,
  workspaceId: string,
  input: CreateAccountInput,
): Promise<Account> {
  const path = `/workspaces/${workspaceId}/accounts`;
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(input),
  });
  if (response.status === 400) {
    const { error, details } = (await response.json()) as { error?: unknown; details?: unknown };
    if (typeof error === "string" && ACCOUNT_TAX_ERROR_CODES.includes(error)) {
      throw new AccountTaxError(error as AccountTaxErrorCode);
    }
    if (error === "amount_too_large") {
      // A starting balance above the cap (#651): kept as the API's own code, for the form's message.
      const fields = typeof details === "object" && details !== null ? (details as Record<string, string | number>) : {};
      throw new ApiError(`POST ${path} failed: 400`, 400, error, fields);
    }
  }
  if (!response.ok) {
    throw new Error(`POST ${path} failed: ${response.status}`);
  }
  return (await response.json()) as Account;
}

export async function closeAccount(accessToken: string, workspaceId: string, accountId: string): Promise<Account> {
  const response = await apiFetch(accessToken, "PATCH", `/workspaces/${workspaceId}/accounts/${accountId}/close`);
  return (await response.json()) as Account;
}
