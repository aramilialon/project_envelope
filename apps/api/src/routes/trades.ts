import { MAX_FREE_TEXT_LENGTH } from "@envelope/core";
import type { FastifyInstance, FastifyReply } from "fastify";

import { createWorkspaceMembershipPreHandler, withWriteAccess } from "../auth/workspace-membership.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfTextTooLong, sendIfValidationError } from "../errors.ts";
import {
  createTrades,
  listTrades,
  TAX_KINDS,
  TRADE_TYPES,
  TradeIdTakenError,
  type SingleTradeInput,
  type TaxKind,
  type TradeAmountsInput,
  type TradeEntryInput,
  type TradeType,
  type TransferLegInput,
} from "../trades/repository.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The integer fields of a trade body, each a JSON number when present. */
const AMOUNT_FIELDS = [
  "quantityE8",
  "priceE6",
  "grossCents",
  "feesCents",
  "transactionTaxCents",
  "accruedInterestCents",
  "withholdingForeignCents",
  "withholdingDomesticCents",
  "gainTaxCents",
  "costBasisCents",
  "splitFrom",
  "splitTo",
] as const;

/** A request body that cannot be read as a trade: answered with a plain 400, like other routes. */
class BadRequest extends Error {}

function uuidField(body: Record<string, unknown>, field: string, required: boolean): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    if (required) throw new BadRequest(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new BadRequest(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function stringField(body: Record<string, unknown>, field: string, required: boolean): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    if (required) throw new BadRequest(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") {
    throw new BadRequest(`${field} must be a string`);
  }
  return value;
}

/**
 * The amounts present in `body`. Each must be a JSON number; whether it is a safe integer, and
 * whether the type uses it, is `@envelope/core`'s to say (with a stable code).
 */
function amountFields(body: Record<string, unknown>, allowed: readonly (typeof AMOUNT_FIELDS)[number][]): TradeAmountsInput {
  const amounts: Record<string, number> = {};
  for (const field of AMOUNT_FIELDS) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (!allowed.includes(field)) {
      throw new BadRequest(`${field} is not part of this kind of request`);
    }
    if (typeof value !== "number") {
      throw new BadRequest(`${field} must be a number`);
    }
    amounts[field] = value;
  }
  return amounts as TradeAmountsInput;
}

function commonFields(body: Record<string, unknown>): { tradeDate: string; occurredAt?: string; memo?: string } {
  const tradeDate = stringField(body, "tradeDate", true)!;
  const occurredAt = stringField(body, "occurredAt", false);
  const memo = stringField(body, "memo", false);
  return { tradeDate, ...(occurredAt === undefined ? {} : { occurredAt }), ...(memo === undefined ? {} : { memo }) };
}

function legField(body: Record<string, unknown>, field: "from" | "to"): TransferLegInput | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new BadRequest(`${field} must be an object`);
  }
  const leg = raw as Record<string, unknown>;
  const amounts = amountFields(leg, field === "to" ? ["feesCents", "costBasisCents"] : ["feesCents", "costBasisCents"]);
  const id = uuidField(leg, "id", false);
  return {
    accountId: uuidField(leg, "accountId", true)!,
    portfolioId: uuidField(leg, "portfolioId", true)!,
    ...(id === undefined ? {} : { id }),
    ...(amounts.feesCents === undefined ? {} : { feesCents: amounts.feesCents }),
    ...(amounts.costBasisCents === undefined ? {} : { costBasisCents: amounts.costBasisCents }),
  };
}

/** Reads a create request: one trade, a transfer (its legs in `from` and `to`) or a split. */
function parseEntry(body: Record<string, unknown>): TradeEntryInput {
  const type = body.type;
  if (typeof type !== "string" || !TRADE_TYPES.includes(type as TradeType)) {
    throw new BadRequest(`type must be one of ${TRADE_TYPES.join(", ")}`);
  }
  const common = commonFields(body);

  if (type === "split") {
    const { splitFrom, splitTo } = amountFields(body, ["splitFrom", "splitTo"]);
    if (splitFrom === undefined || splitTo === undefined) {
      throw new BadRequest("a split needs splitFrom and splitTo");
    }
    return { kind: "split", ...common, instrumentId: uuidField(body, "instrumentId", true)!, splitFrom, splitTo };
  }

  if (type === "transfer") {
    // A transfer's fees and cost belong to its legs; its quantity is the units moved.
    const { quantityE8 } = amountFields(body, ["quantityE8"]);
    if (quantityE8 === undefined) {
      throw new BadRequest("a transfer needs quantityE8, the units moved");
    }
    const from = legField(body, "from");
    const to = legField(body, "to");
    if (!from && !to) {
      throw new BadRequest("a transfer needs a from leg, a to leg or both");
    }
    return {
      kind: "transfer",
      ...common,
      instrumentId: uuidField(body, "instrumentId", true)!,
      quantityE8,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    };
  }

  const taxKind = stringField(body, "taxKind", false);
  if (taxKind !== undefined && !TAX_KINDS.includes(taxKind as TaxKind)) {
    throw new BadRequest(`taxKind must be one of ${TAX_KINDS.join(", ")}`);
  }
  const id = uuidField(body, "id", false);
  const instrumentId = uuidField(body, "instrumentId", type !== "fee" && type !== "tax");
  const entry: SingleTradeInput = {
    kind: "single",
    type: type as SingleTradeInput["type"],
    ...common,
    ...(id === undefined ? {} : { id }),
    accountId: uuidField(body, "accountId", true)!,
    portfolioId: uuidField(body, "portfolioId", true)!,
    instrumentId: instrumentId ?? null,
    ...amountFields(body, AMOUNT_FIELDS),
    ...(taxKind === undefined ? {} : { taxKind: taxKind as TaxKind }),
  };
  return entry;
}

async function sendBadRequest(reply: FastifyReply, error: BadRequest): Promise<void> {
  await reply.code(400).send({ error: `invalid trade: ${error.message}` });
}

/**
 * Trades (#77; ADR 0012): `GET` lists the workspace's trades in the replay order, `POST` records
 * one trade, a transfer of securities (both legs) or a split (every row it stands for). Owners and
 * editors write; `read_only` members read.
 */
export function registerTradesRoutes(app: FastifyInstance, pool: DbPool): void {
  const preHandler = createWorkspaceMembershipPreHandler(pool);
  const writePreHandler = withWriteAccess(preHandler);
  const base = "/workspaces/:workspaceId/trades";

  app.get(base, { preHandler }, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    try {
      const portfolioId = uuidField(query, "portfolioId", false);
      const accountId = uuidField(query, "accountId", false);
      const instrumentId = uuidField(query, "instrumentId", false);
      const trades = await listTrades(request.db!, request.workspace!.id, {
        ...(portfolioId === undefined ? {} : { portfolioId }),
        ...(accountId === undefined ? {} : { accountId }),
        ...(instrumentId === undefined ? {} : { instrumentId }),
      });
      return { trades };
    } catch (error) {
      if (error instanceof BadRequest) {
        await reply.code(400).send({ error: `invalid filter: ${error.message}` });
        return;
      }
      throw error;
    }
  });

  app.post(base, { preHandler: writePreHandler }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    let entry: TradeEntryInput;
    try {
      entry = parseEntry(body);
    } catch (error) {
      if (error instanceof BadRequest) {
        await sendBadRequest(reply, error);
        return;
      }
      throw error;
    }
    if (await sendIfTextTooLong(reply, [["memo", entry.memo, MAX_FREE_TEXT_LENGTH]])) {
      return;
    }

    try {
      const trades = await createTrades(request.db!, request.workspace!.id, request.userId ?? null, entry);
      await reply.code(201).send({ trades });
    } catch (error) {
      if (error instanceof TradeIdTakenError) {
        await reply.code(409).send({ error: "a trade with this id already exists", code: "id_taken", details: { tradeId: error.tradeId } });
        return;
      }
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });
}
