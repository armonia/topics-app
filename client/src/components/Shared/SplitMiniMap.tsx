import { memo } from 'react';
import { useT } from '../../hooks/useT';

/**
 * A tiny schematic of the current split layout — one strip per layout row, one
 * cell per group/pane in that row, sized to the REAL split proportions (column
 * widths and row heights). The cell that hosts the "reference" pane (the tab or
 * sidebar row this map belongs to) is lit; the rest stay quiet. It gives the
 * user spatial orientation in a multi-pane split: "this tab lives in the wide
 * top-right cell".
 *
 * Render only when there's an actual split (more than one cell total) — a
 * single-cell layout has nothing to orient against, so callers pass `undefined`.
 */
export interface SplitMapDescriptor {
  /** Per-row column width fractions, top → bottom. `rows[r][c]` is cell c's
   *  share of row r's width. Length of each inner array = cells in that row. */
  rows: number[][];
  /** Per-row height fractions (top → bottom). Optional — equal heights when
   *  omitted. Length should match `rows`. */
  rowHeights?: number[];
  /** Coordinate of the cell to highlight: [rowIdx, colIdx]. */
  active: [number, number];
}

const W = 16; // px — overall map width
const H = 12; // px — overall map height
const GAP = 1.5; // px between cells

export const SplitMiniMap = memo(function SplitMiniMap({
  rows,
  rowHeights,
  active,
  className,
}: SplitMapDescriptor & { className?: string }) {
  const t = useT();
  // Defensive: a malformed/legacy descriptor (no rows) renders nothing rather
  // than throwing on `.map` and taking down the whole tree.
  if (!rows?.length) return null;
  const [activeRow, activeCol] = active;
  return (
    // SPANS, NOT DIVS, and it is not a detail of taste: the map now rides on
    // the pinned tile too, and a tile is a `<button>` - whose content model is
    // phrasing content, which a `<div>` is not. The boxes are laid out by
    // inline `display: flex` either way, so the drawing is identical and the
    // element is legal everywhere a row wants to put it.
    <span
      className={className}
      style={{ display: 'flex', flexDirection: 'column', gap: GAP, width: W, height: H }}
      aria-hidden
      // A HANDLE FOR THE MEASUREMENT, because the map has no accessible name to
      // find it by: it is `aria-hidden` on purpose (it repeats, as a drawing,
      // what the row already says in words).
      data-testid="split-mini-map"
      title={t('minimap.position')}
    >
      {rows.map((cols, rowIdx) => (
        <span
          key={rowIdx}
          style={{ display: 'flex', gap: GAP, flex: `${rowHeights?.[rowIdx] ?? 1} 1 0%`, minHeight: 0 }}
        >
          {cols.map((widthFraction, colIdx) => {
            const isActive = rowIdx === activeRow && colIdx === activeCol;
            return (
              <span
                key={colIdx}
                style={{
                  flex: `${widthFraction} 1 0%`,
                  minWidth: 0,
                  borderRadius: 1.5,
                  // The cell that marks "you are here": a neutral high-contrast
                  // wash of the surrounding text colour (user preference: NOT the
                  // primary blue). Derived from `currentColor` so it inverts with
                  // the theme — near-white on the dark sidebar, near-black on the
                  // light one. A hardcoded white read fine in dark mode but went
                  // invisible on the default LIGHT sidebar (white-on-#f8f9fa); the
                  // mini-map now renders on sidebar rows only, so that was every
                  // live instance. The active cell carries an internal gradient
                  // ("sfumatura dentro") — the same lit-tile grammar the
                  // OrbitLoader uses — so the two glyphs share one look; unlit
                  // cells stay the fainter 22% wash OrbitLoader reuses for its
                  // frame, so the grid reads in both themes.
                  background: isActive
                    ? 'linear-gradient(150deg, color-mix(in srgb, currentColor 95%, transparent) 0%, color-mix(in srgb, currentColor 72%, transparent) 100%)'
                    : 'color-mix(in srgb, currentColor 22%, transparent)',
                  boxShadow: isActive
                    ? '0 0 0 0.5px color-mix(in srgb, currentColor 40%, transparent)'
                    : undefined,
                }}
              />
            );
          })}
        </span>
      ))}
    </span>
  );
});
