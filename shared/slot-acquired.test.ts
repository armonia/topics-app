/**
 * @covers KANBAN-15
 */
import { describe, expect, test } from "bun:test";
import { SLOT_ACQUIRED_PREFIX, findSlotReacquired, findSlotQueuedAgain, parseSlotAcquired, parseSlotRun, slotAcquiredLine, slotQueuedAgainLine } from "./slot-acquired";

describe("the slot line: printed by slot.ts, read by the board's check runner", () => {
  test("what slot.ts prints is what the runner parses, queue time included", () => {
    const line = slotAcquiredLine("test:unit", 612_400);
    expect(line.startsWith(SLOT_ACQUIRED_PREFIX)).toBe(true);
    expect(parseSlotAcquired(`noise before\n${line}\nnoise after`)).toBe(612_000);
  });

  test("a slot that came at once still prints a line, and it reads as zero", () => {
    expect(parseSlotAcquired(slotAcquiredLine("lint", 0))).toBe(0);
  });

  test("no line, no queue: null, not zero - the runner must not restart a cap for nothing", () => {
    expect(parseSlotAcquired("[slot] lint: all 3 gate slots are busy, waiting for one.")).toBeNull();
    expect(parseSlotAcquired("")).toBeNull();
  });

  test("a second queue is told by the run's token only: a line without it, or with another, is output", () => {
    const first = slotAcquiredLine("typecheck", 0, "abc123");
    expect(parseSlotAcquired(first)).toBe(0);
    expect(parseSlotRun(`noise\n${first}\nmore`)?.run).toBe("abc123");
    expect(parseSlotRun(slotAcquiredLine("typecheck", 0))).toBeNull();
    const again = slotQueuedAgainLine("typecheck", "abc123", 41, 42);
    expect(findSlotQueuedAgain(`x\n${again}\n`, "abc123")).toMatchObject({ pid: 41, group: 42 });
    expect(findSlotQueuedAgain("[slot] waiting nested: x\n", "abc123")).toBeNull();
    expect(findSlotQueuedAgain(slotQueuedAgainLine("typecheck", "fff000", 41, 42), "abc123")).toBeNull();
    expect(findSlotReacquired(slotAcquiredLine("typecheck", 3000, "abc123"), "abc123")).toBeGreaterThan(0);
    expect(findSlotReacquired(slotAcquiredLine("typecheck", 3000), "abc123")).toBe(-1);
  });
});
