/**
 * A short random walk (#80, ADR 0013) through the real server process, over `fetch`: it proves
 * the `fetch` driver and the process, not the domain, so it stays short. A file of its own, so it
 * runs alongside the seeds' walks and the other integration test files (#638, ADR 0016).
 */
import { describe, it } from "node:test";

import { runWalk } from "./run.ts";
import { FETCH_SEED, FETCH_STEPS, logOptions, report, useWalkSuite } from "./suite.ts";

describe("random walk through the real process (#80, ADR 0013)", () => {
  const suite = useWalkSuite();

  it(`keeps every invariant through the real process, seed ${FETCH_SEED}, ${FETCH_STEPS} steps (fetch)`, async () => {
    const fetchEnv = await suite.fetchEnvironment();
    try {
      report(await runWalk(fetchEnv, { seed: FETCH_SEED, steps: FETCH_STEPS, ...logOptions() }), "fetch");
    } finally {
      await suite.stopRealServer();
    }
  });
});
