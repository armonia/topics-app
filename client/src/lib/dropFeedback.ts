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
/** Fill of a split-region preview (the translucent footprint of the new pane). */
export const DROP_REGION_FILL = 'color-mix(in srgb, var(--primary) 15%, transparent)';
/** Resting fill of the full-width-row gutter while a drag is live but not over it. */
export const DROP_GUTTER_FILL_IDLE = 'color-mix(in srgb, var(--primary) 7%, transparent)';
export const DROP_RADIUS = 4;
/** Thickness of the solid seam accent / caret. */
export const DROP_SEAM_PX = 2;
/** Height of the full-width-row drop gutter (top/bottom strips). */
export const FULL_ROW_GUTTER_PX = 26;

// z-index, centralized so the two tiling subsystems agree on which indicator
// wins when regions briefly overlap: caret < region = full-row < external drop.
export const Z_DROP_CARET = 20;
export const Z_DROP_REGION = 40;
export const Z_DROP_FULLROW = 40;

/**
 * boxShadow `inset` accent on the SEAM edge — the inner boundary where the new
 * pane will meet the existing content — for each split direction.
 */
function seamShadow(zone: EdgeZone): string {
  switch (zone) {
    case 'left':   return `inset -${DROP_SEAM_PX}px 0 0 0 ${DROP_ACCENT}`; // region left → seam on its right
    case 'right':  return `inset ${DROP_SEAM_PX}px 0 0 0 ${DROP_ACCENT}`;  // region right → seam on its left
    case 'top':    return `inset 0 -${DROP_SEAM_PX}px 0 0 ${DROP_ACCENT}`; // region top → seam on its bottom
    case 'bottom': return `inset 0 ${DROP_SEAM_PX}px 0 0 ${DROP_ACCENT}`;  // region bottom → seam on its top
  }
}

/**
 * Inline style for a split-region preview: the translucent half-footprint of
 * the resulting pane plus a solid seam accent. No dashed perimeter.
 *
 * - `fullWidth` spans the whole container width (the full-width-row preview)
 *   instead of a single column — this is the visual tell vs a column split.
 * - `gutterInset` lifts the bottom edge up by N px so a `bottom`/`left`/`right`
 *   region stops above the full-width-row gutter and the two never collide.
 *
 * With no opts this reproduces the legacy half-area math exactly.
 */
export function dropRegionStyle(
  zone: EdgeZone,
  opts: { fullWidth?: boolean; gutterInset?: number } = {},
): CSSProperties {
  const { fullWidth = false, gutterInset = 0 } = opts;
  return {
    position: 'absolute',
    pointerEvents: 'none',
    zIndex: Z_DROP_REGION,
    top: zone === 'bottom' ? '50%' : 0,
    bottom: zone === 'top' ? '50%' : gutterInset,
    left: fullWidth ? 0 : zone === 'right' ? '50%' : 0,
    right: fullWidth ? 0 : zone === 'left' ? '50%' : 0,
    background: DROP_REGION_FILL,
    boxShadow: seamShadow(zone),
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
    // Solid seam accent on the inner edge (the one facing the content).
    boxShadow: side === 'bottom'
      ? `inset 0 ${DROP_SEAM_PX}px 0 0 ${DROP_ACCENT}`
      : `inset 0 -${DROP_SEAM_PX}px 0 0 ${DROP_ACCENT}`,
    opacity: active ? 1 : 0.7,
    transition: 'background 140ms ease, opacity 140ms ease',
  };
}
