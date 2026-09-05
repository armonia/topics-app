/**
 * @covers KANBAN-15
 */
import { describe, expect, test } from "bun:test";
import { SLOT_ACQUIRED_PREFIX, parseSlotAcquired, slotAcquiredLine } from "./slot-acquired";

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
});
