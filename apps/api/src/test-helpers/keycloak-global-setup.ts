/**
 * The Node.js test runner's global setup for apps/api's test runs (`--test-global-setup`, in
 * `test:integration` and `test:smoke`): one Keycloak realm per run instead of one per test
 * file (#639). It runs once, in the runner's own process, before the first file starts: it
 * sweeps the test realms earlier runs left behind, creates the run's realm and hands it to every
 * file through `RUN_REALM_ENV`, which the files' processes inherit. `globalTeardown` deletes the
 * realm once the last file has ended, also when the run is interrupted (SIGINT, SIGTERM) or a
 * file fails; a run killed outright (SIGKILL, a crash of the runner) leaves it to the next run's
 * sweep. Without `KEYCLOAK_ADMIN_PASSWORD` it does nothing, and each file that needs Keycloak
 * fails with its own message.
 */
import { createTestRealm, deleteTestRealm, RUN_REALM_ENV, sweepLeftoverTestRealms } from "./keycloak.ts";

let runRealm: string | undefined;

export async function globalSetup(): Promise<void> {
  const adminPassword = process.env.KEYCLOAK_ADMIN_PASSWORD;
  if (!adminPassword) {
    return;
  }
  try {
    await sweepLeftoverTestRealms(adminPassword);
  } catch (error) {
    // A leftover realm costs nothing but space; the run goes on, and the next sweep tries again.
    console.warn(`Could not sweep leftover Keycloak test realms: ${(error as Error).message}`);
  }
  const credentials = await createTestRealm(adminPassword);
  runRealm = credentials.realm;
  process.env[RUN_REALM_ENV] = JSON.stringify(credentials);
}

export async function globalTeardown(): Promise<void> {
  const adminPassword = process.env.KEYCLOAK_ADMIN_PASSWORD;
  if (!adminPassword || runRealm === undefined) {
    return;
  }
  await deleteTestRealm(adminPassword, runRealm);
  runRealm = undefined;
  delete process.env[RUN_REALM_ENV];
}
