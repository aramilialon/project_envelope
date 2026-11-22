import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, afterEach, before, describe, it } from "node:test";

import Fastify from "fastify";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import type { EnqueueOptions, QueueDriver } from "../queue/index.ts";
import { FX_RATES_FETCH_JOB } from "../queue/job-types.ts";
import { processJob } from "../queue/postgres-driver.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { createIsolatedDatabase, type IsolatedDatabase } from "../test-helpers/isolated-database.ts";
import { createEcbProvider, ECB_HISTORY_FILE, type EcbFile } from "./ecb-provider.ts";
import {
  createFxRatesFetchHandler,
  FX_RATES_FETCH_CRON,
  fxRatesStartupKey,
  fxRatesStartupRunNeeded,
  type JobLogger,
  registerFxRatesJob,
} from "./fx-rates-job.ts";
import { writeFxRates } from "./fx-rates-repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

const fixture = (name: string): Promise<string> => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/** Every line the job logged, by level. */
function recordingLogger(): JobLogger & { lines: { level: "info" | "warn" | "error"; object: Record<string, unknown>; message: string }[] } {
  const lines: { level: "info" | "warn" | "error"; object: Record<string, unknown>; message: string }[] = [];
  return {
    lines,
    info: (object, message) => lines.push({ level: "info", object, message }),
    warn: (object, message) => lines.push({ level: "warn", object, message }),
    error: (object, message) => lines.push({ level: "error", object, message }),
  };
}

/** The ECB adapter fed from the fixtures: the full history fixture, or the 90-day one with USD on 2026-11-20 revised. */
function fixtureProvider(today = "2026-11-22") {
  const asked: EcbFile[] = [];
  const provider = createEcbProvider({
    fetchFile: async (file) => {
      asked.push(file);
      return fixture(file === ECB_HISTORY_FILE ? "ecb-hist.xml" : "ecb-hist-90d.xml");
    },
    today: () => today,
  });
  return { provider, asked };
}

/**
 * As envelope_app (ADR 0006), in a database of its own: the job's behaviour depends on whether
 * any rate is stored at all, so no other test file's rows may be there.
 */
describe("fx-rates-fetch job (#85)", () => {
  let database: IsolatedDatabase | undefined;
  let superuserPool: DbPool;
  let appPool: DbPool;

  before(async () => {
    database = await createIsolatedDatabase(databaseUrl);
    superuserPool = createPool(database.databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    appPool = createPool(appConnectionString(database.databaseUrl));
  });

  afterEach(async () => {
    await superuserPool.query("DELETE FROM fx_rates");
  });

  after(async () => {
    try {
      await appPool?.end();
      await superuserPool?.end();
    } finally {
      await database?.drop();
    }
  });

  async function storedRates(): Promise<{ quote: string; date: string; rateE10: string; source: string; fetchedAt: Date }[]> {
    const { rows } = await superuserPool.query<{ quote: string; date: string; rateE10: string; source: string; fetchedAt: Date }>(
      `SELECT quote_currency AS quote, to_char(rate_date, 'YYYY-MM-DD') AS date, rate_e10 AS "rateE10", source, fetched_at AS "fetchedAt"
       FROM fx_rates ORDER BY rate_date, quote_currency`,
    );
    return rows;
  }

  function deliver(handler: ReturnType<typeof createFxRatesFetchHandler>, jobId: string = randomUUID()): Promise<void> {
    return processJob(appPool, FX_RATES_FETCH_JOB, jobId, {}, handler);
  }

  it("loads the full history when no rate is stored, as envelope_app", async () => {
    const { provider, asked } = fixtureProvider();
    const log = recordingLogger();
    await deliver(createFxRatesFetchHandler({ enabled: true, provider, log }));
    assert.deepEqual(asked, [ECB_HISTORY_FILE]);
    const rows = await storedRates();
    assert.equal(rows.length, 77);
    assert.deepEqual(
      rows.filter((r) => r.quote === "USD").map((r) => [r.date, r.rateE10, r.source]),
      [
        ["2004-12-31", "13621000000", "ecb"],
        ["2026-11-19", "10992000000", "ecb"],
        ["2026-11-20", "10990000000", "ecb"],
      ],
    );
    // The currencies the app cannot hold are left out, the old Turkish lira beyond the safe range included.
    assert.ok(!rows.some((r) => r.quote === "TRL" || r.quote === "CYP"));
    const summary = log.lines.find((line) => line.message === "exchange rates stored");
    assert.deepEqual(
      { inserted: summary?.object.inserted, changed: summary?.object.changed, unchanged: summary?.object.unchanged },
      { inserted: 77, changed: 0, unchanged: 0 },
    );
  });

  it("then reads the 90-day file: adds the new days, updates a revised rate with a warning, leaves the rest untouched", async () => {
    const { provider, asked } = fixtureProvider();
    const log = recordingLogger();
    const handler = createFxRatesFetchHandler({ enabled: true, provider, log });
    await deliver(handler);
    const before = await storedRates();
    await deliver(handler);
    assert.deepEqual(asked, [ECB_HISTORY_FILE, "eurofxref-hist-90d.xml"]);

    const after = await storedRates();
    assert.equal(after.length, 77 + 29);
    const usd = after.find((r) => r.quote === "USD" && r.date === "2026-11-20");
    assert.equal(usd?.rateE10, "10991000000");
    // An unchanged row keeps the time it was first fetched.
    const gbpBefore = before.find((r) => r.quote === "GBP" && r.date === "2026-11-19");
    const gbpAfter = after.find((r) => r.quote === "GBP" && r.date === "2026-11-19");
    assert.deepEqual(gbpAfter, gbpBefore);

    const warning = log.lines.find((line) => line.level === "warn");
    assert.deepEqual(warning?.object.changed, [{ quote: "USD", date: "2026-11-20", previousRateE10: 10_990_000_000, rateE10: 10_991_000_000 }]);
    const summary = log.lines.filter((line) => line.message === "exchange rates stored").at(-1);
    assert.deepEqual(
      { inserted: summary?.object.inserted, changed: summary?.object.changed, unchanged: summary?.object.unchanged },
      { inserted: 29, changed: 1, unchanged: 57 },
    );
  });

  it("a second job with another id on the same day finds the same rows and changes nothing", async () => {
    const { provider } = fixtureProvider();
    const handler = createFxRatesFetchHandler({ enabled: true, provider, log: recordingLogger() });
    await deliver(handler);
    await deliver(handler);
    const once = await storedRates();
    const log = recordingLogger();
    await deliver(createFxRatesFetchHandler({ enabled: true, provider, log }));
    assert.deepEqual(await storedRates(), once);
    assert.equal(log.lines.filter((line) => line.level === "warn").length, 0);
    const summary = log.lines.find((line) => line.message === "exchange rates stored");
    assert.deepEqual([summary?.object.inserted, summary?.object.changed, summary?.object.unchanged], [0, 0, 87]);
  });

  it("reads the full history again after a gap the 90-day file cannot close", async () => {
    await deliver(createFxRatesFetchHandler({ enabled: true, provider: fixtureProvider().provider, log: recordingLogger() }));
    const { provider, asked } = fixtureProvider("2027-03-01");
    await deliver(createFxRatesFetchHandler({ enabled: true, provider, log: recordingLogger() }));
    assert.deepEqual(asked, [ECB_HISTORY_FILE]);
  });

  it("with fetching off, never calls the provider and writes nothing", async () => {
    const { provider, asked } = fixtureProvider();
    const log = recordingLogger();
    await deliver(createFxRatesFetchHandler({ enabled: false, provider, log }));
    assert.deepEqual(asked, []);
    assert.equal((await storedRates()).length, 0);
    assert.match(log.lines[0]?.message ?? "", /not fetched/);
  });

  it("gives up a fetch that never answers within the time limit, and stores nothing", async () => {
    let aborted = false;
    const provider = createEcbProvider({
      fetchFile: (_file, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(signal.reason);
          });
        }),
    });
    const started = Date.now();
    const jobId = randomUUID();
    await assert.rejects(deliver(createFxRatesFetchHandler({ enabled: true, provider, log: recordingLogger(), timeoutMs: 100 }), jobId), (error: unknown) => {
      assert.equal((error as Error).name, "TimeoutError");
      return true;
    });
    assert.ok(aborted);
    assert.ok(Date.now() - started < 5_000);
    assert.equal((await storedRates()).length, 0);
    // The failed delivery is not marked processed: the queue's retry runs it again.
    const { rows } = await superuserPool.query("SELECT 1 FROM processed_jobs WHERE job_id = $1", [jobId]);
    assert.equal(rows.length, 0);
  });

  it("refuses a malformed file as a whole: nothing is stored", async () => {
    const provider = createEcbProvider({ fetchFile: async () => (await fixture("ecb-hist-90d.xml")).replace('currency="GBP"', 'currency="gbp"') });
    await assert.rejects(deliver(createFxRatesFetchHandler({ enabled: true, provider, log: recordingLogger() })), /invalid_rates_file|rate entry/);
    assert.equal((await storedRates()).length, 0);
  });

  it("writes a refused file's reason, currency and date to the server log (pino, as main.ts wires it), then fails the job", async () => {
    const provider = createEcbProvider({
      fetchFile: async () => (await fixture("ecb-hist-90d.xml")).replace('currency="USD" rate="1.0991"', 'currency="USD" rate="900719.9254740992"'),
    });
    const written: string[] = [];
    const server = Fastify({ logger: { level: "info", stream: { write: (line: string) => void written.push(line) } } });
    try {
      const log = server.log.child({ job: FX_RATES_FETCH_JOB });
      await assert.rejects(deliver(createFxRatesFetchHandler({ enabled: true, provider, log })), /too large to store/);
    } finally {
      await server.close();
    }
    assert.equal((await storedRates()).length, 0);
    const line = written.map((text) => JSON.parse(text) as Record<string, unknown>).find((entry) => entry.level === 50);
    assert.ok(line, `no error line in ${written.join("")}`);
    assert.equal(line.job, "fx-rates-fetch");
    assert.equal(line.provider, "ecb");
    assert.equal(line.code, "invalid_rates_file");
    const details = line.details as Record<string, unknown>;
    assert.deepEqual([details.reason, details.currency, details.date], ["rate_out_of_range", "USD", "2026-11-20"]);
  });

  it("leaves the system-job flag off once the rates are written, for anything later in the same transaction", async () => {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await writeFxRates(client, [{ base: "EUR", quote: "USD", date: "2026-01-02", rateE10: 11_000_000_000 }], "ecb");
      const { rows } = await client.query<{ flag: boolean | null }>("SELECT app_is_system_job() AS flag");
      assert.equal(rows[0]?.flag, null);
      // So the same transaction can no longer write a rate, nor see every workspace.
      await assert.rejects(
        client.query("INSERT INTO fx_rates (base_currency, quote_currency, rate_date, rate_e10, source) VALUES ('EUR', 'GBP', '2026-01-02', 8000000000, 'ecb')"),
        (error: unknown) => (error as { code?: string }).code === "42501",
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

/** Row-Level Security on fx_rates (migration 0036): every caller reads, only a system job writes. */
describe("fx_rates isolation (#85)", () => {
  let database: IsolatedDatabase | undefined;
  let superuserPool: DbPool;
  let appPool: DbPool;

  before(async () => {
    database = await createIsolatedDatabase(databaseUrl);
    superuserPool = createPool(database.databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    appPool = createPool(appConnectionString(database.databaseUrl));
    await superuserPool.query(
      "INSERT INTO fx_rates (base_currency, quote_currency, rate_date, rate_e10, source) VALUES ('EUR', 'USD', '2026-01-02', 11000000000, 'ecb')",
    );
  });

  after(async () => {
    try {
      await appPool?.end();
      await superuserPool?.end();
    } finally {
      await database?.drop();
    }
  });

  /** Runs `sql` as envelope_app in a transaction with the given session variables, then rolls back. */
  async function asApp<T>(vars: Record<string, string>, run: (query: (sql: string) => Promise<{ rowCount: number | null }>) => Promise<T>): Promise<T> {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      for (const [name, value] of Object.entries(vars)) {
        await client.query("SELECT set_config($1, $2, true)", [name, value]);
      }
      return await run((sql) => client.query(sql));
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  const insertSql = "INSERT INTO fx_rates (base_currency, quote_currency, rate_date, rate_e10, source) VALUES ('EUR', 'GBP', '2026-01-02', 8000000000, 'ecb')";
  const isRlsRefusal = (error: unknown): boolean => (error as { code?: string }).code === "42501";

  it("every request reads every rate, with or without a workspace", async () => {
    for (const vars of [{}, { "app.workspace_id": randomUUID(), "app.user_id": randomUUID() }]) {
      const { rowCount } = await asApp(vars, (query) => query("SELECT * FROM fx_rates"));
      assert.equal(rowCount, 1);
    }
  });

  it("a request cannot insert a rate, whatever workspace it is in (42501)", async () => {
    for (const vars of [{}, { "app.workspace_id": randomUUID(), "app.user_id": randomUUID() }, { "app.is_system_job": "false" }]) {
      await assert.rejects(asApp(vars, (query) => query(insertSql)), isRlsRefusal);
    }
  });

  it("a request cannot update a rate: no row is touched", async () => {
    const { rowCount } = await asApp({ "app.workspace_id": randomUUID() }, (query) => query("UPDATE fx_rates SET rate_e10 = 1"));
    assert.equal(rowCount, 0);
    const { rows } = await superuserPool.query<{ rate_e10: string }>("SELECT rate_e10 FROM fx_rates");
    assert.deepEqual(rows, [{ rate_e10: "11000000000" }]);
  });

  it("nobody but the owner can delete a rate, a system job included (no DELETE grant)", async () => {
    await assert.rejects(asApp({ "app.is_system_job": "true" }, (query) => query("DELETE FROM fx_rates")), isRlsRefusal);
  });

  it("a system job can insert and update, but only the rate, its source and its time", async () => {
    await asApp({ "app.is_system_job": "true" }, async (query) => {
      assert.equal((await query(insertSql)).rowCount, 1);
      assert.equal((await query("UPDATE fx_rates SET rate_e10 = 11100000000, fetched_at = now() WHERE quote_currency = 'USD'")).rowCount, 1);
    });
    await assert.rejects(
      asApp({ "app.is_system_job": "true" }, (query) => query("UPDATE fx_rates SET rate_date = '2026-01-03'")),
      isRlsRefusal,
    );
  });

  it("the table refuses a rate not against the euro, a bad currency, or a value outside 1 to 2^53 − 1", async () => {
    for (const values of [
      "('USD', 'GBP', '2026-01-03', 8000000000, 'ecb')",
      "('EUR', 'EUR', '2026-01-03', 10000000000, 'ecb')",
      "('EUR', 'gbp', '2026-01-03', 8000000000, 'ecb')",
      "('EUR', 'GBP', '2026-01-03', 0, 'ecb')",
      "('EUR', 'GBP', '2026-01-03', 9007199254740992, 'ecb')",
      "('EUR', 'GBP', '2026-01-03', 8000000000, '')",
    ]) {
      await assert.rejects(
        superuserPool.query(`INSERT INTO fx_rates (base_currency, quote_currency, rate_date, rate_e10, source) VALUES ${values}`),
        (error: unknown) => (error as { code?: string }).code === "23514",
        values,
      );
    }
  });
});

describe("registerFxRatesJob (#85)", () => {
  function recordingQueue() {
    const calls: { method: string; args: unknown[] }[] = [];
    const queue: QueueDriver = {
      enqueue: async (jobType: string, data: object, options?: EnqueueOptions) => {
        calls.push({ method: "enqueue", args: [jobType, data, options] });
        return "job-id";
      },
      schedule: async (jobType: string, cron: string) => {
        calls.push({ method: "schedule", args: [jobType, cron] });
      },
      work: async (jobType: string) => {
        calls.push({ method: "work", args: [jobType] });
      },
      start: async () => {},
      stop: async () => {},
    };
    return { queue, calls };
  }

  const neverFetches = createEcbProvider({
    fetchFile: () => {
      throw new Error("the provider must not be called while registering");
    },
  });

  it("with fetching on: registers the handler, the cron at 15:30 and 21:30 UTC on working days, and one run now, deduplicated by the UTC day", async () => {
    const { queue, calls } = recordingQueue();
    await registerFxRatesJob(
      queue,
      { enabled: true, provider: neverFetches, log: recordingLogger() },
      { latestRateDate: async () => null, now: new Date("2026-11-22T23:30:00+01:00") },
    );
    assert.equal(FX_RATES_FETCH_CRON, "30 15,21 * * 1-5");
    assert.deepEqual(calls, [
      { method: "work", args: ["fx-rates-fetch"] },
      { method: "schedule", args: ["fx-rates-fetch", "30 15,21 * * 1-5"] },
      { method: "enqueue", args: ["fx-rates-fetch", {}, { deduplicationKey: "fx-rates:ecb:2026-11-22" }] },
    ]);
    assert.equal(fxRatesStartupKey(new Date("2026-11-23T00:30:00+01:00")), "fx-rates:ecb:2026-11-22");
  });

  it("with fetching off: registers only the handler, schedules and enqueues nothing, and says so once", async () => {
    const { queue, calls } = recordingQueue();
    const log = recordingLogger();
    let read = false;
    await registerFxRatesJob(
      queue,
      { enabled: false, provider: neverFetches, log },
      {
        latestRateDate: async () => {
          read = true;
          return null;
        },
      },
    );
    assert.deepEqual(calls, [{ method: "work", args: ["fx-rates-fetch"] }]);
    assert.equal(read, false);
    assert.equal(log.lines.length, 1);
    assert.match(log.lines[0]?.message ?? "", /MARKET_DATA_FETCH_ENABLED is false/);
  });

  it("skips the startup run when the newest stored day is today or yesterday (UTC), and says so; schedules all the same", async () => {
    for (const latest of ["2026-11-22", "2026-11-21", "2026-11-23"]) {
      const { queue, calls } = recordingQueue();
      const log = recordingLogger();
      // Now is 23:30 on 2026-11-22 in UTC (00:30 the next day in Rome); the last day is after it (a clock behind).
      await registerFxRatesJob(
        queue,
        { enabled: true, provider: neverFetches, log },
        { latestRateDate: async () => latest, now: new Date("2026-11-23T00:30:00+01:00") },
      );
      assert.deepEqual(calls.map((call) => call.method), ["work", "schedule"], latest);
      assert.match(log.lines.at(-1)?.message ?? "", /recent: no fetch at startup/);
    }
  });

  it("runs at startup when the newest stored day is two days old or more (a weekend, a server stopped for days)", async () => {
    for (const latest of ["2026-11-20", "2025-01-02"]) {
      const { queue, calls } = recordingQueue();
      await registerFxRatesJob(
        queue,
        { enabled: true, provider: neverFetches, log: recordingLogger() },
        { latestRateDate: async () => latest, now: new Date("2026-11-22T12:00:00Z") },
      );
      assert.deepEqual(calls.at(-1), { method: "enqueue", args: ["fx-rates-fetch", {}, { deduplicationKey: "fx-rates:ecb:2026-11-22" }] }, latest);
    }
  });

  it("decides from the UTC day, not the server's local one", () => {
    // 00:30 on 2026-11-23 in Rome is 23:30 on 2026-11-22 in UTC: 2026-11-21 is still yesterday.
    assert.equal(fxRatesStartupRunNeeded("2026-11-21", new Date("2026-11-23T00:30:00+01:00")), false);
    assert.equal(fxRatesStartupRunNeeded("2026-11-20", new Date("2026-11-23T00:30:00+01:00")), true);
    assert.equal(fxRatesStartupRunNeeded(null, new Date("2026-11-23T00:30:00+01:00")), true);
  });
});
