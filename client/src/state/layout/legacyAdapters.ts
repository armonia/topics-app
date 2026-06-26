/**
 * legacyAdapters — map the two legacy layout shapes onto the canonical
 * `layoutTree` model (P2 migration bridge).
 *
 * Both engines encode the same thing: a vertical stack of rows (sized by
 * `rowHeights`), each row a horizontal band of columns (sized by `widths`), each
 * column optionally a vertical sub-stack (`cellStacks`, heights INCLUDING the
 * primary at index 0). These adapters turn that into one `LayoutNode` tree so the
 * new `<SplitTree>` renderer can drive BOTH surfaces from a single model, and a
 * persisted layout migrates with byte-identical geometry (the column/row/substack
 * weights are passed straight through — `split()` normalises each band exactly
 * like gridWidths does).
 *
 *   - `gridRowsToTree`  ← standalone PanelGrid (`PanelGridRow[]` + `gridRowHeights`)
 *   - `groupRowsToTree` ← project GroupLayout (`GroupLayoutRow[]` + `rowHeights`)
 *
 * Pure + additive: nothing imports these yet. They run at hydrate behind the P2
 * flag, with the renderer still defaulting to the current engines until verified.
 */
import type { PanelGridRow, GroupLayoutRow } from '../../types';
import { type LayoutNode, leaf, split } from './layoutTree';

/** A column normalised to its leaf key + (optional) vertical sub-stack. */
interface NormColumn {
  /** The column's primary pane/group key (heads the cell). */
  key: string;
  /** Extra panes/groups stacked UNDER the primary (top-to-bottom). */
  stackItems: string[];
  /** Heights for `[primary, ...stackItems]` (length = stackItems.length + 1), or
   *  null when the column is a single pane. */
  stackHeights: number[] | null;
}

interface NormRow {
  cols: NormColumn[];
  /** Column width weights (per `widths`), normalised by `split()`. */
  widths: number[];
}

/** Shared builder: rows → `split('col', rows, rowHeights)`; each row →
 *  `split('row', cols, widths)`; each stacked column →
 *  `split('col', [primary, ...members], heights)`. `split()` collapses any
 *  single-child band (one row / one column / no sub-stack) to its child, so a
 *  plain single-pane layout reduces to a bare leaf. */
function buildTree(rows: NormRow[], rowHeights: number[]): LayoutNode {
  const liveRows = rows.filter((r) => r.cols.length > 0);
  if (liveRows.length === 0) {
    throw new Error('buildTree: layout has no panes');
  }
  const rowNodes = liveRows.map((row) => {
    const colNodes = row.cols.map((c): LayoutNode => {
      if (c.stackItems.length > 0) {
        const nodes = [leaf(c.key), ...c.stackItems.map(leaf)];
        // heights include the primary at [0]; ignore a length-mismatched array
        // (corrupt persisted state) → equal split, never strand a pane at 0.
        const heights =
          c.stackHeights && c.stackHeights.length === nodes.length ? c.stackHeights : undefined;
        return split('col', nodes, heights);
      }
      return leaf(c.key);
    });
    return split('row', colNodes, row.widths);
  });
  // rowHeights may not match after filtering empty rows — buildTree keeps it
  // simple: pass what we have, `split()` falls back to equal when lengths differ.
  const heights = rowHeights.length === rowNodes.length ? rowHeights : undefined;
  return split('col', rowNodes, heights);
}

/** Standalone PanelGrid (`PanelGridRow[]` + device-local `gridRowHeights`) → tree. */
export function gridRowsToTree(
  rows: readonly PanelGridRow[],
  rowHeights: readonly number[],
): LayoutNode {
  const norm: NormRow[] = rows.map((r) => ({
    widths: [...r.widths],
    cols: r.itemKeys.map((key): NormColumn => {
      const stack = r.cellStacks?.[key];
      return {
        key,
        stackItems: stack ? [...stack.items] : [],
        stackHeights: stack ? [...stack.heights] : null,
      };
    }),
  }));
  return buildTree(norm, [...rowHeights]);
}

/** Project GroupLayout (`GroupLayoutRow[]` + `rowHeights`) → tree. */
export function groupRowsToTree(
  rows: readonly GroupLayoutRow[],
  rowHeights: readonly number[],
): LayoutNode {
  const norm: NormRow[] = rows.map((r) => ({
    widths: [...r.widths],
    cols: r.groupIds.map((key): NormColumn => {
      const stack = r.cellStacks?.[key];
      return {
        key,
        stackItems: stack ? [...stack.groupIds] : [],
        stackHeights: stack ? [...stack.heights] : null,
      };
    }),
  }));
  return buildTree(norm, [...rowHeights]);
}
