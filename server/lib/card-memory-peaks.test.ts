/**
 * THE MEMORY PRICE OF A CARD, measured on its own checks.
 *
 * The admission gate used to price one more agent at the footprint of the live
 * sessions, which on the native runtime never includes a card: its tools and
 * checks are children of the server. Three things are measured here:
 *  1. A check round records ITS PEAK (the highest tree reading of any command,
 *     not the last), under the card's id.
 *  2. The ledger keeps one number per card: delivering twice replaces, it does
 *     not vote twice.
 *  3. The capacity route prices one agent from that ledger, the same list the
 *     gate reads, so the panel and the gate agree.
 * @covers KANBAN-75
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetCardMemPeaks, recentCardMemPeaksGB, recordCardMemPeak } from "./card-memory-peaks";
import { runReviewChecks } from "../services/review-checks";
import { computeDispatchCapacity } from "../services/dispatch-capacity";

let cwd = "";
beforeAll(() => { cwd = mkdtempSync(join(tmpdir(), "card-mem-peaks-")); });
afterAll(() => { rmSync(cwd, { recursive: true, force: true }); });
beforeEach(() => { _resetCardMemPeaks(); });

describe("the price list is per card", () => {
  test("a check round records the peak of its heaviest command, under the card", async () => {
    // The first command's tree reads 4 GB, the second's 1 GB: the round's peak
    // is the first, and a runner that kept the last reading would say 1.
    const byPid = new Map<number, number>();
    const runs = await runReviewChecks(
      [{ name: "shards", cmd: "sleep 0.3" }, { name: "lint", cmd: "sleep 0.3" }],
      {
        cwd,
        taskId: "card-a",
        missingInstallRoots: () => [],
        treeSampleMs: 40,
        sampleTreeKB: async (pid) => {
          if (!byPid.has(pid)) byPid.set(pid, byPid.size === 0 ? 4_000_000 : 1_000_000);
          return byPid.get(pid)!;
        },
      },
    );
    expect(runs.every((r) => r.ok)).toBe(true);
    const peaks = recentCardMemPeaksGB();
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!).toBeCloseTo((4_000_000 * 1024) / 1e9, 6);
  });

  test("one number per card: a second delivery replaces the first", () => {
    recordCardMemPeak("card-a", 3);
    recordCardMemPeak("card-b", 5);
    recordCardMemPeak("card-a", 7);
    expect(recentCardMemPeaksGB()).toEqual([5, 7]);
  });

  test("the capacity route prices one agent from the same ledger the gate reads", () => {
    for (const id of ["c1", "c2", "c3"]) recordCardMemPeak(id, 5);
    const cap = computeDispatchCapacity(0, () => null, false, () => 20);
    expect(cap.agentCostMemGB).toBe(5);
  });
});
