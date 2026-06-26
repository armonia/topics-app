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
import type { PanelGridRow, GroupLayoutRow, PanelGridCellStack, GroupCellStack } from '../../types';
import { type LayoutNode, leaf, split, isLeaf, isSplit, leafIds } from './layoutTree';

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

// ─────────────────────────── tree → legacy (reverse) ───────────────────────────
//
// Decompose a (normalised) tree back into the legacy row/column/sub-stack shape.
// Lossless for any tree the FORWARD adapters produce (the legacy 3-level model);
// a deeper tree — which the new engine can create but the legacy model can't hold
// — is flattened defensively (a nested band collapses to its first leaf), so a
// reverse adapter never throws. Used to keep legacy persistence in sync while the
// new engine runs behind a flag, and (via the round-trip test) to PROVE the
// forward adapters preserve every width/height/key.

const firstKey = (n: LayoutNode): string => (isLeaf(n) ? n.id : leafIds(n)[0]);

function treeToNormRows(tree: LayoutNode): { rows: NormRow[]; rowHeights: number[] } {
  // Top col-split → its children are rows; anything else → a single row.
  const rowEntries =
    isSplit(tree) && tree.dir === 'col'
      ? tree.children.map((c) => ({ node: c.node, weight: c.weight }))
      : [{ node: tree, weight: 1 }];

  const rows: NormRow[] = [];
  const rowHeights: number[] = [];
  for (const re of rowEntries) {
    rowHeights.push(re.weight);
    // A row is a row-split (columns) or a single cell.
    const colEntries =
      isSplit(re.node) && re.node.dir === 'row'
        ? re.node.children.map((c) => ({ node: c.node, weight: c.weight }))
        : [{ node: re.node, weight: 1 }];

    const cols: NormColumn[] = colEntries.map((ce): NormColumn => {
      // A column with a col-split is a vertical sub-stack [primary, ...members].
      if (isSplit(ce.node) && ce.node.dir === 'col') {
        const members = ce.node.children;
        return {
          key: firstKey(members[0].node),
          stackItems: members.slice(1).map((m) => firstKey(m.node)),
          stackHeights: members.map((m) => m.weight),
        };
      }
      return { key: firstKey(ce.node), stackItems: [], stackHeights: null };
    });
    rows.push({ cols, widths: colEntries.map((c) => c.weight) });
  }
  return { rows, rowHeights };
}

/** Tree → standalone PanelGrid shape (`PanelGridRow[]` + `rowHeights`). */
export function treeToGridRows(tree: LayoutNode): { rows: PanelGridRow[]; rowHeights: number[] } {
  const { rows, rowHeights } = treeToNormRows(tree);
  return {
    rowHeights,
    rows: rows.map((r): PanelGridRow => {
      const cellStacks: Record<string, PanelGridCellStack> = {};
      for (const c of r.cols) {
        if (c.stackItems.length > 0 && c.stackHeights) {
          cellStacks[c.key] = { items: c.stackItems, heights: c.stackHeights };
        }
      }
      return {
        itemKeys: r.cols.map((c) => c.key),
        widths: r.widths,
        ...(Object.keys(cellStacks).length > 0 ? { cellStacks } : {}),
      };
    }),
  };
}

/** Tree → project GroupLayout shape (`GroupLayoutRow[]` + `rowHeights`). */
export function treeToGroupRows(tree: LayoutNode): { rows: GroupLayoutRow[]; rowHeights: number[] } {
  const { rows, rowHeights } = treeToNormRows(tree);
  return {
    rowHeights,
    rows: rows.map((r): GroupLayoutRow => {
      const cellStacks: Record<string, GroupCellStack> = {};
      for (const c of r.cols) {
        if (c.stackItems.length > 0 && c.stackHeights) {
          cellStacks[c.key] = { groupIds: c.stackItems, heights: c.stackHeights };
        }
      }
      return {
        groupIds: r.cols.map((c) => c.key),
        widths: r.widths,
        ...(Object.keys(cellStacks).length > 0 ? { cellStacks } : {}),
      };
    }),
  };
}
