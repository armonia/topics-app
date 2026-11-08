import type { CSSProperties } from 'react';
import type { EdgeGutters, EdgeZone } from './dropZone';

/**
 * Drop-feedback visual tokens — the ONE source of truth for every pane/tab
 * drag-and-drop indicator, shared by PanelGrid, GroupLayout and PaneTabBar.
 *
 * The law (VS Code / Chrome / JetBrains): a drag shows EXACTLY ONE indicator,
 * and the SHAPE encodes the meaning, never mixed:
 *
 *   - CARET  = una lama sottile e piena, senza campitura → «entra qui, in questa
 *              posizione della fila» (1-D: riordino / aggiungi come tab). NON
 *              sta più qui: è l'attributo `data-drop-active="before|after"` del
 *              contratto condiviso (`lib/dragPreview`), disegnato da una regola
 *              sola in `index.css`, perché la stessa lama serve a superfici che
 *              con la griglia non c'entrano niente — l'albero dei file, le
 *              tessere fissate, le righe della sidebar.
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
export const DROP_RADIUS = 4;
/** Thickness of the solid seam accent / caret. */
export const DROP_SEAM_PX = 2;
/** Height of the full-width-row drop gutter (top/bottom strips). */
export const FULL_ROW_GUTTER_PX = 26;

// z-index, centralized so the two tiling subsystems agree on which indicator
// wins when regions briefly overlap: region < full-row < external drop.
// The full-row gutter sits ABOVE the per-column regions so it stays visible at
// the bottom/top corners (where a column's left/right region would otherwise
// cover it) — that occlusion was part of why it wasn't discoverable.
// La lama d'inserimento non ha più un piano suo: sta nel contratto condiviso
// (`data-drop-active`), che la disegna con uno pseudo-elemento DENTRO al
// bersaglio, quindi non entra mai in gara con queste regioni.
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
  opts: { fullWidth?: boolean; gutterInset?: number; topInset?: number } = {},
): CSSProperties {
  const { fullWidth = false, gutterInset = 0, topInset = 0 } = opts;
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
    // `topInset` lifts the top edge DOWN so a `top`/`left`/`right` region stops
    // BELOW the full-width-row strip at the container's first-row edge (the twin
    // of `gutterInset` at the bottom) — the fill then ends exactly where the
    // full-row strip's hit band begins, so the user can SEE that the top ~26px
    // belongs to the full-width-row gesture, not this column split.
    top: zone === 'bottom' ? '50%' : topInset,
    bottom: zone === 'top' ? '50%' : gutterInset,
    left: fullWidth ? 0 : zone === 'right' ? '50%' : 0,
    right: fullWidth ? 0 : zone === 'left' ? '50%' : 0,
    background: DROP_REGION_FILL,
    boxShadow: seam,
    borderRadius: DROP_RADIUS,
    transition: 'all 140ms ease',
  };
}

/**
 * The center-merge preview: an inset, rounded FILL covering the pane's
 * interior — "this drop goes INTO the pane" (adds as a tab), as opposed to a
 * half-footprint (which claims a side). Pure fill, no seam: there is no
 * divider to preview for a merge. Before this primitive existed, hovering the
 * center of a pane body gave ZERO feedback — a merge drop looked like a dead
 * zone.
 */
export function centerRegionStyle(): CSSProperties {
  return {
    position: 'absolute',
    pointerEvents: 'none',
    zIndex: Z_DROP_REGION,
    inset: '10%',
    background: DROP_REGION_FILL,
    borderRadius: 10,
    transition: 'all 140ms ease',
  };
}

/**
 * The full-width-row drop gutter: a full-container-width band pinned to the
 * container's top/bottom. IDLE (drag live, cursor elsewhere) it shows only a
 * hairline accent hugging the container edge — a hint, not furniture; ACTIVE
 * (cursor over it) the whole band fills with the region language ("occupy this
 * area") spanning the full width — the width is what makes it unmistakable
 * from a single-column split. The old idle state painted the full 26px band
 * plus an uppercase text label on every drag, which cluttered the workspace
 * before the user had expressed any intent.
 */
export function fullRowZoneStyle(side: 'top' | 'bottom', active: boolean, edgeOffset = 0): CSSProperties {
  return {
    position: 'absolute',
    left: 0,
    right: 0,
    // `edgeOffset` pushes the strip IN from the container edge — the project
    // layout offsets the TOP strip by the first row's tab-bar height so the
    // strip sits over the first row's CONTENT, never over its tab bar (a
    // pointer-events:auto strip on top of the tab bar swallowed tab clicks and
    // stole tab-move drops aimed at the bar — the "can't click the tab / can't
    // drag a tab onto the first bar" report). 0 keeps the legacy flush-to-edge.
    [side]: edgeOffset,
    height: FULL_ROW_GUTTER_PX,
    zIndex: Z_DROP_FULLROW,
    background: active ? DROP_REGION_FILL : 'transparent',
    // Active: solid accent on the inner edge (facing the content). Idle: a
    // hairline pinned to the container's own edge, at reduced strength.
    boxShadow: active
      ? (side === 'bottom'
          ? `inset 0 ${DROP_SEAM_PX}px 0 0 ${DROP_ACCENT}`
          : `inset 0 -${DROP_SEAM_PX}px 0 0 ${DROP_ACCENT}`)
      : (side === 'bottom'
          ? `inset 0 -${DROP_SEAM_PX}px 0 0 color-mix(in srgb, ${DROP_ACCENT} 45%, transparent)`
          : `inset 0 ${DROP_SEAM_PX}px 0 0 color-mix(in srgb, ${DROP_ACCENT} 45%, transparent)`),
    transition: 'background 140ms ease, box-shadow 140ms ease',
  };
}

/**
 * An INTERIOR row-gap drop band, sitting entirely ABOVE the boundary between
 * two rows (`topPct` = the boundary's cumulative height, in % of the
 * container), with its bottom edge ON that boundary. Same visual language as
 * the top/bottom `fullRowZoneStyle` strips — it IS the same intent (insert a
 * full-width row), just BETWEEN two existing rows instead of at the
 * container's extremes. Drag-only, like the extreme strips.
 *
 * It used to be CENTERED on the boundary, which put half its 26px on the tab
 * bar of the row BELOW: the band has `pointer-events: auto` and outranks the
 * cells (`Z_DROP_FULLROW`), so aiming at that bar to move a tab into it landed
 * a whole new row instead. `edgeOffset = TAB_BAR_H` fixed the same collision
 * for the container's extreme strips; the interior bands were left on it.
 * Living wholly in the row above keeps every tab bar reachable.
 *
 * Idle = a hairline on the boundary (the band's bottom edge); active = the
 * filled band.
 */
export function rowGapZoneStyle(topPct: number, active: boolean): CSSProperties {
  return {
    position: 'absolute',
    left: 0,
    right: 0,
    top: `calc(${topPct}% - ${FULL_ROW_GUTTER_PX}px)`,
    height: FULL_ROW_GUTTER_PX,
    zIndex: Z_DROP_FULLROW,
    background: active ? DROP_REGION_FILL : 'transparent',
    // Active: seam on BOTH edges — the band still previews an insertion between
    // two rows, so both edges face content. Idle: a reduced-strength hairline on
    // the bottom edge alone, which is the boundary the release aims at.
    boxShadow: active
      ? `inset 0 ${DROP_SEAM_PX}px 0 0 ${DROP_ACCENT}, inset 0 -${DROP_SEAM_PX}px 0 0 ${DROP_ACCENT}`
      : `inset 0 -${DROP_SEAM_PX}px 0 0 color-mix(in srgb, ${DROP_ACCENT} 45%, transparent)`,
    transition: 'background 140ms ease, box-shadow 140ms ease',
  };
}

/**
 * How many pixels at the top / bottom of a cell rect are already owned by a
 * full-width drop strip, so `detectDropZone` can move its floor off them.
 *
 * The strips have `pointer-events: auto` at `Z_DROP_FULLROW`, above every
 * cell region, so a pixel they cover is not a reachable edge target: on a short
 * cell the "stack above this column" band shrank to a few pixels, and on a
 * standalone 320x180 first-row cell to none at all. The interior row-gap band
 * counts the same way, since it sits wholly in the bottom of the row above.
 *
 * `topStripOffset` is how far IN from the container's top edge the top strip
 * starts, in the RECT's own coordinates: the standalone cell rect includes its
 * tab bar (so the strip lands `TAB_BAR_H` down inside it), while the project's
 * content rect starts below that bar (so the strip lands at 0).
 */
export function edgeStripGutters(o: {
  /** The rect's top edge IS the container's top edge. */
  atContainerTop: boolean;
  /** The rect's bottom edge IS the container's bottom edge. */
  atContainerBottom: boolean;
  /** A row-gap band rests on the rect's bottom edge (another row follows). */
  gapBandBelow: boolean;
  /** Whether the extreme strips are mounted at all (they need >1 column). */
  extremeStrips: boolean;
  topStripOffset?: number;
}): EdgeGutters {
  return {
    top: o.atContainerTop && o.extremeStrips ? (o.topStripOffset ?? 0) + FULL_ROW_GUTTER_PX : 0,
    bottom: (o.atContainerBottom && o.extremeStrips) || o.gapBandBelow ? FULL_ROW_GUTTER_PX : 0,
  };
}
