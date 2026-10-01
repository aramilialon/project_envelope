/** The categories and groups endpoints (#52): list, create, archive and reorder both. */
const API_URL: string = import.meta.env.VITE_API_URL;

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

function authHeaders(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` };
}

export async function listCategoryGroups(accessToken: string, workspaceId: string): Promise<CategoryGroup[]> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/category-groups`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) {
    throw new Error(`GET /workspaces/${workspaceId}/category-groups failed: ${response.status}`);
  }
  const body = (await response.json()) as { groups: CategoryGroup[] };
  return body.groups;
}

export async function createCategoryGroup(
  accessToken: string,
  workspaceId: string,
  name: string,
): Promise<CategoryGroup> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/category-groups`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw new Error(`POST /workspaces/${workspaceId}/category-groups failed: ${response.status}`);
  }
  return (await response.json()) as CategoryGroup;
}

export async function reorderCategoryGroups(
  accessToken: string,
  workspaceId: string,
  groupIds: readonly string[],
): Promise<CategoryGroup[]> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/category-groups/reorder`, {
    method: "PUT",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({ groupIds }),
  });
  if (!response.ok) {
    throw new Error(`PUT /workspaces/${workspaceId}/category-groups/reorder failed: ${response.status}`);
  }
  const body = (await response.json()) as { groups: CategoryGroup[] };
  return body.groups;
}

export async function listCategories(accessToken: string, workspaceId: string): Promise<Category[]> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/categories`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) {
    throw new Error(`GET /workspaces/${workspaceId}/categories failed: ${response.status}`);
  }
  const body = (await response.json()) as { categories: Category[] };
  return body.categories;
}

export async function createCategory(
  accessToken: string,
  workspaceId: string,
  groupId: string,
  name: string,
): Promise<Category> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/categories`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({ name, groupId }),
  });
  if (!response.ok) {
    throw new Error(`POST /workspaces/${workspaceId}/categories failed: ${response.status}`);
  }
  return (await response.json()) as Category;
}

export async function archiveCategory(accessToken: string, workspaceId: string, categoryId: string): Promise<Category> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/categories/${categoryId}/archive`, {
    method: "PATCH",
    headers: authHeaders(accessToken),
  });
  if (!response.ok) {
    throw new Error(`PATCH /workspaces/${workspaceId}/categories/${categoryId}/archive failed: ${response.status}`);
  }
  return (await response.json()) as Category;
}

export async function reorderCategories(
  accessToken: string,
  workspaceId: string,
  groupId: string,
  categoryIds: readonly string[],
): Promise<Category[]> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/category-groups/${groupId}/categories/reorder`, {
    method: "PUT",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({ categoryIds }),
  });
  if (!response.ok) {
    throw new Error(
      `PUT /workspaces/${workspaceId}/category-groups/${groupId}/categories/reorder failed: ${response.status}`,
    );
  }
  const body = (await response.json()) as { categories: Category[] };
  return body.categories;
}
