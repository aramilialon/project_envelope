# Domain guide

The rules of envelope budgeting and portfolio rebalancing, with numeric examples. This is not a
tour of the interface (see the [mockups](ux/mockups/) and [UX and visual design](ux/README.md) for
that) or a list of features and phases (see the [design document](design.md)) — it explains *why*
the numbers come out the way they do, the same way a new contributor would need explained before
touching `packages/core`.

## Envelope budgeting

### The core idea

Every euro that arrives in an on-budget account is *unassigned* until the user puts it into a
category. Only money that has actually arrived can be assigned — never income still expected — so
the household always spends what it has, not what it hopes for. The one exception to "assign
first, then spend" is also enforced: assigning more than is unassigned is allowed (overspending the
budget itself is sometimes unavoidable — rent is due before the paycheck clears), but it is shown
as a warning, never silently.

### A category's own month

Four numbers describe a category in a given month:

- **Carried over** — the positive available balance brought forward from last month. A negative
  balance never carries over (see "Overspending" below).
- **Assigned** — what the user put into it this month.
- **Activity** — spending (negative) and refunds (positive) recorded against it this month.
- **Available** = carried over + assigned + activity.

**Example.** Groceries carries over €40 from August. In September the user assigns €400 and
records €380 of spending. Available = 40 + 400 − 380 = **€60**, which becomes October's carried
over.

### Overspending: cash and credit are not the same problem

A category goes negative when its activity outruns what it was given. What happens to that
negative amount at the end of the month depends on *how* it was spent:

- **Cash or debit overspending** restarts the category at zero next month, and the amount is taken
  out of next month's unassigned money — the household already spent cash it did not have, so it
  owes it to itself, the same as an overdraft.
- **Credit overspending** becomes debt on the card instead. It never touches unassigned money,
  because nothing has actually left an on-budget cash account yet — the bill has not been paid.

The split is not about which purchase happened first: of the total overspent amount, as much as
possible is attributed to credit — up to the total actually spent through a card this month — and
only what is left over becomes cash overspending.

**Example.** Restaurants is given €150 this month and €300 is spent, €80 of it through a credit
card and €220 through debit. Overspent = 300 − 150 = €150. Credit overspending = min(150, 80) =
**€80** (every euro of card spending counts against it first); cash overspending = 150 − 80 = **€70**
(the rest, since the overspend is bigger than the card spending alone could explain). Give the same
category €80 more (€230 total) instead and overspent drops to €70 — still bigger than nothing, but
now credit overspending = min(70, 80) = **€70** and cash overspending = 70 − 70 = **€0**: the whole
overspend fits inside what was actually spent on the card, so none of it is blamed on the debit
spending at all.

### Credit cards and their payment category

An on-budget credit card automatically gets its own category — the *payment category* — that holds
the money set aside to pay it. Every category in the budget pays into it once its own credit
overspending is covered the following month (design.md, "Credit cards"); the card's **uncovered
debt** is derived, never stored:

```
uncovered = max(0, owed − max(0, paymentCategory.available))
```

**Example.** A card is owed €800. Its payment category holds €500 (money already set aside).
Uncovered = max(0, 800 − 500) = **€300** — the part of the bill nothing is set aside for yet.
Assigning €300 more to the payment category brings `uncovered` straight to zero; nothing else is
recomputed or stored, because `uncovered` is not a number the budget keeps, it is a number the
budget works out fresh every time.

**A card's starting balance.** Adding a card that already carries debt creates one transaction,
categorized straight to the card's own payment category — not to an ordinary spending category, and
not counted as this month's activity. Treating it as ordinary spending would break two things at
once: its "covered" part would move money from the payment category into itself (going nowhere),
and the category would restart at zero at the end of the month, making the debt disappear instead
of staying visible as `uncovered`.

**Paying down one card from another.** A transfer from card A's payment category to card B's moves
only what A's own payment category actually holds. Whatever is left over stays as A's own uncovered
debt — it does not quietly move to B, the same rule ordinary card overspending already follows.

### Scheduled transactions reserve money ahead of time

A scheduled transaction (rent, a subscription, a salary) reserves money in its category before it
is recorded, so the budget does not look falsely healthy the week before a known bill. `available`
is net of what is reserved; recording the real transaction turns the reservation into ordinary
activity, so nothing moves at that moment.

**Example.** Insurance has €80 available and a €240 premium scheduled for next week. Reserved =
€240, so the category reads €80 available with €240 reserved — not enough to cover it, a warning
("missing €160"), never overspending, since nothing has happened yet. An overdue scheduled item
(past its own date, still not recorded) stays reserved and marked "to record" rather than quietly
disappearing or turning into activity on its own.

### Targets: four ways to ask for money ahead of time

| Kind | Asks this month | Example |
| --- | --- | --- |
| Monthly amount | the amount itself | €200 for Groceries asks €200 every month |
| Amount by a date | (total − carried) ÷ months left (current month and the due month both count) | see below |
| Repeating expense | the same as "amount by a date", until it is due — then the due month moves forward by the interval | a €600 car tax due every June asks like a date target until June, then rolls to next June |
| Balance to keep | target − available, at least zero | "always keep €500 in Car repairs" |

**Example (amount by a date).** €3,600 for a holiday, due June 2027, with €1,250 already carried
into September 2026. Months left (September through June) = 10. Asks = (3,600 − 1,250) ÷ 10 =
**€235** a month. With €200 assigned in September, €35 is still missing. "Fund the targets" assigns
every category's own missing amount from unassigned money, in table order, until unassigned money
runs out — never more than it holds.

Payment categories never have targets of their own: a card's debt is covered by the categories that
caused it, not by a savings goal on the payment category itself.

### Days of buffer

The amount-weighted average number of days between a euro arriving and being spent, first in first
out, over the last 30 days of outflows, across every on-budget account (transfers between on-budget
accounts do not count — no money actually left the budget). A household living paycheck to paycheck
reads close to zero; one with a cushion reads higher, and watches the number instead of a single
balance that says nothing about *when* that money is needed.

### Import, duplicates and reconciliation

A bank statement row is a duplicate of a transaction already in the account when the bank's own
transaction id matches, or — for formats with no id — when the amount matches and the dates are
within three days of each other; each existing transaction can only absorb one row this way. A new
row is held in a staging area until it has a category, or is recognized as income or a transfer —
`packages/core` has no "uncategorized" state for a real transaction, so there is nothing to import
it as until one of those is true.

Reconciliation compares what the budget already believes (the last reconciled balance, plus every
cleared transaction up to the statement's date that the user still has ticked) against the
statement's own closing balance. A non-zero difference is not immediately someone's mistake — it is
usually one specific transaction still pending or unticked that happens to equal it exactly, so the
app looks for that one first before asking the user to add an adjustment by hand.

### The invariant

Across every feature above, one equation must always hold:

```
unassigned money + every category's available + reserved + assigned to future months
  + this month's credit overspending
  = money actually sitting in the on-budget cash accounts (cards excluded)
```

Every code path that moves money — assigning, spending, a transfer, a scheduled transaction firing,
a card payment — has to keep this equation true, or the budget and the real accounts have quietly
drifted apart. `packages/core`'s own tests check it on hundreds of randomly generated histories,
not just a handful of examples, precisely because a rule this central is the one place a single
missed case would be worst to find in production.

## Portfolios and rebalancing

Being built (phase 0.2.x of the [roadmap](design.md#roadmap)). Quantities, prices and positions
are already computed in `packages/core`, though nothing records trades yet; the rest are the rules
the engine will follow once it exists, not a description of something already running.

### Positions and returns

The user records trades (buy, sell, dividend, coupon, fees, taxes, a split, a transfer of
securities); the app derives positions, current value and gains from them and from stored
historical prices, rather than asking the user to maintain a balance by hand. Two different
"return" numbers answer two different questions:

- **TWR** (time-weighted return) measures how good the *strategy* was, independent of when money
  was added or removed — the number to compare against an index.
- **MWR/XIRR** (money-weighted return) measures the *household's own result*, given exactly when
  their contributions happened — the number that answers "did my timing help or hurt me."

#### Quantities, prices and rounding

Quantities have up to 8 decimals and prices up to 6, kept as exact integers rather than fractional
numbers ([ADR 0011](adr/0011-quantities-and-prices-as-scaled-integers.md)). The amount of a trade
is quantity × price × price factor; the price factor is 1 for most instruments and 0.01 when the
price is quoted in percent or in hundredths of the currency. Each conversion rounds by one rule:

- **A savings plan buys what the money allows, never more.** €100 at €87.123456 buys
  1.14779652 units (100 ÷ 87.123456 = 1.147796525…, rounded toward zero). If the broker only
  sells thousandths of a unit, it is 1.147; with whole units only, 1.
- **A bond's quantity is its nominal.** 10,000 nominal at 98.765432 (percent) is
  10,000 × 98.765432 × 0.01 = €9,876.5432, so €9,876.54. Working back, €9,876.54 for 10,000
  nominal is an average price of 98.7654 (rounded half to even at 6 decimals, for display).
- **A share quoted in pence.** 100 shares at 1,234.5p are 100 × 1,234.5 × 0.01 = £1,234.50.
- **Selling part of a position removes its cost proportionally.** €1,000 of cost on 3 units, sold
  one unit at a time: the first sale removes a third of €1,000 = €333.33; the second, half of the
  €666.67 left = €333.335, so €333.34 (half away from zero); the last sale removes everything that
  is left, €333.33. Together they make exactly €1,000.
- **The order of sales matters, so it is fixed.** A cost of €1.01 on 4 units: selling 1 unit and
  then another removes €0.25 + €0.25 = €0.50, while selling 2 units at once removes €0.505, so
  €0.51. Positions are rebuilt by replaying the trades always in the same order, so the same
  trades always give the same cost.

#### Positions and cost basis

A position is never typed in or stored: `packages/core` rebuilds it by replaying the trades in a
fixed order. Its cost `C` is the total paid, in whole cents, and its quantity `Q` the units held;
the average cost is `C ÷ Q`, computed only to be shown.

**The order of the replay.** Trades are replayed by their trade date — the date on the broker's
statement, the same day the user enters — with a split first on its date, then by the time the
trade occurred, by when it was recorded, and by id. A split is recorded on its ex-date (the day
it takes effect), so a sale of the new units on that same day comes after it. Times are compared
to the millisecond. Every trade of an instrument in the workspace is replayed together, because
units moved between two accounts take their cost with them.

**The average cost belongs to the account.** Every portfolio holding the instrument in the same
account shares one average cost: portfolios split the account's *quantity*, not its cost. Moving
units between two portfolios of the same account moves quantity only and never changes the
average. A portfolio's share of the cost is `C × its quantity ÷ Q`, rounded so that the shares
add up to `C` exactly (the leftover cents go to the largest remainders). A sale realizes its gain
at the account's average cost, and the gain belongs to the portfolio the sale is filed under.

Because the average is shared, a portfolio's own realized and unrealized gains move with the other
portfolios' trades: when B buys at a higher price than A paid, the account's average rises and A's
unrealized gain falls, although A did no trade. The account's total is not affected. Each
portfolio's own performance will come from its own cash flows instead (money-weighted, milestone
0.2.1).

The cost follows the Italian rules (art. 68 TUIR):

| Trade | Cost `C` | Gain |
| --- | --- | --- |
| Buy | `+ gross + fees`; the financial transaction tax and accrued interest are not part of it | — |
| Sell | `− C × sold ÷ Q` (the cost removed) | gross − fees − cost removed; gain tax, transaction tax and withholdings are not part of it |
| Transfer to another account of the workspace | the source loses `C × moved ÷ Q`; the destination gains exactly that | — |
| Transfer in from outside the app | `+` the cost the units bring, entered with them | — |
| Transfer out of the app | `− C × moved ÷ Q` | — |
| Transfer between portfolios of the same account | unchanged | — |
| Split | unchanged; each portfolio's quantity × the ratio, rounded down to 8 decimals | — |
| Dividend, coupon, fee, tax | unchanged | — |

The cost of units moved between two accounts is always worked out from the source account at the
moment they leave, so a trade later backdated in the source account changes the destination's
cost too. A transfer's own fees are never part of the cost.

A split ratio is written from:to: 1:4 means 1 unit becomes 4, and a reverse split 10:1 means 10
units become 1. Every split row of one account on one date must have the same ratio, and each
portfolio has at most one. If a split rounds one portfolio's quantity down to zero, its share of
the cost moves to the other portfolios of the account; the account's cost does not change.

**What the totals mean.** Next to the cost and quantity, each position keeps its own totals, so
they can be shown as their own lines:

- **Income** = dividends and coupons (gross) − foreign and domestic withholding − income fees +
  accrued interest received − accrued interest paid. Income fees are the fees of dividends and
  coupons. A bond buy's domestic withholding, credited back with the accrued interest paid,
  counts as negative withholding.
- **Costs** = financial transaction tax + standalone fees + standalone taxes (stamp duty and the
  like).
- **Taxes on gains** = gain tax withheld on sales ± gain tax adjustments. An adjustment's amount
  is positive when it is a refund (money back into the account), which lowers the total, and
  negative when it is extra tax charged, which raises it.
- **Net result** = realized + unrealized + income − costs − taxes on gains.

The fees of buys and sells (trade fees) are already inside the cost and the gain, so they are
shown for information and never subtracted again; the fees of transfers are a total of their own.
The realized gain is economic, not taxable: what the tax rules count as taxable can differ.

Worked examples, each one a test in `packages/core`:

- **Two portfolios, one average.** Portfolio A buys 10 units at €100 with a €5 fee; portfolio B,
  in the same account, buys 30 at €120 with a €5 fee. The account holds 40 units for €4,610.00:
  an average of €115.25 for both. A sells 5 at €130 with a €5 fee: the cost removed is
  4,610 × 5 ÷ 40 = €576.25, the gain is 650 − 5 − 576.25 = €68.75, and it goes to A. The account
  is left with 35 units for €4,033.75, of which A's share is €576.25 (5 units) and B's €3,457.50
  (30 units).
- **A split 1:4.** The same 35 units become 140 (A 20, B 120); the cost stays €4,033.75, so the
  average becomes €28.8125. Nothing is realized.
- **A reverse split 10:1 and cash in lieu.** The same 35 units become 3.5 (A 0.5, B 3), still
  for €4,033.75. Selling A's 0.5 for €650 (€1,300 per unit, no fee) removes
  4,033.75 × 0.5 ÷ 3.5 = €576.25 of cost and realizes €73.75.
- **A split on its ex-date.** Holding 10 units, a 1:2 split and a sale of 20 units on the split's
  ex-date are accepted: the split comes first, whatever the time recorded on each.
- **No negative holdings.** If A, holding 5 units, tries to sell 10, the sale is refused
  (`insufficient_quantity`), even though the account as a whole holds 35. A trade backdated so that
  a later sale would sell more than its portfolio held at that point is refused the same way, at
  that later sale's date.
- **The cost of a sale is exact.** 300,000 units bought for €100,000.00: selling 100,000 removes
  exactly €33,333.33 and leaves €66,666.67, never a cost worked out from a rounded average.
- **Selling everything starts again from zero.** After selling every unit, the cost is exactly
  zero; buying 10 at €90 with a €5 fee gives an average of €90.50.
- **A transfer in is averaged in.** An account holds 10 units bought at €120 (€1,200). Ten more
  arrive from outside the app carrying a cost of €1,000: 20 units for €2,200, an average of €110,
  and no gain or loss.
- **A transfer between accounts follows the source.** An account holds 10 units bought at €100
  and moves 5 to another account: they carry €500. If a buy of 10 more at €130 is later recorded
  in the source before that date, the source held 20 for €2,300 when the 5 left, and they carry
  €575. A €25 fee on the transfer is shown on its own line and is part of neither cost.
- **The financial transaction tax stays out of the cost.** 100 shares at €50, a €5 fee and €5 of
  transaction tax cost €5,005.00; the tax is shown on its own line. Buying 50 more at €62 with a
  €5 fee brings the cost to €8,110.00 for 150 shares. Selling 60 at €70 with a €5 fee removes
  8,110 × 60 ÷ 150 = €3,244.00 of cost and realizes 4,200 − 5 − 3,244 = €951.00; the €247.26 of
  gain tax the broker withholds (26%) is recorded as its own total, not subtracted from the gain.
  A later €100 gain tax adjustment refunded by the broker brings the taxes on gains to €147.26.
- **A dividend's net income.** A €20.00 dividend with €3.00 of foreign withholding, €4.42 of
  domestic withholding and a €2.00 fee is €10.58 of income; the €5 fee paid when the units were
  bought is not subtracted again.
- **A split covers every holding.** A corporate split affects every unit of the instrument, so it
  is recorded once per portfolio holding it, in every account of the workspace. If two accounts
  hold the instrument and the split is recorded in only one, it is refused
  (`split_missing_for_portfolio`); so is a trade that would make another portfolio hold the
  instrument on that date without its own split row. An account that no longer holds the
  instrument on that date needs no row.

Not handled yet: return of capital, amortizing bonds, bonds issued at a discount, spin-offs,
mergers and rights issues, dividends paid in shares, and the fiscal view in euros for instruments
in other currencies.

### Target allocation and thresholds

A target allocation is a tree of percentages that must add up to 100% at each level — for example
Stocks 60% (itself split World 50% / Emerging markets 10%), Bonds 30%, Gold 10%. An instrument can
be split across items by percentage (a 60/40 balanced fund counts 60% toward stocks, 40% toward
bonds); cash can be its own item, targeted as a percentage or as a fixed amount, with the rest of
the net worth splitting across everything else.

Each item gets its own **threshold** — how far it may drift from its target before the engine
considers it out of range — in one of three forms:

- **Absolute**: a fixed number of percentage points either way (±5 points).
- **Relative**: a percentage of the target itself (±20% of the target — ±12 points on a 60% target).
- **5/25 rule**: whichever of the two above is tighter.

### Rebalancing modes

Once an item is out of range, three different modes answer "what trade fixes it" very differently:

- **Contributions only.** Never sell — new money alone is steered toward whatever is furthest below
  its target, in proportion to how far below it each underweight item is.
- **Full.** Buy *and* sell back to the exact target, whatever it takes.
- **To the threshold edge.** The smallest trade that brings the item back to the edge of its own
  band, not all the way to the target — fewer, smaller trades than "full" mode.

For item *i*, with its own current value *Vᵢ*, the portfolio's total value *V*, its target *tᵢ* and
a new contribution *C*:

```
wᵢ = Vᵢ / V            (current weight)
dᵢ = wᵢ − tᵢ           (drift from target)
Δᵢ = tᵢ·(V + C) − Vᵢ   (amount to buy, or sell if negative, in "full" mode)
```

**Example.** A €100,000 portfolio, targets Stocks 60% / Bonds 30% / Gold 10%, an absolute ±5-point
threshold, full rebalancing:

| Item | Target | Current | Drift | Status | Trade |
| --- | --- | --- | --- | --- | --- |
| Stocks | 60% | 67% | +7 pt | above threshold | sell €7,000 |
| Bonds | 30% | 25% | −5 pt | at the limit | buy €5,000 |
| Gold | 10% | 8% | −2 pt | within threshold | nothing required, but buy €2,000 keeps it exactly on target |

Stocks is 7 points over its own 5-point band, so it trades; Gold is only 2 points off and stays
inside its own band, so a minimal-trade mode would leave it alone entirely — "full" mode still
brings it exactly to target because it rebalances everything, not just what is out of range.

### A dynamic stock target based on CAPE (optional)

Instead of one fixed stock target, the user can set it to vary with the CAPE ratio — the more
expensive the market looks by that measure, the lower the stock target — between a minimum and
maximum weight the user chooses:

```
t_stocks = S_max − (CAPE − CAPE_min) / (CAPE_max − CAPE_min) · (S_max − S_min)
```

**Example.** CAPE limits 10–40, stock limits 50%–100%, today's CAPE is 30: t = 100 − (30−10)/(40−10)
· (100−50) = 100 − 0.667·50 = **66.7%**. Every other top-level item shares the remaining 33.3% in
proportion to its own target, and every CAPE value entered is kept, so the target's own history
over time is never lost. The CAPE number itself is typed in by the user each month, with a reminder
and a link to whichever source they picked — the app does not fetch it automatically.

### What the engine will not do

The same "no advice" rule that keeps the budget from judging a purchase applies here too, more
strongly, since money and regulation are both involved:

- It never suggests *which* instruments to buy — only asset-class items the user has already
  placed in the allocation.
- The built-in "well-known allocations" are asset classes with neutral, alphabetically ordered
  names and cited sources, never a ranking or a "best for you" — and the app never asks about age,
  income or risk tolerance to pick one.
- It never places an order. The result is always a list of trades with wording such as "To get back
  to your targets:", never "We recommend".
