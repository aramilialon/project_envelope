# envelope — design document

Last updated: 2026-09-25. This is the reference design; decisions with lasting technical impact also get an [ADR](adr/).

## Vision and principles

One app, web and mobile, that combines envelope budgeting with portfolio management, target allocation and threshold-based rebalancing. The current goal is personal and family use, self-hosted. Open source distribution and a hosted version for others remain possible later, which is why the architecture is multi-user from day one: it costs little to do it now.

- **Only money that has arrived.** The budget assigns money already in the accounts, never future income.
- **One net worth.** Budget cash and investments add up to the same net worth.
- **User rules, not advice.** The app only computes what is needed to respect the targets and thresholds the user has set. It never suggests instruments to buy and never judges the user's choices.
- **Always verifiable.** Every balance, position and return can be rebuilt from the recorded transactions.
- **The data belongs to the user.** Full export at any time, self-hosting possible, no selling of data.
- **Offline first on mobile.** An expense can be recorded without a network and synced later.

## Budget module

The budget follows the envelope method: income arrives unassigned and the user distributes it across categories until all of it is assigned.

| Feature | What it does | Phase |
| --- | --- | --- |
| Accounts | Checking, credit card, cash, savings; "off-budget" accounts for mortgages and investments | MVP |
| Categories and groups | Grouped categories (Home, Bills, Fun…), sortable and archivable | MVP |
| Monthly assignment | Assigned, spent and available per category and month; a positive available balance rolls over to the next month | MVP |
| Unassigned | Only money already received in on-budget accounts, never expected income; warning when assigning more than is available | MVP |
| Assigning to future months | Assign money to next month and beyond, working towards living on last month's income | MVP |
| Targets | Monthly amount, amount by a date, balance to keep, expense repeating every N months or years (a €600 insurance due in March = €50 a month); "€X still needed this month" indicator | MVP |
| Quick assign | One click to fund this month's targets, or repeat last month's assigned or spent amounts | MVP |
| Moving money between categories | Move money from one category to another at any time, including to cover overspending | MVP |
| Transactions | Payee, category, memo, split across categories, transfers between accounts | MVP |
| Overspending | A negative category, to be covered by moving money. If still uncovered at the end of the month: for cash and debit, the category restarts at zero and the amount is taken from next month's unassigned money; for credit cards, it becomes debt on the card not covered by the payment category | MVP |
| Credit cards | Automatic payment category that sets aside the money spent with the card | MVP |
| Scheduled transactions | Rent, salary, subscriptions | MVP |
| Import | CSV, OFX, QIF and CAMT.053 with column mapping and duplicate detection (see "Import and reconciliation") | MVP |
| Reconciliation | Compare the cleared balance with the bank statement, find the difference, lock reconciled transactions (see "Import and reconciliation") | MVP |
| Instant notifications | Instant alert when a category goes negative, a purchase exceeds the available balance or money arrives to be assigned; sent by the server to every member (see Sync, Notifications) | MVP |
| Days of buffer | Average number of days between a euro coming in and being spent, weighted by amount, over the outflows of the last 30 days; first in, first out, across all on-budget accounts; transfers between on-budget accounts excluded. Always visible | MVP |
| Automatic rules | Category suggested from payee or description | Phase 2 |
| Reports | Spending by category, income and expenses, days of buffer per calendar month, net worth over time | Phase 2 |
| Bank connection | Automatic sync through a PSD2 provider | Phase 3 |
| Shared budgets | Several people on the same budget with different roles | Phase 3 |

### What the budget is for

The features above serve a few practical goals of a household budget:

- **Money is never counted twice.** Only money that has arrived can be assigned; the warning when assigning more than is available, and reconciliation with the bank, keep the budget equal to the accounts.
- **Rare bills are not a surprise.** Targets spread an insurance premium or a car tax over the months before it is due, and quick assign funds them in one step.
- **Overspending is fixed in the open.** A negative category stays visible, and notified, until money is moved to cover it; cash and card overspending are handled apart, so card debt never hides.
- **Income can arrive before it is needed.** Assigning to future months, and the days of buffer, show how far ahead of its spending the household is.

### Target calculation

A target tells the budget how much a category asks for in the current month. There are four kinds. In the formulas, *carried* is the available balance brought over from the previous month, *assigned* is what the user assigned this month and *available* is the category's balance now.

| Kind | Settings | Asks this month | Still missing this month | Progress shown |
| --- | --- | --- | --- | --- |
| Monthly amount | amount | the amount | amount − assigned, at least 0 | assigned ÷ amount |
| Amount by a date | total, due month | (total − carried) ÷ months left, rounded up to the cent, at least 0 | asked − assigned, at least 0 | available ÷ total |
| Repeating expense | amount, every 2, 3, 4, 6, 12 or 24 months, next due month | as "amount by a date" until the due month; then the due month moves forward by the interval | asked − assigned, at least 0 | available ÷ amount |
| Balance to keep | threshold | threshold − available, at least 0 | the same | available ÷ threshold |

"Months left" counts the current month and the due month. Example: €3,600 for holidays by June 2027, with €1,250 carried into September 2026, asks (3,600 − 1,250) ÷ 10 = €235 a month; with €200 assigned in September, €35 is still missing. "Fund the targets" assigns the missing amounts from unassigned money, never more than it holds. Payment categories of credit cards have no targets.

These rules belong in `packages/core`, with tests; the mockup's `plan()` function is a reference implementation in plain JavaScript.

### Import and reconciliation

**Import.**

- CSV files need a column mapping: date, description, and either one amount column or separate outflow and inflow columns, plus an optional memo; the date format, the decimal separator and whether the first row holds column names. The mapping is remembered per account. OFX, QIF and CAMT.053 need no mapping.
- A row is a duplicate of a transaction already in the same account when the bank's own transaction id matches (formats that carry one, such as OFX), or otherwise when the amount is the same and the dates are at most 3 days apart; each existing transaction matches at most one row. Duplicates are not imported again; a matched *pending* transaction becomes *cleared*.
- New rows go into a staging area, not into `transactions` directly. Payee and category are suggested from the user's rules and history. A staged row is confirmed into `transactions` (as cleared) only once every row included in the confirmation has a category, or is recognized as a transfer or as income; `transactions` itself has no "to categorize" state (`packages/core` rejects an uncategorized transaction outright). Unconfirmed staged rows expire after 7 days.
- The file is read to extract its rows and is not stored. The import summary compares the file's closing balance, when it has one, with the account's balance.

**Reconciliation.**

- A transaction is *pending* (recorded, not yet seen at the bank), *cleared* (seen on a bank statement or imported) or *reconciled* (part of a completed reconciliation).
- The user enters the statement's closing balance and date. The *cleared balance* is the last reconciled balance plus the cleared transactions up to that date that the user keeps ticked; pending transactions are listed apart and count only once marked cleared.
- *Difference* = statement balance − cleared balance. When it is not zero, the app looks for a pending or unticked transaction equal to the difference and offers to fix it in one step.
- With a zero difference, the ticked transactions become reconciled, and the reconciliation (account, date, statement balance, user) is kept in the account's history.
- When a real difference remains (a forgotten fee, a bank correction), the user can add an adjustment transaction for it, dated on the statement date; its category is chosen by the user, unassigned money by default, so the budget and the accounts stay equal.
- Reconciled transactions cannot be edited or deleted. Unlocking one is an explicit action, recorded in the audit log, and it marks the account's last reconciliation as broken until it is redone.
- Credit cards and every other on-budget or off-budget cash account reconcile the same way.

### Credit cards

An on-budget credit card gets an automatic payment category, which holds the money set aside to pay it (`packages/core`, "Credit card handling").

- **Starting balance.** Creating a card with existing debt also creates a "Starting balance" transaction on the card's account, categorized to the card's own payment category. Card purchases keep going to their own spending categories, as always; only this one transaction is categorized directly to the payment category.
- **The starting balance only sets the card's balance.** A card transaction categorized to that card's own payment category is debt the household already had: it is not activity of the payment category, it moves no money between categories and it does not touch unassigned money; it shows up only as uncovered debt (next point). Treating it as ordinary card spending would not work: its "covered" part would move from the payment category into itself, and its negative available would be reset to zero at the end of the month, hiding the debt. The interface creates exactly one such transaction per card, the starting balance.
- **Uncovered debt is derived, never stored.** `computeBudgetMonth` is given each on-budget card's real balance (what is owed, as a positive amount) and returns, per card, `uncovered = max(0, owed − max(0, paymentCategory.available))`: the part of what is owed that no assigned money covers yet. Nothing new is persisted, and assigning money to the payment category reduces `uncovered` directly. During the month, card spending beyond a category's available shows twice on purpose: as credit overspending on the category (hatched, "card") and inside the card's `uncovered`; at the end of the month the category restarts at zero and only `uncovered` remains.
- **The payment category otherwise behaves like every other category**, including at the end of the month. Its available can only turn negative by paying the card more than it held; that is cash, taken from next month's unassigned money, exactly as an ordinary cash overspend.
- **Income on a card** (cashback, a card-issuer bonus — nothing tied to a specific purchase) is recorded as the composition of two things that already exist: a normal income entry (unassigned money +X) and a card payment (spending the payment category by X, per the existing card-payment rule). If the payment category does not hold X, the excess behaves like an ordinary payment beyond what was set aside (cash overspending). A merchant refund credited to the card stays a refund to its original spending category, as today — this rule is only for inflows with no category of their own.
- **A transfer between two cards A → B** moves the *available* part of A's payment category into B's, up to what A's payment category actually holds; any remainder stays as A's uncovered debt, exactly like ordinary card overspending — the debt itself does not silently move to B.

### Scheduled transactions

A scheduled transaction (rent, salary, a subscription) reserves money ahead of being recorded, rather than only appearing once it happens.

- `computeBudgetMonth` is given the month's scheduled items not yet recorded and returns `reserved` per category; `available` is net of its category's reservations. Recording the scheduled expense turns the reservation into ordinary activity, so `available` does not change at that moment.
- A reservation beyond what a category can cover is a warning, not overspending: nothing has actually happened yet.
- Reservations do not carry over to the next month. An overdue scheduled item (past its date, still not recorded) stays reserved, marked "to record" — it does not silently disappear or convert into activity on its own.
- A scheduled expense on a credit card reserves money in its spending category, the same as a cash one; it becomes card activity, not a payment category concern, only once actually recorded.
- At the start of a month, a summary shows what is already reserved against that month's income. A scheduled item can suggest its own category's target amount.

## Portfolio module

The user records every instrument they own and every transaction. The app derives positions, value and month-by-month performance from historical prices.

| Feature | What it does | Phase |
| --- | --- | --- |
| Portfolios | Several per workspace (for example "Long term", "Third pillar", "Fourth pillar"). A portfolio can span several brokerage accounts, and one brokerage account can hold several portfolios: every trade is assigned to exactly one portfolio at entry (never left unassigned, and an account is never treated as if it were a portfolio), so an account's positions are split logically across its portfolios | MVP |
| Instruments | ETFs, stocks, bonds, funds, cash; search by ISIN or ticker; currency, exchange, asset class | MVP |
| Trades | Buy, sell, dividend or coupon, fees, taxes, split, transfer of securities | MVP |
| Positions | Quantity, average cost, current value, unrealized and realized gains or losses | MVP |
| Historical prices | Daily closing price stored; monthly view for each instrument and for the portfolio | MVP |
| Monthly performance | Month-by-month table and chart: value, net contributions, gain, return | MVP |
| Manual prices | For instruments without automatic quotes (some government bonds, funds, real estate) | MVP |
| Returns | TWR (measures the strategy) and MWR/XIRR (measures the actual result given the user's contributions) | MVP |
| Multi-currency | Instruments in USD or other currencies converted to the base currency with historical rates | MVP |
| Bonds | Maturity, coupon, accrued interest; calendar of expected coupons | Phase 2 |
| Savings plans | Planned periodic contributions, recorded as trades to confirm | Phase 2 |
| Broker import | CSV exports of the most common brokers | Phase 2 |
| Net worth | Budget cash, investments and other assets or debts in one historical view | Phase 2 |
| Local tax rules | Indicative tax calculation, starting with Italy (tax loss carry-forward, administered or self-declared regime) | Phase 3 |

The portfolio connects to the budget through off-budget accounts. A payment from the checking account to the broker is a transfer, so invested money leaves the budget without showing up as spending.

### ETF look-through (phase 2)

The app breaks every ETF down into its holdings and shows the portfolio's real exposure: by country, region, sector, currency and single company. For example "62% of your stocks are in the United States" or "one company weighs 3.1% across all your ETFs".

- The data is public and not personal: the server downloads and refreshes it periodically.
- The asset-class breakdown (stocks, bonds, cash) proposes how to split a mixed ETF across allocation items. The user confirms or corrects it.

#### Sources for holdings data

Aggregator websites are not used as automatic sources: their terms of use typically forbid automated requests and grant no license on the data.

| Source | How it works | Phase |
| --- | --- | --- |
| Issuer file uploaded by the user | The user downloads the holdings file from the ETF issuer's website and uploads it; envelope has a parser for each format | Look-through MVP |
| Manual entry | Country and sector weights typed in, for ETFs without a downloadable file | Look-through MVP |
| Paid API with the user's key | Adapter for a licensed data provider | Later |

For personal use a handful of ETFs refreshed every three months or so is enough, and uploading the issuer's file is the simplest option with no licensing issues.

### Momentum analysis (phase 3)

Momentum indicators are purely informative, in line with the "user rules, not advice" principle.

- **Six-month trend, the main indicator.** For each instrument: *Rising*, *Falling* or *Flat*, with a small six-month chart. Rising when the return of the last six months (dividends included) is above +3% and the price is above its 200-day average; Falling in the opposite case; Flat otherwise. Thresholds are configurable.
- **Detail indicators**, with public, documented formulas: 1, 3, 6 and 12-month returns; 12–1 month momentum; distance from the 200-day average; six-month volatility; maximum drawdown over the last 12 months.
- **Per allocation item too.** The same trend computed on the total value of each item, for example "Bonds: Flat".
- **Only on the user's instruments**: those in the portfolio and those added to a watch list. Never market-wide rankings.
- **Describes the past, gives no advice.** No "buy" or "sell" labels, no rotation strategies.
- **Updated** daily with prices; the monthly check summary includes the trends.

## Rebalancing engine

The engine compares current weights with the targets and thresholds set by the user. When a weight is outside its threshold, it computes how much to buy or sell to get back in range. It never proposes new instruments: it works only on those the user has placed in the allocation.

### User configuration

1. **Multi-level target allocation.** For example Stocks 60% (in turn World 50% and Emerging markets 10%), Bonds 30%, Gold 10%. Each level must add up to 100%.
2. **Instruments assigned to items.** An item can contain several instruments. An instrument can be split across items by percentage: a 60/40 balanced ETF counts 60% in stocks and 40% in bonds. When the ETF's breakdown is available, the split is proposed automatically.
3. **Cash as an item.** Target as a percentage or as a fixed amount ("always keep €20,000"); the rest of the net worth is split across the other targets.
4. **Items excluded from rebalancing.** Assets such as real estate or private company shares count in net worth but never generate trades.
5. **A threshold for each item, in three forms.**
    - Absolute: ±5 percentage points.
    - Relative: ±20% of the target.
    - 5/25 rule: the tighter of ±5 points and ±25% of the target.
6. **Rebalancing mode.**
    - Contributions only: no sales.
    - Full: buys and sales back to target.
    - To the threshold edge: minimal trades.
7. **Execution constraints.** Minimum amount per trade, fees, fractional shares yes or no.
8. **Dynamic target based on CAPE (optional, phase 2).** The weight of the stock item varies with the CAPE ratio: the more expensive the market, the fewer stocks. Details below.

#### Dynamic target based on CAPE

The user sets four parameters: minimum and maximum CAPE, minimum and maximum stock weight. The stock target is derived linearly and always stays between the two limits:

```latex
t_{stocks} = S_{max} - \frac{CAPE - CAPE_{min}}{CAPE_{max} - CAPE_{min}} \cdot (S_{max} - S_{min})
```

With CAPE limits of 10–40, stock limits of 50%–100% and a CAPE of 30, the stock target is 66.7%.

- **The other top-level items** share the remainder in proportion to their targets.
- **The CAPE value** is entered by the user at the monthly check, with a reminder and a link to the source they chose; an automatic adapter can be added later. Only one number a month is needed.
- **History.** Every CAPE value and the resulting target are stored, so the allocation's evolution is visible over time.

### Built-in presets

The app offers two libraries of starting points: rebalancing rules and well-known allocations. The user picks one, copies it into the workspace and edits it freely.

**Rebalancing rules (MVP).** Mechanical methods that say nothing about what to buy:

| Preset | How it works |
| --- | --- |
| Monthly check only | Every month, bring everything back to target, whatever the drift |
| 5-point bands | Act only when an item drifts by more than 5 percentage points, and bring it back to target |
| 5/25 rule | Threshold equal to the tighter of ±5 points and ±25% of the target |
| Contributions only | Never sell: direct new money to underweight items |
| Minimum trades | When out of range, bring the item back only to the edge of its band |

**Well-known allocations (phase 2).** A library of publicly documented allocations, at the asset-class level, with neutral descriptive names:

| Model | Composition |
| --- | --- |
| Classic balanced | 60% stocks, 40% bonds |
| Five equal parts | 20% stocks, 20% small-cap value, 20% long-term bonds, 20% short-term bonds, 20% gold |
| Four equal parts | 25% stocks, 25% long-term bonds, 25% gold, 25% cash |
| Risk-balanced mix | 30% stocks, 40% long-term bonds, 15% intermediate-term bonds, 7.5% gold, 7.5% commodities |
| Three funds | Domestic stocks, international stocks, bonds, with weights chosen by the user |

Every composition must be checked against a primary source before it ships, and cited in the model's description.

Guardrails, to stay clear of financial advice:

- **Asset classes only, never instruments.** Users pick the ETFs for each item themselves.
- **No profiling questionnaire.** The app never proposes a model based on age, income or risk tolerance.
- **Neutral presentation.** Alphabetical order, description, origin and sources, no rankings and no "best".
- **An editable starting point.** Once copied, every weight can be changed.
- **Legal review** before the library is enabled in a hosted version.

**Export and import (phase 2).** An allocation can be exported to a file and imported into another workspace, so users can share their models without the app proposing them.

### Calculation

For each item *i*, with value Vᵢ, total value V, target tᵢ and new contribution C:

```latex
w_i = \frac{V_i}{V} \qquad d_i = w_i - t_i \qquad \Delta_i = t_i \cdot (V + C) - V_i
```

wᵢ is the current weight, dᵢ the drift, Δᵢ the amount to buy (when positive) or sell (when negative). In "contributions only" mode, new money goes to underweight items in proportion to how far each is from its target. Amounts are then converted into shares, rounded according to the constraints and checked again.

### Example

A €100,000 portfolio with an absolute threshold of ±5 points and full rebalancing:

| Item | Target | Current | Drift | Status | Trade |
| --- | --- | --- | --- | --- | --- |
| Stocks | 60% | 67% | +7 pt | Above threshold | Sell €7,000 |
| Bonds | 30% | 25% | −5 pt | At the limit | Buy €5,000 |
| Gold | 10% | 8% | −2 pt | Within threshold | Buy €2,000 |

### What it shows and what it does not do

- **Shows:** a dashboard with target, current and threshold bars; the status of each item; the list of required trades; a simulation "if I invest €X, where does it go?".
- **Notifies:** when an item is outside its threshold, but only at the monthly check: no instant alerts for the portfolio.
- **Does not:** suggest securities, judge the chosen allocation, forecast markets or place orders. Wording stays neutral, such as "To get back to your targets:", never "We recommend".

## Data model

All data belongs to a workspace, the unit of isolation between users. Budget and portfolios live inside a workspace and share accounts and currencies.

The data lives in PostgreSQL on the server, which is the source of truth. Devices keep a local copy for offline use. The model is ready for the future optional end-to-end encryption (see Security).

| Entity | Main fields | Notes |
| --- | --- | --- |
| User | email, password hash, passkeys, 2FA, language, locale, time zone | A user can belong to several workspaces |
| Workspace | name, base currency, reference time zone, plan | Security boundary: every query is filtered by workspace |
| Membership | user, workspace, role | Owner, editor, read-only |
| Account | type, currency, on or off budget, closed | Bank accounts, cards, brokers; each real account lives in exactly one workspace |
| Transaction | account, date, amount, payee, status (pending, cleared, reconciled) | Corrections become new rows or tracked versions |
| Split | transaction, category, amount | One transaction across several categories |
| Category / Group | name, order, archived | |
| AssignmentEntry | month, source category (null = unassigned), destination category (null = unassigned), amount, author, reverses (another entry, optional) | Append-only ledger, never a mutable total: assigning is null→category, unassigning is category→null, moving money is one entry from A to B; a category's assigned amount in a month is incoming minus outgoing entries. Undo is a new entry with `reverses` set, never an edit ([ADR 0008](adr/0008-assignment-ledger.md)) |
| Scheduled | account, category, payee, amount, next due date, every N days/months/years | Reserves money ahead of being recorded (see "Scheduled transactions") |
| Goal | category, type, amount, due date | |
| Instrument | ISIN, ticker, exchange, type, currency, asset class | Shared across users; private data kept separate |
| Price | instrument, date, close, source | Daily time series |
| FxRate | currency pair, date, rate | Historical rates for multi-currency |
| Portfolio | name, purpose, allocation | Linked to accounts through its trades: a portfolio can span several accounts and an account can hold several portfolios |
| Trade | account, portfolio, instrument, type, date, quantity, price, fees, taxes | Buys, sells, dividends, splits; moving units between two portfolios of the same account is a transfer without cash |
| AllocationNode | portfolio, parent, name, target, threshold | Tree of the target allocation |
| AllocationLink | node, instrument, share | Which instrument falls in which item, and in what proportion |
| AuditLog | who, what, when, before and after | Append-only |

### Accounting rules

- **Amounts as integers.** In cents, or the currency's minor unit. Never floating-point numbers ([ADR 0002](adr/0002-amounts-in-minor-units.md)).
- **High-precision quantities.** Fixed decimal with 8 digits for fractional shares; prices with 6 digits.
- **Derived values are never the source of truth.** Balances and positions are recomputed from transactions; caches are rebuildable optimizations.
- **Dates always in UTC.** In the database (`timestamptz`), for transactions and system events alike; the app converts them to the user's preferred time zone.
- **Workspace time zone.** Every workspace has a reference time zone, used only to decide which budget day and month a transaction belongs to. All members therefore see the same monthly totals, even from different time zones. Date-only transactions, such as bank imports, are stored in UTC starting from that day in the workspace's time zone.
- **UUID identifiers**, which clients can generate too, as offline sync requires.

### Workspaces and transfers between them

Budget and portfolios live in the same workspace. Different workspaces (for example Family and Personal) are fully separate: no data belongs to two workspaces.

- **One account, one workspace.** A real account, even a joint one, is added to one workspace only, so it is never counted twice.
- **Linked transfer (phase 2).** When a user records an outflow to another workspace they belong to, the app offers to create the matching inflow there, as unassigned money.
- **Two independent transactions.** Each side belongs to its own workspace and can be edited only by people with permissions there. A link field keeps them paired.
- **Bank matching.** When the bank statement is imported, the real transfer is matched to the transactions already created, without duplicates.
- **Broken link.** If one side is deleted, the other remains with a warning.
- **No net worth aggregated across workspaces.** Net worth is computed within each workspace: the money in a shared workspace belongs to the household, not to a single member.

## Architecture and stack

Everything in TypeScript in a single repository (monorepo, [ADR 0001](adr/0001-monorepo-typescript.md)). Budget and rebalancing logic lives in a shared package used by server, web and mobile, so calculations are identical everywhere.

| Component | Choice | Reason |
| --- | --- | --- |
| Monorepo | pnpm, with Turborepo once there are several packages to build | Shared packages, fast builds |
| Domain core | Pure TypeScript package, no network or database dependencies | Fully testable, reused everywhere |
| API | Node.js with Fastify or NestJS, OpenAPI contract | Mature, typed, generated documentation |
| Database | PostgreSQL with Row-Level Security per workspace | Reliable transactions, isolation between users even in case of bugs |
| Data access | Plain SQL migrations and parameterized queries with node-postgres ([ADR 0005](adr/0005-plain-sql-and-node-postgres.md)) | What runs on the database is exactly what is in the repository |
| Background jobs | PostgreSQL queue (pg-boss) behind a replaceable interface | Price updates, threshold notifications, imports |
| Push notifications | APNs (iOS), FCM (Android) and Web Push, sent by a queue job | Instant budget alerts and the monthly portfolio summary |
| Web | React with Vite (single-page app, installable as a PWA) | Fast, works offline |
| Mobile | React Native with Expo | Same language and same core as the web app |
| Local database | SQLite on mobile, IndexedDB or SQLite WASM on the web | Local copy and change queue for offline use |
| Authentication | Keycloak as identity provider; the app speaks OpenID Connect only | Passkeys, 2FA, external identity providers; no authentication code of our own |
| Internationalization | ICU message catalogs, `Intl` for formatting ([ADR 0004](adr/0004-internationalization.md)) | English source, Italian always complete, more languages without code changes |
| Deployment | Docker images and docker-compose; Helm for Kubernetes | Self-hosting with one command |
| Observability | OpenTelemetry, structured logs, a self-hostable error tracker | Errors visible before users report them |

### Queue module

Background jobs (prices, notifications, monthly check, imports) use a PostgreSQL queue. The rest of the code never sees it directly: it goes through a module with a common interface, so switching to RabbitMQ only takes a new adapter and one configuration line.

- **Single interface.** Three operations: `enqueue` (queue a job with data, run date, deduplication key, number of attempts), `schedule` (periodic jobs, such as the monthly check) and `work` (register the function that runs a job type).
- **Adapters.** `postgres` (pg-boss) from the start; `rabbitmq` when needed. Selected with the `QUEUE_DRIVER` configuration variable.
- **Consistency with the database.** Every job is written to an *outbox* table in the same transaction as the data that triggers it. With PostgreSQL the outbox is the queue itself; with RabbitMQ a process reads it and forwards it to the broker. A notification is never lost, whatever the driver.
- **Idempotent jobs.** Both systems can deliver the same job twice. The safeguard is described below.
- **Job data in versioned JSON**, so old and new jobs coexist during an upgrade.
- **Failed jobs.** Retries with increasing delay, then a dead-letter queue visible in the admin interface.
- **Same tests for every adapter.** A shared suite checks that PostgreSQL and RabbitMQ behave identically.

#### Safeguard against duplicate effects

The queue module prevents duplicate effects by itself, without relying on whoever writes the job.

1. **No double enqueue.** Every job has a deduplication key (for example `notify:category-overspent:<transaction id>`). A second `enqueue` with the same key is ignored.
2. **Processed jobs register.** The `work` function opens a transaction, inserts the job id into the `processed_jobs` table (unique constraint), applies the database effects and commits. If the job arrives again, the insert fails and the job is discarded without touching anything. Job authors cannot forget the check, because the module does it.
3. **External effects** (push notifications, emails, third-party API calls), which are outside the transaction:
    - the job id is passed as an idempotency key to the external service, when supported;
    - push notifications use the job id as notification id, so the phone replaces a duplicate instead of showing it twice;
    - the state of each delivery (pending, sent) is recorded, and a retry resumes only from unconfirmed deliveries.
4. **Mandatory double-delivery test.** The shared suite runs every job type twice with the same data and checks that the database and simulated external effects are identical to a single run. A job without this test fails CI.
5. **Cleanup.** Rows in `processed_jobs` are deleted after 30 days, well beyond the maximum retry window.

### Code quality

- Unit tests and property-based tests for the core (for example: unassigned money plus every available balance, payment categories included, plus money assigned to future months plus the current credit overspending must always equal the balance of the on-budget cash accounts).
- API integration tests against a real database and end-to-end tests with Playwright.
- CI on GitHub Actions: lint, type check, tests, dependency scanning and image builds on every change.
- Mandatory review of changes; releases with semantic versioning and release notes.

## Security, privacy and GDPR

The app handles personal financial data, so security is designed in from the start and verified by third parties before any hosted launch.

- **Access.** Managed by Keycloak: passkeys and 2FA, rate limiting, alerts for sign-ins from new devices, revocable sessions.
- **Isolation.** Row-Level Security in PostgreSQL on top of the API checks: a bug in the code must never expose another user's data.
- **Encryption.** TLS everywhere; encrypted database and backups; secrets (for example bank tokens) encrypted at field level with separately managed keys.
- **End-to-end encryption.** A future, optional module, per workspace. Details below.
- **API protection.** Validation of every input, CSRF protection, security headers, rate limits, no sensitive data in logs.
- **Dependencies.** Automated dependency updates, vulnerability scanning in CI, signed Docker images.
- **Backup and restore.** Daily backups with point-in-time recovery; periodic restore tests, not just backups.
- **Responsible disclosure.** A SECURITY.md file, a dedicated address and stated response times.

### End-to-end encryption: a future, optional module

End-to-end encryption will come in a later phase, as an optional module enabled per workspace. Until then the server can read the data, which keeps analysis, debugging and reports simple.

The module sits between the frontend and the API, but it must run on the device: it encrypts data before it leaves and decrypts it after it arrives. Running on the server, it would not be end-to-end. To plug it in later without rewriting the app, five rules apply from day one:

1. **A single data access point in the client.** Web and mobile read and write only through a common data layer (repositories and sync client). The encryption module will plug in there.
2. **Calculations in the shared core.** Budget, returns and rebalancing live in the TypeScript package used by server and client. In an encrypted workspace, the same calculations move to the device without being rewritten.
3. **Server features that read data are isolated and declared.** Notifications, reports and analytics live in separate modules marked "requires plaintext data". In an encrypted workspace they are disabled or moved to the device.
4. **Metadata separate from content.** Every entity keeps only its id, workspace, modification time and version in plaintext; everything else is content that may one day travel encrypted.
5. **No server-side search on content**, except inside the modules declared under rule 3.

When it arrives, the module will provide a workspace key, member keys, a recovery phrase and well-audited cryptographic libraries. It remains substantial work: these rules make it possible without rewriting the app, not free.

### Authentication with Keycloak

Keycloak is the main identity provider. The app speaks standard OpenID Connect only, so self-hosters can replace it with any compatible provider.

- **External sign-in.** Social logins and company directories are connected to Keycloak as secondary providers (identity brokering), with no code in the app.
- **Managed from our interface.** The app's admin pages (users, external providers, security policies) use Keycloak's admin API through a dedicated module. Users change password, 2FA and passkeys from their profile in the app.
- **Pros.** Mature software used in production everywhere, no authentication code written by us, 2FA, passkeys and social login ready to use.
- **Cons.** One more Java service to run and update, heavier than an embedded library. For self-hosting this is mitigated by a preconfigured docker-compose.

**Why OpenID Connect and not SAML.** OpenID Connect adds authentication on top of OAuth 2.0 and is the standard designed for mobile apps and single-page apps, with the Authorization Code + PKCE flow. It also provides tokens ready to call the API. SAML was designed for browser sign-in between websites and has no standard way to serve native apps or protect an API; many consumer identity providers do not support it either. If a SAML provider is ever needed, such as a company directory, Keycloak connects it as a secondary provider and the app keeps speaking OpenID Connect only.

### GDPR, for a hosted version

- Full data export (JSON and CSV) and account deletion, including from backups within a stated period.
- Privacy policy, records of processing and agreements with suppliers (hosting, email, market data).
- Servers in the European Union and data minimization: no advertising tracking, only anonymous and optional usage analytics.
- A data protection impact assessment (DPIA) before launch, reviewed by a privacy consultant.

## Offline sync and mobile

Every workspace uses the same protocol: changes travel field by field. In plaintext workspaces, which means all of them until the encryption module exists, the server is also the source of truth and does the calculations.

### Field-level change protocol

Each change is a small record:

| Record field | Plaintext workspace | Encrypted workspace |
| --- | --- | --- |
| Entity id, workspace, field name | Plaintext | Plaintext |
| Logical clock (when) and device | Plaintext | Plaintext |
| Value | Plaintext | Encrypted |

1. Every change has a UUID and a hybrid logical clock (HLC) timestamp generated on the device; sending it again never creates duplicates.
2. Offline, changes go into a local SQLite queue and are sent as soon as the network is back.
3. The server resolves conflicts by looking at the clock only: for each field, the most recent change wins. It never needs to read the value, so it works the same way in both kinds of workspace. Deletion is a field like any other (`deleted = true`), resolved by the same rule — never a special case.
4. Whoever loses a conflict sees a notice on that field, with the option to restore their own value (which is itself just a new, later change).
5. Reconciled transactions carry a plaintext "locked" flag: the server rejects later changes.
6. Each device downloads the changes that arrived after the last clock value it has seen.

The protocol is our own rather than a ready-made engine: engines that sync PostgreSQL tables with SQLite work on plaintext data and would force a second system for encrypted workspaces. The phase 0 prototype validates it with two devices, offline changes and conflicts.

### Plaintext and encrypted workspaces

| Aspect | Plaintext workspace | Encrypted workspace |
| --- | --- | --- |
| Offline queue on the device | Same | Same |
| Conflict resolution | Server, by clock | Server, by clock |
| Relational tables on the server | Yes, updated on every change, for calculations and analytics | No, only the change log |
| Balances, available amounts, rebalancing | Computed by the server and sent to devices | Computed on the device by the shared core |
| Budget notifications | Push from the server | Alert computed on the device |
| Monthly portfolio check | Job on the server | Scheduled notification on the device |

In an encrypted workspace the server sees which fields change and when, but not their values.

### Notifications

- **Budget, plaintext workspace.** When a change reaches the server, a job that recomputes the affected categories is queued in the same transaction. If a category goes negative, a purchase exceeds the available balance, or money arrives to be assigned, the server immediately sends a push to every member of the workspace. Resolving any of these — moving money, assigning the new income — needs the `owner` or `editor` role: a `read-only` member is notified but cannot act on it.
- **Budget, on the device making the change.** The alert appears immediately, computed locally by the shared core, even offline. The server's push reaches the other members; for the author of the change, the notification id prevents a duplicate.
- **Budget, encrypted workspace.** The server sends only a silent notification ("there are updates"); the device syncs, computes and shows the alert. On iOS silent notifications can be delayed: this must be measured.
- **Portfolio.** Monthly rebalancing check: a server job for plaintext workspaces, a scheduled notification on the device for encrypted ones.
- **Channels and preferences.** Push on iOS and Android, Web Push in the browser; users choose which alerts they receive and on which devices.
- **Storage.** A notification → destination table (the notification's content plus which device tokens it goes to) is enough; wording and where each one links to are designed later, when notifications are actually built (0.1.5).

### Mobile-specific features

- Quick expense entry in three taps, with suggested payee and category.
- Biometric unlock; amounts hidden when the app goes to the background.
- Instant budget notifications (negative category, purchase exceeds the available balance, money to assign); for the portfolio, only the monthly rebalancing summary.
- Widget with the available amounts of favorite categories (phase 3).
- Account list and register on the phone: balances, transactions grouped by day, search, marking transactions as cleared, and editing a transaction in a full-screen form.

## User interface

The interactive mockups in [docs/ux/mockups/](ux/mockups/) (open them in a browser) are the reference for layout, states, interactions and copy: [the budget month](ux/mockups/budget-month.html), [the account register](ux/mockups/account-register.html), [import and reconciliation](ux/mockups/import-reconciliation.html), [settings and first run](ux/mockups/settings-first-run.html) and [the portfolio](ux/mockups/portfolio.html). They show the Italian translation with sample data; English stays the source language. Where an implementation needs to differ from the mockup, agree it in the issue first and update the mockup and this section in the same pull request. The screenshots in the repository README come from these mockups (`docs/ux/screenshots/`); update them when a mockup they show changes.

### Principles

- **Colour marks problems.** A category with money is plain ink, because that is the normal state; zero is grey. Only what needs attention gets colour: red for cash overspending, amber for credit overspending, for targets still missing money, for reservations a category cannot cover and for uncovered card debt, blue for actions and selection.
- **Form as well as colour.** Every state is recognizable without colour: cash overspending is a solid red block, credit overspending amber hatching with a "card" label, a reservation the category cannot cover a dashed amber outline with a "reserved" label (dashed because nothing has happened yet), missing target money and uncovered card debt a label with an amber meter.
- **A ledger, not a dashboard.** Rules and hairlines instead of cards, shadows and pills; corners of 2 to 3 px at most; icons only where they carry meaning (month arrows, group chevrons, warnings, the phone's tab bar).
- **Summary before detail.** The month's table fills the width; detail opens in a side panel only when asked for, and closes again.
- **Numbers line up.** Tabular figures, right-aligned columns, amounts formatted for the user's locale with a real minus sign.
- **No envelope pictures.** "envelope" is a code name; the interface does not draw envelopes.
- **Neutral wording, never advice**, as everywhere in the app.

### Visual language

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `desk` | `#ECECE8` | `#131418` | Page ground, sidebar |
| `paper` | `#FFFFFF` | `#1B1D22` | Working surfaces: table, panel |
| `ink` | `#1A1C22` | `#ECEDF0` | Text and positive amounts |
| `muted` | `#686C76` | `#979BA6` | Secondary text, zero amounts |
| `rule` | `#D3D4CF` | `#343740` | Lines between rows and sections |
| `pen` | `#2340A0` | `#93A8F4` | Buttons, links, selection (`pen-soft` for selected rows) |
| `red` | `#B3241B` | `#D2392E` | Cash overspending, errors |
| `amber` / `warn` | `#E2A62C` / `#8C5300` | `#D9A23A` / `#EBB765` | Credit overspending, targets still missing money, reservations beyond the available amount, uncovered card debt |

Type is **Archivo**, one family with a width axis: condensed (72 to 78 %) for the month, panel titles, group names and uppercase labels; normal width for text and figures, with tabular lining numbers. Sizes: 40 px month title, 26 px panel title, 14 to 15 px body, 12 px labels (uppercase, 0.5 px tracking). The app self-hosts the font files: a self-hosted install must not call third-party servers.

Both themes follow the operating system setting and can be forced in the user's preferences. Text meets WCAG 2.2 AA contrast, every control is reachable by keyboard with a visible focus ring, and touch targets are at least 44 px.

### Budget month on the desktop

- **Sidebar:** workspace switcher; navigation (Budget, Accounts, Portfolio); on-budget accounts as a ledger with dotted leaders and their total, cards included as negative balances; off-budget accounts; "Add account"; the user and settings.
- **Header:** the month with previous and next arrows, days of buffer, money already assigned to future months, money reserved for scheduled transactions, and the "unassigned" box with its Assign button (its amount turns red when negative).
- **Toolbar:** filter tabs with a count badge each: All, Underfunded (amber: missing target money, reservations not covered, uncovered card debt), Overspent (red), With money; a zero count is shown outlined. Buttons: Summary, Targets, Scheduled, Quick assign, Move money, Undo (reverses the last assignment action, see below).
- **Notices:** one line when categories are overspent, with their count and total and a "Show" link that applies the Overspent filter; one line when scheduled transactions are past their date and not recorded, with "Open scheduled". After every assignment, move, recording or skip, a one-line confirmation says what happened, with "Undo" when it was an assignment.
- **Table:** columns Category, Assigned, Activity, Available, with totals in the header. A group row has a chevron that collapses it, a name that selects it, a red badge with the number of overspent categories it holds, and the group's totals. A category row shows its name, then up to two short status lines, and its amounts: the target meter with a short status ("€35.00 still needed this month", "target reached", "on track, €42.86 a month"); on a card's payment category, a meter of how much of the card's debt is covered ("€48.50 to cover of €642.30 of debt"); when scheduled transactions reserve money, a line with a clock icon ("€90.00 reserved · Boiler service, 29 Sep", "to record" when overdue, "€8.96 missing" in amber when the category cannot cover it). Available is net of reservations.
- **Editing the assigned amount:** clicking a row's Assigned amount selects the row and turns the amount into a field. Typing a new amount, or `+20` / `-15` for a change, and pressing Enter (or leaving the field) records the difference as one assignment entry; Esc cancels. Nothing else in the row is editable in place.
- **Side panel:** hidden when nothing is selected. It closes with "× Close", by clicking the selected item again, or with Esc. It shows one of:
  - *Category:* state, available amount and a sentence explaining what happens at the end of the month (or, for a reservation it cannot cover, that this is a warning and not overspending); covering overspending or a reservation shortfall by choosing the category to take money from (preselected: the smallest one that covers the whole amount, never a balance-to-keep target), or "or assign €X from unassigned money"; the month's ledger (carried over, assigned, activity, reserved for scheduled transactions, available) with a "Move money" link; its scheduled transactions, each with Record and Skip for this month's; the target with Edit, or "Add a target", and "Assign €X from unassigned money" when money is missing; quick assign (as assigned last month, as spent last month), which sets the assigned amount; the month's assignments from the ledger, newest first, with who made each one and "Undo" (an undone entry is struck through and marked "undone"); the month's transactions.
  - *Card payment category:* money set aside to pay the card; a sentence saying where uncovered debt comes from (the starting balance, or named categories overspent with the card this month); the card's debt: the card's balance, money set aside and "to cover", with "Assign €X from unassigned money" and "Move money here"; the month's ledger (carried over, assigned, card spending covered, card payments, available); assignments; transactions, where the starting balance is marked as debt that does not count as activity.
  - *Group:* available in the group; categories, overspent and targets reached; the group's ledger; "Fund the targets" for the group; its categories, each opening its own detail.
  - *Summary:* unassigned money with a sentence for its state (money not assigned yet, everything assigned, too much assigned); counts; "To fix" with overspent categories, missing targets, reservations not covered, uncovered card debt and scheduled transactions to record; the month's ledger; a reconciliation block showing that unassigned money + available + reserved + assigned to future months + this month's uncovered card spending = money in the on-budget cash accounts (cards excluded), noting that a card's starting balance is not part of it.
  - *Assign / Move money:* one form. From: unassigned money or a category with money; To: a category, or unassigned money when moving from a category; for the month (this month or one of the next two, only when assigning from unassigned money); amount. A live preview shows both sides before and after, and whether the overspending, reservation or card debt of the destination gets covered. A category cannot give more than its available amount; assigning more than the unassigned money is allowed with a red warning. "Assign" in the header opens it from unassigned money; "Move money" from a category's panel preselects that category and the amount it is missing. The result is one ledger entry.
  - *Quick assign:* a scope (all categories or one group) and six choices, each with how many categories and how much: fund the targets, cover the scheduled transactions, cover overspending, cover the cards' debt, as assigned last month, as spent last month. The preview lists what each category gets and unassigned money before and after; when unassigned money is not enough, categories are funded in table order until it runs out. One ledger entry per category, undone together.
  - *Scheduled:* money reserved this month, how many to record and what is planned next month; "To record" (past their date), "By the end of the month" and "Expected income" (income reserves nothing and lands in unassigned money when recorded), each with Record and Skip; a preview of the start of next month: what will be reserved, how much of it is already within a target, and per category "within the target", "the target asks €X: €Y missing" or "no target" with "Use as target"; and "+ New scheduled transaction" (expense or income, payee, category, account, amount, next date, repeat; optionally "use it as this category's target"), with a preview of how it changes the category's available amount. When a new month opens, its summary starts from this list.
  - *Targets:* every target grouped by kind, what the targets ask this month and what is still missing, "Fund all targets", and the categories without a target, each with "Add".
  - *Target editor:* the four kinds, each with a one-line explanation; amount (typed in the user's locale), due month, repeat interval; a live preview of what the target asks and what is missing this month; Save, Cancel and Remove.

### Budget month on the phone

One column: month, unassigned money, days of buffer, and a link with the number and total of overspent categories. Groups collapse by tapping their name; groups with overspending come first. A category row shows only its name, its status lines and the available amount; tapping it opens a full-screen detail with a back link, the same content as the desktop panel, and the same target editor. "Assign" and "Move money" open the desktop form full screen. The tab bar has Budget, Accounts, a central button for quick expense entry, Portfolio and More. Groups have no summary screen on the phone.

### Other screens

- **Account register.** Desktop: the account's cleared, pending and total balance; filters by state with counts; search; transactions newest first with a running balance, splits shown under their row; a round control on each row switches pending and cleared, reconciled rows show a padlock. A row opens in the side panel: outflow, inflow or transfer; the payee proposes the category used last time; the category's available amount before and after; splitting across categories with the amount still to split; transfers to a credit card are card payments, transfers to an off-budget account ask for a category. Phone: accounts list, register grouped by day, full-screen transaction form, and quick entry (amount keypad, place, category with its available amount, account).
- **Import and reconciliation.** Import in four steps (file, columns, check, done) and reconciliation with the statement balance, the difference, clues and locking, as described in "Import and reconciliation".
- **Settings.** Two separate places. *Your account*, from the user menu, holds what belongs to the person and applies in every workspace: profile, language, number and date format, personal time zone, theme, notifications and devices, sign-in and security. *Workspace settings*, from the workspace switcher, hold what every member shares: name, currency and the workspace time zone, members and roles, categories and groups, accounts, data export and deletion. Changing workspace settings needs the owner role, except categories, which editors can manage.
- **First run.** Five steps: a short introduction to how the budget works, the workspace, the first account with today's balance (cash accounts only; credit cards are added later), the starting categories, and the unassigned amount.
- **Portfolio.** Overview (value, contributions, gain, 12-month return, out-of-threshold notice, value against contributions over time, month-by-month table, allocation bars, positions), allocation editor (targets per level adding up to 100%, threshold rule, rebalancing presets), rebalancing (mode, contribution, minimum trade, whole or fractional units, "To get back to your targets:"), trade entry, and linked accounts showing how each brokerage account is split across its portfolios. A new portfolio is created with a short guided setup: name and purpose, accounts, how many units of each account's existing positions to move into it from another portfolio (a transfer without cash — it can also start empty), a starting allocation. Phone: value chart, allocation bars and the monthly check.

### Screens still to design

Each gets a mockup in `docs/ux/mockups/` before the milestone that builds it starts: sign-in and invitations; for later milestones, reports, prices and manual prices, ETF look-through, well-known allocations and the CAPE-based target.

## Open source, hosting and market data

The code is licensed under AGPL-3.0 and identical for self-hosting and any hosted version. The only difference would be the services that cost money, such as market data and bank connections.

### License and project

- **AGPL-3.0.** Anyone offering the app as an online service must publish their changes, so no competitor can close the code.
- **Contributions.** A contributor agreement (CLA or DCO) keeps the license manageable in the future.
- **Own name and trademark.** A distinctive name, logo and marketing, with no references to other products; register the chosen name.
- **Documentation.** Installation guide, contributor guide and API documentation.

### Hosted version

Not a current goal: it will be considered only after a long period of stable personal use. Before launch it would need the encryption module, an external security test and the legal reviews listed in this document.

- Same code, monthly or yearly subscription, free trial.
- The paid plan includes automatic quotes, bank connections, managed backups and support.
- Payments through an external payment provider: the app never handles card data.

### Market data

Prices come from interchangeable providers through a common interface, so the source can change without touching anything else.

| Source | Use | Caveat |
| --- | --- | --- |
| Manual entry or CSV | Always available, even offline | None |
| API with the user's key | Self-hosting: users bring their own account with a provider | Users accept the provider's terms |
| Commercially licensed provider | Hosted version | Monthly cost; the license must allow redistribution to users |
| ECB exchange rates | Daily euro reference rates | Only the currencies the ECB publishes |

Unofficial free sources (such as scraping financial websites) are never used in a hosted version: they often breach terms of use and break without notice.

### Regulatory aspects

Rebalancing based only on the user's own rules, without recommending instruments, should stay outside investment advice as defined by MiFID II. A legal opinion is still required before any commercial launch; this document is not legal advice. Clear terms of use and a notice that the app does not provide financial advice are also required.

## Documentation

The documentation explains not only what the code does but also how to change it step by step, for contributors new to modern web development. It lives in the repository's `docs/` folder, can be published as a static site, and is updated together with the code.

| Document | Purpose |
| --- | --- |
| Getting started | Install the tools and start the app locally |
| Project map | What is in each folder and how the pieces talk to each other, with diagrams |
| Decision records (ADR) | Why a technology or solution was chosen, and the discarded alternatives |
| How-to guides | Step-by-step recipes: add a database field, an endpoint, a screen, a trade type, a price source; write a test; publish a release |
| Domain guide | The rules of envelope budgeting and rebalancing, with numeric examples |
| Glossary | Financial terms ("unassigned", TWR, threshold) and technical ones (migration, component, hook, endpoint) |
| API documentation | Generated from the OpenAPI contract |
| Code comments | Explain why, not what; every core function has a description and an example |
| Changelog | What changed in each release |

Rule: no code change is accepted without updating the related documentation; the checklist of every change verifies it. Package READMEs include a "Things to understand" section that explains new concepts through comparisons with older web stacks (see [packages/core](../packages/core/README.md)).

## Roadmap

Work starts from the domain core and the web app for a single workspace, already on a multi-user architecture. Mobile comes once the core is stable, since it reuses the same logic. There are no deadlines: phases only have an order.

| Phase | Contents | Move on when |
| --- | --- | --- |
| 0. Foundations | Monorepo, CI, database, Keycloak, workspaces, domain core with tests | Sign-up, sign-in with 2FA, green CI |
| 1. Budget MVP (web) | Accounts, categories, assignment, transactions, credit cards, targets, moving money between categories, days of buffer, CSV/OFX/QIF/CAMT.053 import, reconciliation, i18n library with English and Italian | A real month of a household budget can be run with the app alone |
| 2. Portfolio MVP (web) | Instruments, trades, positions, historical prices, monthly performance, target allocation, thresholds, rebalancing | The dashboard reproduces the results of an existing spreadsheet-based tracker |
| 3. Mobile and offline | Expo app, local database, sync, quick entry, notifications | One week of use on two devices without loss or duplicates |
| 4. Public open-source beta | Docker, documentation | A self-hosted install works in under 10 minutes |
| 5. Hosted version (optional) | End-to-end encryption module, subscriptions, licensed market data, managed backups, external security test, legal and GDPR review | Security test passed and legal documents ready |
| 6. Evolutions | PSD2 bank connection, shared budgets, widgets | Driven by actual needs |

### After 1.0.0

Ideas kept for after the whole product is complete, each off by default and optional:

| Idea | What it does | Privacy |
| --- | --- | --- |
| Place-aware suggestions (mobile) | With the user's permission, the phone remembers where expenses are recorded and, back at the same place, proposes the payee and category used there | Opt-in per device; a place is stored as an approximate area, never as a track; the list of places can be viewed and deleted |
| Receipt reading | A photo of a receipt becomes a draft transaction with date, amount, merchant and, where present, the VAT number; the reading service is configured by the administrator (a self-hosted engine or an external provider with their own key) | No service is enabled by default; the photo is discarded after reading unless the user attaches it to the transaction |
| Foreign-currency budget accounts | An on-budget account in a currency other than the workspace's base currency | Portfolio instruments in other currencies already work today (see Multi-currency); this is only about budget accounts |

The field-level sync protocol is designed here (this section) but only ships, as its own milestone, once the API surfaces it needs (queue, authenticated multi-workspace requests) exist — see `CLAUDE.md`'s numbered step list for the exact within-phase sequencing, which is more detailed than the phase table above and takes precedence where the two seem to disagree. Targets, reports and broker import each carry their own `Phase` tag where they are first described (budget MVP, budget phase 2 and portfolio phase 2 respectively); phase 4 here is only about packaging what by then already exists. End-to-end encryption and local tax rules are each described once, where most specific (this section's "End-to-end encryption: a future, optional module" and the Portfolio module table), not repeated in phase 6.

## Decisions

| Topic | Decision |
| --- | --- |
| Goal | Personal and family use, self-hosted; a hosted version for others only later, if ever |
| Code name | `envelope`; the final name will be set in a single configuration place |
| Starting point | A new project written from scratch |
| Stack | TypeScript everywhere, Node.js 24 |
| Languages | Code, comments, repository documentation and commits in English; translatable UI with English as the source and Italian always complete ([ADR 0004](adr/0004-internationalization.md)) |
| Sync | Our own field-level change protocol, the same for plaintext and encrypted workspaces; validated by a phase 0 prototype |
| End-to-end encryption | Optional per workspace, as a future module; the architecture accounts for it from day one |
| Queue | pg-boss on PostgreSQL behind an interface, with outbox, deduplication and a mandatory double-delivery test; RabbitMQ adapter when needed |
| Authentication | Keycloak as identity provider, OpenID Connect only |
| Allocation | Multi-level; an instrument can be split across items; ETF look-through where data is available |
| Cash | An allocation item, with a percentage or fixed-amount target |
| Dynamic target | Linear CAPE rule between user-set limits; CAPE entered at the monthly check |
| Momentum | Informative indicators only: six-month trend (Rising, Falling, Flat) and detail indicators; no rotation strategies |
| ETF holdings data | Issuer file uploaded by the user and manual entry; a paid API adapter later |
| Portfolio notifications | Monthly check only |
| Budget notifications | Instant, from the server to every member, and locally on the device making the change |
| Days of buffer | Amount-weighted average over the outflows of the last 30 days, first in first out; monthly history in reports |
| Timeline | No deadlines; phases only have an order |
| Interface | Ledger-like visual language where colour marks problems; Archivo, self-hosted; the budget month mockup in `docs/ux/mockups/` is the reference (see "User interface") |
| Monthly assignments | An append-only ledger of debit/credit entries, never a mutable per-category total, so concurrent offline edits never conflict ([ADR 0008](adr/0008-assignment-ledger.md)) |
| Credit card debt | Uncovered debt is derived (card balance minus the payment category's available), never persisted; the payment category behaves like every other category otherwise (see "Credit cards") |
| Scheduled transactions | Reserve money ahead of being recorded; reservations never carry over to the next month (see "Scheduled transactions") |
| Import | Staged until every row is categorized, a transfer or income; unconfirmed staging expires after 7 days (see "Import and reconciliation") |
| Foreign-currency budget accounts | After 1.0.0 (see "After 1.0.0") |
