/** The accounts endpoints (#51): list, create and close an account in a workspace. */
import { apiFetch } from "../apiFetch.ts";

export type AccountType = "checking" | "savings" | "cash" | "credit_card";

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
}

export async function listAccounts(accessToken: string, workspaceId: string): Promise<Account[]> {
  const response = await apiFetch(accessToken, "GET", `/workspaces/${workspaceId}/accounts`);
  const body = (await response.json()) as { accounts: Account[] };
  return body.accounts;
}

export async function createAccount(
  accessToken: string,
  workspaceId: string,
  input: CreateAccountInput,
): Promise<Account> {
  const response = await apiFetch(accessToken, "POST", `/workspaces/${workspaceId}/accounts`, input);
  return (await response.json()) as Account;
}

export async function closeAccount(accessToken: string, workspaceId: string, accountId: string): Promise<Account> {
  const response = await apiFetch(accessToken, "PATCH", `/workspaces/${workspaceId}/accounts/${accountId}/close`);
  return (await response.json()) as Account;
}
