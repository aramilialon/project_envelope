/** The reconciliation endpoints (#32, #60): `apps/api/src/reconciliation/repository.ts`'s own shapes, mirrored. */
const API_URL: string = import.meta.env.VITE_API_URL;

export interface CandidateTransaction {
  readonly id: string;
  readonly occurredAt: string;
  readonly payee: string | null;
  readonly amountCents: number;
}

export interface ReconciliationCandidates {
  readonly lastReconciledBalanceCents: number;
  readonly pendingTransactions: readonly CandidateTransaction[];
  readonly clearedTransactions: readonly CandidateTransaction[];
}

export interface ReconciliationAdjustment {
  readonly categoryId: string | null;
  readonly memo?: string;
}

export interface ReconcileInput {
  readonly date: string;
  readonly statementBalanceCents: number;
  readonly tickedTransactionIds: readonly string[];
  readonly adjustment?: ReconciliationAdjustment;
}

export interface ReconciliationRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly reconciledAt: string;
  readonly statementBalanceCents: number;
  readonly userId: string | null;
  readonly brokenAt: string | null;
  readonly createdAt: string;
}

export interface ReconciliationSuggestion {
  readonly transactionId: string;
  readonly kind: "pending" | "unticked";
}

export type ReconcileResult =
  | { readonly outcome: "reconciled"; readonly reconciliation: ReconciliationRecord }
  | { readonly outcome: "difference"; readonly differenceCents: number; readonly suggestion?: ReconciliationSuggestion };

function authHeaders(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` };
}

export async function getReconciliationCandidates(
  accessToken: string,
  workspaceId: string,
  accountId: string,
  date: string,
): Promise<ReconciliationCandidates> {
  const response = await fetch(
    `${API_URL}/workspaces/${workspaceId}/accounts/${accountId}/reconciliation-candidates?date=${encodeURIComponent(date)}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) {
    throw new Error(`GET .../accounts/${accountId}/reconciliation-candidates failed: ${response.status}`);
  }
  return (await response.json()) as ReconciliationCandidates;
}

export async function reconcileAccount(
  accessToken: string,
  workspaceId: string,
  accountId: string,
  input: ReconcileInput,
): Promise<ReconcileResult> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/accounts/${accountId}/reconciliations`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`POST .../accounts/${accountId}/reconciliations failed: ${response.status}`);
  }
  return (await response.json()) as ReconcileResult;
}

export async function unlockReconciliation(accessToken: string, workspaceId: string, transactionId: string): Promise<void> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/transactions/${transactionId}/unlock-reconciliation`, {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  if (!response.ok) {
    throw new Error(`POST .../transactions/${transactionId}/unlock-reconciliation failed: ${response.status}`);
  }
}
