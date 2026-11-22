# Review screenshots for #622 (temporary)

Screenshots of every mockup in `docs/ux/mockups/` after #622 turned them into English, for the maintainer to approve the English copy, light and dark: `<mockup>[-<state>]-<theme>-<width>.png`.

How they are taken:

- The mockups' own explanatory notes and controls (the note above each mockup, the screen tabs, the width and role switches, the state buttons) are hidden with an injected style after the clicks that open each state; the mockups themselves are unchanged.
- 1440: the whole page at a 1440 px wide window.
- 360: where the mockup has a phone design, its own phone toggle is clicked and only the phone frame is shot, 360 px wide (the method of `scripts/screenshot-mockups.ts`). Sign-in and the first run have no separate phone design; they are responsive pages, shot whole at a 360 px wide window.

| Mockup | State | 1440 | 360 |
| --- | --- | --- | --- |
| account-register | initial (phone: the Checking register) | `account-register-{light,dark}-1440.png` | `account-register-{light,dark}-360.png` |
| account-register | phone: the Accounts list | — | `account-register-list-{light,dark}-360.png` |
| accounts-panel | initial | `accounts-panel-{light,dark}-1440.png` | desktop only, by design: on a phone the tab bar's Accounts is the navigation |
| budget-categories | initial | `budget-categories-{light,dark}-1440.png` | `budget-categories-{light,dark}-360.png` |
| budget-month | initial | `budget-month-{light,dark}-1440.png` | `budget-month-{light,dark}-360.png` |
| import-reconciliation | Import | `import-reconciliation-import-{light,dark}-1440.png` | No phone design yet |
| import-reconciliation | Reconciliation | `import-reconciliation-reconciliation-{light,dark}-1440.png` | No phone design yet |
| portfolio | initial | `portfolio-{light,dark}-1440.png` | `portfolio-{light,dark}-360.png` |
| settings-first-run | Your account | `settings-first-run-account-{light,dark}-1440.png` | No phone design yet |
| settings-first-run | Workspace | `settings-first-run-workspace-{light,dark}-1440.png` | No phone design yet |
| settings-first-run | First run | `settings-first-run-first-run-{light,dark}-1440.png` | `settings-first-run-first-run-{light,dark}-360.png` |
| sign-in | Idle | `sign-in-{light,dark}-1440.png` | `sign-in-{light,dark}-360.png` |
| sign-in | Error | `sign-in-error-{light,dark}-1440.png` | `sign-in-error-{light,dark}-360.png` |

budget-categories is an excerpt of the budget month; its band is a placeholder, unchanged from the Italian mockup (the real band comes with #763).

This folder is temporary: it is removed before the pull request is merged.
