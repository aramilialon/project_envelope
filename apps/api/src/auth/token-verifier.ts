/**
 * Verifies Keycloak access tokens: signature against the realm's JWKS, issuer,
 * audience and expiry. `jose`'s `createRemoteJWKSet` caches the keys and only
 * refetches them when a token names a key id it hasn't seen yet, so the JWKS
 * endpoint is not hit on every request.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { Config } from "../config.ts";

export class UnauthorizedError extends Error {
  constructor(reason: string) {
    super(`Unauthorized: ${reason}`);
    this.name = "UnauthorizedError";
  }
}

export interface TokenVerifier {
  verify(authorizationHeader: string | undefined): Promise<JWTPayload>;
}

export function createTokenVerifier(config: Pick<Config, "keycloakIssuer" | "keycloakAudience">): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL(`${config.keycloakIssuer}/protocol/openid-connect/certs`));

  return {
    async verify(authorizationHeader: string | undefined): Promise<JWTPayload> {
      const token = extractBearerToken(authorizationHeader);
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: config.keycloakIssuer,
          audience: config.keycloakAudience,
        });
        return payload;
      } catch (error) {
        throw new UnauthorizedError(error instanceof Error ? error.message : "token verification failed");
      }
    },
  };
}

function extractBearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader) {
    throw new UnauthorizedError("missing Authorization header");
  }
  const [scheme, token] = authorizationHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    throw new UnauthorizedError("Authorization header is not a Bearer token");
  }
  return token;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: JWTPayload;
  }
}

export function createAuthPreHandler(verifier: TokenVerifier) {
  return async function authPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      request.auth = await verifier.verify(request.headers.authorization);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unauthorized";
      request.log.info({ reason }, "Rejected request: invalid or missing access token");
      await reply.code(401).send({ error: "unauthorized" });
    }
  };
}
