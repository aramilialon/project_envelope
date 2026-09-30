/**
 * Push notification title/body for budget problems (#40, design.md: "wording... designed
 * later, when notifications are actually built (0.1.5)" — this is that moment).
 *
 * A push notification is sent by the server itself, in final rendered text: unlike a
 * ValidationError (ADR 0004, "no user-facing text in packages/core"), there is no UI on the
 * receiving end to translate a code. `apps/api` has no catalog infrastructure yet (the i18n
 * library is chosen in "phase 1", the web app), so this is a small, self-contained EN/IT
 * lookup, bounded to these few strings, ahead of that future catalog.
 */
import { formatMoney, type CurrencyCode, type Locale } from "@envelope/core";

import type { BudgetProblem } from "../budget/repository.ts";
import type { NotificationContent } from "./repository.ts";

type Language = "en" | "it";

function languageOf(userLanguage: string): Language {
  return userLanguage === "it" ? "it" : "en";
}

const TEMPLATES: Record<
  Language,
  {
    title: (count: number) => string;
    overspentCategory: (name: string, amount: string) => string;
    uncoveredCardDebt: (name: string, amount: string) => string;
    unassignedMoney: (amount: string) => string;
  }
> = {
  en: {
    title: (count) => (count === 1 ? "Budget alert" : `${count} budget alerts`),
    overspentCategory: (name, amount) => `"${name}" is ${amount} over budget.`,
    uncoveredCardDebt: (name, amount) => `"${name}" has ${amount} of card debt not yet covered.`,
    unassignedMoney: (amount) => `${amount} is ready to be assigned.`,
  },
  it: {
    title: (count) => (count === 1 ? "Avviso di budget" : `${count} avvisi di budget`),
    overspentCategory: (name, amount) => `"${name}" supera il budget di ${amount}.`,
    uncoveredCardDebt: (name, amount) => `"${name}" ha ${amount} di debito della carta non ancora coperto.`,
    unassignedMoney: (amount) => `${amount} sono pronti per essere assegnati.`,
  },
};

export function composeBudgetAlert(
  problems: readonly BudgetProblem[],
  options: { language: string; locale: Locale; currency: CurrencyCode },
): NotificationContent {
  const t = TEMPLATES[languageOf(options.language)];
  const lines = problems.map((problem) => {
    const amount = formatMoney(problem.amountCents, { locale: options.locale, currency: options.currency });
    switch (problem.kind) {
      case "overspent_category":
        return t.overspentCategory(problem.name ?? "", amount);
      case "uncovered_card_debt":
        return t.uncoveredCardDebt(problem.name ?? "", amount);
      case "unassigned_money":
        return t.unassignedMoney(amount);
    }
  });
  return { title: t.title(problems.length), body: lines.join(" ") };
}
