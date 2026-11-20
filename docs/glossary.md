# Glossary

## Finance and budgeting

| Term | Meaning | In the code | Italian UI |
| --- | --- | --- | --- |
| Unassigned | Money that has come in but is not assigned to a category yet | `unassigned` | Da assegnare |
| Category | An "envelope" of the budget: Groceries, Rent, Fun… | `categoryId` | Categoria |
| Assigned | Money put into a category for a month | `assigned`, `Assignment` | Assegnato |
| Activity | Spending (negative) and refunds (positive) of a category in the month | `activity`, `Activity` | Movimenti |
| Available | Carried over + assigned + activity; negative = overspent | `available` | Disponibile |
| Carried over | Positive available balance from the previous month | `carriedOver` | Riportato |
| Cash overspending | The part of a negative category paid from cash accounts; taken from unassigned money the following month | `cashOverspending`, `overspentLastMonth` | Spesa eccessiva in contanti |
| Credit overspending | The part of a negative category paid with a credit card; it becomes card debt and does not touch unassigned money | `creditOverspending` | Spesa eccessiva con carta |
| Payment category | A category per credit card holding the money set aside to pay it; covered card spending moves money into it | `paymentCategoryId`, `paymentCategories` | Pagamento carta |
| Card payment | A transfer from a cash account to a credit card | `CardPayment` | Pagamento della carta |
| On-budget / off-budget account | Accounts whose money is (or is not) part of the budget; investments and mortgages are usually off-budget, and a brokerage account ("Conto titoli") is always off-budget | `onBudget` | Conto in budget / fuori budget |
| Split | One transaction spread across several categories | `Split` | Suddivisione |
| Minor unit | The smallest unit of a currency: the cent for EUR, the yen for JPY | `Cents` | Centesimo |
| Quantity | How many units of an instrument a trade or position holds, with up to 8 decimals; for a bond quoted in percent, its nominal amount ([ADR 0011](adr/0011-quantities-and-prices-as-scaled-integers.md)) | `Quantity`, `quantity_e8`, `quantityE8` | Quantità |
| Price | The price of one unit as quoted, with up to 6 decimals; in the instrument's currency when the price factor is 1 | `Price`, `price_e6`, `priceE6` | Prezzo |
| Price factor | What turns quantity × price into an amount: 1 for most instruments, 0.01 for a bond quoted in percent of nominal or a share quoted in pence | `PriceFactor`, `price_factor_e6`, `priceFactorE6` | Fattore di prezzo |
| Nominal | A bond's face value, the amount repaid at maturity; it is the bond's quantity, so 10 bonds of €1,000 are a quantity of 10,000 | `quantity_e8` | Valore nominale |
| Portfolio | A named group of holdings with its own purpose ("Long term", "Pension"); every trade is filed under exactly one, so a portfolio can span several brokerage accounts and an account can hold several portfolios | `portfolios`, `portfolioId` | Portafoglio |
| Instrument | One listing of a security in the catalog shared by every workspace: an ETF, a share, a bond, a fund… identified by an ISIN, or by a ticker on an exchange | `instruments`, `instrumentId` | Strumento |
| ISIN | The 12-character international code of a security, with a check digit; the same ISIN can be listed on several exchanges | `isin` | Codice ISIN |
| Ticker | The short symbol a security trades under on one exchange | `ticker` | Ticker |
| Market identifier code (MIC) | The four-character ISO 10383 code of an exchange, such as XMIL; how an instrument names its exchange | `exchange` | Codice del mercato (MIC) |
| Trade | One buy, sell, dividend or coupon, fee, tax, stock split or transfer of securities on a brokerage account | `trades`, `TradeType` | Operazione |
| Cash leg | The one transaction a trade that moves money owns on its brokerage account; its amount, account and date come from the trade ([ADR 0012](adr/0012-trade-cash-legs.md)) | `cashTransactionId`, `transactions.trade_id`, `tradeCashCents` | Movimento di liquidità |
| Position | What an account or a portfolio holds in one instrument, rebuilt from the trades on every request, never stored | `PositionRecord`, `computePositions` | Posizione |
| Weighted average cost | The cost method: the total cost of a holding divided by its quantity, per account and instrument, shared by every portfolio of the account | `accountAverageCostE6`, `averageCost` | Costo medio ponderato |
| Cost basis | The cost of the units held: buys at gross + fees, plus the cost brought by transfers in from another account or from outside the app, less the share removed by each sale or transfer out | `costBasisCents` | Costo di carico |
| Realized gain or loss | What a sale earned over the cost it removed: gross − fees − cost removed; economic, not taxable | `realizedCents` | Plusvalenza o minusvalenza realizzata |
| Stock split | A change in the number of units of a security, written from:to (1:4: one unit becomes four; a reverse split 10:1: ten become one); the cost does not change. Not to be confused with a split of a transaction across categories | `split`, `splitFrom`, `splitTo` | Split azionario |
| Ex-date | The day a stock split or a dividend takes effect on the price; a split is recorded on it, and applies before every other trade of that date | `tradeDate` of a split | Data di stacco |
| Transfer of securities | Units moved between two portfolios, two accounts, or into or out of the app; between accounts the units take their share of the cost with them | `transfer`, `transferTradeId` | Trasferimento titoli |
| Accrued interest | The interest a bond has earned since its last coupon, paid by the buyer to the seller on top of the price; never part of the cost or the gain | `accruedInterestCents` | Rateo di interessi |
| Coupon | A bond's periodic interest payment; recorded as a dividend | `dividend` | Cedola |
| Domestic withholding | Italian tax withheld at source, entered as a positive amount: withheld on a dividend, a coupon or a bond sale's accrued interest, credited back on a bond buy's | `withholdingDomesticCents` | Ritenuta italiana |
| Foreign withholding | Tax withheld abroad on a dividend before it is paid | `withholdingForeignCents` | Ritenuta estera |
| Gain tax | The tax a broker withholds on the gain of a sale, recorded on that sale | `gainTaxCents`, `gainTaxWithheldCents` | Imposta sulla plusvalenza |
| Gain tax adjustment | A later correction of gain tax by the broker, kept with its sign: a refund is positive, extra tax negative | `gain_tax_adjustment`, `gainTaxAdjustmentsCents` | Rettifica dell'imposta sulle plusvalenze |
| Managed result tax | The tax on the result a managed account's mandate accrued over the year, realized or not; a tax on gains | `managed_result_tax`, `managedResultTaxCents` | Imposta sul risultato di gestione |
| Stamp duty | A periodic tax on the securities account; a tax trade, part of the costs | `stamp_duty` | Imposta di bollo |
| Financial transaction tax | A tax on buying or selling some securities; never part of the cost, part of the costs total | `transactionTaxCents` | Imposta sulle transazioni finanziarie |
| Income, costs, taxes on gains | The three results worked out from a position's totals: income (dividends and coupons net of withholding and fees, plus accrued interest received, minus paid), costs (transaction tax, transfer fees, standalone fees and taxes), taxes on gains (gain tax withheld − adjustments + managed result tax) | `incomeCents`, `costsCents`, `taxesOnGainsCents`, `derivedResults` | Proventi, costi, imposte sulle plusvalenze |
| Settlement | When the cash of a trade actually moves, usually two business days after the trade date (T+2); a cash leg clears then | — | Regolamento |
| Tax country | A workspace's country for tax purposes (ISO 3166-1 alpha-2); in `IT`, every brokerage account records its tax regime | `taxCountry`, `tax_country` | Paese fiscale |
| Tax regime | How a brokerage account's gains are taxed, kept as a history of periods (a change starts on 1 January): self-declared, administered or managed | `TaxRegime`, `account_tax_regimes` | Regime fiscale |
| Self-declared regime | The broker does not settle the tax on capital gains from securities; the investor reports them in their annual return | `self_declared` | Dichiarativo |
| Administered regime | The broker, an Italian withholding agent, withholds the tax on each realized gain and tracks losses within the account | `administered` | Amministrato |
| Managed regime | A manager, an Italian intermediary, runs the account under a mandate and applies the tax to the result the mandate accrued over the year, realized or not | `managed` | Gestito |
| Withholding agent | A broker that withholds Italian tax at source on the investor's behalf (on income from funds and ETFs, dividends and coupons); fixed per account, required for an administered or managed one | `domesticWithholdingAgent` | Sostituto d'imposta |
| Dossier | One securities account at a broker, under one tax regime; one account in the app. A broker can hold several | — | Dossier titoli |

## Technical

| Term | Meaning |
| --- | --- |
| Scaled integer | A decimal value stored as an integer with its scale in its name: `quantity_e8` is units × 10^8, `price_e6` a price × 10^6 ([ADR 0011](adr/0011-quantities-and-prices-as-scaled-integers.md)) |
| Replay | Rebuilding positions by applying every trade of an instrument in one fixed order (trade date, splits first, time, creation time, id), so the same trades always give the same result |
| Row-Level Security | PostgreSQL's per-row filter: every workspace-scoped table shows and accepts only the current workspace's rows ([ADR 0006](adr/0006-row-level-security.md)) |
| Composite workspace key | A foreign key that includes `workspace_id` on both sides, so a row can never point at another workspace's row (foreign keys are checked without Row-Level Security) |
| Monorepo | One repository with several packages that depend on each other |
| Package | A folder with its own `package.json`: a library or an app |
| Pure function | A function that depends only on its parameters and has no external effects (database, network, files) |
| Invariant | A property that must always hold, whatever the data |
| Lockfile | `pnpm-lock.yaml`: the exact versions of every dependency, for identical installs everywhere |
| CI | Continuous integration: GitHub runs checks and tests on every change |
| ADR | Architecture Decision Record: a page explaining a decision and the discarded alternatives |
| Locale | Language and regional conventions for numbers and dates, for example `it-IT` or `en-US` |
| i18n | Internationalization: preparing the app to be translated and formatted for any locale |
| MCP | Model Context Protocol: the standard through which an AI assistant calls an application's tools; `apps/mcp` is the app's MCP server ([ADR 0014](adr/0014-assistant-access-through-mcp.md)) |
| Assistant connection | One member's link between an assistant client and a workspace, `pending` until approved from the web app on the LAN, then `active` until revoked; `assistant_connections` |
| Delegated token | An access token issued to a client other than the app's own (an assistant), on a member's behalf; the API allows it only on routes flagged for assistants |
| Draft | A transaction or trade proposed by an assistant and not yet recorded; it becomes real only when a member confirms it in the web app (`trade_drafts`, staged transactions) |
