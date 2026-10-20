/** Targets (`apps/api` calls them "goals") and quick assign (#55). */
import { apiFetch, authHeaders } from "../apiFetch.ts";

const API_URL: string = import.meta.env.VITE_API_URL;

export type GoalKind = "monthly" | "by_date" | "repeating" | "balance";
export type RepeatInterval = 2 | 3 | 4 | 6 | 12 | 24;

export interface GoalInput {
  readonly kind: GoalKind;
  readonly amountCents: number;
  readonly dueMonth?: string;
  readonly every?: RepeatInterval;
}

export interface GoalRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly categoryId: string;
  readonly kind: GoalKind;
  readonly amountCents: number;
  readonly dueMonth: string | null;
  readonly every: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GoalProgress {
  readonly goal: GoalRecord;
  readonly asks: number;
  readonly missing: number;
  readonly progress: number;
}

/** Undefined when this category has no target set, rather than throwing — the one call here that cannot go through `apiFetch`, which would throw before this gets the chance to look at a 404. */
export async function getGoal(
  accessToken: string,
  workspaceId: string,
  categoryId: string,
  month: string,
): Promise<GoalProgress | undefined> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/categories/${categoryId}/goal?month=${month}`, {
    headers: authHeaders(accessToken),
  });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`GET /workspaces/${workspaceId}/categories/${categoryId}/goal failed: ${response.status}`);
  }
  return (await response.json()) as GoalProgress;
}

export async function upsertGoal(
  accessToken: string,
  workspaceId: string,
  categoryId: string,
  input: GoalInput,
): Promise<GoalRecord> {
  const response = await apiFetch(accessToken, "PUT", `/workspaces/${workspaceId}/categories/${categoryId}/goal`, input);
  return (await response.json()) as GoalRecord;
}

export async function deleteGoal(accessToken: string, workspaceId: string, categoryId: string): Promise<void> {
  await apiFetch(accessToken, "DELETE", `/workspaces/${workspaceId}/categories/${categoryId}/goal`);
}

export type QuickAssignMode = "fund_targets" | "cover_overspending" | "cover_card_debt" | "repeat_assigned" | "repeat_spent";
export type QuickAssignScope = { readonly kind: "all" } | { readonly kind: "group"; readonly groupId: string };

export async function runQuickAssign(
  accessToken: string,
  workspaceId: string,
  month: string,
  scope: QuickAssignScope,
  mode: QuickAssignMode,
): Promise<void> {
  await apiFetch(accessToken, "POST", `/workspaces/${workspaceId}/quick-assign`, { month, scope, mode });
}
