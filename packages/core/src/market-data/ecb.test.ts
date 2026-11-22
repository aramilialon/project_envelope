import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import { assertScalesLinearly } from "../testing/linear-time.ts";
import { ECB_RATES_FILE_MAX_CHARS, parseEcbReferenceRates } from "./ecb.ts";
import { fxRateTable } from "./fx.ts";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/** A file with the history layout (double quotes, one line) around the given days. */
function historyFile(days: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" ' +
    'xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><gesmes:subject>Reference rates</gesmes:subject>' +
    `<Cube>${days}</Cube></gesmes:Envelope>`
  );
}

function day(date: string, entries: string): string {
  return `<Cube time="${date}">${entries}</Cube>`;
}

function rate(currency: string, value: string): string {
  return `<Cube currency="${currency}" rate="${value}"/>`;
}

function assertRefused(text: string, reason: string, details: Record<string, string | number> = {}): void {
  assert.throws(
    () => parseEcbReferenceRates(text),
    (error: unknown) => {
      assert.ok(isValidationError(error, "invalid_rates_file"), `expected invalid_rates_file, got ${String(error)}`);
      assert.equal(error.details.reason, reason);
      for (const [key, value] of Object.entries(details)) assert.equal(error.details[key], value, key);
      return true;
    },
  );
}

describe("parseEcbReferenceRates: the published layouts", () => {
  it("reads the daily file (single quotes, one entry per line)", () => {
    const { rates, skippedCurrencies } = parseEcbReferenceRates(fixture("ecb-daily.xml"));
    assert.equal(rates.length, 29);
    assert.deepEqual(rates[0], { base: "EUR", quote: "USD", date: "2026-11-20", rateE10: 10_990_000_000 });
    assert.deepEqual(
      rates.find((r) => r.quote === "IDR"),
      { base: "EUR", quote: "IDR", date: "2026-11-20", rateE10: 200_713_700_000_000 },
    );
    assert.deepEqual(
      rates.find((r) => r.quote === "GBP"),
      { base: "EUR", quote: "GBP", date: "2026-11-20", rateE10: 8_373_500_000 },
    );
    assert.deepEqual(skippedCurrencies, []);
    assert.ok(rates.every((r) => r.date === "2026-11-20"));
  });

  it("reads the history layout (double quotes, one line), several days, in the file's order", () => {
    const { rates } = parseEcbReferenceRates(fixture("ecb-hist.xml"));
    const dates = [...new Set(rates.map((r) => r.date))];
    assert.deepEqual(dates, ["2026-11-20", "2026-11-19", "2004-12-31"]);
    assert.deepEqual(
      rates.find((r) => r.quote === "USD" && r.date === "2004-12-31"),
      { base: "EUR", quote: "USD", date: "2004-12-31", rateE10: 13_621_000_000 },
    );
    // The rates are a valid table for the conversion functions: no duplicate, all positive.
    assert.doesNotThrow(() => fxRateTable(rates));
  });

  it("leaves out the currencies the app cannot hold, the old Turkish lira beyond the safe range included", () => {
    const { rates, skippedCurrencies } = parseEcbReferenceRates(fixture("ecb-hist.xml"));
    assert.deepEqual(skippedCurrencies, ["CYP", "EEK", "LTL", "LVL", "MTL", "ROL", "SIT", "SKK", "TRL"]);
    assert.ok(!rates.some((r) => skippedCurrencies.includes(r.quote)));
    assert.ok(rates.some((r) => r.quote === "BGN" && r.date === "2004-12-31"));
  });

  it("converts the decimal text digit by digit, never through a float", () => {
    // 0.1 + 0.2 style traps: each would be off by one unit through a float multiplication.
    const { rates } = parseEcbReferenceRates(
      historyFile(day("2026-01-02", rate("USD", "1.1") + rate("GBP", "0.0000000001") + rate("JPY", "123456.0123456789"))),
    );
    assert.deepEqual(
      rates.map((r) => r.rateE10),
      [11_000_000_000, 1, 1_234_560_123_456_789],
    );
  });

  it("accepts the largest rate within the safe range and refuses one unit more", () => {
    // 900719.9254740991 × 10^10 is Number.MAX_SAFE_INTEGER.
    assert.equal(
      parseEcbReferenceRates(historyFile(day("2026-01-02", rate("USD", "900719.9254740991")))).rates[0]?.rateE10,
      Number.MAX_SAFE_INTEGER,
    );
    assertRefused(historyFile(day("2026-01-02", rate("USD", "900719.9254740992"))), "rate_out_of_range", {
      currency: "USD",
      date: "2026-01-02",
    });
  });

  it("refuses a rate of zero for a currency it keeps", () => {
    assertRefused(historyFile(day("2026-01-02", rate("USD", "0.0000"))), "rate_out_of_range", { currency: "USD" });
  });

  it("accepts a day with no rates among others, and white space around attributes", () => {
    const text = historyFile(`${day("2026-01-01", "")}<Cube  time = '2026-01-02' >\n\t<Cube currency='USD'   rate='1.0'\n/></Cube>`);
    assert.deepEqual(parseEcbReferenceRates(text).rates, [{ base: "EUR", quote: "USD", date: "2026-01-02", rateE10: 10_000_000_000 }]);
  });
});

describe("parseEcbReferenceRates: the whole file is refused", () => {
  const good = rate("USD", "1.0990");

  it("when it is truncated inside a day or before the outer Cube closes", () => {
    const whole = historyFile(day("2026-01-02", good + rate("GBP", "0.8")));
    for (const cut of [whole.indexOf('rate="0.8"'), whole.lastIndexOf("</Cube></Cube>"), whole.lastIndexOf("</Cube></gesmes")]) {
      assertRefused(whole.slice(0, cut), "malformed");
    }
  });

  it("for a rate that is not a plain decimal number, whatever the other entries hold", () => {
    for (const bad of ["1,0990", "1.0990 ", " 1.0990", "-1.0990", "+1.0990", "1e3", "1.", ".5", "", "NaN", "1.00000000001", "12345678901234567"]) {
      assertRefused(historyFile(day("2026-01-02", good + rate("GBP", bad))), "malformed");
    }
  });

  it("for a malformed entry of a currency it would leave out", () => {
    assertRefused(historyFile(day("2026-01-02", good + rate("TRL", "1,836,200"))), "malformed");
  });

  it("for a currency that is not three capital letters, or the euro itself", () => {
    for (const bad of ["usd", "US", "USDX", "EUR", ""]) {
      assertRefused(historyFile(day("2026-01-02", good + rate(bad, "1.5"))), "malformed");
    }
  });

  it("for an entry outside a day, or a day outside the outer Cube", () => {
    assertRefused(historyFile(good), "malformed");
    assertRefused(`<Cube time="2026-01-02">${good}</Cube>`, "malformed");
    assertRefused(historyFile(day("2026-01-02", day("2026-01-03", good))), "malformed");
  });

  it("for a tag with other, missing or repeated attributes", () => {
    assertRefused(historyFile(day("2026-01-02", '<Cube currency="USD"/>')), "malformed");
    assertRefused(historyFile(day("2026-01-02", '<Cube currency="USD" rate="1.1" extra="x"/>')), "malformed");
    assertRefused(historyFile(day("2026-01-02", '<Cube currency="USD" currency="GBP" rate="1.1"/>')), "malformed");
    assertRefused(historyFile(day("2026-01-02", '<Cube currency=USD rate="1.1"/>')), "malformed");
    assertRefused(historyFile('<Cube time="2026-01-02" foo="1"></Cube>'), "malformed");
    assertRefused(historyFile(`<Cube time="2026-01-02"/>`), "malformed");
    assertRefused(historyFile(day("2026-01-02", '<Cube currency="USD" rate="1.1"></Cube>')), "malformed");
  });

  it("for a closing tag with attributes or a self-closing slash, where a plain one would close the day", () => {
    for (const closing of ['</Cube foo="1">', "</Cube/>"]) {
      const text = historyFile(`<Cube time="2026-01-02">${good}${closing}`);
      assertRefused(text, "malformed", { offset: text.indexOf(closing) });
    }
  });

  it("for a second outer Cube, or a closing tag with nothing open", () => {
    assertRefused(`${historyFile(day("2026-01-02", good))}<Cube></Cube>`, "malformed");
    assertRefused(`</Cube>${historyFile(day("2026-01-02", good))}`, "malformed");
  });

  it("for a date that is not a calendar date", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "26-01-02", "2026-1-2", ""]) {
      assertRefused(historyFile(day(bad, good)), "invalid_date", { date: bad });
    }
  });

  it("for a day or a currency given twice", () => {
    assertRefused(historyFile(day("2026-01-02", good) + day("2026-01-02", good)), "duplicate_date", { date: "2026-01-02" });
    assertRefused(historyFile(day("2026-01-02", good + rate("USD", "1.1"))), "duplicate_rate", { currency: "USD", date: "2026-01-02" });
    assertRefused(historyFile(day("2026-01-02", rate("TRL", "1") + rate("TRL", "2"))), "duplicate_rate", { currency: "TRL" });
  });

  it("with no rate at all: an empty file, an error page, or days without entries", () => {
    assertRefused("", "no_rates");
    assertRefused("<html><body>Service unavailable</body></html>", "no_rates");
    assertRefused(historyFile(day("2026-01-02", "")), "no_rates");
  });

  it("beyond the size cap, before reading anything", () => {
    assertRefused(" ".repeat(ECB_RATES_FILE_MAX_CHARS + 1), "too_large", { max: ECB_RATES_FILE_MAX_CHARS });
    assert.doesNotThrow(() => parseEcbReferenceRates(historyFile(day("2026-01-02", good)).padEnd(ECB_RATES_FILE_MAX_CHARS, " ")));
  });

  it("names where the problem is", () => {
    const text = historyFile(day("2026-01-02", good + rate("GBP", "x")));
    assertRefused(text, "malformed", { offset: text.indexOf('<Cube currency="GBP"') });
  });
});

describe("parseEcbReferenceRates: running time", () => {
  it("grows linearly with the file, valid or not", () => {
    const dayOf = (i: number): string => {
      const date = new Date(Date.UTC(2000, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      return day(date, rate("USD", "1.0990") + rate("GBP", "0.8373"));
    };
    assertScalesLinearly(
      (size) => historyFile(Array.from({ length: size }, (_, i) => dayOf(i)).join("")),
      parseEcbReferenceRates,
      4_000,
    );
    // Unclosed tags and attribute-like text that never ends, the usual traps for a backtracking pattern.
    const tryParse = (text: string): void => {
      try {
        parseEcbReferenceRates(text);
      } catch {
        // refused, as expected
      }
    };
    assertScalesLinearly((size) => "<Cube".repeat(size), tryParse, 200_000);
    assertScalesLinearly((size) => `<Cube${' a="1"'.repeat(size)}`, tryParse, 50_000);
    assertScalesLinearly((size) => `<Cube>${" ".repeat(size)}`, tryParse, 500_000);
  });
});
