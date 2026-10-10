# UX and visual design (#70)

The reference for every 0.1.7 screen, so every other issue in this milestone can stay generic about layout, interaction and visuals. Open the mockups in [`mockups/`](mockups/) in a browser; this page is the inventory, the navigation structure, the component catalog and the accessibility baseline that tie them together. The visual tokens and principles themselves are defined once in [`docs/design.md`, "User interface"](../design.md#user-interface) — this page does not repeat them, only indexes what draws on them.

## Screen inventory

| Screen | Mockup | Covers (0.1.7 issue) |
| --- | --- | --- |
| Sign-in | [`sign-in.html`](mockups/sign-in.html) | #49 |
| Workspace switcher | part of the band in [`budget-month.html`](mockups/budget-month.html) and every other mockup | #50, #343 (which workspace "/" picks after sign-in) |
| Accounts | its own standalone screen, not `account-register.html`'s own stale sidebar (`#323` retired that layout; the mockup was never redrawn — see "Known gaps" in `apps/web/README.md`); listing, closing and each one's own balance (`#333`) composed from the workspace-settings account list in [`settings-first-run.html`](mockups/settings-first-run.html), and the phone list from `account-register.html`'s own `.ph-acc`; "+ Add account" from the same mockup's first-account onboarding step | #51, #333 |
| Categories and groups | shown as the budget month's bars, [`budget-month.html`](mockups/budget-month.html); listed, created, archived and reordered in the workspace-settings "Categories" tab, [`settings-first-run.html`](mockups/settings-first-run.html) | #52 |
| Budget month | [`budget-month.html`](mockups/budget-month.html) | #53 covers the band, timeline, "To do" and bars (no editing yet); the row detail and side sheet states are `#55`–`#57`, `#217`; the phone layout is `#331`; its own central quick-entry button is `#367` |
| Transaction entry and list | [`account-register.html`](mockups/account-register.html) | #54 (no payee autocomplete, "last used category" hint, or live available-amount preview); the timeline, "To do" list and projected balance are `#337`; "Reconcile" opens `ReconciliationScreen` (`#60`); "Import" opens `ImportScreen` (`#59`) |
| Quick expense entry (phone) | `account-register.html`'s own `qeHtml()` | #367 (`QuickEntryOverlay.tsx`; "Where" is a plain text field, not the mockup's own fixed suggested-payee chips — no frequent-payee memory exists anywhere in the app yet) |
| Quick assign and targets | side sheet states "Quick assign" / "Targets" / "Target editor", [`budget-month.html`](mockups/budget-month.html) | #55 (quick assign has no live preview, and only 5 of the mockup's 6 modes — "cover scheduled" has no endpoint yet) |
| Move money between categories | side sheet state "Assign / Move money", [`budget-month.html`](mockups/budget-month.html) | #56 |
| Credit card payment category | the payment category's row detail, [`budget-month.html`](mockups/budget-month.html) | #57 |
| Days of buffer | in the band, [`budget-month.html`](mockups/budget-month.html) | #58 |
| CSV/OFX import | [`import-reconciliation.html`](mockups/import-reconciliation.html) | #59 (`ImportScreen.tsx`; a staged row's payee is read-only — no endpoint edits one before confirming — and one with no category, income or transfer chosen stays staged rather than importing uncategorized, unlike the mockup's own simulated `doImport()`, since `packages/core` rejects an uncategorized transaction outright) |
| Reconciliation | [`import-reconciliation.html`](mockups/import-reconciliation.html) | #60 (`ReconciliationScreen.tsx`; ticking a pending transaction marks it cleared right away rather than only flipping local state, and the adjustment action has a small category picker the mockup itself does not draw, since design.md requires one) |
| Instant notifications and unresolved problems | the "To do" list and the toast, [`budget-month.html`](mockups/budget-month.html) | #61 (the toast fires for a newly-arrived budget problem only, not the mockup's own wider per-action confirmations with undo; the mockup's own "Notifications" settings tab, per-workspace preferences, is part of the fuller account-settings screen deferred to 0.1.8 — a single band-level on/off toggle stands in for now) |
| Scheduled transactions panel | side sheet state "Scheduled", the reservation lines on the bars and the dashed marks on the timeline, [`budget-month.html`](mockups/budget-month.html) | #217 |
| Settings and first run | [`settings-first-run.html`](mockups/settings-first-run.html) | the "Categories" tab lands early, with #51/#52; the rest is (0.1.8 and later) |
| Portfolio | [`portfolio.html`](mockups/portfolio.html) | (0.2.x) |

Sign-in is the one screen this issue adds: every other screen above already had a mockup before 0.1.7 started. A screen whose 0.1.7 issue is not in this table has no mockup yet — stop and ask for one, or propose it in its own pull request (`CLAUDE.md`).

## Navigation structure

- **Desktop.** A mariner band across the top of every screen: the wordmark, primary navigation (Budget, Accounts, Portfolio), the workspace switcher and the user menu with settings. There is no sidebar; the account list belongs to the Accounts screen. The budget month adds its own second line to the band (month arrows, unassigned money with Assign, reserved, assigned to future months, days of buffer) and, under the band, the timeline, "To do", filter tabs (All, Underfunded, Overspent, With money) and the action toolbar (Summary, Targets, Scheduled, Quick assign, Move money, Undo). A category's detail opens in its own row; month-wide tools (group, summary, targets, scheduled, quick assign, move money, the target editor) open in a side sheet. Neither navigates to a URL of its own.
- **Phone.** A tab bar: Budget, Accounts, a central quick-entry button, Portfolio, More. A screen's own detail (a category, a transaction) opens full screen with a back link, never a side sheet. There is no group summary screen on the phone (design.md). The budget month's own tab bar (`#331`) has Budget, Accounts, the central quick-entry button (`#367`, hidden for a `read_only` member) and More — Portfolio has no screen yet, the same reasoning the desktop nav already applies to it.
- **Sign-in.** Its own unauthenticated route, outside the band/tab-bar chrome entirely: before a session exists there is no workspace to navigate.
- **Choosing a workspace.** "/" picks one in order: the URL already names one, otherwise the last workspace this browser remembers for the signed-in person (#343, a browser-side preference, forgotten if that workspace is no longer reachable), otherwise the only workspace when there is exactly one, otherwise the picker — shown only then, not on every sign-in.
- **Settings.** Reached from the user menu (your account) or the workspace switcher (workspace settings), not from primary navigation — they are destinations, not sections a user browses through day to day.

## Visual style

Colour tokens, typography, spacing and the principles (shapes, not columns; quiet surfaces; colour marks problems) are defined once in [`docs/design.md`, "User interface"](../design.md#user-interface); every mockup in `mockups/` uses the same CSS custom properties (`--desk`, `--paper`, `--band`, `--ink`, `--pen`, `--bar`, `--spent`, `--red`, `--amber`...), so copying them from any existing mockup keeps a new screen consistent automatically. Do not invent new colours, fonts or shadows.

### Reusable components

Extracted from patterns already repeated across the mockups — name them this way in code, not by a mockup's own shorthand CSS class:

| Component | What it is | Where it already appears |
| --- | --- | --- |
| Primary / quiet / danger button | Solid `pen`-coloured action; a bordered, low-emphasis variant; a `red`-bordered destructive one | Every mockup |
| Meter | A thin bar with a label showing progress toward a target or coverage of debt | Budget month category/card rows |
| Status line | A short, icon-led line under a row's name (a target's status, a reservation, a debt) | Budget month category rows |
| Count badge | A small, coloured number (red for overspent, amber for underfunded) on a group row or a filter tab | Budget month table, toolbar |
| Band | The mariner header: navigation, workspace switcher, user menu; on the budget month also the month and unassigned money | Every mockup |
| Category bar | Track = what a category was given; spent, reserved and available inside; overspending or an uncovered reservation past the end; a payment category draws its debt | Budget month |
| Timeline | The month's days as a line, outflows below, income above, dashed when still to come, a "today" line | Budget month (desktop and phone), account register (desktop) |
| To-do list | What needs attention, each with its amount and one action (Open, Record, Fund, Mark, Reconcile) | Budget month (desktop and phone), account register (desktop and phone) |
| Toast | A one-line confirmation after an action, with an optional "Undo" | Budget month, account register |
| Row detail | A category's detail opened in place under its bar, in columns, closed with "× Close", the row again, or Esc (desktop); full screen, replacing the list, closed with a "← Budget" back link instead (phone, `#331`) | Budget month |
| Side sheet | A fixed-width sheet on the right for month-wide tools and forms, closed with "× Close", the same button again, or Esc | Budget month, account register |
| Tab bar (in-page) | `role="tablist"`/`role="tab"` pair switching a view without navigating (e.g. desktop/phone preview, pending/cleared/all) | Every mockup |
| Toggle | An `aria-pressed` button pair (a view switch, a filter) | Every mockup |

### Translation keys, not literal text (ADR 0004)

Mockups show the Italian translation as literal strings because they have no build step; real screens never do. Every string a component or screen needs is a stable, dot-namespaced key resolved through the catalog, for example:

- `signIn.tagline`, `signIn.action`, `signIn.error.generic` (the lead sentence; the technical detail below it is the identity provider's own untranslated message, not a key of its own — `#49`)
- `workspacePicker.tagline`, `workspacePicker.empty`, `workspaceSwitcher.label` (`#50`)
- `budgetMonth.unassigned.title`, `budgetMonth.category.reserved` (`{amount}`, `{payee}`, `{date}` as ICU MessageFormat variables)
- `common.action.close`, `common.action.undo`

Namespace by screen first (`signIn.*`, `budgetMonth.*`), and `common.*` for anything genuinely shared (Close, Undo, Save, Cancel). `packages/core` still never produces any of this text (ADR 0004); a `ValidationError`'s `code` maps to its own key (e.g. `errors.invalid_amount`), chosen by the UI, not the core.

## Accessibility baseline

Already the convention in every mockup; keep it when a screen becomes real code:

- **Contrast.** Every token pair used for text on a background meets WCAG 2.2 AA in both themes (`docs/design.md`'s own table is already checked to that level — do not substitute an unchecked colour).
- **Keyboard.** Every control is reachable by Tab, with a visible focus ring; a row detail, side sheet or full-screen detail closes with Esc; touch targets are at least 44 px.
- **Live regions.** A toast or an inline error uses `role="status"` (informational) or `role="alert"` (needs attention), `aria-live="polite"`, not a silent DOM change.
- **Toggles and tabs.** A pressed state (a filter, a view switch, a theme) is `aria-pressed`; a real tab strip is `role="tablist"`/`role="tab"`/`role="tabpanel"`, associated by `aria-controls`/`aria-labelledby`.
- **Current location.** The active item in primary navigation carries `aria-current="page"`.
- **Decoration.** A purely decorative icon or wordmark is `aria-hidden="true"`; the text next to it, not the icon, carries the meaning.
- **Disclosure.** A collapsed group or an expandable section is `aria-expanded`, and its own label, not just the layout, says what it reveals.

## Screens still to design

Invitations (joining an existing workspace) — not needed by any 0.1.7 issue; design it, with its own mockup, when the workspace-settings work that needs it starts.
