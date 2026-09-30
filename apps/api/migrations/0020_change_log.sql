-- Field-level sync (design.md, "Field-level change protocol"; #42): each change is a single
-- field, on a single entity, at a single hybrid logical clock (HLC) instant. `field_name` folds
-- in which kind of entity this is about ("transactions.memo"), matching the record shape design.md
-- and #42 give literally (entity id, workspace, field name, clock, device, value) — no separate
-- entity_type column. Deletion is a field like any other ("deleted" = true), resolved by the
-- same last-write-wins rule as any other field, never a special case.
--
-- `id` has no default: design.md says it is "generated on the device", and "sending it again
-- never creates duplicates" — the id itself is the idempotency key a repeated network retry
-- relies on (apps/api/src/sync/repository.ts inserts with ON CONFLICT (id) DO NOTHING).
CREATE TABLE change_log (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  entity_id uuid NOT NULL,
  field_name text NOT NULL,
  hlc_physical bigint NOT NULL,
  hlc_counter integer NOT NULL,
  device_id text NOT NULL,
  -- Plaintext in a plaintext workspace, ciphertext in an encrypted one (design.md): the server
  -- never needs to read this to resolve a conflict, so one generic column serves both.
  value jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- "Each device downloads the changes that arrived after the last clock value it has seen"
-- (design.md) — the changes-since-clock endpoint's own query (#44).
CREATE INDEX change_log_workspace_hlc_idx ON change_log (workspace_id, hlc_physical, hlc_counter, device_id);
-- "For each field, the most recent change wins" (design.md) — applying an incoming change
-- (#43) needs the latest row for the same entity/field to compare its HLC against.
CREATE INDEX change_log_entity_field_idx ON change_log (workspace_id, entity_id, field_name);

ALTER TABLE change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_log FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON change_log
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

-- Append-only, like audit_log (migration 0009): a change record is never edited or deleted
-- once received, only superseded by a later one.
GRANT SELECT, INSERT ON change_log TO envelope_app;
