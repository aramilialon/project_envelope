import { Api } from "./lib/api.ts";
import { backdateStartingBalance, createWorkspaceWithOwner, deleteWorkspace, findUserIdBySubject } from "./lib/db.ts";
import { monthOffset, todayAt } from "./lib/dates.ts";
import { assertSafeToRun, requireEnv } from "./lib/env.ts";
import { ensureDemoUser, signInAsDemoUser, subjectOf } from "./lib/keycloak.ts";

/**
 * Seeds a "Demo" workspace through the real `apps/api` HTTP API — see `scripts/README.md` for
 * why (the assignment ledger, Row-Level Security and `@envelope/core`'s own invariants only mean
 * anything if the data was built the way the real app builds it), the one exception (workspace
 * and membership creation/deletion, `lib/db.ts`), and the exact commands to run this.
 *
 * `--reset` deletes a previously seeded "Demo" workspace first; without it, an existing one makes
 * this exit immediately rather than silently leaving two.
 */

const WORKSPACE_NAME = "Demo";
const TIME_ZONE = "Europe/Rome";
const BASE_CURRENCY = "EUR";
const DEMO_USERNAME = "demo";

interface CreatedAccount {
  readonly id: string;
  readonly type: string;
  readonly onBudget: boolean;
  readonly paymentCategoryId: string | null;
}

async function main(): Promise<void> {
  const reset = process.argv.includes("--reset");

  const apiUrl = process.env.API_URL ?? "http://127.0.0.1:3000";
  const keycloakUrl = process.env.KEYCLOAK_URL ?? "http://127.0.0.1:8080";
  const clientId = process.env.KEYCLOAK_AUDIENCE ?? "envelope-api";
  const keycloakAdminPassword = requireEnv("KEYCLOAK_ADMIN_PASSWORD");
  const demoPassword = requireEnv("DEMO_USER_PASSWORD");
  const databaseUrl = requireEnv("DATABASE_URL");

  assertSafeToRun({ API_URL: apiUrl, DATABASE_URL: databaseUrl, KEYCLOAK_URL: keycloakUrl });

  console.log("== Signing in as the demo user");
  await ensureDemoUser(keycloakUrl, keycloakAdminPassword, DEMO_USERNAME, demoPassword);
  const accessToken = await signInAsDemoUser(keycloakUrl, clientId, DEMO_USERNAME, demoPassword);
  const api = new Api(apiUrl, accessToken);
  const subject = subjectOf(accessToken);

  // The user-mapper preHandler creates the local `users` row on the first authenticated
  // request — this is that first request, and also how we check for an existing "Demo" workspace.
  const { workspaces } = await api.get<{ workspaces: { id: string; name: string }[] }>("/me/workspaces");
  const existing = workspaces.find((w) => w.name === WORKSPACE_NAME);
  if (existing && !reset) {
    console.log(`A "${WORKSPACE_NAME}" workspace already exists (${existing.id}). Pass --reset to recreate it.`);
    process.exit(1);
  }
  if (existing) {
    console.log(`== Deleting the previous "${WORKSPACE_NAME}" workspace (${existing.id})`);
    await deleteWorkspace(databaseUrl, existing.id);
  }

  const userId = await findUserIdBySubject(databaseUrl, subject);
  if (!userId) {
    throw new Error("expected a local user row for the demo user's subject after signing in");
  }

  console.log(`== Creating the "${WORKSPACE_NAME}" workspace`);
  const workspaceId = await createWorkspaceWithOwner(databaseUrl, WORKSPACE_NAME, TIME_ZONE, BASE_CURRENCY, userId);
  const base = `/workspaces/${workspaceId}`;

  const { month: currentMonth, isoDate, onOrBeforeToday, beforeTodaySameMonth, afterTodaySameMonth } = todayAt(new Date(), TIME_ZONE);
  const previousMonth = monthOffset(currentMonth, -1);
  const nextMonth = monthOffset(currentMonth, 1);

  console.log("== Creating accounts");
  const account = async (name: string, type: string, onBudget: boolean, startingBalanceCents?: number) =>
    api.post<CreatedAccount>(`${base}/accounts`, {
      name,
      type,
      currency: BASE_CURRENCY,
      onBudget,
      ...(startingBalanceCents === undefined ? {} : { startingBalanceCents }),
    });

  const checking = await account("Checking", "checking", true);
  const savings = await account("Savings", "savings", true);
  const cash = await account("Cash", "cash", true);
  const investments = await account("Investments", "savings", false);
  const visa = await account("Visa", "credit_card", true, -60_000);
  const mastercard = await account("Mastercard", "credit_card", true, -120_000);
  if (!visa.paymentCategoryId || !mastercard.paymentCategoryId) {
    throw new Error("expected both cards to get their own payment category");
  }
  // `POST .../accounts` always dates a card's own "Starting balance" transaction `now()` — moved
  // here to the previous month's own first day, before every other transaction seeded below, so
  // it reads as the card's own balance *before* that month's story starts, not as something that
  // happened today in the middle of it (#326).
  await backdateStartingBalance(databaseUrl, visa.id, `${previousMonth}-01`, TIME_ZONE);
  await backdateStartingBalance(databaseUrl, mastercard.id, `${previousMonth}-01`, TIME_ZONE);

  console.log("== Creating category groups and categories");
  const group = async (name: string) => (await api.post<{ id: string }>(`${base}/category-groups`, { name })).id;
  const category = async (groupId: string, name: string) =>
    (await api.post<{ id: string }>(`${base}/categories`, { groupId, name })).id;

  const homeGroup = await group("Home and bills");
  const mortgagePayment = await category(homeGroup, "Mortgage payment");
  const electricityAndGas = await category(homeGroup, "Electricity and gas");
  const internetAndPhone = await category(homeGroup, "Internet and phone");
  const homeMaintenance = await category(homeGroup, "Home maintenance");

  const everydayGroup = await group("Everyday spending");
  const groceries = await category(everydayGroup, "Groceries");
  const fuelAndTransport = await category(everydayGroup, "Fuel and transport");
  const restaurants = await category(everydayGroup, "Restaurants");
  const pharmacyAndHealth = await category(everydayGroup, "Pharmacy and health");

  const predictableGroup = await group("Predictable expenses");
  const carInsurance = await category(predictableGroup, "Car insurance");
  const carTax = await category(predictableGroup, "Car tax");
  const gifts = await category(predictableGroup, "Gifts");
  const vet = await category(predictableGroup, "Vet");

  const goalsGroup = await group("Goals and savings");
  const emergencyFund = await category(goalsGroup, "Emergency fund");
  const summerVacation = await category(goalsGroup, "Summer vacation");
  const investmentPlanContribution = await category(goalsGroup, "Investment plan contribution");

  const funGroup = await group("Fun");
  const subscriptions = await category(funGroup, "Subscriptions");
  const hobbies = await category(funGroup, "Hobbies");

  console.log("== Assigning money (previous, current and next month)");
  const assign = async (month: string, entries: { destinationCategoryId: string; amountCents: number }[]) =>
    api.post(`${base}/assignments`, {
      entries: entries.map((e) => ({ month, sourceCategoryId: null, destinationCategoryId: e.destinationCategoryId, amountCents: e.amountCents })),
    });

  // Carries into this month as `carriedOver` for the categories that need it (never spent then),
  // plus a previous month's worth of ordinary spending money (#326: a real timeline needs a real
  // month of movements, not just "today" — every day below is already in the past, so none of
  // `onOrBeforeToday`'s clamping applies, unlike the current month's own transactions further down).
  await assign(previousMonth, [
    { destinationCategoryId: homeMaintenance, amountCents: 30_000 },
    { destinationCategoryId: carInsurance, amountCents: 5_000 },
    { destinationCategoryId: carTax, amountCents: 1_500 },
    { destinationCategoryId: gifts, amountCents: 4_000 },
    { destinationCategoryId: vet, amountCents: 2_500 },
    { destinationCategoryId: emergencyFund, amountCents: 30_000 },
    { destinationCategoryId: summerVacation, amountCents: 20_000 },
    { destinationCategoryId: mortgagePayment, amountCents: 85_000 },
    { destinationCategoryId: electricityAndGas, amountCents: 12_000 },
    { destinationCategoryId: internetAndPhone, amountCents: 4_500 },
    { destinationCategoryId: groceries, amountCents: 80_000 },
    { destinationCategoryId: fuelAndTransport, amountCents: 15_000 },
    { destinationCategoryId: restaurants, amountCents: 5_000 },
    { destinationCategoryId: subscriptions, amountCents: 3_000 },
    { destinationCategoryId: hobbies, amountCents: 6_000 },
    { destinationCategoryId: mastercard.paymentCategoryId, amountCents: 4_000 },
  ]);

  await assign(currentMonth, [
    { destinationCategoryId: mortgagePayment, amountCents: 85_000 },
    { destinationCategoryId: electricityAndGas, amountCents: 12_000 },
    { destinationCategoryId: internetAndPhone, amountCents: 4_500 },
    { destinationCategoryId: homeMaintenance, amountCents: 5_000 },
    { destinationCategoryId: groceries, amountCents: 60_000 },
    { destinationCategoryId: fuelAndTransport, amountCents: 15_000 },
    { destinationCategoryId: restaurants, amountCents: 12_000 },
    { destinationCategoryId: pharmacyAndHealth, amountCents: 4_000 },
    { destinationCategoryId: carInsurance, amountCents: 5_000 },
    { destinationCategoryId: carTax, amountCents: 1_500 },
    { destinationCategoryId: gifts, amountCents: 4_000 },
    { destinationCategoryId: vet, amountCents: 2_500 },
    { destinationCategoryId: emergencyFund, amountCents: 30_000 },
    { destinationCategoryId: summerVacation, amountCents: 20_000 },
    { destinationCategoryId: investmentPlanContribution, amountCents: 50_000 },
    { destinationCategoryId: subscriptions, amountCents: 1_000 },
    { destinationCategoryId: hobbies, amountCents: 6_000 },
    { destinationCategoryId: visa.paymentCategoryId, amountCents: 60_000 },
    { destinationCategoryId: mastercard.paymentCategoryId, amountCents: 50_000 },
  ]);

  // Pre-funding next month: `assignedInFuture`.
  await assign(nextMonth, [
    { destinationCategoryId: mortgagePayment, amountCents: 85_000 },
    { destinationCategoryId: homeMaintenance, amountCents: 5_000 },
  ]);

  console.log("== Recording transactions");
  const transaction = async (
    accountId: string,
    payee: string,
    splits: { categoryId: string | null; amountCents: number }[],
    occurredAt: string,
    status: "pending" | "cleared" = "cleared",
  ) =>
    api.post(`${base}/accounts/${accountId}/transactions`, {
      payee,
      occurredAt,
      status,
      splits,
    });

  // Income: enough across the last two months to actually afford everything assigned above
  // (#326: "everything assigned" counts future months' own pre-funding too, regardless of which
  // month is being viewed — `packages/core/src/budget/budget-month.ts`'s own documented rule — so
  // the previous month's own income has to cover not just its own spending but the current and
  // next months' assignments as well, or it reads as a wildly negative "Unassigned" the moment
  // anyone looks back at it), with a healthy buffer left over in both — a cash account with only
  // expenses on it would look (and reconcile) strangely for a screenshot.
  await transaction(checking.id, "Salary", [{ categoryId: null, amountCents: 500_000 }], `${previousMonth}-15`);
  await transaction(checking.id, "Salary", [{ categoryId: null, amountCents: 500_000 }], onOrBeforeToday(3));
  await transaction(checking.id, "Freelance payment", [{ categoryId: null, amountCents: 400_000 }], `${previousMonth}-20`);

  // The previous month's own full spread of ordinary spending (#326: a real timeline, not just a
  // cluster of "today" marks) — every day is already in the past, so no clamping is needed, unlike
  // the current month's own transactions below. Reuses the same categories as the current month's
  // own assignments above, each matched or covered by `previousMonth`'s own assignment just above,
  // so none of it shows up as overspending in a month the screenshots are not meant to dwell on.
  const prevDay = (day: number) => `${previousMonth}-${String(day).padStart(2, "0")}`;
  await transaction(checking.id, "Bank, mortgage payment", [{ categoryId: mortgagePayment, amountCents: -85_000 }], prevDay(1));
  await transaction(checking.id, "Energy provider", [{ categoryId: electricityAndGas, amountCents: -9_640 }], prevDay(3));
  await transaction(checking.id, "Supermarket", [{ categoryId: groceries, amountCents: -18_500 }], prevDay(5));
  await transaction(checking.id, "Phone and internet provider", [{ categoryId: internetAndPhone, amountCents: -4_500 }], prevDay(8));
  await transaction(checking.id, "Gas station", [{ categoryId: fuelAndTransport, amountCents: -7_200 }], prevDay(10));
  await transaction(checking.id, "Supermarket", [{ categoryId: groceries, amountCents: -21_300 }], prevDay(12));
  await transaction(checking.id, "Trattoria", [{ categoryId: restaurants, amountCents: -4_500 }], prevDay(16));
  await transaction(checking.id, "Supermarket", [{ categoryId: groceries, amountCents: -19_600 }], prevDay(19));
  await transaction(checking.id, "Music streaming", [{ categoryId: subscriptions, amountCents: -999 }], prevDay(21));
  await transaction(checking.id, "Music shop", [{ categoryId: hobbies, amountCents: -4_200 }], prevDay(24));
  await transaction(mastercard.id, "Pizzeria", [{ categoryId: restaurants, amountCents: -3_500 }], prevDay(27));
  await transaction(checking.id, "Supermarket", [{ categoryId: groceries, amountCents: -15_800 }], prevDay(28));

  // Every recorded transaction below is anchored to a fixed day of the current month, clamped to
  // today when that day has not happened yet (`onOrBeforeToday`) — a *recorded* transaction dated
  // in the future would describe something that has not actually happened. Never an offset from
  // today either: with today early in the month, "a few days ago" can otherwise land in the
  // previous month entirely (and its spending in the wrong month's budget).

  // Cash overspending: assigned 60 000, spent 64 215 from a cash account.
  await transaction(checking.id, "Supermarket", [{ categoryId: groceries, amountCents: -64_215 }], onOrBeforeToday(7));

  // Credit overspending: assigned 12 000, spent 16 850 on the Mastercard (also pushes its real
  // debt well past what is assigned to its payment category — the "uncovered" case below).
  await transaction(mastercard.id, "Restaurant", [{ categoryId: restaurants, amountCents: -16_850 }], onOrBeforeToday(9));

  // A split across two categories in one transaction.
  await transaction(
    checking.id,
    "Shopping run",
    [
      { categoryId: fuelAndTransport, amountCents: -8_830 },
      { categoryId: hobbies, amountCents: -3_500 },
    ],
    onOrBeforeToday(11),
  );

  // A pending transaction, not yet cleared — recent (today or yesterday), per the same rule.
  await transaction(checking.id, "Streaming service", [{ categoryId: subscriptions, amountCents: -999 }], isoDate(0), "pending");

  await transaction(checking.id, "Investment platform", [{ categoryId: investmentPlanContribution, amountCents: -50_000 }], onOrBeforeToday(5));

  await api.post(`${base}/transfers`, {
    sourceAccountId: checking.id,
    destinationAccountId: savings.id,
    occurredAt: onOrBeforeToday(6),
    amountCents: 20_000,
    payee: "Savings top-up",
    status: "cleared",
  });

  await transaction(investments.id, "Initial transfer", [{ categoryId: null, amountCents: 500_000 }], `${previousMonth}-01`);

  console.log("== Scheduling transactions");
  // A scheduled item's own amount is always positive — "how much it will reserve" — unlike a
  // transaction split, which is signed. `amountCents` here is given as the usual negative
  // expense for readability at each call site below, and flipped once, here.
  const schedule = async (
    accountId: string,
    payee: string,
    categoryId: string,
    amountCents: number,
    nextDueDate: string,
    recurEvery: number,
    recurUnit: "day" | "month" | "year",
  ) =>
    api.post(`${base}/scheduled-transactions`, {
      accountId,
      payee,
      nextDueDate,
      recurEvery,
      recurUnit,
      splits: [{ categoryId, amountCents: -amountCents }],
    });

  // Overdue, not yet recorded — the "to do" list's own job (#330, not this script's).
  await schedule(checking.id, "Internet provider", internetAndPhone, -4_500, beforeTodaySameMonth(5), 1, "month");

  // Due after today: reserved, not yet due.
  await schedule(checking.id, "Mortgage lender", mortgagePayment, -85_000, afterTodaySameMonth(5), 1, "month");

  // A reservation this category cannot cover: carriedOver 30 000 + assigned 5 000 = 35 000
  // available, reserved 50 000 — a warning, never overspending. Not relative to today (only the
  // two above are), so a safe fixed day covers every month without clamping.
  await schedule(checking.id, "Contractor", homeMaintenance, -50_000, `${currentMonth}-20`, 6, "month");

  console.log("== Setting targets");
  const goal = async (categoryId: string, body: Record<string, unknown>) => api.put(`${base}/categories/${categoryId}/goal`, body);

  // Monthly target asking more than assigned this month — still needs funding.
  await goal(subscriptions, { kind: "monthly", amountCents: 3_000 });
  await goal(summerVacation, { kind: "by_date", amountCents: 360_000, dueMonth: monthOffset(currentMonth, 9) });
  await goal(carInsurance, { kind: "repeating", amountCents: 60_000, dueMonth: monthOffset(currentMonth, 11), every: 12 });
  await goal(emergencyFund, { kind: "balance", amountCents: 500_000 });

  console.log("== Verifying the budget invariant");
  await verifyInvariant(api, workspaceId, currentMonth, [checking, savings, cash, visa, mastercard]);

  console.log(`\nDone. Workspace "${WORKSPACE_NAME}" (${workspaceId}) seeded for ${currentMonth}.`);
  console.log(`Sign in as "${DEMO_USERNAME}" with the password in DEMO_USER_PASSWORD.`);
}

interface BudgetMonthCategory {
  readonly available: number;
}

interface BudgetMonthResponse {
  readonly unassigned: number;
  readonly assignedInFuture: number;
  readonly creditOverspending: number;
  readonly reserved: number;
  readonly categories: readonly BudgetMonthCategory[];
  readonly paymentCategories: readonly BudgetMonthCategory[];
}

interface TransactionSplit {
  readonly amountCents: number;
}

interface Transaction {
  readonly splits: readonly TransactionSplit[];
}

/**
 * `unassigned + total available + total reserved + assigned to future months + total credit
 * overspending = the on-budget cash accounts' own balance (cards excluded)` — design.md's own
 * invariant, computed here the same way `apps/web` would: from the budget month endpoint and
 * each cash account's own transaction list, never a direct query.
 */
async function verifyInvariant(api: Api, workspaceId: string, month: string, accounts: readonly CreatedAccount[]): Promise<void> {
  const budgetMonth = await api.get<BudgetMonthResponse>(`/workspaces/${workspaceId}/budget-months/${month}`);
  const totalAvailable = [...budgetMonth.categories, ...budgetMonth.paymentCategories].reduce((sum, c) => sum + c.available, 0);
  const left =
    budgetMonth.unassigned + totalAvailable + budgetMonth.reserved + budgetMonth.assignedInFuture + budgetMonth.creditOverspending;

  let right = 0;
  for (const acc of accounts) {
    if (!acc.onBudget || acc.type === "credit_card") continue;
    const { transactions } = await api.get<{ transactions: readonly Transaction[] }>(`/workspaces/${workspaceId}/accounts/${acc.id}/transactions`);
    for (const t of transactions) {
      for (const split of t.splits) {
        right += split.amountCents;
      }
    }
  }

  if (left !== right) {
    throw new Error(`Budget invariant broken: unassigned+available+reserved+assignedInFuture+creditOverspending=${left}, cash accounts=${right}`);
  }
  console.log(`Invariant holds: ${left} = ${right} (cash accounts' own balance)`);
}

await main();
