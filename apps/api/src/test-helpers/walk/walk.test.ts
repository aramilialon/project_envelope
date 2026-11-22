/**
 * A seeded model-based random walk through the API on demand (#80, ADR 0013): any seed for any
 * number of steps, or a failure's operation log replayed. With neither `WALK_SEED` nor
 * `WALK_REPLAY` set it does nothing: the walks CI runs are in files of their own, one per seed or
 * check (`suite.ts`, #638, ADR 0016).
 *
 *   WALK_SEED=1234 WALK_STEPS=5000 node --test src/test-helpers/walk/walk.test.ts   # a long run
 *   WALK_REPLAY=/tmp/envelope-walk-….json node --test src/test-helpers/walk/walk.test.ts
 *   WALK_DRIVER=fetch                                                              # through the real process
 *
 * A failure prints the seed, the step and the path of the operation log it wrote.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runWalk, type WalkEnvironment, type WalkLog } from "./run.ts";
import { CI_STEPS, logOptions, report, useWalkSuite } from "./suite.ts";

function numberFromEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${name} must be an integer, got ${value}`);
  return number;
}

const replay = process.env.WALK_REPLAY ? (JSON.parse(readFileSync(process.env.WALK_REPLAY, "utf8")) as WalkLog) : undefined;
const seed = numberFromEnv("WALK_SEED");
const steps = numberFromEnv("WALK_STEPS");

if (replay === undefined && seed === undefined) {
  it.skip("walks on demand only: set WALK_SEED or WALK_REPLAY (README, \"The random walk\")");
} else {
  describe("random walk through the API, on demand (#80, ADR 0013)", () => {
    const throughFetch = process.env.WALK_DRIVER === "fetch";
    // The real server starts queue workers and schedules: a database of its own (#638).
    const suite = useWalkSuite({ isolatedDatabase: throughFetch });

    async function walkEnvironment(): Promise<WalkEnvironment> {
      return throughFetch ? suite.fetchEnvironment() : suite.env();
    }

    it(replay ? `replays ${process.env.WALK_REPLAY}` : `walks seed ${seed} for ${steps ?? CI_STEPS} steps`, { timeout: Infinity }, async () => {
      const chosen = await walkEnvironment();
      try {
        const result = await runWalk(chosen, {
          ...(replay ? { seed: replay.seed, steps: replay.ops.length, replay } : { seed: seed!, steps: steps ?? CI_STEPS }),
          ...logOptions(),
        });
        report(result, chosen.driver.name);
        if (process.env.WALK_SAVE_LOG === "1") {
          // A walk that passed keeps its log too, to compare two runs of one seed (they must match).
          const file = join(process.env.WALK_LOG_DIR ?? tmpdir(), `envelope-walk-seed${result.seed}-passed-${process.pid}-${Date.now()}.json`);
          writeFileSync(file, `${JSON.stringify(result.log, null, 1)}\n`);
          console.log(`operation log: ${file}`);
        }
      } finally {
        await suite.stopRealServer();
      }
    });
  });
}
