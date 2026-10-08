# 0010 — A third RLS session variable for periodic jobs that must enumerate every workspace

- **Status:** accepted
- **Date:** 2026-10-08

## Context

ADR 0006 gates every workspace-scoped table on two session variables, `app.user_id` and `app.workspace_id`, both set once per request after checking the caller's own membership. `workspaces` itself (migration 0008, extended by 0022) only ever allows a row matching one of those — the current workspace, or one the current user belongs to.

`#38` ("scheduled transactions fire automatically") needs a periodic job — `queue.schedule`, run on a cron, not triggered by any one request — that materializes every scheduled transaction whose own due date has arrived, in each workspace's own time zone. That job has no request to derive `app.user_id`/`app.workspace_id` from: it must first find every workspace there is, then work through them one at a time, setting `app.workspace_id` to each in turn (the same `set_config` convention `notifications/budget-recompute-job.ts` already established for the budget-recompute job, itself a job with no request context, but one that at least already knows its one workspace from the data it was enqueued with). Reading `workspaces` unscoped is blocked by RLS, same as every other workspace-scoped table — correctly so, since neither existing allowance applies to a job acting on behalf of no one user and no one workspace in particular.

This is not a one-off need: design.md's own "monthly check" (the portfolio's rebalancing/threshold job) and `#40`'s own notification sweep will eventually need the same thing — a periodic job enumerating every workspace to act on, each at its own pace.

## Decision

- A third RLS session variable, `app.is_system_job` (a boolean, read through `app_is_system_job()`, the same `nullif(current_setting(...), '')`-guarded pattern `app_workspace_id()`/`app_user_id()` already use so an unset session fails closed rather than erroring).
- `workspaces`' own read policy gains one more allowance: `OR coalesce(app_is_system_job(), false)`. Nothing else changes — `WITH CHECK` (insert/update) stays exactly as strict as before, and no other table's policy is touched, since a periodic job still needs to pick one workspace at a time and set `app.workspace_id` to it before touching anything workspace-scoped, exactly like `budget-recompute`'s own job already does.
- Only the job handler that genuinely needs to enumerate every workspace sets it (`scheduled-transactions/fire-job.ts`), inside its own transaction, for the duration of that one job delivery. Ordinary request-handling code never does — a bug in a request handler still cannot read across workspaces, which is the entire point of RLS being a second line of defense (design.md, "Isolation"): this is an explicit, narrow, grep-able opt-in for a kind of code that is not a request handler at all, not a general bypass.

## Discarded alternatives

- **`BYPASSRLS` on `envelope_app`.** Defeats RLS's own purpose outright: a bug in any ordinary request-handling query would then also silently read across every workspace, exactly what ADR 0006 exists to rule out.
- **A separate role for background jobs, with `BYPASSRLS`.** Narrower than granting it to `envelope_app` directly, but still an unconditional bypass for everything that role's connection ever does, not just the one "list every workspace" query a periodic job actually needs — and it would need its own connection string/credentials wired through `main.ts` for no real benefit over a session variable the existing connection already carries.
- **A `SECURITY DEFINER` function returning workspace ids.** Works, but hides the bypass inside a function body rather than a policy clause sitting right next to the other two allowances `workspaces` already has — harder to audit at a glance that it is exactly as narrow as intended.

## Consequences

- Any future periodic job that must enumerate every workspace (the portfolio's monthly check, `#40`'s notification sweep) reuses the same `app_is_system_job()` allowance, rather than inventing its own.
- `workspaces` now has three ways to read a row (current workspace, a membership, a system job); each is documented at its own migration (0008, 0022, 0023) rather than only here, so `apps/api/migrations/README.md`'s own per-file description stays the first place to look.
- A job handler that forgets to also set `app.workspace_id` before querying a workspace-scoped table after enumerating workspaces gets exactly the same RLS failure (zero rows, not an error) any other missing-context bug would — this ADR only widens `workspaces`' own policy, nothing else.
