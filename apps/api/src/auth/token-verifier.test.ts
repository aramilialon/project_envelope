import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import Fastify, { type FastifyInstance } from "fastify";
import { SignJWT, generateKeyPair } from "jose";

import { setUpKeycloakTestRealm, type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { createAuthPreHandler, createTokenVerifier } from "./token-verifier.ts";

if (!process.env.KEYCLOAK_ADMIN_PASSWORD) {
  throw new Error("Set KEYCLOAK_ADMIN_PASSWORD (the value from infra/.env) before running the integration tests");
}

describe("token verifier, against a real Keycloak realm", () => {
  let realm: KeycloakTestRealm;
  let app: FastifyInstance;

  before(async () => {
    realm = await setUpKeycloakTestRealm();

    const verifier = createTokenVerifier({ keycloakIssuer: realm.issuer, keycloakAudience: realm.audience });
    app = Fastify();
    app.get("/protected", { preHandler: createAuthPreHandler(verifier) }, async (request) => ({
      sub: request.auth?.sub,
    }));
  });

  after(async () => {
    await app.close();
    await realm.teardown();
  });

  it("accepts a valid token and exposes its claims on the request", async () => {
    const token = await realm.getUserToken();
    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().sub, "expected the token's sub claim to be attached to the request");
  });

  it("rejects a request with no token", async () => {
    const response = await app.inject({ method: "GET", url: "/protected" });
    assert.equal(response.statusCode, 401);
  });

  it("rejects a token with a tampered signature", async () => {
    const token = await realm.getUserToken();
    const tampered = `${token.slice(0, -4)}abcd`;
    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${tampered}` },
    });
    assert.equal(response.statusCode, 401);
  });

  it("rejects a token issued for a different audience", async () => {
    const token = await realm.getTokenWithMismatchedAudience();
    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 401);
  });

  it("rejects a token from an untrusted issuer", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("http://example.com/realms/not-envelope")
      .setAudience(realm.audience)
      .setExpirationTime("5m")
      .sign(privateKey);
    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${forged}` },
    });
    assert.equal(response.statusCode, 401);
  });

  it("rejects an expired token", async () => {
    const token = await realm.getUserToken();
    await sleep(4000); // the test realm's access tokens live 3 seconds (see test-helpers/keycloak.ts)
    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 401);
  });
});
