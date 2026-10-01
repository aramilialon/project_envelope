/** The workspaces endpoint (#50): the first authenticated API call this app makes. */
const API_URL: string = import.meta.env.VITE_API_URL;

export type WorkspaceRole = "owner" | "editor" | "read_only";

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly role: WorkspaceRole;
  readonly baseCurrency: string;
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
