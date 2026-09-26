import type { FastifyInstance } from "fastify";

/**
 * Exists to give a real, permanently-registered route for the global auth
 * preHandlers (#10) to protect: 0.1.2 is done before the Budget API (0.1.3)
 * adds any real business route. Not yet a committed product feature, so
 * buildApp only registers it outside production (#235).
 */
export function registerMeRoute(app: FastifyInstance): void {
  app.get("/me", async (request) => {
    if (!request.userId) {
      throw new Error("registerMeRoute: request.userId was not set — is the user mapper preHandler registered?");
    }
    return { userId: request.userId };
  });
}
