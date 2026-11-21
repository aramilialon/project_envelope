/** Targets (`apps/api` calls them "goals") and quick assign (#55). */
import { apiFetch } from "../apiFetch.ts";

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

/** Every target of the workspace with its progress for `month`, in one request (#682); a category without a target has no entry. */
export async function listGoalProgress(accessToken: string, workspaceId: string, month: string): Promise<GoalProgress[]> {
  const response = await apiFetch(accessToken, "GET", `/workspaces/${workspaceId}/goals?month=${month}`);
  return ((await response.json()) as { goals: GoalProgress[] }).goals;
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
