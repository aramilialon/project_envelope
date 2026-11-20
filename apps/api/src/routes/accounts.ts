import { isTaxRegime, MAX_NAME_LENGTH, type TaxRegimeEntry } from "@envelope/core";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  ACCOUNT_TYPES,
  closeAccount,
  createAccount,
  defaultOnBudget,
  listAccounts,
  type AccountType,
} from "../accounts/repository.ts";
import { addTaxRegime, listTaxRegimes, replaceTaxRegimes, setWithholdingAgent } from "../accounts/tax-regimes.ts";
import { createWorkspaceMembershipPreHandler, withWriteAccess } from "../auth/workspace-membership.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfTextTooLong, sendIfValidationError } from "../errors.ts";

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
    if (body.onBudget !== undefined && typeof body.onBudget !== "boolean") {
      await reply.code(400).send({ error: "invalid account: onBudget must be a boolean when given" });
      return;
    }
    if (await sendIfTextTooLong(reply, [["name", name, MAX_NAME_LENGTH]])) {
      return;
    }
    if (body.taxRegime !== undefined && !isTaxRegime(body.taxRegime)) {
      await reply.code(400).send({ error: "invalid account: taxRegime must be self_declared, administered or managed when given" });
      return;
    }
    if (body.taxRegimeValidFrom !== undefined && (typeof body.taxRegimeValidFrom !== "string" || body.taxRegime === undefined)) {
      await reply.code(400).send({ error: "invalid account: taxRegimeValidFrom must be a YYYY-MM-DD date, given with taxRegime" });
      return;
    }
    if (body.domesticWithholdingAgent !== undefined && typeof body.domesticWithholdingAgent !== "boolean") {
      await reply.code(400).send({ error: "invalid account: domesticWithholdingAgent must be a boolean when given" });
      return;
    }
    const accountType = type as AccountType;
    const onBudget = body.onBudget ?? defaultOnBudget(accountType);

    try {
      const account = await createAccount(request.db!, {
        workspaceId: request.workspace!.id,
        name,
        type: accountType,
        currency,
        onBudget,
        ...(startingBalanceCents === undefined ? {} : { startingBalanceCents }),
        ...(isTaxRegime(body.taxRegime) ? { taxRegime: body.taxRegime } : {}),
        ...(typeof body.taxRegimeValidFrom === "string" ? { taxRegimeValidFrom: body.taxRegimeValidFrom } : {}),
        ...(typeof body.domesticWithholdingAgent === "boolean" ? { domesticWithholdingAgent: body.domesticWithholdingAgent } : {}),
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

  // A brokerage account's withholding-agent flag (#508): set once, while it has none.
  app.patch("/workspaces/:workspaceId/accounts/:accountId", { preHandler: writePreHandler }, async (request, reply) => {
    const accountId = await accountIdOr404(request.params, reply);
    if (!accountId) {
      return;
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.domesticWithholdingAgent !== "boolean") {
      await reply.code(400).send({ error: "invalid account change: domesticWithholdingAgent (a boolean) is required" });
      return;
    }

    try {
      const found = await setWithholdingAgent(request.db!, request.workspace!.id, accountId, body.domesticWithholdingAgent);
      if (!found) {
        await reply.code(404).send({ error: "account not found" });
        return;
      }
      return (await listAccounts(request.db!, request.workspace!.id)).find((account) => account.id === accountId);
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  // A brokerage account's tax regime history (#508): read by any member, changed by an owner or editor.
  app.get("/workspaces/:workspaceId/accounts/:accountId/tax-regimes", { preHandler }, async (request, reply) => {
    const accountId = await accountIdOr404(request.params, reply);
    if (!accountId) {
      return;
    }
    const taxRegimes = await listTaxRegimes(request.db!, request.workspace!.id, accountId);
    if (!taxRegimes) {
      await reply.code(404).send({ error: "account not found" });
      return;
    }
    return { taxRegimes };
  });

  app.post("/workspaces/:workspaceId/accounts/:accountId/tax-regimes", { preHandler: writePreHandler }, async (request, reply) => {
    const accountId = await accountIdOr404(request.params, reply);
    if (!accountId) {
      return;
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!isTaxRegime(body.regime) || (body.validFrom !== undefined && typeof body.validFrom !== "string")) {
      await reply.code(400).send({
        error: "invalid tax regime: regime (self_declared, administered or managed) is required, validFrom a YYYY-MM-DD date when given",
      });
      return;
    }

    try {
      const entry = await addTaxRegime(request.db!, request.workspace!.id, accountId, {
        regime: body.regime,
        ...(typeof body.validFrom === "string" ? { validFrom: body.validFrom } : {}),
      });
      if (!entry) {
        await reply.code(404).send({ error: "account not found" });
        return;
      }
      await reply.code(201).send(entry);
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  // Corrects the whole history at once (#508): `{ taxRegimes: [{ validFrom, regime }, ...] }`.
  app.put("/workspaces/:workspaceId/accounts/:accountId/tax-regimes", { preHandler: writePreHandler }, async (request, reply) => {
    const accountId = await accountIdOr404(request.params, reply);
    if (!accountId) {
      return;
    }
    const history = parseHistory(request.body);
    if (!history) {
      await reply.code(400).send({
        error: "invalid tax regime history: taxRegimes must be a list of { validFrom (YYYY-MM-DD), regime }",
      });
      return;
    }

    try {
      const taxRegimes = await replaceTaxRegimes(request.db!, request.workspace!.id, accountId, history);
      if (!taxRegimes) {
        await reply.code(404).send({ error: "account not found" });
        return;
      }
      return { taxRegimes };
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The route's `accountId`, or undefined after answering 404: a value that is not a UUID names no
 * account, and would otherwise reach PostgreSQL as an invalid uuid and fail with a 500.
 */
async function accountIdOr404(params: unknown, reply: FastifyReply): Promise<string | undefined> {
  const { accountId } = params as { accountId?: unknown };
  if (typeof accountId === "string" && UUID_PATTERN.test(accountId)) {
    return accountId;
  }
  await reply.code(404).send({ error: "account not found" });
  return undefined;
}

function parseHistory(body: unknown): TaxRegimeEntry[] | undefined {
  const list = (body as { taxRegimes?: unknown } | null)?.taxRegimes;
  if (!Array.isArray(list)) {
    return undefined;
  }
  const history: TaxRegimeEntry[] = [];
  for (const item of list) {
    const { validFrom, regime } = (item ?? {}) as { validFrom?: unknown; regime?: unknown };
    if (typeof validFrom !== "string" || !isTaxRegime(regime)) {
      return undefined;
    }
    history.push({ validFrom, regime });
  }
  return history;
}
