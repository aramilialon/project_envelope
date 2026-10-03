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
