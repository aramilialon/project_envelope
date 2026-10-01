/** The transactions and transfers endpoints (#54): `apps/api/src/transactions/repository.ts`'s own shapes, mirrored. */
const API_URL: string = import.meta.env.VITE_API_URL;

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
  readonly externalId: string | null;
  readonly createdAt: string;
  readonly splits: readonly SplitRecord[];
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
}

export interface Transfer {
  readonly source: Transaction;
  readonly destination: Transaction;
}

function authHeaders(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` };
}

export async function listTransactionsForAccount(
  accessToken: string,
  workspaceId: string,
  accountId: string,
): Promise<Transaction[]> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/accounts/${accountId}/transactions`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) {
    throw new Error(`GET /workspaces/${workspaceId}/accounts/${accountId}/transactions failed: ${response.status}`);
  }
  const body = (await response.json()) as { transactions: Transaction[] };
  return body.transactions;
}

export async function createTransaction(
  accessToken: string,
  workspaceId: string,
  accountId: string,
  input: CreateTransactionInput,
): Promise<Transaction> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/accounts/${accountId}/transactions`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`POST /workspaces/${workspaceId}/accounts/${accountId}/transactions failed: ${response.status}`);
  }
  return (await response.json()) as Transaction;
}

export async function updateTransaction(
  accessToken: string,
  workspaceId: string,
  accountId: string,
  transactionId: string,
  input: UpdateTransactionInput,
): Promise<Transaction> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/accounts/${accountId}/transactions/${transactionId}`, {
    method: "PATCH",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(
      `PATCH /workspaces/${workspaceId}/accounts/${accountId}/transactions/${transactionId} failed: ${response.status}`,
    );
  }
  return (await response.json()) as Transaction;
}

export async function createTransfer(
  accessToken: string,
  workspaceId: string,
  input: CreateTransferInput,
): Promise<Transfer> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/transfers`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`POST /workspaces/${workspaceId}/transfers failed: ${response.status}`);
  }
  return (await response.json()) as Transfer;
}
