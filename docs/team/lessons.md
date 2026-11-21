# Lessons

Traps the agent team has hit, and what to do about them, so that the next agent does not hit them again ([Work with the agent team](../how-to/work-with-the-agent-team.md#team-memory)). Every agent reads the entries tagged `[all]` and those tagged with its own role before it starts.

- **Format:** `- **[<role>|all] <the trap>.** <What to do>. (<date>, #<issue>; promote to: <file>)`, where the file is the definition or guide the lesson belongs in for good.
- **Ageing:** the pull request that fixes the cause, or moves the lesson into its target file for good, deletes the entry. At each release the coordinator lists the entries nobody has hit in the last two milestones and hands that list, with the go, to the integrator, whose release changelog pull request deletes them.
- **Cap:** 40 entries, about 150 lines. A longer list means lessons are not being fixed or promoted.

## Entries

- **[developer|qa|integrator] `createdb` and `psql` are not installed on the host.** Create and drop test databases inside the container: `docker exec envelope-postgres-1 createdb -U envelope <name>` (and `psql -U envelope`). (2026-11-21, #728; promote to: docs/getting-started.md)
- **[developer] A new refusal hidden behind an earlier check gives users a misleading code.** When a rule refuses a write, check it before any replay or validation that can fail for another reason, inside the same transaction. (2026-11-21, run 4 G2; promote to: .claude/agents/developer.md)
- **[developer|qa] A web action wrapped in `try/finally` without `catch` fails silently.** Every new API refusal needs a test that the screen shows its message; grep every caller of the endpoint, not only the forms. (2026-11-21, run 4 G1/H3; promote to: apps/web/README.md)
- **[qa] A refusal can pass for one request and not another because the history replay runs first.** Test requests that would also fail a domain check. (2026-11-21, #740; promote to: .claude/agents/qa.md)
- **[architect] A refusal that points at another object leaves the user stuck if it does not say which.** Give the user a way to find it: a date or an id in `details`. (2026-11-21, run 4 F5; promote to: .claude/agents/architect.md)
- **[explorer|qa] Explorers need the API reference and the test tokens.** Put docs/portfolio-api.md and apps/api/README.md in every explorer brief; the explore environment's password grant works with client `envelope-explore-cli` and the manifest's password, one token per role; reload pages before racing two tabs (open dialogs cache account and category lists). (2026-11-21, run 4; promote to: scripts/explore-env/explorer-instructions.md)
