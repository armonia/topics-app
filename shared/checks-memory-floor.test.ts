/**
 * The one reader of the checks memory floor, which is what keeps the number in
 * the panel and the number the brake applies from being two numbers.
 *
 * @covers KANBAN-15
 * @covers KANBAN-90
 */
import { describe, expect, test } from "bun:test";
import {
  CHECKS_MEM_FLOOR_DEFAULT_GB,
  CHECKS_MEM_FLOOR_MAX_GB,
  CHECKS_MEM_FLOOR_MIN_GB,
  checksMemFloorGB,
  checksMemFloorIsOff,
} from "./checks-memory-floor";

describe("the checks memory floor setting", () => {
  test("the default is 3 GB, and it is the answer to every value that is not a number", () => {
    // THE DEFAULT IS THE CHANGE. It was 6 - the floor for admitting an AGENT,
    // borrowed by the checks brake and three times the heaviest command it
    // guards (`lint` from cold, 1.91 GB measured 17/09/2026). At 6 the brake
    // held the round back in 86.2% of 1828 `[memsig]` readings; at 3 it holds
    // 1.0% of them, and the lowest reading in the whole log was 2.7 GB.
    expect(CHECKS_MEM_FLOOR_DEFAULT_GB).toBe(3);
    expect(checksMemFloorGB({})).toBe(3);
    expect(checksMemFloorGB({ checksMemFloorGB: undefined })).toBe(3);
    expect(checksMemFloorGB({ checksMemFloorGB: Number.NaN })).toBe(3);
    expect(checksMemFloorGB({ checksMemFloorGB: Number.POSITIVE_INFINITY })).toBe(3);
    expect(checksMemFloorGB({ checksMemFloorGB: "4" as unknown as number })).toBe(3);
  });

  test("zero survives the round trip: it is a setting, not a missing value", () => {
    // The one value the defaulting must NOT swallow. `0` is the owner switching
    // the brake off; turning it into 3 would silently refuse the setting, which
    // is the failure the concurrency cap already paid for with its own zero.
    expect(checksMemFloorGB({ checksMemFloorGB: 0 })).toBe(0);
    expect(checksMemFloorIsOff(0)).toBe(true);
    expect(checksMemFloorIsOff(3)).toBe(false);
  });

  test("out of range is clamped, not refused, and a fraction lands where the panel shows it", () => {
    expect(checksMemFloorGB({ checksMemFloorGB: -5 })).toBe(CHECKS_MEM_FLOOR_MIN_GB);
    expect(checksMemFloorGB({ checksMemFloorGB: 40 })).toBe(CHECKS_MEM_FLOOR_MAX_GB);
    // Rounded HERE and not in the field, so a value written by hand or by an
    // older client lands on what the panel would have shown.
    expect(checksMemFloorGB({ checksMemFloorGB: 2.4 })).toBe(2);
    expect(checksMemFloorGB({ checksMemFloorGB: 2.6 })).toBe(3);
    // A fraction under half a gigabyte is NOT rounded down into "off": it is a
    // floor somebody asked for, and off has to be asked for explicitly.
    expect(checksMemFloorGB({ checksMemFloorGB: 0.6 })).toBe(1);
  });

  test("the bounds say what they are for", () => {
    expect(CHECKS_MEM_FLOOR_MIN_GB).toBe(0);
    // Above half the RAM of the machines this runs on, a floor would hold every
    // round for ever — which is what 6 had already become in practice.
    expect(CHECKS_MEM_FLOOR_MAX_GB).toBe(16);
    expect(CHECKS_MEM_FLOOR_DEFAULT_GB).toBeGreaterThan(CHECKS_MEM_FLOOR_MIN_GB);
    expect(CHECKS_MEM_FLOOR_DEFAULT_GB).toBeLessThan(CHECKS_MEM_FLOOR_MAX_GB);
  });
});
