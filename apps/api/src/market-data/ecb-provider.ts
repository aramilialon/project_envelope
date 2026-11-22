/**
 * The ECB exchange rates adapter (#85, ADR 0019): the euro reference rates the European Central
 * Bank publishes every working day around 16:00 Central European Time, as public files.
 *
 * Two files are read: the full history since 1999 (about 8 MB) when no rate is stored yet, or
 * when the newest one is too old for the other file to close the gap, and the last 90 days
 * (about 100 kB) otherwise. @envelope/core parses them (`parseEcbReferenceRates`), refusing a
 * file as a whole when anything in it is malformed.
 *
 * The outbound request (`createEcbFileFetcher`) is the only one the server makes for market data,
 * and is kept narrow on purpose: a fixed address (the ECB's, or `MARKET_DATA_ECB_URL`, which
 * `config.ts` accepts only as HTTPS, or HTTP to this machine for tests), one of two fixed file
 * names, no redirect followed, the job's time limit, an XML content type, and a size cap counted
 * on the decoded body as it arrives. Nothing about the server, its users or their data is sent:
 * it is a plain GET for a public file.
 */
import { daysBetween, ECB_RATES_FILE_MAX_CHARS, type LocalDate, parseEcbReferenceRates } from "@envelope/core";

import type { MarketDataProvider } from "./provider.ts";

export const ECB_PROVIDER_ID = "ecb";

/** Where the ECB publishes its rate files; `MARKET_DATA_ECB_URL` replaces it. */
export const ECB_DEFAULT_BASE_URL = "https://www.ecb.europa.eu/stats/eurofxref/";

/** Every day since 1999. */
export const ECB_HISTORY_FILE = "eurofxref-hist.xml";
/** The last 90 days. */
export const ECB_RECENT_FILE = "eurofxref-hist-90d.xml";

export type EcbFile = typeof ECB_HISTORY_FILE | typeof ECB_RECENT_FILE;

/**
 * The 90-day file is read while the newest stored rate is at most this many days old; after a
 * longer gap (the server stopped, or fetching was off, for months) the full history is read
 * instead, so no day is ever left missing. Well inside 90, since the 90-day file counts back from
 * its own newest day and ends on the last working day.
 */
export const ECB_RECENT_FILE_MAX_GAP_DAYS = 80;

/** Fetches one of the ECB files as text; injected, so tests read fixtures and never the network. */
export type EcbFileFetcher = (file: EcbFile, signal: AbortSignal) => Promise<string>;

export interface EcbProviderOptions {
  readonly fetchFile: EcbFileFetcher;
  /** Today in UTC, "YYYY-MM-DD"; injected for tests. */
  readonly today?: () => LocalDate;
}

function utcToday(): LocalDate {
  return new Date().toISOString().slice(0, 10);
}

/** Which file brings the rates stored up to date, given the newest day stored. */
export function ecbFileFor(since: LocalDate | null, today: LocalDate): EcbFile {
  return since === null || daysBetween(since, today) > ECB_RECENT_FILE_MAX_GAP_DAYS ? ECB_HISTORY_FILE : ECB_RECENT_FILE;
}

export function createEcbProvider(options: EcbProviderOptions): MarketDataProvider {
  const today = options.today ?? utcToday;
  return {
    id: ECB_PROVIDER_ID,
    async fetchFxRates(request, signal) {
      const text = await options.fetchFile(ecbFileFor(request.since, today()), signal);
      return parseEcbReferenceRates(text).rates;
    },
  };
}

/** Why a fetch was given up; `code` is stable, for the logs and the tests. */
export class EcbFetchError extends Error {
  readonly code: "http_status" | "content_type" | "too_large" | "not_utf8";

  constructor(code: EcbFetchError["code"], message: string) {
    super(message);
    this.name = "EcbFetchError";
    this.code = code;
  }
}

const XML_MEDIA_TYPES: ReadonlySet<string> = new Set(["text/xml", "application/xml"]);

export interface EcbFileFetcherOptions {
  /** The directory the two files are in, ending with "/"; already checked by `config.ts`. */
  readonly baseUrl: string;
  /** The largest body read, decoded, in bytes. */
  readonly maxBytes?: number;
  /** The global `fetch`; injected only by tests of this function. */
  readonly fetch?: typeof fetch;
}

/**
 * The real fetcher. A non-2xx answer, a redirect, a content type other than XML, a body beyond
 * `maxBytes` (declared or received) or one that is not UTF-8 is an error, and nothing is stored;
 * the job fails and the queue retries it later. `signal` (the job's time limit) covers the whole
 * exchange, the body included.
 */
export function createEcbFileFetcher(options: EcbFileFetcherOptions): EcbFileFetcher {
  const maxBytes = options.maxBytes ?? ECB_RATES_FILE_MAX_CHARS;
  const fetchImpl = options.fetch ?? fetch;
  return async (file, signal) => {
    const url = new URL(file, options.baseUrl);
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal,
      headers: { accept: "application/xml, text/xml" },
    });
    try {
      if (!response.ok) {
        throw new EcbFetchError("http_status", `${url.href} answered ${response.status}`);
      }
      const mediaType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (!XML_MEDIA_TYPES.has(mediaType)) {
        throw new EcbFetchError("content_type", `${url.href} answered with content type "${mediaType}", not XML`);
      }
      const declared = Number(response.headers.get("content-length") ?? Number.NaN);
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new EcbFetchError("too_large", `${url.href} declares ${declared} bytes, more than ${maxBytes}`);
      }
      return await readCapped(response, maxBytes, url.href);
    } finally {
      // A body not read to the end (an error above) is released, never left holding the connection.
      if (!response.bodyUsed) await response.body?.cancel().catch(() => {});
    }
  };
}

async function readCapped(response: Response, maxBytes: number, href: string): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new EcbFetchError("too_large", `${href} sent more than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new EcbFetchError("not_utf8", `${href} sent a body that is not UTF-8`);
  }
}
