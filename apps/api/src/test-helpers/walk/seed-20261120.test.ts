/**
 * The random walk through the API (#80, ADR 0013) for CI seed 20261120, through `inject`. Each
 * fixed CI seed has a file of its own, so the walks run alongside each other and alongside the
 * other integration test files (#638, ADR 0016).
 */
import { describe, it } from "node:test";

import { runWalk } from "./run.ts";
import { CI_STEPS, logOptions, report, useWalkSuite } from "./suite.ts";

const SEED = 20261120;

describe(`random walk through the API, seed ${SEED} (#80, ADR 0013)`, () => {
  const suite = useWalkSuite();

  it(`keeps every invariant for seed ${SEED}, ${CI_STEPS} steps (inject)`, async () => {
    report(await runWalk(suite.env(), { seed: SEED, steps: CI_STEPS, ...logOptions() }), "inject");
  });
});
