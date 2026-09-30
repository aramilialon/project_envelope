/**
 * The `postgres` adapter (design.md, "Queue module"): pg-boss behind
 * `QueueDriver`. The only file in the codebase allowed to import "pg-boss".
 */
import { PgBoss } from "pg-boss";

import type { DbClient } from "../db/pool.ts";
import type { EnqueueOptions, JobHandler, QueueDriver } from "./driver.ts";

export function createPostgresQueueDriver(connectionString: string): QueueDriver {
  const boss = new PgBoss(connectionString);
  const knownQueues = new Set<string>();

  async function ensureQueue(jobType: string): Promise<void> {
    if (knownQueues.has(jobType)) {
      return;
    }
    // "exclusive" is the one queue policy that actually enforces a deduplicationKey/singletonKey
    // (design.md's "no double enqueue"): under the default "standard" policy pg-boss stores the
    // key but never rejects a repeat. Applied to every queue this module creates, not left for
    // each job author to opt into, per design.md: "the queue module prevents duplicate effects
    // by itself, without relying on whoever writes the job."
    await boss.createQueue(jobType, { policy: "exclusive" });
    knownQueues.add(jobType);
  }

  return {
    async start(): Promise<void> {
      await boss.start();
    },

    async stop(): Promise<void> {
      await boss.stop();
    },

    async enqueue<T extends object>(jobType: string, data: T, options: EnqueueOptions = {}, db?: DbClient): Promise<void> {
      await ensureQueue(jobType);
      await boss.send(jobType, data, {
        ...(options.runAt ? { startAfter: options.runAt } : {}),
        ...(options.deduplicationKey ? { singletonKey: options.deduplicationKey } : {}),
        ...(options.retryLimit !== undefined ? { retryLimit: options.retryLimit } : {}),
        // The caller's own transaction (#35): the job insert commits or rolls back with it,
        // pg-boss's job table doubling as the outbox, exactly as design.md describes.
        ...(db ? { db: { executeSql: (text: string, values?: unknown[]) => db.query(text, values).then((r) => ({ rows: r.rows })) } } : {}),
      });
    },

    async schedule<T extends object>(jobType: string, cron: string, data?: T): Promise<void> {
      await ensureQueue(jobType);
      await boss.schedule(jobType, cron, data ?? {});
    },

    async work<T extends object>(jobType: string, handler: JobHandler<T>): Promise<void> {
      await ensureQueue(jobType);
      await boss.work<T>(jobType, async (jobs) => {
        for (const job of jobs) {
          await handler(job.data);
        }
      });
    },
  };
}
