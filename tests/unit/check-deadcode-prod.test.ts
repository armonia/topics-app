/**
 * @covers GATE-02
 */
import { describe, expect, test } from "bun:test";
import { parseCounts } from "../../scripts/check-deadcode-prod";

describe("parseCounts", () => {
  test("reads the three sections of a knip report", () => {
    const out = ["Unused files (3)", "a.ts", "Unused exports (12)", "x  a.ts", "Unused exported types (4)", "T  a.ts"].join("\n");
    expect(parseCounts(out, 1)).toEqual({ files: 3, exports: 12, types: 4 });
  });

  test("a section that is missing counts as zero while others are present", () => {
    expect(parseCounts("Unused exports (2)\nx  a.ts\n", 1)).toEqual({ files: 0, exports: 2, types: 0 });
  });

  test("a clean run prints nothing and exits 0", () => {
    expect(parseCounts("", 0)).toEqual({ files: 0, exports: 0, types: 0 });
  });

  test("a failing run with no known section is an error, never zero", () => {
    expect(() => parseCounts("Unbekannte Ausgabe (7)", 1)).toThrow();
    expect(() => parseCounts("", 2)).toThrow();
  });
});
