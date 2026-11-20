import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";
import { SignJWT, decodeJwt, generateKeyPair } from "jose";

import {
  SHORT_LIVED_TOKEN_SECONDS,
  setUpKeycloakTestRealm,
  waitUntilExpired,
  type KeycloakTestRealm,
} from "../test-helpers/keycloak.ts";
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
    // On purpose: every other token in the test realm lives a minute (#519).
    const token = await realm.getShortLivedUserToken();
    const { iat, exp, aud } = decodeJwt(token);
    assert.equal((exp ?? 0) - (iat ?? 0), SHORT_LIVED_TOKEN_SECONDS);
    // The right audience, so expiry is the only reason left for the 401 below.
    assert.ok([aud ?? []].flat().includes(realm.audience));
    await waitUntilExpired(token);
    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 401);
  });
});
