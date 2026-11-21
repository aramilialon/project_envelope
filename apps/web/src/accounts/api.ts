/** The accounts endpoints (#51): list, create and close an account in a workspace. */
import type { TaxRegime } from "@envelope/core";

import { apiFetch, authHeaders } from "../apiFetch.ts";

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
    const { error } = (await response.json()) as { error?: unknown };
    if (typeof error === "string" && ACCOUNT_TAX_ERROR_CODES.includes(error)) {
      throw new AccountTaxError(error as AccountTaxErrorCode);
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

/**
 * Whether a brokerage account holds any security right now (#652): one of its positions
 * (`GET .../accounts/:accountId/positions`, #79) has a quantity other than zero. A position sold
 * out keeps its row, with a quantity of zero, so the list alone is not enough.
 */
export async function holdsSecurities(accessToken: string, workspaceId: string, accountId: string): Promise<boolean> {
  const response = await apiFetch(accessToken, "GET", `/workspaces/${workspaceId}/accounts/${accountId}/positions`);
  const body = (await response.json()) as { positions: readonly { readonly quantityE8: number }[] };
  return body.positions.some((position) => position.quantityE8 !== 0);
}
