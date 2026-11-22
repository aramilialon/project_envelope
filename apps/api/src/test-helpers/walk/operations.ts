/**
 * The random walk's operation set (ADR 0013): every write the walk can make, each as
 * - `generate`: the parameters of one such operation, chosen from the model with the seeded
 *   generator, referring to entities by handle (undefined when it cannot happen yet, say a sale
 *   with nothing held);
 * - `request`: the HTTP request it is, with the handles resolved to the workspace's ids;
 * - `predict`: what the API must answer, for the cheap rules only (a read-only member, another
 *   workspace's id, a sale of more than is held, a reconciled leg, a trade's cash leg changed
 *   on its own, the tax regime rules of an `IT` workspace, the close rule); anything else is
 *   `any`: accepted, or refused with a code from the allowlist and nothing changed;
 * - `writes`: the accounts whose rows the request would write. A closed one turns the
 *   prediction into 409 `account_closed` (ADR 0018, `predictOperation`), so every operation, a
 *   new one included, is tried against a closed account as soon as the walk has closed one;
 * - `accept`: what an accepted answer adds to the model, and what it touched (for the checks).
 *
 * Personas are weight profiles over this one set (`PROFILES`). A new route joins the walk by
 * adding an operation here and a weight in the profiles that would use it (apps/api/README.md).
 */
import {
  amountOf,
  checkRegimeChange,
  checkTradeRegime,
  computePositions,
  isValidationError,
  PRICE_FACTOR_ONE,
  TAX_REGIMES,
  toPriceFactor,
  validateAccountTaxSettings,
  validatePositionHistory,
  validateTaxRegimeChange,
  validateWithholdingAgentChange,
  type PortfolioPosition,
  type PositionTrade,
  type Price,
  type Quantity,
  type TaxRegime,
  type TaxRegimeEntry,
} from "@envelope/core";

import type { HttpMethod } from "./driver.ts";
import { expectEcho, instantEcho } from "./invariants.ts";
import { localMidnight, type WalkRandom } from "./generator.ts";
import {
  amountOf as transactionAmount,
  sortableHandle,
  sortRegimes,
  type AccountEntity,
  type AccountType,
  type Persona,
  type TradeJson,
  type TransactionEntity,
  type TransactionJson,
  type WorkspaceModel,
} from "./model.ts";

/** One step of the walk, as the operation log stores it: plain JSON, entities by handle. */
export interface Op {
  readonly kind: OpKind;
  readonly ws: Persona;
  /** Who sends it: a member of `ws`, or the owner of another persona's workspace (refused). */
  readonly actor: "owner" | "editor" | "read_only" | `intruder:${Persona}`;
  readonly params: Params;
}

export type Params = Readonly<Record<string, unknown>>;

export type Prediction =
  | { readonly kind: "accept" }
  /** `details`, when given, must be part of the refusal's `details`, field by field. */
  | { readonly kind: "refuse"; readonly status: number; readonly code?: string; readonly details?: Readonly<Record<string, unknown>> }
  /** `alsoAllowed`: codes this one request may be refused with besides the allowlist's. */
  | { readonly kind: "any"; readonly alsoAllowed?: readonly string[] }
  /** A sync upload is answered 201 with one outcome per change: a refused change has its own. */
  | { readonly kind: "syncOutcome"; readonly outcome: string };

export interface Touched {
  /** Account handles whose transactions (and, for a brokerage account, positions) to check. */
  readonly accounts: Set<string>;
  /** Portfolio handles whose positions to check. */
  readonly portfolios: Set<string>;
  readonly budget: boolean;
  /** Account handles whose tax regime history to read back and compare with the model. */
  readonly regimes: Set<string>;
  /** Entities the step created, for the isolation probe. */
  readonly created: { readonly kind: "account" | "portfolio" | "transaction" | "trade"; readonly id: string }[];
}

export interface WalkRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly body?: unknown;
}

export interface GenerateContext {
  readonly random: WalkRandom;
  /** Where the walk is in its run, [0, 1]: dates follow it through the window. */
  readonly progress: number;
  readonly models: ReadonlyMap<Persona, WorkspaceModel>;
}

interface OperationSpec<P extends Params> {
  /** A trade: in the mixed household, every budget month must be the same before and after it. */
  readonly trade?: boolean;
  /**
   * The accounts, by handle, whose rows the request would write: the rows it adds, edits or
   * deletes, a transfer's other leg when the request writes it too, the account a trade moves to.
   * Required of every operation, so that none leaves out the closed-account guard (ADR 0018,
   * #735); one that writes no account's rows (a portfolio, a tax regime history, which ADR 0018
   * leaves writable, the close itself) answers none.
   */
  writes(model: WorkspaceModel, params: P, models: ReadonlyMap<Persona, WorkspaceModel>): readonly (string | undefined)[];
  /**
   * Whether the API refuses a closed account before any rule `predict` knows (`checkAccountsOpen`,
   * #741, #655). Otherwise a closed account turns only an `ACCEPT` or `ANY` into `account_closed`:
   * the rules `predict` refuses with come first (a card's income, a missing category, a reconciled
   * or trade-owned row, a sync change's own outcome), and the database's trigger after them.
   */
  readonly closedFirst?: boolean;
  generate(model: WorkspaceModel, ctx: GenerateContext): P | undefined;
  request(model: WorkspaceModel, params: P, models: ReadonlyMap<Persona, WorkspaceModel>): WalkRequest;
  predict(model: WorkspaceModel, params: P, models: ReadonlyMap<Persona, WorkspaceModel>): Prediction;
  accept(model: WorkspaceModel, params: P, body: unknown): Touched;
}

const ACCEPT: Prediction = { kind: "accept" };
const ANY: Prediction = { kind: "any" };
/** A write to a closed account (#729, ADR 0018). */
const ACCOUNT_CLOSED: Prediction = { kind: "refuse", status: 409, code: "account_closed" };
/** The transactions API's reconciled lock answers a bare 409 without a `code`. */
const RECONCILED_TRANSACTION: Prediction = { kind: "refuse", status: 409 };
const TRADE_OWNED: Prediction = { kind: "refuse", status: 409, code: "trade_owned_transaction" };
/** Income on an on-budget credit card, which `@envelope/core` does not model yet (#548). */
const CARD_INCOME: Prediction = { kind: "refuse", status: 400, code: "card_income_not_supported" };
/** Money leaving the budget for an off-budget account without a category (#378). */
const UNCATEGORIZED: Prediction = { kind: "refuse", status: 400, code: "uncategorized_transaction" };

/**
 * The codes an `any` refusal may carry: the rules the walk does not predict but can run into
 * with valid-looking data (a backdated sale, a split that rounds a holding to nothing). Anything
 * else is a failure.
 */
export const REFUSAL_ALLOWLIST: ReadonlySet<string> = new Set([
  "insufficient_quantity",
  "split_missing_for_portfolio",
  "split_ratio_mismatch",
  "split_duplicate",
  "split_leaves_no_quantity",
  "split_without_holdings",
  "invalid_trade",
  "withholding_exceeds_gross",
  "reconciled",
  // An edit of a trade in the `IT` workspace (`ANY`) that moves it to a date or an account whose
  // regime, or broker, does not allow its taxes (#508, #653). A new trade, a regime change and a
  // new account are predicted exactly instead, with these codes and the others of the regime rules.
  "tax_kind_not_allowed_in_regime",
  "domestic_withholding_requires_agent",
]);

/**
 * Operations left out because of a bug the walk found in the API and that is not fixed yet. Each
 * entry names its finding; delete the entry with the fix, and the walk covers the case again.
 * `WALK_INCLUDE_EXCLUDED=1` puts them all back, to reproduce or check a fix. None today: the
 * walk's first two findings (#547, #548) are fixed, and their logs are in `regressions/`.
 */
export const EXCLUSIONS: Readonly<Record<string, string>> = {};

function excluded(name: string): boolean {
  return process.env.WALK_INCLUDE_EXCLUDED !== "1" && name in EXCLUSIONS;
}

function touched(
  partial: Partial<{ accounts: Iterable<string>; portfolios: Iterable<string>; budget: boolean; regimes: Iterable<string>; created: Touched["created"] }>,
): Touched {
  return {
    accounts: new Set(partial.accounts ?? []),
    portfolios: new Set(partial.portfolios ?? []),
    budget: partial.budget ?? false,
    regimes: new Set(partial.regimes ?? []),
    created: partial.created ?? [],
  };
}

/** For an operation that writes no account's rows. */
const NONE = (): readonly string[] => [];

/** The refusal a `ValidationError` of `@envelope/core` thrown by `check` stands for (400 and its code), or `ACCEPT`. */
function predictCore(check: () => void): Prediction {
  try {
    check();
    return ACCEPT;
  } catch (error) {
    if (isValidationError(error)) return { kind: "refuse", status: 400, code: error.code };
    throw error;
  }
}

function ws(model: WorkspaceModel, suffix: string): string {
  return `/workspaces/${model.workspaceId}${suffix}`;
}

function payee(random: WalkRandom): string | undefined {
  return random.chance(0.6) ? random.pick(["Grocery store", "Landlord", "Pharmacy", "Employer", "Broker", "Bakery", "Café"]) : undefined;
}

function nonLeg(model: WorkspaceModel): TransactionEntity[] {
  return [...model.transactions.values()].filter((entity) => entity.record.tradeId === null);
}

function legs(model: WorkspaceModel): TransactionEntity[] {
  return [...model.transactions.values()].filter((entity) => entity.record.tradeId !== null);
}

/** Whether deleting this transaction is refused as reconciled: it or its transfer partner is. */
function reconciledPair(model: WorkspaceModel, entity: TransactionEntity): boolean {
  return entity.record.status === "reconciled" || model.transferPartner(entity)?.record.status === "reconciled";
}

function accountsTouchedBy(model: WorkspaceModel, entities: readonly (TransactionEntity | undefined)[]): string[] {
  return entities.filter((e): e is TransactionEntity => e !== undefined).map((e) => model.accountById(e.record.accountId).handle);
}

// --- Accounts, categories, portfolios ---------------------------------------------------------

const ACCOUNT_LIMITS: Readonly<Record<Persona, Partial<Record<AccountType, number>>>> = {
  household: { checking: 2, savings: 1, cash: 1, credit_card: 2 },
  investor: { brokerage: 3 },
  mixed: { checking: 2, savings: 1, credit_card: 1, brokerage: 2 },
};

/** The tax country whose regime rules the walk exercises (#508, #676): the investor's workspace has it. */
export const WALK_TAX_COUNTRY = "IT";

/** A brokerage account's tax settings in the `IT` workspace: each one left out now and then, which is refused. */
type AccountTaxParams = { taxRegime?: TaxRegime; taxRegimeValidFrom?: string; domesticWithholdingAgent?: boolean };

type CreateAccountParams = { type: AccountType; onBudget: boolean; name: string } & AccountTaxParams;
const createAccount: OperationSpec<CreateAccountParams> = {
  writes: NONE,
  generate(model, { random, progress }) {
    const limits = ACCOUNT_LIMITS[model.persona];
    const open = (Object.keys(limits) as AccountType[]).filter(
      (type) => [...model.accounts.values()].filter((a) => a.type === type).length < (limits[type] ?? 0),
    );
    if (open.length === 0) return undefined;
    const type = random.pick(open);
    // A savings account is on budget or not (a deposit kept apart); the rest take their default.
    const onBudget = type === "brokerage" ? false : type === "savings" ? random.chance(0.5) : true;
    const params = { type, onBudget, name: `${type} ${model.accounts.size + 1}` };
    if (type !== "brokerage" || model.taxCountry !== WALK_TAX_COUNTRY) return params;
    // In the `IT` workspace a brokerage account needs both settings (`tax_regime_required`), and an
    // administered or managed regime a broker that withholds (`tax_regime_requires_withholding_agent`).
    const omit = random.chance(0.15) ? random.pick(["taxRegime", "domesticWithholdingAgent"] as const) : undefined;
    const taxRegime = random.pick(TAX_REGIMES);
    const domesticWithholdingAgent = random.chance(0.7);
    return {
      ...params,
      ...(omit === "taxRegime" ? {} : { taxRegime, taxRegimeValidFrom: random.date(progress) }),
      ...(omit === "domesticWithholdingAgent" ? {} : { domesticWithholdingAgent }),
    };
  },
  request: (model, p) => ({
    method: "POST",
    path: ws(model, "/accounts"),
    body: {
      name: p.name,
      type: p.type,
      currency: "EUR",
      onBudget: p.onBudget,
      ...(p.taxRegime === undefined ? {} : { taxRegime: p.taxRegime }),
      ...(p.taxRegimeValidFrom === undefined ? {} : { taxRegimeValidFrom: p.taxRegimeValidFrom }),
      ...(p.domesticWithholdingAgent === undefined ? {} : { domesticWithholdingAgent: p.domesticWithholdingAgent }),
    },
  }),
  // The account's first regime is checked as a change from no history (`addTaxRegime`): with no
  // trades yet, the history's own rules are all there is to it.
  predict: (model, p) =>
    predictCore(() => {
      validateAccountTaxSettings({ accountType: p.type, taxCountry: model.taxCountry, taxRegime: p.taxRegime, domesticWithholdingAgent: p.domesticWithholdingAgent });
      if (p.taxRegime !== undefined) {
        validateTaxRegimeChange({
          taxCountry: model.taxCountry,
          domesticWithholdingAgent: p.domesticWithholdingAgent ?? null,
          history: [{ validFrom: p.taxRegimeValidFrom!, regime: p.taxRegime }],
        });
      }
    }),
  accept(model, p, body) {
    const record = body as Parameters<WorkspaceModel["addAccount"]>[0] & { name: string; closedAt: string | null };
    expectEcho("createAccount", [
      ["name", p.name, record.name],
      ["type", p.type, record.type],
      ["currency", "EUR", record.currency],
      ["onBudget", p.onBudget, record.onBudget],
      ["domesticWithholdingAgent", p.domesticWithholdingAgent ?? null, record.domesticWithholdingAgent],
      ["closedAt", null, record.closedAt],
    ]);
    const regimes = p.taxRegime === undefined ? [] : [{ validFrom: p.taxRegimeValidFrom!, regime: p.taxRegime }];
    const account = model.addAccount(record, regimes);
    return touched({ accounts: [account.handle], budget: true, regimes: [account.handle], created: [{ kind: "account", id: account.id }] });
  },
};

/** At most this many closed accounts per workspace, so that most of what the walk writes still lands. */
const MAX_CLOSED_ACCOUNTS = 2;

type CloseAccountParams = { account: string };

/**
 * Closes an account (#703, #729): accepted only when it is empty today, else 409
 * `account_not_empty` with the figures the rule read; an account already closed is not found.
 * Weighted high but generated mostly when an account is empty (a new one, or one `sweepAccount`
 * emptied), so it closes before another step writes to it again and the walk goes on to write to
 * it (`writes`, ADR 0018). Never the last open on-budget cash account or brokerage account, so
 * the walk can still budget and trade.
 */
const closeAccount: OperationSpec<CloseAccountParams> = {
  writes: NONE,
  generate(model, { random }) {
    const closed = model.closedAccounts();
    if (closed.length > 0 && random.chance(0.05)) return { account: random.pick(closed).handle };
    if (closed.length >= MAX_CLOSED_ACCOUNTS) return undefined;
    const open = model.openAccounts();
    const cashLike = (account: AccountEntity): boolean => account.onBudget && account.type !== "credit_card";
    const candidates = open.filter(
      (account) =>
        (account.type !== "brokerage" || open.some((other) => other !== account && other.type === "brokerage")) &&
        (!cashLike(account) || open.some((other) => other !== account && cashLike(other))),
    );
    const empty = candidates.filter((account) => {
      const rule = model.closeRule(account);
      return rule.balanceCents === 0 && !rule.holdsPositions;
    });
    if (empty.length > 0) return { account: random.pick(empty).handle };
    // Now and then an account that is not empty: refused, with the figures.
    return candidates.length > 0 && random.chance(0.15) ? { account: random.pick(candidates).handle } : undefined;
  },
  request: (model, p) => ({ method: "PATCH", path: ws(model, `/accounts/${model.account(p.account).id}/close`) }),
  predict(model, p) {
    const account = model.account(p.account);
    if (account.closed) return { kind: "refuse", status: 404 };
    const { balanceCents, holdsPositions } = model.closeRule(account);
    if (balanceCents === 0 && !holdsPositions) return ACCEPT;
    return {
      kind: "refuse",
      status: 409,
      code: "account_not_empty",
      details: {
        balanceCents,
        holdsPositions,
        laterRows: { count: 0, firstDate: null },
        scheduled: { count: 0, scheduledTransactionId: null, nextDueDate: null },
      },
    };
  },
  accept(model, p, body) {
    const account = model.account(p.account);
    const record = body as { id: string; closedAt: string | null };
    expectEcho("closeAccount", [
      ["id", account.id, record.id],
      ["closed", true, typeof record.closedAt === "string"],
    ]);
    account.closed = true;
    return touched({ accounts: [account.handle], budget: account.onBudget });
  },
};

// --- Tax regimes (#508, #653) ------------------------------------------------------------------

/** An account to change the regime of: mostly a brokerage account, now and then one that takes none. */
function regimeAccount(model: WorkspaceModel, random: WalkRandom): AccountEntity | undefined {
  const accounts = [...model.accounts.values()];
  if (accounts.length === 0) return undefined;
  const brokers = model.brokerageAccounts();
  return brokers.length > 0 && random.chance(0.9) ? random.pick(brokers) : random.pick(accounts);
}

/** A 1 January a change can start on, in the window or the year after it. */
function yearStart(random: WalkRandom): string {
  return random.pick(["2025-01-01", "2026-01-01", "2027-01-01"]);
}

/**
 * What the API answers a change of `account`'s history to `after` (`addTaxRegime`,
 * `replaceTaxRegimes`): only a brokerage account takes one; then the history's own rules and the
 * flag they need (`validateTaxRegimeChange`), then every trade the change covers
 * (`checkRegimeChange`, `tax_regime_conflicts_with_trade`), as `@envelope/core` judges them.
 */
function predictRegimeChange(model: WorkspaceModel, account: AccountEntity, after: readonly TaxRegimeEntry[]): Prediction {
  if (account.type !== "brokerage") return { kind: "refuse", status: 400, code: "tax_regime_not_applicable" };
  return predictCore(() => {
    validateTaxRegimeChange({ taxCountry: model.taxCountry, domesticWithholdingAgent: account.domesticWithholdingAgent, history: after });
    checkRegimeChange(model.regimeCheckedTrades(account), {
      before: account.taxRegimes,
      after,
      domesticWithholdingAgent: account.domesticWithholdingAgent,
    });
  });
}

type AddTaxRegimeParams = { account: string; regime: TaxRegime; validFrom: string };

/**
 * A new period in a brokerage account's history: mostly from a 1 January, now and then from
 * another day (refused unless it is the earliest) or from a day that already starts one.
 */
const addTaxRegime: OperationSpec<AddTaxRegimeParams> = {
  writes: NONE,
  generate(model, { random, progress }) {
    const account = regimeAccount(model, random);
    if (!account) return undefined;
    const roll = random.float();
    const existing = account.taxRegimes.map((entry) => entry.validFrom);
    const validFrom = roll < 0.75 ? yearStart(random) : roll < 0.9 || existing.length === 0 ? random.date(progress) : random.pick(existing);
    return { account: account.handle, regime: random.pick(TAX_REGIMES), validFrom };
  },
  request: (model, p) => ({
    method: "POST",
    path: ws(model, `/accounts/${model.account(p.account).id}/tax-regimes`),
    body: { regime: p.regime, validFrom: p.validFrom },
  }),
  predict(model, p) {
    const account = model.account(p.account);
    return predictRegimeChange(model, account, [...account.taxRegimes, { validFrom: p.validFrom, regime: p.regime }]);
  },
  accept(model, p, body) {
    const entry = body as TaxRegimeEntry;
    expectEcho("the added tax regime", [
      ["validFrom", p.validFrom, entry.validFrom],
      ["regime", p.regime, entry.regime],
    ]);
    const account = model.account(p.account);
    account.taxRegimes = sortRegimes([...account.taxRegimes, entry]);
    return touched({ regimes: [account.handle] });
  },
};

type ReplaceTaxRegimesParams = { account: string; history: TaxRegimeEntry[] };

/**
 * The whole history corrected at once: now and then emptied (`tax_regime_required` in the `IT`
 * workspace), else one to three periods, the first from any day, the others from a 1 January or,
 * now and then, from another day.
 */
const replaceTaxRegimes: OperationSpec<ReplaceTaxRegimesParams> = {
  writes: NONE,
  generate(model, { random, progress }) {
    const account = regimeAccount(model, random);
    if (!account) return undefined;
    if (random.chance(0.15)) return { account: account.handle, history: [] };
    const history: TaxRegimeEntry[] = [{ validFrom: random.date(progress), regime: random.pick(TAX_REGIMES) }];
    for (let count = random.int(0, 2); count > 0; count--) {
      history.push({ validFrom: random.chance(0.9) ? yearStart(random) : random.date(progress), regime: random.pick(TAX_REGIMES) });
    }
    return { account: account.handle, history };
  },
  request: (model, p) => ({
    method: "PUT",
    path: ws(model, `/accounts/${model.account(p.account).id}/tax-regimes`),
    body: { taxRegimes: p.history },
  }),
  predict: (model, p) => predictRegimeChange(model, model.account(p.account), p.history),
  accept(model, p, body) {
    const { taxRegimes } = body as { taxRegimes: TaxRegimeEntry[] };
    expectEcho("the replaced tax regime history", [["taxRegimes", sortRegimes(p.history), taxRegimes]]);
    const account = model.account(p.account);
    account.taxRegimes = sortRegimes(taxRegimes);
    return touched({ regimes: [account.handle] });
  },
};

type SetWithholdingAgentParams = { account: string; value: boolean };

/**
 * The withholding-agent flag, set once on an account that has none: every account of the walk has
 * one from its creation in the `IT` workspace and none elsewhere, so this is always refused
 * (`withholding_agent_already_set`, `tax_regime_not_applicable`) and must change nothing.
 */
const setWithholdingAgent: OperationSpec<SetWithholdingAgentParams> = {
  writes: NONE,
  generate(model, { random }) {
    const account = regimeAccount(model, random);
    return account ? { account: account.handle, value: random.chance(0.5) } : undefined;
  },
  request: (model, p) => ({
    method: "PATCH",
    path: ws(model, `/accounts/${model.account(p.account).id}`),
    body: { domesticWithholdingAgent: p.value },
  }),
  predict(model, p) {
    const account = model.account(p.account);
    return predictCore(() =>
      validateWithholdingAgentChange({ accountType: account.type, taxCountry: model.taxCountry, current: account.domesticWithholdingAgent }),
    );
  },
  accept: () => {
    throw new Error("setWithholdingAgent is never accepted in the walk: every account's flag is set when it is created, or never applies");
  },
};

type CreatePortfolioParams = { name: string };
const createPortfolio: OperationSpec<CreatePortfolioParams> = {
  writes: NONE,
  // A name from the seed, so it never repeats one a deleted portfolio had in a way that differs between runs.
  generate: (model, { random }) => (model.portfolios.size >= 3 ? undefined : { name: `Portfolio ${random.int(1, 1_000_000_000)}` }),
  request: (model, p) => ({ method: "POST", path: ws(model, "/portfolios"), body: { name: p.name } }),
  predict: () => ACCEPT,
  accept(model, p, body) {
    const { id, name } = body as { id: string; name: string };
    expectEcho("createPortfolio", [["name", p.name, name]]);
    const portfolio = model.addPortfolio(id);
    return touched({ portfolios: [portfolio.handle], created: [{ kind: "portfolio", id }] });
  },
};

type PortfolioParams = { portfolio: string };
const deletePortfolio: OperationSpec<PortfolioParams> = {
  writes: NONE,
  generate(model, { random }) {
    if (model.portfolios.size < 2) return undefined;
    return { portfolio: random.pick([...model.portfolios.keys()]) };
  },
  request: (model, p) => ({ method: "DELETE", path: ws(model, `/portfolios/${model.portfolio(p.portfolio).id}`) }),
  predict(model, p) {
    const { id } = model.portfolio(p.portfolio);
    const hasTrades = [...model.trades.values()].some((t) => t.record.portfolioId === id);
    return hasTrades ? { kind: "refuse", status: 409, code: "portfolio_has_trades" } : ACCEPT;
  },
  accept(model, p) {
    model.portfolios.delete(p.portfolio);
    return touched({});
  },
};

// --- Transactions and transfers -------------------------------------------------------------

type TransactionParams = {
  account: string;
  occurredAt: string;
  payee?: string;
  splits: { category: string | null; amountCents: number }[];
};

function transactionRequest(model: WorkspaceModel, p: TransactionParams): WalkRequest {
  return {
    method: "POST",
    path: ws(model, `/accounts/${model.account(p.account).id}/transactions`),
    body: {
      occurredAt: p.occurredAt,
      ...(p.payee === undefined ? {} : { payee: p.payee }),
      splits: p.splits.map((s) => ({ categoryId: s.category === null ? null : model.category(s.category).id, amountCents: s.amountCents })),
    },
  };
}

/** Splits as compared in an echo check: category id and amount, in a stable order. */
function echoSplits(splits: readonly { readonly categoryId: string | null; readonly amountCents: number }[]): unknown {
  return splits
    .map((s) => ({ categoryId: s.categoryId, amountCents: s.amountCents }))
    .sort((a, b) => a.amountCents - b.amountCents || String(a.categoryId).localeCompare(String(b.categoryId)));
}

/** A transaction the API created or rewrote kept the account, time, splits, payee and memo that were sent. */
function echoTransaction(
  model: WorkspaceModel,
  what: string,
  sent: { account: string; occurredAt: string; payee?: string | undefined; memo?: string | undefined; splits: readonly { categoryId: string | null; amountCents: number }[] },
  record: TransactionJson,
): void {
  expectEcho(what, [
    ["accountId", model.account(sent.account).id, record.accountId],
    instantEcho("occurredAt", sent.occurredAt, record.occurredAt),
    ...(sent.payee === undefined ? [] : [["payee", sent.payee, record.payee] as const]),
    ...(sent.memo === undefined ? [] : [["memo", sent.memo, record.memo] as const]),
    ["splits", echoSplits(sent.splits), echoSplits(record.splits)],
  ]);
}

function acceptTransaction(model: WorkspaceModel, p: TransactionParams, body: unknown): Touched {
  const record = body as TransactionJson;
  echoTransaction(model, "the created transaction", {
    ...p,
    splits: p.splits.map((s) => ({ categoryId: s.category === null ? null : model.category(s.category).id, amountCents: s.amountCents })),
  }, record);
  const entity = model.addTransaction(record);
  return touched({ accounts: [model.accountById(entity.record.accountId).handle], budget: true, created: [{ kind: "transaction", id: entity.record.id }] });
}

/** A new transaction writes its account; a card's income is refused before the closed account (`assertNotCardIncome`). */
const transactionWrites = (_model: WorkspaceModel, p: TransactionParams): readonly string[] => [p.account];

const income: OperationSpec<TransactionParams> = {
  writes: transactionWrites,
  generate(model, { random, progress }) {
    // Cards too: income on an on-budget card must be refused, and leave nothing behind (#548).
    const accounts = [...model.budgetCashAccounts(), ...model.cards()];
    if (accounts.length === 0) return undefined;
    const p = payee(random);
    return {
      account: random.pick(accounts).handle,
      occurredAt: random.occurredAt(progress),
      ...(p === undefined ? {} : { payee: p }),
      splits: [{ category: null, amountCents: random.int(150_000, 500_000) }],
    };
  },
  request: transactionRequest,
  predict(model, p) {
    const account = model.account(p.account);
    return account.type === "credit_card" && account.onBudget ? CARD_INCOME : ACCEPT;
  },
  accept: acceptTransaction,
};

const spend: OperationSpec<TransactionParams> = {
  writes: transactionWrites,
  generate(model, { random, progress }) {
    const accounts = [...model.budgetCashAccounts(), ...model.cards()];
    const categories = model.ordinaryCategories();
    if (accounts.length === 0 || categories.length === 0) return undefined;
    const count = random.chance(0.2) ? 2 : 1;
    const refund = random.chance(0.1);
    const splits = Array.from({ length: count }, () => ({
      category: random.pick(categories).handle,
      amountCents: (refund ? 1 : -1) * random.int(300, 40_000),
    }));
    const p = payee(random);
    return { account: random.pick(accounts).handle, occurredAt: random.occurredAt(progress), ...(p === undefined ? {} : { payee: p }), splits };
  },
  request: transactionRequest,
  predict: () => ACCEPT,
  accept: acceptTransaction,
};

/** Money paid into a brokerage account from outside the app: a plain transaction, no category. */
const brokerDeposit: OperationSpec<TransactionParams> = {
  writes: transactionWrites,
  generate(model, { random, progress }) {
    const brokers = model.brokerageAccounts();
    if (brokers.length === 0) return undefined;
    return { account: random.pick(brokers).handle, occurredAt: random.occurredAt(progress), splits: [{ category: null, amountCents: random.int(100_000, 1_000_000) }] };
  },
  request: transactionRequest,
  predict: () => ACCEPT,
  accept: acceptTransaction,
};

type TransferParams = { source: string; destination: string; amountCents: number; occurredAt: string; category?: string };

function transferSpec(choose: (model: WorkspaceModel, random: WalkRandom) => { source: AccountEntity; destination: AccountEntity; category?: string } | undefined, max: number): OperationSpec<TransferParams> {
  return {
    // Both legs; a missing category and a card's income are refused before the closed account.
    writes: (_model, p) => [p.source, p.destination],
    generate(model, { random, progress }) {
      const chosen = choose(model, random);
      if (!chosen) return undefined;
      return {
        source: chosen.source.handle,
        destination: chosen.destination.handle,
        amountCents: random.int(1_000, max),
        occurredAt: random.occurredAt(progress),
        ...(chosen.category === undefined ? {} : { category: chosen.category }),
      };
    },
    request: (model, p) => ({
      method: "POST",
      path: ws(model, "/transfers"),
      body: {
        sourceAccountId: model.account(p.source).id,
        destinationAccountId: model.account(p.destination).id,
        amountCents: p.amountCents,
        occurredAt: p.occurredAt,
        ...(p.category === undefined ? {} : { categoryId: model.category(p.category).id }),
      },
    }),
    predict(model, p) {
      // The category rule of a transfer between an on-budget and an off-budget account: going out
      // it needs one (#378); coming in, none leaves the money to assign (#598), except on a card,
      // where income is not modeled yet (#548).
      const source = model.account(p.source);
      const destination = model.account(p.destination);
      if (p.category === undefined && source.onBudget !== destination.onBudget) {
        if (source.onBudget) return UNCATEGORIZED;
        if (destination.type === "credit_card") return CARD_INCOME;
      }
      return ACCEPT;
    },
    accept(model, p, body) {
      const { source, destination } = body as { source: TransactionJson; destination: TransactionJson };
      // The category goes on the on-budget leg when exactly one of the two accounts is off budget.
      const sourceOn = model.account(p.source).onBudget;
      const destinationOn = model.account(p.destination).onBudget;
      const categoryId = p.category === undefined ? null : model.category(p.category).id;
      const categoryOf = (on: boolean): string | null => (sourceOn !== destinationOn && on ? categoryId : null);
      echoTransaction(model, "the transfer's outgoing leg", { account: p.source, occurredAt: p.occurredAt, splits: [{ categoryId: categoryOf(sourceOn), amountCents: -p.amountCents }] }, source);
      echoTransaction(model, "the transfer's incoming leg", { account: p.destination, occurredAt: p.occurredAt, splits: [{ categoryId: categoryOf(destinationOn), amountCents: p.amountCents }] }, destination);
      expectEcho("the transfer's legs", [
        ["source.transferId", destination.id, source.transferId],
        ["destination.transferId", source.id, destination.transferId],
      ]);
      model.addTransaction(source);
      model.addTransaction(destination);
      return touched({
        accounts: [p.source, p.destination],
        budget: true,
        created: [{ kind: "transaction", id: source.id }],
      });
    },
  };
}

function investmentsCategory(model: WorkspaceModel): string | undefined {
  return model.categoryByName("Investments")?.handle;
}

const transfer = transferSpec((model, random) => {
  const accounts = model.budgetCashAccounts();
  if (accounts.length < 2) return undefined;
  const source = random.pick(accounts);
  return { source, destination: random.pick(accounts.filter((a) => a !== source)) };
}, 200_000);

const cardPayment = transferSpec((model, random) => {
  const cash = model.budgetCashAccounts();
  const cards = model.cards();
  if (cash.length === 0 || cards.length === 0) return undefined;
  return { source: random.pick(cash), destination: random.pick(cards) };
}, 80_000);

/**
 * The monthly transfer from the budget to the broker, assigned to the "Investments" category. Now
 * and then without one, which is refused (#378).
 */
const fundBroker = transferSpec((model, random) => {
  const cash = model.budgetCashAccounts();
  const brokers = model.brokerageAccounts();
  const category = investmentsCategory(model);
  if (cash.length === 0 || brokers.length === 0 || !category) return undefined;
  return { source: random.pick(cash), destination: random.pick(brokers), ...(random.chance(0.1) ? {} : { category }) };
}, 600_000);

/**
 * Money back from the broker: half of the time as income to assign, with no category (#598), half
 * back into the "Investments" category. Now and then into a card: refused without a category
 * (#548), a refund on the card with one.
 */
const withdrawBroker = transferSpec((model, random) => {
  const cash = model.budgetCashAccounts();
  const brokers = model.brokerageAccounts();
  const category = investmentsCategory(model);
  if (cash.length === 0 || brokers.length === 0 || !category) return undefined;
  const cards = model.cards().filter((card) => card.onBudget);
  const destination = cards.length > 0 && random.chance(0.15) ? random.pick(cards) : random.pick(cash);
  return { source: random.pick(brokers), destination, ...(random.chance(0.5) ? {} : { category }) };
}, 150_000);

/**
 * Money kept apart in an off-budget savings account: it leaves the budget through a category, and
 * comes back through one or, half of the time, as income to assign (#598).
 */
const offBudgetSavings = transferSpec((model, random) => {
  const cash = model.budgetCashAccounts();
  const savings = [...model.accounts.values()].filter((a) => !a.onBudget && a.type === "savings");
  const categories = model.ordinaryCategories();
  if (cash.length === 0 || savings.length === 0 || categories.length === 0) return undefined;
  const outgoing = random.chance(0.7);
  const [source, destination] = outgoing ? [random.pick(cash), random.pick(savings)] : [random.pick(savings), random.pick(cash)];
  const category = random.pick(categories).handle;
  return { source: source!, destination: destination!, ...(!outgoing && random.chance(0.5) ? {} : { category }) };
}, 200_000);

/** A transfer between two cards' payment categories (#260). */
const cardToCard = transferSpec((model, random) => {
  const cards = model.cards();
  if (cards.length < 2) return undefined;
  const source = random.pick(cards);
  return { source, destination: random.pick(cards.filter((c) => c !== source)) };
}, 50_000);

const brokerToBroker = transferSpec((model, random) => {
  const brokers = model.brokerageAccounts();
  if (brokers.length < 2) return undefined;
  const source = random.pick(brokers);
  return { source, destination: random.pick(brokers.filter((a) => a !== source)) };
}, 300_000);

/**
 * Empties an account that holds money, so the walk can close it (#735): its whole balance moves
 * to another on-budget cash account, or a card's debt is paid off from one. Each is a transfer
 * like any other, refused when it writes to an account already closed.
 */
const sweepAccount: OperationSpec<TransferParams> = {
  ...transferSpec(() => undefined, 0),
  generate(model, { random, progress }) {
    const cash = model.budgetCashAccounts();
    const candidates = model.openAccounts().filter((account) => account.type !== "brokerage" && model.balanceOf(account) !== 0);
    if (candidates.length === 0) return undefined;
    const account = random.pick(candidates);
    const balance = model.balanceOf(account);
    const others = cash.filter((other) => other !== account);
    if (others.length === 0) return undefined;
    const other = random.pick(others);
    const [source, destination] = balance > 0 ? [account, other] : [other, account];
    return { source: source.handle, destination: destination.handle, amountCents: Math.abs(balance), occurredAt: random.occurredAt(progress) };
  },
};

type EditTransactionParams = { tx: string; change: "memo" | "payee" | "amount" | "status"; value: string | number };
const editTransaction: OperationSpec<EditTransactionParams> = {
  // Its own account, and the other leg's when a new amount moves it too (#547); checked first (#655).
  writes(model, p) {
    const entity = model.transaction(p.tx);
    const partner = model.transferPartner(entity);
    const movesPartner = p.change === "amount" && partner !== undefined && p.value !== transactionAmount(entity.record);
    return accountsTouchedBy(model, [entity, movesPartner ? partner : undefined]);
  },
  closedFirst: true,
  generate(model, { random }) {
    const candidates = nonLeg(model);
    if (candidates.length === 0) return undefined;
    const entity = random.pick(candidates);
    const singleSplit = entity.record.splits.length === 1;
    // A transfer leg's new amount keeps its sign, so the other leg follows it (#547).
    const amountEditable = singleSplit;
    const change = random.weighted<EditTransactionParams["change"]>([
      ["memo", 3],
      ["payee", 2],
      ["amount", amountEditable ? 3 : 0],
      ["status", 2],
    ]);
    const current = transactionAmount(entity.record);
    const value =
      change === "amount"
        ? Math.sign(current || 1) * random.int(100, Math.max(200, Math.abs(current) * 2))
        : change === "status"
          ? random.pick(["pending", "cleared"])
          : `${change} ${random.int(1, 999)}`;
    return { tx: entity.handle, change, value };
  },
  request(model, p) {
    const entity = model.transaction(p.tx);
    const split = entity.record.splits[0]!;
    const body =
      p.change === "amount"
        ? { splits: [{ categoryId: split.categoryId, amountCents: p.value }] }
        : { [p.change]: p.value };
    return { method: "PATCH", path: ws(model, `/accounts/${entity.record.accountId}/transactions/${entity.record.id}`), body };
  },
  predict(model, p) {
    const entity = model.transaction(p.tx);
    if (entity.record.status === "reconciled") return RECONCILED_TRANSACTION;
    // A new amount on a transfer leg moves the other leg too, which a reconciled leg refuses (#547).
    if (p.change === "amount" && p.value !== transactionAmount(entity.record) && model.transferPartner(entity)?.record.status === "reconciled") {
      return RECONCILED_TRANSACTION;
    }
    return ACCEPT;
  },
  accept(model, p, body) {
    const entity = model.transaction(p.tx);
    const split = entity.record.splits[0]!;
    const partner = model.transferPartner(entity);
    echoEdit(
      `the edited transaction (${p.change})`,
      entity.record,
      body as TransactionJson,
      p.change === "amount"
        ? { splits: [{ categoryId: split.categoryId, amountCents: p.value as number, memo: null }] }
        : { [p.change]: p.value },
    );
    if (p.change === "amount" && partner && p.value !== transactionAmount(entity.record)) {
      // The other leg gets the opposite amount on its one split (keeping its id, memo and
      // category), and a cleared other leg goes back to pending (#547). The full comparison of
      // the touched accounts checks it against the API.
      const [partnerSplit] = partner.record.splits;
      partner.record = {
        ...partner.record,
        status: partner.record.status === "cleared" ? "pending" : partner.record.status,
        splits: [{ ...partnerSplit!, amountCents: -(p.value as number) }],
      };
    }
    entity.record = body as TransactionJson;
    return touched({ accounts: accountsTouchedBy(model, [entity, partner]), budget: true });
  },
};

type TxParams = { tx: string };

/**
 * An edited transaction came back as it was, with only `changes` applied: the field the request
 * sent, and nothing else moved. For a cash leg, "as it was" is what the model works out from its
 * trade (amount, account, midnight of the trade date), not what the API last answered.
 */
function echoEdit(what: string, before: TransactionJson, after: TransactionJson, changes: Partial<Pick<TransactionJson, "payee" | "memo" | "status" | "splits">>): void {
  const view = (r: TransactionJson) => ({
    accountId: r.accountId,
    occurredAt: new Date(r.occurredAt).toISOString(),
    payee: r.payee,
    memo: r.memo,
    status: r.status,
    transferId: r.transferId,
    tradeId: r.tradeId,
    splits: echoSplits(r.splits),
  });
  const expected = view({ ...before, ...changes });
  const actual = view(after);
  expectEcho(what, Object.keys(expected).map((key) => [key, expected[key as keyof typeof expected], actual[key as keyof typeof actual]] as const));
}

/** An edit of a transaction's own fields writes its account, checked before anything else (#655). */
const ownAccount = (model: WorkspaceModel, p: { tx: string }): readonly string[] => accountsTouchedBy(model, [model.transaction(p.tx)]);

const clearTransaction: OperationSpec<TxParams> = {
  writes: ownAccount,
  closedFirst: true,
  generate(model, { random }) {
    const pending = [...model.transactions.values()].filter((e) => e.record.status === "pending");
    return pending.length === 0 ? undefined : { tx: random.pick(pending).handle };
  },
  request(model, p) {
    const { record } = model.transaction(p.tx);
    return { method: "PATCH", path: ws(model, `/accounts/${record.accountId}/transactions/${record.id}`), body: { status: "cleared" } };
  },
  predict: () => ACCEPT,
  accept(model, p, body) {
    const entity = model.transaction(p.tx);
    echoEdit("the cleared transaction", entity.record, body as TransactionJson, { status: "cleared" });
    entity.record = body as TransactionJson;
    return touched({ accounts: accountsTouchedBy(model, [entity]) });
  },
};

/** A delete writes both legs; a reconciled or trade-owned row is refused before the closed account. */
const deleteWrites = (model: WorkspaceModel, p: TxParams): readonly string[] => {
  const entity = model.transaction(p.tx);
  return accountsTouchedBy(model, [entity, model.transferPartner(entity)]);
};

const deleteTransaction: OperationSpec<TxParams> = {
  writes: deleteWrites,
  generate(model, { random }) {
    const candidates = nonLeg(model);
    return candidates.length === 0 ? undefined : { tx: random.pick(candidates).handle };
  },
  request(model, p) {
    const { record } = model.transaction(p.tx);
    return { method: "DELETE", path: ws(model, `/accounts/${record.accountId}/transactions/${record.id}`) };
  },
  predict(model, p) {
    const entity = model.transaction(p.tx);
    if (entity.record.status === "reconciled") return RECONCILED_TRANSACTION;
    if (entity.record.tradeId !== null) return TRADE_OWNED;
    return reconciledPair(model, entity) ? RECONCILED_TRANSACTION : ACCEPT;
  },
  accept(model, p) {
    const entity = model.transaction(p.tx);
    const partner = model.transferPartner(entity);
    const accounts = accountsTouchedBy(model, [entity, partner]);
    model.removeTransaction(entity.handle);
    if (partner) model.removeTransaction(partner.handle);
    return touched({ accounts, budget: true });
  },
};

// --- A trade's cash leg through the transactions API and sync (ADR 0012) ---------------------

type LegEditParams = { tx: string; change: "memo" | "payee" | "status"; value: string };
const editLeg: OperationSpec<LegEditParams> = {
  writes: ownAccount,
  closedFirst: true,
  generate(model, { random }) {
    const candidates = legs(model);
    if (candidates.length === 0) return undefined;
    const change = random.pick(["memo", "payee", "status"] as const);
    const value = change === "status" ? random.pick(["pending", "cleared"]) : `${change} ${random.int(1, 999)}`;
    return { tx: random.pick(candidates).handle, change, value };
  },
  request(model, p) {
    const { record } = model.transaction(p.tx);
    return { method: "PATCH", path: ws(model, `/accounts/${record.accountId}/transactions/${record.id}`), body: { [p.change]: p.value } };
  },
  predict: (model, p) => (model.transaction(p.tx).record.status === "reconciled" ? RECONCILED_TRANSACTION : ACCEPT),
  accept(model, p, body) {
    const entity = model.transaction(p.tx);
    echoEdit(`the edited cash leg (${p.change})`, entity.record, body as TransactionJson, { [p.change]: p.value });
    entity.record = body as TransactionJson;
    return touched({ accounts: accountsTouchedBy(model, [entity]) });
  },
};

type LegAmountParams = { tx: string; amountCents: number };
const editLegAmount: OperationSpec<LegAmountParams> = {
  writes: ownAccount,
  closedFirst: true,
  generate(model, { random }) {
    const candidates = legs(model);
    return candidates.length === 0 ? undefined : { tx: random.pick(candidates).handle, amountCents: -random.int(1, 100_000) };
  },
  request(model, p) {
    const { record } = model.transaction(p.tx);
    return {
      method: "PATCH",
      path: ws(model, `/accounts/${record.accountId}/transactions/${record.id}`),
      body: { splits: [{ categoryId: null, amountCents: p.amountCents }] },
    };
  },
  predict: (model, p) => (model.transaction(p.tx).record.status === "reconciled" ? RECONCILED_TRANSACTION : TRADE_OWNED),
  accept: () => {
    throw new Error("editLegAmount is never accepted");
  },
};

const deleteLeg: OperationSpec<TxParams> = {
  writes: deleteWrites,
  generate(model, { random }) {
    const candidates = legs(model);
    return candidates.length === 0 ? undefined : { tx: random.pick(candidates).handle };
  },
  request: deleteTransaction.request,
  predict: deleteTransaction.predict,
  accept: () => {
    throw new Error("deleteLeg is never accepted");
  },
};

type SyncParams = { tx: string; field: string; value: unknown; changeId: string; deviceId: string; physical: number };

function syncRequest(model: WorkspaceModel, p: SyncParams): WalkRequest {
  return {
    method: "POST",
    path: ws(model, "/changes"),
    body: {
      changes: [
        { id: p.changeId, entityId: model.transaction(p.tx).record.id, fieldName: p.field, hlc: { physical: p.physical, counter: 0, deviceId: p.deviceId }, value: p.value },
      ],
    },
  };
}

/** A device changing a field of a cash leg that belongs to the trade: refused, `trade_owned`. */
const syncTradeOwned: OperationSpec<SyncParams> = {
  // `trade_owned` and `locked` come before `account_closed` (sync/apply.ts): its outcome stays.
  writes: ownAccount,
  generate(model, { random }) {
    const candidates = legs(model);
    if (candidates.length === 0) return undefined;
    const leg = random.pick(candidates);
    // A split's own fields name the split: possible once the model holds the leg as the API returned it.
    const splitId = leg.record.splits[0]?.id;
    const fields = ["transactions.amount_cents", "transactions.occurred_at", "transactions.account_id", ...(splitId ? ["splits.amount_cents", "splits.category_id"] : [])];
    const field = random.pick(fields);
    const value = field.endsWith("amount_cents") ? -random.int(1, 9_999) : field === "transactions.occurred_at" ? "2025-10-01T10:00:00Z" : random.uuid();
    return { tx: leg.handle, field, value, changeId: random.uuid(), deviceId: `walk-${random.int(1, 9)}`, physical: 1_760_000_000_000 + random.int(0, 1e9) };
  },
  request(model, p) {
    const request = syncRequest(model, p);
    if (!p.field.startsWith("splits.")) return request;
    const splitId = model.transaction(p.tx).record.splits[0]?.id;
    const [change] = (request.body as { changes: Record<string, unknown>[] }).changes;
    return { ...request, body: { changes: [{ ...change, entityId: splitId }] } };
  },
  predict: () => ({ kind: "syncOutcome", outcome: "trade_owned" }),
  accept: () => touched({}),
};

/** A device changing the memo of a reconciled transaction: refused, `locked`. */
const syncLockedMemo: OperationSpec<SyncParams> = {
  writes: ownAccount,
  generate(model, { random }) {
    const candidates = [...model.transactions.values()].filter((e) => e.record.status === "reconciled");
    if (candidates.length === 0) return undefined;
    return { tx: random.pick(candidates).handle, field: "transactions.memo", value: `synced ${random.int(1, 999)}`, changeId: random.uuid(), deviceId: `walk-${random.int(1, 9)}`, physical: 1_760_000_000_000 + random.int(0, 1e9) };
  },
  request: syncRequest,
  predict: () => ({ kind: "syncOutcome", outcome: "locked" }),
  accept: () => touched({}),
};

// --- Reconciliation ---------------------------------------------------------------------------

type ReconcileParams = { account: string; date: string; ticked: string[]; statementBalanceCents: number };
const reconcile: OperationSpec<ReconcileParams> = {
  writes: (_model, p) => [p.account],
  generate(model, { random }) {
    const cleared = [...model.transactions.values()].filter((e) => e.record.status === "cleared");
    if (cleared.length === 0) return undefined;
    const anchor = random.pick(cleared);
    const account = model.accountById(anchor.record.accountId);
    const date = anchor.record.budgetDate;
    const eligible = cleared.filter((e) => e.record.accountId === account.id && e.record.budgetDate <= date);
    const ticked = eligible.filter((e) => e === anchor || random.chance(0.7));
    const statementBalanceCents = model.lastReconciledBalance(account.handle) + ticked.reduce((sum, e) => sum + transactionAmount(e.record), 0);
    return { account: account.handle, date, ticked: ticked.map((e) => e.handle), statementBalanceCents };
  },
  request: (model, p) => ({
    method: "POST",
    path: ws(model, `/accounts/${model.account(p.account).id}/reconciliations`),
    body: { date: p.date, statementBalanceCents: p.statementBalanceCents, tickedTransactionIds: p.ticked.map((h) => model.transaction(h).record.id) },
  }),
  predict: () => ACCEPT,
  accept(model, p, body) {
    const result = body as { outcome: string; reconciliation?: { id: string } };
    if (result.outcome !== "reconciled" || !result.reconciliation) {
      throw new Error(`expected the reconciliation to complete, got ${JSON.stringify(body)}`);
    }
    model.addReconciliation(result.reconciliation.id, p.account, p.date, p.statementBalanceCents);
    for (const handle of p.ticked) {
      const entity = model.transaction(handle);
      entity.record = { ...entity.record, status: "reconciled" };
      entity.reconciliationId = result.reconciliation.id;
    }
    return touched({ accounts: [p.account] });
  },
};

const unlock: OperationSpec<TxParams> = {
  writes: ownAccount,
  generate(model, { random }) {
    const reconciled = [...model.transactions.values()].filter((e) => e.record.status === "reconciled");
    return reconciled.length === 0 ? undefined : { tx: random.pick(reconciled).handle };
  },
  request: (model, p) => ({ method: "POST", path: ws(model, `/transactions/${model.transaction(p.tx).record.id}/unlock-reconciliation`) }),
  predict: () => ACCEPT,
  accept(model, p, body) {
    const entity = model.transaction(p.tx);
    if (entity.reconciliationId) model.breakReconciliation(entity.reconciliationId);
    entity.reconciliationId = null;
    echoEdit("the unlocked transaction", entity.record, body as TransactionJson, { status: "cleared" });
    entity.record = body as TransactionJson;
    return touched({ accounts: accountsTouchedBy(model, [entity]) });
  },
};

// --- Trades -------------------------------------------------------------------------------------

/** When the candidate rows were recorded, for the prediction: after every trade already stored. */
const CANDIDATE_CREATED_AT = "9999-12-31T23:59:59.999Z";

type TradeFields = {
  type: "buy" | "sell" | "dividend" | "fee" | "tax";
  account: string;
  portfolio: string;
  instrument: string | null;
  tradeDate: string;
  occurredAt?: string;
  amounts: Record<string, number>;
  taxKind?: string;
  memo?: string;
};

function tradeBody(model: WorkspaceModel, p: TradeFields): Record<string, unknown> {
  return {
    type: p.type,
    accountId: model.account(p.account).id,
    portfolioId: model.portfolio(p.portfolio).id,
    ...(p.instrument === null ? {} : { instrumentId: model.instruments.get(p.instrument).id }),
    tradeDate: p.tradeDate,
    ...(p.occurredAt === undefined ? {} : { occurredAt: p.occurredAt }),
    ...(p.taxKind === undefined ? {} : { taxKind: p.taxKind }),
    ...(p.memo === undefined ? {} : { memo: p.memo }),
    ...p.amounts,
  };
}

/** One trade row as it was sent: by handle, its amounts as in the request body. */
type SentTradeRow = {
  type: TradeJson["type"];
  account: string;
  portfolio: string;
  instrument: string | null;
  tradeDate: string;
  occurredAt?: string | undefined;
  amounts: Record<string, number>;
  taxKind?: string | undefined;
  memo?: string | undefined;
};

/**
 * A trade row the API stored kept what was sent: type, account, portfolio, instrument, trade date,
 * time, every amount, the tax kind and the memo. A buy or a sell sent without a gross gets
 * quantity × price × price factor, rounded once (ADR 0011).
 */
function echoTradeRow(model: WorkspaceModel, what: string, sent: SentTradeRow, record: TradeJson): void {
  const instrument = sent.instrument === null ? undefined : model.instruments.get(sent.instrument);
  const derivedGross =
    (sent.type === "buy" || sent.type === "sell") && sent.amounts.grossCents === undefined && instrument
      ? [["grossCents (quantity × price)", amountOf(sent.amounts.quantityE8! as Quantity, sent.amounts.priceE6! as Price, toPriceFactor(instrument.priceFactorE6), instrument.currency), record.grossCents] as const]
      : [];
  expectEcho(what, [
    ["type", sent.type, record.type],
    ["accountId", model.account(sent.account).id, record.accountId],
    ["portfolioId", model.portfolio(sent.portfolio).id, record.portfolioId],
    ["instrumentId", instrument?.id ?? null, record.instrumentId],
    ["tradeDate", sent.tradeDate, record.tradeDate],
    sent.occurredAt === undefined ? (["occurredAt", null, record.occurredAt] as const) : instantEcho("occurredAt", sent.occurredAt, record.occurredAt),
    ...Object.entries(sent.amounts).map(([field, value]) => [field, value, (record as unknown as Record<string, unknown>)[field]] as const),
    ...derivedGross,
    ...(sent.taxKind === undefined ? [] : [["taxKind", sent.taxKind, record.taxKind] as const]),
    ...(sent.memo === undefined ? [] : [["memo", sent.memo, record.memo] as const]),
  ]);
}

function candidateRow(model: WorkspaceModel, id: string, row: { type: PositionTrade["type"]; account: string; portfolio: string; instrument: string | null; tradeDate: string; occurredAt?: string | undefined; amounts: Record<string, number>; taxKind?: string | undefined; transferTradeId?: string | null }): PositionTrade {
  const instrument = row.instrument === null ? undefined : model.instruments.get(row.instrument);
  const a = row.amounts;
  const quantity = (a.quantityE8 ?? 0) as Quantity;
  const price = (a.priceE6 ?? 0) as Price;
  const priceFactor = instrument ? toPriceFactor(instrument.priceFactorE6) : PRICE_FACTOR_ONE;
  const grossCents =
    a.grossCents ?? ((row.type === "buy" || row.type === "sell") && instrument ? amountOf(quantity, price, priceFactor, instrument.currency) : 0);
  return {
    id,
    accountId: model.account(row.account).id,
    portfolioId: model.portfolio(row.portfolio).id,
    instrumentId: instrument?.id ?? null,
    type: row.type,
    date: row.tradeDate,
    occurredAt: row.occurredAt ?? localMidnight(row.tradeDate),
    createdAt: CANDIDATE_CREATED_AT,
    currency: model.account(row.account).currency,
    quantity,
    price,
    priceFactor,
    grossCents,
    feesCents: a.feesCents ?? 0,
    transactionTaxCents: a.transactionTaxCents ?? 0,
    accruedInterestCents: a.accruedInterestCents ?? 0,
    withholdingForeignCents: a.withholdingForeignCents ?? 0,
    withholdingDomesticCents: a.withholdingDomesticCents ?? 0,
    gainTaxCents: a.gainTaxCents ?? 0,
    taxKind: (row.taxKind ?? null) as PositionTrade["taxKind"],
    costBasisCents: a.costBasisCents ?? null,
    splitFrom: null,
    splitTo: null,
    transferTradeId: row.transferTradeId ?? null,
  };
}

/** The core's verdict on the history with the candidate rows added: what the API must answer too. */
function predictHistory(model: WorkspaceModel, candidates: readonly PositionTrade[]): Prediction {
  try {
    validatePositionHistory([...model.positionTrades(), ...candidates]);
    return ACCEPT;
  } catch (error) {
    if (isValidationError(error)) return { kind: "refuse", status: 400, code: error.code };
    throw error;
  }
}

function acceptTrades(model: WorkspaceModel, body: unknown): Touched {
  const { trades } = body as { trades: TradeJson[] };
  const added = model.addTrades(trades);
  return touched({
    accounts: added.map((t) => model.accountById(t.record.accountId).handle),
    portfolios: added.map((t) => model.handleOf(t.record.portfolioId)).filter((h): h is string => h !== undefined),
    created: added.map((t) => ({ kind: "trade" as const, id: t.record.id })),
  });
}

/**
 * What each portfolio holds now, ordered by account, portfolio and instrument handle: the core
 * orders its rows by id, which differs between two runs of the same seed, and the generator picks
 * from this list.
 */
function holdings(model: WorkspaceModel): PortfolioPosition[] {
  const key = (p: PortfolioPosition): string =>
    [
      sortableHandle(model.handleOf(p.accountId)),
      sortableHandle(model.handleOf(p.portfolioId)),
      sortableHandle(model.instruments.byId.get(p.instrumentId)?.handle),
    ].join("|");
  return computePositions(model.positionTrades())
    .portfolios.filter((p) => p.quantity > 0 && model.handleOf(p.portfolioId) !== undefined)
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function instrumentHandle(model: WorkspaceModel, id: string): string {
  const instrument = model.instruments.byId.get(id);
  if (!instrument) throw new Error(`unknown instrument ${id}`);
  return instrument.handle;
}

/** A brokerage account and a portfolio of the workspace, any pair: portfolios are not tied to an account. */
function brokerAndPortfolio(model: WorkspaceModel, random: WalkRandom): { account: string; portfolio: string } | undefined {
  const brokers = model.brokerageAccounts();
  if (brokers.length === 0 || model.portfolios.size === 0) return undefined;
  return { account: random.pick(brokers).handle, portfolio: random.pick([...model.portfolios.keys()]) };
}

function maybeTime(random: WalkRandom, tradeDate: string): { occurredAt?: string } {
  const time = random.tradeTime(tradeDate);
  return time === undefined ? {} : { occurredAt: time };
}

/**
 * The tax regime rules a new row must pass in the `IT` workspace (#508), checked before the
 * replay: a regime history on its account (`tax_regime_required`), then `checkTradeRegime` against
 * the regime in force on its date and the account's broker. Undefined when every row passes, or
 * outside that workspace.
 */
function predictRegime(model: WorkspaceModel, rows: readonly PositionTrade[]): Prediction | undefined {
  if (model.taxCountry !== WALK_TAX_COUNTRY) return undefined;
  for (const row of rows) {
    const account = model.accountById(row.accountId);
    if (account.taxRegimes.length === 0) return { kind: "refuse", status: 400, code: "tax_regime_required" };
    const instrumentType = row.instrumentId === null ? null : (model.instruments.byId.get(row.instrumentId)?.type ?? null);
    const prediction = predictCore(() =>
      checkTradeRegime(row, { history: account.taxRegimes, date: row.date, domesticWithholdingAgent: account.domesticWithholdingAgent, instrumentType }),
    );
    if (prediction.kind !== "accept") return prediction;
  }
  return undefined;
}

/** A trade's accounts are checked open before anything that could refuse it for another reason (#741). */
function singleTradeSpec(generate: OperationSpec<TradeFields>["generate"]): OperationSpec<TradeFields> {
  return {
    trade: true,
    writes: (_model, p) => [p.account],
    closedFirst: true,
    generate,
    request: (model, p) => ({ method: "POST", path: ws(model, "/trades"), body: tradeBody(model, p) }),
    predict(model, p) {
      const rows = [candidateRow(model, "candidate", p)];
      return predictRegime(model, rows) ?? predictHistory(model, rows);
    },
    accept(model, p, body) {
      const { trades } = body as { trades: TradeJson[] };
      expectEcho(`the recorded ${p.type}`, [["rows", 1, trades.length]]);
      echoTradeRow(model, `the recorded ${p.type}`, p, trades[0]!);
      return acceptTrades(model, body);
    },
  };
}

function priceFor(random: WalkRandom, type: string): { quantityE8: number; priceE6: number } {
  if (type === "government_bond") {
    return { quantityE8: random.int(1, 20) * 1_000 * 100_000_000, priceE6: random.int(95_000_000, 105_000_000) };
  }
  const quantityE8 = random.chance(0.3) ? random.int(10_000_000, 4_000_000_000) : random.int(1, 40) * 100_000_000;
  return { quantityE8, priceE6: random.int(20_000_000, 300_000_000) };
}

const buy = singleTradeSpec((model, { random, progress }) => {
  const where = brokerAndPortfolio(model, random);
  if (!where) return undefined;
  const instrument = random.pick([...model.instruments.byHandle.values()]);
  const tradeDate = random.date(progress);
  const amounts: Record<string, number> = { ...priceFor(random, instrument.type), feesCents: random.int(0, 1_500) };
  if (random.chance(0.2)) amounts.transactionTaxCents = random.int(1, 500);
  if (instrument.type === "government_bond" && random.chance(0.6)) {
    amounts.accruedInterestCents = random.int(100, 5_000);
    if (random.chance(0.5)) amounts.withholdingDomesticCents = Math.floor(amounts.accruedInterestCents * 0.125);
  }
  return { type: "buy", ...where, instrument: instrument.handle, tradeDate, ...maybeTime(random, tradeDate), amounts };
});

function sellFields(model: WorkspaceModel, random: WalkRandom, progress: number, oversell: boolean): TradeFields | undefined {
  const held = holdings(model);
  if (held.length === 0) return undefined;
  const holding = random.pick(held);
  const instrument = model.instruments.byId.get(holding.instrumentId)!;
  const quantityE8 = oversell ? holding.quantity + random.int(1, 100_000_000) : random.chance(0.3) ? holding.quantity : random.int(1, holding.quantity);
  // Mostly after the holding's last trade, so the sale has the units; sometimes any date.
  const lastDate = model.positionTrades()
    .filter((t) => t.instrumentId === holding.instrumentId && t.portfolioId === holding.portfolioId)
    .reduce((latest, t) => (t.date > latest ? t.date : latest), "");
  const candidateDate = random.date(progress);
  const tradeDate = random.chance(0.8) && candidateDate < lastDate ? lastDate : candidateDate;
  const amounts: Record<string, number> = { quantityE8, priceE6: priceFor(random, instrument.type).priceE6, feesCents: random.int(0, 1_500) };
  if (random.chance(0.3)) amounts.gainTaxCents = random.int(0, 2_000);
  if (random.chance(0.15)) amounts.transactionTaxCents = random.int(1, 300);
  if (instrument.type === "government_bond" && random.chance(0.5)) {
    amounts.accruedInterestCents = random.int(100, 3_000);
    if (random.chance(0.5)) amounts.withholdingDomesticCents = Math.floor(amounts.accruedInterestCents * 0.125);
  }
  return {
    type: "sell",
    account: model.accountById(holding.accountId).handle,
    portfolio: model.handleOf(holding.portfolioId)!,
    instrument: instrument.handle,
    tradeDate,
    ...maybeTime(random, tradeDate),
    amounts,
  };
}

const sell = singleTradeSpec((model, { random, progress }) => sellFields(model, random, progress, false));
/** A sale of more than the portfolio holds: refused with `insufficient_quantity`, as the core predicts. */
const oversell = singleTradeSpec((model, { random, progress }) => sellFields(model, random, progress, true));

const dividend = singleTradeSpec((model, { random, progress }) => {
  const where = brokerAndPortfolio(model, random);
  if (!where) return undefined;
  const instrument = random.pick([...model.instruments.byHandle.values()]);
  const grossCents = random.int(500, 50_000);
  const withholdingForeignCents = random.chance(0.5) ? Math.floor(grossCents * 0.15) : 0;
  const withholdingDomesticCents = random.chance(0.6) ? Math.floor((grossCents - withholdingForeignCents) * 0.26) : 0;
  const tradeDate = random.date(progress);
  return {
    type: "dividend",
    ...where,
    instrument: instrument.handle,
    tradeDate,
    ...maybeTime(random, tradeDate),
    amounts: { grossCents, withholdingForeignCents, withholdingDomesticCents, feesCents: random.chance(0.3) ? random.int(1, 300) : 0 },
  };
});

const fee = singleTradeSpec((model, { random, progress }) => {
  const where = brokerAndPortfolio(model, random);
  if (!where) return undefined;
  const tradeDate = random.date(progress);
  const instrument = random.chance(0.3) ? random.pick([...model.instruments.byHandle.values()]).handle : null;
  return { type: "fee", ...where, instrument, tradeDate, ...maybeTime(random, tradeDate), amounts: { feesCents: random.int(100, 2_500) } };
});

const tax = singleTradeSpec((model, { random, progress }) => {
  const where = brokerAndPortfolio(model, random);
  if (!where) return undefined;
  const taxKind = random.weighted([["stamp_duty", 4], ["other", 1], ["gain_tax_adjustment", 2], ["managed_result_tax", 1]] as const);
  const grossCents = taxKind === "gain_tax_adjustment" ? random.pick([-1, 1]) * random.int(100, 3_000) : random.int(100, 5_000);
  const tradeDate = random.date(progress);
  return { type: "tax", ...where, instrument: null, tradeDate, ...maybeTime(random, tradeDate), taxKind, amounts: { grossCents } };
});

/**
 * `ANY`, and `account_closed` as well when a closed account ever traded the instrument: whether it
 * held some on a split's date, and so gets a row of the split, is the API's to work out.
 */
function anyOrClosedHolder(model: WorkspaceModel, instrument: string): Prediction {
  const { id } = model.instruments.get(instrument);
  const closed = new Set(model.closedAccounts().map((account) => account.id));
  const held = [...model.trades.values()].some((trade) => trade.record.instrumentId === id && closed.has(trade.record.accountId));
  return held ? { kind: "any", alsoAllowed: ["account_closed"] } : ANY;
}

type SplitParams = { instrument: string; tradeDate: string; occurredAt?: string; splitFrom: number; splitTo: number };
const split: OperationSpec<SplitParams> = {
  trade: true,
  generate(model, { random, progress }) {
    const held = holdings(model);
    if (held.length === 0) return undefined;
    const [splitFrom, splitTo] = random.pick([[1, 2], [1, 4], [2, 1], [1, 3]] as const);
    const tradeDate = random.date(progress);
    return { instrument: instrumentHandle(model, random.pick(held).instrumentId), tradeDate, ...maybeTime(random, tradeDate), splitFrom, splitTo };
  },
  request: (model, p) => ({
    method: "POST",
    path: ws(model, "/trades"),
    body: {
      type: "split",
      instrumentId: model.instruments.get(p.instrument).id,
      tradeDate: p.tradeDate,
      ...(p.occurredAt === undefined ? {} : { occurredAt: p.occurredAt }),
      splitFrom: p.splitFrom,
      splitTo: p.splitTo,
    },
  }),
  // The rows a split stands for are the API's to work out (every holding at the start of its date),
  // so its accounts too: a closed one that held the instrument then refuses it (ADR 0018).
  writes: NONE,
  predict: (model, p) => anyOrClosedHolder(model, p.instrument),
  accept(model, p, body) {
    // Which holdings the rows cover is checked by the positions oracle; each row keeps what was sent.
    const { trades } = body as { trades: TradeJson[] };
    for (const row of trades) {
      echoTradeRow(model, "a recorded split row", {
        type: "split",
        account: model.accountById(row.accountId).handle,
        portfolio: model.handleOf(row.portfolioId) ?? "<unknown portfolio>",
        instrument: p.instrument,
        tradeDate: p.tradeDate,
        occurredAt: p.occurredAt,
        amounts: { splitFrom: p.splitFrom, splitTo: p.splitTo },
      }, row);
    }
    return acceptTrades(model, body);
  },
};

type LegParams = { account: string; portfolio: string; feesCents?: number; costBasisCents?: number };
type TransferSecuritiesParams = { instrument: string; tradeDate: string; occurredAt?: string; quantityE8: number; from?: LegParams; to?: LegParams };

const transferSecurities: OperationSpec<TransferSecuritiesParams> = {
  trade: true,
  writes: (_model, p) => [p.from?.account, p.to?.account],
  closedFirst: true,
  generate(model, { random, progress }) {
    const brokers = model.brokerageAccounts();
    const portfolios = [...model.portfolios.keys()];
    if (brokers.length === 0 || portfolios.length === 0) return undefined;
    const tradeDate = random.date(progress);
    const time = maybeTime(random, tradeDate);
    const fees = (p: number): { feesCents?: number } => (random.chance(p) ? { feesCents: random.int(100, 2_000) } : {});
    const variant = random.weighted([["inFromOutside", 2], ["outOfApp", 1], ["betweenPortfolios", 2], ["betweenAccounts", 2]] as const);
    if (variant === "inFromOutside") {
      const instrument = random.pick([...model.instruments.byHandle.values()]);
      return {
        instrument: instrument.handle,
        tradeDate,
        ...time,
        quantityE8: priceFor(random, instrument.type).quantityE8,
        to: { account: random.pick(brokers).handle, portfolio: random.pick(portfolios), costBasisCents: random.int(1_000, 200_000), ...fees(0.2) },
      };
    }
    const held = holdings(model);
    if (held.length === 0) return undefined;
    const holding = random.pick(held);
    const from: LegParams = { account: model.accountById(holding.accountId).handle, portfolio: model.handleOf(holding.portfolioId)!, ...fees(0.3) };
    const quantityE8 = random.chance(0.4) ? holding.quantity : random.int(1, holding.quantity);
    const common = { instrument: instrumentHandle(model, holding.instrumentId), tradeDate, ...time, quantityE8 };
    if (variant === "outOfApp") return { ...common, from };
    if (variant === "betweenPortfolios") {
      const others = portfolios.filter((p) => p !== from.portfolio);
      if (others.length === 0) return undefined;
      return { ...common, from, to: { account: from.account, portfolio: random.pick(others) } };
    }
    const otherBrokers = brokers.filter((b) => b.handle !== from.account);
    if (otherBrokers.length === 0) return undefined;
    return { ...common, from, to: { account: random.pick(otherBrokers).handle, portfolio: random.pick(portfolios), ...fees(0.1) } };
  },
  request(model, p) {
    const leg = (l: LegParams) => ({
      accountId: model.account(l.account).id,
      portfolioId: model.portfolio(l.portfolio).id,
      ...(l.feesCents === undefined ? {} : { feesCents: l.feesCents }),
      ...(l.costBasisCents === undefined ? {} : { costBasisCents: l.costBasisCents }),
    });
    return {
      method: "POST",
      path: ws(model, "/trades"),
      body: {
        type: "transfer",
        instrumentId: model.instruments.get(p.instrument).id,
        tradeDate: p.tradeDate,
        ...(p.occurredAt === undefined ? {} : { occurredAt: p.occurredAt }),
        quantityE8: p.quantityE8,
        ...(p.from ? { from: leg(p.from) } : {}),
        ...(p.to ? { to: leg(p.to) } : {}),
      },
    };
  },
  predict(model, p) {
    const rows: PositionTrade[] = [];
    const legRow = (id: string, l: LegParams, quantityE8: number, other: string | null) =>
      candidateRow(model, id, {
        type: "transfer",
        account: l.account,
        portfolio: l.portfolio,
        instrument: p.instrument,
        tradeDate: p.tradeDate,
        occurredAt: p.occurredAt,
        amounts: { quantityE8, ...(l.feesCents === undefined ? {} : { feesCents: l.feesCents }), ...(l.costBasisCents === undefined ? {} : { costBasisCents: l.costBasisCents }) },
        transferTradeId: other,
      });
    if (p.from) rows.push(legRow("candidate-from", p.from, -p.quantityE8, p.to ? "candidate-to" : null));
    if (p.to) rows.push(legRow("candidate-to", p.to, p.quantityE8, p.from ? "candidate-from" : null));
    return predictRegime(model, rows) ?? predictHistory(model, rows);
  },
  accept(model, p, body) {
    const { trades } = body as { trades: TradeJson[] };
    const legs = [...(p.from ? [{ leg: p.from, quantityE8: -p.quantityE8 }] : []), ...(p.to ? [{ leg: p.to, quantityE8: p.quantityE8 }] : [])];
    const rows = [...trades].sort((a, b) => a.quantityE8 - b.quantityE8); // the outgoing leg, negative, first
    expectEcho("the recorded transfer", [["rows", legs.length, rows.length]]);
    legs.forEach(({ leg, quantityE8 }, index) => {
      const row = rows[index]!;
      echoTradeRow(model, `the transfer's ${quantityE8 < 0 ? "outgoing" : "incoming"} leg`, {
        type: "transfer",
        account: leg.account,
        portfolio: leg.portfolio,
        instrument: p.instrument,
        tradeDate: p.tradeDate,
        occurredAt: p.occurredAt,
        amounts: {
          quantityE8,
          ...(leg.feesCents === undefined ? {} : { feesCents: leg.feesCents }),
          ...(leg.costBasisCents === undefined ? {} : { costBasisCents: leg.costBasisCents }),
        },
      }, row);
    });
    if (rows.length === 2) {
      expectEcho("the transfer's legs", [
        ["from.transferTradeId", rows[1]!.id, rows[0]!.transferTradeId],
        ["to.transferTradeId", rows[0]!.id, rows[1]!.transferTradeId],
      ]);
    }
    return acceptTrades(model, body);
  },
};

/** `move` names, by handle, the account or portfolio a trade moves to; `patch` holds only plain values. */
type EditTradeParams = { trade: string; patch: Record<string, unknown>; move?: { account?: string; portfolio?: string } };
/** Every account of a trade's group (#741: an edit or a delete checks them before the reconciled lock). */
const groupWrites = (model: WorkspaceModel, p: { trade: string }): string[] =>
  model.tradeGroup(model.trade(p.trade)).map((member) => model.accountById(member.record.accountId).handle);

const editTrade: OperationSpec<EditTradeParams> = {
  trade: true,
  writes: (model, p) => [...groupWrites(model, p), p.move?.account],
  closedFirst: true,
  generate(model, { random }) {
    if (model.trades.size === 0) return undefined;
    const entity = random.pick([...model.trades.values()]);
    const r = entity.record;
    const shiftDate = (): Record<string, unknown> => {
      const date = new Date(Date.parse(`${r.tradeDate}T00:00:00Z`) + random.int(-10, 10) * 86_400_000).toISOString().slice(0, 10);
      const clamped = date < "2025-09-01" ? "2025-09-01" : date > "2026-04-30" ? "2026-04-30" : date;
      return { tradeDate: clamped, occurredAt: null };
    };
    let patch: Record<string, unknown>;
    switch (r.type) {
      case "buy":
      case "sell":
        patch = random.weighted<Record<string, unknown>>([
          [{ feesCents: random.int(0, 2_000) }, 3],
          [{ quantityE8: Math.max(1, Math.round(r.quantityE8 * (0.5 + random.float()))) }, 3],
          [shiftDate(), 2],
          [{ memo: `edited ${random.int(1, 999)}` }, 1],
        ]);
        break;
      case "dividend":
        patch = random.chance(0.5)
          ? { grossCents: r.withholdingForeignCents + r.withholdingDomesticCents + random.int(0, 20_000) }
          : { feesCents: random.int(0, 300) };
        break;
      case "fee":
        patch = random.chance(0.7) ? { feesCents: random.int(100, 3_000) } : shiftDate();
        break;
      case "tax":
        patch = { grossCents: Math.sign(r.grossCents) * random.int(100, 4_000) };
        break;
      case "transfer":
        patch = random.weighted<Record<string, unknown>>([
          [{ quantityE8: Math.max(1, Math.round(Math.abs(r.quantityE8) * (0.5 + random.float()))) }, 2],
          [{ memo: `moved ${random.int(1, 999)}` }, 1],
          [shiftDate(), 1],
        ]);
        break;
      case "split":
        patch = random.chance(0.5) ? { memo: `split ${random.int(1, 999)}` } : shiftDate();
        break;
    }
    // Now and then a single trade moves to another account or portfolio: its cash leg goes with it.
    if (r.type !== "transfer" && r.type !== "split" && random.chance(0.2)) {
      const brokers = model.brokerageAccounts().filter((a) => a.id !== r.accountId);
      const portfolios = [...model.portfolios.values()].filter((p) => p.id !== r.portfolioId);
      const move = {
        ...(brokers.length > 0 && random.chance(0.6) ? { account: random.pick(brokers).handle } : {}),
        ...(portfolios.length > 0 && random.chance(0.6) ? { portfolio: random.pick(portfolios).handle } : {}),
      };
      if (Object.keys(move).length > 0) return { trade: entity.handle, patch, move };
    }
    return { trade: entity.handle, patch };
  },
  request: (model, p) => ({
    method: "PATCH",
    path: ws(model, `/trades/${model.trade(p.trade).record.id}`),
    body: {
      ...p.patch,
      ...(p.move?.account ? { accountId: model.account(p.move.account).id } : {}),
      ...(p.move?.portfolio ? { portfolioId: model.portfolio(p.move.portfolio).id } : {}),
    },
  }),
  predict(model, p) {
    const entity = model.trade(p.trade);
    if (model.isTradeLocked(entity)) return { kind: "refuse", status: 409, code: "reconciled" };
    // A split moved to another date may cover a closed account it did not before.
    return entity.record.type === "split" && entity.record.instrumentId !== null
      ? anyOrClosedHolder(model, instrumentHandle(model, entity.record.instrumentId))
      : ANY;
  },
  accept(model, p, body) {
    const group = model.tradeGroup(model.trade(p.trade));
    const accountsBefore = group.map((t) => model.accountById(t.record.accountId).handle);
    const portfoliosBefore = group.map((t) => model.handleOf(t.record.portfolioId));
    const { trades } = body as { trades: TradeJson[] };
    echoTradeEdit(model, p, group, trades);
    model.applyTradeEdit(group, trades);
    return touched({
      accounts: [...accountsBefore, ...trades.map((t) => model.accountById(t.accountId).handle)],
      portfolios: [...portfoliosBefore, ...trades.map((t) => model.handleOf(t.portfolioId))].filter((h): h is string => h !== undefined),
    });
  },
};

/** What a trade's edit may change on its own: the leg the trade owns, rewritten from it. */
const DERIVED_TRADE_FIELDS: ReadonlySet<string> = new Set(["cashCents", "cashTransactionId", "locked"]);

/**
 * Every row an edit returned is the row as it was with the patch applied, and nothing else
 * changed: the edited trade takes the whole patch (and a move to another account or portfolio);
 * a transfer's two legs and a split's rows take it together, a transfer's quantity with each
 * leg's own sign. A buy or a sell whose quantity changes without a gross gets its gross worked
 * out again. A split row the edit added is checked by the positions oracle.
 */
function echoTradeEdit(model: WorkspaceModel, p: EditTradeParams, group: readonly { record: TradeJson }[], rows: readonly TradeJson[]): void {
  const editedId = model.trade(p.trade).record.id;
  for (const row of rows) {
    const before = group.find((member) => member.record.id === row.id)?.record;
    if (!before) continue;
    const together = before.type === "transfer" || before.type === "split";
    const expected: Record<string, unknown> = { ...before };
    if (row.id === editedId || together) {
      for (const [field, value] of Object.entries(p.patch)) {
        expected[field] = field === "quantityE8" && before.type === "transfer" ? Math.sign(before.quantityE8) * (value as number) : value;
      }
    }
    if (row.id === editedId && p.move?.account) expected.accountId = model.account(p.move.account).id;
    if (row.id === editedId && p.move?.portfolio) expected.portfolioId = model.portfolio(p.move.portfolio).id;
    if ((before.type === "buy" || before.type === "sell") && row.id === editedId && "quantityE8" in p.patch && !("grossCents" in p.patch) && before.instrumentId) {
      const instrument = model.instruments.byId.get(before.instrumentId)!;
      expected.grossCents = amountOf(expected.quantityE8 as Quantity, expected.priceE6 as Price, toPriceFactor(instrument.priceFactorE6), instrument.currency);
    }
    const instant = (value: unknown): unknown => (typeof value === "string" ? new Date(value).toISOString() : value);
    expectEcho(
      `the edited ${before.type} ${model.handleOf(before.id) ?? before.id}`,
      Object.keys(expected)
        .filter((field) => !DERIVED_TRADE_FIELDS.has(field))
        .map((field) => {
          const sent = field === "occurredAt" ? instant(expected[field]) : expected[field];
          const returned = (row as unknown as Record<string, unknown>)[field];
          return [field, sent, field === "occurredAt" ? instant(returned) : returned] as const;
        }),
    );
  }
}

type TradeParams = { trade: string };
const deleteTrade: OperationSpec<TradeParams> = {
  trade: true,
  writes: groupWrites,
  closedFirst: true,
  generate(model, { random }) {
    return model.trades.size === 0 ? undefined : { trade: random.pick([...model.trades.keys()]) };
  },
  request: (model, p) => ({ method: "DELETE", path: ws(model, `/trades/${model.trade(p.trade).record.id}`) }),
  predict: (model, p) => (model.isTradeLocked(model.trade(p.trade)) ? { kind: "refuse", status: 409, code: "reconciled" } : ANY),
  accept(model, p) {
    const group = model.tradeGroup(model.trade(p.trade));
    const accounts = group.map((t) => model.accountById(t.record.accountId).handle);
    const portfolios = group.map((t) => model.handleOf(t.record.portfolioId)).filter((h): h is string => h !== undefined);
    model.removeTrades(group.map((t) => t.handle));
    return touched({ accounts, portfolios });
  },
};

// --- Another workspace's ids (isolation) -------------------------------------------------------

type ForeignParams = { variant: string; foreign: Persona; target: string; own?: string };

function foreignModel(models: ReadonlyMap<Persona, WorkspaceModel>, persona: Persona): WorkspaceModel {
  const model = models.get(persona);
  if (!model) throw new Error(`no ${persona} workspace in this walk`);
  return model;
}

/**
 * A request in this workspace naming an entity of another one: refused as if the entity did not
 * exist, and neither workspace changes.
 */
const foreign: OperationSpec<ForeignParams> = {
  // A new trade names its own account, checked open before the portfolio is looked up (#741); the
  // other variants are refused before anything is written (an unknown account, category or row).
  writes: (_model, p) => (p.variant === "tradeInForeignPortfolio" ? [p.own] : []),
  closedFirst: true,
  generate(model, { random, models }) {
    const others = [...models.values()].filter((m) => m !== model);
    const other = random.pick(others);
    const brokers = model.brokerageAccounts();
    const options: (ForeignParams | undefined)[] = [
      other.accounts.size > 0 ? { variant: "transactionOnForeignAccount", foreign: other.persona, target: random.pick([...other.accounts.keys()]) } : undefined,
      other.trades.size > 0 ? { variant: "patchForeignTrade", foreign: other.persona, target: random.pick([...other.trades.keys()]) } : undefined,
      other.trades.size > 0 ? { variant: "deleteForeignTrade", foreign: other.persona, target: random.pick([...other.trades.keys()]) } : undefined,
      other.transactions.size > 0 ? { variant: "deleteForeignTransaction", foreign: other.persona, target: random.pick([...other.transactions.keys()]) } : undefined,
      other.portfolios.size > 0 && brokers.length > 0
        ? { variant: "tradeInForeignPortfolio", foreign: other.persona, target: random.pick([...other.portfolios.keys()]), own: random.pick(brokers).handle }
        : undefined,
      other.accounts.size > 0 && model.accounts.size > 0
        ? { variant: "transferToForeignAccount", foreign: other.persona, target: random.pick([...other.accounts.keys()]), own: random.pick([...model.accounts.keys()]) }
        : undefined,
    ];
    const available = options.filter((o): o is ForeignParams => o !== undefined);
    return available.length === 0 ? undefined : random.pick(available);
  },
  request(model, p, models) {
    const other = foreignModel(models, p.foreign);
    const instrument = [...model.instruments.byHandle.values()][0]!;
    switch (p.variant) {
      case "transactionOnForeignAccount":
        return {
          method: "POST",
          path: ws(model, `/accounts/${other.account(p.target).id}/transactions`),
          body: { occurredAt: "2025-10-01", splits: [{ categoryId: null, amountCents: 100 }] },
        };
      case "patchForeignTrade":
        return { method: "PATCH", path: ws(model, `/trades/${other.trade(p.target).record.id}`), body: { memo: "not yours" } };
      case "deleteForeignTrade":
        return { method: "DELETE", path: ws(model, `/trades/${other.trade(p.target).record.id}`) };
      case "deleteForeignTransaction": {
        const { record } = other.transaction(p.target);
        return { method: "DELETE", path: ws(model, `/accounts/${record.accountId}/transactions/${record.id}`) };
      }
      case "tradeInForeignPortfolio":
        return {
          method: "POST",
          path: ws(model, "/trades"),
          body: { type: "buy", accountId: model.account(p.own!).id, portfolioId: other.portfolio(p.target).id, instrumentId: instrument.id, tradeDate: "2025-10-01", quantityE8: 100_000_000, priceE6: 10_000_000 },
        };
      case "transferToForeignAccount":
        return {
          method: "POST",
          path: ws(model, "/transfers"),
          body: { sourceAccountId: model.account(p.own!).id, destinationAccountId: other.account(p.target).id, amountCents: 100, occurredAt: "2025-10-01", categoryId: other.ordinaryCategories()[0]?.id },
        };
      default:
        throw new Error(`unknown foreign variant ${p.variant}`);
    }
  },
  predict(_model, p) {
    switch (p.variant) {
      case "tradeInForeignPortfolio":
        return { kind: "refuse", status: 400, code: "unknown_portfolio" };
      case "transferToForeignAccount":
        // The category check comes first when one is given (another workspace's category is unknown here).
        return { kind: "refuse", status: 400 };
      default:
        return { kind: "refuse", status: 404 };
    }
  },
  accept: () => {
    throw new Error("a foreign reference is never accepted");
  },
};

// --- The operation set and the personas' weights -----------------------------------------------

/** Each operation has its own parameter type; `operation()` hands them out as plain `Params`. */
export const OPERATIONS: Readonly<Record<string, OperationSpec<any>>> = {
  createAccount,
  closeAccount,
  addTaxRegime,
  replaceTaxRegimes,
  setWithholdingAgent,
  createPortfolio,
  deletePortfolio,
  income,
  spend,
  brokerDeposit,
  transfer,
  cardPayment,
  fundBroker,
  withdrawBroker,
  offBudgetSavings,
  cardToCard,
  brokerToBroker,
  sweepAccount,
  editTransaction,
  clearTransaction,
  deleteTransaction,
  editLeg,
  editLegAmount,
  deleteLeg,
  syncTradeOwned,
  syncLockedMemo,
  reconcile,
  unlock,
  buy,
  sell,
  oversell,
  dividend,
  fee,
  tax,
  split,
  transferSecurities,
  editTrade,
  deleteTrade,
  foreign,
};

export type OpKind = keyof typeof OPERATIONS;

/**
 * How often each persona does what. The mixed household is the main profile, biased to the seam
 * between the budget and the broker; the pure profiles keep the other side empty and cheap.
 */
export const PROFILES: Readonly<Record<Persona, Readonly<Record<string, number>>>> = {
  household: {
    createAccount: 2,
    income: 6,
    spend: 14,
    // Transfers between budget accounts are weighted up so the walk keeps building the pairs whose
    // legs it edits (#547).
    transfer: 6,
    cardPayment: 4,
    offBudgetSavings: 2,
    cardToCard: 1,
    editTransaction: 4,
    clearTransaction: 7,
    deleteTransaction: 2,
    reconcile: 3,
    unlock: 1,
    syncLockedMemo: 1,
    foreign: 2,
    // An account emptied, then closed, then written to (#735). The close is weighted high, but
    // generated mostly while an account is empty (`closeAccount`).
    sweepAccount: 2,
    closeAccount: 6,
  },
  // The investor's workspace is the walk's `IT` one (#676): its tax regimes change as it goes.
  investor: {
    createAccount: 1,
    closeAccount: 4,
    addTaxRegime: 2,
    replaceTaxRegimes: 1,
    setWithholdingAgent: 1,
    createPortfolio: 1,
    deletePortfolio: 1,
    brokerDeposit: 3,
    brokerToBroker: 1,
    buy: 12,
    sell: 6,
    oversell: 1,
    dividend: 4,
    fee: 2,
    tax: 2,
    split: 1,
    transferSecurities: 3,
    editTrade: 4,
    deleteTrade: 2,
    clearTransaction: 3,
    editLeg: 1,
    reconcile: 2,
    unlock: 1,
    foreign: 2,
  },
  mixed: {
    createAccount: 1,
    sweepAccount: 1,
    closeAccount: 4,
    // No tax country: a regime is refused as not applicable, and must change nothing.
    addTaxRegime: 1,
    createPortfolio: 1,
    deletePortfolio: 1,
    income: 4,
    spend: 6,
    transfer: 3,
    cardPayment: 1,
    fundBroker: 7,
    withdrawBroker: 3,
    editTransaction: 2,
    clearTransaction: 5,
    deleteTransaction: 2,
    buy: 9,
    sell: 4,
    oversell: 1,
    dividend: 3,
    fee: 2,
    tax: 2,
    split: 1,
    transferSecurities: 2,
    editTrade: 4,
    deleteTrade: 2,
    editLeg: 2,
    editLegAmount: 2,
    deleteLeg: 2,
    syncTradeOwned: 2,
    syncLockedMemo: 1,
    reconcile: 4,
    unlock: 1,
    foreign: 2,
  },
};

/** Operations a read-only member or an intruder may try: any write but the foreign ones. */
export const WRITE_KINDS_FOR_REFUSAL: readonly string[] = Object.keys(OPERATIONS).filter((kind) => kind !== "foreign");

export function operation(kind: string): OperationSpec<Params> {
  const spec = OPERATIONS[kind];
  if (!spec) throw new Error(`unknown operation ${kind}`);
  return spec as OperationSpec<Params>;
}

/**
 * What a member who may write must get for an operation: its own prediction, unless it writes to a
 * closed account (ADR 0018), which is refused 409 `account_closed` first when the API checks that
 * first (`closedFirst`), and otherwise wherever the operation's own prediction would let it through.
 */
export function predictOperation(kind: string, model: WorkspaceModel, params: Params, models: ReadonlyMap<Persona, WorkspaceModel>): Prediction {
  const spec = operation(kind);
  const closed = spec.writes(model, params, models).some((handle) => handle !== undefined && model.account(handle).closed);
  if (closed && spec.closedFirst) return ACCOUNT_CLOSED;
  const prediction = spec.predict(model, params, models);
  return closed && (prediction.kind === "accept" || prediction.kind === "any") ? ACCOUNT_CLOSED : prediction;
}
