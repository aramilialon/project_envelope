import { createHash, randomBytes } from "node:crypto";

/**
 * Gets a real access token for a persistent "demo" Keycloak user, without a browser. The
 * `envelope-api` client is public, PKCE-only, with `directAccessGrantsEnabled: false` by design
 * (`scripts/keycloak/bootstrap.sh`) — no password grant. This drives the same Authorization
 * Code + PKCE handshake a browser would, by posting directly to Keycloak's own server-rendered
 * login form (an ordinary HTML form, no client-side rendering), the same way
 * `apps/web/e2e/keycloak-test-user.ts` creates throwaway users through the admin API instead of
 * the (disabled) self-registration screen.
 */

const REALM = "envelope";
const REDIRECT_URI = "http://localhost:5173";

function base64url(input: Buffer): string {
  return input.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll(/=+$/g, "");
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** The `sub` claim of an access token, without pulling in a JWT library for one field. */
export function subjectOf(accessToken: string): string {
  const payload = accessToken.split(".")[1];
  if (!payload) {
    throw new Error("subjectOf: not a JWT (no payload segment)");
  }
  const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub: string };
  return json.sub;
}

async function adminToken(keycloakUrl: string, adminPassword: string): Promise<string> {
  const response = await fetch(`${keycloakUrl}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password: adminPassword }),
  });
  if (!response.ok) {
    throw new Error(`Keycloak admin token request failed: ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as { access_token: string }).access_token;
}

/** Creates the persistent "demo" user if it does not already exist; leaves it alone otherwise (its password is not changed on an existing user). */
export async function ensureDemoUser(
  keycloakUrl: string,
  adminPassword: string,
  username: string,
  password: string,
): Promise<void> {
  const token = await adminToken(keycloakUrl, adminPassword);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const existing = await fetch(`${keycloakUrl}/admin/realms/${REALM}/users?username=${username}&exact=true`, { headers });
  if (!existing.ok) {
    throw new Error(`looking up the demo user failed: ${existing.status} ${await existing.text()}`);
  }
  const found = (await existing.json()) as unknown[];
  if (found.length > 0) {
    return;
  }

  const created = await fetch(`${keycloakUrl}/admin/realms/${REALM}/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      username,
      email: `${username}@example.invalid`,
      emailVerified: true,
      firstName: "Demo",
      lastName: "User",
      enabled: true,
      credentials: [{ type: "password", value: password, temporary: false }],
    }),
  });
  if (!created.ok) {
    throw new Error(`creating the demo user failed: ${created.status} ${await created.text()}`);
  }
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair] = setCookie.split(";");
      const [name, value] = pair?.split("=", 2) ?? [];
      if (name && value !== undefined) {
        this.cookies.set(name, value);
      }
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

/** The login form's own POST target, out of the page Keycloak serves for the auth request. */
function findFormAction(html: string): string {
  const match = /<form[^>]+action="([^"]+)"/i.exec(html);
  if (!match?.[1]) {
    throw new Error("signInAsDemoUser: could not find the login form's action URL in Keycloak's response");
  }
  return match[1].replaceAll("&amp;", "&");
}

/** Signs in as `username`/`password` through the real PKCE handshake, returning an access token. */
export async function signInAsDemoUser(keycloakUrl: string, clientId: string, username: string, password: string): Promise<string> {
  const jar = new CookieJar();
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(16));

  const authUrl = new URL(`${keycloakUrl}/realms/${REALM}/protocol/openid-connect/auth`);
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  const loginPage = await fetch(authUrl);
  jar.absorb(loginPage);
  if (!loginPage.ok) {
    throw new Error(`fetching the login page failed: ${loginPage.status} ${await loginPage.text()}`);
  }
  const actionUrl = findFormAction(await loginPage.text());

  const submitted = await fetch(actionUrl, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header() },
    body: new URLSearchParams({ username, password, credentialId: "" }),
  });
  jar.absorb(submitted);
  const location = submitted.headers.get("location");
  if (submitted.status !== 302 || !location) {
    throw new Error(
      `signing in as "${username}" failed: expected a redirect after the login form post, got ${submitted.status}. ` +
        "Check the demo user's password matches DEMO_USER_PASSWORD.",
    );
  }
  const code = new URL(location).searchParams.get("code");
  if (!code) {
    throw new Error(`signInAsDemoUser: no "code" in the redirect location (${location})`);
  }

  const tokenResponse = await fetch(`${keycloakUrl}/realms/${REALM}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`exchanging the code for a token failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
  }
  return ((await tokenResponse.json()) as { access_token: string }).access_token;
}
