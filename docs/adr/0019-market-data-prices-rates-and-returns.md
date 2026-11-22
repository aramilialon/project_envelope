# 0019 — Market data: prices, exchange rates and returns

- **Status:** accepted
- **Date:** 2026-11-22

## Context

Milestone 0.2.1 adds historical prices, exchange rates and returns (design.md, "Portfolio module" and "Market data"). Three questions cut across its issues (#82–#89, #505):

- **Who owns a price.** A price fetched from a provider is public data, the same for every workspace, like an instrument. A price typed by a user, or imported from a CSV, is that workspace's own data: it may value a private instrument (#505), or disagree with the shared quote, and it must never reach another workspace. Jobs connect as `envelope_app` (ADR 0006); there is no separate role for them.
- **How a rate is stored.** ADR 0011 left exchange rates to this milestone with one constraint: at least 10 significant digits, one stated direction, never inverted. ADR 0002 requires every amount in minor units, rounded by a stated rule.
- **What a return is.** Time-weighted and money-weighted returns are ratios, not amounts: computing them needs powers and roots, and their result is never added to money.

## Decision

- **Prices.** One table, `prices`: instrument, date, close (`close_e6`, the same quoting and price factor as a trade's `price_e6`), source. `workspace_id` is null for a shared provider price and set for a manual or CSV price; a check ties the two (`source = 'provider'` exactly when `workspace_id` is null). One row per workspace (or shared), instrument and date. A price is input data, not a derived value: it is edited in place, and every value computed from it is rebuilt on read (ADR 0008's rule is about derived totals, which stay unstored).
- **Isolation of prices.** Row-Level Security with one policy per command: every role reads shared rows and its own workspace's rows; it inserts, updates and deletes only its own workspace's rows, and shared rows only inside a system job (`app_is_system_job()`, ADR 0010). A single `USING` clause is not enough: it would let a request update or delete shared rows. A trigger refuses a price whose instrument the caller cannot see, since a foreign key check ignores Row-Level Security, and a shared price on a workspace's private instrument.
- **Precedence.** For an instrument and a date, the price is the one with the latest date on or before it; on the same date, the workspace's own price wins over the shared one. The rule is in `@envelope/core` (`resolvePrice`), which receives both kinds of candidates; SQL only loads them. No price on or before the date means the value is unknown, never zero.
- **Exchange rates.** `fx_rates` holds rates as published by the ECB: `rate_e10`, the units of the quote currency for one euro, × 10^10, within the safe-integer range; a value beyond it is refused, never rounded. A rate is never stored inverted. Another currency pair is computed through the euro, in `BigInt`, rounded once to the target currency's minor unit: amount_B = amount_A × r_B × 10^dB ÷ (r_A × 10^dA). A value is converted from quantity × price × price factor × rates with a single rounding. The euro converts to itself, and any currency to itself, without a rate. The rate used is the most recent one on or before the date, with no maximum age: the date of the rate used is returned with every converted value; with no rate on or before the date, the value is unknown. Every role can read `fx_rates`; only a system job writes it.
- **Writes by system jobs.** ADR 0010's `app_is_system_job()` also gates writes to shared market data. It is set only inside the job handlers listed in a test, which fails if any other file sets it.
- **Providers.** A provider implements one interface (`fetchPrices`, `fetchFxRates`) and writes only shared rows, through a queue job (`enqueue`/`schedule`/`work`, a deduplication key, `processed_jobs`, a double-delivery test). Screens and endpoints read only what is stored and never call a provider during a request. The first adapters are `manual`, which fetches nothing, and the ECB rates.
- **Outbound requests.** One instance-wide setting, `MARKET_DATA_FETCH_ENABLED`, turns off every outbound request; it defaults to on (maintainer decision, 2026-11-22). With it off, rates can be loaded from a downloaded file with an administration command. Tests never reach the network: the fetcher is injected and fed from fixtures. The ECB file is parsed by the core without an XML dependency, and refused as a whole when any entry is malformed.
- **Returns.** `@envelope/core` computes them in floating point over generic inputs: valuations (each known or unknown) and external flows (signed amounts with dates). Which trades and transactions are external flows is a separate core function, so its definition can change without touching the return functions. A return is output as an integer in millionths (`returnE6`), rounded half away from zero once, or as unknown with a reason (`missing_value`, `no_capital`, `no_solution`). Returns are never stored and never used to compute an amount; tests compare them to hand-checked references with a tolerance of one millionth, since `Math.pow` and `Math.log` may differ between JavaScript engines.

## Alternatives considered

- **Prices shared only, no Row-Level Security** (the issue's first sketch). A manual price for a private instrument, or one correcting a quote, would be visible to every workspace.
- **Two tables, shared and workspace prices.** Equivalent isolation, but every reader would union them, and the precedence would be split across two queries.
- **A separate database role for jobs that write shared data.** It needs its own login, pool and credentials for a narrow benefit; a session flag already scopes the one other bypass (ADR 0010), and the allowlist test keeps it grep-able.
- **`numeric` rates, or rates as floats.** The same reasons as ADR 0011: silent rounding on insert, strings in node-postgres, and inexact products.
- **Storing both directions of a rate, or inverted rates.** An inverted rate is rounded; ADR 0011 rules it out.
- **Returns as decimal strings, or as scaled integers computed in `BigInt`.** Strings need parsing everywhere; exact rational arithmetic cannot compute a root (XIRR) and adds nothing to a ratio that is only displayed.

## Consequences

- A workspace never sees another workspace's prices, and no request can change a shared price or rate.
- An all-euro workspace needs no rates at all; a workspace with other currencies shows values as unknown, with the reason, until rates exist (fetching off and no file imported, or a currency the ECB does not publish).
- A new provider is an adapter and a job; screens do not change. A provider that needs a user's key, or a licence, takes its own decision about where the key is kept.
- A table added later that holds shared market data follows the same pattern: a read policy for everyone, write policies for system jobs only, and its job on the allowlist.
- Prices are not a sync entity yet. When they become one, their entity id must be derived from (workspace, instrument, date), so two devices that enter the same day converge.
