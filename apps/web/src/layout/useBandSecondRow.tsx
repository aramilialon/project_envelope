import { useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { BandSecondRowSlotContext } from "./bandSecondRowSlot.ts";

/**
 * Portals `node` into the band's own second-line slot (`AppLayout.tsx`): the budget month's
 * month navigation, "unassigned" box and facts row live here instead of in `AppLayout` itself,
 * since it is the only screen with a second band line so far (#324). Pass `null` while there is
 * nothing to show there yet (loading, an error, …) — the slot itself only ever renders what the
 * current screen gives it.
 */
export function useBandSecondRow(node: ReactNode): ReactNode {
  const slot = useContext(BandSecondRowSlotContext);
  return slot ? createPortal(node, slot) : null;
}
