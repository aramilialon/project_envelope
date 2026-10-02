/** Fails fast with a clear message instead of `undefined` surfacing somewhere unrelated later. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set ${name} (see scripts/README.md or apps/api/README.md)`);
  }
  return value;
}

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

/**
 * Refuses to run against anything but a local development stack: `NODE_ENV=production`, or any
 * of the given URLs not resolving to `127.0.0.1`/`localhost`, both abort before this makes a
 * single request. This script creates and deletes a whole workspace, reads and writes the
 * database directly, and talks to Keycloak's own admin API — never something to risk against a
 * real deployment. `urls` is every connection the caller is about to use, keyed by the
 * environment variable it came from, so the error names the one that is not local.
 */
export function assertSafeToRun(urls: Readonly<Record<string, string>>): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run with NODE_ENV=production.");
  }
  for (const [name, url] of Object.entries(urls)) {
    const { hostname } = new URL(url);
    if (!LOCAL_HOSTNAMES.has(hostname)) {
      throw new Error(`Refusing to run against a non-local ${name} (${url}). This script is for local development only.`);
    }
  }
}
