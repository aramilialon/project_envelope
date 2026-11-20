/**
 * The random walk's model (ADR 0013): nothing but the log of what the API accepted, each entity
 * stored as the API returned it, under a handle ("a3", "t12") that the operation log uses in
 * place of its id. A log therefore replays in a fresh workspace, where every id is new: the
 * handles come out the same as long as the same operations are accepted in the same order.
 *
 * The expected state is never kept here: `invariants.ts` works it out from this log with
 * `@envelope/core`. The only rules the model applies itself are ADR 0012's for a trade's cash
 * leg (its amount, account and date come from the trade; its memo, payee and status are its own),
 * which is what the walk checks the API against.
 */
import {
  PRICE_FACTOR_ONE,
  toPriceFactor,
  tradeCashCents,
  type Price,
  type PositionTrade,
  type Quantity,
} from "@envelope/core";

import { localMidnight } from "./generator.ts";

export type Persona = "household" | "investor" | "mixed";
export type Role = "owner" | "editor" | "read_only";
export type AccountType = "checking" | "savings" | "cash" | "credit_card" | "brokerage";
export type TransactionStatus = "pending" | "cleared" | "reconciled";

/** A transaction as `GET .../transactions` returns it (the fields the walk reads). */
export interface TransactionJson {
  readonly id: string;
  readonly accountId: string;
  readonly occurredAt: string;
  readonly budgetDate: string;
  readonly payee: string | null;
  readonly memo: string | null;
  readonly status: TransactionStatus;
  readonly transferId: string | null;
  readonly tradeId: string | null;
  readonly splits: readonly { readonly id?: string; readonly categoryId: string | null; readonly amountCents: number; readonly memo: string | null }[];
}

/** A trade as the trades API returns it. */
export interface TradeJson {
  readonly id: string;
  readonly accountId: string;
  readonly portfolioId: string;
  readonly instrumentId: string | null;
  readonly type: PositionTrade["type"];
  readonly tradeDate: string;
  readonly occurredAt: string | null;
  readonly quantityE8: number;
  readonly priceE6: number;
  readonly grossCents: number;
  readonly feesCents: number;
  readonly transactionTaxCents: number;
  readonly accruedInterestCents: number;
  readonly withholdingForeignCents: number;
  readonly withholdingDomesticCents: number;
  readonly gainTaxCents: number;
  readonly taxKind: PositionTrade["taxKind"];
  readonly costBasisCents: number | null;
  readonly splitFrom: number | null;
  readonly splitTo: number | null;
  readonly transferTradeId: string | null;
  readonly memo: string | null;
  readonly createdAt: string;
  readonly cashCents: number;
  readonly cashTransactionId: string | null;
  readonly locked: boolean;
}

export interface AccountEntity {
  readonly handle: string;
  readonly id: string;
  readonly type: AccountType;
  readonly onBudget: boolean;
  readonly currency: string;
  /** Handle of an on-budget card's payment category. */
  readonly paymentCategory: string | null;
}

export interface CategoryEntity {
  readonly handle: string;
  readonly id: string;
  readonly name: string;
  readonly payment: boolean;
}

export interface PortfolioEntity {
  readonly handle: string;
  readonly id: string;
}

export interface InstrumentEntity {
  readonly handle: string;
  readonly id: string;
  readonly type: "stock" | "fund" | "government_bond";
  readonly currency: string;
  readonly priceFactorE6: number;
}

export interface TransactionEntity {
  readonly handle: string;
  record: TransactionJson;
  /** The reconciliation that reconciled it, while it is reconciled. */
  reconciliationId: string | null;
}

export interface TradeEntity {
  readonly handle: string;
  record: TradeJson;
}

export interface ReconciliationEntity {
  readonly id: string;
  readonly account: string;
  readonly date: string;
  readonly statementBalanceCents: number;
  /** Order of creation, to break ties of `date` as the API does (created_at). */
  readonly sequence: number;
  broken: boolean;
}

export interface WalkUser {
  readonly userId: string;
  token(): Promise<string>;
}

/** Instruments are a shared catalog: one set for the whole walk, the same handles in every workspace. */
export class InstrumentCatalog {
  readonly byHandle = new Map<string, InstrumentEntity>();
  readonly byId = new Map<string, InstrumentEntity>();

  add(entity: InstrumentEntity): void {
    this.byHandle.set(entity.handle, entity);
    this.byId.set(entity.id, entity);
  }

  get(handle: string): InstrumentEntity {
    const entity = this.byHandle.get(handle);
    if (!entity) throw new Error(`unknown instrument handle ${handle}`);
    return entity;
  }
}

/** Midnight UTC of a date: how the API sorts a trade recorded without a time. */
function occurredAtOrMidnight(trade: TradeJson): string {
  return trade.occurredAt ?? `${trade.tradeDate}T00:00:00.000Z`;
}

export class WorkspaceModel {
  readonly accounts = new Map<string, AccountEntity>();
  readonly categories = new Map<string, CategoryEntity>();
  readonly portfolios = new Map<string, PortfolioEntity>();
  readonly transactions = new Map<string, TransactionEntity>();
  readonly trades = new Map<string, TradeEntity>();
  readonly reconciliations: ReconciliationEntity[] = [];
  /** Every id the workspace's entities ever had, by handle and back. */
  private readonly handleById = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  /** Handles given out since `takeCreated` was last called: the log records them per step. */
  private created: string[] = [];
  private reconciliationSequence = 0;

  readonly persona: Persona;
  readonly workspaceId: string;
  readonly users: Readonly<Record<Role, WalkUser>>;
  readonly instruments: InstrumentCatalog;

  constructor(persona: Persona, workspaceId: string, users: Readonly<Record<Role, WalkUser>>, instruments: InstrumentCatalog) {
    this.persona = persona;
    this.workspaceId = workspaceId;
    this.users = users;
    this.instruments = instruments;
  }

  private nextHandle(prefix: string, id: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    const handle = `${prefix}${n}`;
    this.handleById.set(id, handle);
    this.created.push(handle);
    return handle;
  }

  takeCreated(): string[] {
    const created = this.created;
    this.created = [];
    return created;
  }

  handleOf(id: string): string | undefined {
    return this.handleById.get(id);
  }

  // --- Accounts, categories, portfolios ---------------------------------------------------

  addAccount(record: { id: string; type: AccountType; onBudget: boolean; currency: string; paymentCategoryId: string | null }): AccountEntity {
    let paymentCategory: string | null = null;
    if (record.paymentCategoryId) {
      paymentCategory = this.nextHandle("c", record.paymentCategoryId);
      this.categories.set(paymentCategory, { handle: paymentCategory, id: record.paymentCategoryId, name: "payment", payment: true });
    }
    const handle = this.nextHandle("a", record.id);
    const entity: AccountEntity = { handle, id: record.id, type: record.type, onBudget: record.onBudget, currency: record.currency, paymentCategory };
    this.accounts.set(handle, entity);
    return entity;
  }

  account(handle: string): AccountEntity {
    const entity = this.accounts.get(handle);
    if (!entity) throw new Error(`unknown account handle ${handle} in ${this.persona}`);
    return entity;
  }

  accountById(id: string): AccountEntity {
    const handle = this.handleById.get(id);
    return this.account(handle ?? `<id ${id}>`);
  }

  addCategory(record: { id: string; name: string }): CategoryEntity {
    const handle = this.nextHandle("c", record.id);
    const entity: CategoryEntity = { handle, id: record.id, name: record.name, payment: false };
    this.categories.set(handle, entity);
    return entity;
  }

  category(handle: string): CategoryEntity {
    const entity = this.categories.get(handle);
    if (!entity) throw new Error(`unknown category handle ${handle} in ${this.persona}`);
    return entity;
  }

  categoryByName(name: string): CategoryEntity | undefined {
    return [...this.categories.values()].find((category) => category.name === name);
  }

  addPortfolio(id: string): PortfolioEntity {
    const handle = this.nextHandle("p", id);
    const entity: PortfolioEntity = { handle, id };
    this.portfolios.set(handle, entity);
    return entity;
  }

  portfolio(handle: string): PortfolioEntity {
    const entity = this.portfolios.get(handle);
    if (!entity) throw new Error(`unknown portfolio handle ${handle} in ${this.persona}`);
    return entity;
  }

  // --- Transactions --------------------------------------------------------------------------

  addTransaction(record: TransactionJson): TransactionEntity {
    const handle = this.nextHandle("t", record.id);
    const entity: TransactionEntity = { handle, record, reconciliationId: null };
    this.transactions.set(handle, entity);
    return entity;
  }

  transaction(handle: string): TransactionEntity {
    const entity = this.transactions.get(handle);
    if (!entity) throw new Error(`unknown transaction handle ${handle} in ${this.persona}`);
    return entity;
  }

  transactionById(id: string): TransactionEntity | undefined {
    const handle = this.handleById.get(id);
    return handle === undefined ? undefined : this.transactions.get(handle);
  }

  removeTransaction(handle: string): void {
    this.transactions.delete(handle);
  }

  /** The other leg of a transfer, if `entity` is one. */
  transferPartner(entity: TransactionEntity): TransactionEntity | undefined {
    return entity.record.transferId === null ? undefined : this.transactionById(entity.record.transferId);
  }

  // --- Trades and their cash legs ------------------------------------------------------------

  trade(handle: string): TradeEntity {
    const entity = this.trades.get(handle);
    if (!entity) throw new Error(`unknown trade handle ${handle} in ${this.persona}`);
    return entity;
  }

  tradeById(id: string): TradeEntity | undefined {
    const handle = this.handleById.get(id);
    return handle === undefined ? undefined : this.trades.get(handle);
  }

  /** The cash leg the model expects for a trade (ADR 0012), if it moves cash. */
  legOf(trade: TradeEntity): TransactionEntity | undefined {
    return [...this.transactions.values()].find((entity) => entity.record.tradeId === trade.record.id);
  }

  /**
   * Trade rows in an order that does not depend on their ids: the rows of one request (a
   * transfer's two legs, a split's rows) come back in an order that ties on random UUIDs, and
   * handles given out in that order would differ between two runs of the same seed. A transfer's
   * outgoing leg comes first; a split's rows go by account, then portfolio handle.
   */
  sortTradeRows(records: readonly TradeJson[]): TradeJson[] {
    const key = (record: TradeJson): string =>
      [
        record.type,
        record.type === "transfer" && record.quantityE8 < 0 ? "0" : "1",
        sortableHandle(this.handleOf(record.accountId)),
        sortableHandle(this.handleOf(record.portfolioId)),
        sortableHandle(record.instrumentId === null ? undefined : this.instruments.byId.get(record.instrumentId)?.handle),
      ].join("|");
    return [...records].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  }

  /** Records trades the API created, each with the cash leg ADR 0012 says it owns. */
  addTrades(records: readonly TradeJson[]): TradeEntity[] {
    return this.sortTradeRows(records).map((record) => {
      const handle = this.nextHandle("tr", record.id);
      const entity: TradeEntity = { handle, record };
      this.trades.set(handle, entity);
      this.syncLeg(entity, undefined);
      return entity;
    });
  }

  /**
   * Records what an edit of `group` (a trade and the rows that go with it) returned, and what it
   * does to each one's leg. A split stands for every holding at the start of its date, so moving
   * its date can add rows (a holding that only exists by the new date) and remove some: the
   * split's rows become exactly the ones returned.
   */
  applyTradeEdit(group: readonly TradeEntity[], records: readonly TradeJson[]): void {
    for (const record of this.sortTradeRows(records)) {
      const entity = this.tradeById(record.id);
      if (!entity) {
        if (record.type !== "split") throw new Error(`an edit returned trade ${record.id}, which the model does not have`);
        this.addTrades([record]);
        continue;
      }
      const before = entity.record;
      entity.record = record;
      this.syncLeg(entity, before);
    }
    const returned = new Set(records.map((record) => record.id));
    const dropped = group.filter((member) => member.record.type === "split" && !returned.has(member.record.id));
    this.removeTrades(dropped.map((member) => member.handle));
  }

  /** Forgets trades the API deleted, with their legs. */
  removeTrades(handles: readonly string[]): void {
    for (const handle of handles) {
      const entity = this.trade(handle);
      const leg = this.legOf(entity);
      if (leg) this.transactions.delete(leg.handle);
      this.trades.delete(handle);
    }
  }

  /**
   * The rows a trade is edited and deleted with (design.md, "Trade"): a transfer's other leg, every
   * row of a split (same instrument, same date).
   */
  tradeGroup(entity: TradeEntity): TradeEntity[] {
    const { record } = entity;
    if (record.type === "transfer" && record.transferTradeId !== null) {
      const partner = this.tradeById(record.transferTradeId);
      return partner ? [entity, partner] : [entity];
    }
    if (record.type === "split") {
      return [...this.trades.values()].filter(
        (other) => other.record.type === "split" && other.record.instrumentId === record.instrumentId && other.record.tradeDate === record.tradeDate,
      );
    }
    return [entity];
  }

  /** Whether the API must refuse to edit or delete a trade: its own or its transfer partner's cash leg is reconciled. */
  isTradeLocked(entity: TradeEntity): boolean {
    return this.tradeGroup(entity).some((member) => this.legOf(member)?.record.status === "reconciled");
  }

  /**
   * Keeps a trade's cash leg as ADR 0012 says: created pending with the trade, amount = the cash
   * the trade moves, on its account, dated on its trade date; rewritten in place by an edit
   * (same id, payee and memo; a cleared leg whose amount, account or date changed goes back to
   * pending); deleted when the trade stops moving cash.
   */
  private syncLeg(entity: TradeEntity, before: TradeJson | undefined): void {
    const { record } = entity;
    const existing = before === undefined ? undefined : this.legOf(entity);
    const cash = tradeCashCents(record);
    if (cash === 0 || record.cashTransactionId === null) {
      if (existing) this.transactions.delete(existing.handle);
      return;
    }
    const changed =
      existing !== undefined &&
      (existing.record.accountId !== record.accountId ||
        existing.record.budgetDate !== record.tradeDate ||
        existing.record.splits[0]?.amountCents !== cash);
    const leg: TransactionJson = {
      id: record.cashTransactionId,
      accountId: record.accountId,
      // Midnight of the trade date in the workspace's time zone (ADR 0012), moved with the trade.
      occurredAt: localMidnight(record.tradeDate),
      budgetDate: record.tradeDate,
      payee: existing?.record.payee ?? null,
      memo: existing?.record.memo ?? null,
      status: existing === undefined ? "pending" : changed && existing.record.status === "cleared" ? "pending" : existing.record.status,
      transferId: null,
      tradeId: record.id,
      splits: [{ categoryId: null, amountCents: cash, memo: null }],
    };
    if (existing && existing.record.id === leg.id) {
      existing.record = leg;
    } else {
      if (existing) this.transactions.delete(existing.handle);
      this.addTransaction(leg);
    }
  }

  // --- Reconciliations ---------------------------------------------------------------------

  /** The statement balance of the account's last reconciliation still in force, as the API reads it. */
  lastReconciledBalance(account: string): number {
    const last = this.reconciliations
      .filter((r) => r.account === account && !r.broken)
      .sort((a, b) => (a.date === b.date ? b.sequence - a.sequence : a.date < b.date ? 1 : -1))[0];
    return last?.statementBalanceCents ?? 0;
  }

  addReconciliation(id: string, account: string, date: string, statementBalanceCents: number): void {
    this.reconciliations.push({ id, account, date, statementBalanceCents, sequence: this.reconciliationSequence++, broken: false });
  }

  breakReconciliation(id: string): void {
    const reconciliation = this.reconciliations.find((r) => r.id === id);
    if (reconciliation) reconciliation.broken = true;
  }

  // --- Views used by the generator, the predictions and the oracle --------------------------

  /** Every trade of the workspace as `@envelope/core`'s replay takes it. */
  positionTrades(): PositionTrade[] {
    return [...this.trades.values()].map((entity) => toPositionTrade(entity.record, this));
  }

  brokerageAccounts(): AccountEntity[] {
    return [...this.accounts.values()].filter((account) => account.type === "brokerage");
  }

  /** On-budget accounts that hold cash (not cards). */
  budgetCashAccounts(): AccountEntity[] {
    return [...this.accounts.values()].filter((account) => account.onBudget && account.type !== "credit_card");
  }

  cards(): AccountEntity[] {
    return [...this.accounts.values()].filter((account) => account.type === "credit_card");
  }

  ordinaryCategories(): CategoryEntity[] {
    return [...this.categories.values()].filter((category) => !category.payment);
  }

  transactionsOf(account: AccountEntity): TransactionEntity[] {
    return [...this.transactions.values()].filter((entity) => entity.record.accountId === account.id);
  }

  balanceOf(account: AccountEntity): number {
    return this.transactionsOf(account).reduce((sum, entity) => sum + amountOf(entity.record), 0);
  }
}

/**
 * A handle that sorts by its number ("a2" before "a10"); a missing one sorts last. Anything the
 * generator picks from, or hands out handles in, is ordered by handles, never by ids.
 */
export function sortableHandle(handle: string | undefined): string {
  if (handle === undefined) return "~";
  const match = /^([a-z]+)(\d+)$/.exec(handle);
  return match ? `${match[1]}${match[2]!.padStart(6, "0")}` : handle;
}

/** A transaction's amount: the sum of its splits. */
export function amountOf(record: TransactionJson): number {
  return record.splits.reduce((sum, split) => sum + split.amountCents, 0);
}

/** A stored trade as `@envelope/core`'s replay takes it, the same mapping the API's repository applies. */
export function toPositionTrade(record: TradeJson, model: WorkspaceModel): PositionTrade {
  const account = model.accountById(record.accountId);
  const instrument = record.instrumentId === null ? undefined : model.instruments.byId.get(record.instrumentId);
  return {
    id: record.id,
    accountId: record.accountId,
    portfolioId: record.portfolioId,
    instrumentId: record.instrumentId,
    type: record.type,
    date: record.tradeDate,
    occurredAt: occurredAtOrMidnight(record),
    createdAt: record.createdAt,
    currency: account.currency,
    quantity: record.quantityE8 as Quantity,
    price: record.priceE6 as Price,
    priceFactor: instrument ? toPriceFactor(instrument.priceFactorE6) : PRICE_FACTOR_ONE,
    grossCents: record.grossCents,
    feesCents: record.feesCents,
    transactionTaxCents: record.transactionTaxCents,
    accruedInterestCents: record.accruedInterestCents,
    withholdingForeignCents: record.withholdingForeignCents,
    withholdingDomesticCents: record.withholdingDomesticCents,
    gainTaxCents: record.gainTaxCents,
    taxKind: record.taxKind,
    costBasisCents: record.costBasisCents,
    splitFrom: record.splitFrom,
    splitTo: record.splitTo,
    transferTradeId: record.transferTradeId,
  };
}
