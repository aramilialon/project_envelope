/**
 * Runs after the token verifier and user mapper preHandlers: checks the
 * local user's membership in the workspace the request names, and opens the
 * request's single database transaction with the session variables ADR
 * 0006's Row-Level Security policies read (SET LOCAL app.user_id /
 * app.workspace_id). registerWorkspaceScope's onResponse/onError hooks
 * commit or roll back that same transaction once the response is ready.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { DbClient, DbPool } from "../db/pool.ts";

declare module "fastify" {
  interface FastifyRequest {
    db?: DbClient;
    workspace?: { id: string; role: string };
  }
}

export function registerWorkspaceScope(app: FastifyInstance): void {
  app.addHook("onError", async (request) => {
    await releaseRequestTransaction(request, "ROLLBACK");
  });

  app.addHook("onResponse", async (request) => {
    await releaseRequestTransaction(request, "COMMIT");
  });
}

async function releaseRequestTransaction(request: FastifyRequest, finish: "COMMIT" | "ROLLBACK"): Promise<void> {
  const client = request.db;
  if (!client) {
    return;
  }
  delete request.db;
  try {
    await client.query(finish);
  } finally {
    client.release();
  }
}

export function createWorkspaceMembershipPreHandler(pool: DbPool) {
  return async function workspaceMembershipPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const workspaceId = extractWorkspaceId(request);
    if (!workspaceId) {
      await reply.code(400).send({ error: "workspace id required" });
      return;
    }
    if (!request.userId) {
      throw new Error("workspaceMembershipPreHandler requires request.userId to already be set");
    }

    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [request.userId]);

    const { rows } = await client.query<{ role: string }>(
      "SELECT role FROM memberships WHERE user_id = $1 AND workspace_id = $2",
      [request.userId, workspaceId],
    );
    const membership = rows[0];

    if (!membership) {
      await client.query("ROLLBACK");
      client.release();
      await reply.code(403).send({ error: "forbidden" });
      return;
    }

    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);

    request.db = client;
    request.workspace = { id: workspaceId, role: membership.role };
  };
}

function extractWorkspaceId(request: FastifyRequest): string | undefined {
  const params = request.params as Record<string, unknown> | undefined;
  const fromParams = params?.workspaceId;
  if (typeof fromParams === "string") {
    return fromParams;
  }
  const header = request.headers["x-workspace-id"];
  return typeof header === "string" ? header : undefined;
}
