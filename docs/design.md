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
| Accounts | Checking, credit card, cash, savings, brokerage (always off budget); "off-budget" accounts for mortgages and investments | MVP |
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
- **Income on a card** (cashback, a card-issuer bonus — nothing tied to a specific purchase) is recorded as the composition of two things that already exist: a normal income entry (unassigned money +X) and a card payment (spending the payment category by X, per the existing card-payment rule). If the payment category does not hold X, the excess behaves like an ordinary payment beyond what was set aside (cash overspending). A merchant refund credited to the card stays a refund to its original spending category, as today — this rule is only for inflows with no category of their own. Not built yet: until it is, the API refuses an uncategorized transaction on an on-budget card with `card_income_not_supported` (#548) rather than storing a row the budget month cannot read.
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
| Portfolios | Several per workspace (for example "Long term", "Third pillar", "Fourth pillar"). A portfolio can span several brokerage accounts, and one brokerage account can hold several portfolios: every trade is assigned to exactly one portfolio at entry (never left unassigned, and an account is never treated as if it were a portfolio), so an account's positions are split logically across its portfolios. An archived portfolio takes no new trades (unarchiving it lets it take them again); the trades it already has stay editable and deletable, it can be emptied by a transfer out of it, and a split of an instrument it holds still applies to it, since a split is a fact about the instrument | MVP |
| Instruments | ETFs, stocks, bonds, funds, cash; search by ISIN or ticker; currency, exchange, asset class. Private instruments, with no ISIN and no ticker (real estate, a company pension fund), are not supported yet: they are planned as instruments scoped to one workspace in milestone 0.2.1 (#505) | MVP |
| Trades | Buy, sell, dividend or coupon, fees, taxes, split, transfer of securities | MVP |
| Positions | Quantity, average cost (weighted, per account and instrument, [ADR 0011](adr/0011-quantities-and-prices-as-scaled-integers.md)), current value, unrealized and realized gains or losses | MVP |
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

The portfolio connects to the budget through off-budget accounts. A payment from the checking account to the broker is a transfer from an on-budget account to an off-budget one, so it asks for a category on its on-budget leg (#378), like any money that leaves the budget: the monthly investment is planned as an envelope (an "Investments" category, for example), and the transfer is that category's spending. Money brought back from the broker to an on-budget account is income to assign: it lands as Unassigned in the month of its date by default, or in a category chosen for it; into an on-budget credit card a category is required (#598). Trades themselves never touch the budget: they move cash within the brokerage account ([ADR 0012](adr/0012-trade-cash-legs.md)).

How to record all of this through the API, with every endpoint, body and validation code, is in the [portfolio API reference](portfolio-api.md).

### Tax regime of brokerage accounts

A workspace has an optional **tax country** (ISO 3166-1 alpha-2), set by its owner. It decides which tax data a brokerage account must carry; only `IT` asks for any today, other countries are added with their own rules. Nothing here computes a tax yet: these records let trades be checked against the regime now, and let the local tax rules (milestone 0.11.0) estimate taxes later. The three regimes are described in the [domain guide](domain-guide.md#tax-regimes-of-a-brokerage-account).

- **One account, one dossier.** An app account is one dossier at the broker. One broker can hold several dossiers under different regimes; each is its own account here.
- **Regime history, not a single value.** Each brokerage account keeps a list of periods, each a regime and the first day it applies: `self_declared`, `administered` or `managed`. A trade uses the regime in force on its own date (`regimeAt` in `@envelope/core`), so a change from a later 1 January does not alter trades dated before it; recording or correcting the history re-reads the trades it covers. The first period may start on any date, and also applies to every date before it: before the first recorded change, the initial regime is the only one known, so older trades imported later need no backdated regime. Its date (by default the day it is recorded) only marks when it was recorded. Every later period starts on 1 January (`tax_regime_change_not_year_start`), and no two periods start on the same day (`tax_regime_duplicate_date`). A switch in the middle of a year is, in practice, two accounts and a transfer of securities between them.
- **Correcting the history.** An owner or editor can add a period (`POST .../tax-regimes`) or replace the whole history at once (`PUT .../tax-regimes`), for example to record that an account was self-declared before it became administered. The replacement happens in one transaction, under the account's lock, and is checked by the same rules.
- **Withholding agent, fixed per account.** A brokerage account also records whether the broker is an Italian withholding agent. The flag has no history: a change of the broker's status means a new account and a transfer of securities. It is used only to validate the regime and, later, for estimates; the tax actually withheld on each dividend, coupon or sale is recorded on that trade, and that is the fact. An administered or managed regime, anywhere in the history, needs the flag set to true (`tax_regime_requires_withholding_agent`): there the broker settles the tax itself. In the self-declared regime the flag decides which withholdings can appear on the account's income: an Italian withholding agent still withholds on income from funds and ETFs (including the gain when units are sold or redeemed), dividends and coupons; a foreign broker applies no Italian withholding of its own.
- **When they are required.** Creating a brokerage account in an `IT` workspace needs both the regime and the withholding-agent flag (`tax_regime_required`); any other account type, or a workspace whose tax country is not `IT`, refuses either (`tax_regime_not_applicable`). A brokerage account created before its workspace's tax country became `IT` keeps working with no regime until one is added; its flag can be set once (`PATCH .../accounts/:accountId`) while it has none. On such an account in an `IT` workspace, a trade is refused only while its regime history is empty (`tax_regime_required`). Once a regime is added, it covers every earlier trade too.
- **Trades are checked against the regime** in force on their trade date, in an `IT` workspace only (`tax_kind_not_allowed_in_regime`): gain tax on a sale is not allowed in `managed`, where the mandate settles it, and in `self_declared` only on a fund at a broker that is an Italian withholding agent; a `managed_result_tax` only in `managed`. A gain tax adjustment is allowed when any regime in force on or before its date allowed gain tax (an administered sale in December, self-declared from 1 January, a refund in February); in `self_declared` it names the fund it adjusts. The domestic withholding on the accrued interest of a bond buy or sale needs a broker that is an Italian withholding agent (`domestic_withholding_requires_agent`); a dividend's or a coupon's may have been taken upstream, so any broker can carry it. The amounts themselves are never compared with an estimate: the broker's figures are authoritative.
- **Managed accounts.** In the managed regime the tax applies to the result the mandate accrued over the year, realized or not, and the manager, an Italian intermediary, applies it. A managed (discretionary mandate) account is normally modelled as one private "mandate" instrument per account with a manually entered value, which needs private instruments (milestone 0.2.1). Until then, a managed account records individual trades only.
- **Deferred to the local tax rules (milestone 0.11.0):** tax estimates, loss carry-forward and its expiry, conversion to euro, per-taxpayer averages, account owners.

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
| Workspace | name, base currency, reference time zone, tax country (optional), plan | Security boundary: every query is filtered by workspace |
| Membership | user, workspace, role | Owner, editor, read-only |
| Account | type, currency, on or off budget, withholding agent (brokerage only), closed | Bank accounts, cards, brokers; each real account lives in exactly one workspace |
| AccountTaxRegime | account, valid from, regime | A brokerage account's regime history (see "Tax regime of brokerage accounts"): self-declared, administered or managed; later periods start on 1 January |
| Transaction | account, date, amount, payee, status (pending, cleared, reconciled) | Edited in place (a new amount on one leg of a transfer gives the other leg the opposite amount), or deleted outright (both legs together for a transfer); reconciled transactions neither, until unlocked |
| Split | transaction, category, amount | One transaction across several categories |
| Category / Group | name, order, archived | |
| AssignmentEntry | batch (device-generated, shared by every entry of one user action), month, source category (null = unassigned), destination category (null = unassigned), amount, author, reverses (another entry, optional) | Append-only ledger, never a mutable total: assigning is null→category, unassigning is category→null, moving money is one entry from A to B; quick assign is one entry per category, sharing a batch, undone together. A category's assigned amount in a month is incoming minus outgoing entries. Undo is new entries with `reverses` set, never an edit ([ADR 0008](adr/0008-assignment-ledger.md)) |
| Scheduled | account, category, payee, amount, next due date, every N days/months/years | Reserves money ahead of being recorded (see "Scheduled transactions") |
| Goal | category, type, amount, due date | |
| Instrument | ISIN, ticker, exchange, name, type, currency, asset class, price factor | Shared across users; private data kept separate. The type keeps apart what tax rules treat differently, since a shared row is never updated: stock, fund (ETFs included), ETC/ETN, government bond (government, white-listed-state or supranational issuer), other bond, certificate, cash, other. One row per listing: the same ISIN can trade on several exchanges, in different currencies. Identified by an ISIN or by a ticker on an exchange, the exchange being its ISO 10383 market identifier code (MIC, such as XMIL); append-only for users, corrected by an administrator. The price factor turns a price into an amount (amount = quantity × price × factor), stored scaled by 10^6 as an integer ([ADR 0011](adr/0011-quantities-and-prices-as-scaled-integers.md)): 0.01 for a bond quoted in percent of nominal or a price in pence |
| Price | instrument, date, close, source | Daily time series |
| FxRate | currency pair, date, rate | Historical rates for multi-currency |
| Portfolio | name, purpose, archived, allocation | Linked to accounts through its trades: a portfolio can span several accounts and an account can hold several portfolios |
| Trade | account (brokerage), portfolio, instrument (none for an account-wide fee or tax), type, trade date, time (optional), quantity, price, gross, fees, transaction tax, accrued interest, foreign and domestic withholding, gain tax, tax kind, cost (transfer in from outside only), split ratio, other leg of a transfer, memo | Buy, sell, dividend (coupons too), fee, tax, split, transfer. Every amount is in the account's currency, which in 0.2.0 must be the instrument's. A split is entered once and becomes one row per portfolio holding the instrument, in every account; a transfer is two linked rows (between two portfolios of one account: quantity only; between two accounts: the cost follows the outgoing leg), or one row for a transfer from or to outside the app. A trade that moves cash owns its cash leg, a transaction on the same account ([ADR 0012](adr/0012-trade-cash-legs.md)). A trade that would make a portfolio's holding negative at any date is refused, and so is an edit or a deletion that would. A transfer's two legs, and a split's rows, are edited and deleted together; the type of a trade never changes (delete it and record another) |
| AllocationNode | portfolio, parent, name, target, threshold | Tree of the target allocation |
| AllocationLink | node, instrument, share | Which instrument falls in which item, and in what proportion |
| AuditLog | who, what, when, before and after | Append-only |

### Accounting rules

- **Amounts as integers.** In cents, or the currency's minor unit. Never floating-point numbers ([ADR 0002](adr/0002-amounts-in-minor-units.md)).
- **High-precision quantities.** Fixed decimal with 8 digits for fractional shares; prices with 6 digits. Both are scaled integers (`quantity_e8`, `price_e6`), with one rounding rule per conversion ([ADR 0011](adr/0011-quantities-and-prices-as-scaled-integers.md)).
- **Derived values are never the source of truth.** Balances and positions are recomputed from transactions; caches are rebuildable optimizations.
- **A trade owns its cash leg.** The cash a trade moves (a buy's cost, a sale's or a dividend's net proceeds, a fee, a tax) is one transaction on the trade's brokerage account, written with the trade and derived from it: its amount, account and date cannot be changed on their own, through the API or sync: editing the trade rewrites them (creating the leg when the trade starts moving cash, deleting it when it stops), and deleting the trade deletes the leg; its memo, payee and cleared status are its own; the memo and payee survive an edit, and so does the status unless the edit changes the leg's amount, account or date, which sends a cleared leg back to uncleared. A trade whose leg is reconciled cannot be edited or deleted until the reconciliation is unlocked. It starts uncleared, dated on the trade date: it clears once the trade settles and shows on the broker's statement. A brokerage account's balance is therefore the transfers into and out of it plus its cash legs, and since the account is off budget, trades never change the budget ([ADR 0012](adr/0012-trade-cash-legs.md)).
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
- **Isolation.** Row-Level Security in PostgreSQL on top of the API checks: a bug in the code must never expose another user's data. Foreign keys are checked without Row-Level Security, so every reference between two workspace tables includes `workspace_id` and cannot point at another workspace's row ([ADR 0006](adr/0006-row-level-security.md)).
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

### Assistant access (MCP)

A member can let an AI assistant read their workspace through an MCP server, `apps/mcp`, a separate process that reaches data only through the API, with no database credentials of its own ([ADR 0014](adr/0014-assistant-access-through-mcp.md)).

- **Off by default.** The owner sets `assistant_access` per workspace: off, owner only, or all members.
- **Local first, read-only** (milestone 0.2.8): over stdio, signed in with the device authorization grant, tokens kept in memory only.
- **Remote** (milestone 0.4.1): over Streamable HTTP, behind an internet-facing Keycloak with multi-factor authentication for every user, pre-registered clients only, token exchange to a reduced-scope token for the API, an IP allowlist, and every new connection approved from the web app on the LAN. The server is reached through a small relay host that forwards TLS unopened over an outbound tunnel, so no port is opened at home (ADR 0014, D9).
- **Writes only as drafts** (milestone 0.4.2): an assistant proposes transaction and trade drafts that a member confirms in the web app; a restrictive policy in the database refuses every other write made on an assistant's behalf.
- **Encrypted workspaces** are never reachable remotely, and locally only if the owner opts in (milestone 0.8.0).
- **No advice.** Tools return the engine's own figures in neutral wording; what the assistant then says is its own.

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

1. Every change has a UUID and a hybrid logical clock (HLC) timestamp generated on the device; sending it again never creates duplicates and gets the same answer as the first time. The UUID is unique within the workspace: the same id in another workspace is an unrelated change, and a different change sent under an id already used is refused.
2. A change applies only to an entity of the workspace it is sent to; any other entity is answered as not found, and the change is not recorded.
3. Offline, changes go into a local SQLite queue and are sent as soon as the network is back.
4. The server resolves conflicts by looking at the clock only: for each field, the most recent change wins. It never needs to read the value, so it works the same way in both kinds of workspace. Deletion is a field like any other (`deleted = true`), resolved by the same rule — never a special case.
5. Whoever loses a conflict sees a notice on that field, with the option to restore their own value (which is itself just a new, later change).
6. Reconciled transactions carry a plaintext "locked" flag: the server rejects later changes.
7. Each device downloads the changes that arrived after the last clock value it has seen.

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

- **Budget, plaintext workspace.** When a change reaches the server, a job that recomputes the affected categories is queued in the same transaction. If a category goes negative, a purchase exceeds the available balance, or money arrives to be assigned, the server immediately sends a push to every member of the workspace — but only when that problem is new or its amount has changed since the last check, not every time the job runs while it persists unchanged. Resolving any of these — moving money, assigning the new income — needs the `owner` or `editor` role: a `read-only` member is notified but cannot act on it.
- **Budget, on the device making the change.** The alert appears immediately, computed locally by the shared core, even offline. The server's push reaches the other members; for the author of the change, the notification id prevents a duplicate.
- **Budget, encrypted workspace.** The server sends only a silent notification ("there are updates"); the device syncs, computes and shows the alert. On iOS silent notifications can be delayed: this must be measured.
- **Portfolio.** Monthly rebalancing check: a server job for plaintext workspaces, a scheduled notification on the device for encrypted ones.
- **Channels and preferences.** Push on iOS and Android, Web Push in the browser; users choose which alerts they receive and on which devices.
- **Storage.** A notification → destination table (the notification's content plus which device tokens it goes to) is enough. Wording: the budget alert's title/body is composed server-side in the recipient's own `language`, from a small, self-contained English/Italian lookup local to `apps/api` (ADR 0009's catalog-based i18n library, FormatJS, is for the apps, not the server; a push notification has no UI on the receiving end to translate a code, unlike a `ValidationError`). Where each one links to is still open, for the web app.

### Mobile-specific features

- Quick expense entry in three taps, with suggested payee and category.
- Biometric unlock; amounts hidden when the app goes to the background.
- Instant budget notifications (negative category, purchase exceeds the available balance, money to assign); for the portfolio, only the monthly rebalancing summary.
- Widget with the available amounts of favorite categories (phase 3).
- Account list and register on the phone: balances, the first two things to do, transactions grouped by day, search, marking transactions as cleared, and editing a transaction in a full-screen form.

## User interface

The interactive mockups in [docs/ux/mockups/](ux/mockups/) (open them in a browser) are the reference for layout, states, interactions and copy: [the budget month](ux/mockups/budget-month.html), [the account register](ux/mockups/account-register.html), [import and reconciliation](ux/mockups/import-reconciliation.html), [settings and first run](ux/mockups/settings-first-run.html), [sign-in](ux/mockups/sign-in.html) and [the portfolio](ux/mockups/portfolio.html). They show the Italian translation with sample data; English stays the source language. Where an implementation needs to differ from the mockup, agree it in the issue first and update the mockup and this section in the same pull request. The screenshots in the repository README (`docs/ux/screenshots/`) come from the real running app, except the portfolio (no screen yet) and the three-phone composite, which come from these mockups (`scripts/README.md`, "Reference screenshots", lists which is which and how to regenerate them). Every screenshot is taken in both themes, as `<name>-light.png` and `<name>-dark.png`; update both when a screen or mockup they show changes. [`docs/ux/README.md`](ux/README.md) indexes every screen against its mockup, the navigation structure, a reusable component catalog and the accessibility baseline (#70).

### Principles

- **Colour marks problems.** A category with money is plain ink, because that is the normal state; zero is grey. Only what needs attention gets colour: red for cash overspending, amber for credit overspending, for targets still missing money, for reservations a category cannot cover and for uncovered card debt, blue for actions and selection. The mariner band at the top is the one colour that is not a state: it carries navigation, the month and unassigned money.
- **Form as well as colour.** Every state is recognizable without colour: cash overspending is a solid red block, credit overspending amber hatching with a "card" label, a reservation the category cannot cover a dashed amber outline with a "reserved" label (dashed because nothing has happened yet), missing target money and uncovered card debt a label with an amber meter.
- **Shapes, not columns.** A category is a bar, not a row of three numbers: its length is what the category was given, a darker part what was spent, stripes what is reserved, and overspending sticks out past the end. One number per row, the available amount. The month itself is a line of days. This is also what keeps envelope from looking like every other budgeting app, whose month is a table of assigned, activity and available.
- **Quiet surfaces.** Soft tinted surfaces and rounded corners (7 to 16 px) instead of rules everywhere; no shadows; icons only where they carry meaning (month arrows, group chevrons, the clock of a reservation, the phone's tab bar).
- **Summary before detail.** First where the month stands (the band), then what happened and what is coming (the timeline) and what needs doing ("To do"), then the categories. A category's detail opens in its own row; month-wide tools open in a side sheet; both close again.
- **Numbers line up.** Tabular figures, right-aligned columns, amounts formatted for the user's locale with a real minus sign.
- **No envelope pictures.** "envelope" is a code name; the interface does not draw envelopes.
- **Neutral wording, never advice**, as everywhere in the app.

### Visual language

The light theme is a pale sea blue with white working surfaces under a mariner band; the dark theme is graphite, almost neutral, under a brighter mariner band, so the band stays the one strong colour.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `desk` | `#E4ECF5` | `#121417` | The timeline and "To do" surfaces, a row's open detail — never the page itself |
| `paper` / `paper-2` | `#FFFFFF` / `#F2F6FB` | `#1A1D21` / `#20242A` | The page ground and working surfaces; group rows and the side sheet |
| `band` / `band-2` | `#173B60` / `#24507D` | `#1D4570` / `#2B5888` | The mariner band; controls and the unassigned box inside it (`band-ink`, `band-muted` for its text) |
| `ink` / `ink-2` | `#13263A` / `#3E5267` | `#E8ECF1` / `#BDC4CD` | Text and positive amounts |
| `muted` | `#627589` | `#8B939E` | Secondary text, zero amounts |
| `rule` / `rule-soft` | `#D2DDE9` / `#E8EEF5` | `#2D3137` / `#23272C` | Lines where a line is needed |
| `pen` | `#1E5A92` | `#8DBCEB` | Buttons, links, selection (`pen-soft` for an open row), income in the timeline |
| `bar` / `spent` | `#79AADB` / `#CBD6E1` | `#4277AC` / `#383D45` | A bar's money still available / already spent |
| `red` | `#C2412D` | `#D9553F` | Cash overspending, errors |
| `amber` / `warn` | `#DE9F2F` / `#8A5A04` | `#D19A35` / `#ECBA6A` | Credit overspending, targets still missing money, reservations beyond the available amount, uncovered card debt |

Type is **Bricolage Grotesque** for the month, titles, group names and big figures (slightly narrowed, 88 to 92 % width), and **Figtree** for text, labels and figures, with tabular lining numbers. Labels are in sentence case; there are no uppercase labels. Sizes: 46 px month, 24 to 30 px titles and big figures, 14 to 15 px body, 12 to 13 px secondary text. Both families are open source; the app self-hosts the font files, since a self-hosted install must not call third-party servers.

Both themes follow the operating system setting and can be forced in the user's preferences. Text meets WCAG 2.2 AA contrast, every control is reachable by keyboard with a visible focus ring, and touch targets are at least 44 px.

### Budget month on the desktop

- **Band:** the mariner band across the top replaces the sidebar. First line: a button that opens the accounts panel (`#412`), the wordmark, navigation (Budget, Accounts, Portfolio) as rounded tabs, the workspace switcher and the user menu. Second line: the month with previous and next arrows, the "unassigned" box with its Assign button (its amount turns red when negative), and on the right money reserved for scheduled transactions, money already assigned to future months and days of buffer. Accounts and their balances live on the Accounts screen by default, not on every screen — the accounts panel is a dismissible detour from wherever you already are, not a second place they always show: closed by default, taking no layout space until opened, deliberately not the persistent sidebar `#323` removed. It opens on the left, over whichever screen is already showing, with the workspace's net worth at its head (every on-budget and off-budget account, cards included), then on-budget accounts, credit cards and off-budget accounts each in their own group; a row switches the main content straight to that account's own register without leaving the panel; a link at its foot goes to the full Accounts screen.
- **Timeline:** "September, day by day", a running total of the month's days, starting at zero on day 1 and moving with each day's own net amount — not a judgement colour: a day that moved the total up or down is `pen`/`ink`, the same tokens already used for income and ordinary text, never `red`/`amber`, which stay reserved for a real problem. The account register shows the same timeline for one account, with transfers counted the same way. Recorded movements build the solid, actual part of the line, up to today; scheduled ones extend it, dashed, to the end of the month — an overdue one folds into today's own point instead of its own earlier day, with a small amber marker, rather than moving the solid line itself. Days after today sit on a lighter ground behind a "today" line. A dashed reference line at today's own height, with its amount, calls out the current value — what has moved so far this month, not the account's real balance, the one thing a multi-account budget month has no single one of. A handful of light gridlines mark a few round amounts along the vertical scale, so a given height on the line reads as an actual amount, not just a shape; their amounts sit in a gutter left of the plot, as wide as the widest of them, so the line never runs over them and a long negative amount is never cut off, and early in the month, when there is no room left of the "today" line, its label moves to the right of it; the first tick (day 1) also names the month ("Sep 1"), so the axis does not rely only on the heading above it. Both are full-width mode only — the phone's own small timeline keeps just the running line and "today".
- **To do:** next to the timeline, a list of what needs attention, each with its amount and one action: overspent categories ("Cover Groceries", red dot for cash, amber for card), scheduled transactions to record ("Record"), reservations a category cannot cover, cards' uncovered debt and, as one line, the targets still missing money ("Fund"). Opening an item opens its category in its row. It replaces the old one-line notices; an empty list says there is nothing to fix this month.
- **Toolbar:** above the bars, filter tabs with a count badge each: All, Underfunded (amber: missing target money, reservations not covered, uncovered card debt), Overspent (red), With money; a zero count is shown outlined. Buttons: Summary, Targets, Scheduled, Quick assign, Move money, Undo (reverses the last assignment action, see below). After every assignment, move, recording or skip, a one-line confirmation says what happened, with "Undo" when it was an assignment.
- **Bars:** one per category, grouped. A group row (tinted, rounded) has a chevron that collapses it, a name that opens the group's summary in the side sheet, a red badge with the number of overspent categories it holds, and the group's available amount. A category row has three parts. Its name, with a muted line of what was spent of what it was given ("€642.15 spent of €600.00", "€350.00 to spend") and up to one more status line: the target meter ("€35.00 still needed this month", "target reached", "on track, €42.86 a month"), the clock line of a reservation ("€90.00 reserved · Boiler service, 29 Sep", "to record" when overdue, "€8.96 missing" in amber), or on a card's payment category the debt meter ("€48.50 to cover of €642.30 of debt"). The bar: its track (82 % of the width) is carried over plus assigned; inside it, spent (`spent`), reserved (stripes) and still available (`bar`); past its end, at most 18 % more, cash overspending (solid red), card overspending (amber hatching) or a reservation beyond what is left (dashed amber outline). A card's payment category draws its debt instead: covered in `bar`, uncovered hatched. And the available amount, in the same cells as before (red block, hatched "card", dashed "reserved"). A legend under the bars names the five fills. Available is net of reservations.
- **Categories and groups from the budget month** (`#397`, `docs/ux/mockups/budget-categories.html`): adding and renaming, the two things a budgeting session reaches for mid-month, happen right here; reordering and archiving stay in Workspace settings → Categories, the full management view. Each group row has one quiet "⋯" menu: "Add a category" (an inline name field at the end of the group, which stays open after each add, since two or three in a row is the common case), "Rename group" (the group row turns into the same field), and "Reorder or archive…", which opens Workspace settings → Categories. "+ Add a group" sits below the last group; a new group goes straight on to its first category. A category's own detail has "Rename" next to its name. Names are typed in place, never in a side sheet: Enter saves, Esc cancels; an empty name, or one already used by another category in the same group (another group, for a group), is refused with a one-line message under the field. A new category starts empty, with nothing assigned. The "Credit card payments" group and a card's own payment category keep their names (each card's payment category is named after its card), so that group's menu offers only the way to Workspace settings, and a payment category's detail has no "Rename". Only an owner or an editor sees any of it (categories are the one workspace setting editors manage); a read-only member sees the bars exactly as before. On the phone the same menu, at a 44px target, and "Rename" in the category's full-screen detail.
- **A category's detail** opens in its own row, below the bar, on the `desk` ground, in three columns; clicking the row again, "× Close" or Esc closes it. The assigned amount is a field there: typing a new amount, or `+20` / `-15` for a change, and pressing Enter (or leaving the field) records the difference as one assignment entry; Esc cancels.
- **Side sheet:** month-wide tools open in a sheet on the right, which narrows the bars while it is open, and closes with "× Close", the same button again, or Esc. The category and card detail below are what the row shows; the sheet shows the rest:
  - *Category* (in its row): state, available amount and a sentence explaining what happens at the end of the month (or, for a reservation it cannot cover, that this is a warning and not overspending); covering overspending or a reservation shortfall by choosing the category to take money from (preselected: the smallest one that covers the whole amount, never a balance-to-keep target), or "or assign €X from unassigned money"; the month's ledger (carried over, assigned, activity, reserved for scheduled transactions, available) with a "Move money" link; its scheduled transactions, each with Record and Skip for this month's; the target with Edit, or "Add a target", and "Assign €X from unassigned money" when money is missing; quick assign (as assigned last month, as spent last month), which sets the assigned amount; the month's assignments from the ledger, newest first, with who made each one and "Undo" (an undone entry is struck through and marked "undone"); the month's transactions.
  - *Card payment category* (in its row): money set aside to pay the card; a sentence saying where uncovered debt comes from (the starting balance, or named categories overspent with the card this month); the card's debt: the card's balance, money set aside and "to cover", with "Assign €X from unassigned money" and "Move money here"; the month's ledger (carried over, assigned, card spending covered, card payments, available); assignments; transactions, where the starting balance is marked as debt that does not count as activity.
  - *Group:* available in the group; categories, overspent and targets reached; the group's ledger; "Fund the targets" for the group; its categories, each opening its own detail.
  - *Summary:* unassigned money with a sentence for its state (money not assigned yet, everything assigned, too much assigned); counts; "To fix" with overspent categories, missing targets, reservations not covered, uncovered card debt and scheduled transactions to record; the month's ledger; a reconciliation block showing that unassigned money + available + reserved + assigned to future months + this month's credit overspending (`creditOverspending`, the transient term of the invariant — not `uncovered`, which is cumulative and includes starting balances) = money in the on-budget cash accounts (cards excluded), noting that a card's starting balance is not part of it.
  - *Assign / Move money:* one form. From: unassigned money or a category with money; To: a category, or unassigned money when moving from a category; for the month (this month or one of the next two, only when assigning from unassigned money); amount. A live preview shows both sides before and after, and whether the overspending, reservation or card debt of the destination gets covered. A category cannot give more than its available amount; assigning more than the unassigned money is allowed with a red warning. "Assign" in the header opens it from unassigned money; "Move money" from a category's panel preselects that category and the amount it is missing. The result is one ledger entry.
  - *Quick assign:* a scope (all categories or one group) and six choices, each with how many categories and how much: fund the targets, cover the scheduled transactions, cover overspending, cover the cards' debt, as assigned last month, as spent last month. The preview lists what each category gets and unassigned money before and after; when unassigned money is not enough, categories are funded in table order until it runs out. One ledger entry per category, undone together.
  - *Scheduled:* money reserved this month, how many to record and what is planned next month; "To record" (past their date), "By the end of the month" and "Expected income" (income reserves nothing and lands in unassigned money when recorded), each with Record and Skip; a preview of the start of next month: what will be reserved, how much of it is already within a target, and per category "within the target", "the target asks €X: €Y missing" or "no target" with "Use as target"; and "+ New scheduled transaction" (expense or income, payee, category, account, amount, next date, repeat; optionally "use it as this category's target"), with a preview of how it changes the category's available amount. When a new month opens, its summary starts from this list.
  - *Targets:* every target grouped by kind, what the targets ask this month and what is still missing, "Fund all targets", and the categories without a target, each with "Add".
  - *Target editor:* the four kinds, each with a one-line explanation; amount (typed in the user's locale), due month, repeat interval; a live preview of what the target asks and what is missing this month; Save, Cancel and Remove.

### Budget month on the phone

One column in the desktop's order: the band with the month, unassigned money and Assign; a small timeline that keeps only the running line and "today"; the first three things to do, with how many more; then the groups and bars, the name and available amount above a full-width bar. Groups collapse by tapping their name. Tapping a category or a thing to do opens a full-screen detail with a back link, the same content as the desktop row's detail, and the same target editor. "Assign" and "Move money" open the desktop form full screen. The tab bar has Budget, Accounts, a central button for quick expense entry, Portfolio and More. Groups have no summary screen on the phone.

### Other screens

Every screen uses the same band for navigation and the same tokens and type, and uses the full width under the band — the account register included: its own list of accounts lives on the Accounts screen instead (`#323` removed the band's shared account ledger in favor of that single, dedicated screen).

- **Account register.** Desktop: the account's name and, large in the display face, its balance, with the cleared and pending amounts and the projected balance at the end of the month (today's balance plus the scheduled transactions of the month that are not recorded yet) beside it; under it the same timeline as the budget month, for this account only, next to a "To do" list: record a scheduled transaction that is overdue ("Record", which opens the side sheet filled in), mark a pending transaction as cleared ("Mark"). The timeline and the list fold away while the side sheet is open, to leave the register room; filters by state with counts; search; transactions newest first with a running balance, splits shown under their row; a round control on each row switches pending and cleared, reconciled rows show a padlock. A toolbar button, always there, opens reconciliation ("Reconcile") — a manual action for when the balance looks wrong, not something the register keeps suggesting: the running balance it already shows is the truth until the person themselves notices otherwise. A row opens in the side sheet: outflow, inflow or transfer; the payee proposes the category used last time; the category's available amount before and after; splitting across categories with the amount still to split; transfers to a credit card are card payments, transfers to an off-budget account ask for a category. A transfer goes either way ("To another account" or "From another account"); switching direction keeps the account already chosen. "From another account" does not list credit cards (money coming from a card, a cash advance, is not covered yet). One coming in from any off-budget account (a brokerage account or a loan) to a cash account offers "Unassigned" first, selected by default, then the categories, and its hint says how much "Unassigned" (or the chosen category) goes from and to; its register row reads "Transfer · From <account> · Unassigned" (or the category), and one going out to an off-budget account reads "Transfer · To <account> · <category>"; other transfers read "Transfer". Editing such a row can change its category, or set it back to "Unassigned" where that is offered. Coming in from an off-budget account to a credit card, "Unassigned" is not offered and a category is required, as for an outgoing transfer (the mockup has no card register to draw it in). The import's check step follows the same rule for a row marked as a transfer with an off-budget account: "Unassigned" first and selected by default for money coming in to a cash account, a category required otherwise. Phone: accounts list, register grouped by day with the first two things to do under the balance (no timeline), full-screen transaction form, and quick entry (amount keypad, place, category with its available amount, account).
- **Import and reconciliation.** Import in four steps (file, columns, check, done) and reconciliation with the statement balance, the difference, clues and locking, as described in "Import and reconciliation".
- **Settings.** Two separate places. *Your account*, from the user menu, holds what belongs to the person and applies in every workspace: profile, language, number and date format, personal time zone, theme, notifications and devices, sign-in and security. *Workspace settings*, from the workspace switcher, hold what every member shares: name, currency and the workspace time zone, members and roles, categories and groups, accounts, data export and deletion. Changing workspace settings needs the owner role, except categories, which editors can manage.
- **Choosing a workspace after signing in.** The one already named in the URL, otherwise the last workspace this browser used — if the signed-in user still belongs to it — otherwise the only workspace when there is exactly one, otherwise a picker to choose from (shown only the first time, or whenever none of the earlier rules apply any more), or, belonging to none at all, an offer to create one on the spot (name, currency, time zone — the currency fixed from then on). The workspace switcher updates which one is remembered whenever it changes it; picking one from the picker remembers it the same way. The preference lives in the browser, keyed to the signed-in person, so a different person signing into the same browser never inherits someone else's. The switcher itself also offers "+ New workspace", the same form, and, owner only, "Delete workspace" — type the workspace's own name to confirm, then every piece of its data is gone for every member. Both reach directly for a plain form or confirm dialog today, ahead of the fuller workspace-settings shell *Settings* above describes.
- **First run.** Five steps: a short introduction to how the budget works, the workspace, the first account with today's balance (cash accounts only; credit cards are added later), the starting categories, and the unassigned amount.
- **Portfolio.** Overview (value, contributions, gain, 12-month return, out-of-threshold notice, value against contributions over time, month-by-month table, allocation bars, positions), allocation editor (targets per level adding up to 100%, threshold rule, rebalancing presets), rebalancing (mode, contribution, minimum trade, whole or fractional units, "To get back to your targets:"), trade entry, and linked accounts showing how each brokerage account is split across its portfolios. A new portfolio is created with a short guided setup: name and purpose, accounts, how many units of each account's existing positions to move into it from another portfolio (a transfer without cash — it can also start empty), a starting allocation. Phone: value chart, allocation bars and the monthly check.

### Screens still to design

Each gets a mockup in `docs/ux/mockups/` before the milestone that builds it starts: invitations (joining an existing workspace, not needed by 0.1.7 — see `docs/ux/README.md`); for later milestones, reports, prices and manual prices, ETF look-through, well-known allocations and the CAPE-based target.

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
| API documentation | Generated from the OpenAPI contract; until that exists, written by hand: the [portfolio API reference](portfolio-api.md) for the portfolio endpoints, and `apps/api/README.md` for the rest |
| Code comments | Explain why, not what; every core function has a description and an example |
| Changelog | What changed in each release |

Rule: no code change is accepted without updating the related documentation; the checklist of every change verifies it. Package READMEs include a "Things to understand" section that explains new concepts through comparisons with older web stacks (see [packages/core](../packages/core/README.md)).

## Roadmap

Work starts from the domain core and the web app for a single workspace, already on a multi-user architecture. Mobile comes once the core is stable, since it reuses the same logic. There are no deadlines: phases only have an order.

| Phase | Contents | Move on when |
| --- | --- | --- |
| 0. Foundations | Monorepo, CI, database, Keycloak, workspaces, domain core with tests | Sign-up, sign-in with 2FA, green CI |
| 1. Budget MVP (web) | Accounts, categories, assignment, transactions, credit cards, targets, moving money between categories, days of buffer, CSV/OFX/QIF/CAMT.053 import, reconciliation, i18n library with English and Italian | A real month of a household budget can be run with the app alone |
| 2. Portfolio MVP (web) | Instruments, trades, positions, historical prices, monthly performance, target allocation, thresholds, rebalancing; private instruments scoped to one workspace (no ISIN and no ticker) follow the shared catalog in milestone 0.2.1 (#505); local, read-only assistant access over MCP in milestone 0.2.8 (see "Assistant access (MCP)") | The dashboard reproduces the results of an existing spreadsheet-based tracker |
| 3. Mobile and offline | Expo app, local database, sync, quick entry, notifications | One week of use on two devices without loss or duplicates |
| 4. Public open-source beta | Docker, documentation; rate limiting and an internet-ready Keycloak (upgrade, production mode, brute-force protection, multi-factor authentication) in milestone 0.4.0; remote assistant access in 0.4.1 and assistant drafts in 0.4.2 (see "Assistant access (MCP)") | A self-hosted install works in under 10 minutes |
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
| Interface | A mariner band over pale blue (graphite in the dark theme); categories as bars, the month as a timeline, a "To do" list; colour marks problems; Bricolage Grotesque and Figtree, self-hosted; the budget month mockup in `docs/ux/mockups/` is the reference (see "User interface") |
| Monthly assignments | An append-only ledger of debit/credit entries, never a mutable per-category total, so concurrent offline edits never conflict ([ADR 0008](adr/0008-assignment-ledger.md)) |
| Credit card debt | Uncovered debt is derived (card balance minus the payment category's available), never persisted; the payment category behaves like every other category otherwise (see "Credit cards") |
| Scheduled transactions | Reserve money ahead of being recorded; reservations never carry over to the next month (see "Scheduled transactions") |
| Import | Staged until every row is categorized, a transfer or income; unconfirmed staging expires after 7 days (see "Import and reconciliation") |
| Foreign-currency budget accounts | After 1.0.0 (see "After 1.0.0") |
| Assistant access | An MCP server that reaches data only through the API, off by default per workspace; local and read-only first, remote later behind a hardened Keycloak, writes only as drafts a member confirms ([ADR 0014](adr/0014-assistant-access-through-mcp.md)) |
