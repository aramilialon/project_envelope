-- Idempotent creates and a unique assignment batch (#559, ADR 0020).
--
-- idempotency_keys: one row per `Idempotency-Key` header a create route accepted, kept per
-- workspace (the key's primary key starts with workspace_id: the same key sent to two workspaces
-- never collides, and a 409 never says anything about another workspace, lesson #505). The row
-- holds a fingerprint of the request (sha256 of the method, the route, the path parameters, the
-- query, the canonical body and the user) and the reply it got, so a repeat with the same key and
-- the same request gets the same reply without writing anything again.
--
-- The row is inserted when the key is claimed, before the handler runs, and its reply is filled in
-- before the reply is sent, in the same request transaction (apps/api/src/idempotency/). Only a
-- success is ever committed: a 4xx or 5xx rolls the whole request back, key included. The deferred
-- constraint trigger below refuses to commit a key whose reply was never stored, so a route that
-- forgets to store it fails instead of leaving a key that replays nothing.
--
-- A key lives at least 24 hours: an hourly system job (idempotency/sweep-job.ts, ADR 0010) deletes
-- the older ones, and an expired key claimed again is deleted and counts as new. Deleting a
-- workspace or a user deletes their keys.
CREATE TABLE idempotency_keys (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  key uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The route pattern ("/workspaces/:workspaceId/transfers"), for diagnostics; the fingerprint
  -- already covers it.
  operation text NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  -- Null only between the claim and the stored reply, inside the request's own transaction.
  response_status smallint CHECK (response_status BETWEEN 200 AND 399),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_keys_pkey PRIMARY KEY (workspace_id, key),
  CONSTRAINT idempotency_keys_reply_check CHECK ((response_status IS NULL) = (response_body IS NULL))
);

-- The sweep deletes each workspace's rows older than the lifetime.
CREATE INDEX idempotency_keys_workspace_created_at_idx ON idempotency_keys (workspace_id, created_at);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON idempotency_keys
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

-- Claim (INSERT), replay (SELECT), store the reply (UPDATE of the reply columns only), delete an
-- expired key (DELETE). Nothing else is ever changed.
GRANT SELECT, INSERT, DELETE ON idempotency_keys TO envelope_app;
GRANT UPDATE (response_status, response_body) ON idempotency_keys TO envelope_app;

-- Re-reads the row at commit rather than trusting NEW: the INSERT event's NEW still has the null
-- reply the claim inserted, even when the reply was stored afterwards in the same transaction.
CREATE FUNCTION idempotency_keys_refuse_unstored_reply() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT FROM idempotency_keys
    WHERE workspace_id = NEW.workspace_id AND key = NEW.key AND response_status IS NULL
  ) THEN
    RAISE EXCEPTION 'an idempotency key cannot be committed without the reply it got'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'idempotency_keys_reply_stored',
            TABLE = 'idempotency_keys';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER idempotency_keys_reply_stored
  AFTER INSERT OR UPDATE ON idempotency_keys
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION idempotency_keys_refuse_unstored_reply();

-- assignment_batches: makes an assignment batch id unique per workspace (ADR 0008 always meant
-- the device to generate it; ADR 0020). Every ledger row references its batch, so every writer
-- (a batch, quick assign, an undo) has to claim the batch first. request_hash is the fingerprint
-- of the request that created a batch with a client-chosen id: a repeat with the same request
-- replays the batch's rows, a different one is 409 id_conflict. It is null for a batch whose id
-- the server generated, and for every batch from before this migration, so reusing one of those
-- ids is always a conflict.
CREATE TABLE assignment_batches (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id uuid NOT NULL,
  request_hash bytea CHECK (octet_length(request_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assignment_batches_pkey PRIMARY KEY (workspace_id, id)
);

ALTER TABLE assignment_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON assignment_batches
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

-- A register of ids, append-only like the ledger it guards.
GRANT SELECT, INSERT ON assignment_batches TO envelope_app;

-- row_security is turned off for this migration's transaction (ADR 0006, as migrations 0029, 0037
-- and 0038): under FORCE ROW LEVEL SECURITY a migrating role that is neither superuser nor
-- BYPASSRLS would see no ledger rows, backfill nothing, and then fail on the foreign key below.
SET LOCAL row_security = off;

-- One batch per distinct (workspace, batch id) already in the ledger. Every id so far was made by
-- the server (randomUUID), so none collides.
INSERT INTO assignment_batches (workspace_id, id, created_at)
SELECT workspace_id, batch_id, min(created_at)
FROM assignment_ledger
GROUP BY workspace_id, batch_id;

-- The order of the request's entries, so a replayed batch returns its rows in that order. Null on
-- every row from before this migration (the ledger is append-only: no row is updated).
ALTER TABLE assignment_ledger ADD COLUMN batch_position smallint CHECK (batch_position >= 0);

-- NO ACTION, not RESTRICT: deleting a workspace cascades to both tables, and NO ACTION checks only
-- at the end of the statement, once the ledger rows are gone too.
ALTER TABLE assignment_ledger ADD CONSTRAINT assignment_ledger_batch_id_fkey
  FOREIGN KEY (workspace_id, batch_id) REFERENCES assignment_batches (workspace_id, id);
