// @ts-check
// Mutation testing: measures whether the tests CATCH bugs, not just whether they run the lines.
// Stryker changes the code on purpose (a `>` into `>=`, a `true` into `false`, a branch removed)
// and reruns the tests that cover that spot: a surviving mutant is a bug the suite would let
// through. The per-file score lives in `scripts/mutation-baseline.json` and can only go up:
// `scripts/check-mutation.ts` reads it.
//
// The scope is the CRITICAL list in `scripts/mutation-critical.ts`, not the whole repo: a
// campaign over the whole server costs days (26k mutants over a 3-minute suite, as measured in
// my-little-software-factory#157). It widens by adding modules there, one at a time.
//
// Linux and macOS only: the Bun runner needs process.getuid, so it refuses to start on Windows.
import { CRITICAL } from "./scripts/mutation-critical.ts";

/** @type {Record<string, unknown>} Stryker's PartialStrykerOptions; typed loosely so knip does not want @stryker-mutator/api as a dependency. */
export default {
  appendPlugins: ["@hughescr/stryker-bun-runner"],
  testRunner: "bun",
  coverageAnalysis: "perTest",
  mutate: CRITICAL.map((m) => m.source),
  // Only the TS sources: the default also parses the HTML under docs/ and stops on a
  // malformed mockup.
  disableTypeChecks: "{server,shared,scripts}/**/*.ts",
  bun: {
    testFiles: [...new Set(CRITICAL.flatMap((m) => m.tests))],
    timeout: 300_000,
  },
  reporters: ["clear-text", "json", "progress"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  incremental: true,
  incrementalFile: "reports/mutation/stryker-incremental.json",
  thresholds: { high: 90, low: 70, break: null },
  timeoutMS: 10_000,
  concurrency: 8,
  tempDirName: ".stryker-tmp",
};
