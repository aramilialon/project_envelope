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
