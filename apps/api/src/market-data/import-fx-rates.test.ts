import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import { ECB_RATES_FILE_MAX_CHARS, isValidationError } from "@envelope/core";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { createIsolatedDatabase, type IsolatedDatabase } from "../test-helpers/isolated-database.ts";
import { importFxRatesFile } from "./import-fx-rates.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

const fixturePath = (name: string): string => new URL(`./fixtures/${name}`, import.meta.url).pathname;

/** The administration command's work (#85), as envelope_app, in a database of its own. */
describe("importFxRatesFile (#85)", () => {
  let database: IsolatedDatabase | undefined;
  let superuserPool: DbPool;
  let appPool: DbPool;
  let directory: string;

  before(async () => {
    database = await createIsolatedDatabase(databaseUrl);
    superuserPool = createPool(database.databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    appPool = createPool(appConnectionString(database.databaseUrl));
    directory = await mkdtemp(join(tmpdir(), "envelope-fx-import-"));
  });

  afterEach(async () => {
    await superuserPool.query("DELETE FROM fx_rates");
  });

  after(async () => {
    try {
      await rm(directory, { recursive: true, force: true });
      await appPool?.end();
      await superuserPool?.end();
    } finally {
      await database?.drop();
    }
  });

  async function count(): Promise<number> {
    const { rows } = await superuserPool.query<{ n: number }>("SELECT count(*)::int AS n FROM fx_rates");
    return rows[0]!.n;
  }

  it("loads a downloaded file, then a newer one on top, and the same file again changes nothing", async () => {
    const first = await importFxRatesFile(appPool, fixturePath("ecb-hist.xml"));
    assert.deepEqual([first.inserted, first.changed.length, first.unchanged], [77, 0, 0]);
    assert.deepEqual(first.skippedCurrencies, ["CYP", "EEK", "LTL", "LVL", "MTL", "ROL", "SIT", "SKK", "TRL"]);
    const second = await importFxRatesFile(appPool, fixturePath("ecb-hist-90d.xml"));
    assert.deepEqual([second.inserted, second.changed, second.unchanged], [
      29,
      [{ quote: "USD", date: "2026-11-20", previousRateE10: 10_990_000_000, rateE10: 10_991_000_000 }],
      57,
    ]);
    const again = await importFxRatesFile(appPool, fixturePath("ecb-hist-90d.xml"));
    assert.deepEqual([again.inserted, again.changed.length, again.unchanged], [0, 0, 87]);
    assert.equal(await count(), 106);
    const { rows } = await superuserPool.query<{ source: string }>("SELECT DISTINCT source FROM fx_rates");
    assert.deepEqual(rows, [{ source: "ecb" }]);
  });

  it("refuses a malformed file as a whole, leaving the stored rates as they were", async () => {
    await importFxRatesFile(appPool, fixturePath("ecb-hist.xml"));
    const path = join(directory, "malformed.xml");
    // The first day is good, the last one has a bad rate: nothing of the file may be written.
    const text = (await readFile(fixturePath("ecb-hist-90d.xml"), "utf8")).replace(/rate="([0-9.]+)"\/><\/Cube><\/Cube>/, 'rate="n/a"/></Cube></Cube>');
    await writeFile(path, text);
    await assert.rejects(importFxRatesFile(appPool, path), (error) => isValidationError(error, "invalid_rates_file"));
    assert.equal(await count(), 77);
  });

  it("refuses a file beyond the size cap before reading it", async () => {
    const path = join(directory, "large.xml");
    await writeFile(path, Buffer.alloc(ECB_RATES_FILE_MAX_CHARS + 1, 0x20));
    await assert.rejects(importFxRatesFile(appPool, path), (error) => isValidationError(error, "invalid_rates_file") && error.details.reason === "too_large");
    assert.equal(await count(), 0);
  });
});
