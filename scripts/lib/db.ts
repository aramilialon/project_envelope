import pg from "pg";

/**
 * The one thing this seed script still does with direct SQL, deliberately isolated here:
 * backdating a credit card's own "Starting balance" transaction (`backdateStartingBalance`,
 * #326) — `POST .../accounts` always dates it `now()` (`apps/api/src/accounts/repository.ts`),
 * with no way to ask for another date through the API, so a card seeded as part of the previous
 * month's own story would otherwise show its debt arriving today instead, however long ago the
 * rest of that month happened. Everything else this seed produces (the workspace itself,
 * accounts, categories, transactions, assignments, scheduled transactions, goals) goes through
 * the real API instead (`lib/api.ts`), so RLS and the assignment ledger actually get exercised.
 */

function pool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}

/** Moves a credit card's own "Starting balance" transaction to midnight, in the workspace's own time zone, on `date` ("YYYY-MM-DD") — see the module comment above for why this needs direct SQL. */
export async function backdateStartingBalance(databaseUrl: string, accountId: string, date: string, timeZone: string): Promise<void> {
  const db = pool(databaseUrl);
  try {
    await db.query(
      `UPDATE transactions SET occurred_at = ($1::date AT TIME ZONE $2) WHERE account_id = $3 AND payee = 'Starting balance'`,
      [date, timeZone, accountId],
    );
  } finally {
    await db.end();
  }
}
