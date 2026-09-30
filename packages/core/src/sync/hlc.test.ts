import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compareHlc, nextHlc } from "./hlc.ts";

describe("hybrid logical clock", () => {
  it("advances the physical time on a first change", () => {
    const hlc = nextHlc(1000, undefined, "device-a");
    assert.deepEqual(hlc, { physical: 1000, counter: 0, deviceId: "device-a" });
  });

  it("advances the physical time again once the wall clock has moved past the previous one", () => {
    const previous = nextHlc(1000, undefined, "device-a");
    const hlc = nextHlc(2000, previous, "device-a");
    assert.deepEqual(hlc, { physical: 2000, counter: 0, deviceId: "device-a" });
  });

  it("ticks the counter when the wall clock has not moved past the previous physical time", () => {
    const previous = nextHlc(1000, undefined, "device-a");
    const hlc = nextHlc(1000, previous, "device-a");
    assert.deepEqual(hlc, { physical: 1000, counter: 1, deviceId: "device-a" });
  });

  it("still moves forward when the wall clock runs backward", () => {
    const previous = nextHlc(5000, undefined, "device-a");
    const hlc = nextHlc(1000, previous, "device-a");
    assert.deepEqual(hlc, { physical: 5000, counter: 1, deviceId: "device-a" });
    assert.ok(compareHlc(hlc, previous) > 0);
  });

  it("compares by physical time first", () => {
    assert.ok(compareHlc({ physical: 1000, counter: 5, deviceId: "z" }, { physical: 2000, counter: 0, deviceId: "a" }) < 0);
  });

  it("compares by the logical counter when physical time ties", () => {
    assert.ok(compareHlc({ physical: 1000, counter: 0, deviceId: "z" }, { physical: 1000, counter: 1, deviceId: "a" }) < 0);
  });

  it("breaks a full tie by device id, deterministically either way", () => {
    const a = { physical: 1000, counter: 0, deviceId: "device-a" };
    const b = { physical: 1000, counter: 0, deviceId: "device-b" };
    assert.ok(compareHlc(a, b) < 0);
    assert.ok(compareHlc(b, a) > 0);
  });

  it("reports equal HLCs as equal", () => {
    const hlc = { physical: 1000, counter: 2, deviceId: "device-a" };
    assert.equal(compareHlc(hlc, { ...hlc }), 0);
  });
});
