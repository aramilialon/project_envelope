/** The categories and groups endpoints (#52): list, create, rename (#397), archive and reorder both. */
import { apiFetch, authHeaders } from "../apiFetch.ts";

const API_URL: string = import.meta.env.VITE_API_URL;

/** Why the API refused a name (#397): see `apps/api`'s own `CategoryConflict`. */
export type CategoryConflictCode = "name_taken" | "payment_category" | "payment_group";

/** A 409 from creating or renaming a category or group, carrying the API's own stable `code`. */
export class CategoryConflictError extends Error {
  readonly code: CategoryConflictCode;

  constructor(code: CategoryConflictCode) {
    super(`category conflict: ${code}`);
    this.code = code;
  }
}

/**
 * A create or rename call: a 409 becomes a `CategoryConflictError` the form can name, every other
 * failure the same generic error `apiFetch` throws — so this one uses a plain `fetch`, since
 * `apiFetch` throws before the body's own `code` could be read.
 */
async function sendName(accessToken: string, method: string, path: string, body: unknown): Promise<Response> {
  const response = await fetch(`${API_URL}${path}`, { method, headers: authHeaders(accessToken, true), body: JSON.stringify(body) });
  if (response.status === 409) {
    const { code } = (await response.json()) as { code: CategoryConflictCode };
    throw new CategoryConflictError(code);
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${response.status}`);
  }
  return response;
}

export interface CategoryGroup {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly archived: boolean;
}

export interface Category {
  readonly id: string;
  readonly workspaceId: string;
  readonly groupId: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly archived: boolean;
}

export async function listCategoryGroups(accessToken: string, workspaceId: string): Promise<CategoryGroup[]> {
  const response = await apiFetch(accessToken, "GET", `/workspaces/${workspaceId}/category-groups`);
  const body = (await response.json()) as { groups: CategoryGroup[] };
  return body.groups;
}

export async function createCategoryGroup(
  accessToken: string,
  workspaceId: string,
  name: string,
): Promise<CategoryGroup> {
  const response = await sendName(accessToken, "POST", `/workspaces/${workspaceId}/category-groups`, { name });
  return (await response.json()) as CategoryGroup;
}

export async function renameCategoryGroup(accessToken: string, workspaceId: string, groupId: string, name: string): Promise<CategoryGroup> {
  const response = await sendName(accessToken, "PATCH", `/workspaces/${workspaceId}/category-groups/${groupId}`, { name });
  return (await response.json()) as CategoryGroup;
}

export async function reorderCategoryGroups(
  accessToken: string,
  workspaceId: string,
  groupIds: readonly string[],
): Promise<CategoryGroup[]> {
  const response = await apiFetch(accessToken, "PUT", `/workspaces/${workspaceId}/category-groups/reorder`, { groupIds });
  const body = (await response.json()) as { groups: CategoryGroup[] };
  return body.groups;
}

export async function listCategories(accessToken: string, workspaceId: string): Promise<Category[]> {
  const response = await apiFetch(accessToken, "GET", `/workspaces/${workspaceId}/categories`);
  const body = (await response.json()) as { categories: Category[] };
  return body.categories;
}

export async function createCategory(
  accessToken: string,
  workspaceId: string,
  groupId: string,
  name: string,
): Promise<Category> {
  const response = await sendName(accessToken, "POST", `/workspaces/${workspaceId}/categories`, { name, groupId });
  return (await response.json()) as Category;
}

export async function renameCategory(accessToken: string, workspaceId: string, categoryId: string, name: string): Promise<Category> {
  const response = await sendName(accessToken, "PATCH", `/workspaces/${workspaceId}/categories/${categoryId}`, { name });
  return (await response.json()) as Category;
}

export async function archiveCategory(accessToken: string, workspaceId: string, categoryId: string): Promise<Category> {
  const response = await apiFetch(accessToken, "PATCH", `/workspaces/${workspaceId}/categories/${categoryId}/archive`);
  return (await response.json()) as Category;
}

export async function reorderCategories(
  accessToken: string,
  workspaceId: string,
  groupId: string,
  categoryIds: readonly string[],
): Promise<Category[]> {
  const response = await apiFetch(
    accessToken,
    "PUT",
    `/workspaces/${workspaceId}/category-groups/${groupId}/categories/reorder`,
    { categoryIds },
  );
  const body = (await response.json()) as { categories: Category[] };
  return body.categories;
}
