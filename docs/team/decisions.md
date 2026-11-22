# Decisions awaiting the maintainer's review

The agent team takes decisions without asking the maintainer, on the recommendation of the role that owns each question ([Work with the agent team](../how-to/work-with-the-agent-team.md#coordinators-working-rules)). Each one is logged here until the maintainer reviews it at the next phase deadline: the releases that close a roadmap phase (the "… MVP" milestones and `1.0.0`).

- **Format:** one line per decision, `- **#<issue>** (<date>, <role, or "coordinator alone, review it">): <decision>.`, under the review deadline and then the milestone the decision was taken in.
- **Disagreements:** a disagreement between roles, or between a role and the coordinator, that is still open goes at the top of its section, marked **disagreement**, with each position in one line.
- **Who writes:** the developer or the translator adds the entries its brief lists, on its own branch; the coordinator brings the other roles' notes in through the next branch (see "Team memory" in the guide).
- **Cleanup:** at the phase review the section is emptied through a pull request whose description gives each entry's outcome: confirmed; confirmed and moved into an ADR or the design text (named); or reversed, with the new issue that reverses it.

## Awaiting review at 0.2.7 Portfolio MVP

### 0.2.1

- **#82** (2026-11-22, domain-expert): a price is the latest one dated on or before the date, the workspace's own winning a tie; prices and exchange rates have no maximum age, and the date used is returned with the value.
- **#82** (2026-11-22, architect): `prices` has a nullable `workspace_id` (null for a shared provider price) and one Row-Level Security policy per command; shared rows are written only by a system job.
- **#82** (2026-11-22, architect): system jobs write shared market data through `app_is_system_job()` and an allowlist test, not through a new database role.
- **#82** (2026-11-22, architect): price precedence is resolved in `@envelope/core` (`resolvePrice`); SQL only loads the candidates.
- **#84** (2026-11-22, architect): screens and endpoints read only stored prices and rates, never a provider.
- **#85** (2026-11-22, architect): rates are stored as `rate_e10`, quote currency per 1 EUR as published, never inverted; other pairs are computed through the euro with one rounding.
- **#85** (2026-11-22, architect): no XML dependency for the ECB file, and the built-in `fetch`.
- **#85** (2026-11-22, domain-expert): the ECB parser checks every entry's syntax and leaves out currencies `isKnownCurrency` refuses (withdrawn ISO 4217 codes, e.g. TRL beyond the ×10^10 safe range), naming them in `skippedCurrencies`; a kept currency out of range still refuses the whole file.
- **#85** (2026-11-22, security-reviewer): the README states the one request the server makes by itself (ECB rates, on by default — maintainer decision) and the switch that turns it off.
- **#87/#88** (2026-11-22, architect): returns are computed in floating point inside, output as an integer `returnE6`, never stored.
- **#83** (2026-11-22, architect): prices are not a sync entity in 0.2.1; a future entity id is derived from (workspace, instrument, date).
- **#83** (2026-11-22, architect): one audit entry per manual price write, one summary entry per CSV import.
- **#89** (2026-11-22, architect): the performance range is capped at 120 months, computed on read, with no cache.
- **#89** (2026-11-22, architect): #89 depends on #719.
- **#89** (2026-11-22, architect): a month with nothing held reports both returns as null with `no_capital` through the existing reason fields; no fallback percentage and no new response field; the money-weighted return takes the same valuations (flow dates and month ends) as the time-weighted one.
- **#89** (2026-11-22, domain-expert; maintainer asked): a period with nothing held at the end of any day it is valued on has no return (`no_capital`, both TWR and MWR) and shows only its gain; no substitute percentage (gain ÷ previous value or ÷ money put in) is added, since gain is already after costs and those ratios are undefined or −100% in exactly those months.
- **#89** (2026-11-22, domain-expert): the MWR's clock starts on the first day held (earlier flows carried forward to it) and ends at the last money received (later payments discounted back to it); a period of no length is end ÷ the net money put in − 1; the root nearest 0 is taken when several rates balance the flows; the TWR's clock adds up only the stretches while something is held, a gap in the middle of a range included.
- **#89** (2026-11-22, domain-expert): a same-day round trip (bought and sold on one day) shows a gain but no return, because the portfolio is valued at the end of each day.
- **#596** (2026-11-22, architect; domain-expert confirms): untimed trades in histories that local-midnight ordering would reorder get `occurred_at` = UTC midnight of their date by a repair migration (0038), which keeps the replay order, positions and cost basis they had; rejected: a release note only, a fail-loud check, accepting the change.
- **#719** (2026-11-22, architect): the positions answer carries no list or count of trades dated after `asOf`; how later trades show is decided with the portfolio dashboard (#106, 0.2.4) and its mockup.
- **#782** (2026-11-22, domain-expert): negative income in a later month is left out of an earlier month's unassigned calculation item by item, not as the month's net; a later month's positive income still pays its own assignments.
- **#660** (2026-11-22, domain-expert): budget problems flag a payment category only beyond its card's credit (same figure as `cashOverspending`).
- **#505** (2026-11-22, architect): a workspace's private instruments live under `/workspaces/:workspaceId/instruments`; GET by id there also returns a shared instrument, and another workspace's private one is a 404.
- **#505** (2026-11-22, architect): a private instrument carries no ISIN, ticker or exchange, so the shared catalog's unique indexes can never answer a 409 that reveals another workspace's holdings.
- **#505** (2026-11-22, architect): every instrument response carries `workspaceId` (`null` for a shared instrument).
- **#505** (2026-11-22, architect): a private instrument's name is unique per workspace, ignoring case, after trimming (409 `name_taken`).
- **#505** (2026-11-22, architect): a workspace-scoped instrument search is deferred to #789.

### 0.2.0

- **#701** (2026-11-21, coordinator alone, review it): a goal amount above the cap is refused with `amount_too_large`, like every other amount (ADR 0002, #651).
- **#698** (2026-11-21, coordinator alone, review it): an assigned amount already above the cap can still be brought down from the Assigned field (proposed by the developer).
- **#702** (2026-11-21, coordinator alone, review it): every row dated after today goes under "Later", the current month included.
- **#702** (2026-11-21, domain-expert): positions as of today are a follow-up of their own, #719.
- **#702** (2026-11-21, domain-expert): repeating scheduled occurrences are a follow-up of their own, #720.
- **#699** (2026-11-21, domain-expert and ux-reviewer): a card row reads "{toCover} to cover: {debt} of debt and {paidBeyond} paid beyond what was set aside".
- **#699** (2026-11-21, domain-expert): quick assign covers the whole amount to cover (`toCover`).
- **#699** (2026-11-21, qa): the bar for a card's cash overspending is a follow-up of its own, #726.
- **#729** (2026-11-21, architect): a sync change refused because its account is closed gets its own outcome, `account_closed`.
- **#729** (2026-11-21, architect): an import confirmation that touches a closed account is refused as a whole.
- **#728** (2026-11-21, translator): the Italian message for a card's spending against its budget (`budget.bar.spentWithCardOf`) puts its arguments in a different order from the English.
- **#705** (2026-11-21, domain-expert): closing a credit card requires its payment category to be settled, whether it is above or below zero; a closed card's payment category takes no assignments and leaves the current and later months, and stays in past months so their figures do not change.

### 0.2.1

- **#758** (2026-11-22, architect): the product-marketer gets Read, Grep, Glob, WebSearch and WebFetch only, with no shell; screens stay with the ux-reviewer; public-text wording is recommended by the marketer and decided by the coordinator after the domain-expert (money) and security-reviewer (security, privacy) checks; name, identity and tokens go to the maintainer.
- **#758** (2026-11-22, security-reviewer): WebSearch is allowed globally and WebFetch for a fixed list of exact public reference hosts; the rules apply to every agent; hosts where anyone can publish content (*.github.io, raw and gist hosts, paste, file and shortener services, web archives, translation proxies) are never added; WebFetch to localhost, 127.0.0.1, ::1, 10.0.0.11 and 169.254.169.254 is denied.
- **#777** (2026-11-22, architect): the installer is confined by its tools list (a single-tool MCP server running commands only inside its sandbox), not by Bash allow patterns; reading outside the manuals is allowed but always reported as a finding; getting-started stays user-facing until the 0.4.0 install guide.
- **#777** (2026-11-22, maintainer confirmed): the sandbox's host firewall goes beyond the planned `DOCKER-USER` drops to the private ranges: it also drops everything from the sandbox bridge to the host itself (`INPUT`, IPv4 and IPv6) and all forwarded IPv6 from the bridge, since `DOCKER-USER` never sees traffic to the host's own addresses and a privileged sandbox could re-enable IPv6.
- **#777** (2026-11-22, coordinator): the installer's commands run in an interactive login shell (`bash -lic`) so a manual's `~/.bashrc` lines take effect as for a real user, with only the two known startup lines dropped from stderr; `sudo` is typed with `sudo -S` and the sandbox's dev password; `qa` reproduces installer findings in a sandbox of its own, one sandbox at a time, through the sandbox MCP tool (security-reviewer: never through quoted host-shell commands); agents without a tools list disallow that tool.
- **#618** (2026-11-22, architect): moved up from wave 9 to now; the fix is checked on the PRs that follow it, since the review workflow cannot prove itself on its own PR.
- **#655** (2026-11-22, architect): PATCH occurredAt takes a date only while create still takes an instant; accountId in a PATCH body is 400 unknown_field for every transaction, a trade's cash leg included; editing or deleting through an account that does not hold the transaction answers 404; invalid_body, unknown_field and invalid_field are the shared request-shape codes that #713 reuses and #663 lists.
- **#87/#88/#89** (2026-11-22, domain-expert): a portfolio holds securities only; its flows are minus its trades' cash legs plus the market value of securities moved in or out; TWR is valued at each flow day (not Modified Dietz); a missing price makes a figure unknown, never 0.
- **#87/#88** (2026-11-22, domain-expert): a figure is yearly once the period reaches its first anniversary; year fraction = whole anniversaries + days since the last ÷ days to the next (not Actual/365); MWR bounds apply to the figure shown (period rate under a year), nothing received back = −100%; TWR sub-periods holding nothing at either end contribute 1.
- **#668** (2026-11-22, domain-expert): every positive split dated after today counts nowhere until its date, per split; negative splits count at once.
- **#662** (2026-11-22, architect): an error's `details.tradeId` names a stored trade, or is `null` for a row the request itself adds, never an id the server made up; the one exception is 409 `id_taken`, which echoes the client id sent.
- **#662** (2026-11-22, architect): a position's quantity leaving the safe range is 400 `invalid_quantity` with `{ label: "positionQuantity", value, tradeId, accountId, portfolioId }`, naming the trade that pushes it over.
- **#594** (2026-11-22, architect): a field of another kind of trade request is `invalid_trade` naming it (per type, from `TRADE_REQUEST_FIELDS`), a field no trade request has is `unknown_field`; `taxKind` on a trade other than a tax keeps its own code, `tax_kind_not_allowed_for_trade_type`.
- **#594** (2026-11-22, architect): `null` on create means the field is left out; on edit it clears the field (`occurredAt`, `memo`, a fee's or a tax's `instrumentId`).
- **#594** (2026-11-22, architect): an edit that changes nothing (`{}`, `type` alone, only `null` legs) is 400 `invalid_body`, with no audit entry.
- **#594** (2026-11-22, architect): the `details.field` names (request names such as `quantityE8` against core names such as `quantity`) are unified in #663, not here.
