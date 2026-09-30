import type { QueueConfig } from "../config.ts";
import type { QueueDriver } from "./driver.ts";
import { createPostgresQueueDriver } from "./postgres-driver.ts";

export type { EnqueueOptions, JobHandler, QueueDriver } from "./driver.ts";

/** Picks the adapter named by `QUEUE_DRIVER` (design.md, "Queue module") — the only place that switches on it. */
export function createQueueDriver(config: QueueConfig): QueueDriver {
  switch (config.driver) {
    case "postgres":
      return createPostgresQueueDriver(config.databaseUrl);
  }
}
