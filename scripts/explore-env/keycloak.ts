/**
 * The Keycloak side of a disposable environment (#536): a realm of its own, created here with a
 * creation timestamp the sweeper reads, then given the web app's client by
 * `scripts/keycloak/bootstrap.sh` (the same script that sets up the shared realm), plus a second
 * public client with the password grant so a persona can call the API without a browser, and the
 * persona users. The admin token never leaves this process.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assertExploreRealm, REALM_PREFIX } from "./names.ts";

const BOOTSTRAP_SH = fileURLToPath(new URL("../keycloak/bootstrap.sh", import.meta.url));
const CREATED_AT_ATTRIBUTE = "envelopeExploreCreatedAt";
export const WEB_CLIENT_ID = "envelope-api";
export const API_CLIENT_ID = "envelope-explore-cli";
/** Long enough for an explorer's call sequence between two token requests. */
const ACCESS_TOKEN_LIFESPAN_SECONDS = 900;

export class KeycloakAdmin {
  readonly url: string;
  private readonly adminPassword: string;
  private token: string | undefined;

  constructor(url: string, adminPassword: string) {
    this.url = url;
    this.adminPassword = adminPassword;
  }

  private async adminToken(): Promise<string> {
    if (this.token) {
      return this.token;
    }
    const response = await fetch(`${this.url}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password: this.adminPassword }),
    });
    if (!response.ok) {
      throw new Error(`Keycloak admin token request failed: ${response.status} (check KEYCLOAK_ADMIN_PASSWORD)`);
    }
    this.token = ((await response.json()) as { access_token: string }).access_token;
    return this.token;
  }

  /** An admin API call, retrying a 5xx a few times (Keycloak answers one now and then while other runs create and delete realms, #519). */
  async request(method: string, path: string, body?: unknown): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(`${this.url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${await this.adminToken()}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 401 && attempt === 1) {
        this.token = undefined;
        await response.body?.cancel();
        continue;
      }
      if (response.status < 500 || attempt >= 5) {
        return response;
      }
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }

  private async expectOk(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await this.request(method, path, body);
    if (!response.ok) {
      throw new Error(`Keycloak ${method} ${path} failed: ${response.status} ${await response.text()}`);
    }
    return response;
  }

  async createRealm(realm: string, createdAt: Date): Promise<void> {
    assertExploreRealm(realm);
    await this.expectOk("POST", "/admin/realms", {
      realm,
      enabled: true,
      registrationAllowed: false,
      verifyEmail: false,
      accessTokenLifespan: ACCESS_TOKEN_LIFESPAN_SECONDS,
      attributes: { [CREATED_AT_ATTRIBUTE]: createdAt.toISOString() },
    });
  }

  /** Runs `scripts/keycloak/bootstrap.sh` for `realm`, allowing exactly `webOrigin`. */
  async bootstrap(realm: string, webOrigin: string, log: (line: string) => void): Promise<void> {
    assertExploreRealm(realm);
    const child = spawn("bash", [BOOTSTRAP_SH], {
      env: {
        PATH: process.env.PATH ?? "",
        KEYCLOAK_URL: this.url,
        KEYCLOAK_ADMIN_PASSWORD: this.adminPassword,
        KEYCLOAK_REALM: realm,
        KEYCLOAK_AUDIENCE: WEB_CLIENT_ID,
        WEB_ORIGINS: webOrigin,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    if (code !== 0) {
      throw new Error(`scripts/keycloak/bootstrap.sh failed:\n${output}`);
    }
    log(`realm ${realm} bootstrapped`);
  }

  /** A public client with the password grant and the API's audience, for calling the API without a browser. */
  async createApiClient(realm: string): Promise<void> {
    assertExploreRealm(realm);
    const created = await this.expectOk("POST", `/admin/realms/${realm}/clients`, {
      clientId: API_CLIENT_ID,
      enabled: true,
      publicClient: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: true,
      serviceAccountsEnabled: false,
    });
    const internalId = created.headers.get("location")?.split("/").pop();
    if (!internalId) {
      throw new Error("Keycloak did not return the new client's id");
    }
    await this.expectOk("POST", `/admin/realms/${realm}/clients/${internalId}/protocol-mappers/models`, {
      name: "audience-mapper",
      protocol: "openid-connect",
      protocolMapper: "oidc-audience-mapper",
      config: { "included.custom.audience": WEB_CLIENT_ID, "id.token.claim": "false", "access.token.claim": "true" },
    });
  }

  async createUser(realm: string, username: string, password: string, firstName: string): Promise<void> {
    assertExploreRealm(realm);
    await this.expectOk("POST", `/admin/realms/${realm}/users`, {
      username,
      // The user profile requires these; without them the first sign-in stops to ask for them.
      email: `${username}@example.invalid`,
      emailVerified: true,
      firstName,
      lastName: "Explorer",
      enabled: true,
      requiredActions: [],
      credentials: [{ type: "password", value: password, temporary: false }],
    });
  }

  /** Deletes `realm`; true if it existed. */
  async deleteRealm(realm: string): Promise<boolean> {
    assertExploreRealm(realm);
    const response = await this.request("DELETE", `/admin/realms/${encodeURIComponent(realm)}`);
    await response.body?.cancel();
    if (response.status === 404) {
      return false;
    }
    if (!response.ok) {
      throw new Error(`Deleting realm ${realm} failed: ${response.status}`);
    }
    return true;
  }

  async listExploreRealms(): Promise<{ name: string; createdAt: Date | undefined }[]> {
    const response = await this.expectOk("GET", "/admin/realms?briefRepresentation=false");
    const realms = (await response.json()) as { realm: string; attributes?: Record<string, string> }[];
    return realms
      .filter((r) => r.realm.startsWith(REALM_PREFIX))
      .map((r) => {
        const value = r.attributes?.[CREATED_AT_ATTRIBUTE];
        const stamp = value ? new Date(value) : undefined;
        return { name: r.realm, createdAt: stamp && !Number.isNaN(stamp.getTime()) ? stamp : undefined };
      });
  }
}

/** An access token for a persona, through the realm's password-grant client. */
export async function personaToken(keycloakUrl: string, realm: string, username: string, password: string): Promise<string> {
  const response = await fetch(`${keycloakUrl}/realms/${realm}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: API_CLIENT_ID, username, password, scope: "openid" }),
  });
  if (!response.ok) {
    throw new Error(`Getting a token for ${username} failed: ${response.status}`);
  }
  return ((await response.json()) as { access_token: string }).access_token;
}
