import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { createUnimplementedPushDriver } from "./unimplemented-driver.ts";

describe("unimplemented push driver", () => {
  it("rejects instead of silently pretending to have sent anything", async () => {
    const driver = createUnimplementedPushDriver("ios");
    await assert.rejects(
      () => driver.send("some-token", { notificationId: randomUUID(), title: "T", body: "B" }),
      /ios.*not implemented yet/,
    );
  });
});
