/**
 * The signed-in user's own last-used workspace (#343): an entirely browser-side preference, keyed
 * by the access token's own `sub` claim so a different person signing into the same browser never
 * inherits someone else's. Every read and write is wrapped in `try`/`catch` — storage disabled, a
 * private window, quota — falling through silently, never an error the user sees.
 */
const KEY_PREFIX = "envelope.lastWorkspaceId.";

export function getLastUsedWorkspaceId(subject: string): string | null {
  try {
    return localStorage.getItem(KEY_PREFIX + subject);
  } catch {
    return null;
  }
}

export function setLastUsedWorkspaceId(subject: string, workspaceId: string): void {
  try {
    localStorage.setItem(KEY_PREFIX + subject, workspaceId);
  } catch {
    // Storage disabled, a private window, quota — the preference is simply not remembered.
  }
}

/** Called when the stored id names a workspace the user can no longer reach, so a future membership re-grant does not resurrect a stale preference by coincidence. */
export function clearLastUsedWorkspaceId(subject: string): void {
  try {
    localStorage.removeItem(KEY_PREFIX + subject);
  } catch {
    // Same as above: nothing to do if storage itself is unavailable.
  }
}
