import { useEffect, useState } from "react";

/** The same breakpoint the rest of the app's own CSS media queries use. */
const PHONE_MAX_WIDTH = 600;

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
