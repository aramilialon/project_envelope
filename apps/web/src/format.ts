import { currencyDecimals } from "@envelope/core";

/**
 * "9 Oct" — a short date, shared across the account register, its own "To do" lists, import and
 * reconciliation; "3 Mar 2028" when the date falls in another year than `currentYear` (#702).
 * `currentYear` defaults to the browser's own; the register passes the workspace's.
 */
export function shortDate(iso: string, locale: string, currentYear: number = new Date().getFullYear()): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", timeZone: "UTC" };
  if (y !== currentYear) {
    options.year = "numeric";
  }
  return new Intl.DateTimeFormat(locale, options).format(new Date(Date.UTC(y, m - 1, d)));
}

/** An amount in its own currency's units (not minor units), without the currency symbol. */
export function plainAmount(cents: number, locale: string, currency: string): string {
  const decimals = currencyDecimals(currency);
  return new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(cents / 10 ** decimals);
}
