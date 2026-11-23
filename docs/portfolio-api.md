# Portfolio API

How to record a portfolio through the API, and what the API does with it: the schema behind it,
every endpoint of milestones 0.2.0 and 0.2.1 with its request and response bodies, its validation codes, and
how positions and their results are worked out. It is written for three readers:

- **someone recording their own portfolio.** There are no portfolio screens yet, so the API is the
  only way in; the [step-by-step example](#a-worked-example) at the end is the quickest start;
- **exploratory testers**, who need to know what the API should answer before they can say it
  answered wrongly;
- **developers**, who need the rules without reading `apps/api` and `packages/core` first.

The *why* behind the numbers (cost basis, the order of the replay, the Italian tax regimes) is in
the [domain guide](domain-guide.md#portfolios-and-rebalancing); the decisions are
[ADR 0011](adr/0011-quantities-and-prices-as-scaled-integers.md) (quantities and prices) and
[ADR 0012](adr/0012-trade-cash-legs.md) (a trade owns its cash leg). Every example below was
checked against a running server.

Milestone 0.2.1 added private instruments, with no ISIN and no ticker (#505,
[Private instruments](#private-instruments)), a workspace's own closing prices, typed or imported
from a CSV file (#83, [Prices](#prices)), the ECB's exchange rates ([Exchange rates](#exchange-rates),
#85), and a portfolio's month-by-month value, contributions, gain and returns, in the workspace's
base currency ([Performance](#performance), #89).

What the API does **not** do yet: positions show no current value, unrealized gain or net result
(the [performance](#performance) values the whole portfolio instead); a trade's instrument must be
in its account's currency; no settlement date on a trade; no import of a broker's statement; and no
field of a trade is synced from devices yet.

## Contents

- [Before you start](#before-you-start)
- [The schema](#the-schema)
- [Workspace tax country](#workspace-tax-country)
- [Brokerage accounts and their tax regime](#brokerage-accounts-and-their-tax-regime)
- [Instruments](#instruments)
- [Prices](#prices)
- [Exchange rates](#exchange-rates)
- [Portfolios](#portfolios)
- [Trades](#trades)
- [Positions](#positions)
- [Performance](#performance)
- [A worked example](#a-worked-example)

## Before you start

**Where.** Every path below is relative to the API's URL: `http://127.0.0.1:3000` for a
development server ([getting started](getting-started.md#9-the-api-server-appsapi)), or `api.url`
in the manifest of a disposable environment ([getting started](getting-started.md#14-a-disposable-environment-optional)).

**Signing in.** Every request but `GET /health` needs a Keycloak access token in
`Authorization: Bearer <token>`. On a disposable environment, `scripts/README.md` ("The manifest")
shows how to get one for a persona with `curl`; tokens there last 15 minutes. Bodies are JSON
(`content-type: application/json`).

**Who may do what.**

| Endpoint | Who |
| --- | --- |
| `PATCH /workspaces/:workspaceId` (tax country) | the workspace's `owner` |
| `POST /instruments`, `GET /instruments…` | any signed-in user, no workspace needed: the catalog is shared (these routes never see a workspace's private instruments) |
| Every `GET` under `/workspaces/:workspaceId/` | any member, `read_only` included |
| Every other write under `/workspaces/:workspaceId/` | `owner` and `editor`; a `read_only` member gets 403 |

A workspace the caller is not a member of answers 403. Inside a workspace, an id that names
another workspace's row answers exactly as one that names nothing: 404 in a path, a validation
error in a body (`unknown_account`, `unknown_portfolio`). A malformed id in a path is a 404.

**Numbers are integers.** No amount, quantity or price is ever a decimal number in the API:

| Field | Holds | Example |
| --- | --- | --- |
| `…Cents` | an amount in the account's minor unit ([ADR 0002](adr/0002-amounts-in-minor-units.md)): cents for EUR, yen for JPY | €2,005.00 is `200500` |
| `quantityE8` | units × 10^8: up to 8 decimals, so fractional units fit | 20 units is `2000000000`; 1.5 units is `150000000` |
| `priceE6` | the price of one unit as quoted × 10^6 | €100.00 is `100000000`; 99.50 (percent of nominal) is `99500000` |
| `priceFactorE6` | the instrument's price factor × 10^6 | 1 is `1000000`; 0.01 is `10000` |
| `accountAverageCostE6` | an average cost, as a price × 10^6 | €56.10 is `56100000` |

The amount of a buy or a sell is quantity × price × price factor, rounded once, half away from
zero, to the minor unit. The price factor is 1 for most instruments and 0.01 for a bond quoted in
percent of its nominal, or a share quoted in pence. **A bond's quantity is its nominal**: €10,000
nominal is `quantityE8: 1000000000000`, and at 99.50 its amount is
10,000 × 99.50 × 0.01 = €9,950.00, `995000`. Every value must be a safe integer (at most
9,007,199,254,740,991), which caps a position at about 90 million units and a price at about
9 billion per unit (ADR 0011).

**Dates and times.** A date is `"YYYY-MM-DD"`. A time is an ISO 8601 timestamp with `Z` or an
offset (`"2026-03-12T10:15:00+01:00"`); the API answers in UTC (`"2026-03-12T09:15:00.000Z"`).

**Errors.** Four shapes:

| Status | Body | When |
| --- | --- | --- |
| 400 | `{ "error": "<code>", "details": { … } }` | a rule of the domain, a trade body the route cannot read, or a body with a field the request does not take (`unknown_field`, below): the codes below, each with its `details` |
| 400 | `{ "error": "invalid portfolio: …" }` | a body the account, portfolio or instrument routes cannot read. English text, no code (the trade routes answer with codes, #594) |
| 409 | `{ "error": "<text>", "code": "<code>" }`, sometimes with `details` | a conflict: a name or an id already taken, a locked trade |
| 403, 404 | `{ "error": "<text>" }` | not allowed, not found |

**Bodies are strict.** Every write below takes only the fields its section lists: any other key, a
misspelt one (`taxcountry`) or one the request cannot change (`id`, `workspaceId`, an account's
`currency` on its `PATCH`), is 400 `unknown_field` with `{ "field" }` naming it, checked before
anything else, so nothing is written (#713; the trades since #594). A field inside a nested object
or list is named by its path: `from.fees` in a trade's leg, `taxRegimes[1].regim` in a regime
history. A body that is not a JSON object (an array, a string) is 400 `invalid_body` on those
same routes. Closing an account takes no field: send no body, or `{}`.

Names and free text have length limits (`apps/api/README.md`, "Length limits on names and free
text"): a portfolio's `name` 100 characters, its `purpose` and a trade's `memo` 500; over the
limit is 400 `text_too_long` with `{ "field", "max" }`.

**Nothing half-written.** Each request runs in one database transaction, committed only when the
reply's status is below 400. Any error leaves nothing stored, so retrying a request that failed
never creates a duplicate. (For a request whose answer was lost, see
[Retries and client ids](#retries-and-client-ids).)

## The schema

Migrations 0025 to 0031 in `apps/api/migrations/`, and 0035 for private instruments. The parts and how they connect:

```
workspaces (tax_country)
 ├─ accounts (type 'brokerage', on_budget false, domestic_withholding_agent)
 │   ├─ account_tax_regimes (valid_from, regime)        one row per period
 │   ├─ transactions (trade_id → the trade it is the cash leg of)
 │   └─ trades ──────────── instrument_id → instruments (shared, or this workspace's own)
 ├─ instruments (workspace_id set: private instruments)
 └─ portfolios ──────────── ◄ trades.portfolio_id
```

| Table | What a row is | Workspace isolation |
| --- | --- | --- |
| `instruments` | one listing of a security in the shared catalog (an ISIN, or a ticker on an exchange, `workspace_id` null), or a workspace's private instrument (`workspace_id` set, no ISIN, ticker or exchange) | Row-Level Security since migration 0035, one policy per command: every caller reads the shared rows and its own workspace's, and inserts a shared row or one of its own workspace's. The app may only read and insert (`SELECT`, `INSERT`); an administrator corrects it with SQL (`apps/api/README.md`, "Correcting the instruments catalog") |
| `portfolios` | a named group of holdings with a free-text purpose; archivable | Row-Level Security |
| `trades` | one buy, sell, dividend or coupon, fee, tax, split row or transfer leg | Row-Level Security |
| `account_tax_regimes` | one period of a brokerage account's tax regime | Row-Level Security |
| `transactions.trade_id` | marks a transaction as a trade's cash leg | (the transactions table's own) |
| `workspaces.tax_country` | ISO 3166-1 alpha-2 code, or null | — |
| `accounts.domestic_withholding_agent` | brokerage accounts only: whether the broker is an Italian withholding agent; null when not recorded | — |

**Row-Level Security.** Every workspace-scoped table has `ENABLE` and `FORCE ROW LEVEL SECURITY`
and the policy `workspace_id = app_workspace_id()` for reads and writes alike
([ADR 0006](adr/0006-row-level-security.md)), so a request sees and writes only its own
workspace's rows, whatever its SQL says.

**Composite workspace keys.** PostgreSQL checks a foreign key without Row-Level Security, so a
plain `account_id REFERENCES accounts (id)` would let a row point at another workspace's account
once its id was known. Every foreign key between two workspace-scoped tables therefore carries the
workspace too, and the row it points at must have the same `workspace_id`. The keys below come
from migrations 0028 to 0031; migration 0029 (#504) converted the older tables' keys the same way:

| Key | Points at | On delete |
| --- | --- | --- |
| `trades (workspace_id, account_id)` | `accounts (workspace_id, id)` | cascade |
| `trades (workspace_id, portfolio_id)` | `portfolios (workspace_id, id)` | restrict: a portfolio with trades cannot be deleted |
| `trades (workspace_id, transfer_trade_id)` | `trades (workspace_id, id)`, the other leg of a transfer | no action, deferrable, so both legs are inserted pointing at each other and only deleted together |
| `transactions (workspace_id, trade_id, account_id)` | `trades (workspace_id, id, account_id)` | cascade; on update cascade, so a cash leg can only ever sit on its trade's account |
| `account_tax_regimes (workspace_id, account_id)` | `accounts (workspace_id, id)` | cascade |
| `trades (instrument_id)` | `instruments (id)` | no action: an instrument a trade uses is never removed. Single-column, since a shared instrument belongs to no workspace; a trigger (migration 0035) refuses an instrument that is neither shared nor the trade's own workspace's, with a `check_violation` naming `instrument_not_found` |

**The `trades` columns.** Every amount is in the account's minor unit; `quantity_e8` and
`price_e6` are scaled integers (ADR 0011). A column a type does not use is 0 (amounts, quantity,
price) or null (`tax_kind`, `cost_basis_cents`, `split_from`, `split_to`, `transfer_trade_id`),
and one `CHECK` per type enforces it, so a row that breaks its type's shape cannot be stored
whatever writes it. `quantity_e8` and `price_e6` are kept within the safe-integer range; amounts
are never negative, except the gross of a gain tax adjustment. Positions are never stored: they
are worked out from these rows on every request.

The app may update a trade's columns but never its `id`, `workspace_id`, `type`, `created_at` or
`transfer_trade_id`: the type of a trade and the link between a transfer's legs never change. The
withholding-agent flag of an account cannot change once set (a trigger refuses it), and a
brokerage account can never be on budget (a `CHECK`), on every write path.

## Workspace tax country

`PATCH /workspaces/:workspaceId` — owner only.

```json
{ "taxCountry": "IT" }
```

`taxCountry` is an officially assigned ISO 3166-1 alpha-2 code in upper case (`"it"` is refused
with `invalid_tax_country`, and so are codes that name no country, such as `ZZ`, `EU`, `UN` or
`UK`: the United Kingdom is `GB`), or `null` to remove it. A code stored before this check (#711)
is still returned as it is, and can be replaced or removed. The answer is the workspace, with the brokerage
accounts that have no tax regime yet:

```json
{
  "id": "45fd02be-…",
  "name": "Household",
  "baseCurrency": "EUR",
  "timeZone": "Europe/Rome",
  "taxCountry": "IT",
  "accountsWithoutTaxRegime": ["9b1c…"]
}
```

`accountsWithoutTaxRegime` lists, by id and oldest first, every brokerage account of the workspace
with an empty regime history when the tax country is `IT`, and is `[]` otherwise: a client can ask
for their regimes right away.

| Error | Details |
| --- | --- |
| 400 `invalid_tax_country` | `{ "taxCountry": "XX" }`: not two upper-case letters, or not an officially assigned ISO 3166-1 code (`ZZ`, `EU`, `UN`, `UK`) |
| 400 `unknown_field` | `{ "field": "taxcountry" }`: any key but `taxCountry`, the workspace's `timeZone` and `baseCurrency` included (#713) |

Only `IT` changes anything today: in an `IT` workspace every brokerage account records its tax
regime and whether its broker is an Italian withholding agent, and trades are checked against
them. Setting `IT` does not ask existing brokerage accounts for a regime retroactively, and is
never refused for them: such an account keeps working, a new trade on it is refused while it has no
regime (see below), and the trades it already has can still be edited in every field the regime
rules do not read, their memo first of all ([Editing a trade](#editing-a-trade)). Its first regime
is checked against those trades like any other change of the history. `GET /me/workspaces` lists each workspace's `taxCountry`.

## Brokerage accounts and their tax regime

### Creating a brokerage account

`POST /workspaces/:workspaceId/accounts` — owner, editor.

```json
{
  "name": "Broker",
  "type": "brokerage",
  "currency": "EUR",
  "taxRegime": "administered",
  "taxRegimeValidFrom": "2026-01-01",
  "domesticWithholdingAgent": true
}
```

- `onBudget` defaults to `false` for a brokerage account, and `true` is refused: a brokerage
  account is always off budget.
- `taxRegime` (`self_declared`, `administered` or `managed`) and `domesticWithholdingAgent` are
  required in an `IT` workspace and refused anywhere else, and on any other account type.
- `taxRegimeValidFrom` is the first day of that regime, any date; it defaults to today in the
  workspace's time zone. As the first period it also covers every earlier date, so older trades
  recorded later need no backdated regime. Sent without `taxRegime`, it is a plain 400.

The answer (201) is the account; the regime is read with `GET …/tax-regimes`:

```json
{
  "id": "b199f4b9-…", "workspaceId": "45fd02be-…", "name": "Broker", "type": "brokerage",
  "currency": "EUR", "onBudget": false, "paymentCategoryId": null,
  "domesticWithholdingAgent": true, "closedAt": null, "createdAt": "2026-11-20T20:33:01.629Z"
}
```

| Error | Details | When |
| --- | --- | --- |
| 400 `brokerage_on_budget` | `{ "type": "brokerage" }` | `onBudget: true` |
| 400 `tax_regime_required` | `{ "field": "taxRegime" \| "domesticWithholdingAgent", "taxCountry": "IT" }` | an `IT` workspace, one of the two missing |
| 400 `tax_regime_not_applicable` | `{ "field", "type" }` or `{ "field", "taxCountry" }` (`""` when none) | given on another account type, or outside an `IT` workspace |
| 400 `tax_regime_requires_withholding_agent` | `{ "regime": "administered" }` | `administered` or `managed` without `domesticWithholdingAgent: true` |
| 400 `invalid_date` | `{ "value" }` | `taxRegimeValidFrom` is not a real date |
| 400 `unknown_field` | `{ "field" }` | a key other than `name`, `type`, `currency`, `onBudget`, `startingBalanceCents` and the three above (#713) |

### The withholding-agent flag

`PATCH /workspaces/:workspaceId/accounts/:accountId` with `{ "domesticWithholdingAgent": true }` —
owner, editor. Only for a brokerage account in an `IT` workspace whose flag is still null (one
created before the workspace's tax country became `IT`): the flag is set once and is fixed
afterwards. If the broker's status changes, that is a new account and a transfer of securities.
The answer is the account. When the account already has a regime history, every trade of the
account is checked against the new flag by the trade rules (step 7): `false` is refused while a bond
trade carries a domestic withholding on its accrued interest. Without a history, the first regime
checks them (below).

| Error | Details |
| --- | --- |
| 400 `withholding_agent_already_set` | `{ "field": "domesticWithholdingAgent" }` |
| 400 `tax_regime_conflicts_with_trade` | `{ "tradeId", "tradeDate", "code": "domestic_withholding_requires_agent" }`: the flag would break that trade, the earliest by date then id |
| 400 `tax_regime_not_applicable` | `{ "field", "type" }` or `{ "field", "taxCountry" }` |
| 400 `unknown_field` | `{ "field": "name" }`: any key but `domesticWithholdingAgent`; this `PATCH` renames nothing (#713) |

### The regime history

An account's regime is a list of periods, each in force from its `validFrom` until the next one's,
the first also before its own date. A trade is checked against the regime in force on its trade
date. The first period may start on any date; every later one starts on 1 January, and no two
start on the same day. What each regime means, with examples, is in the
[domain guide](domain-guide.md#tax-regimes-of-a-brokerage-account).

| Request | Who | Body | Answer |
| --- | --- | --- | --- |
| `GET /workspaces/:workspaceId/accounts/:accountId/tax-regimes` | any member | — | 200 `{ "taxRegimes": [ { "validFrom", "regime" }, … ] }`, oldest first; `[]` when none |
| `POST …/tax-regimes` | owner, editor | `{ "regime": "self_declared", "validFrom": "2027-01-01" }`; `validFrom` defaults to today | 201 the period added |
| `PUT …/tax-regimes` | owner, editor | `{ "taxRegimes": [ { "validFrom": "2024-03-15", "regime": "self_declared" }, { "validFrom": "2026-01-01", "regime": "administered" } ] }` | 200 `{ "taxRegimes": […] }`, the whole history replaced at once |

`PUT` corrects the history: the old periods are deleted and the new ones inserted in one
transaction, under a lock on the account, and checked by the same rules.

**A change reads the account's trades again.** Every trade of the account the change covers — its
date now falls under another regime or, for a gain tax adjustment, the regimes in force on or before
its date are no longer the same — is checked against the new history by the trade rules
([What is checked, in order](#what-is-checked-in-order), step 7). If one of them breaks, the change
is refused with `tax_regime_conflicts_with_trade`, naming the earliest such trade (by date, then id)
and the code it would fail with, and nothing is written. For example, an administered account with
a sale of a stock that carries gain tax cannot become `self_declared` over that sale's date (a fund
sale at a domestic withholding agent can), and a managed account with a `managed_result_tax` cannot
leave `managed` over that tax's date. Edit or delete the trade first, or start the new regime on a
later 1 January. A trade whose period the change leaves alone is not checked again, and neither is
the withholding on accrued interest, which depends on the broker, not on the regime. The account's
first regime is the exception: it covers every trade, and checks each by every trade rule, the
withholding on accrued interest included (`domestic_withholding_requires_agent`), since trades
recorded while the account had no regime were never checked against the broker either. The check runs
under the same account lock as the write, which a trade being recorded or edited on that account
also waits for. `POST` can also add a
period before the first one, but only when the first one starts on 1 January (it then becomes a
change, and changes start on 1 January).

| Error | Details |
| --- | --- |
| 400 `tax_regime_change_not_year_start` | `{ "validFrom": "2027-07-01" }` |
| 400 `tax_regime_duplicate_date` | `{ "validFrom" }` |
| 400 `tax_regime_requires_withholding_agent` | `{ "regime" }`: any `administered` or `managed` period needs the flag set to true |
| 400 `tax_regime_not_applicable` | `{ "field": "taxRegime", "type" }` (not a brokerage account) or `{ "field": "taxRegime", "taxCountry" }` (not an `IT` workspace) |
| 400 `tax_regime_required` | `{ "field": "taxRegime", "taxCountry": "IT" }`: `PUT` with an empty list in an `IT` workspace |
| 400 `tax_regime_conflicts_with_trade` | `{ "tradeId", "tradeDate", "code": "tax_kind_not_allowed_in_regime" }`: the new history would break that trade; `code` is the trade's own failing code (`domestic_withholding_requires_agent` too, on a first regime) |
| 400 `invalid_date` | `{ "value" }` |
| 400 `unknown_field` | `{ "field": "validfrom" }` or, in a `PUT` entry, `{ "field": "taxRegimes[1].regim" }`: a key the body or the entry does not take (#713) |

### Closing a brokerage account

`PATCH /workspaces/:workspaceId/accounts/:accountId/close` — owner, editor. An account is closed
only once it is empty today and later, "today" in the workspace's time zone: its balance today is
zero and no transaction (a cash leg included) is dated after today; it holds no security today
(every position's quantity is zero; a position sold out does not count) and no trade is dated after
today, so a sale dated later does not empty a holding held today; and no scheduled transaction uses
it. Otherwise nothing is closed (#703, #729):

| Error | Details | When |
| --- | --- | --- |
| 409 `account_not_empty` | `{ "balanceCents": 0, "laterRows": { "count": 1, "firstDate": "2027-04-01" }, "holdsPositions": true, "scheduled": { "count": 1, "scheduledTransactionId": "0b9e6c7a-3f1d-4e52-9a8b-6c2d1e4f7a90", "nextDueDate": "2027-02-15" } }`: the balance as of today, in the account's currency; the rows dated after today (transactions, and trades that move no cash), with the earliest one's date (`null` when none); whether a security is held today; the scheduled transactions on it, with the id and next due date of the one due first (earliest next due date, then lowest id; both `null` when `count` is 0, #741) | any of those is not empty |
| 400 `unknown_field` | `{ "field": "closedAt" }` | any key in the body: closing takes none (#713) |
| 422 `amount_total_overflow` | `{ "accountId", "label": "balanceCents" }` | the balance is beyond the safe range of minor units (rows stored before the cap of #651) |
| 404 | | the account is not found, or is already closed |

A closed account takes no writes (#729, ADR 0018): a trade on it, a transfer of securities into or
out of it, and an edit or a deletion of one of its trades, or of a trade's cash leg, are refused with
409 `account_closed`, and nothing is written. The closed account is checked first, in the same
transaction and before the position replay (#741): a sell beyond the holdings, a date that would
leave a sale uncovered or the deletion of a buy a later sale needs answers `account_closed` on a
closed account, and `insufficient_quantity` only on an open one.

## Instruments

The shared catalog is open to every workspace: an instrument added by one household is found by
all (an asset with no ISIN and no ticker is a workspace's own instead: [Private instruments](#private-instruments)).
A row is a **listing**: the same ISIN can trade on several exchanges, in different currencies, and
appears once per exchange. A row cannot be changed or removed through the API, since other
workspaces may already use it.

### Adding an instrument

`POST /instruments` — any signed-in user.

```json
{
  "ticker": "WORLD1",
  "exchange": "XMIL",
  "name": "World equity ETF",
  "type": "fund",
  "currency": "EUR"
}
```

| Field | Rules |
| --- | --- |
| `isin` | optional; 12 characters with a correct check digit; upper-cased |
| `ticker` | optional; ASCII letters, digits, `.` and `-`, 1 to 32 characters; upper-cased; needs `exchange` |
| `exchange` | the exchange's ISO 10383 market identifier code (MIC), exactly 4 letters or digits, such as `XMIL` or `XETR`; upper-cased |
| `name` | required, up to 200 characters |
| `type` | `stock`, `fund` (ETFs included), `etc_etn`, `government_bond`, `bond`, `certificate`, `cash`, `other`. The split follows the lines tax rules draw, since a row is never updated |
| `currency` | an ISO 4217 code the runtime lists as in use, upper-cased (the same check as an account's, #595); the currency the instrument is quoted in |
| `assetClass` | optional free text, up to 64 characters |
| `priceFactorE6` | optional, default `1000000` (a factor of 1); `10000` (0.01) for a bond quoted in percent of nominal or a price in pence |

An instrument needs an ISIN, or a ticker with its exchange. The answer (201) is the row:

```json
{
  "id": "6af8fb3b-…", "workspaceId": null, "isin": null, "ticker": "WORLD1", "exchange": "XMIL",
  "name": "World equity ETF", "type": "fund", "currency": "EUR", "assetClass": null,
  "priceFactorE6": 1000000
}
```

| Error | Details |
| --- | --- |
| 409 `isin_taken` | the same ISIN on the same exchange (or the same ISIN with no exchange) is already there |
| 409 `ticker_taken` | the same ticker on the same exchange is already there, ignoring case |
| 400 `missing_instrument_identifier` | `{}`: neither ISIN nor ticker |
| 400 `missing_exchange` | `{ "ticker" }` |
| 400 `invalid_isin` | `{ "isin" }`: wrong shape or check digit |
| 400 `invalid_ticker`, `invalid_exchange` | `{ "ticker" }`, `{ "exchange" }` |
| 400 `invalid_instrument_type` | `{ "type" }` |
| 400 `invalid_currency` | `{ "currency" }` as sent: not an ISO 4217 code in use (`XYZ`, the withdrawn `VEF`) |
| 400 `invalid_instrument_field` | `{ "field" }` (a missing name, or a field that is not a string) or `{ "field", "maxLength" }` |
| 400 `invalid_price_factor` | `{ "label": "priceFactorE6", "value" }`: not a positive safe integer |

### Finding an instrument

`GET /instruments?q=WORLD1` — any signed-in user. A query that is a valid ISIN returns every listing
of that ISIN; anything else is a prefix of the ticker or the name, at least 2 characters, ignoring
case, an exact ticker first, then by name. At most 20 rows:
`{ "instruments": [ … ] }`. A shorter query is 400 `search_query_too_short`
`{ "minLength": 2 }`. There is no endpoint that lists the whole catalog.

`GET /instruments/:instrumentId` returns one row, or 404.

Every instrument row carries `workspaceId`: `null` for the shared catalog, the workspace's id for
a private instrument. The `/instruments` routes run with no workspace, so they find shared
instruments only: a private instrument is a 404 there, even for a member of its workspace, and a
search never returns one.

### Private instruments

An asset with no ISIN and no exchange ticker (real estate, a company pension fund, private
company shares) is a **private instrument**: it belongs to one workspace, which can trade it and
record its prices, and no other workspace can find it or point a trade or a price at it. Like a
shared instrument, it cannot be changed or removed through the API; it goes with its workspace
when the workspace is deleted.

| Request | Who | Answer |
| --- | --- | --- |
| `POST /workspaces/:workspaceId/instruments` | `owner`, `editor` | 201, the row |
| `GET /workspaces/:workspaceId/instruments` | any member | 200 `{ "instruments": [ … ] }`: the workspace's private instruments, by name; never the shared catalog |
| `GET /workspaces/:workspaceId/instruments/:instrumentId` | any member | 200, the row: a shared instrument or one of the workspace's own; 404 for another workspace's, an unknown or a malformed id |

```json
{ "name": "Flat in town", "type": "other", "currency": "EUR", "assetClass": "Real estate" }
```

The body takes `name`, `type`, `currency`, `assetClass` and `priceFactorE6`, with the same rules
and errors as [Adding an instrument](#adding-an-instrument). `isin`, `ticker` and `exchange` must be
left out (or `null`): any other value is 400 `invalid_instrument_field` `{ "field" }`. A name is
unique among the workspace's private instruments, ignoring case and the spaces around it: a second
one answers 409 `name_taken` and writes nothing. Another workspace's names, and the shared
catalog's, never conflict, so a private instrument may be named like a shared one. The answer:

```json
{
  "id": "0b6c1d52-…", "workspaceId": "4e1f…", "isin": null, "ticker": null, "exchange": null,
  "name": "Flat in town", "type": "other", "currency": "EUR", "assetClass": "Real estate",
  "priceFactorE6": 1000000
}
```

A trade names a private instrument by its `instrumentId` like any other; in another workspace the
same id is `unknown_instrument`.

## Prices

An instrument without automatic quotes (some government bonds, funds, a private instrument such as
real estate) gets its closing prices from the workspace itself: typed one date at a time, or
imported from a CSV file. Such a price is the workspace's own (`"origin": "own"`): no other
workspace sees it, and it never changes a shared price fetched from a provider (`"origin":
"shared"`), which every workspace reads. On a date with both, the workspace's own price is the one
that values the instrument ([ADR 0019](adr/0019-market-data-prices-rates-and-returns.md),
"Precedence"). Every path below starts with `/workspaces/:workspaceId/instruments/:instrumentId/prices`.

| Request | Who | Answer |
| --- | --- | --- |
| `GET …/prices?from=&to=` | any member | 200 `{ "prices": [ … ] }`: own and shared prices from `from` to `to`, both optional and included, by date, the shared one first on a date that has both; a `to` before `from` is 400 `invalid_date` with `{ "field": "to", "value" }`, as on `GET /fx-rates` |
| `PUT …/prices/:date` `{ "closeE6" }` | `owner`, `editor` | 201 with the price when the date had no own price; 200 when it replaced another close, or already had this one (then nothing is written) |
| `DELETE …/prices/:date` | `owner`, `editor` | 204; 404 `{ "error": "price not found" }` when the date has no own price, even if it has a shared one, which is never deleted |
| `POST …/prices/import?locale=` with a `text/csv` body | `owner`, `editor` | 200 `{ "inserted", "replaced", "unchanged", "from", "to" }`: how many dates were new, had another close, or already had this one, and the first and last date of the file |

A price object:

```json
{ "priceDate": "2026-03-31", "closeE6": 101500000, "source": "manual", "origin": "own" }
```

`closeE6` is the close as quoted × 10^6, like a trade's `priceE6`: a bond quoted in percent of its
nominal has its close in percent too. It is a safe integer, zero or more. `source` is `manual` for a
typed price, `csv` for an imported one and `provider` for a shared one. The instrument must be a
shared one or one of the workspace's private instruments: another workspace's private instrument,
an unknown or a malformed id answers 404 `{ "error": "instrument not found" }`, the same body as
every other route's missing row.

**The file.** Two columns, the date (`YYYY-MM-DD`) and the close, read in the locale given by
`?locale=` (`en`, a dot for decimals, when left out; a tag of at most 35 characters, with no
extension such as `-u-` and no private-use `-x-` part): a close with a comma, such as `"101,50"` in
`it-IT`, is quoted as in any CSV file. A first line reading `date,close` is a header and is skipped;
blank lines are skipped. The body is `content-type: text/csv`, at most 1 MiB and 20,000 rows, and an
import counts toward the per-user file import limit (`apps/api/README.md`, "Rate limits").

```csv
date,close
2026-03-30,101.25
2026-03-31,101.5
```

The file is stored whole or not at all. The first line that breaks a rule refuses it with 400
`{ "error": "invalid_price_file", "details": { "line", "column", "reason" } }`, the line counted
from 1 with the header and blank lines, the column 1 for the date and 2 for the close. `reason` is
one of `missing_column`, `extra_column`, `invalid_date` (not a real date, or a date after today,
then with `"max": "<today>"` in `details` too), `duplicate_date`
(a date an earlier line gave), `invalid_price_format`, `invalid_price` (negative, or beyond the safe
range) and `no_rows` (no price in the file). Importing the same file again answers every date as
`unchanged`. An imported price replaces the workspace's own price of the same date, typed or
imported, when its close differs.

**Dates.** A price is dated today or earlier in the workspace's time zone, with no lower limit: a
price from 1850 is accepted, and a price dated before an instrument's first buy values nothing. A
later date is 400 `invalid_date` with `{ "field": "date", "max": "<today>" }`; in a file, the
line's `reason` is `invalid_date` with `max`.

| Code | When |
| --- | --- |
| `invalid_date` | the date in the path (`{ "field": "date" }`) is not a real `YYYY-MM-DD` date, or is after today in the workspace's time zone (`{ "field": "date", "max" }`); `from` or `to` is not a real date (`{ "field", "value" }`) or is given twice (`{ "field" }`), or `to` is before `from` (`{ "field": "to", "value" }`) |
| `invalid_price` | `closeE6` is missing, not an integer, negative or beyond the safe range |
| `unknown_field`, `invalid_body` | a `PUT` body with another field than `closeE6`, or one that is not a JSON object |
| `invalid_price_file` | a line of the file breaks a rule (above) |
| `too_many_rows` | the file has more than 20,000 rows (`{ "max": 20000 }`) |
| `invalid_locale` | `?locale=` is not a locale tag, is longer than 35 characters, or has an extension or private-use part (`{ "value" }`) |

A body of another type than `text/csv` on the import answers 415. Each `PUT` or `DELETE` that
changes a price writes one entry in the workspace's audit log, and each import that changes any
price one summary entry. Prices are not synced from devices yet.

## Exchange rates

The euro reference rates the European Central Bank publishes every working day, shared by every
workspace like the catalog. The server fetches them by itself (see apps/api/README.md,
"Exchange rates"); the API only reads what is stored, and no request ever fetches anything.

`GET /fx-rates?quote=USD&from=2026-11-01&to=2026-11-30` — any signed-in user, member of a
workspace or not. `quote` is required; `from` and `to` are optional and both included. The rates of
that currency, oldest first, exactly as published:

```json
{
  "base": "EUR",
  "quote": "USD",
  "rates": [
    { "date": "2026-11-19", "rateE10": 10992000000 },
    { "date": "2026-11-20", "rateE10": 10990000000 }
  ]
}
```

`rateE10` is the units of `quote` for one euro × 10^10 (1.0990 dollars for one euro is
`10990000000`), never inverted ([ADR 0019](adr/0019-market-data-prices-rates-and-returns.md)). A
rate exists only for days the ECB publishes one: no weekends, no TARGET holidays. A currency with no
stored rate answers an empty list.

| Error | Details |
| --- | --- |
| 400 `invalid_currency` | `{ "currency" }`: missing, not a currency code in use (upper case), or `EUR` itself |
| 400 `invalid_date` | `{ "field", "value" }`: `from` or `to` not a `YYYY-MM-DD` calendar date, or `to` before `from` (`field` is `to`) |

## Portfolios

A portfolio is a group of holdings with its own purpose ("Long term", "Pension"). It declares no
accounts: every trade is filed under exactly one portfolio, so a portfolio spans whichever
accounts its trades are on, and one account can hold several portfolios.

| Request | Who | Body | Answer |
| --- | --- | --- | --- |
| `GET /workspaces/:workspaceId/portfolios` | any member | `?includeArchived=true` to include archived ones | 200 `{ "portfolios": [ … ] }`, by name |
| `GET …/portfolios/:portfolioId` | any member | — | 200 the portfolio, archived or not; 404 |
| `POST …/portfolios` | owner, editor | `{ "name": "Growth", "purpose": "Long term" }`; `purpose` optional | 201 the portfolio |
| `PATCH …/portfolios/:portfolioId` | owner, editor | any of `{ "name", "purpose", "archived" }` | 200 the portfolio |
| `DELETE …/portfolios/:portfolioId` | owner, editor | — | 204 |

```json
{
  "id": "bfef0c73-…", "workspaceId": "45fd02be-…", "name": "Growth", "purpose": "Long term",
  "archivedAt": null, "createdAt": "2026-11-20T20:33:01.825Z"
}
```

- `purpose` is free text; `null` or a blank string clears it.
- `archived: true` archives (keeping the first `archivedAt`), `false` unarchives. An archived
  portfolio keeps its trades and positions and is left out of the list unless asked for. It takes
  no new trades (400 `portfolio_archived`): no buy, sell, dividend, fee or tax, and no transfer
  into it. The trades it already has can still be edited and deleted, a transfer out of it is
  allowed so it can be emptied into another portfolio or account, and a split of an instrument it
  holds still writes its row there (a split is a fact about the instrument). Unarchive it to
  record trades in it again.
- Two non-archived portfolios of a workspace cannot share a name, ignoring case and surrounding
  spaces: 409 `name_taken`, on create, rename and unarchive. An archived one does not block its
  name.
- A portfolio with trades cannot be deleted: 409 `portfolio_has_trades`; archive it instead.
- A body with no name, or with nothing to change, is a plain 400.
- Any other key (`archive`, `archivedAt`, `id`, `workspaceId`) is 400 `unknown_field` with
  `{ "field" }`, on create and on `PATCH` alike, and nothing is written (#713).

## Trades

### The trade object

Every trade endpoint answers with trade objects. A buy of 20 units at €100.00 with a €5.00 fee:

```json
{
  "id": "6f1c1d2e-0000-4000-8000-000000000001",
  "workspaceId": "45fd02be-…",
  "accountId": "b199f4b9-…",
  "portfolioId": "bfef0c73-…",
  "instrumentId": "6af8fb3b-…",
  "type": "buy",
  "tradeDate": "2026-03-12",
  "occurredAt": null,
  "quantityE8": 2000000000,
  "priceE6": 100000000,
  "grossCents": 200000,
  "feesCents": 500,
  "transactionTaxCents": 0,
  "accruedInterestCents": 0,
  "withholdingForeignCents": 0,
  "withholdingDomesticCents": 0,
  "gainTaxCents": 0,
  "taxKind": null,
  "costBasisCents": null,
  "splitFrom": null,
  "splitTo": null,
  "transferTradeId": null,
  "memo": null,
  "createdAt": "2026-11-20T20:33:01.877Z",
  "cashCents": -200500,
  "cashTransactionId": "cf50e51b-…",
  "locked": false
}
```

| Field | Meaning |
| --- | --- |
| `tradeDate` | the trade date on the broker's statement; a split's is its ex-date; a dividend's or coupon's is its payment date, when the cash arrives |
| `occurredAt` | optional time of the trade; only orders trades within one date, and must fall on `tradeDate` in the workspace's time zone |
| `quantityE8`, `priceE6` | buy and sell: units and price, both positive (the type gives the direction). Transfer: the units moved, negative on the outgoing leg, positive on the incoming one. 0 on every other type |
| `grossCents` | buy and sell: the amount of the units; dividend: the gross income; tax: the tax amount |
| `feesCents` | the broker's fees; on a fee trade, the fee itself |
| `transactionTaxCents` | the financial transaction tax and similar, on a buy or a sell |
| `accruedInterestCents` | bonds only: the accrued interest paid on a buy or received on a sale |
| `withholdingForeignCents` | dividends only: tax withheld abroad |
| `withholdingDomesticCents` | Italian tax withheld, always entered positive: withheld on a dividend, a coupon or (on its accrued interest) a bond sale; credited back on a bond buy with accrued interest |
| `gainTaxCents` | sales only: the gain tax the broker withheld |
| `taxKind` | taxes only: `stamp_duty`, `managed_result_tax`, `gain_tax_adjustment`, `other` |
| `costBasisCents` | only on a transfer in from outside the app: the cost the units bring |
| `splitFrom`, `splitTo` | a split's ratio from:to; 1:4 means 1 unit becomes 4 |
| `transferTradeId` | the other leg of a transfer; null for a transfer from or to outside the app |
| `cashCents` | the cash the trade moves on its account, positive in, negative out ([Cash legs](#cash-legs)) |
| `cashTransactionId` | its cash leg, a transaction on the same account; null when it moves no cash |
| `locked` | true once the cash leg is reconciled: the trade can no longer be edited or deleted |

### Recording a trade

`POST /workspaces/:workspaceId/trades` — owner, editor. One request records one buy, sell,
dividend, fee or tax; or both legs of a transfer; or a split, entered once. The answer is 201
`{ "trades": [ … ] }`: one trade, two legs, or one row per holding the split covers, in the
[replay order](#the-replay-order).

Every request carries `type` and `tradeDate`, and optionally `occurredAt` and `memo`. A request
takes only its own fields, so nothing sent is ever dropped silently (#594):

- a field that no trade request has is 400 `unknown_field` with `{ "field" }` (`"fee"`, or
  `"from.fees"` inside a transfer's leg);
- a field of another kind of request is 400 `invalid_trade` naming it: `from` or `to` on a buy,
  `accountId`, `portfolioId`, `id` or `taxKind` at the top of a transfer or a split, `quantityE8`
  on a split or a dividend, `gainTaxCents` on a buy, `grossCents` on a fee. The table below lists
  what each type takes. `null` reads as left out, so a field of another kind sent as `null` is not
  refused. `taxKind` on anything but a tax keeps its own code,
  `tax_kind_not_allowed_for_trade_type`;
- a field of the wrong JSON type (a string for an amount, an id that is not a UUID, a `type` or
  `taxKind` that is none of the listed ones, a leg that is not an object) is 400 `invalid_field`
  with `{ "field" }`;
- a body that is not a JSON object is 400 `invalid_body`;
- a required field left out (or `null`) is 400 `invalid_trade` naming it (#600).

An optional amount left out is 0.

**Buy, sell, dividend, fee, tax.** `accountId` (a brokerage account) and `portfolioId` are
required; `id` is an optional client-generated UUID; `occurredAt`, `memo` and `taxKind` are taken
by every one. Then, by type:

| Type | Required | Optional | Rules |
| --- | --- | --- | --- |
| `buy` | `instrumentId`, `quantityE8` > 0, `priceE6` > 0 | `grossCents`, `feesCents`, `transactionTaxCents`, `accruedInterestCents`, `withholdingDomesticCents` | `grossCents` defaults to quantity × price × price factor, rounded once half away from zero; send the broker's figure when it differs. Accrued interest only on a `bond` or `government_bond`; a domestic withholding only with accrued interest, and not above it |
| `sell` | `instrumentId`, `quantityE8` > 0, `priceE6` ≥ 0 | as a buy, plus `gainTaxCents` | the portfolio must hold the units on that date. A price of 0 closes a worthless position: the gross is 0 and the whole cost removed is a realized loss |
| `dividend` (a coupon too) | `instrumentId`, `grossCents` > 0 | `feesCents`, `withholdingForeignCents`, `withholdingDomesticCents` | the two withholdings together not above the gross |
| `fee` | `feesCents` > 0 | `instrumentId` | without an instrument, a fee on the whole account (custody) |
| `tax` | `taxKind`, `grossCents` > 0 | `instrumentId` | a `gain_tax_adjustment`'s `grossCents` is signed and not 0: positive is a refund, negative extra tax |

A buy at a price of 0 is refused (`invalid_trade`, `field: "priceE6"`), and so is a dividend of 0
(`field: "grossCents"`). Shares received for free are a transfer in from outside the app at their
tax cost; bonus shares (one free share for every ten held) are a split of 10:11
([domain guide](domain-guide.md#what-each-trade-needs)).

**Transfer of securities.** Units move between two portfolios of one account, between two
accounts, or into or out of the app. No `accountId` or `portfolioId` at the top: each leg carries
its own.

```json
{
  "type": "transfer",
  "instrumentId": "6af8fb3b-…",
  "tradeDate": "2026-04-20",
  "quantityE8": 500000000,
  "from": { "accountId": "b199f4b9-…", "portfolioId": "<Income>", "feesCents": 150 },
  "to":   { "accountId": "b199f4b9-…", "portfolioId": "<Growth>" }
}
```

- `quantityE8` is the units moved, positive; the outgoing leg is stored negative.
- A leg is `{ accountId, portfolioId, id?, feesCents? }`. `from` and `to` together are two
  linked rows; `to` alone is a transfer in from outside the app and needs `costBasisCents`, the
  cost the units bring; `from` alone is a transfer out of the app.
- Between two portfolios of one account only the quantity moves: the account's cost and average
  do not change. Between two accounts the outgoing leg takes its share of the source account's
  cost with it, and the incoming leg adds exactly that cost; no gain is realized either way.
- A leg's fees are a cost of their own, never part of the cost basis. Each leg with fees has its
  own cash leg on its own account.
- Both accounts must be in the instrument's currency (no exchange rates yet).

**Split.** Entered once, with no account or portfolio:

```json
{ "type": "split", "instrumentId": "6af8fb3b-…", "tradeDate": "2026-04-10", "splitFrom": 1, "splitTo": 2 }
```

The API writes one split row for every portfolio, in every account of the workspace, that holds
the instrument at the start of that date (after every trade of earlier dates). Each holding's
quantity is multiplied by `splitTo ÷ splitFrom`, rounded toward zero to 8 decimals; the cost does
not change, so the average cost is divided by the ratio. A reverse split is written the other way
round (10:1 means 10 units become 1). A split moves no cash. A trade recorded later that would
make another portfolio hold the instrument on the split's date without a split row of its own is
refused (`split_missing_for_portfolio`), so where a split is involved, record the trades before it
first.

### What is checked, in order

Nothing is written until every check has passed:

1. the body's shape: `invalid_body`, `unknown_field`, a field of another kind of request
   (`invalid_trade`), a wrong JSON type (`invalid_field`), the length of `memo`
   (`text_too_long`);
2. the fields the type requires (`invalid_trade` naming the first one missing);
3. the quantity: a safe integer (`invalid_quantity`) above 0 (`invalid_trade` with
   `field: "quantity"` on a buy or a sale, `"quantityE8"` on a transfer);
4. the price of a buy or a sale: a safe integer not below 0 (`invalid_price`), and above 0 on a
   buy (`invalid_trade`, `field: "priceE6"`); a dividend's gross not 0 and a split's ratio two
   positive integers (`invalid_trade` naming the field);
5. the instrument exists (`unknown_instrument`), and the gross of a buy or a sale sent without
   one is computed from quantity × price;
6. the rows the request stands for are built: a transfer's legs, or a split's rows for the
   holdings on its date (`split_without_holdings`); a client-generated id is not taken (409
   `id_taken`);
7. each account exists in the workspace and is a brokerage account, the instrument is in its
   currency, each portfolio exists and, unless the row is a split row, a transfer's outgoing leg
   or a row already stored there, is not archived (`portfolio_archived`);
8. the trade's amounts: signs (`negative_amount_not_allowed`) and caps (`amount_too_large`), a tax
   kind only on a tax, accrued interest only on a bond, withholdings not above what they are
   withheld from;
9. `occurredAt` falls on `tradeDate` in the workspace's time zone;
10. in an `IT` workspace, the account's tax regime on the trade date
    ([domain guide](domain-guide.md#tax-regimes-of-a-brokerage-account));
11. the workspace's whole history of the instrument, every account and portfolio, is replayed with
    the new rows: no portfolio may hold a negative quantity at any date, every split must cover
    every holding, a transfer's legs must match, no position's quantity may leave the safe range.

So the first error names the field actually wrong (#662): a buy with a negative quantity is
`invalid_trade` with `field: "quantity"`, not a refusal of the negative gross computed from it.

Step 11 runs under a lock on the workspace's history of that instrument, so two concurrent
requests can never each pass on their own and together oversell.

### Validation codes

All 400 `{ "error": "<code>", "details": { … } }` unless marked 409.

| Code | Details | When |
| --- | --- | --- |
| `invalid_body` | `{}` | the body is not a JSON object (an array, a string, a number, `null`); on an edit, also a body that changes nothing |
| `unknown_field` | `{ "field" }` | a field no trade request has, or `id` on an edit; `"from.fees"` inside a leg |
| `invalid_field` | `{ "field" }` | a field of the wrong JSON type or value: an amount that is not a number, an id or a filter that is not a UUID, a `type` or `taxKind` that is none of the listed ones, a leg that is not an object |
| `unknown_account` | `{ "accountId" }` | not an account of this workspace |
| `account_not_brokerage` | `{ "accountId", "accountType" }` | trades go on brokerage accounts only |
| `unknown_portfolio` | `{ "portfolioId" }` | not a portfolio of this workspace |
| `portfolio_archived` | `{ "portfolioId" }` | the portfolio is archived and takes no new trades: a buy, sell, dividend, fee or tax filed under it, a transfer into it, or an edit that moves a trade or a transfer's leg into it. A transfer out of it and a split's rows are allowed. Unarchive it first |
| `unknown_instrument` | `{ "instrumentId" }` | not in the catalog |
| `currency_mismatch` | `{ "accountId", "accountCurrency", "instrumentCurrency" }` | the instrument is quoted in another currency than the account's |
| `negative_amount_not_allowed` | `{ "field" }` | an amount or cost below zero |
| `tax_kind_not_allowed_for_trade_type` | `{ "type", "taxKind" }` | `taxKind` on anything but a tax |
| `accrued_interest_not_allowed` | `{ "instrumentType" }` (`""` without an instrument) | accrued interest on an instrument that is not a bond |
| `withholding_exceeds_gross` | `{ "field", "withheld", "gross" }` | a dividend's withholdings above its gross (`field: "withholding"`), or a bond trade's domestic withholding above its accrued interest (`field: "withholdingDomesticCents"`) |
| `invalid_trade` | `{ "field" }`, or `{ "tradeId", "field" }` | a trade that breaks its type's shape: a required field missing, a field of another kind of request or one the type does not use, a quantity of 0 or less, a buy's price of 0, a dividend of 0, a fee or a tax of 0, a split ratio that is not two positive integers, an `occurredAt` not on the trade date, a transfer in with no `costBasisCents` (or a cost on any other leg), a transfer between the same holding, two legs that do not match |
| `tax_regime_required` | `{ "accountId" }` | an `IT` workspace, and the account has no regime yet; a new trade only, an edit of a trade there is not checked |
| `tax_kind_not_allowed_in_regime` | `{ "regime", "field" }`, plus `taxKind` for a tax | gain tax, an adjustment or a managed result tax the regime on that date does not allow |
| `domestic_withholding_requires_agent` | `{ "field": "withholdingDomesticCents" }` | a domestic withholding on a bond trade's accrued interest at a broker that is not an Italian withholding agent |
| `insufficient_quantity` | `{ "tradeId", "accountId", "portfolioId", "instrumentId", "date", "available", "requested" }`, quantities × 10^8 | the portfolio would hold less than zero at that trade |
| `split_without_holdings` | `{ "instrumentId", "date" }` | no portfolio holds the instrument at the start of the split's date |
| `split_missing_for_portfolio` | `{ "accountId", "instrumentId", "date", "portfolioId" }` | a portfolio holds the instrument on a split's date without a split row |
| `split_duplicate`, `split_ratio_mismatch` | `{ "accountId", "instrumentId", "date" }`, plus `portfolioId` for a duplicate | two split rows for one portfolio and date, or two ratios for one instrument and date |
| `split_leaves_no_quantity` | `{ "accountId", "instrumentId", "date" }` | the split rounds a whole position with a cost down to zero units |
| `invalid_date` | `{ "value" }` | `tradeDate` is not a real date |
| `invalid_amount`, `invalid_quantity`, `invalid_price` | `{ "label", "value" }` | not a safe integer (a decimal number, or too large); a negative price |
| `invalid_quantity` | `{ "label": "positionQuantity", "value", "tradeId", "accountId", "portfolioId" }` | a position's quantity, a portfolio's or an account's, would leave the safe range (about 90 million units) at `tradeId`: the buy, the split row of that holding or the incoming leg of a transfer that pushes it over (#662). `accountId` and `portfolioId` name the position, since a request that adds several rows (a split's rows, a transfer's legs) names each of them `null` |
| `amount_too_large` | `{ "label", "max", "value" }` | an amount, a cost or the cash leg they add up to above 10^12 minor units (€10,000,000,000.00; ADR 0002, #651); `label` is the field, or `cash`. An edit checks the whole trade, so a memo-only edit of a trade stored above the cap before #651 is refused too |
| 422 `amount_total_overflow` | `{ "label", "tradeId" }` | a running total of a position (`label`: `costBasisCents`, or the total, such as `standaloneFeesCents`) would leave the safe range of minor units while replaying `tradeId`; only trades stored before the cap can do it (ADR 0002, #651). The positions of the account or portfolio answer it too |
| 409 `id_taken` | `{ "tradeId" }` | the client-generated id is already used, in this workspace or any other |

`invalid_trade`'s `details.field` is usually a field of the request (`feesCents`, `grossCents`,
`costBasisCents`, `occurredAt`, …), but some checks report the core's own name instead:
`quantity` for a buy's or a sale's `quantityE8` (a transfer's is `quantityE8`), `price` for a
`priceE6` on a trade that takes none, `date` for `tradeDate`, and `currency`,
`priceFactor` and `transferTradeId`, which are not request fields at all (the account's or the
instrument's currency and price factor, the link between a transfer's legs). A client that shows
the field to the user maps both kinds of name.

The `insufficient_quantity` details name the trade where the holding would go negative, which is
not always the one being recorded: a backdated sale, or an edit or deletion of an earlier buy,
makes a *later* trade oversell, and that later trade is the one named.

**`details.tradeId` always names a stored trade, or is `null`** (#662). It is `null` when the trade
at fault is one the request itself adds: the trade being recorded (with or without a
client-generated `id`), either leg of a new transfer, a split's new row. The id the server would
have given it names no trade, so it is never shown. An edit names the trade being edited by its own
id, since it is stored; a split edit that adds a row for a new holding names that row `null`.
The one exception is 409 `id_taken`, whose `details.tradeId` echoes the client id the request
itself sent, so the client can find the trade an earlier attempt recorded.

```json
{
  "error": "insufficient_quantity",
  "details": {
    "tradeId": "c77477af-…", "accountId": "b199f4b9-…", "portfolioId": "133dfde9-…",
    "instrumentId": "6af8fb3b-…", "date": "2026-03-20", "available": 0, "requested": 500000000
  }
}
```

### Listing trades

`GET /workspaces/:workspaceId/trades` — any member. Optional filters `?portfolioId=`,
`?accountId=`, `?instrumentId=` (UUIDs, else 400 `invalid_field` naming the filter), combined with AND. The answer is
`{ "trades": [ … ] }` in the replay order.

### The replay order

Positions come from replaying trades in one fixed order, so the same trades always give the same
result to the cent (ADR 0011):

1. `tradeDate`;
2. on the same date, split rows first: a split applies at the start of its ex-date, so a sale of
   the new units that day comes after it;
3. `occurredAt`, to the millisecond; a trade with no time counts as the start of its date in the
   workspace's time zone (local midnight; the moment the clocks jump where a daylight saving
   change skips midnight; the first midnight where the clocks go back across it and midnight
   comes twice), so it comes before every timed trade of that date (#596). Some older trades
   recorded without a time carry the time they were sorted at until now, so their order and every
   amount stay as shown (migration 0038);
4. `createdAt`, when the trade was recorded;
5. `id`.

The order matters because the cost each sale removes is rounded: with a cost of €1.01 on 4 units,
selling 1 and then 1 removes €0.25 + €0.25, selling 2 at once removes €0.51. A trade recorded
later with an earlier date takes its place in the order, and everything after it is worked out
again.

### Cash legs

A trade that moves money owns exactly one transaction on its own account, its **cash leg**
([ADR 0012](adr/0012-trade-cash-legs.md)), written in the same database transaction:

| Type | `cashCents` |
| --- | --- |
| buy | −(gross + fees + transaction tax + accrued interest − domestic withholding) |
| sell | gross + accrued interest − fees − transaction tax − gain tax − domestic withholding |
| dividend or coupon | gross − fees − foreign withholding − domestic withholding |
| fee | −fees |
| tax | −gross; a `gain_tax_adjustment`: +gross (a refund is positive, extra tax negative) |
| transfer | −fees of the leg; no cash leg without fees |
| split | none |

- The leg has one split with no category, is dated on the trade date (midnight in the
  workspace's time zone), and starts `pending`. Mark it `cleared` when it appears on the broker's
  statement, usually two business days after the trade (settlement); a statement dated before
  then does not show it yet.
- It appears in `GET …/accounts/:accountId/transactions` like any transaction, with `tradeId`
  set and `trade`, a summary of its trade: `type`, `quantityE8`, and `instrumentId`,
  `instrumentName` and `instrumentTicker` (all null for an account-wide fee or tax), so a client
  can name the row after its trade without reading the trades and instruments (#657). Its payee, memo and status are its own and are edited there. Its amount, account and date
  belong to the trade: `PATCH` with `splits`, `amountCents` or an `occurredAt` other than the
  leg's own date, or `DELETE`, answers 409 `trade_owned_transaction`. `accountId` is not a field
  of that `PATCH` for any transaction: it answers 400 `unknown_field`. The `PATCH` takes
  `occurredAt` as a date only (`YYYY-MM-DD`), while creating a transaction also takes a date with
  a time; a date with a time in a `PATCH` answers 400 `invalid_date`.
- A brokerage account's balance is the transfers into and out of it plus its cash legs. Since the
  account is off budget, a trade never changes the budget. A transaction recorded by hand on it
  (not a transfer) takes no category either: a split with a `categoryId` answers 400
  `category_not_allowed` with `details.field` `categoryId`, on create, on an edit with `splits`
  and on an import row (#710). The money reached the broker through a
  transfer from an on-budget account, which asked for a category
  ([domain guide](domain-guide.md#the-cash-a-trade-moves)).
- Money taken back out of the broker goes through `POST /workspaces/:workspaceId/transfers` too.
  To an on-budget cash account without `categoryId`, its on-budget leg lands as Unassigned, income
  to assign in the month of its date; with `categoryId` it goes into that category. To an on-budget
  credit card a category is required: without one, 400 `card_income_not_supported` with
  `details.accountId` ([domain guide](domain-guide.md#money-moved-to-an-off-budget-account)).
- Once a cash leg is reconciled, its trade is `locked`: editing or deleting it answers 409
  `reconciled` until the reconciliation is unlocked
  (`POST /workspaces/:workspaceId/transactions/:transactionId/unlock-reconciliation`). The rows
  edited together lock together: if either leg of a transfer has a reconciled cash leg, neither
  can be edited or deleted.

### Editing a trade

`PATCH /workspaces/:workspaceId/trades/:tradeId` — owner, editor. A field left out keeps its
value; `null` clears `occurredAt`, `memo` and, on a fee or a tax, `instrumentId`. The type of a
trade never changes: delete it and record another.

| The trade is | The edit may carry |
| --- | --- |
| a buy, sell, dividend, fee or tax | any field its type's create request takes but `id` (the table in [Recording a trade](#recording-a-trade)) |
| a transfer leg | `instrumentId`, `tradeDate`, `occurredAt`, `memo`, `quantityE8` (the units moved, positive), and `from` / `to` with any of `{ accountId, portfolioId, feesCents, costBasisCents }` for the legs it has |
| a split row | `tradeDate`, `occurredAt`, `memo`, `splitFrom`, `splitTo` |

- **Groups move together.** A transfer's two legs, and every row of a split (the instrument's
  split rows on that date, in every account), are edited through any one of their ids. An edited
  split works out again which holdings it covers on its new date; a holding it already covered
  keeps its row's id.
- **The gross of a buy or a sell.** An edit that changes `quantityE8`, `priceE6` or `instrumentId`
  without `grossCents` computes the gross again from them, as a create does: send the broker's
  figure again with the edit to keep it.
- **The price and the gross only when they change.** The quantity, the price and a dividend's
  gross are checked again (steps 3 and 4) only when the edit changes the quantity, the price or
  the gross. A buy recorded at a price of 0, or a dividend of 0, before #600 refused them keeps
  taking every other edit (its memo, its date); an edit that changes one of those three must give
  it a price above 0, or a gross.
- **The history is checked again.** The edited rows go through every check of a create, and the
  whole history of every instrument the edit touches (the old one and the new one) is replayed;
  an edit that would make any portfolio oversell, at any date, is refused.
- **The tax regime only when something it reads changes.** In an `IT` workspace an edited row is
  checked against the regime again (step 10) only when its date, account, instrument, tax kind, gain
  tax, transaction tax, either withholding or, on a tax, its amount changes. An edit of the memo,
  the time, the quantity, the price or the portfolio alone skips that check, so a trade recorded
  before its account's regime history changed keeps taking those edits. While an account has no
  regime yet (a trade recorded before the workspace's tax country became `IT`), an edit of its
  trades is not checked against the regime at all, a split's or a transfer's included: the
  account's first regime checks every trade, so a trade no regime would accept can be fixed by an
  edit before the regime is recorded.
- **Archived portfolios.** A trade already in an archived portfolio can still be edited there, or
  moved out of it. Moving a trade or a transfer's leg (either one) into an archived portfolio is
  `portfolio_archived`. A split moved to another date covers the holdings on that date, archived
  portfolios included.
- **The cash leg is rewritten in place.** It keeps its id, payee and memo; it is created when the
  trade starts moving cash and deleted when it stops. A `cleared` leg whose amount, account or
  date changes goes back to `pending`, since it no longer matches the statement it was ticked
  against.
- The answer is 200 `{ "trades": [ … ] }`, every row of the group as written.

| Error | When |
| --- | --- |
| 400 `invalid_body` | not a JSON object; or an edit that changes nothing: `{}`, only `null` legs, or the trade's own `type` alone (checked after the 409s below, #596) |
| 400 `unknown_field`, `invalid_field` `{ "field" }` | as on create; `id` is `unknown_field`. Unlike create, a field of another kind with the wrong JSON type (`gainTaxCents: "5"` on a buy) is `invalid_field`, not `invalid_trade`: the body is read before the trade's type is known (to be made uniform in #663) |
| 400 `invalid_trade` `{ "field" }` | a field the trade's type does not take (`field` names it: `from` on a buy, `accountId` on a transfer, `instrumentId` on a split, `grossCents` on a fee), a different `type`, alone or with other fields (`field: "type"`, #596), `instrumentId: null` on a trade that needs one, `from` or `to` on a transfer without that leg |
| 400, the create codes | the edited trade breaks a rule, or the history no longer replays |
| 404 | no trade of this workspace has this id |
| 409 `account_closed` | a row of the group is on a closed account, or the edit moves one to a closed account |
| 409 `reconciled` | a cash leg of the group is reconciled |
| 409 `concurrent_change` | another request moved the trade to another instrument meanwhile; nothing was written, retry |

The closed account and the reconciled cash leg are checked before anything else, `type` included:
an edit sending only `type`, the trade's own or another, answers 409 `account_closed` or
`reconciled` on such a trade, never `invalid_body` or `invalid_trade`.

### Deleting a trade

`DELETE /workspaces/:workspaceId/trades/:tradeId` — owner, editor. Deletes the trade with every
row of its group (both legs of a transfer, every row of a split) and their cash legs; 204. The
instrument's history is replayed without them first: deleting a buy that a later sale or transfer
depends on is refused with `insufficient_quantity`, naming that later trade. 404 and 409
`reconciled` as for an edit. Every create, edit and delete is recorded in the audit log
(`trade.create`, `trade.update`, `trade.delete`) with the rows before and after.

### Retries and client ids

There is no idempotency key. A trade (and each leg of a transfer, as `from.id` and `to.id`) may
carry an `id` generated on the device, a UUID. If a request's answer is lost and it is sent again
with the same id, the second one answers 409 `id_taken` with `details.tradeId` and writes nothing:
the first one was recorded, and `GET …/trades` shows it. (An id another workspace already uses
answers the same 409, revealing nothing else about that trade, so ids must be fresh random UUIDs.)
Without a client id the server makes one up, and a second send of the same request records a
second trade. Split rows always get ids from the server.

## Positions

| Request | Who | Answer |
| --- | --- | --- |
| `GET /workspaces/:workspaceId/portfolios/:portfolioId/positions` | any member | the portfolio's positions, an archived portfolio included |
| `GET /workspaces/:workspaceId/accounts/:accountId/positions` | any member | the account's positions, across its portfolios |

Positions are worked out from the trades on every request, never stored. They are **as of a
date**, by default today in the workspace's time zone, the same day every balance is as of
(#702, #719): only trades dated on or before it are replayed. Trades dated after today are left
out of positions and cost basis, and are still listed by `GET …/trades`, so a sale recorded
ahead, dated next year, leaves today's quantity, cost and totals as they are, as the brokerage
account's cash leaves out its proceeds until that day. `?asOf=YYYY-MM-DD` asks for another date, past or future;
a malformed one is 400 `invalid_date`. Both answer:

```json
{ "asOf": "2026-11-21", "positions": [ { … }, … ], "summaries": [ { … }, … ] }
```

- **`asOf`**: the date the positions are as of.
- **`positions`**: one row per account and instrument the portfolio (or account) has a trade of
  dated on or before `asOf`, sorted by account then instrument id. A position sold out stays,
  with quantity 0, for its totals. Trades dated after `asOf` are still listed by
  `GET …/trades`.
- **`summaries`**: one row per currency, the totals of every position plus the fees and taxes
  recorded without an instrument. Amounts in different currencies are never added together.

A position row:

| Field | Meaning |
| --- | --- |
| `accountId`, `instrument` | the account, and the instrument's row (`workspaceId` set for a private instrument) |
| `currency` | the account's currency; every amount in the row is in it |
| `quantityE8` | units held: the portfolio's own, or the account's |
| `costBasisCents` | the cost of the units held. For a portfolio, its share of the account's cost |
| `accountAverageCostE6` | the account's average cost per unit, as a price × 10^6 in the instrument's quoting (a bond in percent of nominal); null when nothing is held. For display only |
| the 18 totals below, then `incomeCents`, `costsCents`, `taxesOnGainsCents` | |

A summary has `currency`, `costBasisCents` and the same totals.

### Weighted average cost, per account and instrument

The cost method is the weighted average cost, and the average belongs to the **account**: every
portfolio holding the instrument in that account shares one average. Portfolios split the
account's quantity, not its cost.

- A buy adds `gross + fees` to the account's cost `C`; the transaction tax and accrued interest
  are not part of it.
- A sale removes `C × sold ÷ held`, rounded half away from zero to the minor unit (selling
  everything removes exactly what is left). Its realized gain is `gross − fees − cost removed`,
  and belongs to the portfolio the sale is filed under. Gain tax, transaction tax and withholdings
  are not part of it.
- A portfolio's `costBasisCents` is `C × its quantity ÷ the account's quantity`, rounded so the
  portfolios' shares add up to `C` exactly. Never divide it by the portfolio's quantity: show
  `accountAverageCostE6`. Because the average is shared, a portfolio's share moves when another
  portfolio of the same account buys or sells.
- Every portfolio's figures are worked out from the workspace's whole history of each instrument,
  every account and portfolio included, since a transfer between accounts carries cost from one to
  the other.

The [domain guide](domain-guide.md#positions-and-cost-basis) has the full rules, with worked
examples.

### Totals

Each in the account's minor unit, counting the trades of the portfolio (or account) itself:

| Total | What it adds up |
| --- | --- |
| `realizedCents` | gains (positive) and losses of sales: economic, not taxable |
| `costInCents` | cost that came in: buys (gross + fees), and transfers in from another account or from outside the app. A transfer between two portfolios of the same account adds nothing |
| `costSoldCents` | cost removed by sales |
| `costTransferredOutCents` | cost carried out by transfers to another account or out of the app |
| `tradeFeesCents` | fees of buys and sells: already inside the cost and the gain, shown for information |
| `incomeFeesCents` | fees of dividends and coupons |
| `transferFeesCents` | fees of transfers of securities |
| `transactionTaxCents` | transaction taxes of buys and sells |
| `accruedInterestPaidCents` | accrued interest paid on bond buys |
| `accruedInterestReceivedCents` | accrued interest received on bond sales |
| `gainTaxWithheldCents` | gain tax withheld on sales, as on each sale |
| `gainTaxAdjustmentsCents` | gain tax adjustments, signed as entered: a refund positive, extra tax negative |
| `managedResultTaxCents` | tax on the result of a managed account |
| `incomeGrossCents` | dividends and coupons, gross |
| `withholdingForeignCents` | foreign withholding on dividends |
| `withholdingDomesticCents` | domestic withholding, net: withheld on dividends, coupons and bond sales, minus what was credited back on bond buys; can be negative |
| `standaloneFeesCents` | fee trades |
| `standaloneTaxesCents` | tax trades of kind `stamp_duty` and `other` |

### Income, costs and taxes on gains

Three results are worked out from the totals (`derivedResults` in `packages/core`):

- **`incomeCents`** = income gross − foreign withholding − domestic withholding − income fees +
  accrued interest received − accrued interest paid.
- **`costsCents`** = transaction tax + transfer fees + standalone fees + standalone taxes. Trade
  fees are not added again: they are already inside the cost and the gain.
- **`taxesOnGainsCents`** = gain tax withheld − gain tax adjustments + managed result tax.

**Withheld tax versus adjustments.** The gain tax the broker withheld on each sale and the
corrections it made later are two separate totals, so each can be compared with the broker's own
tax statement. An adjustment is kept with its sign: a €100.00 refund (`grossCents: 10000`, cash
+€100.00) lowers the taxes on gains, and €30.00 of extra tax charged (`grossCents: -3000`, cash
−€30.00) raises them. With €247.26 withheld on a sale and a €100.00 refund later:
`gainTaxWithheldCents` 24726, `gainTaxAdjustmentsCents` 10000, `taxesOnGainsCents` 14726.

The **net result** (realized + unrealized + income − costs − taxes on gains) of a position needs
its price, and is not on the positions yet; the [performance](#performance) gives the portfolio's
gain month by month. For an account whose securities all came in through buys, the
figures already add up: realized + income − costs − taxes on gains = (cash balance + cost) − money
transferred in.

## Performance

| Request | Who | Answer |
| --- | --- | --- |
| `GET /workspaces/:workspaceId/portfolios/:portfolioId/performance?from=YYYY-MM&to=YYYY-MM` | any member | the portfolio's figures for each month from `from` to `to`, both included, and over the whole range; an archived portfolio included |

A portfolio's value, money put in, income, gain and returns, month by month, in the workspace's
base currency. They are computed from the trades, the stored [prices](#prices) and the stored
[exchange rates](#exchange-rates) on every request, never stored and never cached; a request never
fetches a price or a rate. The rules are the domain guide's
([Flows, valuation and returns](domain-guide.md#flows-valuation-and-returns)); every figure is after
the costs and taxes the trades record.

```json
{
  "baseCurrency": "EUR",
  "from": "2026-09",
  "to": "2026-10",
  "months": [
    {
      "month": "2026-09",
      "valuationDate": "2026-09-30",
      "valueCents": 102000,
      "netContributionsCents": 100500,
      "incomeCents": 0,
      "gainCents": 1500,
      "twrE6": 14925,
      "mwrE6": 14925,
      "twrUnknownReason": null,
      "mwrUnknownReason": null,
      "oldestPriceDate": "2026-09-30",
      "oldestRateDate": null,
      "missing": []
    },
    { "month": "2026-10", "…": "…" }
  ],
  "totals": {
    "startDate": "2026-08-31",
    "endDate": "2026-10-31",
    "startValueCents": 0,
    "endValueCents": 206000,
    "netContributionsCents": 200500,
    "incomeCents": 0,
    "gainCents": 5500,
    "twrE6": 35023,
    "twrAnnualized": false,
    "mwrE6": 36416,
    "mwrAnnualized": false,
    "twrUnknownReason": null,
    "mwrUnknownReason": null,
    "missing": []
  }
}
```

A month:

| Field | Meaning |
| --- | --- |
| `valuationDate` | the date the month is valued at: its last day, or today in the workspace's time zone for the current month |
| `valueCents` | the value of the securities the portfolio holds at the end of `valuationDate`: each position's quantity × its latest price on or before that date × price factor, rounded once in the instrument's currency, then the amounts of each currency added up and converted once at that date's rate. The cash of the trades belongs to the brokerage account and is not part of it. A position sold out needs no price |
| `netContributionsCents` | money put into the portfolio (+) or taken out (−) in the month, dividends and coupons apart: a buy counts everything it cost (gross, fees, transaction tax, accrued interest, less domestic withholding credited), a sale its net proceeds, a fee or a tax its amount, a transfer of securities their market value on its date (never their cost) plus its fees. The amounts of one date and one currency are added up, contributions and income apart, then converted once at that date's rate |
| `incomeCents` | the net cash of the month's dividends and coupons, as a positive amount, converted the same way |
| `gainCents` | `valueCents` − the previous month's value − `netContributionsCents` + `incomeCents`, exact to the cent |
| `twrE6` | the month's time-weighted return, in millionths (`14925` is 1.4925%): how the holdings did, whatever money was added or taken out, cut at the end of every day with a trade |
| `mwrE6` | the month's money-weighted return, in millionths: how the household's own money did, given when it went in and out |
| `twrUnknownReason`, `mwrUnknownReason` | why `twrE6` or `mwrE6` is null, and null when it is known: `missing_value` when a value or a flow it needs is unknown (see `missing`); `no_capital` when there is nothing to measure (the portfolio was worth nothing at the end of every day the period is valued on: its start, each day with a flow, each month end and its end, as in a month with only a fee or a dividend after everything was sold; or a stretch ends with more taken out than it held); `no_solution` (money-weighted only) when no rate from just above −100% to +1000% balances the flows |
| `oldestPriceDate`, `oldestRateDate` | the oldest price and the oldest exchange rate `valueCents` used: prices and rates have no maximum age, so a screen can show how old they are. Null when none was needed, or when the value is unknown |
| `missing` | what an unknown figure lacks, each once: `{ "instrumentId", "reason": "no_price", "date" }` for a security held (or transferred) with no price on or before the date, `{ "instrumentId", "reason": "no_rate", "currency", "date" }` for an amount whose currency (or the base currency) has no rate on or before it. `date` is the earliest date, among those the figure needed (the start of the month, each trade date, the valuation date), that lacks it: a price or a rate dated on or before it fills the gap. `instrumentId` is null for a fee or tax recorded without an instrument |

**Unknown is null, never 0.** A held position with no price, or a currency with no rate, makes
the value null, never a sum of the rest, and every figure that needs it null too (the gain, the
returns, the next month's gain); `missing` says what to add. A return is also null when there is
nothing to measure: a month in which the portfolio held nothing, or one that ends with more taken
out than it held. A month before the first trade is worth 0, with returns null.

**The totals** run from the end of the month before `from` (`startDate`, `startValueCents`) to
the end of the last month (`endDate`, `endValueCents`): the contributions, income and gain over
the whole range, from the start value, the end value and every flow in between; equal to the sum
of the months' figures whenever every month's figure is known. The two returns over the whole
range are each computed in one go from the same values and flows, never by linking the rounded
monthly figures; `twrUnknownReason` and `mwrUnknownReason` say why one is null, as for a month. A range that reaches a year
(`startDate` to `endDate`) gives yearly returns (`twrAnnualized`, `mwrAnnualized` true); a shorter
one gives the return over the range itself. Both flags are null when their return is.

A return is displayed by rounding `…E6` to 0.01 percentage points, half to even. Prices in the
workspace's own and shared rows follow the [precedence](#prices): on the same date, the
workspace's own price wins.

| Error | When |
| --- | --- |
| 404 `{ "error": "portfolio not found" }` | another workspace's portfolio, an unknown or a malformed id, the same body as every other portfolio route |
| 400 `invalid_month` | `{ "field", "value" }`: `from` or `to` missing (`value` null), not a `YYYY-MM` month or given twice; `to` before `from` (`field` is `to`, as on `GET /fx-rates` and the prices list); `to` after the current month in the workspace's time zone (with `"max": "<current month>"`) |
| 400 `range_too_long` | `{ "months", "max": 120 }`: the range covers more than 120 months |

## A worked example

A household in an `IT` workspace funds an administered brokerage account from its budget and
records two portfolios. These are the steps and figures of the milestone's smoke test
(`apps/api/src/smoke/0.2.0-portfolio.smoke.test.ts`), which checks every number below against the
real server (it also spends from a second category, left out here, so its own budget figures
differ from step 6's). Paths are relative to `/workspaces/:workspaceId`, except `/instruments`.
Followed in this order on an empty workspace, such as a disposable environment's, every request
answers as shown.

**1. The workspace, the accounts and the money.**

| Request | Body |
| --- | --- |
| `PATCH` (the workspace itself) | `{ "taxCountry": "IT" }` |
| `POST /accounts` | `{ "name": "Checking", "type": "checking", "currency": "EUR" }` |
| `POST /accounts` | `{ "name": "Broker", "type": "brokerage", "currency": "EUR", "taxRegime": "administered", "taxRegimeValidFrom": "2026-01-01", "domesticWithholdingAgent": true }` |
| `POST /category-groups` | `{ "name": "Goals" }` |
| `POST /categories` | `{ "name": "Investments", "groupId": "<goals>" }` |
| `POST /accounts/<checking>/transactions` | `{ "occurredAt": "2026-03-02", "splits": [ { "categoryId": null, "amountCents": 4000000 } ] }`: €40,000.00 of income |
| `POST /assignments` | `{ "entries": [ { "month": "2026-03", "sourceCategoryId": null, "destinationCategoryId": "<investments>", "amountCents": 3000000 } ] }`: €30,000.00 from Unassigned to "Investments" |
| `POST /transfers` | `{ "sourceAccountId": "<checking>", "destinationAccountId": "<broker>", "occurredAt": "2026-03-10", "amountCents": 3000000, "categoryId": "<investments>" }` |

Each `POST` answers 201 with the new row, whose `id` the later steps use. The transfer answers
`{ "source": { … }, "destination": { … } }`, its two transactions: `destination.id` is the
deposit on the broker, which step 7 reconciles.

The transfer goes from an on-budget account to an off-budget one, so it needs `categoryId`
(without one, 400 `uncategorized_transaction`): it is €30,000.00 of spending from "Investments",
whose available drops to 0, and nothing else in the budget moves. The other way, a transfer from
the broker to the checking account may leave `categoryId` out: it then lands as Unassigned in the
month of its date (into an on-budget credit card a category is required, 400
`card_income_not_supported`). This walkthrough does not move money back.

**2. Instruments.** `POST /instruments` three times: an ETF (`type: "fund"`), a share
(`"stock"`), and a government bond quoted in percent of nominal (`"government_bond"`,
`priceFactorE6: 10000`), all in EUR, each with a ticker and exchange of its own (or an ISIN), for
example `{ "ticker": "BTP31", "exchange": "XMIL", "name": "Treasury bond 2031", "type":
"government_bond", "currency": "EUR", "priceFactorE6": 10000 }`. The catalog is shared, so on a
server where those tickers are taken, pick others (409 `ticker_taken`).

**3. Portfolios.** `POST /portfolios` `{ "name": "Growth" }` and
`{ "name": "Income", "purpose": "Coupons and dividends" }`.

**4. Trades**, each `POST /trades` with `"accountId": "<broker>"`:

| Trade | Body (besides `accountId`, `portfolioId` and, for buys and sales, `"type"` and `instrumentId` as in "Recording a trade") | `cashCents` | Arithmetic |
| --- | --- | --- | --- |
| Growth buys 20 ETF | `type: "buy"`, `tradeDate: "2026-03-12"`, `quantityE8: 2000000000`, `priceE6: 100000000`, `feesCents: 500` | −200500 | gross 20 × 100.00 = 2,000.00, + 5.00 fee |
| Income buys 30 ETF | `"2026-03-13"`, 30 at 120.00, fee 5.00 | −360500 | the account holds 50 for 2,005.00 + 3,605.00 = €5,610.00 |
| Growth buys 100 shares | `"2026-03-16"`, 100 at 50.00, fee 5.00 | −500500 | corrected below |
| Income buys 10 shares by mistake | `"2026-03-17"`, 10 at 55.00 | −55000 | deleted below |
| Growth sells 10 ETF | `type: "sell"`, `"2026-03-20"`, 10 at 130.00, `feesCents: 500`, `gainTaxCents: 4498` | +125002 | cost removed 5,610.00 × 10 ÷ 50 = 1,122.00; gain 1,300.00 − 5.00 − 1,122.00 = 173.00; 26% of it is 44.98; cash 1,300.00 − 5.00 − 44.98 |
| Correct the share buy | `PATCH /trades/<id>` `{ "quantityE8": 8000000000, "feesCents": 400 }` | −400400 | gross computed again: 80 × 50.00 = 4,000.00, + 4.00 |
| Delete the mistake | `DELETE /trades/<id>` | — | 204; its cash leg goes with it |
| Dividend on Growth's shares | `type: "dividend"`, `"2026-04-01"`, `grossCents: 4000`, `withholdingForeignCents: 600`, `withholdingDomesticCents: 884`, `feesCents: 100` | +2416 | 26% domestic on the 34.00 left after foreign tax is 8.84; 40.00 − 6.00 − 8.84 − 1.00 |
| ETF split 1:2 | `{ "type": "split", "instrumentId": "<etf>", "tradeDate": "2026-04-10", "splitFrom": 1, "splitTo": 2 }` | 0, 0 | two rows with `quantityE8: 0` in the answer; the positions (step 5) show Growth 10 → 20, Income 30 → 60; cost still 4,488.00, now on 80 units |
| Bond buy on Income | `"2026-04-15"`, `quantityE8: 1000000000000` (10,000 nominal), `priceE6: 99500000`, `feesCents: 200`, `accruedInterestCents: 4000`, `withholdingDomesticCents: 500` | −998700 | gross 10,000 × 99.50 × 0.01 = 9,950.00; 12.5% of the 40.00 accrued interest credited back; −(9,950.00 + 2.00 + 40.00 − 5.00) |
| Income moves 5 ETF to Growth | transfer, `"2026-04-20"`, `quantityE8: 500000000`, `from` Income with `feesCents: 150`, `to` Growth | −150 (from), 0 (to); the answer lists the to leg first | same account: Growth 25, Income 55, cost and average unchanged |
| Custody fee on Growth | `type: "fee"`, `"2026-04-30"`, `feesCents: 350`, no instrument | −350 | |

**5. Positions.** `GET /portfolios/<growth>/positions`:

| Position | `quantityE8` | `costBasisCents` | `accountAverageCostE6` | Other totals |
| --- | --- | --- | --- | --- |
| ETF | 2500000000 | 140250 | 56100000 | `realizedCents` 17300, `costInCents` 200500, `costSoldCents` 112200, `tradeFeesCents` 1000, `gainTaxWithheldCents` 4498, `taxesOnGainsCents` 4498 |
| Shares | 8000000000 | 400400 | 50050000 | `costInCents` 400400, `tradeFeesCents` 400, `incomeGrossCents` 4000, `withholdingForeignCents` 600, `withholdingDomesticCents` 884, `incomeFeesCents` 100, `incomeCents` 2416 |

Growth's ETF cost is its share of the account's: 4,488.00 × 25 ÷ 80 = €1,402.50, and Income's
4,488.00 × 55 ÷ 80 = €3,085.50; together €4,488.00. The average, €56.10, is the account's:
4,488.00 ÷ 80. Growth's summary adds the custody fee: `standaloneFeesCents` 350, `costsCents` 350.

Income's bond: `costBasisCents` 995200, `accountAverageCostE6` 99520000 (99.52 percent of
nominal), `accruedInterestPaidCents` 4000, `withholdingDomesticCents` −500, so `incomeCents`
0 − (−5.00) − 40.00 = −€35.00 until a coupon or a sale brings interest back.

The account's summary (`GET /accounts/<broker>/positions`): cost 4,488.00 + 4,004.00 + 9,952.00 =
€18,444.00; realized €173.00; income 24.16 − 35.00 = −€10.84; costs 1.50 + 3.50 = €5.00; taxes on
gains €44.98.

**6. The cash adds up.** The broker's balance is the deposit plus every cash leg:
30,000.00 − 2,005.00 − 3,605.00 − 4,004.00 + 1,250.02 + 24.16 − 9,987.00 − 1.50 − 3.50 =
€11,668.18. And realized + income − costs − taxes on gains = 173.00 − 10.84 − 5.00 − 44.98 =
€112.18 = 11,668.18 + 18,444.00 − 30,000.00. The balance is the sum of the splits' `amountCents`
of every transaction in `GET /accounts/<broker>/transactions`.

The budget months are exactly what they were before the first trade: `GET /budget-months/2026-03`
and `GET /budget-months/2026-04` (the full path is
`GET /workspaces/:workspaceId/budget-months/:month`) answer the same body as they did right after
the transfer. In March `unassigned` is 1000000 (40,000.00 − 30,000.00), and "Investments" has
`assigned` 3000000, `activity` −3000000 and `available` 0; April starts with the same 1000000
unassigned and nothing in "Investments".

**7. Reconciling locks.** The broker's statement of 12 March shows the deposit and Growth's first
buy: 30,000.00 − 2,005.00 = €27,995.00.

| Request | Body | Answer |
| --- | --- | --- |
| `PATCH /accounts/<broker>/transactions/<deposit>` | `{ "status": "cleared" }` | 200 |
| `PATCH /accounts/<broker>/transactions/<buy's cashTransactionId>` | `{ "status": "cleared" }` | 200 |
| `POST /accounts/<broker>/reconciliations` | `{ "date": "2026-03-12", "statementBalanceCents": 2799500, "tickedTransactionIds": [ "<deposit>", "<buy's cashTransactionId>" ] }` | 201 `{ "outcome": "reconciled", "reconciliation": { … } }` |
| `GET /trades` | | the ETF buy of 12 March, alone, has `locked: true` |
| `PATCH /trades/<buy>` | `{ "feesCents": 0 }` | 409 `{ "error": "a trade whose cash leg is reconciled cannot be edited; unlock it first", "code": "reconciled" }` |
| `DELETE /trades/<buy>` | | 409, the same `code` |

`<deposit>` is the transfer's `destination.id` from step 1; the buy's `cashTransactionId` is in
its row in the answer to `POST /trades`. Positions do not change.

Mind the two error shapes ([Before you start](#before-you-start)): a 409 carries its code in
`code`, next to English text in `error`, while a 400 carries the code in `error` itself (the
`uncategorized_transaction` of step 1 is `{ "error": "uncategorized_transaction", "details": {} }`).
