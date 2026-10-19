/** The workspaces endpoint (#50): the first authenticated API call this app makes. */
const API_URL: string = import.meta.env.VITE_API_URL;

export type WorkspaceRole = "owner" | "editor" | "read_only";

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly role: WorkspaceRole;
  readonly baseCurrency: string;
  /** IANA time zone name (e.g. "Europe/Rome"): "today" and "this month" are the workspace's own, not the browser's (#326). */
  readonly timeZone: string;
}

export interface CreateWorkspaceInput {
  readonly name: string;
  readonly baseCurrency: string;
  readonly timeZone: string;
}

export async function listMyWorkspaces(accessToken: string): Promise<Workspace[]> {
  const response = await fetch(`${API_URL}/me/workspaces`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`GET /me/workspaces failed: ${response.status}`);
  }
  const body = (await response.json()) as { workspaces: Workspace[] };
  return body.workspaces;
}

/** `#394`: creates a workspace with the signed-in user as its own first member, `owner`. */
export async function createWorkspace(accessToken: string, input: CreateWorkspaceInput): Promise<Workspace> {
  const response = await fetch(`${API_URL}/workspaces`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`POST /workspaces failed: ${response.status}`);
  }
  return (await response.json()) as Workspace;
}

/** `#394`: deletes a workspace outright — owner-only, `403` for anyone else. */
export async function deleteWorkspace(accessToken: string, workspaceId: string): Promise<void> {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`DELETE /workspaces/${workspaceId} failed: ${response.status}`);
  }
}
