import type { FastifyInstance } from "fastify";

import type { DbPool } from "../db/pool.ts";
import { listWorkspacesForUser } from "../memberships/repository.ts";

/**
 * `GET /me/workspaces` (#50, the workspace switcher): every workspace the signed-in user
 * belongs to, with their own role in each. Registered globally like any other route (the
 * auth/user-mapper preHandlers already protect it) — unlike `/me`, this is a real, permanent
 * feature, not gated to non-production.
 */
export function registerMyWorkspacesRoute(app: FastifyInstance, pool: DbPool): void {
  app.get("/me/workspaces", async (request) => {
    if (!request.userId) {
      throw new Error("registerMyWorkspacesRoute: request.userId was not set — is the user mapper preHandler registered?");
    }
    const workspaces = await listWorkspacesForUser(pool, request.userId);
    return { workspaces };
  });
}
