import { normalizeInstrument, parseInstrumentSearch } from "@envelope/core";
import type { FastifyInstance } from "fastify";

import type { DbPool } from "../db/pool.ts";
import { sendIfValidationError } from "../errors.ts";
import { createInstrument, getInstrument, InstrumentConflictError, searchInstruments } from "../instruments/repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optionalString(body: Record<string, unknown>, field: string): string | null | undefined {
  const value = body[field];
  return typeof value === "string" || value === null ? value : undefined;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === "string" ? value : "";
}

/**
 * The shared instruments catalog (#76): any signed-in user can add an instrument and find one,
 * with no workspace membership, since the catalog belongs to no workspace (the global
 * auth/user-mapper preHandlers still protect every route here). There is deliberately no update
 * or delete endpoint — other workspaces may already reference an instrument — and no endpoint
 * that lists the whole catalog, which would show one workspace what the others hold.
 */
export function registerInstrumentsRoutes(app: FastifyInstance, pool: DbPool): void {
  app.post("/instruments", async (request, reply) => {
    if (!request.userId) {
      throw new Error("registerInstrumentsRoutes: request.userId was not set — is the user mapper preHandler registered?");
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const instrument = normalizeInstrument({
        isin: optionalString(body, "isin"),
        ticker: optionalString(body, "ticker"),
        exchange: optionalString(body, "exchange"),
        name: requiredString(body, "name"),
        type: requiredString(body, "type"),
        currency: requiredString(body, "currency"),
        assetClass: optionalString(body, "assetClass"),
        priceFactorE6: body.priceFactorE6,
      });
      const created = await createInstrument(pool, request.userId, instrument);
      await reply.code(201).send(created);
    } catch (error) {
      if (error instanceof InstrumentConflictError) {
        await reply.code(409).send({ error: "this listing is already in the catalog", code: error.code });
        return;
      }
      if (await sendIfValidationError(reply, error)) return;
      throw error;
    }
  });

  app.get("/instruments", async (request, reply) => {
    const { q } = request.query as { q?: unknown };
    try {
      const search = parseInstrumentSearch(typeof q === "string" ? q : "");
      const instruments = await searchInstruments(pool, search);
      return { instruments };
    } catch (error) {
      if (await sendIfValidationError(reply, error)) return;
      throw error;
    }
  });

  app.get("/instruments/:instrumentId", async (request, reply) => {
    const { instrumentId } = request.params as { instrumentId: string };
    const instrument = UUID.test(instrumentId) ? await getInstrument(pool, instrumentId) : undefined;
    if (!instrument) {
      await reply.code(404).send({ error: "instrument not found" });
      return;
    }
    return instrument;
  });
}
