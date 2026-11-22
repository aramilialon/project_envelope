/**
 * The random walk's operation set (ADR 0013): every write the walk can make, each as
 * - `generate`: the parameters of one such operation, chosen from the model with the seeded
 *   generator, referring to entities by handle (undefined when it cannot happen yet, say a sale
 *   with nothing held);
 * - `request`: the HTTP request it is, with the handles resolved to the workspace's ids;
 * - `predict`: what the API must answer, for the cheap rules only (a read-only member, another
 *   workspace's id, a sale of more than is held, a reconciled leg, a trade's cash leg changed
 *   on its own); anything else is `any`: accepted, or refused with a code from the allowlist and
 *   nothing changed;
 * - `accept`: what an accepted answer adds to the model, and what it touched (for the checks).
 *
 * Personas are weight profiles over this one set (`PROFILES`). A new route joins the walk by
 * adding an operation here and a weight in the profiles that would use it (apps/api/README.md).
 */
import {
  amountOf,
  computePositions,
  isValidationError,
  PRICE_FACTOR_ONE,
  toPriceFactor,
  validatePositionHistory,
  type PortfolioPosition,
  type PositionTrade,
  type Price,
  type Quantity,
} from "@envelope/core";

import type { HttpMethod } from "./driver.ts";
import { expectEcho, instantEcho } from "./invariants.ts";
import { localMidnight, type WalkRandom } from "./generator.ts";
import {
  amountOf as transactionAmount,
  sortableHandle,
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
  | { readonly kind: "refuse"; readonly status: number; readonly code?: string }
  | { readonly kind: "any" }
  /** A sync upload is answered 201 with one outcome per change: a refused change has its own. */
  | { readonly kind: "syncOutcome"; readonly outcome: string };

export interface Touched {
  /** Account handles whose transactions (and, for a brokerage account, positions) to check. */
  readonly accounts: Set<string>;
  /** Portfolio handles whose positions to check. */
  readonly portfolios: Set<string>;
  readonly budget: boolean;
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
  generate(model: WorkspaceModel, ctx: GenerateContext): P | undefined;
  request(model: WorkspaceModel, params: P, models: ReadonlyMap<Persona, WorkspaceModel>): WalkRequest;
  predict(model: WorkspaceModel, params: P, models: ReadonlyMap<Persona, WorkspaceModel>): Prediction;
  accept(model: WorkspaceModel, params: P, body: unknown): Touched;
}

const ACCEPT: Prediction = { kind: "accept" };
const ANY: Prediction = { kind: "any" };
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

function touched(partial: Partial<{ accounts: Iterable<string>; portfolios: Iterable<string>; budget: boolean; created: Touched["created"] }>): Touched {
  return {
    accounts: new Set(partial.accounts ?? []),
    portfolios: new Set(partial.portfolios ?? []),
    budget: partial.budget ?? false,
    created: partial.created ?? [],
  };
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

type CreateAccountParams = { type: AccountType; onBudget: boolean; name: string };
const createAccount: OperationSpec<CreateAccountParams> = {
  generate(model, { random }) {
    const limits = ACCOUNT_LIMITS[model.persona];
    const open = (Object.keys(limits) as AccountType[]).filter(
      (type) => [...model.accounts.values()].filter((a) => a.type === type).length < (limits[type] ?? 0),
    );
    if (open.length === 0) return undefined;
    const type = random.pick(open);
    // A savings account is on budget or not (a deposit kept apart); the rest take their default.
    const onBudget = type === "brokerage" ? false : type === "savings" ? random.chance(0.5) : true;
    return { type, onBudget, name: `${type} ${model.accounts.size + 1}` };
  },
  request: (model, p) => ({ method: "POST", path: ws(model, "/accounts"), body: { name: p.name, type: p.type, currency: "EUR", onBudget: p.onBudget } }),
  predict: () => ACCEPT,
  accept(model, p, body) {
    const record = body as Parameters<WorkspaceModel["addAccount"]>[0] & { name: string };
    expectEcho("createAccount", [
      ["name", p.name, record.name],
      ["type", p.type, record.type],
      ["currency", "EUR", record.currency],
      ["onBudget", p.onBudget, record.onBudget],
    ]);
    const account = model.addAccount(record);
    return touched({ accounts: [account.handle], budget: true, created: [{ kind: "account", id: account.id }] });
  },
};

type CreatePortfolioParams = { name: string };
const createPortfolio: OperationSpec<CreatePortfolioParams> = {
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

const income: OperationSpec<TransactionParams> = {
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

type EditTransactionParams = { tx: string; change: "memo" | "payee" | "amount" | "status"; value: string | number };
const editTransaction: OperationSpec<EditTransactionParams> = {
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

const clearTransaction: OperationSpec<TxParams> = {
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

const deleteTransaction: OperationSpec<TxParams> = {
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

function singleTradeSpec(generate: OperationSpec<TradeFields>["generate"]): OperationSpec<TradeFields> {
  return {
    trade: true,
    generate,
    request: (model, p) => ({ method: "POST", path: ws(model, "/trades"), body: tradeBody(model, p) }),
    predict: (model, p) => predictHistory(model, [candidateRow(model, "candidate", p)]),
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
  // The rows a split stands for are the API's to work out (every holding at the start of its date).
  predict: () => ANY,
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
    return predictHistory(model, rows);
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
const editTrade: OperationSpec<EditTradeParams> = {
  trade: true,
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
  predict: (model, p) => (model.isTradeLocked(model.trade(p.trade)) ? { kind: "refuse", status: 409, code: "reconciled" } : ANY),
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
  },
  investor: {
    createAccount: 1,
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
