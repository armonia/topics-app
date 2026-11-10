import { describe, expect, test } from "bun:test";
import { findRegressions } from "./e2e-duration-regressions";

describe("findRegressions", () => {
  test("flags a file that grew past both the relative and absolute floor", () => {
    const before = { "a.spec.ts": 20 };
    const after = { "a.spec.ts": 30 }; // +10s, +50%
    expect(findRegressions(before, after)).toEqual([
      { file: "a.spec.ts", beforeS: 20, afterS: 30, growthPct: 0.5 },
    ]);
  });

  test("ignores a big percentage over a tiny absolute duration", () => {
    const before = { "a.spec.ts": 0.3 };
    const after = { "a.spec.ts": 0.9 }; // +200%, but +0.6s
    expect(findRegressions(before, after)).toEqual([]);
  });

  test("ignores a small percentage over a long duration", () => {
    const before = { "a.spec.ts": 120 };
    const after = { "a.spec.ts": 126 }; // +6s, but +5%
    expect(findRegressions(before, after)).toEqual([]);
  });

  test("ignores a file with no prior measurement (new spec)", () => {
    const before = {};
    const after = { "new.spec.ts": 100 };
    expect(findRegressions(before, after)).toEqual([]);
  });

  test("ignores a file dropped from the fresh snapshot (removed spec)", () => {
    const before = { "gone.spec.ts": 100 };
    const after = {};
    expect(findRegressions(before, after)).toEqual([]);
  });

  test("ignores a file that got faster", () => {
    const before = { "a.spec.ts": 30 };
    const after = { "a.spec.ts": 20 };
    expect(findRegressions(before, after)).toEqual([]);
  });

  test("sorts slowest growth first", () => {
    const before = { "small.spec.ts": 10, "big.spec.ts": 10 };
    const after = { "small.spec.ts": 16, "big.spec.ts": 30 }; // +60%, +200%
    const result = findRegressions(before, after);
    expect(result.map((r) => r.file)).toEqual(["big.spec.ts", "small.spec.ts"]);
  });
});
