/**
 * THE THIRD OUTCOME OF `check:ink`, PROVED BY RUNNING IT.
 *
 * WHY THIS FILE EXISTS, NEXT TO THE OTHER ONE. `perf-gates-third-outcome.test.ts`
 * already holds the shape of the CI step (exit 2 becomes an annotated warning,
 * exit 1 still stops the run) and, for the script, it reads the SOURCE with two
 * regexes. A regex over source text cannot prove an exit code. Two of the four
 * places `scripts/check-ink-latency.ts` returns from are not covered by it at
 * all: the missing result file, and the run that measured only some of the
 * three gestures. Swap `NOT_MEASURED` for `OVER_BUDGET` in either of them and
 * that test stays green while CI starts calling "I did not measure" a
 * regression, which is the exact defect the gate was given a third outcome for
 * on run 33027396174.
 *
 * So this file executes the real script bytes and asserts the number it hands
 * back. The five cases are the whole decision table:
 *
 *   no measurement on disk            -> 2  abstain
 *   every gesture inside the budget   -> 0  pass
 *   one gesture over the budget       -> 1  red
 *   one gesture missing from the run  -> 2  abstain
 *   one over AND one missing          -> 1  a measured overrun beats silence
 *
 * Plus the sixth that is not about measuring at all: a mistyped `--stall` must
 * stop the run (1) and never abstain (2). An abstention there would turn a typo
 * in a CI argument into a warning nobody reads.
 *
 * HERMETIC BY COPY, not by an env var. The script derives its repo root from
 * its own location, so a copy of it under a scratch directory reads the budget
 * and the measurement from that directory. Nothing is stubbed and no
 * production code gained a test-only hook: the file under test is the same
 * bytes that ship.
 * @covers GATE-04
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testTmpDir } from "../integration/helpers";

const REPO_ROOT = join(import.meta.dir, "../..");
const SCRIPT_REL = "scripts/check-ink-latency.ts";
const BUDGET_REL = "tests/e2e/ink-budget.json";
const RESULT_REL = "test-results/ink-latency.json";

/** The scratch repo the copied script sees as its own root. */
let root = "";

/** One gesture's measurement, in the shape the spec writes it. */
function gesture(medianMs: number, maxMs = medianMs): Record<string, unknown> {
  return { samples: [medianMs, maxMs], frames: [1, 1], medianMs, minMs: medianMs, maxMs };
}

/** Write the measurement file, or remove it when given null. */
function measurement(gestures: Record<string, unknown> | null): void {
  const path = join(root, RESULT_REL);
  if (gestures === null) {
    rmSync(path, { force: true });
    return;
  }
  writeFileSync(
    path,
    JSON.stringify({
      measuredAt: "2026-08-27T10:00:00.000Z",
      samplesPerGesture: 2,
      stallMs: 0,
      gestures,
    }),
  );
}

/** Run the copied gate with `--no-run` (no Playwright) and report its exit. */
function runGate(extraArgs: string[] = []): { code: number; out: string } {
  const run = spawnSync(process.execPath, [join(root, SCRIPT_REL), "--no-run", ...extraArgs], {
    cwd: root,
    encoding: "utf8",
  });
  return { code: run.status ?? -1, out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

beforeAll(() => {
  root = testTmpDir("check-ink-exit-codes");
  for (const rel of [SCRIPT_REL, BUDGET_REL, RESULT_REL]) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
  }
  copyFileSync(join(REPO_ROOT, SCRIPT_REL), join(root, SCRIPT_REL));
  copyFileSync(join(REPO_ROOT, BUDGET_REL), join(root, BUDGET_REL));
});

describe("check:ink: i tre esiti si vedono ESEGUENDOLO", () => {
  it("senza nessuna misura sul disco si astiene (2), e non dice che va tutto bene", () => {
    measurement(null);
    const { code, out } = runGate();
    expect(code).toBe(2);
    expect(out).toContain("no measurement");
  });

  it("tre gesti dentro il budget: verde (0)", () => {
    measurement({ card: gesture(23), tab: gesture(14), send: gesture(12) });
    const { code, out } = runGate();
    expect(code).toBe(0);
    expect(out).toContain("All three under budget.");
  });

  it("un gesto oltre la mediana di budget: rosso (1), non un'astensione", () => {
    // The budget is 100ms median: 140 is over it by a margin no scheduling
    // noise explains, so this case does not depend on the machine.
    measurement({ card: gesture(140), tab: gesture(14), send: gesture(12) });
    const { code, out } = runGate();
    expect(code).toBe(1);
    expect(out).toContain("Over budget:");
  });

  it("un solo campione oltre il tetto: rosso (1) anche con la mediana buona", () => {
    // The ceiling is the half a median cannot see: four samples at 13ms and one
    // at 300ms is a stall a user felt, and the median hides it.
    measurement({ card: gesture(13, 300), tab: gesture(14), send: gesture(12) });
    expect(runGate().code).toBe(1);
  });

  it("un gesto che non ha prodotto un numero: astensione (2), mai verde", () => {
    measurement({ card: gesture(23), tab: gesture(14) });
    const { code, out } = runGate();
    expect(code).toBe(2);
    expect(out).toContain("Not measured");
  });

  it("uno sforo MISURATO batte l'astensione: rosso (1), non 2", () => {
    measurement({ card: gesture(140), tab: gesture(14) });
    expect(runGate().code).toBe(1);
  });

  it("un `--stall` scritto male ferma la run (1): un errore di invocazione non si astiene", () => {
    // Exit 2 here would let a typo in the CI argument through as a warning:
    // the gate would announce it did not measure, and nobody would look.
    measurement({ card: gesture(23), tab: gesture(14), send: gesture(12) });
    const { code, out } = runGate(["--stall", "banana"]);
    expect(code).toBe(1);
    expect(out).toContain("--stall");
  });
});
