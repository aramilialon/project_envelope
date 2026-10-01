/**
 * Provisions and removes a throwaway user in the real "envelope" Keycloak realm (#49's own
 * `scripts/keycloak/bootstrap.sh`), for an e2e test to sign in as — mirroring the "create a
 * throwaway identity through the admin API, never by hand" approach `apps/api`'s own
 * `test-helpers/keycloak.ts` uses for its throwaway realms. Self-registration is disabled on
 * this realm by design, so a test cannot create its own user any other way.
 */

const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? "http://127.0.0.1:8080";
const REALM = "envelope";

export interface KeycloakTestUser {
  readonly username: string;
  readonly password: string;
  /** Keycloak's own user id — the `sub` claim of any token issued to this user, and so the key `db.ts`'s `findUserIdBySubject` needs. */
  readonly subject: string;
  teardown(): Promise<void>;
}

async function adminToken(): Promise<string> {
  const password = process.env.KEYCLOAK_ADMIN_PASSWORD;
  if (!password) {
    throw new Error("Set KEYCLOAK_ADMIN_PASSWORD (the value from infra/.env) to run the e2e tests");
  }
  const response = await fetch(`${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password }),
  });
  if (!response.ok) {
    throw new Error(`Keycloak admin token request failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

export async function createTestUser(): Promise<KeycloakTestUser> {
  const token = await adminToken();
  const username = `e2e-${crypto.randomUUID()}`;
  const password = crypto.randomUUID();

  const created = await fetch(`${KEYCLOAK_URL}/admin/realms/${REALM}/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      // The realm's own user profile requires these (Keycloak's default "Verify Profile"
      // required action otherwise interrupts the very first sign-in to collect them).
      email: `${username}@example.invalid`,
      emailVerified: true,
      firstName: "E2E",
      lastName: "Test",
      enabled: true,
      credentials: [{ type: "password", value: password, temporary: false }],
    }),
  });
  if (!created.ok) {
    throw new Error(`creating the e2e test user failed: ${created.status} ${await created.text()}`);
  }
  const location = created.headers.get("location");
  const userId = location?.split("/").pop();
  if (!userId) {
    throw new Error("createTestUser: could not read the created user's id from the Location header");
  }

  return {
    username,
    password,
    subject: userId,
    async teardown() {
      const freshToken = await adminToken();
      await fetch(`${KEYCLOAK_URL}/admin/realms/${REALM}/users/${userId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${freshToken}` },
      });
    },
  };
}
