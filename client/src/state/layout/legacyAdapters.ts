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
 * STATUS: the forward DEEP adapters (`gridRowsToTree` / `groupRowsToTree`, which
 * encode sub-stacks as col-splits) + their reverse counterparts are the
 * persistence / round-trip bridge and the golden-geometry test ORACLE — they are
 * the reference for "the canonical weights produce the legacy geometry". The two
 * desktop renderers do NOT consume the deep adapters: they drive a SHALLOW tree
 * (sub-stacks render inside a column's `<CellSubStack>`, not as tree leaves) built
 * by `buildShallowGridTree` below — extracted from the two identical inline
 * builders so the golden gate can assert over the exact code that ships.
 */
import { type LayoutNode, type SplitChild, type SplitNode, leaf } from './layoutTree';

/** One row, normalised to its column keys + width weights (sub-stacks excluded —
 *  the shallow renderer tree doesn't encode them). */
export interface ShallowRow {
  readonly keys: readonly string[];
  readonly widths: readonly number[];
}

/**
 * The SHALLOW split tree both desktop renderers (`PanelGrid`, `GroupLayout`)
 * actually drive: a col-split of rows, each a row-split of column leaves. A
 * missing or duplicate key (per `isLive`) becomes an inert `__skip:*` weight-0
 * leaf — keeping the tree index 1:1 with the row model so a divider's (path, idx)
 * maps straight back to (rowIdx, colIdx), and a transient stale key reserves no
 * space (self-heals on the next prune). Sub-stacks are deliberately NOT encoded
 * (they live inside each column's `<CellSubStack>`). Returns null for an empty
 * layout. Byte-identical to the inline builders it replaced — golden-geometry
 * tested against the deep-adapter oracle for sub-stack-free layouts.
 */
export function buildShallowGridTree(
  rows: readonly ShallowRow[],
  rowHeights: readonly number[],
  isLive: (key: string) => boolean,
): LayoutNode | null {
  const seen = new Set<string>();
  const rowChildren: SplitChild[] = rows.map((row, ri): SplitChild => {
    const cols: SplitChild[] =
      row.keys.length === 0
        ? [{ weight: 1, node: leaf(`__skip:${ri}:empty`) }]
        : row.keys.map((key, ci): SplitChild => {
            const live = isLive(key) && !seen.has(key);
            if (live) seen.add(key);
            return {
              weight: live ? (row.widths[ci] ?? 1 / row.keys.length) : 0,
              node: leaf(live ? key : `__skip:${ri}:${ci}`),
            };
          });
    const rowNode: SplitNode = { kind: 'split', dir: 'row', children: cols };
    return { weight: rowHeights[ri] ?? 1 / rows.length, node: rowNode };
  });
  if (rowChildren.length === 0) return null;
  return { kind: 'split', dir: 'col', children: rowChildren };
}
