import { describe, expect, it } from "vitest";

import { urlBase64ToUint8Array } from "./vapidKey.ts";

describe("urlBase64ToUint8Array", () => {
  it("decodes a base64url string with no padding needed", () => {
    // "test" -> base64 "dGVzdA==" -> base64url "dGVzdA" (padding stripped)
    expect(Array.from(urlBase64ToUint8Array("dGVzdA"))).toEqual([116, 101, 115, 116]);
  });

  it("decodes a base64url string that needs padding restored", () => {
    // "a" -> base64 "YQ==" -> base64url "YQ"
    expect(Array.from(urlBase64ToUint8Array("YQ"))).toEqual([97]);
  });

  it("converts URL-safe characters (- and _) back to + and /", () => {
    // bytes [251, 255] -> base64 "+/8=" -> base64url "-_8"
    expect(Array.from(urlBase64ToUint8Array("-_8"))).toEqual([251, 255]);
  });
});
