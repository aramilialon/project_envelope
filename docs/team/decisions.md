# Decisions awaiting the maintainer's review

The agent team takes decisions without asking the maintainer, on the recommendation of the role that owns each question ([Work with the agent team](../how-to/work-with-the-agent-team.md#coordinators-working-rules)). Each one is logged here until the maintainer reviews it at the next phase deadline: the releases that close a roadmap phase (the "… MVP" milestones and `1.0.0`).

- **Format:** one line per decision, `- **#<issue>** (<date>, <role, or "coordinator alone, review it">): <decision>.`, under the review deadline and then the milestone the decision was taken in.
- **Disagreements:** a disagreement between roles, or between a role and the coordinator, that is still open goes at the top of its section, marked **disagreement**, with each position in one line.
- **Who writes:** the developer or the translator adds the entries its brief lists, on its own branch; the coordinator brings the other roles' notes in through the next branch (see "Team memory" in the guide).
- **Cleanup:** at the phase review the section is emptied through a pull request whose description gives each entry's outcome: confirmed; confirmed and moved into an ADR or the design text (named); or reversed, with the new issue that reverses it.

## Awaiting review at 0.2.7 Portfolio MVP

### 0.2.0

- **#701** (2026-11-21, coordinator alone, review it): a goal amount above the cap is refused with `amount_too_large`, like every other amount (ADR 0002, #651).
- **#698** (2026-11-21, developer): an assigned amount already above the cap can still be brought down from the Assigned field.
- **#702** (2026-11-21, coordinator alone, review it): every row dated after today goes under "Later", the current month included.
- **#702** (2026-11-21, domain-expert): positions as of today are a follow-up of their own, #719.
- **#702** (2026-11-21, domain-expert): repeating scheduled occurrences are a follow-up of their own, #720.
- **#699** (2026-11-21, domain-expert and ux-reviewer): a card row reads "{toCover} to cover: {debt} of debt and {paidBeyond} paid beyond what was set aside".
- **#699** (2026-11-21, domain-expert): quick assign covers the whole amount to cover (`toCover`).
- **#699** (2026-11-21, qa): the bar for a card's cash overspending is a follow-up of its own, #726.
- **#729** (2026-11-21, architect): a sync change refused because its account is closed gets its own outcome, `account_closed`.
- **#729** (2026-11-21, architect): an import confirmation that touches a closed account is refused as a whole.
- **#728** (2026-11-21, translator): the Italian message for a card's spending against its budget (`budget.bar.spentWithCardOf`) puts its arguments in a different order from the English.
