# Review screenshots: mockup states for 0.2.1

Temporary: the last commit of this pull request removes this folder before the merge (`docs/ux/README.md`, "Screenshots"). Each state is shot light and dark (`-light.png`, `-dark.png`), on a 1440 px desktop and on a 360 px phone. The quick assign and scheduled side sheets have no phone layout (the budget month's phone has no toolbar), so those states are desktop only. The desktop accounts list is the workspace settings list (`settings-first-run.html`), which has no phone view; its phone version is `account-register.html`'s accounts list.

| State | Files | Mockup | Issue |
| --- | --- | --- | --- |
| Close asks first (a card: what happens to its payment category; the phone: a cash account) | `01-close-confirm-desktop-*`, `01-close-confirm-phone-*` | `settings-first-run.html` (Workspace → Accounts, Gas card), `account-register.html` (phone, Prepaid card) | #705 |
| Close refused: a card whose payment category is not settled | `02-close-refused-card-desktop-*`, `02-close-refused-card-phone-*` | `settings-first-run.html` (Store card), `account-register.html` (phone, Visa) | #705 |
| Closed accounts under "Closed", with "Reopen", after closing one | `03-closed-accounts-desktop-*`, `03-closed-accounts-phone-*` | same | #705 |
| A closed account's register, a row opened read only (desktop) | `04-closed-register-desktop-*`, `04-closed-register-phone-*` | `account-register.html` (sidebar or phone list: Old post office account) | #705 |
| The same account reopened | `05-reopened-desktop-*`, `05-reopened-phone-*` | `account-register.html` | #705 |
| Add account: off budget, in another currency, with a starting balance | `06-add-account-other-currency-desktop-*`, `06-add-account-other-currency-phone-*` | `account-register.html` ("+ Add account", phone "+ Add") | #717, #778 |
| Add account: a negative starting balance (desktop), a date after today (phone) | `07-add-account-overdraft-desktop-*`, `07-add-account-after-today-phone-*` | `account-register.html` | #778 |
| Add account: a credit card's debt and its date | `08-add-account-card-desktop-*`, `08-add-account-card-phone-*` | `account-register.html` | #778 |
| A register in US dollars: the currency marker, and a transfer with no account to pick | `09-other-currency-transfer-desktop-*`, `09-other-currency-transfer-phone-*` | `account-register.html` (Dollar savings, New transaction, Transfer) | #717 |
| Checking's transfer list names the account left out for its currency | `10-transfer-list-hint-desktop-*`, `10-transfer-list-hint-phone-*` | `account-register.html` (New transaction, Transfer) | #717 |
| A card paid beyond what was set aside, still owing: red part on its bar, "To do" line naming both parts | `11-card-paid-beyond-desktop-*`, `11-card-paid-beyond-phone-*` | `budget-month.html` (Travel card) | #726 |
| The same card owing nothing: empty track and the red part | `12-card-owes-nothing-desktop-*`, `12-card-owes-nothing-phone-*` | `budget-month.html` (strip: "Owes nothing") | #726 |
| Scheduled: "Later", due after next month | `13-scheduled-later-desktop-*` | `budget-month.html` (Scheduled) | #744 |
| Scheduled: a "Later" item opened in its form | `14-scheduled-later-open-desktop-*` | `budget-month.html` (Scheduled, Open) | #744 |
| Quick assign: what a run assigned (sheet closed, confirmation with Undo) | `15-quick-assign-done-desktop-*` | `budget-month.html` (Quick assign, Run) | #707 |
| Quick assign: nothing to assign, said before sending | `16-quick-assign-nothing-desktop-*` | `budget-month.html` (Quick assign again) | #707 |
| Empty budget, owner or editor: points at "+ Add a group" | `17-empty-budget-desktop-*`, `17-empty-budget-phone-*` | `budget-categories.html` (strip: "No categories yet") | #709 |
| Empty budget, read only | `18-empty-budget-read-only-desktop-*`, `18-empty-budget-read-only-phone-*` | `budget-categories.html` | #709 |
