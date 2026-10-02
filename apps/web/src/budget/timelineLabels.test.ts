import { createIntl } from "react-intl";
import { describe, expect, it } from "vitest";

import { formatPayees } from "./timelineLabels.ts";

const intl = createIntl({ locale: "en", defaultLocale: "en", messages: {} });

describe("formatPayees (#326)", () => {
  it("lists one payee plainly", () => {
    expect(formatPayees(["Supermarket"], 0, intl)).toBe("Supermarket");
  });

  it("joins two payees with Intl.ListFormat's own conjunction style", () => {
    expect(formatPayees(["Supermarket", "Restaurant"], 0, intl)).toBe("Supermarket and Restaurant");
  });

  it("adds a translated 'and N more' tail instead of a raw '+N' that could read as a signed amount", () => {
    expect(formatPayees(["Supermarket", "Restaurant"], 5, intl)).toBe("Supermarket and Restaurant and 5 more");
  });
});
