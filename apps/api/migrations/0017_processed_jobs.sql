-- Idempotent job processing (design.md, "Queue module", #36): work() inserts the job id
-- here, in the same transaction as the job's own effects, before running them; a repeat
-- delivery's insert fails the unique constraint, so the job is discarded without touching
-- anything, and job authors cannot forget the check because the module does it for them.
--
-- A job id is a global concept, not a workspace one, so this table is not workspace-scoped
-- and carries no Row-Level Security: it is queue bookkeeping, not domain data.
CREATE TABLE processed_jobs (
  job_id uuid PRIMARY KEY,
  job_type text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Swept by work() itself on every delivery: rows older than 30 days, well beyond the
-- maximum retry window, are deleted, so DELETE needs a grant too (not just SELECT/INSERT).
CREATE INDEX processed_jobs_processed_at_idx ON processed_jobs (processed_at);

GRANT SELECT, INSERT, DELETE ON processed_jobs TO envelope_app;
