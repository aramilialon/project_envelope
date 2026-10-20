import { currencyDecimals } from "@envelope/core";

/** "9 Oct" — a short date, shared across the account register, its own "To do" lists, import and reconciliation. */
export function shortDate(iso: string, locale: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** An amount in its own currency's units (not minor units), without the currency symbol. */
export function plainAmount(cents: number, locale: string, currency: string): string {
  const decimals = currencyDecimals(currency);
  return new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(cents / 10 ** decimals);
}
