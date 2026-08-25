/**
 * @covers PANE-13
 */
import { describe, test, expect } from "bun:test";
import { clampScrollOffset } from "./scrollOffset";

describe("clampScrollOffset (PANE-03 scroll restore)", () => {
  test("returns 0 when offset is undefined", () => {
    expect(clampScrollOffset(undefined, 1000, 400)).toBe(0);
  });

  test("returns 0 for negative offsets", () => {
    expect(clampScrollOffset(-50, 1000, 400)).toBe(0);
  });

  test("returns the offset unchanged when within scrollable range", () => {
    // scrollable range: max = scrollHeight - clientHeight = 600
    expect(clampScrollOffset(250, 1000, 400)).toBe(250);
  });

  test("caps to max (scrollHeight - clientHeight) when offset is too large", () => {
    // device A closed at 1000px, device B has shorter content: max = 200
    expect(clampScrollOffset(1000, 500, 300)).toBe(200);
  });

  test("returns 0 when content is shorter than the viewport (no scroll possible)", () => {
    // max = 400 - 600 = -200 → clamped to 0
    expect(clampScrollOffset(300, 400, 600)).toBe(0);
  });

  test("rejects non-finite offsets", () => {
    // NaN and Infinity both fail Number.isFinite, so both return 0 — the
    // helper is defensive: non-finite inputs can't be clamped meaningfully.
    expect(clampScrollOffset(NaN, 1000, 400)).toBe(0);
    expect(clampScrollOffset(Infinity, 1000, 400)).toBe(0);
  });
});
