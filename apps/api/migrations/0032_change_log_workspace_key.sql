-- A change id is unique within its workspace, not across all of them (#513).
--
-- Migration 0020 made `id` alone the primary key, and the sync upload inserted with
-- ON CONFLICT (id) DO NOTHING. A uniqueness check sees every row, Row-Level Security or not, so a
-- client that reused another workspace's change id had its change applied but silently not
-- recorded (its other devices never received it), and the outcome it got back said whether that
-- foreign id existed. With the key on (workspace_id, id), each workspace's change ids are its own:
-- the same id in two workspaces is two unrelated changes, and nothing one workspace sends can
-- collide with, or learn about, another's.
ALTER TABLE change_log DROP CONSTRAINT change_log_pkey;
ALTER TABLE change_log ADD CONSTRAINT change_log_pkey PRIMARY KEY (workspace_id, id);

-- What the upload answered when the change was first received, so a retry of the same change
-- (same workspace, same id) answers the same, instead of `stale` against itself. Only accepted
-- changes are recorded, so only these two outcomes exist here.
ALTER TABLE change_log ADD COLUMN outcome text;

-- Rows recorded before this migration did not keep their outcome. A change was applied unless a
-- change to the same field with a clock at least as late had been received by then; changes
-- received in the same request share one received_at and their order among themselves is lost,
-- so one of those with an equal or later clock counts as received first. Best effort, and only
-- ever read back by a retry of such an old change.
UPDATE change_log c
SET outcome = CASE
  WHEN EXISTS (
    SELECT 1 FROM change_log p
    WHERE p.workspace_id = c.workspace_id
      AND p.entity_id = c.entity_id
      AND p.field_name = c.field_name
      AND p.id <> c.id
      AND p.received_at <= c.received_at
      AND (p.hlc_physical, p.hlc_counter, p.device_id) >= (c.hlc_physical, c.hlc_counter, c.device_id)
  ) THEN 'stale'
  ELSE 'applied'
END;

ALTER TABLE change_log ALTER COLUMN outcome SET NOT NULL;
ALTER TABLE change_log ADD CONSTRAINT change_log_outcome_check CHECK (outcome IN ('applied', 'stale'));
