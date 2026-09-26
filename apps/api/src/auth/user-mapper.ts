/**
 * Runs after the token verifier preHandler: turns the token's sub/email
 * claims into a local `users` row (creating it on first sign-in, keeping the
 * email in sync afterwards) and attaches its id to the request.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

import type { DbPool } from "../db/pool.ts";
import { upsertUserFromClaims } from "../users/repository.ts";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

export function createUserMapperPreHandler(pool: DbPool) {
  return async function userMapperPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const claims = request.auth;
    const keycloakSubject = claims?.sub;
    const email = typeof claims?.email === "string" ? claims.email : undefined;

    if (!keycloakSubject || !email) {
      request.log.warn("Token verified but missing the sub or email claim");
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const user = await upsertUserFromClaims(pool, { keycloakSubject, email });
    request.userId = user.id;
  };
}
