-- A user must be able to list every workspace they belong to, not just the one the current
-- request happens to be scoped to (#50, the workspace switcher). Migration 0008 already gave
-- `memberships` exactly this allowance ("find which workspaces am I in, before app.workspace_id
-- is even known"); `workspaces` itself still only allowed `id = app_workspace_id()`, so joining
-- the two to read a workspace's own name returned nothing without a workspace already chosen.
--
-- Read-only: WITH CHECK is left exactly as strict as before (an insert or update still needs
-- app.workspace_id to match that one row); only the USING (read) clause gains the
-- membership-based OR, mirroring memberships' own policy shape.
ALTER POLICY workspace_isolation ON workspaces
  USING (
    id = app_workspace_id()
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = workspaces.id AND m.user_id = app_user_id())
  );
