/**
 * The opaque cursor of an account's transaction pages (#560): base64url of a small JSON object
 * naming the last row a page returned, by its place in the register order
 * (occurred_at, created_at, id), and the list it belongs to.
 *
 * The two instants are the database's own text with microseconds (`to_char(... .US)` in UTC),
 * cast back with `::timestamptz` by the query, never a JavaScript `Date`: a `Date` keeps only
 * milliseconds, so two rows a few microseconds apart would compare equal to the cursor and one of
 * them would be skipped.
 */
import { ValidationError } from "@envelope/core";

export type TransactionOrder = "asc" | "desc";

/** The place of one row in the register order, as the database writes it. */
export interface TransactionKey {
  /** `occurred_at` in UTC with microseconds, `YYYY-MM-DDTHH:MI:SS.USZ`. */
  readonly occurredAt: string;
  /** `created_at`, in the same form. */
  readonly createdAt: string;
  readonly id: string;
}

/** What a cursor is valid for: one account of one workspace, read in one order. */
export interface TransactionCursorScope {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly order: TransactionOrder;
}

const CURSOR_VERSION = 1;
/** Far more than a cursor ever takes (about 250 characters); anything longer is refused unread. */
const MAX_CURSOR_LENGTH = 1024;
const INSTANT_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Whether a value is an instant as the database writes it here, on a real date at a real time: a
 * "2026-02-30" that the pattern alone lets through would fail the query's `::timestamptz` cast.
 * The milliseconds are enough to check the calendar; the microseconds are only digits.
 */
function isInstantText(value: unknown): value is string {
  if (typeof value !== "string" || !INSTANT_TEXT.test(value)) {
    return false;
  }
  const date = new Date(`${value.slice(0, 23)}Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 23) === value.slice(0, 23);
}

interface CursorPayload {
  readonly v: number;
  readonly w: string;
  readonly a: string;
  readonly d: TransactionOrder;
  readonly o: string;
  readonly c: string;
  readonly i: string;
}

export function encodeTransactionCursor(scope: TransactionCursorScope, key: TransactionKey): string {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    w: scope.workspaceId,
    a: scope.accountId,
    d: scope.order,
    o: key.occurredAt,
    c: key.createdAt,
    i: key.id,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * The row a cursor names, when the cursor was given out for this very list.
 *
 * @throws ValidationError `invalid_cursor`, with empty `details`, for a cursor that is not one
 *   this API wrote, of another version, or given out for another workspace, another account or
 *   the other order. Nothing in the refusal says which, so a cursor tells nobody anything about a
 *   list it was not given out for.
 */
export function decodeTransactionCursor(cursor: unknown, scope: TransactionCursorScope): TransactionKey {
  const invalid = (): ValidationError => new ValidationError("invalid_cursor", "the cursor is not one of this list", {});
  // A repeated `cursor` parameter reaches here as an array.
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH || !BASE64URL.test(cursor)) {
    throw invalid();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw invalid();
  }
  const { v, w, a, d, o, c, i } = payload as Record<string, unknown>;
  if (
    v !== CURSOR_VERSION ||
    w !== scope.workspaceId ||
    a !== scope.accountId ||
    d !== scope.order ||
    !isInstantText(o) ||
    !isInstantText(c) ||
    typeof i !== "string" ||
    !UUID.test(i)
  ) {
    throw invalid();
  }
  return { occurredAt: o, createdAt: c, id: i };
}
