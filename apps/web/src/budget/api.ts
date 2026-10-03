/** The budget month endpoint (#53): `apps/api/src/budget/repository.ts`'s own response shape, mirrored. */
const API_URL: string = import.meta.env.VITE_API_URL;

export interface BudgetMonthCategory {
  readonly categoryId: string;
  readonly name: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly sortOrder: number;
  readonly carriedOver: number;
  readonly assigned: number;
  readonly activity: number;
  readonly available: number;
  readonly creditOverspending: number;
  readonly cashOverspending: number;
  readonly reserved: number;
  readonly uncovered: number;
}

export interface BudgetMonthResponse {
  readonly month: string;
  readonly unassigned: number;
  readonly assignedInFuture: number;
  readonly overspentLastMonth: number;
  readonly creditOverspending: number;
  readonly reserved: number;
  readonly categories: readonly BudgetMonthCategory[];
  readonly paymentCategories: readonly BudgetMonthCategory[];
}

export async function getBudgetMonth(
  accessToken: string,
  workspaceId: string,
  month: string,
): Promise<BudgetMonthResponse> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/budget-months/${month}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`GET /workspaces/${workspaceId}/budget-months/${month} failed: ${response.status}`);
  }
  return (await response.json()) as BudgetMonthResponse;
}

/** `GET .../budget-months/:month/events` (#325, #346): what the timeline and the "To do" list are both built from. */
export interface MonthEvent {
  readonly date: string;
  readonly amountCents: number;
  readonly payee: string | null;
  readonly categoryId: string | null;
  readonly kind: "recorded" | "pending" | "scheduled";
  readonly scheduledTransactionId?: string;
}

export async function getBudgetMonthEvents(
  accessToken: string,
  workspaceId: string,
  month: string,
  accountId?: string,
): Promise<readonly MonthEvent[]> {
  const url = new URL(`${API_URL}/workspaces/${workspaceId}/budget-months/${month}/events`);
  if (accountId !== undefined) {
    url.searchParams.set("accountId", accountId);
  }
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    throw new Error(`GET /workspaces/${workspaceId}/budget-months/${month}/events failed: ${response.status}`);
  }
  const body = (await response.json()) as { events: MonthEvent[] };
  return body.events;
}

/** One entry of `POST .../assignments`' own batch — the assignment ledger's append-only unit (ADR 0008). `null` means unassigned money. */
export interface AssignmentEntryInput {
  readonly month: string;
  readonly sourceCategoryId: string | null;
  readonly destinationCategoryId: string | null;
  readonly amountCents: number;
}

export async function createAssignments(accessToken: string, workspaceId: string, entries: readonly AssignmentEntryInput[]): Promise<void> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/assignments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  });
  if (!response.ok) {
    throw new Error(`POST /workspaces/${workspaceId}/assignments failed: ${response.status}`);
  }
}

/** The scheduled transactions endpoints (#330): `apps/api/src/scheduled-transactions/repository.ts`'s own response shapes, mirrored. A split's `categoryId` is always a real category — a scheduled transaction is never income yet (`#347`). */
export type RecurUnit = "day" | "month" | "year";

export interface ScheduledSplit {
  readonly categoryId: string;
  readonly amountCents: number;
  readonly memo: string | null;
}

export interface ScheduledTransaction {
  readonly id: string;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly payee: string | null;
  readonly memo: string | null;
  readonly nextDueDate: string;
  readonly recurEvery: number;
  readonly recurUnit: RecurUnit;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly splits: readonly ScheduledSplit[];
}

export interface CreateScheduledTransactionInput {
  readonly accountId: string;
  readonly payee?: string;
  readonly memo?: string;
  readonly nextDueDate: string;
  readonly recurEvery: number;
  readonly recurUnit: RecurUnit;
  readonly categoryId: string;
  readonly amountCents: number;
}

export async function listScheduledTransactions(accessToken: string, workspaceId: string): Promise<readonly ScheduledTransaction[]> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/scheduled-transactions`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`GET /workspaces/${workspaceId}/scheduled-transactions failed: ${response.status}`);
  }
  const body = (await response.json()) as { scheduledTransactions: ScheduledTransaction[] };
  return body.scheduledTransactions;
}

export async function createScheduledTransaction(
  accessToken: string,
  workspaceId: string,
  input: CreateScheduledTransactionInput,
): Promise<ScheduledTransaction> {
  const { categoryId, amountCents, ...rest } = input;
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/scheduled-transactions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...rest, amountCents, splits: [{ categoryId, amountCents }] }),
  });
  if (!response.ok) {
    throw new Error(`POST /workspaces/${workspaceId}/scheduled-transactions failed: ${response.status}`);
  }
  return (await response.json()) as ScheduledTransaction;
}

export interface RecordScheduledTransactionResult {
  readonly transaction: { readonly id: string };
  readonly scheduledTransaction: ScheduledTransaction;
}

export async function recordScheduledTransaction(
  accessToken: string,
  workspaceId: string,
  scheduledTransactionId: string,
): Promise<RecordScheduledTransactionResult> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/scheduled-transactions/${scheduledTransactionId}/record`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`POST /workspaces/${workspaceId}/scheduled-transactions/${scheduledTransactionId}/record failed: ${response.status}`);
  }
  return (await response.json()) as RecordScheduledTransactionResult;
}

export async function skipScheduledTransaction(accessToken: string, workspaceId: string, scheduledTransactionId: string): Promise<ScheduledTransaction> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/scheduled-transactions/${scheduledTransactionId}/skip`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`POST /workspaces/${workspaceId}/scheduled-transactions/${scheduledTransactionId}/skip failed: ${response.status}`);
  }
  return (await response.json()) as ScheduledTransaction;
}
