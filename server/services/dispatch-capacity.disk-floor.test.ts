/**
 * @covers WORKTREE-STD-01
 *
 * The disk floor is a setting (`worktree_disk_floor_gb`) whose default is the old
 * constant: the verdict takes the floor as its last argument, and the sentence
 * names the number that was used.
 */
import { describe, expect, test } from "bun:test";
import { DISPATCH_MEM_FLOOR_GB, dispatchResourceVerdict } from "./dispatch-capacity";
import { DEFAULT_WORKTREE_DISK_FLOOR_GB as DISPATCH_DISK_FLOOR_GB } from "../../shared/worktree-settings";
import type { HeldMemory } from "./mem-signal";

const wideMemory = (): HeldMemory => ({ measurable: true, latestGB: DISPATCH_MEM_FLOOR_GB + 8, heldGB: DISPATCH_MEM_FLOOR_GB + 8, coveredMs: 120_000 });

describe("disk floor from the settings", () => {
  test("the default is the old constant, 12 GB", () => {
    expect(DISPATCH_DISK_FLOOR_GB).toBe(12);
  });

  test("20 GB free is under a floor of 30 and the sentence says 30", () => {
    const verdict = dispatchResourceVerdict("/x", () => 20, wideMemory, true, undefined, [], 30);
    expect(verdict.kind).toBe("disk");
    expect(verdict.reason).toContain("sotto il pavimento di 30 GB");
  });

  test("20 GB free passes a floor of 15", () => {
    expect(dispatchResourceVerdict("/x", () => 20, wideMemory, true, undefined, [], 15).reason).toBeNull();
  });

  test("without an explicit floor the setting is read, and an untouched one is 12", () => {
    expect(dispatchResourceVerdict("/x", () => 11.9, wideMemory).kind).toBe("disk");
    expect(dispatchResourceVerdict("/x", () => 12, wideMemory).reason).toBeNull();
  });
});
