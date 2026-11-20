import { MAX_FREE_TEXT_LENGTH } from "@envelope/core";
import type { FastifyInstance, FastifyReply } from "fastify";

import { createWorkspaceMembershipPreHandler, withWriteAccess } from "../auth/workspace-membership.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfTextTooLong, sendIfValidationError } from "../errors.ts";
import {
  createTrades,
  deleteTrade,
  listTrades,
  TAX_KINDS,
  TRADE_TYPES,
  TradeIdTakenError,
  updateTrade,
  type SingleTradeInput,
  type TaxKind,
  type TradeAmountsInput,
  type TradeEntryInput,
  type TradePatchInput,
  type TradeType,
  type TransferLegInput,
  type TransferLegPatch,
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
  // costBasisCents is accepted on either leg so the core can name it when it is misplaced.
  const amounts = amountFields(leg, ["feesCents", "costBasisCents"]);
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

/** The fields an edit may carry; which of them a trade's type takes is the repository's to say. */
const PATCH_KEYS: ReadonlySet<string> = new Set([
  "type",
  "accountId",
  "portfolioId",
  "instrumentId",
  "tradeDate",
  "occurredAt",
  "memo",
  "taxKind",
  "from",
  "to",
  ...AMOUNT_FIELDS,
]);
const LEG_PATCH_KEYS: ReadonlySet<string> = new Set(["accountId", "portfolioId", "feesCents", "costBasisCents"]);

function rejectUnknownKeys(body: Record<string, unknown>, known: ReadonlySet<string>, where: string): void {
  for (const key of Object.keys(body)) {
    if (!known.has(key)) {
      throw new BadRequest(`${where}${key} cannot be edited`);
    }
  }
}

/** A field an edit may clear: absent is undefined, `null` is null. */
function clearable<T>(body: Record<string, unknown>, field: string, read: (body: Record<string, unknown>, field: string, required: boolean) => T | undefined): T | null | undefined {
  return body[field] === null ? null : read(body, field, false);
}

function legPatchField(body: Record<string, unknown>, field: "from" | "to"): TransferLegPatch | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new BadRequest(`${field} must be an object`);
  }
  const leg = raw as Record<string, unknown>;
  rejectUnknownKeys(leg, LEG_PATCH_KEYS, `${field}.`);
  const amounts = amountFields(leg, ["feesCents", "costBasisCents"]);
  const accountId = uuidField(leg, "accountId", false);
  const portfolioId = uuidField(leg, "portfolioId", false);
  return {
    ...(accountId === undefined ? {} : { accountId }),
    ...(portfolioId === undefined ? {} : { portfolioId }),
    ...(amounts.feesCents === undefined ? {} : { feesCents: amounts.feesCents }),
    ...(amounts.costBasisCents === undefined ? {} : { costBasisCents: amounts.costBasisCents }),
  };
}

/** Reads an edit: any field of a create request but `id`; `null` clears `occurredAt`, `memo` and `instrumentId`. */
function parsePatch(body: Record<string, unknown>): TradePatchInput {
  rejectUnknownKeys(body, PATCH_KEYS, "");
  const type = stringField(body, "type", false);
  const taxKind = stringField(body, "taxKind", false);
  if (taxKind !== undefined && !TAX_KINDS.includes(taxKind as TaxKind)) {
    throw new BadRequest(`taxKind must be one of ${TAX_KINDS.join(", ")}`);
  }
  const accountId = uuidField(body, "accountId", false);
  const portfolioId = uuidField(body, "portfolioId", false);
  const instrumentId = clearable(body, "instrumentId", uuidField);
  const tradeDate = stringField(body, "tradeDate", false);
  const occurredAt = clearable(body, "occurredAt", stringField);
  const memo = clearable(body, "memo", stringField);
  const from = legPatchField(body, "from");
  const to = legPatchField(body, "to");
  return {
    ...amountFields(body, AMOUNT_FIELDS),
    ...(type === undefined ? {} : { type }),
    ...(taxKind === undefined ? {} : { taxKind: taxKind as TaxKind }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(portfolioId === undefined ? {} : { portfolioId }),
    ...(instrumentId === undefined ? {} : { instrumentId }),
    ...(tradeDate === undefined ? {} : { tradeDate }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(memo === undefined ? {} : { memo }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

async function sendReconciled(reply: FastifyReply, action: "edited" | "deleted"): Promise<void> {
  await reply.code(409).send({ error: `a trade whose cash leg is reconciled cannot be ${action}; unlock it first`, code: "reconciled" });
}

async function sendBadRequest(reply: FastifyReply, error: BadRequest): Promise<void> {
  await reply.code(400).send({ error: `invalid trade: ${error.message}` });
}

/**
 * Trades (#77, #509; ADR 0012): `GET` lists the workspace's trades in the replay order, `POST`
 * records one trade, a transfer of securities (both legs) or a split (every row it stands for),
 * `PATCH .../:tradeId` edits one and `DELETE .../:tradeId` deletes one, each with the rows that go
 * with it and their cash legs. Owners and editors write; `read_only` members read.
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

  app.patch(`${base}/:tradeId`, { preHandler: writePreHandler }, async (request, reply) => {
    const { tradeId } = request.params as { tradeId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    let patch: TradePatchInput;
    try {
      patch = parsePatch(body);
    } catch (error) {
      if (error instanceof BadRequest) {
        await sendBadRequest(reply, error);
        return;
      }
      throw error;
    }
    if (await sendIfTextTooLong(reply, [["memo", patch.memo, MAX_FREE_TEXT_LENGTH]])) {
      return;
    }

    try {
      const result = await updateTrade(request.db!, request.workspace!.id, request.userId ?? null, tradeId, patch);
      if (result === "not_found") {
        await reply.code(404).send({ error: "trade not found" });
        return;
      }
      if (result === "reconciled") {
        await sendReconciled(reply, "edited");
        return;
      }
      return { trades: result };
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  app.delete(`${base}/:tradeId`, { preHandler: writePreHandler }, async (request, reply) => {
    const { tradeId } = request.params as { tradeId: string };
    try {
      const result = await deleteTrade(request.db!, request.workspace!.id, request.userId ?? null, tradeId);
      if (result === "not_found") {
        await reply.code(404).send({ error: "trade not found" });
        return;
      }
      if (result === "reconciled") {
        await sendReconciled(reply, "deleted");
        return;
      }
      await reply.code(204).send();
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });
}
