-- The queue module's own connection role (design.md, "Queue module"; #34).
--
-- pg-boss manages its own `pgboss` schema with dynamic DDL (a job table per
-- queue, created as queues are registered), so unlike every other table in
-- this repository it cannot be captured as a fixed migration: pg-boss itself
-- runs that DDL, at startup and whenever a new queue is created.
--
-- `envelope_app` (ADR 0006) has no DDL privilege at all, by design, and
-- extending it to cover this would widen the blast radius of the one
-- connection every request already uses. `envelope_queue` is a second,
-- separate role instead, scoped to exactly what pg-boss needs to manage its
-- own schema (CREATE on the database, so it can `CREATE SCHEMA pgboss`) and
-- nothing about the domain tables `envelope_app` covers.
--
-- Like `envelope_app`, it has no LOGIN and no password yet: given one out of
-- band, the same way (see docs/getting-started.md), never in a migration or
-- in the repository.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'envelope_queue') THEN
    CREATE ROLE envelope_queue NOSUPERUSER NOLOGIN;
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO envelope_queue', current_database());
END
$$;
