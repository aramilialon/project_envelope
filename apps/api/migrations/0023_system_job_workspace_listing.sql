-- A background job that runs on a schedule (#38, design.md "a scheduled job materializes a
-- real transaction on its due date") has no request of its own to derive app.workspace_id from
-- — it needs to find every workspace there is, then work through them one at a time. Neither
-- `workspaces`' own policy (migration 0008/0022: one workspace, or one the caller is a member
-- of) nor `memberships`' allows that: both still require a concrete app.user_id/app.workspace_id,
-- which a periodic, no-request job genuinely has neither of.
--
-- A third, narrow session variable for exactly this: app.is_system_job, read through the same
-- nullif(..., '')-guarded pattern app_workspace_id()/app_user_id() already use. Only the one
-- job handler that needs to enumerate every workspace ever sets it (ADR 0010); ordinary
-- request-handling code never does, so a bug there still cannot read across workspaces — the
-- whole point of RLS being a second line of defense (design.md, "Isolation") is unchanged.
--
-- Read-only, exactly like 0022: WITH CHECK (insert/update) is untouched.
CREATE FUNCTION app_is_system_job() RETURNS boolean AS $$
  SELECT nullif(current_setting('app.is_system_job', true), '')::boolean
$$ LANGUAGE sql STABLE;

ALTER POLICY workspace_isolation ON workspaces
  USING (
    id = app_workspace_id()
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = workspaces.id AND m.user_id = app_user_id())
    OR coalesce(app_is_system_job(), false)
  );
