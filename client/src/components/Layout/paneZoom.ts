/**
 * paneZoom — the pure half of "zoom a conversation": WHICH cells survive, and
 * what the split tree looks like once the others are gone.
 *
 * The whole mechanism is weights, not shape (design D1): the tree a surface
 * already built is handed back with the weight of every cell outside the zoom
 * set forced to 0. `SplitTree` sizes each child with `flex: <weight> 1 0%`, so a
 * single non-zero sibling takes the whole band, and `gapHasDivider` drops the
 * divider next to a zero-weight child on its own. Node ids are preserved
 * untouched, which is the reason nothing remounts: `keyFor` keys leaves on
 * `leaf:<id>` and splits on their sibling INDEX, both invariant to weight.
 *
 * Everything here is pure: no store import, no React, no DOM. The surfaces
 * (PanelGrid, GroupLayout) inject their own rows and item map, so one behaviour
 * serves both instead of two copies drifting apart.
 *
 * `cellKeysForPanes` is EXTRACTED from the pane→cell walk that `mobileVisibleKey`
 * had inline in PanelGrid (including the climb from a stacked pane up to the cell
 * that draws it). The returned set keeps ROW ORDER, so that caller can keep
 * taking the first match and read identically to what it did before.
 */
import { type LayoutNode, isLeaf } from '../../state/layout/layoutTree';

/** One grid cell as the surfaces model it: a key plus the panes it hosts.
 *  Structural on purpose — PanelGrid's `GridItem` and a project group both
 *  satisfy it without either side importing the other's type. */
export interface ZoomGridItem {
  readonly key: string;
  readonly panelIds: readonly string[];
}

/** Cell key → the cell. `Map<string, GridItem>` satisfies it as-is. */
export type ZoomItemMap = ReadonlyMap<string, ZoomGridItem>;

/** One row of cells, plus the vertical sub-stacks hanging off a cell. Shaped on
 *  `PanelGridRow` so that surface passes its rows straight through; a surface
 *  that names its columns differently (project rows carry `groupIds`) maps once
 *  at the call site rather than making this module know about both. */
export interface ZoomRow {
  readonly itemKeys: readonly string[];
  readonly cellStacks?: Readonly<Record<string, { readonly items: readonly string[] }>>;
}

/**
 * The cell keys the surface actually renders, in row order, deduplicated.
 *
 * It mirrors `buildShallowGridTree`'s own liveness test (`isLive(key) &&
 * !seen.has(key)`, legacyAdapters.ts): a key the item map doesn't know, or a key
 * repeated in a later row, becomes an inert weight-0 `__skip:` leaf there and is
 * therefore NOT a cell anyone can see.
 *
 * It lives here, exported, because two things have to agree on the count and
 * agreeing by coincidence is how they drift: the availability predicate ("more
 * than one live cell on this surface") and `resolveEntryScope`, which returns
 * null on exactly the same layout. One definition, one metric.
 */
export function liveCellKeys(rows: readonly ZoomRow[], itemMap: ZoomItemMap): ReadonlySet<string> {
  const live = new Set<string>();
  for (const row of rows) {
    for (const key of row.itemKeys) {
      if (itemMap.has(key)) live.add(key);
    }
  }
  return live;
}

/**
 * The keys of the cells that HOST any of `paneIds`.
 *
 * A pane can sit in a cell's own tab list, or inside that cell's vertical
 * sub-stack: in the second case the answer is the HOST cell's key, because the
 * stack is drawn inside it and there is no separate cell to reveal. Iteration
 * follows rows then columns, and `Set` keeps insertion order, so the first
 * element is the first cell in document order that hosts a pane.
 */
export function cellKeysForPanes(
  rows: readonly ZoomRow[],
  itemMap: ZoomItemMap,
  paneIds: readonly string[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  if (paneIds.length === 0) return keys;
  const wanted = new Set(paneIds);
  const hosts = (key: string): boolean => {
    const item = itemMap.get(key);
    return !!item && item.panelIds.some((id) => wanted.has(id));
  };
  for (const row of rows) {
    for (const key of row.itemKeys) {
      if (hosts(key)) { keys.add(key); continue; }
      for (const stacked of row.cellStacks?.[key]?.items ?? []) {
        if (hosts(stacked)) { keys.add(key); break; }
      }
    }
  }
  return keys;
}

/**
 * The same tree with every cell outside `cellKeys` at weight 0.
 *
 * A split child is kept at its own weight when its subtree holds at least one
 * of the keys, so an entire ROW collapses on its own when none of its columns
 * is in the set — no second rule for rows. Nodes are reused by reference
 * wherever nothing changed, and the root comes back IDENTICAL when the set is
 * empty or already covers every cell: a memo on top of this never invalidates
 * for a no-op.
 *
 * A set that matches NO leaf returns the tree untouched rather than a surface
 * with every weight at 0. That is not defensive padding: the set is pruned in an
 * effect, one render behind, so a cell key that dies between two renders really
 * does reach this function, and the difference is a normal grid versus a blank
 * window for that frame.
 */
export function applyZoomWeights(root: LayoutNode | null, cellKeys: ReadonlySet<string>): LayoutNode | null {
  if (!root || cellKeys.size === 0) return root;
  if (!holdsAnyKey(root, cellKeys)) return root;
  return zoomNode(root, cellKeys);
}

function holdsAnyKey(node: LayoutNode, cellKeys: ReadonlySet<string>): boolean {
  if (isLeaf(node)) return cellKeys.has(node.id);
  return node.children.some((child) => holdsAnyKey(child.node, cellKeys));
}

function zoomNode(node: LayoutNode, cellKeys: ReadonlySet<string>): LayoutNode {
  if (isLeaf(node)) return node;
  let changed = false;
  const children = node.children.map((child) => {
    const keep = holdsAnyKey(child.node, cellKeys);
    const weight = keep ? child.weight : 0;
    const inner = keep ? zoomNode(child.node, cellKeys) : child.node;
    if (weight === child.weight && inner === child.node) return child;
    changed = true;
    return { weight, node: inner };
  });
  return changed ? { ...node, children } : node;
}

/**
 * Drop the cell keys that no longer exist. Returns the SAME ref when nothing
 * was dropped, the convention `pruneSoloCells` follows, so a caller can compare
 * by identity and skip a redundant state write.
 */
export function pruneZoom(
  keys: ReadonlySet<string>,
  liveKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  let changed = false;
  const kept = new Set<string>();
  for (const key of keys) {
    if (liveKeys.has(key)) kept.add(key);
    else changed = true;
  }
  return changed ? kept : keys;
}
