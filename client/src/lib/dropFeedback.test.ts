/**
 * Tests for the drop-feedback tokens. The invariants that protect the UX law:
 *   - a split REGION is a pure translucent fill — NO border, NO seam line (a
 *     border/line reads as a SECOND preview alongside the fill);
 *   - the region's footprint math matches the resulting pane (half per edge);
 *   - `fullWidth` spans the whole container (the "full-width row" tell);
 *   - `gutterInset` lifts a region's bottom so it clears the full-row gutter;
 *   - a caret is a thin solid bar, never a filled region.
 *
 * @covers LAYOUT-01
 */
import { describe, test, expect } from "bun:test";
import {
  dropRegionStyle,
  fullRowZoneStyle,
  rowGapZoneStyle,
  edgeStripGutters,
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

describe("dropRegionStyle — the UX law (fill + one inner-edge seam, never a perimeter)", () => {
  test("a translucent fill plus a single inset seam — never a dashed/solid perimeter", () => {
    for (const z of ["left", "right", "top", "bottom"] as const) {
      const s = dropRegionStyle(z);
      expect(s.border).toBeUndefined();                    // never a 4-side perimeter border
      expect(String(s.background)).toContain("color-mix"); // translucent fill
      expect(s.pointerEvents).toBe("none");                // never eats the drop
      // The seam (intentional, per dropRegionStyle's contract) is the single
      // "where the split lands" indicator: ONE inset box-shadow on the inner
      // edge — not a full perimeter (which would read as a bordered box).
      const seam = String(s.boxShadow);
      expect(seam).toContain("inset");
      expect(seam).toContain("var(--primary)");
      expect(seam.split(",").length).toBe(1); // a single edge, not 2+ sides
    }
  });

  test("the seam sits on the edge that becomes the divider (opposite the region's side)", () => {
    expect(dropRegionStyle("right").boxShadow).toBe(`inset ${DROP_SEAM_PX}px 0 0 0 var(--primary)`);
    expect(dropRegionStyle("left").boxShadow).toBe(`inset -${DROP_SEAM_PX}px 0 0 0 var(--primary)`);
    expect(dropRegionStyle("bottom").boxShadow).toBe(`inset 0 ${DROP_SEAM_PX}px 0 0 var(--primary)`);
    expect(dropRegionStyle("top").boxShadow).toBe(`inset 0 -${DROP_SEAM_PX}px 0 0 var(--primary)`);
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

describe("fullRowZoneStyle — full-width gutter", () => {
  test("spans the full width at a fixed gutter height", () => {
    const s = fullRowZoneStyle("bottom", false);
    expect(s.left).toBe(0);
    expect(s.right).toBe(0);
    expect(s.height).toBe(FULL_ROW_GUTTER_PX);
    expect(s.bottom).toBe(0);
  });

  test("idle is a hairline hint, active is the filled band (drop UX v2)", () => {
    const idle = fullRowZoneStyle("bottom", false);
    const active = fullRowZoneStyle("bottom", true);
    // Idle: no fill (transparent) — only a reduced-strength hairline pinned to
    // the container's own edge. The old always-on fill + uppercase label
    // cluttered every drag before the user expressed any intent.
    expect(idle.background).toBe("transparent");
    expect(String(idle.boxShadow)).toContain("color-mix");
    // Active: the region fill language + a full-strength seam on the inner edge.
    expect(String(active.background)).toContain("color-mix");
    expect(String(active.boxShadow)).toBe(`inset 0 ${DROP_SEAM_PX}px 0 0 var(--primary)`);
  });
});

describe("rowGapZoneStyle — the band lives ABOVE the boundary", () => {
  test("its bottom edge IS the row boundary, so it never reaches the next row's tab bar", () => {
    // Centred on the boundary, half the 26px band fell on the tab bar of the
    // row BELOW: aiming at that bar to move a tab there gave you a new row.
    const s = rowGapZoneStyle(40, false);
    expect(s.top).toBe(`calc(40% - ${FULL_ROW_GUTTER_PX}px)`);
    expect(s.height).toBe(FULL_ROW_GUTTER_PX);
  });

  test("idle is a hairline on the boundary, active is the filled band", () => {
    const idle = rowGapZoneStyle(40, false);
    const active = rowGapZoneStyle(40, true);
    expect(idle.background).toBe("transparent");
    // The hairline hugs the band's BOTTOM edge — the boundary itself.
    expect(String(idle.boxShadow)).toBe(
      `inset 0 -${DROP_SEAM_PX}px 0 0 color-mix(in srgb, var(--primary) 45%, transparent)`,
    );
    expect(String(active.background)).toContain("color-mix");
  });
});

describe("edgeStripGutters — pixels a strip already owns", () => {
  const base = { atContainerTop: false, atContainerBottom: false, gapBandBelow: false, extremeStrips: true };

  test("the project's content rect starts below the tab bar: 26px at the top", () => {
    expect(edgeStripGutters({ ...base, atContainerTop: true }).top).toBe(FULL_ROW_GUTTER_PX);
  });

  test("the standalone cell rect includes its tab bar: 40 + 26 = 66px", () => {
    expect(edgeStripGutters({ ...base, atContainerTop: true, topStripOffset: 40 }).top).toBe(66);
  });

  test("a row-gap band owns the bottom even when the extreme strips are absent", () => {
    expect(edgeStripGutters({ ...base, extremeStrips: false, gapBandBelow: true }).bottom).toBe(FULL_ROW_GUTTER_PX);
    expect(edgeStripGutters({ ...base, extremeStrips: false, atContainerBottom: true }).bottom).toBe(0);
  });

  test("a middle slot touches nothing", () => {
    expect(edgeStripGutters(base)).toEqual({ top: 0, bottom: 0 });
  });
});
