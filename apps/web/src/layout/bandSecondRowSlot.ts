import { createContext } from "react";

/**
 * The band's own second line (`docs/design.md`'s "Band": month navigation, the "unassigned" box,
 * the facts row) belongs to whichever screen has one — today only the budget month — not to
 * `AppLayout` itself. `useBandSecondRow` (`useBandSecondRow.tsx`) portals a screen's own markup
 * into the `<div className="bm">` slot `AppLayout.tsx` renders, so `AppLayout` never needs to
 * know what, if anything, a screen puts there. `null` until the slot itself has mounted.
 *
 * Its own module, not `AppLayout.tsx`, so that file keeps exporting only the one component
 * (react-refresh's own lint rule).
 */
export const BandSecondRowSlotContext = createContext<HTMLDivElement | null>(null);
