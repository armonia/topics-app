/**
 * @covers GATE-19
 *
 * `scripts/qa-gate.sh` runs typecheck, lint and the static gates in parallel
 * lanes. That is only safe while two things stay true, and neither is visible in
 * a green bar: (1) the one gate that WRITES into the sources
 * (`check:deadcode-blindspots` appends a probe to every project file) never sits
 * in a lane, and (2) every gate a lane measures is also reported in the summary,
 * so a lane cannot run a gate and silently drop its row (a red nobody reads).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BAR = readFileSync(join(import.meta.dir, "..", "..", "scripts/qa-gate.sh"), "utf8");

/** The gate names inside the `STATICI=( ... )` array, comments excluded. */
function lanedGates(): string[] {
  const m = /STATICI=\(([\s\S]*?)\)\n/.exec(BAR);
  expect(m, "qa-gate.sh no longer declares STATICI").not.toBeNull();
  return [...m![1]!.matchAll(/check:[a-z0-9-]+/g)].map((x) => x[0]);
}

describe("qa-gate.sh lanes", () => {
  test("the lane list is not empty (or the checks below prove nothing)", () => {
    expect(lanedGates().length).toBeGreaterThan(15);
  });

  test("the gate that writes into the sources never runs in a lane", () => {
    expect(lanedGates()).not.toContain("check:deadcode-blindspots");
  });

  test("it runs alone, after the lanes have joined", () => {
    const wait = BAR.indexOf("\nwait\n");
    const solo = BAR.indexOf("misura check:deadcode-blindspots");
    expect(wait).toBeGreaterThan(0);
    expect(solo).toBeGreaterThan(wait);
  });

  test("every gate that is measured is reported, in the summary loop", () => {
    const summary = /for c in "\$\{STATICI\[@\]\}" ([^;]*); do\n\s+riferisci/.exec(BAR);
    expect(summary, "the summary loop changed shape").not.toBeNull();
    const extra = summary![1]!.trim().split(/\s+/);
    expect(extra).toEqual(["check:deadcode-blindspots", "typecheck", "lint"]);
  });
});
