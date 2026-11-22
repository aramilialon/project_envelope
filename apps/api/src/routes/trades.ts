import { assertTextLength, MAX_FREE_TEXT_LENGTH, ValidationError } from "@envelope/core";
import type { FastifyInstance, FastifyReply } from "fastify";

import { createWorkspaceMembershipPreHandler, withWriteAccess } from "../auth/workspace-membership.ts";
import type { DbPool } from "../db/pool.ts";
import { invalidField, sendIfValidationError, strictBody } from "../errors.ts";
import {
  createTrades,
  deleteTrade,
  listTrades,
  TAX_KINDS,
  TRADE_REQUEST_FIELDS,
  TRADE_TYPES,
  ConcurrentTradeChangeError,
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

/**
 * Every field a create request may carry, whatever its type: anything else is a 400
 * `unknown_field`, so a misspelt field is never silently dropped. Which of them a type takes is
 * `TRADE_REQUEST_FIELDS`'s to say (#594). `costBasisCents` belongs to a transfer's leg: at the top
 * level it is a field of another kind of request (`invalid_trade`), as it was before #594.
 */
const CREATE_KEYS: ReadonlySet<string> = new Set(["type", "costBasisCents", ...Object.values(TRADE_REQUEST_FIELDS).flat()]);
const CREATE_LEG_KEYS: ReadonlySet<string> = new Set(["id", "accountId", "portfolioId", "feesCents", "costBasisCents"]);

/** The fields an edit may carry: those of a create request but `id`; which a trade's type takes is the repository's to say. */
const PATCH_KEYS: ReadonlySet<string> = new Set([...CREATE_KEYS].filter((key) => key !== "id"));
const LEG_PATCH_KEYS: ReadonlySet<string> = new Set(["accountId", "portfolioId", "feesCents", "costBasisCents"]);

/**
 * The fields a create request of each type cannot do without (#600), in the order a missing one is
 * named. A transfer also needs a `from` leg, a `to` leg or both, each with its account and portfolio.
 */
const REQUIRED_FIELDS: Readonly<Record<TradeType, readonly string[]>> = {
  buy: ["tradeDate", "accountId", "portfolioId", "instrumentId", "quantityE8", "priceE6"],
  sell: ["tradeDate", "accountId", "portfolioId", "instrumentId", "quantityE8", "priceE6"],
  dividend: ["tradeDate", "accountId", "portfolioId", "instrumentId", "grossCents"],
  fee: ["tradeDate", "accountId", "portfolioId", "feesCents"],
  tax: ["tradeDate", "accountId", "portfolioId", "taxKind", "grossCents"],
  transfer: ["tradeDate", "instrumentId", "quantityE8"],
  split: ["tradeDate", "instrumentId", "splitFrom", "splitTo"],
};

/** A field the request needs and does not have (#600): a 400 `invalid_trade` naming it. */
function missingField(field: string): ValidationError {
  return new ValidationError("invalid_trade", `${field} is required`, { field });
}

/** Whether a field is absent: left out, or `null`, which a create reads as left out. */
function absent(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * A UUID field, or undefined when absent.
 *
 * @throws ValidationError "invalid_field" (details: field, `where` + its name) for anything but a UUID.
 */
function uuidField(body: Record<string, unknown>, field: string, where = ""): string | undefined {
  const value = body[field];
  if (absent(value)) return undefined;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw invalidField(`${where}${field}`);
  return value.toLowerCase();
}

/**
 * A string field, or undefined when absent.
 *
 * @throws ValidationError "invalid_field" for anything but a string.
 */
function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (absent(value)) return undefined;
  if (typeof value !== "string") throw invalidField(field);
  return value;
}

/**
 * `taxKind`, or undefined when absent.
 *
 * @throws ValidationError "invalid_field" for anything but one of `TAX_KINDS`.
 */
function taxKindField(body: Record<string, unknown>): TaxKind | undefined {
  const value = body.taxKind;
  if (absent(value)) return undefined;
  if (typeof value !== "string" || !TAX_KINDS.includes(value as TaxKind)) throw invalidField("taxKind");
  return value as TaxKind;
}

/**
 * The amounts present in `body`, each a JSON number; whether it is a safe integer, and in range,
 * is `@envelope/core`'s to say (with a stable code).
 *
 * @throws ValidationError "invalid_field" for an amount that is not a JSON number.
 */
function amountFields(body: Record<string, unknown>, where = ""): TradeAmountsInput {
  const amounts: Record<string, number> = {};
  for (const field of AMOUNT_FIELDS) {
    const value = body[field];
    if (absent(value)) continue;
    if (typeof value !== "number") throw invalidField(`${where}${field}`);
    amounts[field] = value;
  }
  return amounts as TradeAmountsInput;
}

/**
 * A transfer leg's object, or undefined when absent.
 *
 * @throws ValidationError "invalid_field" (`from` or `to`) for anything but a JSON object, and
 *   "unknown_field" (`from.fees`) for a key a leg does not have.
 */
function legObject(body: Record<string, unknown>, field: "from" | "to", known: ReadonlySet<string>): Record<string, unknown> | undefined {
  const raw = body[field];
  if (absent(raw)) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalidField(field);
  return strictBody(raw, known, `${field}.`);
}

/** The memo's length (#507): 400 `text_too_long`, checked with the rest of the body's shape. */
function checkMemo(memo: string | null | undefined): void {
  if (typeof memo === "string") assertTextLength(memo, MAX_FREE_TEXT_LENGTH, "memo");
}

/** A transfer leg of a create request, its fields read and its account and portfolio required. */
function legInput(leg: Record<string, unknown>, field: "from" | "to"): TransferLegInput {
  const where = `${field}.`;
  const id = uuidField(leg, "id", where);
  const accountId = uuidField(leg, "accountId", where);
  const portfolioId = uuidField(leg, "portfolioId", where);
  // costBasisCents is accepted on either leg so the core can name it when it is misplaced.
  const { feesCents, costBasisCents } = amountFields(leg, where);
  return {
    accountId: accountId!,
    portfolioId: portfolioId!,
    ...(id === undefined ? {} : { id }),
    ...(feesCents === undefined ? {} : { feesCents }),
    ...(costBasisCents === undefined ? {} : { costBasisCents }),
  };
}

/**
 * Reads a create request: one trade, a transfer (its legs in `from` and `to`) or a split. The
 * checks run in the order the domain expert ruled (#594, #600, #662), so that the first error names
 * the field actually wrong:
 * 1. the shape: a body that is not a JSON object (`invalid_body`), a field no trade request has
 *    (`unknown_field`), a `type` that is none of them (`invalid_field`), a field of another kind of
 *    request (`invalid_trade` naming it: `from` on a buy, `accountId` on a split, `gainTaxCents` on a
 *    buy), a field of the wrong JSON type (`invalid_field`), a `memo` too long (`text_too_long`);
 * 2. the fields the type needs (`invalid_trade` naming the first one missing).
 * The quantity, the price and the amounts come next, in the repository.
 */
function parseEntry(raw: unknown): TradeEntryInput {
  const body = strictBody(raw, CREATE_KEYS);
  if (absent(body.type)) throw missingField("type");
  const type = body.type;
  if (typeof type !== "string" || !TRADE_TYPES.includes(type as TradeType)) throw invalidField("type");
  const taken = TRADE_REQUEST_FIELDS[type as TradeType];
  for (const [field, value] of Object.entries(body)) {
    if (field !== "type" && !absent(value) && !taken.includes(field)) {
      throw new ValidationError("invalid_trade", `a ${type} request does not take ${field}`, { field });
    }
  }

  const id = uuidField(body, "id");
  const accountId = uuidField(body, "accountId");
  const portfolioId = uuidField(body, "portfolioId");
  const instrumentId = uuidField(body, "instrumentId");
  const tradeDate = stringField(body, "tradeDate");
  const occurredAt = stringField(body, "occurredAt");
  const memo = stringField(body, "memo");
  const taxKind = taxKindField(body);
  const amounts = amountFields(body);
  const fromLeg = legObject(body, "from", CREATE_LEG_KEYS);
  const toLeg = legObject(body, "to", CREATE_LEG_KEYS);
  const from = fromLeg && legInput(fromLeg, "from");
  const to = toLeg && legInput(toLeg, "to");
  checkMemo(memo);

  for (const field of REQUIRED_FIELDS[type as TradeType]) {
    if (absent(body[field])) throw missingField(field);
  }
  const common = {
    tradeDate: tradeDate!,
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(memo === undefined ? {} : { memo }),
  };

  if (type === "split") {
    return { kind: "split", ...common, instrumentId: instrumentId!, splitFrom: amounts.splitFrom!, splitTo: amounts.splitTo! };
  }

  if (type === "transfer") {
    if (!fromLeg && !toLeg) {
      throw new ValidationError("invalid_trade", "a transfer needs a from leg, a to leg or both", { field: "from" });
    }
    for (const [field, leg] of [["from", fromLeg], ["to", toLeg]] as const) {
      for (const key of ["accountId", "portfolioId"]) {
        if (leg && absent(leg[key])) throw missingField(`${field}.${key}`);
      }
    }
    return {
      kind: "transfer",
      ...common,
      instrumentId: instrumentId!,
      quantityE8: amounts.quantityE8!,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    };
  }

  const entry: SingleTradeInput = {
    kind: "single",
    type: type as SingleTradeInput["type"],
    ...common,
    ...(id === undefined ? {} : { id }),
    accountId: accountId!,
    portfolioId: portfolioId!,
    instrumentId: instrumentId ?? null,
    ...amounts,
    ...(taxKind === undefined ? {} : { taxKind }),
  };
  return entry;
}

/** A field an edit may clear: absent is undefined, `null` is null. */
function clearable<T>(body: Record<string, unknown>, field: string, read: (body: Record<string, unknown>, field: string) => T | undefined): T | null | undefined {
  return body[field] === null ? null : read(body, field);
}

/** A transfer leg of an edit, every field optional. */
function legPatch(body: Record<string, unknown>, field: "from" | "to"): TransferLegPatch | undefined {
  const leg = legObject(body, field, LEG_PATCH_KEYS);
  if (!leg) return undefined;
  const where = `${field}.`;
  const accountId = uuidField(leg, "accountId", where);
  const portfolioId = uuidField(leg, "portfolioId", where);
  const { feesCents, costBasisCents } = amountFields(leg, where);
  return {
    ...(accountId === undefined ? {} : { accountId }),
    ...(portfolioId === undefined ? {} : { portfolioId }),
    ...(feesCents === undefined ? {} : { feesCents }),
    ...(costBasisCents === undefined ? {} : { costBasisCents }),
  };
}

/**
 * Reads an edit: any field of a create request but `id` (`unknown_field`, as any field no request
 * has); `null` clears `occurredAt`, `memo` and `instrumentId`. A field of the wrong JSON type is
 * `invalid_field`, a `memo` too long `text_too_long`, and an edit that changes nothing (`{}`,
 * `type` alone, or only `null` legs) `invalid_body`, so it writes no audit log entry. Which fields
 * the trade's type takes is the repository's to check (`invalid_trade`), once it has the trade.
 */
function parsePatch(raw: unknown): TradePatchInput {
  const body = strictBody(raw, PATCH_KEYS);
  const type = stringField(body, "type");
  const taxKind = taxKindField(body);
  const accountId = uuidField(body, "accountId");
  const portfolioId = uuidField(body, "portfolioId");
  const instrumentId = clearable(body, "instrumentId", uuidField);
  const tradeDate = stringField(body, "tradeDate");
  const occurredAt = clearable(body, "occurredAt", stringField);
  const memo = clearable(body, "memo", stringField);
  const amounts = amountFields(body);
  const from = legPatch(body, "from");
  const to = legPatch(body, "to");
  checkMemo(memo);
  const patch: TradePatchInput = {
    ...amounts,
    ...(type === undefined ? {} : { type }),
    ...(taxKind === undefined ? {} : { taxKind }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(portfolioId === undefined ? {} : { portfolioId }),
    ...(instrumentId === undefined ? {} : { instrumentId }),
    ...(tradeDate === undefined ? {} : { tradeDate }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(memo === undefined ? {} : { memo }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
  // An edit that changes nothing (`{}`, or only `null` legs) is refused, so it writes no audit log
  // entry. `type` alone is checked against the trade's own (#596): `invalid_trade` when it differs,
  // `invalid_body` when it is the same (`updateTrade` answers "nothing_to_change").
  if (Object.keys(patch).length === 0) {
    throw new ValidationError("invalid_body", "the edit changes nothing");
  }
  return patch;
}

async function sendConcurrentChange(reply: FastifyReply): Promise<void> {
  await reply.code(409).send({ error: "the trade changed while this request ran; retry it", code: "concurrent_change" });
}

async function sendReconciled(reply: FastifyReply, action: "edited" | "deleted"): Promise<void> {
  await reply.code(409).send({ error: `a trade whose cash leg is reconciled cannot be ${action}; unlock it first`, code: "reconciled" });
}

/**
 * Trades (#77, #509; ADR 0012): `GET` lists the workspace's trades in the replay order, `POST`
 * records one trade, a transfer of securities (both legs) or a split (every row it stands for),
 * `PATCH .../:tradeId` edits one and `DELETE .../:tradeId` deletes one, each with the rows that go
 * with it and their cash legs. An edit of a buy or a sell that changes `quantityE8`, `priceE6` or
 * `instrumentId` without `grossCents` computes the gross again from them, as a create does: the
 * broker's own figure must be sent again with the edit to keep it. An edit that changes a cash
 * leg's amount, account or date sends a cleared leg back to pending. Owners and editors write;
 * `read_only` members read.
 *
 * Every refusal is a stable code with its `details` (#594, #600, #662): a body the route cannot
 * read is `invalid_body`, `unknown_field`, `invalid_field` or `invalid_trade` (`parseEntry`,
 * `parsePatch`), thrown to the global error handler like `strictBody`'s own.
 */
export function registerTradesRoutes(app: FastifyInstance, pool: DbPool): void {
  const preHandler = createWorkspaceMembershipPreHandler(pool);
  const writePreHandler = withWriteAccess(preHandler);
  const base = "/workspaces/:workspaceId/trades";

  app.get(base, { preHandler }, async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    // A filter that is not a UUID is a 400 `invalid_field` naming it.
    const portfolioId = uuidField(query, "portfolioId");
    const accountId = uuidField(query, "accountId");
    const instrumentId = uuidField(query, "instrumentId");
    const trades = await listTrades(request.db!, request.workspace!.id, {
      ...(portfolioId === undefined ? {} : { portfolioId }),
      ...(accountId === undefined ? {} : { accountId }),
      ...(instrumentId === undefined ? {} : { instrumentId }),
    });
    return { trades };
  });

  app.post(base, { preHandler: writePreHandler }, async (request, reply) => {
    const entry = parseEntry(request.body);
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
    const patch = parsePatch(request.body);
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
      if (result === "nothing_to_change") {
        // `type` alone, the trade's own: the same refusal as `{}` (#594, #596).
        await sendIfValidationError(reply, new ValidationError("invalid_body", "the edit changes nothing"));
        return;
      }
      return { trades: result };
    } catch (error) {
      if (error instanceof ConcurrentTradeChangeError) {
        await sendConcurrentChange(reply);
        return;
      }
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
      if (error instanceof ConcurrentTradeChangeError) {
        await sendConcurrentChange(reply);
        return;
      }
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });
}
