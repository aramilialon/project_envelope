/**
 * Job type names and payload shapes shared between a producer (which enqueues) and its
 * consumer (which registers `work(...)` for it), kept in a module of their own with no other
 * imports: transactions/repository.ts (the producer) and notifications/budget-recompute-job.ts
 * (the consumer, which itself imports budget/repository.ts, which imports
 * transactions/repository.ts back) would otherwise form an import cycle.
 */

export const BUDGET_RECOMPUTE_JOB = "budget-recompute";

export interface BudgetRecomputeJobData {
  readonly workspaceId: string;
  readonly transactionId: string;
  readonly month: string;
}

/** A periodic job (`#38`): no one workspace/transaction triggers it, so it carries no payload of its own. */
export const SCHEDULED_TRANSACTIONS_FIRE_JOB = "scheduled-transactions-fire";

export type ScheduledTransactionsFireJobData = Record<string, never>;

/** A periodic job (#85): fetches the euro reference rates; shared data, so no payload of its own. */
export const FX_RATES_FETCH_JOB = "fx-rates-fetch";

export type FxRatesFetchJobData = Record<string, never>;

/** A periodic job (#559): removes expired idempotency keys in every workspace; no payload of its own. */
export const IDEMPOTENCY_KEYS_SWEEP_JOB = "idempotency-keys-sweep";

export type IdempotencyKeysSweepJobData = Record<string, never>;

/** Every job type registered anywhere: the double-delivery harness (#37) fails CI for one missing a case here. */
export const ALL_JOB_TYPES = [BUDGET_RECOMPUTE_JOB, SCHEDULED_TRANSACTIONS_FIRE_JOB, FX_RATES_FETCH_JOB, IDEMPOTENCY_KEYS_SWEEP_JOB] as const;
