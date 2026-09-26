import type { FastifyInstance } from "fastify";

import type { DbPool } from "../db/pool.ts";

export function registerHealthRoute(app: FastifyInstance, pool: DbPool): void {
  app.get("/health", async (_request, reply) => {
    try {
      await pool.query("SELECT 1");
    } catch (error) {
      app.log.error(error, "Health check failed: database unreachable");
      return reply.code(503).send({ status: "error", database: "unreachable" });
    }
    return reply.send({ status: "ok", database: "connected" });
  });
}
