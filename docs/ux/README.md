# UX and visual design (#70)

The reference for every 0.1.7 screen, so every other issue in this milestone can stay generic about layout, interaction and visuals. Open the mockups in [`mockups/`](mockups/) in a browser; this page is the inventory, the navigation structure, the component catalog and the accessibility baseline that tie them together. The visual tokens and principles themselves are defined once in [`docs/design.md`, "User interface"](../design.md#user-interface) — this page does not repeat them, only indexes what draws on them.

## Screen inventory

| Screen | Mockup | Covers (0.1.7 issue) |
| --- | --- | --- |
| Sign-in | [`sign-in.html`](mockups/sign-in.html) | #49 |
| Workspace switcher | part of the sidebar in [`budget-month.html`](mockups/budget-month.html) | #50 |
| Accounts | ledger list and "+ Add account" in the sidebar, [`budget-month.html`](mockups/budget-month.html); full register in [`account-register.html`](mockups/account-register.html); listing and closing one composed from the workspace-settings account list in [`settings-first-run.html`](mockups/settings-first-run.html) | #51 |
| Categories and groups | shown in the budget month's own table, [`budget-month.html`](mockups/budget-month.html); listed, created, archived and reordered in the workspace-settings "Categories" tab, [`settings-first-run.html`](mockups/settings-first-run.html) | #52 |
| Budget month | [`budget-month.html`](mockups/budget-month.html) | #53 covers the table and ready-to-assign only (no editing yet); the side panel states are `#55`–`#57`, `#217` |
| Transaction entry and list | [`account-register.html`](mockups/account-register.html) | #54 (no payee autocomplete, "last used category" hint, or live available-amount preview; "Import"/"Reconcile" are `#59`/`#60`) |
| Quick assign and targets | side panel states "Quick assign" / "Targets" / "Target editor", [`budget-month.html`](mockups/budget-month.html) | #55 (quick assign has no live preview, and only 5 of the mockup's 6 modes — "cover scheduled" has no endpoint yet) |
| Move money between categories | side panel state "Assign / Move money", [`budget-month.html`](mockups/budget-month.html) | #56 |
| Credit card payment category | side panel state "Card payment category", [`budget-month.html`](mockups/budget-month.html) | #57 |
| Days of buffer | header indicator, [`budget-month.html`](mockups/budget-month.html) | #58 |
| CSV/OFX import | [`import-reconciliation.html`](mockups/import-reconciliation.html) | #59 |
| Reconciliation | [`import-reconciliation.html`](mockups/import-reconciliation.html) | #60 |
| Instant notifications and unresolved problems | "Notices" line and toast, [`budget-month.html`](mockups/budget-month.html) | #61 |
| Scheduled transactions panel | side panel state "Scheduled", [`budget-month.html`](mockups/budget-month.html) | #217 |
| Settings and first run | [`settings-first-run.html`](mockups/settings-first-run.html) | the "Categories" tab lands early, with #51/#52; the rest is (0.1.8 and later) |
| Portfolio | [`portfolio.html`](mockups/portfolio.html) | (0.2.x) |

Sign-in is the one screen this issue adds: every other screen above already had a mockup before 0.1.7 started. A screen whose 0.1.7 issue is not in this table has no mockup yet — stop and ask for one, or propose it in its own pull request (`CLAUDE.md`).

## Navigation structure

- **Desktop.** A persistent sidebar: workspace switcher at the top; primary navigation (Budget, Accounts, Portfolio); on-budget accounts as a ledger, off-budget accounts below them, "Add account"; the user menu and settings at the bottom. The budget month itself has its own secondary navigation: month arrows, filter tabs (All, Underfunded, Overspent, With money), and the action toolbar (Summary, Targets, Scheduled, Quick assign, Move money, Undo). A side panel opens over the working area for any detail (category, group, card, summary, a form) and closes back to the same screen — it never navigates to a new URL of its own.
- **Phone.** A tab bar: Budget, Accounts, a central quick-entry button, Portfolio, More. A screen's own detail (a category, a transaction) opens full screen with a back link, never a side panel. There is no group summary screen on the phone (design.md).
- **Sign-in.** Its own unauthenticated route, outside the sidebar/tab-bar chrome entirely: before a session exists there is no workspace to navigate.
- **Settings.** Reached from the user menu (your account) or the workspace switcher (workspace settings), not from primary navigation — they are destinations, not sections a user browses through day to day.

## Visual style

Colour tokens, typography, spacing and the ledger-not-dashboard principles are defined once in [`docs/design.md`, "User interface"](../design.md#user-interface); every mockup in `mockups/` uses the same CSS custom properties (`--desk`, `--paper`, `--ink`, `--pen`, `--red`, `--amber`...), so copying them from any existing mockup keeps a new screen consistent automatically. Do not invent new colours, fonts or shadows.

### Reusable components

Extracted from patterns already repeated across the mockups — name them this way in code, not by a mockup's own shorthand CSS class:

| Component | What it is | Where it already appears |
| --- | --- | --- |
| Primary / quiet / danger button | Solid `pen`-coloured action; a bordered, low-emphasis variant; a `red`-bordered destructive one | Every mockup |
| Meter | A thin bar with a label showing progress toward a target or coverage of debt | Budget month category/card rows |
| Status line | A short, icon-led line under a row's name (a target's status, a reservation, a debt) | Budget month category rows |
| Count badge | A small, coloured number (red for overspent, amber for underfunded) on a group row or a filter tab | Budget month table, toolbar |
| Notice | A single dismissible line above the table, with a "Show"-style link that applies a filter | Budget month |
| Toast | A one-line confirmation after an action, with an optional "Undo" | Budget month, account register |
| Side panel | A fixed-width panel over the working area, closed with "× Close", the same item again, or Esc | Budget month, account register |
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
- **Keyboard.** Every control is reachable by Tab, with a visible focus ring; a side panel or full-screen detail closes with Esc; touch targets are at least 44 px.
- **Live regions.** A toast or an inline error uses `role="status"` (informational) or `role="alert"` (needs attention), `aria-live="polite"`, not a silent DOM change.
- **Toggles and tabs.** A pressed state (a filter, a view switch, a theme) is `aria-pressed`; a real tab strip is `role="tablist"`/`role="tab"`/`role="tabpanel"`, associated by `aria-controls`/`aria-labelledby`.
- **Current location.** The active item in primary navigation carries `aria-current="page"`.
- **Decoration.** A purely decorative icon or wordmark is `aria-hidden="true"`; the text next to it, not the icon, carries the meaning.
- **Disclosure.** A collapsed group or an expandable section is `aria-expanded`, and its own label, not just the layout, says what it reveals.

## Screens still to design

Invitations (joining an existing workspace) — not needed by any 0.1.7 issue; design it, with its own mockup, when the workspace-settings work that needs it starts.
