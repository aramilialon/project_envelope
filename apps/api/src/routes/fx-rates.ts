import { assertDate, assertKnownCurrency, FX_BASE_CURRENCY, ValidationError } from "@envelope/core";
import type { FastifyInstance } from "fastify";

import type { DbPool } from "../db/pool.ts";
import { sendIfValidationError } from "../errors.ts";
import { listFxRates } from "../market-data/fx-rates-repository.ts";

/** An optional date query parameter: absent or empty is no bound; anything else must be a calendar date. */
function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === "") return null;
  if (typeof value === "string") {
    try {
      assertDate(value);
      return value;
    } catch {
      // answered below, naming the field
    }
  }
  throw new ValidationError("invalid_date", `${field} must be a YYYY-MM-DD date`, { field, value: String(value) });
}

/**
 * `GET /fx-rates?quote=USD&from=YYYY-MM-DD&to=YYYY-MM-DD` (#85): the stored euro reference rates
 * of one currency, oldest first, each as published (`rateE10`: units of the currency for one euro
 * × 10^10, ADR 0019). Any signed-in user, with no workspace membership: rates are public data,
 * the same for every workspace (the global auth/user-mapper preHandlers still protect it). Only
 * what is stored is returned; a request never fetches anything.
 *
 * Refusals: 400 `invalid_currency` (`details.currency`) for a `quote` that is missing, not a
 * currency code in use, or the euro itself; 400 `invalid_date` (`details.field`) for a `from` or
 * `to` that is not a calendar date, or a `to` before `from`.
 */
export function registerFxRatesRoutes(app: FastifyInstance, pool: DbPool): void {
  app.get("/fx-rates", async (request, reply) => {
    const { quote, from, to } = request.query as { quote?: unknown; from?: unknown; to?: unknown };
    try {
      const currency = typeof quote === "string" ? quote : "";
      assertKnownCurrency(currency);
      if (currency === FX_BASE_CURRENCY) {
        throw new ValidationError("invalid_currency", `rates are quoted against ${FX_BASE_CURRENCY}, not for it`, { currency });
      }
      const fromDate = optionalDate(from, "from");
      const toDate = optionalDate(to, "to");
      if (fromDate !== null && toDate !== null && toDate < fromDate) {
        throw new ValidationError("invalid_date", "to is before from", { field: "to", value: toDate });
      }
      const rates = await listFxRates(pool, currency, fromDate, toDate);
      return { base: FX_BASE_CURRENCY, quote: currency, rates };
    } catch (error) {
      if (await sendIfValidationError(reply, error)) return;
      throw error;
    }
  });
}
