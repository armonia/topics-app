/**
 * THE CONTROL MEASURE OF THE SEMAPHORE, and what it is allowed to count.
 *
 * The probe answers one question: with N agents working, how many `bun test`
 * runs are alive against how many slots are declared. On 2026-08-27 at 02:40 it
 * would have answered TWO against a board declaring one agent, which is the
 * measurement this change comes from.
 *
 * WHAT IS TESTED HERE is the reading, because the reading is where a control
 * measure lies. Counting the wrapper (`bun run scripts/slot.ts ...`) or the
 * shell it spawns would double every number and turn "two runs" into "six",
 * making the probe useless exactly when it matters. The live count itself is
 * the state of the machine and belongs to the probe, not to a test.
 * @covers SLOT-02
 */
import { describe, it, expect } from "bun:test";
import { isBunTestRun, parsePs } from "./probe-gate-concurrency.ts";

describe("what counts as a run of the suite", () => {
  it("counts a bun test, however it was typed", () => {
    expect(isBunTestRun("bun test ./tests/unit")).toBe(true);
    expect(isBunTestRun("/opt/homebrew/bin/bun test --timeout 30000 ./client/src ./server/")).toBe(true);
    // A runtime flag may sit between the two: still one run.
    expect(isBunTestRun("bun --bun test ./tests/unit")).toBe(true);
  });

  it("does not count the queue standing in front of one", () => {
    // The wrapper and the shell it spawns are not runs. This is the shape the
    // real `test:unit` has, and counting it would double the number.
    expect(isBunTestRun("bun run scripts/slot.ts test:unit -- bun test ./tests/unit")).toBe(false);
    expect(isBunTestRun("/bin/sh -c bun test --timeout 30000 ./tests/unit")).toBe(false);
    expect(isBunTestRun("bun x something")).toBe(false);
    expect(isBunTestRun("bun")).toBe(false);
    expect(isBunTestRun("node test")).toBe(false);
  });
});

describe("reading `ps`", () => {
  const OUTPUT = [
    "  501 12:54 /opt/homebrew/bin/bun test --timeout 30000 --reporter=junit --reporter-outfile=/tmp/unit.xml ./client/src ./server/",
    "  777 04:02 /opt/homebrew/bin/bun test --timeout 30000 --reporter=junit --reporter-outfile=/tmp/unit.xml ./client/src ./server/",
    "  888 00:11 bun run scripts/slot.ts test:unit -- bun test ./tests/unit",
    "  999 01:00 /bin/sh -c echo hello",
    "garbage that is not a ps line",
  ].join("\n");

  it("finds the two runs that were measured, and only those", () => {
    const runs = parsePs(OUTPUT);
    expect(runs.map((r) => r.pid)).toEqual([501, 777]);
    expect(runs[0].elapsed, "the age is what says a run has been stuck for 12 minutes").toBe("12:54");
  });

  it("survives an empty or unreadable answer instead of throwing", () => {
    expect(parsePs("")).toEqual([]);
    expect(parsePs("\n\n")).toEqual([]);
  });
});
