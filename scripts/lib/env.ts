/** Fails fast with a clear message instead of `undefined` surfacing somewhere unrelated later. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set ${name} (see scripts/README.md or apps/api/README.md)`);
  }
  return value;
}

/**
 * Refuses to run against anything but a local development stack: `NODE_ENV=production` or an
 * API URL that does not resolve to `127.0.0.1`/`localhost` both abort immediately. This script
 * creates and deletes a whole workspace — never something to risk against a real deployment.
 */
export function assertSafeToRun(apiUrl: string): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run with NODE_ENV=production.");
  }
  const { hostname } = new URL(apiUrl);
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    throw new Error(`Refusing to run against a non-local API (${apiUrl}). This script is for local development only.`);
  }
}
