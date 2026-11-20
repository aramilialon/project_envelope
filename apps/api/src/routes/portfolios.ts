import { MAX_FREE_TEXT_LENGTH, MAX_NAME_LENGTH } from "@envelope/core";
import type { FastifyInstance, FastifyReply } from "fastify";

import { createWorkspaceMembershipPreHandler, withWriteAccess } from "../auth/workspace-membership.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfTextTooLong } from "../errors.ts";
import { isUuid } from "../ids.ts";
import {
  createPortfolio,
  deletePortfolio,
  getPortfolio,
  isPortfolioNameConflict,
  isPortfolioNameTaken,
  listPortfolios,
  updatePortfolio,
  type PortfolioChanges,
} from "../portfolios/repository.ts";

/**
 * A 409's own `code`, so a client can say which conflict it was without matching on the English
 * `error` text: `name_taken` (another non-archived portfolio of the workspace already has that
 * name, ignoring case and surrounding spaces — the same code category groups and categories use,
 * #397).
 */
type PortfolioConflict = "name_taken";

/** An optional free-text purpose: a string (blank meaning none) or `null`; `undefined` when absent, `false` when invalid. */
function purposeField(body: Record<string, unknown>): string | null | undefined | false {
  if (!("purpose" in body) || body.purpose === undefined) {
    return undefined;
  }
  if (body.purpose === null) {
    return null;
  }
  if (typeof body.purpose !== "string") {
    return false;
  }
  return body.purpose.trim() || null;
}

async function sendNameTaken(reply: FastifyReply): Promise<void> {
  await reply.code(409).send({ error: "another portfolio already has this name", code: "name_taken" satisfies PortfolioConflict });
}

async function sendNotFound(reply: FastifyReply): Promise<void> {
  await reply.code(404).send({ error: "portfolio not found" });
}

export function registerPortfoliosRoutes(app: FastifyInstance, pool: DbPool): void {
  const preHandler = createWorkspaceMembershipPreHandler(pool);
  const writePreHandler = withWriteAccess(preHandler);
  const base = "/workspaces/:workspaceId/portfolios";

  app.get(base, { preHandler }, async (request) => {
    const { includeArchived } = (request.query ?? {}) as { includeArchived?: string };
    const portfolios = await listPortfolios(request.db!, request.workspace!.id, { includeArchived: includeArchived === "true" });
    return { portfolios };
  });

  app.get(`${base}/:portfolioId`, { preHandler }, async (request, reply) => {
    const { portfolioId } = request.params as { portfolioId: string };
    const portfolio = isUuid(portfolioId) ? await getPortfolio(request.db!, request.workspace!.id, portfolioId) : undefined;
    if (!portfolio) {
      await sendNotFound(reply);
      return;
    }
    return portfolio;
  });

  app.post(base, { preHandler: writePreHandler }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const purpose = purposeField(body);
    if (!name || purpose === false) {
      await reply.code(400).send({ error: "invalid portfolio: name is required, and purpose must be a string or null" });
      return;
    }
    if (await sendIfTextTooLong(reply, [["name", name, MAX_NAME_LENGTH], ["purpose", purpose, MAX_FREE_TEXT_LENGTH]])) {
      return;
    }
    if (await isPortfolioNameTaken(request.db!, request.workspace!.id, name)) {
      await sendNameTaken(reply);
      return;
    }
    try {
      const portfolio = await createPortfolio(request.db!, request.workspace!.id, name, purpose ?? null);
      await reply.code(201).send(portfolio);
    } catch (error) {
      if (isPortfolioNameConflict(error)) {
        await sendNameTaken(reply);
        return;
      }
      throw error;
    }
  });

  // Renames, changes the purpose, archives (`archived: true`) or unarchives (`archived: false`),
  // in any combination.
  app.patch(`${base}/:portfolioId`, { preHandler: writePreHandler }, async (request, reply) => {
    const { portfolioId } = request.params as { portfolioId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = body.name === undefined ? undefined : typeof body.name === "string" ? body.name.trim() : "";
    const purpose = purposeField(body);
    const archived = body.archived;
    if (
      name === "" ||
      purpose === false ||
      (archived !== undefined && typeof archived !== "boolean") ||
      (name === undefined && purpose === undefined && archived === undefined)
    ) {
      await reply.code(400).send({
        error: "invalid portfolio change: give a non-empty name, a purpose (string or null) or archived (boolean)",
      });
      return;
    }
    if (await sendIfTextTooLong(reply, [["name", name, MAX_NAME_LENGTH], ["purpose", purpose, MAX_FREE_TEXT_LENGTH]])) {
      return;
    }

    const existing = isUuid(portfolioId) ? await getPortfolio(request.db!, request.workspace!.id, portfolioId) : undefined;
    if (!existing) {
      await sendNotFound(reply);
      return;
    }

    // The name the portfolio ends up with only has to be unique if it ends up non-archived.
    const endsArchived = archived ?? existing.archivedAt !== null;
    if (!endsArchived && (await isPortfolioNameTaken(request.db!, request.workspace!.id, name ?? existing.name, portfolioId))) {
      await sendNameTaken(reply);
      return;
    }

    const changes: PortfolioChanges = {
      ...(name === undefined ? {} : { name }),
      ...(purpose === undefined ? {} : { purpose }),
      ...(archived === undefined ? {} : { archived }),
    };
    try {
      return await updatePortfolio(request.db!, request.workspace!.id, portfolioId, changes);
    } catch (error) {
      if (isPortfolioNameConflict(error)) {
        await sendNameTaken(reply);
        return;
      }
      throw error;
    }
  });

  // No trades table exists yet (#77), so nothing can refer to a portfolio and deleting one always
  // succeeds. Once trades exist, their foreign key is ON DELETE RESTRICT and this route will answer
  // 409 `portfolio_has_trades` for a portfolio that still has any.
  app.delete(`${base}/:portfolioId`, { preHandler: writePreHandler }, async (request, reply) => {
    const { portfolioId } = request.params as { portfolioId: string };
    const removed = isUuid(portfolioId) && (await deletePortfolio(request.db!, request.workspace!.id, portfolioId));
    if (!removed) {
      await sendNotFound(reply);
      return;
    }
    await reply.code(204).send();
  });
}
