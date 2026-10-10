import { createContext } from "react";

/**
 * Bumped by `AppLayout.tsx` whenever the quick-entry overlay (`QuickEntryOverlay.tsx`, `#367`)
 * records a transaction. The overlay is not a route, so the screen behind it never unmounts to
 * pick up the change the way navigating to it fresh would — `BudgetScreen.tsx` and
 * `AccountRegisterScreen.tsx` watch this and refetch their own data when it changes. Starts at 0,
 * before anything has changed.
 *
 * Its own module, not `AppLayout.tsx`, so that file keeps exporting only the one component
 * (react-refresh's own lint rule) — the same reason `bandSecondRowSlot.ts` is separate.
 */
export const BudgetDataVersionContext = createContext(0);
