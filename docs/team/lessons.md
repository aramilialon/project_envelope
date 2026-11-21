# Lessons

Traps the agent team has hit, and what to do about them, so that the next agent does not hit them again ([Work with the agent team](../how-to/work-with-the-agent-team.md#team-memory)). Every agent reads the entries tagged `[all]` and those tagged with its own role before it starts.

- **Format:** `- **[<role>|all] <the trap>.** <What to do>. (<date>, #<issue>; promote to: <file>)`, where the file is the definition or guide the lesson belongs in for good.
- **Ageing:** the pull request that fixes the cause, or moves the lesson into its target file for good, deletes the entry. At each release the coordinator lists the entries nobody has hit in the last two milestones and hands that list, with the go, to the integrator, whose release changelog pull request deletes them.
- **Cap:** 40 entries, about 150 lines. A longer list means lessons are not being fixed or promoted.

## Entries

- **[developer|qa|integrator] `createdb` and `psql` are not installed on the host.** Create and drop test databases inside the container: `docker exec envelope-postgres-1 createdb -U envelope <name>` (and `psql -U envelope`). (2026-11-21, #728; promote to: docs/getting-started.md)
