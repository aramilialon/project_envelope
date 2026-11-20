import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_KEYCLOAK_TARGET, keycloakTargetFromEnv } from "./keycloak.ts";

test("keycloakTargetFromEnv falls back to the shared realm and the Vite dev server", () => {
  assert.deepEqual(keycloakTargetFromEnv({}), DEFAULT_KEYCLOAK_TARGET);
  assert.deepEqual(keycloakTargetFromEnv({}), { realm: "envelope", redirectUri: "http://localhost:5173" });
});

test("keycloakTargetFromEnv takes a disposable environment's realm and web origin", () => {
  assert.deepEqual(keycloakTargetFromEnv({ KEYCLOAK_REALM: "envelope-explore-0a1b2c3d", WEB_URL: "http://127.0.0.1:41841" }), {
    realm: "envelope-explore-0a1b2c3d",
    redirectUri: "http://127.0.0.1:41841",
  });
});

test("keycloakTargetFromEnv refuses a realm that is neither envelope nor a disposable one", () => {
  for (const realm of ["master", "keycloak", "other", "envelope-explore-", "envelope-explore-XYZ", "envelope-explore-0a1b2c3d/x"]) {
    assert.throws(() => keycloakTargetFromEnv({ KEYCLOAK_REALM: realm }), /Refusing to touch realm/, realm);
  }
});
