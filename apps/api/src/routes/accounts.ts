import type { FastifyInstance } from "fastify";

import {
  closeAccount,
  createAccount,
  listAccounts,
  type AccountType,
} from "../accounts/repository.ts";
import { createWorkspaceMembershipPreHandler } from "../auth/workspace-membership.ts";
import type { DbPool } from "../db/pool.ts";

const ACCOUNT_TYPES: readonly AccountType[] = ["checking", "savings", "cash", "credit_card"];

export function registerAccountsRoutes(app: FastifyInstance, pool: DbPool): void {
  const preHandler = createWorkspaceMembershipPreHandler(pool);

  app.post("/workspaces/:workspaceId/accounts", { preHandler }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const type = body.type;
    const currency = typeof body.currency === "string" ? body.currency : "";
    const onBudget = body.onBudget === undefined ? true : Boolean(body.onBudget);
    const startingBalanceCents = typeof body.startingBalanceCents === "number" ? body.startingBalanceCents : undefined;

    if (!name || typeof type !== "string" || !ACCOUNT_TYPES.includes(type as AccountType) || !currency) {
      await reply.code(400).send({ error: "invalid account: name, a valid type and currency are required" });
      return;
    }

    const account = await createAccount(request.db!, {
      workspaceId: request.workspace!.id,
      name,
      type: type as AccountType,
      currency,
      onBudget,
      ...(startingBalanceCents === undefined ? {} : { startingBalanceCents }),
    });
    await reply.code(201).send(account);
  });

  app.get("/workspaces/:workspaceId/accounts", { preHandler }, async (request) => {
    const accounts = await listAccounts(request.db!, request.workspace!.id);
    return { accounts };
  });

  app.patch("/workspaces/:workspaceId/accounts/:accountId/close", { preHandler }, async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const account = await closeAccount(request.db!, request.workspace!.id, accountId);
    if (!account) {
      await reply.code(404).send({ error: "account not found, or already closed" });
      return;
    }
    return account;
  });
}
