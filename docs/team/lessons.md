# Lessons

Traps the agent team has hit, and what to do about them, so that the next agent does not hit them again ([Work with the agent team](../how-to/work-with-the-agent-team.md#team-memory)). Every agent reads the entries tagged `[all]` and those tagged with its own role before it starts.

- **Format:** `- **[<role>|all] <the trap>.** <What to do>. (<date>, #<issue>; promote to: <file>)`, where the file is the definition or guide the lesson belongs in for good.
- **Ageing:** the pull request that fixes the cause, or moves the lesson into its target file for good, deletes the entry. At each release the coordinator prunes the entries nobody has hit in the last two milestones.
- **Cap:** 40 entries, about 150 lines. A longer list means lessons are not being fixed or promoted.

## Entries

- **[integrator] The automatic AI review sometimes skips a pull request without a comment, above all one that opened with conflicts.** Re-trigger it with `gh pr ready --undo` then `gh pr ready`, at most once per pull request, and say so in the report. (2026-11-21, #618; promote to: `.claude/agents/integrator.md`, done in #737; delete when #618 fixes the cause)
