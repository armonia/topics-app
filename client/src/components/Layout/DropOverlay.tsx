import type React from 'react';
import type { EdgeZone } from '../../lib/dropZone';
import { dropRegionStyle, caretStyle, fullRowZoneStyle, rowGapZoneStyle } from '../../lib/dropFeedback';

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
}: {
  zone: EdgeZone;
  fullWidth?: boolean;
  gutterInset?: number;
}) {
  return <div data-grid-split-overlay={zone} style={dropRegionStyle(zone, { fullWidth, gutterInset })} />;
}

/** A 1-D insert caret at a tab's left/right edge — reorder / add-as-tab. */
export function InsertCaret({ side }: { side: 'left' | 'right' }) {
  return <div data-drop-caret={side} style={caretStyle(side)} />;
}

/**
 * The full-width-row drop gutter (project layout). Carries its own drag
 * handlers (it is a real hit target, unlike the pointer-events:none regions),
 * so it is NOT pointerEvents:none.
 */
export function FullWidthRowZone({
  side,
  active,
  label = 'Riga a tutta larghezza',
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  side: 'top' | 'bottom';
  active: boolean;
  label?: string;
  onDragOver?: React.DragEventHandler;
  onDragLeave?: React.DragEventHandler;
  onDrop?: React.DragEventHandler;
}) {
  return (
    <div
      data-full-row-zone={side}
      className="flex items-center justify-center gap-1.5"
      style={fullRowZoneStyle(side, active)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span className="text-[11px] font-semibold text-primary pointer-events-none select-none uppercase tracking-wide leading-none">
        {side === 'top' ? '↑' : '↓'} {label}
      </span>
    </div>
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
  label = 'Riga a tutta larghezza',
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  /** The boundary's cumulative height, in % of the container. */
  topPct: number;
  active: boolean;
  label?: string;
  onDragOver?: React.DragEventHandler;
  onDragLeave?: React.DragEventHandler;
  onDrop?: React.DragEventHandler;
}) {
  return (
    <div
      data-row-gap-zone
      className="flex items-center justify-center gap-1.5"
      style={rowGapZoneStyle(topPct, active)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span className="text-[11px] font-semibold text-primary pointer-events-none select-none uppercase tracking-wide leading-none">
        {'↕'} {label}
      </span>
    </div>
  );
}
