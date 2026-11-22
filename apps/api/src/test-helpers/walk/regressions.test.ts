/**
 * Replays, through `inject`, every minimal log in `regressions/` of a bug the random walk found
 * (#80, ADR 0013; README, "The random walk"): each in fresh workspaces, a few steps each, so a
 * fixed bug cannot come back unnoticed. A file of its own, so it runs alongside the seeds' walks
 * and the other integration test files (#638, ADR 0016).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runWalk, type WalkLog } from "./run.ts";
import { logOptions, REGRESSIONS_DIR, report, useWalkSuite } from "./suite.ts";

const REGRESSION_LOGS = readdirSync(REGRESSIONS_DIR).filter((name) => name.endsWith(".json")).sort();

describe("random walk through the API, regression logs (#80, ADR 0013)", () => {
  const suite = useWalkSuite();

  for (const name of REGRESSION_LOGS) {
    it(`replays the regression log ${name} (inject)`, async () => {
      const log = JSON.parse(readFileSync(join(REGRESSIONS_DIR, name), "utf8")) as WalkLog;
      report(await runWalk(suite.env(), { seed: log.seed, steps: log.ops.length, replay: log, ...logOptions() }), "inject");
    });
  }
});
