/**
 * The random walk is deterministic (#80, ADR 0013): two walks of the same seed, through `inject`,
 * give byte-identical operation logs. A file of its own, so it runs alongside the seeds' walks
 * and the other integration test files (#638, ADR 0016).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runWalk } from "./run.ts";
import { DETERMINISM_SEED, DETERMINISM_STEPS, logOptions, useWalkSuite } from "./suite.ts";

describe("random walk through the API, determinism (#80, ADR 0013)", () => {
  const suite = useWalkSuite();

  it(`walks seed ${DETERMINISM_SEED} the same way twice, ${DETERMINISM_STEPS} steps (inject)`, async () => {
    // A seed is a reproduction only if it gives the same walk every time: every operation, every
    // status and every handle given out, whatever ids and creation times the API picks. The rows of
    // one split or securities transfer come back in an order that ties on their random ids, so
    // this seed also checks the order the model gives them handles in (`sortTradeRows`), though
    // only when the two walks happen to get the rows back in different orders (about one run in
    // two); model.test.ts checks that order every time.
    const first = await runWalk(suite.env(), { seed: DETERMINISM_SEED, steps: DETERMINISM_STEPS, ...logOptions() });
    const second = await runWalk(suite.env(), { seed: DETERMINISM_SEED, steps: DETERMINISM_STEPS, ...logOptions() });
    const firstLog = JSON.stringify(first.log.ops);
    const secondLog = JSON.stringify(second.log.ops);
    if (firstLog !== secondLog) {
      const step = first.log.ops.findIndex((op, index) => JSON.stringify(op) !== JSON.stringify(second.log.ops[index]));
      assert.fail(`seed ${DETERMINISM_SEED} walked differently the second time, from step ${step + 1}:\n  ${JSON.stringify(first.log.ops[step])}\n  ${JSON.stringify(second.log.ops[step])}`);
    }
  });
});
