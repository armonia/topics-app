/**
 * @covers GATE-10
 *
 * THE BAR MUST NOT BE A SUBSET OF CI.
 *
 * `scripts/qa-gate.sh` answers one question — "is it green?" — and a developer
 * who reads BARRA VERDE stops looking. That answer is only worth anything if
 * the list it runs covers the static gates CI blocks on. On 2026-08-26 it did
 * not: `check:identifier-language`, `check:spec-coverage` and
 * `check:deadcode-blindspots` were in `.github/workflows/ci.yml` and not in the
 * bar, and the first of the three was RED while the script printed BARRA VERDE.
 * Nobody had added them; nobody had decided not to. The two lists had simply
 * drifted, and nothing was watching them drift.
 *
 * WHAT THIS TEST DOES. It reads both files, and for every `bun run check:*`
 * that CI invokes it demands one of two things:
 *
 *   1. the same gate is in the bar's own loop, or
 *   2. the gate is named in `DELIBERATELY_OUT` here AND its name appears in a
 *      comment inside `qa-gate.sh`.
 *
 * The second half is the point. An exclusion is a decision — `check:bundle`
 * needs a client build, `check:route-latency` measures milliseconds on a loaded
 * machine — and a decision that is not written down is indistinguishable from
 * an omission six weeks later. Requiring the name to appear in the script's own
 * prose means the reader of `qa-gate.sh` learns why it is missing there, where
 * the question occurs to them, instead of here.
 *
 * WHAT IT DOES NOT DO: it does not require the bar to be a subset of CI. The
 * bar may run MORE than CI does; that direction never produces a false green.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const CI = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const BAR = readFileSync(join(ROOT, "scripts/qa-gate.sh"), "utf8");

/**
 * Gates CI blocks on that the bar deliberately does not run. Each one has to be
 * argued in `qa-gate.sh` itself — the test below checks that the name is
 * actually written there, so this list cannot grow in silence.
 */
const DELIBERATELY_OUT: Record<string, string> = {
  "check:bundle": "needs public/ already built (bun run build:client)",
  "check:route-latency": "a TIME gate: on a loaded machine it measures the machine",
  "check:ink": "a TIME gate",
  "check:drag": "a TIME gate",
  "check:growth": "a TIME gate",
  "check:scroll-fluidity": "a TIME gate",
};

/** Every `check:*` gate CI actually invokes. */
const ciGates: Set<string> = new Set(
  [...CI.matchAll(/bun run (check:[a-z-]+)/g)].map((m) => m[1]!),
);

/**
 * The gates the bar runs. Read from the `for c in … ; do esegui "$c"` loop and
 * from the explicit `esegui <name>` lines, which is how the script itself
 * spells them.
 */
const barGates: Set<string> = new Set([
  ...[...BAR.matchAll(/(check:[a-z-]+)(?![a-z-])/g)]
    .filter((m) => {
      // Only names inside the loop body count as "run". A name that appears
      // solely in a comment is an exclusion being argued, not a gate.
      const lineStart = BAR.lastIndexOf("\n", m.index!) + 1;
      return !BAR.slice(lineStart, m.index!).trimStart().startsWith("#");
    })
    .map((m) => m[1]!),
]);

describe("the two lists are non-empty, or this file proves nothing", () => {
  // Both are scraped with a regex. A rewrite of either file that breaks a
  // pattern would leave an empty set, and an empty set satisfies every
  // assertion below while checking nothing.
  test("CI names a plausible number of gates", () => {
    expect(ciGates.size).toBeGreaterThan(15);
  });

  test("the bar names a plausible number of gates", () => {
    expect(barGates.size).toBeGreaterThan(12);
  });
});

describe("qa-gate.sh covers every static gate CI blocks on", () => {
  test("no gate is missing without a written reason", () => {
    const missing = [...ciGates].filter(
      (g) => !barGates.has(g) && !(g in DELIBERATELY_OUT),
    );
    expect(
      missing,
      "CI blocks on these and the bar does not run them: it would print BARRA VERDE where CI goes red. " +
        "Add them to the loop in scripts/qa-gate.sh, or to DELIBERATELY_OUT here with the reason written in that script.",
    ).toEqual([]);
  });

  test("every deliberate exclusion is argued in qa-gate.sh, not only here", () => {
    const unargued = Object.keys(DELIBERATELY_OUT).filter((g) => !BAR.includes(g));
    expect(
      unargued,
      "excluded from the bar but never named in it: whoever reads qa-gate.sh cannot find out why",
    ).toEqual([]);
  });

  test("and the check can actually fail", () => {
    // The non-vacuity half, asserted instead of trusted: a gate that is in
    // neither set must be reported. Without this, a `barGates` regex that
    // matched everything would keep the test above permanently green.
    const invented = "check:questo-cancello-non-esiste";
    expect(barGates.has(invented)).toBe(false);
    expect(invented in DELIBERATELY_OUT).toBe(false);
  });
});
