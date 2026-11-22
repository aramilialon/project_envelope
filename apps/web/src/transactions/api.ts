/** The transactions and transfers endpoints (#54): `apps/api/src/transactions/repository.ts`'s own shapes, mirrored. */
import { apiFetch } from "../apiFetch.ts";

export type TransactionStatus = "pending" | "cleared" | "reconciled";

/** `categoryId: null` means income (or, read back, "ready to assign") — the only meaning `null` gets on a non-transfer transaction. */
export interface SplitInput {
  readonly categoryId: string | null;
  readonly amountCents: number;
  readonly memo?: string;
}

export interface SplitRecord {
  readonly id: string;
  readonly categoryId: string | null;
  readonly amountCents: number;
  readonly memo: string | null;
}

export interface Transaction {
  readonly id: string;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly occurredAt: string;
  readonly budgetDate: string;
  readonly payee: string | null;
  readonly memo: string | null;
  readonly status: TransactionStatus;
  readonly transferId: string | null;
  /** The account of a transfer's other leg, or null when this is not a transfer leg (#599). */
  readonly transferAccountId: string | null;
  readonly externalId: string | null;
  /** The trade this transaction is the cash leg of (ADR 0012), or null: its amount, account and date belong to the trade. */
  readonly tradeId: string | null;
  /** What that trade is (#657), read with the transaction; null when `tradeId` is. */
  readonly trade: TransactionTrade | null;
  readonly createdAt: string;
  readonly splits: readonly SplitRecord[];
}

export type TradeType = "buy" | "sell" | "dividend" | "fee" | "tax" | "split" | "transfer";

/** The trade behind a cash leg (#657): `apps/api/src/transactions/repository.ts`'s `TransactionTrade`. */
export interface TransactionTrade {
  readonly type: TradeType;
  /** Units × 10^8 (ADR 0011); 0 for a type with no quantity. */
  readonly quantityE8: number;
  /** Null for an account-wide fee or tax. */
  readonly instrumentId: string | null;
  readonly instrumentName: string | null;
  readonly instrumentTicker: string | null;
}

export interface CreateTransactionInput {
  readonly occurredAt: string;
  readonly payee?: string;
  readonly memo?: string;
  readonly status?: TransactionStatus;
  readonly splits: readonly SplitInput[];
}

export interface UpdateTransactionInput {
  readonly payee?: string;
  readonly memo?: string;
  readonly status?: TransactionStatus;
  readonly splits?: readonly SplitInput[];
  readonly amountCents?: number;
}

export interface CreateTransferInput {
  readonly sourceAccountId: string;
  readonly destinationAccountId: string;
  readonly occurredAt: string;
  readonly amountCents: number;
  readonly payee?: string;
  readonly memo?: string;
  readonly status?: TransactionStatus;
  /**
   * Lands on the on-budget leg when exactly one of the two accounts is off budget
   * (`@envelope/core`'s `transferCategoryRule`): required when the money leaves the budget or comes
   * into an on-budget card, optional from an off-budget account into a cash account, where leaving
   * it out makes the money income to assign (#598, #599).
   */
  readonly categoryId?: string;
}

export interface Transfer {
  readonly source: Transaction;
  readonly destination: Transaction;
}

export async function listTransactionsForAccount(
  accessToken: string,
  workspaceId: string,
  accountId: string,
): Promise<Transaction[]> {
  const response = await apiFetch(accessToken, "GET", `/workspaces/${workspaceId}/accounts/${accountId}/transactions`);
  const body = (await response.json()) as { transactions: Transaction[] };
  return body.transactions;
}

export async function createTransaction(
  accessToken: string,
  workspaceId: string,
  accountId: string,
  input: CreateTransactionInput,
): Promise<Transaction> {
  const response = await apiFetch(accessToken, "POST", `/workspaces/${workspaceId}/accounts/${accountId}/transactions`, input);
  return (await response.json()) as Transaction;
}

export async function updateTransaction(
  accessToken: string,
  workspaceId: string,
  accountId: string,
  transactionId: string,
  input: UpdateTransactionInput,
): Promise<Transaction> {
  const response = await apiFetch(
    accessToken,
    "PATCH",
    `/workspaces/${workspaceId}/accounts/${accountId}/transactions/${transactionId}`,
    input,
  );
  return (await response.json()) as Transaction;
}

/** `409` when the transaction (or, for a transfer, either of its two legs) is reconciled — unlock it first (`#403`). */
export async function deleteTransaction(
  accessToken: string,
  workspaceId: string,
  accountId: string,
  transactionId: string,
): Promise<void> {
  await apiFetch(accessToken, "DELETE", `/workspaces/${workspaceId}/accounts/${accountId}/transactions/${transactionId}`);
}

export async function createTransfer(
  accessToken: string,
  workspaceId: string,
  input: CreateTransferInput,
): Promise<Transfer> {
  const response = await apiFetch(accessToken, "POST", `/workspaces/${workspaceId}/transfers`, input);
  return (await response.json()) as Transfer;
}
