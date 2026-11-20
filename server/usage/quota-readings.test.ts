/**
 * @covers USAGE-28
 */
import { describe, expect, test } from "bun:test";
import { latestReadings } from "./quota-readings";

describe("latestReadings", () => {
  test("keeps the newest sample per account and window, in any file order", () => {
    const rows = latestReadings([
      { t: 300, s: { "claude|a@x|7d": 40 } },
      { t: 100, s: { "claude|a@x|7d": 10, "claude|a@x|5h": 5 } },
      { t: 200, s: { "codex|a@x|7d": 7, "claude|a@x|API": 0 } },
    ]);
    const claude = rows.find((r) => r.provider === "claude")!;
    expect(claude.week).toEqual({ pct: 40, t: 300 });
    expect(claude.fiveH).toEqual({ pct: 5, t: 100 });
    expect(rows.find((r) => r.provider === "codex")!.week?.pct).toBe(7);
    expect(rows).toHaveLength(2);
  });
});
