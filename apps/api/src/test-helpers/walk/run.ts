/**
 * Runs one seeded random walk through the API (ADR 0013): sets up three workspaces (a household
 * that only budgets, an investor who only invests, and a mixed household that does both), then
 * takes `steps` steps, each one operation of one persona, interleaved by the seed. After every
 * step it checks the touched workspace and probes isolation; every `fullEvery` steps and at the
 * end it compares everything. On a failure it writes the operation log as JSON, so
 * `WALK_REPLAY=<file>` replays exactly those operations in fresh workspaces.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeJwt } from "jose";

import type { DbPool } from "../../db/pool.ts";
import type { KeycloakTestRealm } from "../keycloak.ts";
import type { WalkDriver, WalkResponse } from "./driver.ts";
import { LAST_MONTH, WalkRandom } from "./generator.ts";
import {
  checkAccountPositions,
  checkAccountTransactions,
  checkBrokerageAccount,
  checkBudgetMonth,
  checkPortfolioPositions,
  checkTrades,
  compareDigests,
  expectEqual,
  fail,
  fullCheck,
  get,
  oraclePositions,
  probeIsolation,
  WalkFailure,
  WorkspaceDigest,
  type CheckContext,
} from "./invariants.ts";
import { amountOf, InstrumentCatalog, WorkspaceModel, type Persona, type Role, type TransactionJson, type WalkUser } from "./model.ts";
import { operation, PROFILES, REFUSAL_ALLOWLIST, WRITE_KINDS_FOR_REFUSAL, type Op, type Prediction } from "./operations.ts";

export const PERSONAS: readonly Persona[] = ["household", "investor", "mixed"];
const ROLES: readonly Role[] = ["owner", "editor", "read_only"];

/** How often each persona takes the step: the mixed household, the seam between budget and broker, most. */
const PERSONA_WEIGHTS: readonly (readonly [Persona, number])[] = [
  ["mixed", 2],
  ["household", 1],
  ["investor", 1],
];

export interface WalkEnvironment {
  readonly driver: WalkDriver;
  readonly superuserPool: DbPool;
  readonly users: Readonly<Record<Persona, Readonly<Record<Role, WalkUser>>>>;
}

export interface LoggedStep {
  readonly step: number;
  readonly op: Op;
  /** The status the API answered when the log was written; informational on a replay. */
  status?: number;
  /** The handles the step gave out (an entity, its transfer partner, a trade's cash leg). */
  created?: string[];
}

export interface WalkLog {
  readonly version: 1;
  readonly seed: number;
  readonly steps: number;
  readonly driver: string;
  readonly ops: LoggedStep[];
}

export interface WalkOptions {
  readonly seed: number;
  readonly steps: number;
  /** A full comparison of every workspace every this many steps (and always at the end). */
  readonly fullEvery?: number;
  /** Replays these operations instead of generating new ones. */
  readonly replay?: WalkLog;
  /** Where a failing walk writes its log; the system's temporary directory by default. */
  readonly logDir?: string;
}

export interface WalkResult {
  readonly seed: number;
  readonly steps: number;
  readonly accepted: number;
  readonly refused: number;
  readonly durationMs: number;
  /** Per operation kind: [accepted, refused]. */
  readonly byKind: Record<string, [number, number]>;
}

/** Keycloak users for every persona and role, each with a token renewed before it expires. */
export async function createWalkUsers(realm: KeycloakTestRealm, driver: WalkDriver): Promise<Record<Persona, Record<Role, WalkUser>>> {
  const users = {} as Record<Persona, Record<Role, WalkUser>>;
  for (const persona of PERSONAS) {
    const byRole = {} as Record<Role, WalkUser>;
    for (const role of ROLES) {
      const user = await realm.createUser();
      const token = renewingToken(() => user.getToken());
      // The first authenticated request creates the local user.
      const me = await driver.request("GET", "/me", undefined, await token());
      if (me.status !== 200) throw new Error(`GET /me answered ${me.status}`);
      byRole[role] = { userId: (me.body as { userId: string }).userId, token };
    }
    users[persona] = byRole;
  }
  return users;
}

function renewingToken(fetchToken: () => Promise<string>): () => Promise<string> {
  let token: string | undefined;
  let expiresAt = 0;
  return async () => {
    if (!token || expiresAt - Date.now() < 20_000) {
      token = await fetchToken();
      expiresAt = (decodeJwt(token).exp ?? 0) * 1000;
    }
    return token;
  };
}

/** The status and stable code of a refusal: `code`, else an `error` that is a code, else "text". */
function refusalCode(body: unknown): string {
  const { code, error } = (body ?? {}) as { code?: unknown; error?: unknown };
  if (typeof code === "string") return code;
  if (typeof error === "string" && /^[a-z0-9_]+$/.test(error)) return error;
  return "text";
}

async function expectCreated(driver: WalkDriver, method: "POST", path: string, body: unknown, token: string): Promise<Record<string, unknown>> {
  const response = await driver.request(method, path, body, token);
  if (response.status !== 201) throw new Error(`setup: ${method} ${path} answered ${response.status}: ${JSON.stringify(response.body)}`);
  return response.body as Record<string, unknown>;
}

/**
 * The fixed start of every walk, not part of the log: the shared instruments, and per persona a
 * workspace (with an editor and a read-only member) holding what it starts from.
 */
async function setUp(env: WalkEnvironment): Promise<{ models: Map<Persona, WorkspaceModel>; instruments: InstrumentCatalog }> {
  const { driver, superuserPool } = env;
  const instruments = new InstrumentCatalog();
  const creator = await env.users.mixed.owner.token();
  const listings: readonly { handle: string; type: "stock" | "fund" | "government_bond"; priceFactorE6: number }[] = [
    { handle: "i1", type: "stock", priceFactorE6: 1_000_000 },
    { handle: "i2", type: "fund", priceFactorE6: 1_000_000 },
    // A bond quoted in percent of its nominal.
    { handle: "i3", type: "government_bond", priceFactorE6: 10_000 },
  ];
  for (const listing of listings) {
    const created = await expectCreated(driver, "POST", "/instruments", {
      ticker: `W${randomBytes(5).toString("hex").toUpperCase()}`,
      exchange: "XMIL",
      name: `Walk ${listing.type}`,
      type: listing.type,
      currency: "EUR",
      priceFactorE6: listing.priceFactorE6,
    }, creator);
    instruments.add({ handle: listing.handle, id: created.id as string, type: listing.type, currency: "EUR", priceFactorE6: listing.priceFactorE6 });
  }

  const models = new Map<Persona, WorkspaceModel>();
  for (const persona of PERSONAS) {
    const users = env.users[persona];
    const token = await users.owner.token();
    const workspace = await expectCreated(driver, "POST", "/workspaces", { name: `Walk ${persona}`, baseCurrency: "EUR", timeZone: "Europe/Rome" }, token);
    const model = new WorkspaceModel(persona, workspace.id as string, users, instruments);
    models.set(persona, model);
    for (const role of ["editor", "read_only"] as const) {
      await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, $3)", [users[role].userId, model.workspaceId, role]);
    }
    const path = (suffix: string) => `/workspaces/${model.workspaceId}${suffix}`;
    if (persona !== "investor") {
      for (const [group, names] of [["Everyday", ["Groceries", "Rent", "Fun"]], ["Saving", ["Investments"]]] as const) {
        const { id: groupId } = await expectCreated(driver, "POST", path("/category-groups"), { name: group }, token);
        for (const name of names) {
          const category = await expectCreated(driver, "POST", path("/categories"), { name, groupId }, token);
          model.addCategory({ id: category.id as string, name });
        }
      }
      const checking = await expectCreated(driver, "POST", path("/accounts"), { name: "Checking", type: "checking", currency: "EUR" }, token);
      model.addAccount(checking as Parameters<WorkspaceModel["addAccount"]>[0]);
    }
    if (persona !== "household") {
      const broker = await expectCreated(driver, "POST", path("/accounts"), { name: "Broker", type: "brokerage", currency: "EUR" }, token);
      model.addAccount(broker as Parameters<WorkspaceModel["addAccount"]>[0]);
      const portfolio = await expectCreated(driver, "POST", path("/portfolios"), { name: "Core" }, token);
      model.addPortfolio(portfolio.id as string);
    }
  }
  return { models, instruments };
}

async function tearDown(env: WalkEnvironment, models: ReadonlyMap<Persona, WorkspaceModel>, instruments: InstrumentCatalog): Promise<void> {
  // The trades go with their workspaces; only then can the instruments they referenced go.
  await env.superuserPool.query("DELETE FROM workspaces WHERE id = ANY($1)", [[...models.values()].map((m) => m.workspaceId)]);
  await env.superuserPool.query("DELETE FROM instruments WHERE id = ANY($1)", [[...instruments.byId.keys()]]);
}

function generateOp(random: WalkRandom, progress: number, models: ReadonlyMap<Persona, WorkspaceModel>): Op {
  const persona = random.weighted(PERSONA_WEIGHTS);
  const model = models.get(persona)!;
  const roll = random.float();
  const actor: Op["actor"] =
    roll < 0.05 ? "read_only" : roll < 0.08 ? `intruder:${random.pick(PERSONAS.filter((p) => p !== persona))}` : roll < 0.2 ? "editor" : "owner";
  const refusedActor = actor === "read_only" || actor.startsWith("intruder:");
  const weights = Object.entries(PROFILES[persona]).filter(([kind]) => !refusedActor || WRITE_KINDS_FOR_REFUSAL.includes(kind));
  for (let attempt = 0; attempt < 50; attempt++) {
    const kind = random.weighted(weights);
    const params = operation(kind).generate(model, { random, progress, models });
    if (params !== undefined) {
      return { kind, ws: persona, actor, params };
    }
  }
  throw new Error(`no operation of ${persona} could be generated in 50 attempts`);
}

class Walk {
  private readonly env: WalkEnvironment;
  private readonly models: ReadonlyMap<Persona, WorkspaceModel>;
  private readonly digest: WorkspaceDigest;
  private readonly ctx: CheckContext;
  private accepted = 0;
  private refused = 0;
  readonly byKind: Record<string, [number, number]> = {};

  constructor(env: WalkEnvironment, models: ReadonlyMap<Persona, WorkspaceModel>, digest: WorkspaceDigest) {
    this.env = env;
    this.models = models;
    this.digest = digest;
    this.ctx = { driver: env.driver };
  }

  get counts(): { accepted: number; refused: number } {
    return { accepted: this.accepted, refused: this.refused };
  }

  private count(kind: string, accepted: boolean): void {
    const entry = (this.byKind[kind] ??= [0, 0]);
    entry[accepted ? 0 : 1]++;
    if (accepted) this.accepted++;
    else this.refused++;
  }

  private model(persona: Persona): WorkspaceModel {
    const model = this.models.get(persona);
    if (!model) throw new Error(`no ${persona} workspace`);
    return model;
  }

  async step(logged: LoggedStep): Promise<void> {
    const { op } = logged;
    const model = this.model(op.ws);
    const spec = operation(op.kind);
    const intruder = op.actor.startsWith("intruder:") ? this.model(op.actor.slice("intruder:".length) as Persona) : undefined;
    const prediction: Prediction =
      op.actor === "read_only" ? { kind: "refuse", status: 403 } : intruder ? { kind: "refuse", status: 403 } : spec.predict(model, op.params, this.models);
    const request = spec.request(model, op.params, this.models);
    const token = intruder ? await intruder.users.owner.token() : await model.users[op.actor as Role].token();

    // Every workspace the request names or could reach: its own, and a foreign one it refers to.
    const foreignPersona = typeof op.params.foreign === "string" ? (op.params.foreign as Persona) : undefined;
    const reachable = [model, ...(intruder ? [intruder] : []), ...(foreignPersona ? [this.model(foreignPersona)] : [])].map((m) => m.workspaceId);
    const before = prediction.kind === "accept" ? undefined : await this.digest.read(this.env.superuserPool, reachable);

    // In the mixed household, a trade must leave the budget as it was. The last month of the window
    // carries every earlier month over, so it is the one read before and after; the full check
    // compares every month with the oracle, which no trade can move.
    const budgetPath = `/workspaces/${model.workspaceId}/budget-months/${LAST_MONTH}`;
    const budgetBefore = spec.trade && op.ws === "mixed" ? await get(this.ctx, model, budgetPath) : undefined;

    const response = await this.env.driver.request(request.method, request.path, request.body, token);
    logged.status = response.status;
    if (response.status >= 500) fail(`${request.method} ${request.path} answered ${response.status}: ${JSON.stringify(response.body)}`);

    if (prediction.kind === "syncOutcome") {
      const outcome = (response.body as { results?: { outcome?: string }[] } | undefined)?.results?.[0]?.outcome;
      if (response.status !== 201 || outcome !== prediction.outcome) {
        fail(`sync upload answered ${response.status} with outcome ${String(outcome)}, expected 201 with ${prediction.outcome}: ${JSON.stringify(response.body)}`);
      }
      compareDigests(before!, await this.digest.read(this.env.superuserPool, reachable), `a sync change refused as ${prediction.outcome}`);
      this.count(op.kind, false);
      return;
    }

    const ok = response.status >= 200 && response.status < 300;
    if (!ok) {
      await this.refusal(op, prediction, response, request.method, request.path);
      compareDigests(before!, await this.digest.read(this.env.superuserPool, reachable), `a refused ${request.method} ${request.path}`);
      this.count(op.kind, false);
      return;
    }
    if (prediction.kind === "refuse") {
      fail(`${request.method} ${request.path} answered ${response.status}, expected a refusal ${prediction.status} ${prediction.code ?? ""}: ${JSON.stringify(response.body)}`);
    }
    this.count(op.kind, true);
    model.takeCreated();
    const touched = spec.accept(model, op.params, response.body);
    const handles = model.takeCreated();
    if (handles.length > 0) logged.created = handles;
    await this.checkTouched(model, touched);

    if (budgetBefore !== undefined) {
      expectEqual(await get(this.ctx, model, budgetPath), budgetBefore, `budget month ${LAST_MONTH} of the mixed household after a trade`);
    }

    const created = touched.created[0];
    if (created) {
      const others = PERSONAS.filter((p) => p !== op.ws);
      await probeIsolation(this.ctx, model, this.model(others[Math.floor(logged.step / 2) % others.length]!), created, logged.step);
    }
  }

  private async refusal(op: Op, prediction: Prediction, response: WalkResponse, method: string, path: string): Promise<void> {
    const code = refusalCode(response.body);
    const what = `${method} ${path} (${op.kind} as ${op.actor}) answered ${response.status} ${code}: ${JSON.stringify(response.body)}`;
    if (prediction.kind === "accept") fail(`${what}\n  expected it to be accepted`);
    if (prediction.kind === "refuse") {
      if (response.status !== prediction.status || (prediction.code !== undefined && code !== prediction.code)) {
        fail(`${what}\n  expected ${prediction.status} ${prediction.code ?? "(any code)"}`);
      }
      return;
    }
    if (response.status < 400 || response.status >= 500 || !REFUSAL_ALLOWLIST.has(code)) {
      fail(`${what}\n  a refusal the walk does not predict must be a 4xx with a code from the allowlist`);
    }
  }

  /** The cheap checks after an accepted step: the touched accounts, positions and budget of its workspace. */
  private async checkTouched(model: WorkspaceModel, touched: { accounts: Set<string>; portfolios: Set<string>; budget: boolean }): Promise<void> {
    const lists = new Map<string, TransactionJson[]>();
    for (const handle of touched.accounts) {
      const account = model.accounts.get(handle);
      if (account) lists.set(account.id, await checkAccountTransactions(this.ctx, model, account));
    }
    const brokers = [...touched.accounts].map((h) => model.accounts.get(h)).filter((a) => a?.type === "brokerage");
    if (brokers.length > 0 || touched.portfolios.size > 0) {
      const oracle = oraclePositions(model);
      for (const account of brokers) {
        const positions = await checkAccountPositions(this.ctx, model, account!, oracle);
        const trades = await checkTrades(this.ctx, model, `?accountId=${account!.id}`);
        checkBrokerageAccount(account!, lists.get(account!.id)!, trades, positions, `${model.persona}/${account!.handle}`);
      }
      for (const handle of touched.portfolios) {
        if (model.portfolios.has(handle)) await checkPortfolioPositions(this.ctx, model, handle, oracle);
      }
    }
    if (touched.budget && model.persona !== "investor") {
      // The touched accounts' balances as the API just listed them; the others' as the model has
      // them, already checked against the API when they were last touched (and at every full check).
      const balances = new Map<string, number>();
      for (const account of model.budgetCashAccounts()) {
        const list = lists.get(account.id);
        balances.set(account.id, list ? list.reduce((sum, t) => sum + amountOf(t), 0) : model.balanceOf(account));
      }
      await checkBudgetMonth(this.ctx, model, LAST_MONTH, balances);
    }
  }

  async fullCheck(): Promise<void> {
    for (const model of this.models.values()) {
      await fullCheck(this.ctx, model);
    }
  }
}

function writeLog(log: WalkLog, dir: string, step: number): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `envelope-walk-seed${log.seed}-step${step}-${process.pid}-${Date.now()}.json`);
  writeFileSync(file, `${JSON.stringify(log, null, 1)}\n`);
  return file;
}

/**
 * Runs one walk. A failure throws an error that names the seed, the step and the log file it
 * wrote; the workspaces are removed either way (set WALK_KEEP=1 to keep them for a look).
 */
export async function runWalk(env: WalkEnvironment, options: WalkOptions): Promise<WalkResult> {
  const started = Date.now();
  const { models, instruments } = await setUp(env);
  const digest = await WorkspaceDigest.prepare(env.superuserPool);
  const walk = new Walk(env, models, digest);
  const random = new WalkRandom(options.seed);
  const steps = options.replay ? options.replay.ops.length : options.steps;
  const fullEvery = options.fullEvery ?? 100;
  const log: WalkLog = { version: 1, seed: options.seed, steps, driver: env.driver.name, ops: [] };
  let current = 0;
  try {
    for (let step = 1; step <= steps; step++) {
      current = step;
      const op = options.replay ? options.replay.ops[step - 1]!.op : generateOp(random, step / steps, models);
      const logged: LoggedStep = { step, op };
      log.ops.push(logged);
      await walk.step(logged);
      if (step % fullEvery === 0) await walk.fullCheck();
    }
    current = steps + 1;
    await walk.fullCheck();
  } catch (error) {
    const file = writeLog(log, options.logDir ?? tmpdir(), current);
    const reason = error instanceof WalkFailure ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error);
    const op = log.ops.at(-1)?.op;
    throw new Error(
      `random walk failed: seed ${options.seed}, step ${current > steps ? "final check" : current} of ${steps}` +
        `${op ? `, operation ${JSON.stringify(op)}` : ""}\n${reason}\n` +
        `operation log: ${file}\nreplay: WALK_REPLAY=${file} pnpm --filter @envelope/api exec node --test src/test-helpers/walk/walk.test.ts`,
    );
  } finally {
    if (process.env.WALK_KEEP !== "1") await tearDown(env, models, instruments);
  }
  return { seed: options.seed, steps, ...walk.counts, durationMs: Date.now() - started, byKind: walk.byKind };
}
