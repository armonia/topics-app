/**
 * @covers KANBAN-15
 */
import { describe, expect, test } from "bun:test";
import { GATE_SLOWDOWN_PREFIX, MAX_SLOWDOWN_FACTOR, clampSlowdown, gateSlowdownLine, parseGateSlowdown } from "./gate-slowdown";

describe("the slowdown line: printed by the unit runner, read by the board's check runner", () => {
  test("what the runner prints is what the board parses", () => {
    const line = gateSlowdownLine(2, "2 shard invece di 4 sotto carico");
    expect(line.startsWith(GATE_SLOWDOWN_PREFIX)).toBe(true);
    expect(parseGateSlowdown(`test-unit-shards: carico 46.0 su 12 core\n${line}\nfase1 shard 0 …`)).toBe(2);
  });

  test("no line, no extension: null and not 1, so the caller keeps its own cap", () => {
    expect(parseGateSlowdown("[slot] acquired test:unit: 0 s in the queue, the command starts now")).toBeNull();
    expect(parseGateSlowdown("")).toBeNull();
  });

  test("a declaration cannot shorten the cap, nor lift it forever", () => {
    expect(clampSlowdown(0.5)).toBe(1);
    expect(clampSlowdown(-3)).toBe(1);
    expect(clampSlowdown(Number.NaN)).toBe(1);
    expect(clampSlowdown(99)).toBe(MAX_SLOWDOWN_FACTOR);
    expect(parseGateSlowdown(gateSlowdownLine(99, "carico assurdo"))).toBe(MAX_SLOWDOWN_FACTOR);
  });

  test("one decimal survives the round trip", () => {
    expect(parseGateSlowdown(gateSlowdownLine(1.5, "meta' dei worker"))).toBe(1.5);
  });
});
