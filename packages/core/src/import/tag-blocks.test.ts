import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertScalesLinearly } from "../testing/linear-time.ts";
import { mulberry32 } from "../testing/random.ts";
import { findTagBlocks, findTagElements } from "./tag-blocks.ts";

// The lazy regular expressions findTagBlocks replaced (#675): it must find exactly what they found.
function regexBlocks(content: string, tag: string, attributes: boolean): string[] {
  const open = attributes ? `<${tag}(?:\\s[^>]*)?>` : `<${tag}>`;
  const regex = new RegExp(`${open}([\\s\\S]*?)<\\/${tag}>`, "gi");
  return [...content.matchAll(regex)].map((match) => match[1] ?? "");
}

describe("findTagBlocks", () => {
  it("finds each block's inner content, case-insensitively and in file order", () => {
    assert.deepEqual(findTagBlocks("<A>one</a> x <a>two</A>", "a"), ["one", "two"]);
  });

  it("ends a block at the first closing tag and never overlaps blocks", () => {
    assert.deepEqual(findTagBlocks("<a>1<a>2</a>3</a><a>4</a>", "a"), ["1<a>2", "4"]);
  });

  it("stops at an opening tag with no closing tag after it", () => {
    assert.deepEqual(findTagBlocks("<a>1</a><a>2<a>3", "a"), ["1"]);
  });

  it("takes attributes only when asked, and not a longer tag name sharing the prefix", () => {
    const content = '<Dt id="1">x</Dt><DtTm>y</DtTm><Dt\n>z</Dt>';
    assert.deepEqual(findTagBlocks(content, "Dt", { attributes: true }), ["x", "z"]);
    assert.deepEqual(findTagBlocks(content, "Dt"), []);
  });

  it("stops after the given number of blocks", () => {
    assert.deepEqual(findTagBlocks("<a>1</a><a>2</a>", "a", { limit: 1 }), ["1"]);
  });

  it("keeps non-ASCII text intact and compares tag names as ASCII only", () => {
    // "İ".toLowerCase() is two code units long: a lowercased copy would shift every offset after it.
    assert.deepEqual(findTagBlocks("İİ<A>İstanbul ÄÖ</A>", "a"), ["İstanbul ÄÖ"]);
    // The Kelvin sign lowercases to "k", but the replaced expressions never matched it to a "k".
    assert.deepEqual(findTagBlocks("<\u212A>x</k><k>y</K>", "k"), ["y"]);
  });

  it("finds what the lazy regular expressions found, on random markup", () => {
    const random = mulberry32(675);
    const pieces = ["<a>", "</a>", "<A>", "</A>", "<a ", "<a x='1'>", "<ab>", "</ab>", ">", "x", "İ", " ", "\n", "<", "/", "a", "A"];
    for (let i = 0; i < 2000; i++) {
      let content = "";
      const length = Math.floor(random() * 20);
      for (let j = 0; j < length; j++) content += pieces[Math.floor(random() * pieces.length)];
      for (const attributes of [false, true]) {
        assert.deepEqual(findTagBlocks(content, "a", { attributes }), regexBlocks(content, "a", attributes), content);
      }
    }
  });

  it("scans in linear time when nothing closes", () => {
    for (const attributes of [false, true]) {
      assertScalesLinearly(
        (size) => "<a>".repeat(size),
        (content) => findTagBlocks(content, "a", { attributes }),
        200_000,
      );
    }
    assertScalesLinearly(
      (size) => "<a x".repeat(size),
      (content) => findTagBlocks(content, "a"),
      200_000,
    );
  });

  it("stops at once at an opening tag whose attributes never end", () => {
    // The search ends at the first "<a x" after one native scan for ">", well under a millisecond
    // on any of these inputs: too little to time, so this only fails if the time starts to grow
    // (the replaced expression scanned to the end of the file from every "<a x").
    assertScalesLinearly(
      (size) => "<a x".repeat(size),
      (content) => assert.deepEqual(findTagBlocks(content, "a", { attributes: true }), []),
      200_000,
    );
  });
});

describe("findTagElements", () => {
  it("gives each element's opening-tag attributes with its body, as findTagBlocks finds them", () => {
    const content = `<Amt Ccy="EUR">1.00</Amt><Amt>2.00</Amt><AmtDtls>x</AmtDtls><Amt\n Ccy='USD'>3.00</Amt>`;
    assert.deepEqual(findTagElements(content, "Amt", { attributes: true }), [
      { attributes: ' Ccy="EUR"', body: "1.00" },
      { attributes: "", body: "2.00" },
      { attributes: "\n Ccy='USD'", body: "3.00" },
    ]);
    assert.deepEqual(findTagElements(content, "Amt", { attributes: true, limit: 1 }), [{ attributes: ' Ccy="EUR"', body: "1.00" }]);
    // Without attributes only the bare opening tag counts, so no element has any.
    assert.deepEqual(findTagElements(content, "Amt"), [{ attributes: "", body: "2.00" }]);
  });
});
