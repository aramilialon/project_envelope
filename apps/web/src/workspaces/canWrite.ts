import type { WorkspaceRole } from "./api.ts";

/**
 * Whether a member's own role lets them write (`#61`): owner or editor, never `read_only`.
 * Takes the role alone (not the whole `Workspace`) since both callers already derive their own
 * `currentWorkspace` from a separately-loading `useWorkspaces()`, which may not have resolved
 * yet — `undefined` defaults to `false`, the safer default than ever showing a write action a
 * read-only member could click before the real role arrives.
 */
export function canWrite(role: WorkspaceRole | undefined): boolean {
  return role === "owner" || role === "editor";
}
