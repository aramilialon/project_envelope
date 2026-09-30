/**
 * Background jobs (design.md, "Queue module"): the rest of the code never
 * imports a queue library directly, only this interface — switching drivers
 * is a new adapter (`postgres-driver.ts` today, a `rabbitmq` one later) and
 * one configuration line (`QUEUE_DRIVER`).
 */
import type { DbClient } from "../db/pool.ts";

export interface EnqueueOptions {
  /** When the job should run; defaults to as soon as a worker is free. */
  readonly runAt?: Date;
  /** A second `enqueue` with the same key, while a matching job is still pending, is ignored (no double enqueue). */
  readonly deduplicationKey?: string;
  /** How many times a failed job is retried before it is given up on. */
  readonly retryLimit?: number;
}

/**
 * `db` is a transaction opened just for this delivery (#36): the module has already inserted
 * this job's id into `processed_jobs` inside it, so whatever the handler writes through `db`
 * commits or rolls back together with that idempotency marker, in one step.
 */
export type JobHandler<T> = (data: T, db: DbClient) => Promise<void>;

export interface QueueDriver {
  /**
   * Queues a job, returning its id (or `null` if `deduplicationKey` matched a job already
   * pending). Given `db` (a request's own transaction client), the job commits or rolls back
   * together with whatever data triggered it — the same connection the caller is already
   * inside, not a second one (#35's own concern is wiring this into specific write paths).
   */
  enqueue<T extends object>(jobType: string, data: T, options?: EnqueueOptions, db?: DbClient): Promise<string | null>;
  /** Registers a periodic job (a cron expression), such as the monthly portfolio check. */
  schedule<T extends object>(jobType: string, cron: string, data?: T): Promise<void>;
  /**
   * Registers the function that runs a job type. A repeat delivery of the same job id is
   * discarded before the handler ever runs (`processed_jobs`, #36) — job authors get this for
   * free, they never have to check it themselves.
   */
  work<T extends object>(jobType: string, handler: JobHandler<T>): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
