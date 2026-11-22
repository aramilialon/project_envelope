import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { ValidationError } from "@envelope/core";
import Fastify from "fastify";

import {
  AccountClosedError,
  isInstrumentNotFoundViolation,
  LOG_REDACT_PATHS,
  registerErrorHandler,
  strictBody,
  toErrorReply,
  TooManyRequestsError,
} from "./errors.ts";
import { ID_PARAM_NAMES, isUuid } from "./ids.ts";

describe("registerErrorHandler's logging (#512)", () => {
  /** A bare app with the handler and the app's own redaction, whose log lines are kept for inspection. */
  function appThrowing(error: Error) {
    const lines: Record<string, unknown>[] = [];
    const app = Fastify({
      logger: {
        level: "info",
        redact: [...LOG_REDACT_PATHS],
        stream: { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
      },
    });
    registerErrorHandler(app);
    app.get("/boom", async () => {
      throw error;
    });
    return { app, lines };
  }

  async function logOf(error: Error): Promise<Record<string, unknown>> {
    const { app, lines } = appThrowing(error);
    await app.inject({ method: "GET", url: "/boom" });
    await app.close();
    const line = lines.find((entry) => entry.statusCode !== undefined || entry.err !== undefined);
    assert.ok(line, "the error handler logged nothing");
    return line;
  }

  it("logs a mapped client error's code and status only, never its message quoting request data", async () => {
    const line = await logOf(databaseError("22P02", 'invalid input syntax for type uuid: "private request data"'));
    assert.equal(line.level, 30);
    assert.equal(line.code, "22P02");
    assert.equal(line.statusCode, 400);
    assert.equal(line.err, undefined);
    assert.ok(!JSON.stringify(line).includes("private request data"));
  });

  it("logs a database permission refusal at warn, still answering 403", async () => {
    const { app, lines } = appThrowing(databaseError("42501", "permission denied for table accounts"));
    const response = await app.inject({ method: "GET", url: "/boom" });
    await app.close();
    assert.equal(response.statusCode, 403);
    const line = lines.find((entry) => entry.code === "42501");
    assert.equal(line?.level, 40);
  });

  it("logs a 500's whole error, with a database error's detail redacted", async () => {
    const error = Object.assign(databaseError("23514", 'new row for relation "accounts" violates check constraint'), {
      detail: "Failing row contains (private, row, values).",
    });
    const line = await logOf(error);
    assert.equal(line.level, 50);
    const err = line.err as Record<string, unknown>;
    assert.match(String(err.message), /violates check constraint/);
    assert.equal(err.detail, "[Redacted]");
  });
});

/** Shaped like node-postgres' own `DatabaseError`: a message, a SQLSTATE `code` and a `severity`. */
function databaseError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, severity: "ERROR" });
}

describe("toErrorReply (#512)", () => {
  it("maps a rate limit to 429 too_many_requests with the seconds to wait (#566)", () => {
    assert.deepEqual(toErrorReply(new TooManyRequestsError(42)), {
      statusCode: 429,
      body: { error: "too_many_requests", details: { retryAfterSeconds: 42 } },
    });
  });

  it("maps a foreign-key violation to 400 invalid_reference, without the database message", () => {
    const reply = toErrorReply(
      databaseError("23503", 'insert or update on table "import_mappings" violates foreign key constraint "import_mappings_account_fk"'),
    );
    assert.deepEqual(reply, { statusCode: 400, body: { error: "invalid_reference" } });
  });

  it("maps invalid input syntax to 400 invalid_input", () => {
    const reply = toErrorReply(databaseError("22P02", 'invalid input syntax for type uuid: "nope"'));
    assert.deepEqual(reply, { statusCode: 400, body: { error: "invalid_input" } });
  });

  it("maps a date PostgreSQL cannot read, or one that does not exist, to 400 invalid_date (#655)", () => {
    assert.deepEqual(toErrorReply(databaseError("22007", 'invalid input syntax for type timestamp: "not-a-date"')), {
      statusCode: 400,
      body: { error: "invalid_date" },
    });
    assert.deepEqual(toErrorReply(databaseError("22008", 'date/time field value out of range: "2026-02-30"')), {
      statusCode: 400,
      body: { error: "invalid_date" },
    });
  });

  it("maps insufficient privilege and a Row-Level Security refusal to 403 forbidden", () => {
    assert.deepEqual(toErrorReply(databaseError("42501", "permission denied for table accounts")), {
      statusCode: 403,
      body: { error: "forbidden" },
    });
    // What PostgreSQL actually raises for a row a Row-Level Security policy refuses.
    assert.deepEqual(
      toErrorReply(databaseError("42501", 'new row violates row-level security policy for table "import_mappings"')),
      { statusCode: 403, body: { error: "forbidden" } },
    );
  });

  it("still maps a Row-Level Security refusal reported under another SQLSTATE to 403", () => {
    // The message fallback: a refusal re-raised under another code (by a trigger or a function
    // wrapping the statement, for instance) is still a refusal, never a 500 naming the table.
    assert.deepEqual(
      toErrorReply(databaseError("P0001", 'new row violates row-level security policy for table "import_mappings"')),
      { statusCode: 403, body: { error: "forbidden" } },
    );
  });

  it("maps a write to a closed account to 409 account_closed (#729)", () => {
    const refused = Object.assign(databaseError("23514", "the account is closed"), { constraint: "account_closed" });
    assert.deepEqual(toErrorReply(refused), { statusCode: 409, body: { error: "account_closed" } });
    // Any other check violation is still a generic 500: only the closed-account trigger is a 409.
    const other = Object.assign(databaseError("23514", "new row violates check constraint"), { constraint: "trades_buy_check" });
    assert.deepEqual(toErrorReply(other), { statusCode: 500, body: { error: "internal_error" } });
  });

  it("maps a repository's own closed-account refusal like the trigger's (#741)", () => {
    assert.deepEqual(toErrorReply(new AccountClosedError("5f0c8a1e-0000-4000-8000-000000000001")), {
      statusCode: 409,
      body: { error: "account_closed" },
    });
  });

  it("maps any other database error to a generic 500", () => {
    const reply = toErrorReply(databaseError("23505", 'duplicate key value violates unique constraint "accounts_pkey"'));
    assert.deepEqual(reply, { statusCode: 500, body: { error: "internal_error" } });
  });

  it("maps a ValidationError to 400 with its code and details", () => {
    const reply = toErrorReply(new ValidationError("invalid_amount", "an English message", { amount: 1.5 }));
    assert.deepEqual(reply, { statusCode: 400, body: { error: "invalid_amount", details: { amount: 1.5 } } });
  });

  it("maps amount_total_overflow to 422: the stored rows, not the request, are the problem (#651)", () => {
    const details = { label: "transactions", transactionIds: "a,b", count: 2 };
    const reply = toErrorReply(new ValidationError("amount_total_overflow", "an English message", details));
    assert.deepEqual(reply, { statusCode: 422, body: { error: "amount_total_overflow", details } });
  });

  it("keeps a Fastify client error's status, with a fixed body instead of its message", () => {
    const unsupported = Object.assign(new Error("Unsupported Media Type: text/plain"), {
      statusCode: 415,
      code: "FST_ERR_CTP_INVALID_MEDIA_TYPE",
    });
    assert.deepEqual(toErrorReply(unsupported), {
      statusCode: 415,
      body: { error: "unsupported_media_type", code: "FST_ERR_CTP_INVALID_MEDIA_TYPE" },
    });
    const tooLarge = Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    assert.deepEqual(toErrorReply(tooLarge), { statusCode: 413, body: { error: "payload_too_large" } });
    const teapot = Object.assign(new Error("short and stout"), { statusCode: 418 });
    assert.deepEqual(toErrorReply(teapot), { statusCode: 418, body: { error: "client_error" } });
  });

  it("maps anything else, a 5xx status included, to a generic 500", () => {
    assert.deepEqual(toErrorReply(new Error("secret detail")), { statusCode: 500, body: { error: "internal_error" } });
    assert.deepEqual(toErrorReply(Object.assign(new Error("boom"), { statusCode: 503 })), {
      statusCode: 500,
      body: { error: "internal_error" },
    });
    assert.deepEqual(toErrorReply("a thrown string"), { statusCode: 500, body: { error: "internal_error" } });
    assert.deepEqual(toErrorReply(null), { statusCode: 500, body: { error: "internal_error" } });
  });

  it("does not take a non-database error's code for a SQLSTATE", () => {
    // A Node system error has a `code` too, but no `severity`: still a generic 500.
    assert.deepEqual(toErrorReply(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })), {
      statusCode: 500,
      body: { error: "internal_error" },
    });
  });
});

describe("isInstrumentNotFoundViolation (#83)", () => {
  it("recognises only the check_violation the instrument triggers raise", () => {
    const raised = { code: "23514", severity: "ERROR", constraint: "instrument_not_found" };
    assert.equal(isInstrumentNotFoundViolation(raised), true);
    assert.equal(isInstrumentNotFoundViolation({ ...raised, constraint: "account_closed" }), false);
    assert.equal(isInstrumentNotFoundViolation({ ...raised, code: "23503" }), false);
    assert.equal(isInstrumentNotFoundViolation(new Error("instrument_not_found")), false);
  });
});

describe("ID_PARAM_NAMES (#512)", () => {
  it("names every id path parameter the routes declare", async () => {
    const routesDir = new URL("./routes/", import.meta.url);
    const sources = await Promise.all(
      (await readdir(routesDir)).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts")).map((file) => readFile(new URL(file, routesDir), "utf8")),
    );
    const params = new Set(sources.flatMap((source) => [...source.matchAll(/:([a-zA-Z]+Id)\b/g)].map((match) => match[1]!)));
    params.delete("workspaceId");
    assert.ok(params.size > 0);
    for (const param of params) {
      assert.ok(ID_PARAM_NAMES[param], `${param} has no name in ID_PARAM_NAMES`);
    }
  });
});

describe("isUuid (#512)", () => {
  it("accepts a uuid in either letter case", () => {
    assert.equal(isUuid("0b6f1c2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b"), true);
    assert.equal(isUuid("0B6F1C2E-3A4D-4E5F-8A9B-0C1D2E3F4A5B"), true);
  });

  it("refuses anything else", () => {
    for (const value of ["", "nope", "0b6f1c2e-3a4d-4e5f-8a9b-0c1d2e3f4a5", "0b6f1c2e3a4d4e5f8a9b0c1d2e3f4a5b", " 0b6f1c2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b", 42, null, undefined]) {
      assert.equal(isUuid(value), false, String(value));
    }
  });
});

describe("strictBody (#655)", () => {
  const allowed = new Set(["payee", "memo"]);

  it("returns the fields of a body that holds only allowed keys, and {} for no body", () => {
    assert.deepEqual(strictBody({ payee: "Shop" }, allowed), { payee: "Shop" });
    assert.deepEqual(strictBody({}, allowed), {});
    assert.deepEqual(strictBody(undefined, allowed), {});
  });

  it("refuses the first key that is not allowed with unknown_field, naming it", () => {
    assert.throws(
      () => strictBody({ payee: "Shop", accountId: "x", other: 1 }, allowed),
      (error: unknown) => error instanceof ValidationError && error.code === "unknown_field" && error.details.field === "accountId",
    );
  });

  it("refuses a body that is not a JSON object with invalid_body", () => {
    for (const body of [null, [], ["payee"], "payee", 42, true]) {
      assert.throws(
        () => strictBody(body, allowed),
        (error: unknown) => error instanceof ValidationError && error.code === "invalid_body",
        JSON.stringify(body),
      );
    }
  });
});
