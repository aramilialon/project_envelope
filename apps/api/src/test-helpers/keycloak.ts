/**
 * Provisions a throwaway Keycloak realm for integration tests, through the
 * admin REST API: a realm with a short access-token lifespan (so a test can
 * wait for a token to expire), two clients with different audiences, and one
 * user. Nothing here is meant for anything but tests: the realm is deleted in
 * `teardown()`.
 */
import { randomUUID } from "node:crypto";

const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? "http://127.0.0.1:8080";
const MATCHING_AUDIENCE = "envelope-api";
const MISMATCHED_AUDIENCE = "some-other-api";

export interface KeycloakTestRealm {
  readonly issuer: string;
  readonly audience: string;
  getUserToken(): Promise<string>;
  getTokenWithMismatchedAudience(): Promise<string>;
  updateUserEmail(email: string): Promise<void>;
  teardown(): Promise<void>;
}

export async function setUpKeycloakTestRealm(): Promise<KeycloakTestRealm> {
  const adminPassword = process.env.KEYCLOAK_ADMIN_PASSWORD;
  if (!adminPassword) {
    throw new Error(
      "Set KEYCLOAK_ADMIN_PASSWORD (the value from infra/.env) to run the Keycloak integration tests",
    );
  }

  const adminToken = await getAdminToken(adminPassword);
  const realm = `envelope-test-${randomUUID()}`;
  const clientSecret = randomUUID();
  const username = "test-user";
  const password = randomUUID();

  await adminRequest(adminToken, "POST", "/admin/realms", {
    realm,
    enabled: true,
    sslRequired: "none",
    accessTokenLifespan: 3,
  });

  await createClientWithAudience(adminToken, realm, "envelope-api", clientSecret, MATCHING_AUDIENCE);
  await createClientWithAudience(adminToken, realm, "envelope-other", clientSecret, MISMATCHED_AUDIENCE);
  const userId = await createUser(adminToken, realm, username, password);

  return {
    issuer: `${KEYCLOAK_URL}/realms/${realm}`,
    audience: MATCHING_AUDIENCE,
    getUserToken: () => getUserAccessToken(realm, "envelope-api", clientSecret, username, password),
    getTokenWithMismatchedAudience: () => getUserAccessToken(realm, "envelope-other", clientSecret, username, password),
    updateUserEmail: async (email: string) => {
      await adminRequest(adminToken, "PUT", `/admin/realms/${realm}/users/${userId}`, { email });
    },
    teardown: async () => {
      await adminRequest(adminToken, "DELETE", `/admin/realms/${realm}`);
    },
  };
}

async function getAdminToken(adminPassword: string): Promise<string> {
  const body = await postForm(`${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
    grant_type: "password",
    client_id: "admin-cli",
    username: "admin",
    password: adminPassword,
  });
  return body.access_token as string;
}

async function getUserAccessToken(
  realm: string,
  clientId: string,
  clientSecret: string,
  username: string,
  password: string,
): Promise<string> {
  const body = await postForm(`${KEYCLOAK_URL}/realms/${realm}/protocol/openid-connect/token`, {
    grant_type: "password",
    client_id: clientId,
    client_secret: clientSecret,
    username,
    password,
    scope: "openid",
  });
  return body.access_token as string;
}

async function postForm(url: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function adminRequest(
  adminToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const response = await fetch(`${KEYCLOAK_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} responded ${response.status}: ${await response.text()}`);
  }
  return response;
}

function createdEntityId(response: Response): string {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Keycloak did not return a Location header for the created entity");
  }
  return location.split("/").pop() ?? "";
}

async function createClientWithAudience(
  adminToken: string,
  realm: string,
  clientId: string,
  secret: string,
  audience: string,
): Promise<void> {
  const response = await adminRequest(adminToken, "POST", `/admin/realms/${realm}/clients`, {
    clientId,
    secret,
    enabled: true,
    publicClient: false,
    directAccessGrantsEnabled: true,
    standardFlowEnabled: false,
    serviceAccountsEnabled: false,
  });
  const internalId = createdEntityId(response);

  await adminRequest(adminToken, "POST", `/admin/realms/${realm}/clients/${internalId}/protocol-mappers/models`, {
    name: "audience-mapper",
    protocol: "openid-connect",
    protocolMapper: "oidc-audience-mapper",
    config: {
      "included.custom.audience": audience,
      "id.token.claim": "false",
      "access.token.claim": "true",
    },
  });
}

async function createUser(adminToken: string, realm: string, username: string, password: string): Promise<string> {
  // firstName/lastName are required: without them Keycloak's user-profile validation silently
  // adds a VERIFY_PROFILE required action at login time, which rejects the password grant with
  // "Account is not fully set up" even though the user's own requiredActions list is empty.
  const response = await adminRequest(adminToken, "POST", `/admin/realms/${realm}/users`, {
    username,
    email: `${username}@example.com`,
    firstName: "Test",
    lastName: "User",
    emailVerified: true,
    enabled: true,
    requiredActions: [],
  });
  const internalId = createdEntityId(response);

  await adminRequest(adminToken, "PUT", `/admin/realms/${realm}/users/${internalId}/reset-password`, {
    type: "password",
    value: password,
    temporary: false,
  });

  return internalId;
}
