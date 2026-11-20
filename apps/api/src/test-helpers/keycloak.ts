/**
 * Provisions a throwaway Keycloak realm for integration tests, through the
 * admin REST API: a realm whose access tokens live a minute (long enough for a
 * slow test on a loaded machine, #519), two clients with different audiences, a
 * third client with the matching audience whose tokens live only
 * `SHORT_LIVED_TOKEN_SECONDS` (for the tests that wait for a token to expire, on
 * purpose), and one user. Nothing here is meant for anything but tests: the
 * realm is deleted in `teardown()`.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { decodeJwt } from "jose";

const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? "http://127.0.0.1:8080";
const MATCHING_AUDIENCE = "envelope-api";
const MISMATCHED_AUDIENCE = "some-other-api";
const ACCESS_TOKEN_LIFESPAN_SECONDS = 60;
/** How long a token from `getShortLivedUserToken()` lives. */
export const SHORT_LIVED_TOKEN_SECONDS = 2;

export interface KeycloakTestRealm {
  readonly issuer: string;
  readonly audience: string;
  getUserToken(): Promise<string>;
  /** A token for the same user that expires after `SHORT_LIVED_TOKEN_SECONDS`, for tests of expiry. */
  getShortLivedUserToken(): Promise<string>;
  getTokenWithMismatchedAudience(): Promise<string>;
  /** A token for a brand-new user in the same realm — for tests needing several distinct local users (e.g. #24's per-role checks). */
  getTokenForNewUser(): Promise<string>;
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
  // Unique per realm: apps/api's own users.email is UNIQUE, and every test realm otherwise
  // mapped to the same "test-user@example.com", colliding across test files and runs.
  const username = `test-user-${randomUUID()}`;
  const password = randomUUID();

  await adminRequest(adminToken, "POST", "/admin/realms", {
    realm,
    enabled: true,
    sslRequired: "none",
    accessTokenLifespan: ACCESS_TOKEN_LIFESPAN_SECONDS,
  });

  await createClientWithAudience(adminToken, realm, "envelope-api", clientSecret, MATCHING_AUDIENCE);
  await createClientWithAudience(adminToken, realm, "envelope-other", clientSecret, MISMATCHED_AUDIENCE);
  await createClientWithAudience(adminToken, realm, "envelope-api-short-lived", clientSecret, MATCHING_AUDIENCE, {
    "access.token.lifespan": String(SHORT_LIVED_TOKEN_SECONDS),
  });
  const userId = await createUser(adminToken, realm, username, password);

  return {
    issuer: `${KEYCLOAK_URL}/realms/${realm}`,
    audience: MATCHING_AUDIENCE,
    getUserToken: () => getUserAccessToken(realm, "envelope-api", clientSecret, username, password),
    getShortLivedUserToken: () => getUserAccessToken(realm, "envelope-api-short-lived", clientSecret, username, password),
    getTokenWithMismatchedAudience: () => getUserAccessToken(realm, "envelope-other", clientSecret, username, password),
    getTokenForNewUser: async () => {
      const otherUsername = `test-user-${randomUUID()}`;
      const otherPassword = randomUUID();
      await createUser(adminToken, realm, otherUsername, otherPassword);
      return getUserAccessToken(realm, "envelope-api", clientSecret, otherUsername, otherPassword);
    },
    updateUserEmail: async (email: string) => {
      await adminRequest(adminToken, "PUT", `/admin/realms/${realm}/users/${userId}`, { email });
    },
    teardown: async () => {
      await adminRequest(adminToken, "DELETE", `/admin/realms/${realm}`);
    },
  };
}

/**
 * Resolves once `token` is past its own `exp` (a second past it, since `exp` has whole-second
 * precision), so a test of expiry waits exactly as long as the token itself says, not a guess.
 */
export async function waitUntilExpired(token: string): Promise<void> {
  const { exp } = decodeJwt(token);
  if (exp === undefined) {
    throw new Error("expected the token to carry an exp claim");
  }
  const remainingMs = (exp + 1) * 1000 - Date.now();
  if (remainingMs > 0) {
    await sleep(remainingMs);
  }
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
  const response = await fetchRetryingServerErrors(url, {
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
  const response = await fetchRetryingServerErrors(`${KEYCLOAK_URL}${path}`, {
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

/**
 * Keycloak answers 500 now and then when several test runs create and delete realms at the same
 * time (#519): a realm deleted by one run can still be in the role cache another run's admin
 * request walks ("Not found in database", a NullPointerException), and the request is rolled
 * back. Such a request succeeds when sent again a moment later, so a 5xx is retried a few times
 * before it counts as a failure; any other status is returned as is.
 */
const SERVER_ERROR_ATTEMPTS = 5;

async function fetchRetryingServerErrors(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, init);
    if (response.status < 500 || attempt === SERVER_ERROR_ATTEMPTS) {
      return response;
    }
    await response.body?.cancel();
    await sleep(250 * attempt);
  }
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
  attributes: Record<string, string> = {},
): Promise<void> {
  const response = await adminRequest(adminToken, "POST", `/admin/realms/${realm}/clients`, {
    clientId,
    secret,
    enabled: true,
    publicClient: false,
    directAccessGrantsEnabled: true,
    standardFlowEnabled: false,
    serviceAccountsEnabled: false,
    attributes,
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
