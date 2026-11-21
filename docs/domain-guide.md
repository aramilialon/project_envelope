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

**A month's unassigned money counts only money received by then.** Looking at any month M, the
app follows the money month by month from M on: for each month N, the income received by the end
of N (and by today), less everything assigned to months up to N, less the cash overspending taken
from the months before M. M's unassigned money is the smallest of these figures. So:

- a month never shows income dated after it: browsing back to August does not show September's
  salary;
- money assigned ahead to a later month comes out of the month it was taken from;
- but a later month's assignment paid for by that later month's own income is not blamed on M;
- income dated after today counts nowhere until its date: it is expected income, not money
  received. Spending dated after today does count against its category straight away, which errs
  on the safe side. This holds for outflows only: money coming in with a category and dated after
  today (a refund, a categorized transfer from the broker) counts in its category at once for now
  (#668).

"From this month's money, assigned to later months" is later months' assignments that their own
income does not pay for, charged to M; when it exceeds what M has, M's unassigned money is negative
(example 3: €1,100 while September received €1,000).

**Examples.** Today is 21 November 2026.

1. Nothing in August, a €3,000 salary on 25 September: August shows **€0** unassigned, September
   **€3,000**. A second €3,000 salary on 25 October leaves August and September as they were;
   October shows €6,000.
2. €1,000 received in September, €900 of it assigned to October's rent: September shows **€100**
   unassigned and €900 assigned to later months; October shows €100.
3. The same, but €1,100 assigned to October and no October income: September shows **−€100** (a
   warning: more assigned than received), with €1,100 assigned to later months.
4. €100 received in September; a €16,802 loan paid out on 5 October and assigned in October to the
   loan's own category: September shows **€100**, not −€16,702, because October's own income pays
   for October's assignment.
5. €2,000 received on 10 November, €500 expected on 27 November, €300 assigned to Groceries and
   €50 of groceries already entered for the 25th: November shows **€1,700** unassigned and
   Groceries €250 available. The €500 counts from the 27th on, in November and every later month,
   not before.

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

**Paying the card beyond what was set aside.** Paying the card more than its payment category
holds takes the difference from cash that had no job: the payment category's available goes
negative, and that negative part is cash overspending, taken from next month's unassigned money like
any other. It covers none of the debt, so `uncovered` ignores it, and the card's real debt is what
is owed on it (`owed`), never `available + uncovered`. What it takes to bring the payment category
back to covering the whole debt is

```
to cover = cash overspending + uncovered = max(0, max(0, owed) − available)
```

A card in credit (negative `owed`) counts as owing nothing in it. The row's status line, the
detail's "To cover", the card's "To do" item, its "Assign" button and quick assign's "Cover card
debt" all use this one figure.

**Example.** A card is added owing €500 (its starting balance). €45.67 of groceries go on the card,
covered by the Groceries category's own money, so €45.67 moves into the payment category. €300 is
then paid to the card from checking, with nothing assigned to the payment category.

- owed = 500 + 45.67 − 300 = **€245.67**; available = 45.67 − 300 = **−€254.33**.
- The debt shown is €245.67; "Set aside" is €0.00, never negative; a neutral line says "Paid beyond
  what was set aside: €254.33".
- Uncovered = max(0, 245.67 − max(0, −254.33)) = €245.67.
- To cover = max(0, max(0, 245.67) − (−254.33)) = **€500.00**: the €254.33 of cash overspending
  plus the €245.67 still uncovered. The row reads "€500.00 to cover: €245.67 of debt and €254.33
  paid beyond what was set aside"; the month's one "To do" item for the card, its "Assign" button
  and quick assign's "Cover the cards' debt" all ask for €500.00, and assigning it brings both the cash
  overspending and the uncovered debt to zero.

Reading the debt as `available + uncovered` would give −€8.66 here, which is why the budget returns
`owed` itself.

**Two edge cases.**

- *A card in credit.* The card owes −€10 (it was paid €10 more than its whole balance) and its
  payment category's available is −€50. The debt counts as 0, so uncovered = 0, the cash
  overspending is €50, and to cover = max(0, max(0, −10) − (−50)) = **€50**.
- *A card paid exactly its debt from cash.* A card is added owing €300 and €300 is paid to it from
  checking, with nothing assigned. Debt = owed = **€0**, paid beyond what was set aside = **€300**
  (available is −€300), uncovered = 0, and to cover = max(0, 0 − (−300)) = **€300**: the row reads
  "€300.00 to cover: paid beyond what was set aside".

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

### Money moved to an off-budget account

A transfer between two on-budget accounts moves money without spending it: the budget does not
change. A transfer between an on-budget account and an off-budget one (a brokerage account, a
savings account kept out of the budget, a mortgage, a loan) is different, because the money leaves
the budget or enters it. Only the on-budget leg counts, and how it counts depends on where the
money goes; the off-budget leg never has a category.

- **Out to an off-budget account:** it always needs a real category, like any spending
  ("Investments" for the monthly payment to the broker). A transfer without one, or with
  "Unassigned", is refused (`uncategorized_transaction`), and so is an edit that takes the category
  away (#378, #552).
- **In from an off-budget account into a cash account:** by default it is **income to assign**
  ("Unassigned"), in the month of its date, like a salary. A real category can be chosen instead,
  for example to refill the envelope that funded the investment: it then goes into that category's
  available, the same way a refund does (#598).
- **In from an off-budget account into an on-budget credit card:** it needs a real category, and is
  then read as a refund on the card. Without one it is refused (`card_income_not_supported`):
  income on a card is not modeled yet.

Transfers between two on-budget accounts, or between two off-budget accounts, never carry a
category.

This is how an investment is planned: the household gives the monthly amount to an "Investments"
category, and the transfer to the broker spends it.

**Example.** €40,000.00 of income arrives; €30,000.00 is assigned to "Investments" and €500.00 to
"Groceries"; €123.45 is spent on groceries. The €30,000.00 transfer from the checking account to
the brokerage account is spending from "Investments": its available goes from €30,000.00 to 0, and
unassigned money stays at 40,000.00 − 30,000.00 − 500.00 = €9,500.00, and "Groceries" has
500.00 − 123.45 = €376.55 available. The checking account holds 40,000.00 − 123.45 − 30,000.00 =
€9,876.55 = 9,500.00 (unassigned) + 0 ("Investments") + 376.55 ("Groceries"), the invariant
below. Every buy, sale and fee on the brokerage account afterwards moves cash within that account
only, and leaves the budget exactly as it was.

**Examples of money coming back.** September 2026: checking holds €3,000, of which €200 is
unassigned, €1,800 is in "Groceries" and €1,000 in "Rent"; "Investments" holds nothing.

1. Selling ETFs and moving €5,000 from the broker to checking, with no category: Unassigned becomes
   **€5,200** and checking €8,000. The invariant holds: 5,200 + 1,800 + 1,000 = 8,000.
2. The same transfer in "Investments" instead: "Investments" holds **€5,000**, Unassigned stays
   €200.
3. €5,000 sent to the broker in June through "Investments", and coming back in September as
   Unassigned: September's unassigned money grows by €5,000 (and every later month's with it);
   June, July and August, and the spending of "Investments" in June, do not change: income never
   shows in a month before its date.
4. Starting from example 1, after assigning €4,000 to "Holiday" (Unassigned €1,200), the transfer's
   checking leg is edited to "Investments": Unassigned becomes **−€3,800** (more assigned than
   there is, shown as a warning) and "Investments" €5,000; the total is still €8,000, and the
   broker's leg does not change.
5. Refused: checking → broker with no category; broker → Visa with no category; the checking leg of
   a transfer to the broker edited to no category.

### Each account in its own currency

Every account keeps its own currency, and amounts in different currencies are never added together
until exchange rates exist (#86, #652):

- **On-budget accounts, cards included, are in the workspace's base currency.** The budget is one
  pot of money in one currency; an on-budget account in another one is refused
  (`account_currency_not_base`). An off-budget account (a broker in dollars, a savings account in
  francs) can be in any currency.
- **A transfer moves money between two accounts in the same currency.** One amount cannot mean
  €1,000 on one side and $1,000 on the other, so a transfer between accounts in different
  currencies is refused (`currency_mismatch`). Such a move is entered as an outflow from one account
  and an inflow into the other, each in its own currency.
- **Every balance is shown in its account's own currency.**
- **The net worth adds up base-currency accounts only.** What accounts in other currencies hold is
  listed beside it, each in its own currency ("Not included: $3,000.00 (no exchange rates yet)").
  Balances in one currency are netted: a −$100 card and a $3,000 broker show as $2,900, and a
  lone −$5,000 loan as −$5,000. Securities are not in the net worth either until prices exist
  (#125): only the cash in the brokerage account counts. Sending €10,000 to a broker in euros
  leaves the net worth unchanged (the money only moves between two accounts in the net worth);
  spending it on an ETF lowers the net worth by what the purchase cost, fees included. A line says
  so whenever the workspace holds securities.

**Example.** Base currency EUR: checking €5,000, an on-budget card −€500, a broker in euros holding
€2,000 of cash and some ETFs, a broker in dollars holding $3,000 of cash. Net worth:
5,000 − 500 + 2,000 = **€6,500**, with "Not included: $3,000.00 (no exchange rates yet)" and "Net
worth does not include securities (no prices yet)".

**Example, continued.** €1,000 moves from checking to the dollar broker, which receives $1,080. It
cannot be a transfer: checking records an outflow of €1,000 with a category (which one is the
household's choice), and the broker an inflow of $1,080. Checking now holds €4,000 and the broker
$4,080, so the net worth drops to 4,000 − 500 + 2,000 = **€5,500**, and the note becomes "Not
included: $4,080.00 (no exchange rates yet)". The euros reappear in the net worth, as dollars
converted at a rate, only once exchange rates exist (#86).

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
  = money in the on-budget cash accounts (cards excluded) at the end of the month,
    less the income dated after today (not received yet)
```

that is, income received by the earlier of the end of the month and today, plus the activity up to
the end of the month. It holds in every month, not only the current one.

Every code path that moves money — assigning, spending, a transfer, a scheduled transaction firing,
a card payment — has to keep this equation true, or the budget and the real accounts have quietly
drifted apart. `packages/core`'s own tests check it on hundreds of randomly generated histories,
not just a handful of examples, precisely because a rule this central is the one place a single
missed case would be worst to find in production.

## Portfolios and rebalancing

Being built (phase 0.2.x of the [roadmap](design.md#roadmap)). Quantities, prices and positions
are already computed in `packages/core`; the API records, edits and deletes trades (#77, #509),
keeps each brokerage account's tax regime (#508) and returns positions, without prices yet (#79).
How to do all of that through the API is in the [portfolio API reference](portfolio-api.md). The
rest of this part (prices, returns, allocation, rebalancing) is the rules the engine will follow
once it exists, not a description of something already running.

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
units become 1. Every split row of one instrument on one date must have the same ratio, in every
account (`split_ratio_mismatch`), and each portfolio has at most one. If a split rounds one portfolio's quantity down to zero, its share of
the cost moves to the other portfolios of the account; the account's cost does not change.

**What the totals mean.** Next to the cost and quantity, each position keeps its own totals, so
they can be shown as their own lines. Every total is in the account's currency, and the net
result below is only ever added up within one currency.

- **Income** = dividends and coupons (gross) − foreign and domestic withholding − income fees +
  accrued interest received − accrued interest paid. Income fees are the fees of dividends and
  coupons. The domestic withholding is entered as a positive amount and the trade's type gives its
  direction: withheld on a sale, a dividend or a coupon; credited back on a bond buy with accrued
  interest, where it counts as negative withholding.
- **Costs** = financial transaction tax + transfer fees + standalone fees + stamp duty and other
  taxes.
- **Taxes on gains** = gain tax withheld on sales − gain tax adjustments + managed result tax.
  An adjustment's amount is kept as entered: positive when it is a refund (money back into the
  account), which lowers the total, and negative when it is extra tax charged, which raises it.
  The tax withheld and the adjustments are separate totals, so they can be compared with the
  broker's tax statement. The tax on the result of a managed account is a tax on gains, not a
  cost.
- **Net result** = realized + unrealized + income − costs − taxes on gains. It needs prices
  (milestone 0.2.1); `derivedResults` in `packages/core` gives the first three already.

Because of the credit on a bond buy with accrued interest, the domestic withholding total can be
negative. The cost that came in (buys and transfers in) minus the cost transferred out is the
*net cost in*, not the money invested: a transfer in from outside the app brings the cost it
carries, not money paid through the account.

**A portfolio's cost is a share, not a running sum.** A portfolio's cost in − cost sold − cost
transferred out does not equal its cost: cost shifts between the portfolios of an account through
the shared average. In the example below, A paid €1,005.00 and its sale removed €576.25, which
leaves €428.75, yet A's cost is €576.25: when B bought at €120 the account's average rose to
€115.25, and A's share of the cost rose with it. Never divide a portfolio's cost by its quantity
to show an average: show the account's average cost. The account's figures always reconcile.

**The account adds up.** For an account whose securities all came in through buys, realized +
income − costs − taxes on gains = (cash balance + cost) − money transferred in: every cent that
left the cash either sits in the cost or is one of those results.

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
  With a €3.00 custody fee as well, the account adds up: 951 − (5 + 3) − 147.26 = €795.74, and
  the €9,000.00 transferred in became €4,929.74 of cash and €4,866.00 of cost, €9,795.74.
- **A managed account's tax.** A managed account whose result for the year is €1,000.00 pays
  €260.00 of managed result tax (26%): €260.00 of taxes on gains, no cost.
- **A dividend's net income.** A €20.00 dividend with €3.00 of foreign withholding, €4.42 of
  domestic withholding and a €2.00 fee is €10.58 of income; the €5 fee paid when the units were
  bought is not subtracted again.
- **A split covers every holding.** A corporate split affects every unit of the instrument, so it
  is recorded once per portfolio holding it, in every account of the workspace. If two accounts
  hold the instrument and the split is recorded in only one, it is refused
  (`split_missing_for_portfolio`); so is a trade that would make another portfolio hold the
  instrument on that date without its own split row. An account that no longer holds the
  instrument on that date needs no row.

#### The cash a trade moves

Every trade that moves money writes it on the brokerage account as one transaction, its cash leg
([ADR 0012](adr/0012-trade-cash-legs.md)), so the account's cash balance is the money transferred
in from the budget, minus what was transferred out, plus every cash leg. The leg is positive when
cash comes in:

| Trade | Cash |
| --- | --- |
| Buy | −(gross + fees + transaction tax + accrued interest − domestic withholding) |
| Sell | gross + accrued interest − fees − transaction tax − gain tax − domestic withholding |
| Dividend or coupon | gross − fees − foreign withholding − domestic withholding |
| Fee | −fees |
| Tax | −amount; a gain tax adjustment +amount (a refund is positive, extra tax negative) |
| Transfer of securities | −fees (nothing without fees) |
| Split | nothing |

The worked example on the financial transaction tax, followed through the account's cash:

| Step | Cash | Balance |
| --- | --- | --- |
| Transfer in from the checking account | +9,000.00 | 9,000.00 |
| Buy 100 at €50, €5 fee, €5 transaction tax | −5,010.00 | 3,990.00 |
| Buy 50 at €62, €5 fee | −3,105.00 | 885.00 |
| Sell 60 at €70, €5 fee, €247.26 gain tax | +3,947.74 | 4,832.74 |
| Gain tax adjustment refunded by the broker | +100.00 | 4,932.74 |
| The €20.00 dividend of the next example, paid into the same account (20 − 3 − 4.42 − 2) | +10.58 | 4,943.32 |

The leg's amount, account and date come from the trade; only its memo, payee and cleared status
are edited on the transaction. The budget never sees any of it: a brokerage account is off budget.
The money left the budget once, when it was transferred to the broker: that transfer went from an
on-budget account to an off-budget one, so it carried a category, and it was that category's
spending (see [Money moved to an off-budget account](#money-moved-to-an-off-budget-account)).

**Dates and clearing.** The leg is dated on the trade date, and starts uncleared like any new
transaction: the user marks it cleared when it appears on the broker's statement. Cash moves on
the settlement date, usually two business days later (T+2), so a statement dated inside that
window does not show the trade yet: reconcile after settlement. A dividend or a coupon is entered
on its payment date, the day the cash arrives, not on its ex-date.

**What is not a trade.** A refund of a fee or of stamp duty is entered as a plain transaction on
the brokerage account, not as a negative fee or tax. The tax on financial assets held abroad
(IVAFE) is paid through the tax return, not from the foreign account, so it is not a tax trade
either.

**Taxes and the regime.** In an `IT` workspace each trade is checked against the account's tax
regime on its trade date. A gain tax adjustment corrects tax withheld earlier, possibly under
another regime: an administered sale in December, a switch to self-declared from 1 January and a
refund in February are accepted, because a regime in force on or before the refund allowed gain
tax. In the self-declared regime only a domestic withholding agent withholds gain tax, and only on
funds, so an adjustment there names the fund it adjusts. A dividend's or a coupon's domestic
withholding can appear at any broker, since Italian tax may have been taken upstream before a
foreign broker paid it; the withholding on the accrued interest of a bond buy or sale is computed
only by a domestic withholding agent.

Not handled yet: return of capital, amortizing bonds, bonds issued at a discount — among them
zero-coupon government bills (BOT) and zero-coupon notes (CTZ) traded before maturity, where the
withholding agent settles tax on the part of the issue discount accrued while they were held: a
BOT bought at issue for €9,850 per €10,000 nominal and sold after half its life for €9,960 carries
about €75 of accrued discount (taxed at 12.5%) and €35 of capital gain (taxed at 26%), which the
fields of a trade cannot keep apart yet —, spin-offs,
mergers and rights issues, dividends paid in shares, and the fiscal view in euros for instruments
in other currencies. Until exchange rates exist, a transfer between two accounts in different
currencies is refused, because its cost cannot be converted: the API answers `currency_mismatch`,
since in 0.2.0 the instrument must be in each account's currency, and the core's own replay refuses
it too (`invalid_trade`, field `currency`). Such a move is entered as a transfer out of the app
from the first account plus a transfer in from outside into the second, carrying the cost
converted by the user.

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

### Tax regimes of a brokerage account

Recorded now (#508), used later: the app does not compute any tax yet. Indicative taxes are part of
the local tax rules (milestone 0.11.0, see the [design document](design.md#tax-regime-of-brokerage-accounts)).
What follows describes the Italian rules the records are shaped for; it says what each regime
means, not which one to choose.

A workspace whose tax country is Italy (`IT`) records, for every brokerage account, which of three
regimes it is under:

- **Self-declared** (*dichiarativo*, `self_declared`). The broker does not settle the tax on
  capital gains from securities; the investor reports them in their annual return. An Italian
  withholding agent (*sostituto d'imposta*) still withholds on income from funds and ETFs
  (including the gain when units are sold or redeemed), dividends and coupons. A foreign broker
  does not act as an Italian withholding agent, so it applies no Italian withholding of its own;
  Italian-source income may still arrive with Italian tax applied upstream.
- **Administered** (*amministrato*). The broker, an Italian withholding agent, computes and
  withholds the tax on each realized gain when it happens, and keeps track of losses within that
  account to offset later gains.
- **Managed** (*gestito*). The investor has given a manager a mandate to manage the account. The
  tax applies to the result the mandate accrued over the year, realized or not, and the manager,
  an Italian intermediary, applies it. Such an account is normally recorded as one private
  "mandate" instrument with a value entered by hand, which needs private instruments
  (milestone 0.2.1); until then it records individual trades only.

**One account, one dossier.** An account in the app is one dossier at the broker. One broker can
hold several dossiers under different regimes, each recorded as its own account.

**The withholding agent is fixed per account.** Whether the broker is an Italian withholding agent
is recorded once, with no history: if the broker's status changes, that is a new account and a
transfer of securities. An administered or managed account always has a broker that is one. The
flag only checks the regime and, later, feeds estimates; the tax actually withheld on each
dividend, coupon or sale is what the trade records, and that is the fact.

**The regime is a history.** An account can change regime, but a change takes effect from
1 January; only the first regime recorded may start on any date (by default, the day it is
recorded). Each trade is read under the regime in force on its own date, so a change from a later
1 January does not alter trades dated before it; recording or correcting the history re-reads the
trades it covers. The first regime also covers every date before it: until the first change, it is
the only regime known for the account, so a household importing years of older trades does not
have to backdate it. A switch in the middle of a year is, in practice, two accounts and a transfer
of securities between them.

**Example.** A regime "administered" is recorded on 20 November 2026 for an account opened years
earlier. A sale from 2019, imported later, is read under the administered regime too. If the
account was under another regime back then, record that history instead: for example
self-declared, then administered from 1 January 2024.

**Example.** An account administered since 15 March 2024 switches to self-declared from 1 January
2027. A sale on 20 December 2026 is under the administered regime, so the broker withholds the tax
on its gain at the sale; a sale on 5 January 2027 is under the self-declared regime, so its gain
goes into the investor's own annual return. Recording the switch does not change the 2026 sale. A
switch recorded "from 1 July 2027" is refused (`tax_regime_change_not_year_start`).

**Example.** The same account already holds a sale of a share on 10 February 2026, on which the
broker withheld €26.00 of gain tax. Correcting the history to "self-declared since 2024" is refused
(`tax_regime_conflicts_with_trade`, naming that sale): under self-declared a broker withholds no
gain tax on a share, so the recorded sale would no longer make sense. Either the sale is wrong (edit
or delete it first) or the history is (keep administered over February 2026). Had the sale been of
a fund at an Italian withholding agent, the correction would be accepted, since such a broker still
withholds on fund gains. A change only judges the trades it covers: a switch from 1 January 2027
leaves that sale alone.

**Example.** Two self-declared accounts each receive a foreign dividend of €100 gross, €15 of it
withheld abroad, so €85 is left. At a broker that is an Italian withholding agent, €22.10 is
withheld on the €85 and €62.90 arrives. At a foreign broker, €85 arrives and is reported in the
investor's return.

#### What each regime changes in the trades

Since nothing computes a tax yet, the regime decides which taxes a trade may carry: each trade in
an `IT` workspace is checked against the regime in force on its trade date, and the broker's own
figures are recorded as they are, never compared with an estimate. 26% is the ordinary rate on
gains and income from securities; 12.5% applies to government bonds.

| On the trade | Self-declared | Administered | Managed |
| --- | --- | --- | --- |
| Gain tax withheld on a sale (`gainTaxCents`) | only on a fund, at a broker that is an Italian withholding agent | yes | no: the manager settles the tax on the year's result |
| A gain tax adjustment (refund or extra tax) | when a regime in force on or before its date allowed gain tax; under self-declared alone, only on a fund at an Italian withholding agent | the same | the same |
| Tax on the result of the mandate (`managed_result_tax`) | no | no | yes |
| Domestic withholding on a bond trade's accrued interest | only at an Italian withholding agent | yes (always one) | yes (always one) |
| Domestic withholding on a dividend or a coupon | at any broker: it may have been taken before a foreign broker paid it | yes | yes |

A trade the regime does not allow is refused with `tax_kind_not_allowed_in_regime`, naming the
regime and the field; the withholding on accrued interest at a foreign broker is refused with
`domestic_withholding_requires_agent`. In an `IT` workspace, a brokerage account with no regime yet
takes no new trade (`tax_regime_required`). A workspace can still become `IT` while some of its
brokerage accounts have trades and no regime: the change lists those accounts, their trades keep
taking any edit while the account has no regime, and the first regime recorded is checked against
every one of them by every rule above, the withholding on accrued interest included. A trade no
regime would accept (gain tax on a share's sale with a self-declared regime in mind, say) is edited
first, then the regime is recorded. Setting the withholding-agent flag later, on an account that
already has a regime, is checked against its trades the same way. The worked examples below follow the tests in
`packages/core` and `apps/api`; not every figure is itself a test case (the €260.00 managed
result tax, for one, is not).

**Example: a sale's gain tax in each regime.** An ETF (a fund) is sold at a gain of €173.00, and
the broker withholds 26% of it, €44.98: 1,300.00 of gross, a €5.00 fee and €44.98 of gain tax put
€1,250.02 into the account. On an administered account the sale is recorded as it is. On a
self-declared account at an Italian withholding agent it is too, because such a broker still
withholds on fund gains; the same sale of a share there, or of the ETF at a foreign broker, is
refused (`tax_kind_not_allowed_in_regime`, field `gainTaxCents`): no Italian tax is withheld on
those gains, which go into the investor's return. On an account that has only ever been managed,
any gain tax on a sale is refused, and so is a gain tax adjustment.

**Example: the regime in force on each date.** An account is administered from 10 May 2024 and
managed from 1 January 2026. A sale with gain tax dated 31 December 2025 is accepted; the same sale
dated 1 January 2026 is refused.

**Example: a refund across a change of regime.** An account administered since 10 March 2025
switches to self-declared from 1 January 2026. A share sold on 15 December 2025 has €3.00 of gain
tax withheld. On 10 February 2026 the broker refunds it: a tax trade of kind `gain_tax_adjustment`
with a gross of +€3.00, which puts €3.00 back into the account. It is accepted because a regime in
force on or before 10 February 2026, the administered one, allowed gain tax; a sale with gain tax
on that same day is refused, since the regime then is self-declared. On an account that was only
ever self-declared, an adjustment is accepted only on a fund. On an account managed from
1 May 2024 and administered from 1 January 2026, a refund dated 1 June 2025 is refused (only the
managed regime was in force by then) and one dated 1 June 2026 is accepted.

**Example: the tax on a managed account's result.** A managed account whose result for the year is
€1,000.00 pays €260.00 (26%), recorded on 31 December as a tax of kind `managed_result_tax`: €260.00
of taxes on gains, not a cost, and €260.00 out of the account. The same tax on an administered
account is refused (`tax_kind_not_allowed_in_regime`, field `taxKind`).

**Example: a government bond's accrued interest.** A government bond paying a 2% coupon every six
months, €10,000 nominal, is bought at 98.50, 60 days into a 182-day coupon period, with a €5.00
fee: the gross is 10,000 × 98.50 × 0.01 = €9,850.00 and the accrued interest paid to the seller
10,000 × 2% × 60 ÷ 182 = €65.93. An Italian withholding agent credits back 12.5% of that interest,
€8.24, so €9,850.00 + 5.00 + 65.93 − 8.24 = €9,912.69 leaves the account. Sold later at 99.20 with
€131.87 of accrued interest and a €5.00 fee, on an administered account: the gain is
9,920.00 − 5.00 − 9,855.00 = €60.00, taxed at 12.5%, €7.50; 12.5% of the interest, €16.48, is
withheld; €9,920.00 + 131.87 − 5.00 − 7.50 − 16.48 = €10,022.89 comes in. At a foreign broker,
which applies no Italian withholding, a domestic withholding on either trade is refused.

**Example: dividends at an Italian and at a foreign broker.** An Italian share pays a €100.00
dividend with €26.00 withheld in Italy before it is paid: €74.00 arrives, and the trade is accepted
at a foreign broker too, since the tax was taken upstream. A foreign share's €100.00 dividend with
€15.00 withheld abroad, €22.10 withheld by an Italian withholding agent (26% of the €85.00 left)
and a €2.00 fee puts €60.90 into the account. A coupon of €200.00 with 12.5% withheld puts €175.00
in.

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
