import { useEffect, useState } from "react";

/**
 * The phone breakpoint, in px. The one canonical value for it: every `@media (max-width: ...)`
 * in `AppLayout.css`, `AccountRegisterScreen.css` and `BudgetScreen.css` must match it exactly,
 * and says so in its own comment — a CSS media query cannot read a JS (or even a CSS custom
 * property) value, so there is no way to make those four actually share one value at the
 * language level, only to keep them pointed at each other.
 */
export const PHONE_MAX_WIDTH = 600;

/**
 * True below the phone breakpoint — for the rare screen whose phone layout is not just the same
 * markup reflowed by CSS (the budget month's bars, the band) but a genuinely different element
 * tree (the account register's table vs. its day-grouped list, `#333`). Read synchronously from
 * `window.innerWidth` on the very first render, so there is no flash of the wrong one while an
 * effect catches up; a `resize` listener keeps it current afterward.
 */
export function usePhoneWidth(): boolean {
  const [isPhone, setIsPhone] = useState(() => window.innerWidth <= PHONE_MAX_WIDTH);

  useEffect(() => {
    function onResize() {
      setIsPhone(window.innerWidth <= PHONE_MAX_WIDTH);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return isPhone;
}
