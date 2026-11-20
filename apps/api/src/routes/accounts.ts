import type { FastifyInstance } from "fastify";

import {
  ACCOUNT_TYPES,
  closeAccount,
  createAccount,
  defaultOnBudget,
  listAccounts,
  type AccountType,
} from "../accounts/repository.ts";
import { createWorkspaceMembershipPreHandler, withWriteAccess } from "../auth/workspace-membership.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfValidationError } from "../errors.ts";

export function registerAccountsRoutes(app: FastifyInstance, pool: DbPool): void {
  const preHandler = createWorkspaceMembershipPreHandler(pool);
  const writePreHandler = withWriteAccess(preHandler);

  app.post("/workspaces/:workspaceId/accounts", { preHandler: writePreHandler }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const type = body.type;
    const currency = typeof body.currency === "string" ? body.currency : "";
    const startingBalanceCents = typeof body.startingBalanceCents === "number" ? body.startingBalanceCents : undefined;

    if (!name || typeof type !== "string" || !ACCOUNT_TYPES.includes(type as AccountType) || !currency) {
      await reply.code(400).send({ error: "invalid account: name, a valid type and currency are required" });
      return;
    }
    const accountType = type as AccountType;
    const onBudget = body.onBudget === undefined ? defaultOnBudget(accountType) : Boolean(body.onBudget);

    try {
      const account = await createAccount(request.db!, {
        workspaceId: request.workspace!.id,
        name,
        type: accountType,
        currency,
        onBudget,
        ...(startingBalanceCents === undefined ? {} : { startingBalanceCents }),
      });
      await reply.code(201).send(account);
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  app.get("/workspaces/:workspaceId/accounts", { preHandler }, async (request) => {
    const accounts = await listAccounts(request.db!, request.workspace!.id);
    return { accounts };
  });

  app.patch("/workspaces/:workspaceId/accounts/:accountId/close", { preHandler: writePreHandler }, async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const account = await closeAccount(request.db!, request.workspace!.id, accountId);
    if (!account) {
      await reply.code(404).send({ error: "account not found, or already closed" });
      return;
    }
    return account;
  });
}
