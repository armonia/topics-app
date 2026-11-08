import type React from 'react';
import type { EdgeZone } from '../../lib/dropZone';
import { dropRegionStyle, centerRegionStyle, fullRowZoneStyle, rowGapZoneStyle } from '../../lib/dropFeedback';

/**
 * The shared drop-feedback primitives. Stateless by design: the parent's
 * drag state drives mount/unmount, so the existing window `dragend`/`drop`
 * reset paths fully control visibility (no internal state to leak past a
 * gesture). See lib/dropFeedback.ts for the shape↔meaning law.
 */

/**
 * A split-region preview: the translucent footprint of the resulting pane.
 * `fullWidth` spans the whole container (the full-width-row preview);
 * `gutterInset` lifts its bottom so it clears the full-width-row gutter.
 *
 * Keeps `data-grid-split-overlay={zone}` — the attribute E2E tests locate.
 */
export function SplitRegion({
  zone,
  fullWidth,
  gutterInset,
  topInset,
}: {
  zone: EdgeZone;
  fullWidth?: boolean;
  gutterInset?: number;
  topInset?: number;
}) {
  return <div data-grid-split-overlay={zone} style={dropRegionStyle(zone, { fullWidth, gutterInset, topInset })} />;
}

/**
 * The center-merge preview: inset rounded fill covering the pane interior —
 * "this drop goes INTO the pane" (adds as a tab). Painted when a drag hovers
 * the cell's center zone; before this, a merge hover over the pane body gave
 * no feedback at all and read as a dead zone.
 */
export function CenterRegion() {
  return <div data-grid-split-overlay="center" style={centerRegionStyle()} />;
}

/**
 * The full-width-row drop gutter (project layout). Carries its own drag
 * handlers (it is a real hit target, unlike the pointer-events:none regions),
 * so it is NOT pointerEvents:none.
 */
export function FullWidthRowZone({
  side,
  active,
  edgeOffset,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  side: 'top' | 'bottom';
  active: boolean;
  /** Push the strip IN from the container edge (px). The project layout offsets
   *  the TOP strip by the first row's tab-bar height so it never overlaps — and
   *  never swallows clicks/drops on — that bar. */
  edgeOffset?: number;
  onDragOver?: React.DragEventHandler;
  onDragLeave?: React.DragEventHandler;
  onDrop?: React.DragEventHandler;
}) {
  // No text label: the SHAPE carries the meaning (a full-container-width band
  // = full-width row). Idle shows only a hairline at the container edge; the
  // old always-on fill + uppercase caption cluttered every drag gesture.
  return (
    <div
      data-full-row-zone={side}
      style={fullRowZoneStyle(side, active, edgeOffset)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    />
  );
}

/**
 * An INTERIOR row-gap drop band, centered on the boundary between two rows —
 * the only gesture that inserts a full-width row BETWEEN existing rows (the
 * FullWidthRowZone strips cover the container's extremes; per-cell top/bottom
 * edges split a single column). Drag-only, like the extreme strips.
 */
export function RowGapDropZone({
  topPct,
  active,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  /** The boundary's cumulative height, in % of the container. */
  topPct: number;
  active: boolean;
  onDragOver?: React.DragEventHandler;
  onDragLeave?: React.DragEventHandler;
  onDrop?: React.DragEventHandler;
}) {
  // Label-free like FullWidthRowZone: idle = hairline on the row boundary,
  // active = the filled full-width band.
  return (
    <div
      data-row-gap-zone
      style={rowGapZoneStyle(topPct, active)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    />
  );
}
