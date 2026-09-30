/**
 * The shared double-delivery test harness (design.md, "Queue module"; #37): every registered
 * job type (queue/job-types.ts's ALL_JOB_TYPES) must prove that redelivering the same job id
 * (pg-boss's own at-least-once retry, or a crash after send but before ack) produces its
 * effects exactly once, not twice. A job type with no case here fails the coverage check below,
 * not silently.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { DbPool } from "../db/pool.ts";
import type { JobHandler } from "./driver.ts";
import { processJob } from "./postgres-driver.ts";

/**
 * Type-erased so a mixed list of job types (each with its own payload shape) can share one
 * array; `defineDoubleDeliveryCase` is the one place that casts, keeping every call site typed.
 */
export interface DoubleDeliveryCase {
  readonly jobType: string;
  run(pool: DbPool, jobId: string): Promise<void>;
  /** Counts this job's own effect (a notification sent, a row written...) for the jobId it was just delivered under. */
  countEffects(pool: DbPool, jobId: string): Promise<number>;
}

export function defineDoubleDeliveryCase<T extends object>(options: {
  readonly jobType: string;
  readonly data: T;
  readonly handler: JobHandler<T>;
  countEffects(pool: DbPool, jobId: string): Promise<number>;
}): DoubleDeliveryCase {
  return {
    jobType: options.jobType,
    run: (pool, jobId) => processJob(pool, options.jobType, jobId, options.data, options.handler),
    countEffects: options.countEffects,
  };
}

/** Delivers the same job id twice and asserts its counted effect happened exactly once. */
export async function assertSingleDelivery(pool: DbPool, testCase: DoubleDeliveryCase): Promise<void> {
  const jobId = randomUUID();
  await testCase.run(pool, jobId);
  await testCase.run(pool, jobId);
  const effects = await testCase.countEffects(pool, jobId);
  assert.equal(effects, 1, `${testCase.jobType}: expected exactly one effect after a repeat delivery, got ${effects}`);
}

/** Fails loudly if a registered job type has no case in `cases`. */
export function assertEveryJobTypeCovered(allJobTypes: readonly string[], cases: readonly DoubleDeliveryCase[]): void {
  const covered = new Set(cases.map((testCase) => testCase.jobType));
  const missing = allJobTypes.filter((jobType) => !covered.has(jobType));
  assert.deepEqual(missing, [], `job types missing a double-delivery case: ${missing.join(", ")}`);
}
