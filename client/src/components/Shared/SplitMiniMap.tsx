import { memo } from 'react';

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
  // Defensive: a malformed/legacy descriptor (no rows) renders nothing rather
  // than throwing on `.map` and taking down the whole tree.
  if (!rows?.length) return null;
  const [activeRow, activeCol] = active;
  return (
    <div
      className={className}
      style={{ display: 'flex', flexDirection: 'column', gap: GAP, width: W, height: H }}
      aria-hidden
      title="Posizione nel layout"
    >
      {rows.map((cols, rowIdx) => (
        <div
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
                  background: isActive
                    ? 'var(--primary)'
                    : 'color-mix(in srgb, currentColor 22%, transparent)',
                  boxShadow: isActive
                    ? '0 0 0 0.5px color-mix(in srgb, var(--primary) 60%, transparent)'
                    : undefined,
                }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
});
