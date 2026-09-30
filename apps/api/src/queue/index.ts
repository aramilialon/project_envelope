import type { QueueConfig } from "../config.ts";
import type { DbPool } from "../db/pool.ts";
import type { QueueDriver } from "./driver.ts";
import { createPostgresQueueDriver } from "./postgres-driver.ts";

export type { EnqueueOptions, JobHandler, QueueDriver } from "./driver.ts";

/**
 * Picks the adapter named by `QUEUE_DRIVER` (design.md, "Queue module") — the only place that
 * switches on it. `appPool` is `envelope_app`'s own pool: a job's effects, and the
 * `processed_jobs` idempotency marker (#36), are domain writes and run through it.
 */
export function createQueueDriver(config: QueueConfig, appPool: DbPool): QueueDriver {
  switch (config.driver) {
    case "postgres":
      return createPostgresQueueDriver(config.databaseUrl, appPool);
  }
}
