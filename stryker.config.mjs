// @ts-check
// Mutation testing (spec-flow D9 Tier A): measures whether the tests CATCH bugs, not just whether
// they run the lines. Stryker changes the code on purpose (a `>` into `>=`, a `true` into
// `false`, a branch removed) and reruns the tests that cover that spot: a surviving mutant is a
// bug the suite would let through. `spec-flow check-mutation` turns the report into a per-file
// ratchet against spec-flow.mutation-baseline.json.
//
// The scope is `mutation.tierA` in spec-flow.completeness.json, the one place it lives: a
// campaign over the whole server costs days (26k mutants over a 3-minute suite, as measured in
// my-little-software-factory#157). It widens by adding a module there, one at a time.
//
// Linux and macOS only: the Bun runner needs process.getuid, so it refuses to start on Windows.
import { readFileSync } from "node:fs";

const { tierA } = JSON.parse(readFileSync(new URL("./spec-flow.completeness.json", import.meta.url), "utf8")).mutation;

/** @type {Record<string, unknown>} Stryker's PartialStrykerOptions; typed loosely so knip does not want @stryker-mutator/api as a dependency. */
export default {
  appendPlugins: ["@hughescr/stryker-bun-runner"],
  testRunner: "bun",
  coverageAnalysis: tierA.coverageAnalysis,
  mutate: tierA.targets,
  // Only the TS sources: the default also parses the HTML under docs/ and stops on a
  // malformed mockup.
  disableTypeChecks: "{server,shared,scripts}/**/*.ts",
  bun: { testFiles: tierA.tests, timeout: 300_000 },
  reporters: ["clear-text", "json", "progress"],
  jsonReporter: { fileName: tierA.report },
  incremental: tierA.incremental,
  incrementalFile: "reports/mutation/stryker-incremental.json",
  thresholds: { high: tierA.threshold * 100, low: 70, break: null },
  timeoutMS: 10_000,
  concurrency: 8,
  tempDirName: ".stryker-tmp",
};
