import { assertDate, assertLocale, assertPriceDate, parsePriceCsv, ValidationError, type LocalDate } from "@envelope/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { recordAuditLog } from "../audit-log/repository.ts";
import { createWorkspaceMembershipPreHandler, withWriteAccess } from "../auth/workspace-membership.ts";
import type { DbPool } from "../db/pool.ts";
import { getCurrentDate } from "../days-of-buffer/repository.ts";
import { isInstrumentNotFoundViolation, sendIfValidationError, strictBody } from "../errors.ts";
import { isUuid } from "../ids.ts";
import { getInstrument } from "../instruments/repository.ts";
import { deleteWorkspacePrice, listPrices, upsertWorkspacePrices, type PriceRecord } from "../prices/repository.ts";
import { IMPORT_BODY_LIMIT_BYTES } from "./import.ts";

const PUT_KEYS: ReadonlySet<string> = new Set(["closeE6"]);

/** The locale a price file's numbers are read in when the request names none: a dot for decimals. */
const DEFAULT_CSV_LOCALE = "en";

/**
 * The range a price list covers when the request leaves `from` or `to` out: every stored date.
 * The earliest is the first `assertDate` reads (`Date.UTC` takes a year below 100 as 19xx).
 */
const EARLIEST_DATE = "0100-01-01";
const LATEST_DATE = "9999-12-31";

async function sendInstrumentNotFound(reply: FastifyReply): Promise<void> {
  await reply.code(404).send({ error: "instrument_not_found" });
}

/**
 * The instrument named in the path, when the workspace can see it: a shared one or the
 * workspace's own private one (#505). Another workspace's private instrument, an unknown or a
 * malformed id answer 404 `instrument_not_found` alike, and the route stops there (`undefined`).
 */
async function instrumentOf(request: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
  const { instrumentId } = request.params as { instrumentId: string };
  const instrument = isUuid(instrumentId) ? await getInstrument(request.db!, instrumentId) : undefined;
  if (!instrument) {
    await sendInstrumentNotFound(reply);
    return undefined;
  }
  return instrument.id;
}

/** An optional date in the query: absent is `fallback`; anything but one `YYYY-MM-DD` date is `invalid_date` naming it. */
function queryDate(query: Record<string, unknown>, field: "from" | "to", fallback: LocalDate): LocalDate {
  const value = query[field];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new ValidationError("invalid_date", `${field} must be one YYYY-MM-DD date`, { field });
  }
  try {
    assertDate(value);
  } catch {
    throw new ValidationError("invalid_date", `${field} is not a valid YYYY-MM-DD date`, { field, value });
  }
  return value;
}

/** `closeE6` of a PUT body: a non-negative safe integer, or 400 `invalid_price` naming the field. */
function closeOf(body: Record<string, unknown>): number {
  const value = body.closeE6;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError("invalid_price", "closeE6 must be a non-negative safe integer of the price × 10^6", {
      label: "closeE6",
      value: value === undefined ? null : String(value),
    });
  }
  return value;
}

/** The workspace's own price of the instrument on a date, if it has one. */
async function ownPrice(request: FastifyRequest, instrumentId: string, date: LocalDate): Promise<PriceRecord | undefined> {
  const prices = await listPrices(request.db!, request.workspace!.id, instrumentId, date, date);
  return prices.find((price) => price.origin === "own");
}

/** What the audit log keeps of one own price. */
function audited(instrumentId: string, price: PriceRecord): Record<string, unknown> {
  return { instrumentId, priceDate: price.priceDate, closeE6: price.closeE6, source: price.source };
}

/**
 * A workspace's own closing prices of an instrument (#83, ADR 0019), for instruments without
 * automatic quotes: typed one at a time, or imported from a CSV file of `date,close` rows. Each
 * is the workspace's own (`origin: "own"`): never seen by another workspace, and never changes a
 * shared price, which it overrides on its own date (`resolvePrice` in @envelope/core).
 *
 * - `GET .../prices?from=&to=`: own and shared prices, each with its `origin`; any member.
 * - `PUT .../prices/:date` `{ closeE6 }`: sets the own price of that date; 201 when it is new,
 *   200 when it replaced one or was already that close.
 * - `DELETE .../prices/:date`: removes the own price of that date (204); a date with no own price,
 *   even one with a shared price, is 404 `price_not_found`.
 * - `POST .../prices/import?locale=` with a `text/csv` body: sets every row's own price at once,
 *   or none of them; counts toward the per-user import limit.
 *
 * Writes are for owners and editors (403 for `read_only`). The instrument must be shared or the
 * workspace's own private one; anything else is 404 `instrument_not_found`. A price is dated
 * today or earlier in the workspace's time zone (#715). Each PUT or DELETE that changes a row
 * writes one audit log entry, and each import that changes any row one summary entry. Prices are
 * not a sync entity yet (ADR 0019).
 */
export function registerPricesRoutes(app: FastifyInstance, pool: DbPool): void {
  const preHandler = createWorkspaceMembershipPreHandler(pool);
  const writePreHandler = withWriteAccess(preHandler);
  const base = "/workspaces/:workspaceId/instruments/:instrumentId/prices";

  // Scoped so that only the import below reads a `text/csv` body; every other route keeps refusing one (415).
  void app.register(async (scope) => {
    scope.addContentTypeParser("text/csv", { parseAs: "string", bodyLimit: IMPORT_BODY_LIMIT_BYTES }, (_request, body, done) => {
      done(null, body);
    });

    scope.get(base, { preHandler }, async (request, reply) => {
      const instrumentId = await instrumentOf(request, reply);
      if (instrumentId === undefined) return;
      const query = (request.query ?? {}) as Record<string, unknown>;
      try {
        const from = queryDate(query, "from", EARLIEST_DATE);
        const to = queryDate(query, "to", LATEST_DATE);
        const prices = await listPrices(request.db!, request.workspace!.id, instrumentId, from, to);
        return { prices };
      } catch (error) {
        if (await sendIfValidationError(reply, error)) return;
        throw error;
      }
    });

    scope.put(`${base}/:date`, { preHandler: writePreHandler }, async (request, reply) => {
      const instrumentId = await instrumentOf(request, reply);
      if (instrumentId === undefined) return;
      const { date } = request.params as { date: string };
      const workspaceId = request.workspace!.id;
      try {
        assertPriceDate(date, await getCurrentDate(request.db!, workspaceId));
        const closeE6 = closeOf(strictBody(request.body, PUT_KEYS));
        const before = await ownPrice(request, instrumentId, date);
        const result = await upsertWorkspacePrices(
          request.db!,
          workspaceId,
          instrumentId,
          [{ priceDate: date, closeE6 }],
          "manual",
          request.userId ?? null,
        );
        const after = await ownPrice(request, instrumentId, date);
        if (!after) {
          throw new Error("registerPricesRoutes: the price just written is not there");
        }
        if (result.inserted + result.replaced > 0) {
          await recordAuditLog(request.db!, {
            workspaceId,
            userId: request.userId ?? null,
            action: result.inserted > 0 ? "price.create" : "price.update",
            before: before ? audited(instrumentId, before) : null,
            after: audited(instrumentId, after),
          });
        }
        await reply.code(result.inserted > 0 ? 201 : 200).send(after);
      } catch (error) {
        if (isInstrumentNotFoundViolation(error)) {
          await sendInstrumentNotFound(reply);
          return;
        }
        if (await sendIfValidationError(reply, error)) return;
        throw error;
      }
    });

    scope.delete(`${base}/:date`, { preHandler: writePreHandler }, async (request, reply) => {
      const instrumentId = await instrumentOf(request, reply);
      if (instrumentId === undefined) return;
      const { date } = request.params as { date: string };
      const workspaceId = request.workspace!.id;
      try {
        assertDate(date);
        const before = await ownPrice(request, instrumentId, date);
        if (!before || !(await deleteWorkspacePrice(request.db!, workspaceId, instrumentId, date))) {
          await reply.code(404).send({ error: "price_not_found" });
          return;
        }
        await recordAuditLog(request.db!, {
          workspaceId,
          userId: request.userId ?? null,
          action: "price.delete",
          before: audited(instrumentId, before),
          after: null,
        });
        await reply.code(204).send();
      } catch (error) {
        if (await sendIfValidationError(reply, error)) return;
        throw error;
      }
    });

    scope.post(`${base}/import`, { preHandler: writePreHandler, bodyLimit: IMPORT_BODY_LIMIT_BYTES }, async (request, reply) => {
      const instrumentId = await instrumentOf(request, reply);
      if (instrumentId === undefined) return;
      // Only `text/csv`: Fastify would also hand over a `text/plain` body as a string.
      const mediaType = (request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (mediaType !== "text/csv" || typeof request.body !== "string") {
        await reply.code(415).send({ error: "unsupported_media_type" });
        return;
      }
      const { locale } = (request.query ?? {}) as { locale?: unknown };
      const workspaceId = request.workspace!.id;
      try {
        if (locale !== undefined && typeof locale !== "string") {
          throw new ValidationError("invalid_locale", "locale must be one locale tag", { value: null });
        }
        const csvLocale = locale ?? DEFAULT_CSV_LOCALE;
        assertLocale(csvLocale);
        const rows = parsePriceCsv(request.body, { locale: csvLocale, today: await getCurrentDate(request.db!, workspaceId) });
        const result = await upsertWorkspacePrices(request.db!, workspaceId, instrumentId, rows, "csv", request.userId ?? null);
        const dates = rows.map((row) => row.priceDate).sort();
        const summary = { ...result, from: dates[0]!, to: dates[dates.length - 1]! };
        if (result.inserted + result.replaced > 0) {
          await recordAuditLog(request.db!, {
            workspaceId,
            userId: request.userId ?? null,
            action: "price.import",
            before: null,
            after: { instrumentId, rows: rows.length, ...summary },
          });
        }
        return summary;
      } catch (error) {
        if (isInstrumentNotFoundViolation(error)) {
          await sendInstrumentNotFound(reply);
          return;
        }
        if (await sendIfValidationError(reply, error)) return;
        throw error;
      }
    });
  });
}
