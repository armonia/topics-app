/**
 * Tests for the drop-feedback tokens. The invariants that protect the UX law:
 *   - a split REGION is a pure translucent fill — NO border, NO seam line (a
 *     border/line reads as a SECOND preview alongside the fill);
 *   - the region's footprint math matches the resulting pane (half per edge);
 *   - `fullWidth` spans the whole container (the "full-width row" tell);
 *   - `gutterInset` lifts a region's bottom so it clears the full-row gutter;
 *   - a caret is a thin solid bar, never a filled region.
 */
import { describe, test, expect } from "bun:test";
import {
  dropRegionStyle,
  caretStyle,
  fullRowZoneStyle,
  FULL_ROW_GUTTER_PX,
  DROP_SEAM_PX,
} from "./dropFeedback";

describe("dropRegionStyle — footprint math", () => {
  test("left region fills the left half", () => {
    const s = dropRegionStyle("left");
    expect(s.left).toBe(0);
    expect(s.right).toBe("50%");
    expect(s.top).toBe(0);
    expect(s.bottom).toBe(0);
  });

  test("right region fills the right half", () => {
    const s = dropRegionStyle("right");
    expect(s.left).toBe("50%");
    expect(s.right).toBe(0);
  });

  test("top region fills the top half", () => {
    const s = dropRegionStyle("top");
    expect(s.top).toBe(0);
    expect(s.bottom).toBe("50%");
  });

  test("bottom region fills the bottom half", () => {
    const s = dropRegionStyle("bottom");
    expect(s.top).toBe("50%");
    expect(s.bottom).toBe(0);
  });
});

describe("dropRegionStyle — the UX law (fill is the ONLY indicator)", () => {
  test("a translucent fill, with NO border and NO seam line", () => {
    for (const z of ["left", "right", "top", "bottom"] as const) {
      const s = dropRegionStyle(z);
      expect(s.border).toBeUndefined();      // no dashed/solid perimeter
      expect(s.boxShadow).toBeUndefined();   // no seam line (would read as a 2nd preview)
      expect(String(s.background)).toContain("color-mix"); // translucent fill
      expect(s.pointerEvents).toBe("none");  // never eats the drop
    }
  });
});

describe("dropRegionStyle — fullWidth + gutterInset", () => {
  test("fullWidth spans the whole container width", () => {
    const s = dropRegionStyle("bottom", { fullWidth: true });
    expect(s.left).toBe(0);
    expect(s.right).toBe(0);
    expect(s.top).toBe("50%"); // still the bottom half vertically
  });

  test("gutterInset lifts the bottom edge for bottom/left/right (not top)", () => {
    expect(dropRegionStyle("bottom", { gutterInset: 26 }).bottom).toBe(26);
    expect(dropRegionStyle("left", { gutterInset: 26 }).bottom).toBe(26);
    expect(dropRegionStyle("top", { gutterInset: 26 }).bottom).toBe("50%");
  });
});

describe("caretStyle — 1-D insert marker", () => {
  test("is a thin solid bar with no fill region", () => {
    const s = caretStyle("left");
    expect(s.left).toBe(0);
    expect(s.width).toBe(DROP_SEAM_PX);
    expect(String(s.background)).toContain("var(--primary)");
    expect(s.background).not.toContain?.("color-mix"); // solid, not a translucent fill
  });

  test("right caret pins to the right edge", () => {
    expect(caretStyle("right").right).toBe(0);
  });
});

describe("fullRowZoneStyle — full-width gutter", () => {
  test("spans the full width at a fixed gutter height", () => {
    const s = fullRowZoneStyle("bottom", false);
    expect(s.left).toBe(0);
    expect(s.right).toBe(0);
    expect(s.height).toBe(FULL_ROW_GUTTER_PX);
    expect(s.bottom).toBe(0);
  });

  test("active state is more opaque than idle", () => {
    const idle = fullRowZoneStyle("bottom", false);
    const active = fullRowZoneStyle("bottom", true);
    expect(Number(active.opacity)).toBeGreaterThan(Number(idle.opacity));
  });
});
