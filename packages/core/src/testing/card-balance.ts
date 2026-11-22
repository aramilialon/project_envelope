/**
 * Builds a card's own transactions for tests (`CardBalance.transactions`, #660): one transaction
 * dated `date` that leaves the card owing `owed` from that month on (negative: in credit). Not
 * part of the domain API (`src/index.ts`).
 */

import type { CardTransaction } from "../budget/card-balance.ts";
import type { Cents } from "../money.ts";
import type { LocalDate } from "../month.ts";

export function owing(owed: Cents, date: LocalDate): readonly CardTransaction[] {
  return [{ date, amount: 0 - owed }];
}
