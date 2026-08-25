/**
 * The parts of the memory bench that can be wrong SILENTLY.
 *
 * A bench fails loudly when it cannot boot a server. It fails quietly when the
 * tree walk misses a subtree, when the platform check falls back to a metric
 * nobody named, or when the slope is computed from points that are not a line:
 * in each of those cases a number is still printed, and it is wrong. Those are
 * the three things pinned here, with a synthetic process table so the assertions
 * do not depend on what this machine happens to be running.
  * @covers MEM-BENCH-01
 */

import { describe, expect, test } from "bun:test";

import {
  mb,
  median,
  metricForPlatform,
  parseCounts,
  parsePsRows,
  parseSmapsRollup,
  pidsMatching,
  slopeOf,
  treeOf,
} from "./proc";
import { withoutClaudeEnv } from "./memory";
import type { ProcRow } from "./proc";

describe("metric selection per platform", () => {
  test("names the metric each platform can answer honestly", () => {
    expect(metricForPlatform("darwin")).toBe("phys_footprint");
    expect(metricForPlatform("linux")).toBe("pss");
  });

  test("returns null rather than a metric it cannot defend", () => {
    // The defect this guards: a bench that quietly falls back to `rss` on a
    // platform it cannot measure still prints a number, and the number gets
    // compared against a footprint taken elsewhere.
    expect(metricForPlatform("win32")).toBeNull();
    expect(metricForPlatform("freebsd")).toBeNull();
    expect(metricForPlatform("")).toBeNull();
  });
});

describe("process table parsing", () => {
  test("keeps the whole command line, spaces included", () => {
    const rows = parsePsRows(
      [
        "  501     1 node /path/pty-bridge.mjs --socket /tmp/topics pty.sock --parent-pid 9",
        "  502   501 claude --dangerously-skip-permissions",
      ].join("\n"),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pid: 501, ppid: 1 });
    // A split on whitespace would have cut this in half and the bridge would
    // never be found by its socket path.
    expect(rows[0].command).toContain("/tmp/topics pty.sock");
    expect(rows[1]).toMatchObject({ pid: 502, ppid: 501 });
  });

  test("skips lines that are not process rows", () => {
    expect(parsePsRows("PID PPID COMMAND\n\n   7   1 bun\n")).toEqual([
      { pid: 7, ppid: 1, command: "bun" },
    ]);
  });
});

describe("the tree walk", () => {
  const table: ProcRow[] = [
    { pid: 1, ppid: 0, command: "launchd" },
    { pid: 10, ppid: 1, command: "bun run server.ts" },
    { pid: 11, ppid: 10, command: "server child" },
    { pid: 12, ppid: 11, command: "server grandchild" },
    { pid: 20, ppid: 1, command: "node pty-bridge.mjs --socket /tmp/bench.sock" },
    { pid: 21, ppid: 20, command: "claude" },
    { pid: 22, ppid: 21, command: "mcp server" },
    { pid: 30, ppid: 1, command: "Chromium" },
    { pid: 31, ppid: 30, command: "Chromium Helper (Renderer)" },
    { pid: 99, ppid: 1, command: "somebody else" },
  ];

  test("reaches grandchildren, which is where the memory actually is", () => {
    // The whole point: the server process alone read 87 MB while the fleet it
    // owned held about 5 GB. A walk one level deep is a 50x undercount.
    expect(treeOf(table, [10])).toEqual([10, 11, 12]);
  });

  test("unions overlapping roots without double counting a pid", () => {
    expect(treeOf(table, [10, 11, 30])).toEqual([10, 11, 12, 30, 31]);
  });

  test("drops a root that is not in the table instead of inventing it", () => {
    expect(treeOf(table, [4242])).toEqual([]);
    expect(treeOf(table, [10, 4242])).toEqual([10, 11, 12]);
  });

  test("terminates on a cycle", () => {
    // Reparenting plus pid reuse can produce a snapshot where ppid points back
    // into the set. A walk that assumed a forest would spin here forever.
    const cyclic: ProcRow[] = [
      { pid: 5, ppid: 6, command: "a" },
      { pid: 6, ppid: 5, command: "b" },
    ];
    expect(treeOf(cyclic, [5])).toEqual([5, 6]);
  });

  test("never counts pid 1's whole world just because a root was reparented", () => {
    // Walking from the bridge must not sweep in every other launchd child.
    expect(treeOf(table, [20])).toEqual([20, 21, 22]);
    expect(treeOf(table, [20])).not.toContain(99);
  });

  test("finds the detached bridge by its socket, and not the searcher", () => {
    expect(pidsMatching(table, "/tmp/bench.sock")).toEqual([20]);
    expect(pidsMatching(table, "/tmp/bench.sock", [20])).toEqual([]);
  });
});

describe("PSS parsing on linux", () => {
  test("reads Pss out of smaps_rollup", () => {
    expect(parseSmapsRollup("Rss:  100 kB\nPss:  73512 kB\nShared_Clean: 1 kB\n")).toBe(73512);
  });

  test("returns null when the kernel did not offer it", () => {
    expect(parseSmapsRollup("Rss: 100 kB\n")).toBeNull();
  });
});

describe("the slope: the number the bench exists for", () => {
  test("recovers the marginal cost from points on a line", () => {
    // 40 MB of shell, 12 MB a topic.
    const bytes = (n: number): number => (40 + 12 * n) * 1024 * 1024;
    const slope = slopeOf([
      { n: 0, bytes: bytes(0) },
      { n: 1, bytes: bytes(1) },
      { n: 5, bytes: bytes(5) },
      { n: 10, bytes: bytes(10) },
    ]);
    expect(slope).not.toBeNull();
    expect(mb((slope as NonNullable<typeof slope>).perUnitBytes)).toBe(12);
    expect(mb((slope as NonNullable<typeof slope>).interceptBytes)).toBe(40);
    expect((slope as NonNullable<typeof slope>).r2).toBeCloseTo(1, 6);
  });

  test("reports r2 well below 1 when the points are not a line", () => {
    // A residency cap flattens the curve after a while, and the fitted slope
    // then describes neither half. r2 is the reader's warning that it happened.
    const slope = slopeOf([
      { n: 0, bytes: 100 },
      { n: 1, bytes: 200 },
      { n: 5, bytes: 600 },
      { n: 10, bytes: 610 },
      { n: 25, bytes: 615 },
    ]);
    expect(slope).not.toBeNull();
    expect((slope as NonNullable<typeof slope>).r2).toBeLessThan(0.8);
  });

  test("publishes the consecutive steps, not only the fitted line", () => {
    const slope = slopeOf([
      { n: 0, bytes: 0 },
      { n: 1, bytes: 100 },
      { n: 5, bytes: 300 },
    ]);
    expect((slope as NonNullable<typeof slope>).steps).toEqual([
      { from: 0, to: 1, perUnitBytes: 100 },
      { from: 1, to: 5, perUnitBytes: 50 },
    ]);
  });

  test("sorts the points before fitting, so measurement order cannot change the answer", () => {
    const ordered = slopeOf([
      { n: 0, bytes: 0 },
      { n: 4, bytes: 400 },
    ]);
    const shuffled = slopeOf([
      { n: 4, bytes: 400 },
      { n: 0, bytes: 0 },
    ]);
    expect(shuffled).toEqual(ordered);
  });

  test("says nothing rather than zero when there is not enough evidence", () => {
    // "Not enough points" printed as a slope of 0 would read as "the Nth topic
    // is free", which is the most flattering possible lie for this product.
    expect(slopeOf([])).toBeNull();
    expect(slopeOf([{ n: 3, bytes: 10 }])).toBeNull();
    expect(
      slopeOf([
        { n: 3, bytes: 10 },
        { n: 3, bytes: 20 },
      ]),
    ).toBeNull();
  });

  test("a flat set of points is a zero slope with r2 1, not a division by zero", () => {
    const slope = slopeOf([
      { n: 0, bytes: 500 },
      { n: 5, bytes: 500 },
    ]);
    expect((slope as NonNullable<typeof slope>).perUnitBytes).toBe(0);
    expect((slope as NonNullable<typeof slope>).r2).toBe(1);
  });
});

describe("sample reduction and arguments", () => {
  test("the median resists one bad sample", () => {
    expect(median([100, 102, 9000])).toBe(102);
    expect(median([100, 200])).toBe(150);
    expect(median([])).toBe(0);
  });

  test("counts are parsed, ordered and deduplicated", () => {
    expect(parseCounts("1,5,10,25")).toEqual([1, 5, 10, 25]);
    expect(parseCounts("10, 1 ,10,")).toEqual([1, 10]);
    expect(parseCounts("0,-3,abc")).toEqual([]);
  });

  test("CLAUDE* is scrubbed so both sides of the comparison start clean", () => {
    const env = withoutClaudeEnv({
      PATH: "/usr/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "abc",
      HOME: "/Users/x",
      EMPTY: undefined,
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/x" });
  });
});
