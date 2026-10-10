/** The import endpoints (#28, #29, #59): `apps/api/src/import/repository.ts`'s own shapes, mirrored. */
const API_URL: string = import.meta.env.VITE_API_URL;

export type CsvDateFormat = "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY";
export type DecimalSeparator = "." | ",";

interface AmountColumnMapping {
  readonly amountColumn: number;
}
interface SplitColumnMapping {
  readonly outflowColumn: number;
  readonly inflowColumn: number;
}

export type CsvMapping = (AmountColumnMapping | SplitColumnMapping) & {
  readonly hasHeaderRow: boolean;
  readonly dateColumn: number;
  readonly dateFormat: CsvDateFormat;
  readonly descriptionColumn: number;
  readonly decimalSeparator: DecimalSeparator;
  readonly memoColumn?: number;
};

export type ImportFormat = "csv" | "ofx" | "qif" | "camt053";

export interface StagedTransaction {
  readonly id: string;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly occurredAt: string;
  readonly payee: string | null;
  readonly memo: string | null;
  readonly amountCents: number;
  readonly externalId: string | null;
  readonly duplicateOf: string | null;
  readonly createdAt: string;
}

export interface ClosingBalanceComparison {
  readonly statementCents: number;
  readonly projectedCents: number;
  readonly differenceCents: number;
}

export interface StageImportResult {
  readonly staged: readonly StagedTransaction[];
  readonly duplicateCount: number;
  readonly closingBalance?: ClosingBalanceComparison;
}

export type StagedTransactionDecision =
  | { readonly stagedTransactionId: string; readonly kind: "income" }
  | { readonly stagedTransactionId: string; readonly kind: "category"; readonly categoryId: string }
  | { readonly stagedTransactionId: string; readonly kind: "transfer"; readonly otherAccountId: string };

export type ConfirmationOutcome =
  | { readonly stagedTransactionId: string; readonly outcome: "confirmed"; readonly transactionId: string }
  | { readonly stagedTransactionId: string; readonly outcome: "duplicate_cleared"; readonly transactionId: string }
  | { readonly stagedTransactionId: string; readonly outcome: "rejected"; readonly code: string }
  | { readonly stagedTransactionId: string; readonly outcome: "not_found" };

function authHeaders(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` };
}

export async function getImportMapping(accessToken: string, workspaceId: string, accountId: string): Promise<CsvMapping | undefined> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/accounts/${accountId}/import-mapping`, {
    headers: authHeaders(accessToken),
  });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`GET .../accounts/${accountId}/import-mapping failed: ${response.status}`);
  }
  return (await response.json()) as CsvMapping;
}

export async function saveImportMapping(
  accessToken: string,
  workspaceId: string,
  accountId: string,
  mapping: CsvMapping,
): Promise<CsvMapping> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/accounts/${accountId}/import-mapping`, {
    method: "PUT",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify(mapping),
  });
  if (!response.ok) {
    throw new Error(`PUT .../accounts/${accountId}/import-mapping failed: ${response.status}`);
  }
  return (await response.json()) as CsvMapping;
}

export interface StageImportInput {
  readonly content: string;
  readonly format: ImportFormat;
  readonly mapping?: CsvMapping;
  readonly closingBalanceCents?: number;
}

export async function stageImport(
  accessToken: string,
  workspaceId: string,
  accountId: string,
  input: StageImportInput,
): Promise<StageImportResult> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/accounts/${accountId}/import`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`POST .../accounts/${accountId}/import failed: ${response.status}`);
  }
  return (await response.json()) as StageImportResult;
}

export async function confirmStagedTransactions(
  accessToken: string,
  workspaceId: string,
  accountId: string,
  decisions: readonly StagedTransactionDecision[],
): Promise<ConfirmationOutcome[]> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/accounts/${accountId}/staged-transactions/confirm`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({ decisions }),
  });
  if (!response.ok) {
    throw new Error(`POST .../accounts/${accountId}/staged-transactions/confirm failed: ${response.status}`);
  }
  const body = (await response.json()) as { outcomes: ConfirmationOutcome[] };
  return body.outcomes;
}
