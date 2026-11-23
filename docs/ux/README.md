# UX and visual design (#70)

The reference for every 0.1.7 screen, so every other issue in this milestone can stay generic about layout, interaction and visuals. Open the mockups in [`mockups/`](mockups/) in a browser; this page is the inventory, the navigation structure, the component catalog and the accessibility baseline that tie them together. The visual tokens and principles themselves are defined once in [`docs/design.md`, "User interface"](../design.md#user-interface) — this page does not repeat them, only indexes what draws on them.

## Language of the mockups

The mockups are in English, the source language of every interface string, from #622 on ([ADR 0015](../adr/0015-english-first-translations.md)); the other languages are written from that copy by the `translator` agent. Until then they were in Italian. Italian copy approved before this change: `git show be8c552:docs/ux/mockups/<file>` (`be8c552` is the last commit with Italian mockups). It is the source for `packages/i18n/locales/it.json` on the screens approved then, except where the translation glossary (`packages/i18n/glossary.md`) records a later decision.

### Copy guidance

- A refusal states the rule it applies before the facts that break it, and names every other object it points at.
- A currency named in a sentence is its name in the interface language, then its code in brackets: "US Dollar (USD)", from `Intl.DisplayNames`, never the formatting locale's. Where the runtime has no name for a code, the code alone. A count in a sentence ("2 decimal places") is a plural ICU argument, with an `=0` case where zero reads differently ("can't have decimal places").
- A type label and the rest of a line, written as plain text (a phone row, a title, an opened row), are joined by " · ": "Inflow · Unassigned", "Transfer · To ETF broker". "To" and "From" start with a capital there, as after any separator.

## Screen inventory

| Screen | Mockup | Covers (0.1.7 issue) |
| --- | --- | --- |
| Sign-in | [`sign-in.html`](mockups/sign-in.html) | #49 |
| Workspace switcher | part of the band in [`budget-month.html`](mockups/budget-month.html) and every other mockup | #50, #343 (which workspace "/" picks after sign-in) |
| Accounts | its own standalone screen, not `account-register.html`'s own stale sidebar (`#323` retired that layout; the mockup was never redrawn — see "Known gaps" in `apps/web/README.md`); listing, closing and each one's own balance (`#333`) composed from the workspace-settings account list in [`settings-first-run.html`](mockups/settings-first-run.html), and the phone list from `account-register.html`'s own `.ph-acc`; "+ Add account" from the same mockup's first-account onboarding step; a refused close shows, under the row and above its divider, an intro ("This account can't be closed yet. Right now:") and one item per reason, each with the figures the screen shows: today's balance, the rows dated after today (how many and the first one's date), the securities it holds today, the scheduled transactions that use it with the first one's next due date ("A transaction scheduled for {date} uses it.", `#741`) (`#703`, `#729`); a refusal with no known reason says only "We could not close this account."; proposed for 0.2.1: "Close account" (on the phone, in the row's "⋯" menu) asks first, under the row (balance today, nothing dated after today, what closing does, and for a card what happens to its payment category); every refusal states its rule before the facts, replacing the intro above: "{account} can't be closed yet: it has to be empty, today and later. Right now:", and for a card "{account} can't be closed yet: it has to be empty, today and later, and its payment category has to have €0.00 available, with nothing assigned to it in a later month. Right now:" (a card whose payment category is not settled is refused with that rule and its facts), the fallback staying "We could not close this account."; closed accounts sit under "Closed" with "Reopen" and still open their register (desktop: `settings-first-run.html`, workspace settings → Accounts; phone: `account-register.html`'s accounts list, `#705`); "+ Add account" asks the currency (a choice for an off-budget account only) and, for every type, an optional starting balance with its date (`account-register.html`, the sidebar's "+ Add account" and the phone's "+ Add", `#717`, `#778`) | #51, #333, #703, #729, #741, #705, #717, #778 |
| Accounts panel | [`accounts-panel.html`](mockups/accounts-panel.html); a dismissible left panel opened from the band, every account and its balance, switching the main content to an account's own register without leaving it — built (`apps/web/src/accounts/AccountsPanel.tsx`), desktop only | #412 |
| Categories and groups | shown as the budget month's bars, [`budget-month.html`](mockups/budget-month.html); listed, created, archived and reordered in the workspace-settings "Categories" tab, [`settings-first-run.html`](mockups/settings-first-run.html) | #52 |
| Categories and groups from the budget month | [`budget-categories.html`](mockups/budget-categories.html); a proposal: a "⋯" menu per group row (add a category, rename the group, reorder or archive in Workspace settings), "+ Add a group" below the last group, "Rename" in a category's own detail, names typed inline, owner or editor only — built (`apps/web/src/budget/GroupMenu.tsx`, `apps/web/src/categories/CategoryNameField.tsx`); proposed for 0.2.1: the empty budget's copy points at "+ Add a group" (the strip's "No categories yet" switch, `#709`) | #397, #709 |
| Budget month | [`budget-month.html`](mockups/budget-month.html) | #53 covers the band, timeline, "To do" and bars (no editing yet); the row detail and side sheet states are `#55`–`#57`, `#217`; the phone layout is `#331`; its own central quick-entry button is `#367`. A reservation shortfall's "To do" line does not yet start with the mockup's "{payee}, {date}: " prefix (the core's item carries neither) |
| Transaction entry and list | [`account-register.html`](mockups/account-register.html) | #54 (no payee autocomplete, "last used category" hint, or live available-amount preview); the timeline, "To do" list and projected balance are `#337`; "Reconcile" opens `ReconciliationScreen` (`#60`); "Import" opens `ImportScreen` (`#59`); a refused one-click action (a status, "Mark", "Record") shows one red alert line under the balance, and a refused "Unlock" shows it in the reconciled transaction's sheet above its button (`#741`); proposed for 0.2.1: a closed account's register (the sidebar's "Old post office account", read only, "Reopen", `#705`) and an off-budget account in US dollars (the sidebar's "Dollar savings": the currency's symbol on every amount field, and a transfer with no account in that currency to pick, `#717`) |
| Quick expense entry (phone) | `account-register.html`'s own `qeHtml()` | #367 (`QuickEntryOverlay.tsx`; "Where" is a plain text field, not the mockup's own fixed suggested-payee chips — no frequent-payee memory exists anywhere in the app yet) |
| Quick assign and targets | side sheet states "Quick assign" / "Targets" / "Target editor", [`budget-month.html`](mockups/budget-month.html) | #55 (quick assign has no live preview, and only 5 of the mockup's 6 modes — "cover scheduled" has no endpoint yet); proposed for 0.2.1: why a choice has nothing to assign, and the confirmation of what a run assigned (`#707`) |
| Move money between categories | side sheet state "Assign / Move money", [`budget-month.html`](mockups/budget-month.html) | #56 |
| Credit card payment category | the payment category's row detail, [`budget-month.html`](mockups/budget-month.html) | #57; proposed for 0.2.1: the red part of a card paid beyond what was set aside on its bar, and its "To do" line naming both parts (the "Travel card", with the strip's switch for the case with no debt left, `#726`) |
| Days of buffer | in the band, [`budget-month.html`](mockups/budget-month.html) | #58 |
| CSV/OFX import | [`import-reconciliation.html`](mockups/import-reconciliation.html) | #59 (`ImportScreen.tsx`; a staged row's payee is read-only — no endpoint edits one before confirming — and one with no category, income or transfer chosen stays staged rather than importing uncategorized, unlike the mockup's own simulated `doImport()`, since `packages/core` rejects an uncategorized transaction outright); a refused file shows one red alert line above the step (#671, #672): a file in another currency than the account's names both ("A file can be imported only into an account in the same currency: this file's currency is US Dollar (USD), and this account's is Euro (EUR).", the mockup's "Use a file in US dollars"), or, when the file states a currency that is not a code, says "this file states a currency we don't recognize"; an amount with more decimals than the account's currency allows says how many it allows, with the decimal separator as a possible cause at the CSV's columns step (the mockup's "Use a file with three-decimal amounts", then "Continue"; changing the separator clears it) and the file's currency alone at step 1 for QIF, OFX and CAMT.053 ("An amount in Euro (EUR) can have at most 2 decimal places: this file has an amount with more, so it was not imported. The file may be from an account in another currency.") |
| Reconciliation | [`import-reconciliation.html`](mockups/import-reconciliation.html) | #60 (`ReconciliationScreen.tsx`; ticking a pending transaction marks it cleared right away rather than only flipping local state, and the adjustment action has a small category picker the mockup itself does not draw, since design.md requires one) |
| Instant notifications and unresolved problems | the "To do" list and the toast, [`budget-month.html`](mockups/budget-month.html) | #61 (the toast fires for a newly-arrived budget problem only, not the mockup's own wider per-action confirmations with undo; the mockup's own "Notifications" settings tab, per-workspace preferences, is part of the fuller account-settings screen deferred to 0.1.8 — a single band-level on/off toggle stands in for now) |
| Scheduled transactions panel | side sheet state "Scheduled", the reservation lines on the bars and the dashed marks on the timeline, [`budget-month.html`](mockups/budget-month.html) | #217; proposed for 0.2.1: "After {month}", what is due after next month, and every scheduled transaction opening its form (`#744`) |
| Settings and first run | [`settings-first-run.html`](mockups/settings-first-run.html) | the "Categories" tab lands early, with #51/#52; the rest is (0.1.8 and later) |
| Portfolio | [`portfolio.html`](mockups/portfolio.html) | (0.2.x) |

Sign-in is the one screen this issue adds: every other screen above already had a mockup before 0.1.7 started. A screen whose 0.1.7 issue is not in this table has no mockup yet — stop and ask for one, or propose it in its own pull request (`CLAUDE.md`).

The "+ Add account" form also offers a brokerage type ("Brokerage", always off budget, so it has no "On budget" choice, `#74`), which the onboarding's first-account step in `settings-first-run.html` does not draw; from 0.2.1 the whole form is drawn in `account-register.html` (`#717`, `#778`).

In a workspace whose tax country is Italy (`IT`) only, the same form asks a brokerage account's tax regime (`#508`), composed from the pieces it already uses: a second `.types`/`.opt` radiogroup ("Tax regime": Self-declared, Administered, Managed) with no preselection, a one-line hint under each regime and one under the group, and — for "Self-declared" only — a `.chk` checkbox, "The broker is an Italian withholding agent", with its own hint (an administered or managed account's broker always is one). The screens to set the tax country and to see or correct the regime history have no mockup yet (`#516`).

## Navigation structure

- **Desktop.** A mariner band across the top of every screen: a button that opens the accounts panel (`#412`, [`accounts-panel.html`](mockups/accounts-panel.html)), the wordmark, primary navigation (Budget, Accounts, Portfolio), the workspace switcher and the user menu with settings. There is no persistent sidebar; the account list belongs to the Accounts screen by default — the accounts panel is a dismissible, closed-by-default detour from it, not a second place balances always show. The budget month adds its own second line to the band (month arrows, unassigned money with Assign, reserved, the money from this month assigned to later months, days of buffer) and, under the band, the timeline, "To do", filter tabs (All, Underfunded, Overspent, With money) and the action toolbar (Summary, Targets, Scheduled, Quick assign, Move money, Undo). A category's detail opens in its own row; month-wide tools (group, summary, targets, scheduled, quick assign, move money, the target editor) open in a side sheet. Neither navigates to a URL of its own.
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
| Action error line | One red `role="alert"` line saying why a one-click action was refused (a closed account, a rate limit, a plain failure), under the account's balance, under the item in a list, or above the button in a sheet; the pressed control keeps focus, the line is brought into view, and it clears on the next action or when a sheet opens (`#741`) | Account register, "Scheduled" side sheet |
| Side sheet | A fixed-width sheet on the right for month-wide tools and forms, closed with "× Close", the same button again, or Esc | Budget month, account register |
| Tab bar (in-page) | `role="tablist"`/`role="tab"` pair switching a view without navigating (e.g. desktop/phone preview, pending/cleared/all) | Every mockup |
| Toggle | An `aria-pressed` button pair (a view switch, a filter) | Every mockup |

### Translation keys, not literal text (ADR 0004)

Mockups show their English copy as literal strings because they have no build step; real screens never do: that copy becomes each string's English `defaultMessage` (ADR 0015). Every string a component or screen needs is a stable, dot-namespaced key resolved through the catalog, for example:

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
- **Repeated button names.** A generic button repeated on every row ("Close account", "Reopen") keeps its visible words first and adds the row's object as visually hidden text after them (`Close account<span class="sr">, Gas card</span>`). Never an `aria-label` that drops the visible words (WCAG 2.5.3), and never a name that duplicates another button's, such as the confirmation's own "Close Gas card".

## Screenshots

[`screenshots/`](screenshots/) holds the reference screenshots the repository README shows. Every one of them is taken in both themes, as `<name>-light.png` and `<name>-dark.png`, and a change to a screen (or mockup) that one of them shows refreshes both in the same pull request. Built screens are shot from the real running app over the demo workspace (`scripts/screenshot-demo.ts`, in English); the portfolio, which has no screen yet, and the three-phone composite from the mockups (`scripts/screenshot-mockups.ts`, in English too), which also makes the README's two mixed images, `budget-month-split.png` and `phones-mixed.png`. Which screenshot comes from where, and the commands, are in [`scripts/README.md`, "Reference screenshots"](../../scripts/README.md#reference-screenshots).

A pull request that proposes a mockup for the maintainer's approval also carries screenshots of each new or changed state, in both themes, on a 360 px phone and on a desktop, in a temporary folder `docs/ux/review/<pr>/` that its description shows. A last commit removes the folder before the merge, so the review screenshots never reach `main`. A change to the copy only, inside a state the maintainer has already approved, is decided by the `ux-reviewer` and the `domain-expert` and logged in [`docs/team/decisions.md`](../team/decisions.md) ([Work with the agent team](../how-to/work-with-the-agent-team.md#coordinators-working-rules)).

## Screens still to design

Invitations (joining an existing workspace) — not needed by any 0.1.7 issue; design it, with its own mockup, when the workspace-settings work that needs it starts.
