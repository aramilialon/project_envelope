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
