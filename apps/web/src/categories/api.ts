/** The categories and groups endpoints (#52): list, create, archive and reorder both. */
import { apiFetch } from "../apiFetch.ts";

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
  const response = await apiFetch(accessToken, "POST", `/workspaces/${workspaceId}/category-groups`, { name });
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
  const response = await apiFetch(accessToken, "POST", `/workspaces/${workspaceId}/categories`, { name, groupId });
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
