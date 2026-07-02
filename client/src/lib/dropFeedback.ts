import type { CSSProperties } from 'react';
import type { EdgeZone } from './dropZone';

/**
 * Drop-feedback visual tokens — the ONE source of truth for every pane/tab
 * drag-and-drop indicator, shared by PanelGrid, GroupLayout and PaneTabBar.
 *
 * The law (VS Code / Chrome / JetBrains): a drag shows EXACTLY ONE indicator,
 * and the SHAPE encodes the meaning, never mixed:
 *
 *   - CARET  = a thin SOLID bar, NO fill        → "insert at an ordinal slot in
 *                                                  a bar" (1-D: reorder / add tab).
 *   - REGION = a translucent FILL (the footprint of the resulting pane) plus a
 *              single SOLID seam accent on the inner edge, with NO dashed
 *              perimeter                          → "occupy this area" (2-D split).
 *
 * The old overlays used `fill + 2px DASHED border`, which read as BOTH a border
 * line AND a filled area at once — the double-indicator the user reported. The
 * fill alone (with a seam accent) is the whole preview; the dashed perimeter is
 * gone. "Below one column" vs "full-width row" is disambiguated purely by WIDTH:
 * a column-scoped region vs a `fullWidth` region spanning the whole container.
 */

export const DROP_ACCENT = 'var(--primary)';
/** Fill of a split-region preview (the translucent footprint of the new pane).
 *  The fill is the body of the indicator; a single SOLID seam accent on the
 *  pane's INNER edge (the divider line, facing the content it splits from) marks
 *  exactly where the split lands — this is the documented law (fill + one inner
 *  seam, never a dashed perimeter), and the seam is what makes a half-split read
 *  cleanly on busy terminal/editor content instead of a vague tinted rectangle. */
export const DROP_REGION_FILL = 'color-mix(in srgb, var(--primary) 22%, transparent)';
/** Resting fill of the full-width-row gutter while a drag is live but not over
 *  it. Kept clearly visible (not a faint hint) so the "drop here for a
 *  full-width row" affordance is DISCOVERABLE the moment a drag starts — the
 *  old 7%/0.7 band was effectively invisible until the cursor was already on it. */
export const DROP_GUTTER_FILL_IDLE = 'color-mix(in srgb, var(--primary) 14%, transparent)';
export const DROP_RADIUS = 4;
/** Thickness of the solid seam accent / caret. */
export const DROP_SEAM_PX = 2;
/** Height of the full-width-row drop gutter (top/bottom strips). */
export const FULL_ROW_GUTTER_PX = 26;

// z-index, centralized so the two tiling subsystems agree on which indicator
// wins when regions briefly overlap: caret < region < full-row < external drop.
// The full-row gutter sits ABOVE the per-column regions so it stays visible at
// the bottom/top corners (where a column's left/right region would otherwise
// cover it) — that occlusion was part of why it wasn't discoverable.
export const Z_DROP_CARET = 20;
export const Z_DROP_REGION = 40;
export const Z_DROP_FULLROW = 50;

/**
 * Inline style for a split-region preview: the translucent half-footprint of
 * the resulting pane, plus a single SOLID seam accent on its INNER edge — the
 * edge that becomes the divider, facing the content being split from. The seam
 * (one inset box-shadow, never a full/dashed perimeter) tells the user precisely
 * where the split lands and keeps the half readable on busy content.
 *
 * - `fullWidth` spans the whole container width (the full-width-row preview)
 *   instead of a single column — this is the visual tell vs a column split.
 * - `gutterInset` lifts the bottom edge up by N px so a `bottom`/`left`/`right`
 *   region stops above the full-width-row gutter and the two never collide.
 */
export function dropRegionStyle(
  zone: EdgeZone,
  opts: { fullWidth?: boolean; gutterInset?: number } = {},
): CSSProperties {
  const { fullWidth = false, gutterInset = 0 } = opts;
  // Inner-edge seam: the region occupies the half on `zone`'s side, so its inner
  // edge is the OPPOSITE side (a right-split's pane sits on the right → its seam
  // is on its left). One inset shadow on that edge = the divider line.
  const seam =
    zone === 'right' ? `inset ${DROP_SEAM_PX}px 0 0 0 ${DROP_ACCENT}`
    : zone === 'left' ? `inset -${DROP_SEAM_PX}px 0 0 0 ${DROP_ACCENT}`
    : zone === 'bottom' ? `inset 0 ${DROP_SEAM_PX}px 0 0 ${DROP_ACCENT}`
    : `inset 0 -${DROP_SEAM_PX}px 0 0 ${DROP_ACCENT}`; // top
  return {
    position: 'absolute',
    pointerEvents: 'none',
    zIndex: Z_DROP_REGION,
    top: zone === 'bottom' ? '50%' : 0,
    bottom: zone === 'top' ? '50%' : gutterInset,
    left: fullWidth ? 0 : zone === 'right' ? '50%' : 0,
    right: fullWidth ? 0 : zone === 'left' ? '50%' : 0,
    background: DROP_REGION_FILL,
    boxShadow: seam,
    borderRadius: DROP_RADIUS,
    transition: 'all 140ms ease',
  };
}

/** The 1-D insert caret drawn at a tab's left/right edge. Solid bar, no fill. */
export function caretStyle(side: 'left' | 'right'): CSSProperties {
  return {
    position: 'absolute',
    [side]: 0,
    top: 4,
    bottom: 4,
    width: DROP_SEAM_PX,
    background: DROP_ACCENT,
    borderRadius: 2,
    zIndex: Z_DROP_CARET,
  };
}

/**
 * The full-width-row drop gutter: a full-container-width band pinned to the
 * container's top/bottom. Same fill language as a split region (so it reads as
 * "occupy this area"), but spanning the whole width — that width is what makes
 * it unmistakable from a single-column bottom split.
 */
export function fullRowZoneStyle(side: 'top' | 'bottom', active: boolean): CSSProperties {
  return {
    position: 'absolute',
    left: 0,
    right: 0,
    [side]: 0,
    height: FULL_ROW_GUTTER_PX,
    zIndex: Z_DROP_FULLROW,
    background: active ? DROP_REGION_FILL : DROP_GUTTER_FILL_IDLE,
    // Solid accent on the inner edge (facing the content) — this is a thin
    // full-width band with a label, so the accent reads as the band's edge, not
    // a competing split line.
    boxShadow: side === 'bottom'
      ? `inset 0 ${DROP_SEAM_PX}px 0 0 ${DROP_ACCENT}`
      : `inset 0 -${DROP_SEAM_PX}px 0 0 ${DROP_ACCENT}`,
    opacity: active ? 1 : 0.92,
    transition: 'background 140ms ease, opacity 140ms ease',
  };
}

/**
 * An INTERIOR row-gap drop band, centered on the boundary between two rows
 * (`topPct` = the boundary's cumulative height, in % of the container).
 * Same visual language as the top/bottom `fullRowZoneStyle` strips — it IS
 * the same intent (insert a full-width row), just BETWEEN two existing rows
 * instead of at the container's extremes. Drag-only, like the extreme strips.
 */
export function rowGapZoneStyle(topPct: number, active: boolean): CSSProperties {
  return {
    position: 'absolute',
    left: 0,
    right: 0,
    top: `calc(${topPct}% - ${FULL_ROW_GUTTER_PX / 2}px)`,
    height: FULL_ROW_GUTTER_PX,
    zIndex: Z_DROP_FULLROW,
    background: active ? DROP_REGION_FILL : DROP_GUTTER_FILL_IDLE,
    // Seam on BOTH edges — the band sits between two rows, so both edges face
    // content; a single seam would read as belonging to one row only.
    boxShadow: `inset 0 ${DROP_SEAM_PX}px 0 0 ${DROP_ACCENT}, inset 0 -${DROP_SEAM_PX}px 0 0 ${DROP_ACCENT}`,
    opacity: active ? 1 : 0.92,
    transition: 'background 140ms ease, opacity 140ms ease',
  };
}
