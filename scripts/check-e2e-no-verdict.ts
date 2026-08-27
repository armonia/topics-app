#!/usr/bin/env bun
/**
 * scripts/check-e2e-no-verdict.ts - names the tests that got NO verdict.
 *
 * WHY IT EXISTS
 * When a worker dies halfway through a shard, Playwright does not fail those
 * tests: it stops starting them. The summary then reads
 * `909 passed, 17 skipped, 9 did not run` - and those nine are coverage that
 * VANISHED without a red of its own. One yellow line in the middle of a
 * thousand, with no names: nobody can say afterwards WHICH nine scenarios were
 * not measured that night, so the run cannot be read as a statement about the
 * code. Measured on the nightly of 2026-08-15 (run 31863080604): nine tests
 * with no verdict, invisible in the job summary.
 *
 * A skip is a decision (someone wrote `test.skip` and a reason). A did-not-run
 * is an accident, and the two must not look alike in a log.
 *
 * WHAT COUNTS AS "NO VERDICT", and why it is copied and not invented
 * The rule is Playwright's own, from its base reporter's `generateSummary()`:
 * a test whose outcome is `skipped` is
 *   - INTERRUPTED, if one of its results has status `interrupted` (it had
 *     started when the worker went down);
 *   - DID NOT RUN, if it has no results at all, or its `expectedStatus` is not
 *     `skipped` (i.e. nobody asked for it to be skipped);
 *   - a real SKIP otherwise - declared, not lost.
 * Reimplementing that rule by eye is how a gate ends up disagreeing with the
 * summary printed right above it.
 *
 * EXIT CODES
 *   0  every test in the report has a verdict (or is a declared skip)
 *   1  at least one test has none: they are listed, with file and title
 *   2  no report could be read (bad path, unparseable JSON)
 *
 * USAGE
 *   bun run scripts/check-e2e-no-verdict.ts test-results/results.json
 *   bun run scripts/check-e2e-no-verdict.ts downloaded-results/-star-/results.json
 * Wired as a step of .github/workflows/e2e-nightly.yml (runs with always(),
 * after each shard).
 */

import { readFileSync } from "fs";

type PwResult = { status?: string };
type PwTest = {
  status?: string;
  expectedStatus?: string;
  results?: PwResult[];
};
type PwSpec = { file?: string; title?: string; line?: number; tests?: PwTest[] };
type PwSuite = { file?: string; suites?: PwSuite[]; specs?: PwSpec[] };
type PwJson = { suites?: PwSuite[] };

export type LostTest = {
  file: string;
  title: string;
  line?: number;
  kind: "did-not-run" | "interrupted";
};

/**
 * Classifies one test the way Playwright's own summary does.
 * Returns null when the test has a verdict (passed, failed, flaky, or a skip
 * that somebody actually declared).
 */
export function classify(test: PwTest): LostTest["kind"] | null {
  if (test.status !== "skipped") return null;
  const results = test.results ?? [];
  if (results.some((r) => r.status === "interrupted")) return "interrupted";
  if (results.length === 0 || test.expectedStatus !== "skipped") return "did-not-run";
  return null;
}

/** Walks the report tree and collects every test left without a verdict. */
export function collectLost(json: PwJson): LostTest[] {
  const lost: LostTest[] = [];
  const walk = (suite: PwSuite): void => {
    for (const child of suite.suites ?? []) walk(child);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const kind = classify(test);
        if (!kind) continue;
        lost.push({
          file: spec.file ?? suite.file ?? "(file sconosciuto)",
          title: spec.title ?? "(senza titolo)",
          line: spec.line,
          kind,
        });
      }
    }
  };
  for (const suite of json.suites ?? []) walk(suite);
  return lost;
}

function main(): number {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (paths.length === 0) {
    console.error("uso: bun run scripts/check-e2e-no-verdict.ts <results.json> [...]");
    return 2;
  }

  const lost: LostTest[] = [];
  let read = 0;
  for (const path of paths) {
    let json: PwJson;
    try {
      json = JSON.parse(readFileSync(path, "utf8")) as PwJson;
    } catch (err) {
      console.error(`report illeggibile: ${path} (${(err as Error).message})`);
      continue;
    }
    read++;
    lost.push(...collectLost(json));
  }

  if (read === 0) {
    console.error("Nessun report letto: non si puo' dire nulla sulla copertura.");
    return 2;
  }

  if (lost.length === 0) {
    console.log(`Ogni test ha un verdetto (${read} report letti).`);
    return 0;
  }

  // The GitHub annotation carries the COUNT, the log carries the NAMES: the
  // first is what shows on the run page, the second is what makes it usable.
  console.log(
    `::error title=Copertura persa::${lost.length} test senza verdetto ` +
      `(worker morto a meta' shard): la loro copertura e' sparita, non e' passata.`,
  );
  const MAX_LISTED = 40;
  for (const t of lost.slice(0, MAX_LISTED)) {
    const where = t.line ? `${t.file}:${t.line}` : t.file;
    console.log(`  · [${t.kind}] ${where} > ${t.title}`);
  }
  if (lost.length > MAX_LISTED) {
    console.log(`  ... e altri ${lost.length - MAX_LISTED}.`);
  }
  console.log(
    "\nQuesti non sono skip: nessuno li ha dichiarati. Sono test che non hanno girato\n" +
      "perche' il worker e' caduto, e senza questa riga sarebbero spariti in silenzio.",
  );
  return 1;
}

if (import.meta.main) process.exit(main());
