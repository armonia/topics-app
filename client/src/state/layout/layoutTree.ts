/**
 * layoutTree — the pure layout engine for the split system (P2 rewrite).
 *
 * Today the app runs TWO divergent layout engines: the standalone `PanelGrid`
 * (layout derived from `openPanels` + `soloCells` via a racy reconciliation) and
 * the project `GroupLayout`/`useProjectLayout` (authoritative `GroupLayoutRow[]`).
 * Both encode the SAME shape — a vertical stack of rows, each row a horizontal
 * band of columns sized by `widths`, each column optionally a vertical sub-stack
 * — but with duplicated, subtly-different resize / equalize / split / close math.
 *
 * This module replaces both with ONE canonical model: an n-ary *weighted* split
 * tree. A node is either a `leaf` (one pane, identified by an opaque id) or a
 * `split` that lays its `children` out along an axis (`row` = side-by-side,
 * `col` = stacked), each child carrying a relative `weight`. Weights are the
 * exact same quantity the renderer already consumes (`flex: <weight> 1 0%`),
 * normalised to sum 1 per split — so the geometry is identical to today's, but
 * expressible at ARBITRARY depth (no MAX_COLS / MAX_ROWS / single-level-substack
 * caps) and with every operation a pure tree walk.
 *
 * Why n-ary (children[]) and not the binary {a,b} the roadmap sketched: a row of
 * N columns IS one split node with N weighted children — a 1:1 image of the
 * current `{ groupIds, widths }` row. Binary nesting would re-encode that as a
 * right-leaning chain of 2-splits with awkward compound ratios, making resize /
 * equalize (which operate on a whole band) needlessly recursive. N-ary keeps the
 * weight math line-for-line equivalent to gridWidths.ts.
 *
 * Everything here is PURE and side-effect-free: each operation returns a NEW tree
 * (structural sharing where possible) and never mutates its input. Adapters from
 * the legacy `PanelGridRow[]` / `GroupLayoutRow[]` shapes live alongside (built
 * next, behind a flag, with golden geometry tests); the React renderer
 * (`<SplitTree>`) and gesture controller consume the model but hold none of it.
 */

export type LeafId = string;

/** Split axis. `row` = children side-by-side (columns, weight≈width fraction);
 *  `col` = children stacked top-to-bottom (rows, weight≈height fraction). */
export type SplitDir = 'row' | 'col';

export interface LeafNode {
  readonly kind: 'leaf';
  readonly id: LeafId;
}

export interface SplitChild {
  /** Relative weight along the parent's axis. Normalised to sum 1 per split. */
  readonly weight: number;
  readonly node: LayoutNode;
}

export interface SplitNode {
  readonly kind: 'split';
  readonly dir: SplitDir;
  readonly children: readonly SplitChild[];
}

export type LayoutNode = LeafNode | SplitNode;

/** Which edge of a target leaf a moved/created pane lands on. */
export type DropEdge = 'left' | 'right' | 'top' | 'bottom';

/** Minimum weight a divider drag may shrink a child to (relative fraction).
 *  Equalize/normalize deliberately ignore this — a heavily-split neighbour can
 *  legitimately push a sibling below it (mirrors gridWidths.ts).
 *
 *  NB — WIRING RECONCILIATION: the live PanelGrid floors divider drags at
 *  MIN_PANE_FRACTION = 0.1 (components/Layout/constants.ts) while this engine
 *  floors at 0.05. When splitTreeEngine is flipped on, pick ONE canonical floor
 *  (almost certainly 0.1, the value users already feel) and update the
 *  golden-geometry tests accordingly — otherwise the engine lets panes shrink to
 *  half the size the legacy path allows. Kept at 0.05 for now so the 84 existing
 *  tests stay green while the engine is unwired. */
export const MIN_CHILD_WEIGHT = 0.05;

const EPSILON = 1e-9;

// ─────────────────────────── constructors / guards ───────────────────────────

export function leaf(id: LeafId): LeafNode {
  return { kind: 'leaf', id };
}

export function isLeaf(node: LayoutNode): node is LeafNode {
  return node.kind === 'leaf';
}

export function isSplit(node: LayoutNode): node is SplitNode {
  return node.kind === 'split';
}

/** Build a split from children + (optional) weights. Weights default to equal;
 *  any supplied set is normalised. Always passes through `normalize` so the
 *  result is canonical (same-dir children flattened, single child collapsed). */
export function split(
  dir: SplitDir,
  nodes: readonly LayoutNode[],
  weights?: readonly number[],
): LayoutNode {
  const n = nodes.length;
  if (n === 0) throw new Error('split() needs at least one child');
  const w = normalizeWeights(weights && weights.length === n ? weights : nodes.map(() => 1));
  const children = nodes.map((node, i) => ({ weight: w[i], node }));
  return normalize({ kind: 'split', dir, children });
}

// ─────────────────────────────── weight math ───────────────────────────────
// (kept identical in spirit to gridWidths.ts so geometry matches the old engines)

/** Renormalise weights to sum 1, preserving relative proportions. All-zero /
 *  non-finite → equal split. */
export function normalizeWeights(weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const clean = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const total = clean.reduce((s, x) => s + x, 0);
  return total > EPSILON ? clean.map((x) => x / total) : weights.map(() => 1 / weights.length);
}

function equalWeights(count: number): number[] {
  return count <= 0 ? [] : new Array(count).fill(1 / count);
}

// ───────────────────────────────── queries ─────────────────────────────────

/** All leaf ids in left-to-right / top-to-bottom (document) order. */
export function leafIds(node: LayoutNode): LeafId[] {
  if (isLeaf(node)) return [node.id];
  const out: LeafId[] = [];
  for (const c of node.children) out.push(...leafIds(c.node));
  return out;
}

export function leafCount(node: LayoutNode): number {
  return isLeaf(node) ? 1 : node.children.reduce((s, c) => s + leafCount(c.node), 0);
}

export function hasLeaf(node: LayoutNode, id: LeafId): boolean {
  if (isLeaf(node)) return node.id === id;
  return node.children.some((c) => hasLeaf(c.node, id));
}

/** Path of child indices from the root to the leaf with `id`, or null if absent.
 *  `[]` means the root itself is that leaf. */
export function pathToLeaf(node: LayoutNode, id: LeafId): number[] | null {
  if (isLeaf(node)) return node.id === id ? [] : null;
  for (let i = 0; i < node.children.length; i++) {
    const sub = pathToLeaf(node.children[i].node, id);
    if (sub) return [i, ...sub];
  }
  return null;
}

// ──────────────────────────────── normalize ────────────────────────────────

/**
 * Canonicalise a tree:
 *   - normalize children recursively, dropping any that collapse to nothing;
 *   - FLATTEN a child split that shares the parent's axis into the parent,
 *     scaling the grandchildren by the child's weight (so a row inside a row
 *     becomes one row — this is what makes `splitLeaf` preserve sibling widths);
 *   - collapse a split with a single child to that child (weight absorbed);
 *   - renormalise the surviving children's weights to sum 1.
 * Leaves pass through unchanged.
 */
export function normalize(node: LayoutNode): LayoutNode {
  if (isLeaf(node)) return node;

  const flattened: SplitChild[] = [];
  for (const child of node.children) {
    const norm = normalize(child.node);
    if (isSplit(norm) && norm.dir === node.dir) {
      // Same-axis nested split → splice its children in, scaled by this child's
      // weight, so relative proportions across the whole band are preserved.
      for (const gc of norm.children) {
        flattened.push({ weight: child.weight * gc.weight, node: gc.node });
      }
    } else {
      flattened.push({ weight: child.weight, node: norm });
    }
  }

  // Unreachable via the public API (constructors guarantee ≥1 child, removal
  // goes through rewriteLeaf which returns null instead of an empty split).
  if (flattened.length === 0) throw new Error('normalize: split with no children');
  if (flattened.length === 1) return flattened[0].node;

  const w = normalizeWeights(flattened.map((c) => c.weight));
  return { kind: 'split', dir: node.dir, children: flattened.map((c, i) => ({ weight: w[i], node: c.node })) };
}

// ──────────────────────────── structural editing ────────────────────────────

/** Replace the leaf `targetId` with `replacement` (or, if `replacement` is null,
 *  REMOVE it), returning the rewritten node — or null if the whole node vanished.
 *  Splits left with one child collapse; weights of survivors renormalise. */
function rewriteLeaf(
  node: LayoutNode,
  targetId: LeafId,
  replacement: LayoutNode | null,
): LayoutNode | null {
  if (isLeaf(node)) {
    if (node.id !== targetId) return node;
    return replacement; // may be null (removal) or a new subtree (split-in-place)
  }
  const kids: SplitChild[] = [];
  for (const c of node.children) {
    const next = rewriteLeaf(c.node, targetId, replacement);
    if (next) kids.push({ weight: c.weight, node: next });
  }
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0].node; // collapse single survivor (weight absorbed)
  return { kind: 'split', dir: node.dir, children: kids };
}

/**
 * Split the leaf `targetId` along `dir`, inserting `newId` on `edge`'s side with
 * `ratio` of the slot (default 0.5). Works for a fresh pane OR an existing id
 * being relocated. The new 2-child split is `normalize`d into its parent when
 * the axes match, so an insert into a row keeps every OTHER column's width
 * exactly (the donor column simply halves) — identical to gridWidths
 * `splitColumnWidths`.
 */
export function splitLeaf(
  tree: LayoutNode,
  targetId: LeafId,
  edge: DropEdge,
  newId: LeafId,
  ratio = 0.5,
): LayoutNode {
  const dir: SplitDir = edge === 'left' || edge === 'right' ? 'row' : 'col';
  const before = edge === 'left' || edge === 'top';
  const r = Math.min(Math.max(ratio, EPSILON), 1 - EPSILON);
  const target = leaf(targetId);
  const inserted = leaf(newId);
  const pair: SplitNode = before
    ? { kind: 'split', dir, children: [{ weight: r, node: inserted }, { weight: 1 - r, node: target }] }
    : { kind: 'split', dir, children: [{ weight: 1 - r, node: target }, { weight: r, node: inserted }] };
  const next = rewriteLeaf(tree, targetId, pair);
  if (!next) return tree; // target not found → unchanged
  return normalize(next);
}

/** Remove the leaf `id`. Returns the rewritten tree, or null if it was the last
 *  leaf (caller decides what an empty layout means). Survivors keep their
 *  relative proportions (gridWidths `keepColumnWidths`). */
export function closeLeaf(tree: LayoutNode, id: LeafId): LayoutNode | null {
  if (isLeaf(tree)) return tree.id === id ? null : tree;
  const next = rewriteLeaf(tree, id, null);
  return next ? normalize(next) : null;
}

/**
 * Move the leaf `sourceId` to land on `edge` of `targetId` (drag-tab-to-edge
 * drop-split). Removing then re-inserting the SAME id is fine — leaves are
 * opaque ids; the pane's content lives elsewhere keyed by id. No-op if source ==
 * target, or either is missing.
 */
export function moveLeaf(
  tree: LayoutNode,
  sourceId: LeafId,
  targetId: LeafId,
  edge: DropEdge,
  ratio = 0.5,
): LayoutNode {
  if (sourceId === targetId) return tree;
  if (!hasLeaf(tree, sourceId) || !hasLeaf(tree, targetId)) return tree;
  const without = closeLeaf(tree, sourceId);
  if (!without) return tree;
  // The target may have been collapsed away by the removal only if source was
  // its sole sibling chain — but target is a distinct leaf, so it survives.
  if (!hasLeaf(without, targetId)) return tree;
  return splitLeaf(without, targetId, edge, sourceId, ratio);
}

// ───────────────────────────────── resize ─────────────────────────────────

/**
 * Drag the divider between children `idx` and `idx+1` of the split at `path`,
 * shifting `delta` (a fraction of the whole band, signed) from the right child
 * to the left. Clamped so neither falls below `MIN_CHILD_WEIGHT`. Other children
 * are untouched. Returns a new tree (or the same if the path is invalid).
 */
export function resizeAt(
  tree: LayoutNode,
  path: readonly number[],
  idx: number,
  delta: number,
): LayoutNode {
  const target = nodeAt(tree, path);
  if (!target || !isSplit(target)) return tree;
  if (idx < 0 || idx + 1 >= target.children.length) return tree;
  const a = target.children[idx].weight;
  const b = target.children[idx + 1].weight;
  const sum = a + b;
  let na = a + delta;
  na = Math.min(Math.max(na, MIN_CHILD_WEIGHT), sum - MIN_CHILD_WEIGHT);
  const nb = sum - na;
  const children = target.children.map((c, i) =>
    i === idx ? { ...c, weight: na } : i === idx + 1 ? { ...c, weight: nb } : c,
  );
  const replaced: SplitNode = { kind: 'split', dir: target.dir, children };
  return replaceNodeAt(tree, path, replaced);
}

/** Set `weight` directly on the child at `path`/`idx` (used by keyboard resize),
 *  rebalancing the band to keep sum 1. */
export function setWeightAt(
  tree: LayoutNode,
  path: readonly number[],
  idx: number,
  weight: number,
): LayoutNode {
  const target = nodeAt(tree, path);
  if (!target || !isSplit(target)) return tree;
  if (idx < 0 || idx >= target.children.length) return tree;
  const raw = target.children.map((c, i) => (i === idx ? Math.max(weight, MIN_CHILD_WEIGHT) : c.weight));
  const w = normalizeWeights(raw);
  const children = target.children.map((c, i) => ({ ...c, weight: w[i] }));
  return replaceNodeAt(tree, path, { kind: 'split', dir: target.dir, children });
}

// ──────────────────────────────── equalize ────────────────────────────────

/** Even out the direct children of the split at `path` (1/n each). `[]` targets
 *  the root. Double-click-a-divider semantics. */
export function equalizeAt(tree: LayoutNode, path: readonly number[]): LayoutNode {
  const target = nodeAt(tree, path);
  if (!target || !isSplit(target)) return tree;
  const w = equalWeights(target.children.length);
  const children = target.children.map((c, i) => ({ ...c, weight: w[i] }));
  return replaceNodeAt(tree, path, { kind: 'split', dir: target.dir, children });
}

/** Even out EVERY split in the tree (depth-first). The "equalize all" command —
 *  the current two engines can't express this in one shot. */
export function equalizeAll(node: LayoutNode): LayoutNode {
  if (isLeaf(node)) return node;
  const w = equalWeights(node.children.length);
  return {
    kind: 'split',
    dir: node.dir,
    children: node.children.map((c, i) => ({ weight: w[i], node: equalizeAll(c.node) })),
  };
}

// ─────────────────────────── node addressing helpers ───────────────────────────

/** The node at a child-index `path` from the root, or null if the path is invalid. */
export function nodeAt(node: LayoutNode, path: readonly number[]): LayoutNode | null {
  let cur: LayoutNode = node;
  for (const i of path) {
    if (isLeaf(cur) || i < 0 || i >= cur.children.length) return null;
    cur = cur.children[i].node;
  }
  return cur;
}

/** Replace the node at `path` with `replacement`, returning a new tree. Weights
 *  along the path are preserved. Invalid path → unchanged. */
export function replaceNodeAt(
  node: LayoutNode,
  path: readonly number[],
  replacement: LayoutNode,
): LayoutNode {
  if (path.length === 0) return replacement;
  if (isLeaf(node)) return node;
  const [head, ...rest] = path;
  if (head < 0 || head >= node.children.length) return node;
  const children = node.children.map((c, i) =>
    i === head ? { ...c, node: replaceNodeAt(c.node, rest, replacement) } : c,
  );
  return { kind: 'split', dir: node.dir, children };
}

// ──────────────────────────────── geometry ────────────────────────────────

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LeafRect extends Rect {
  id: LeafId;
}

/**
 * Lay the tree out inside `rect`, returning one absolute rect per leaf. `gutter`
 * (px) is subtracted BETWEEN siblings so dividers — and, for native browser
 * panes, the webview-free strips the divider lives in — get real space. This is
 * the single geometry source the renderer, the divider hit-boxes, and the
 * per-region vibrancy all read, so they can never disagree.
 */
export function computeRects(node: LayoutNode, rect: Rect, gutter = 0): LeafRect[] {
  if (isLeaf(node)) return [{ id: node.id, ...rect }];
  const out: LeafRect[] = [];
  const horizontal = node.dir === 'row';
  const total = horizontal ? rect.width : rect.height;
  const gaps = gutter * (node.children.length - 1);
  const usable = Math.max(0, total - gaps);
  const weights = normalizeWeights(node.children.map((c) => c.weight));
  let offset = horizontal ? rect.x : rect.y;
  for (let i = 0; i < node.children.length; i++) {
    const size = usable * weights[i];
    const childRect: Rect = horizontal
      ? { x: offset, y: rect.y, width: size, height: rect.height }
      : { x: rect.x, y: offset, width: rect.width, height: size };
    out.push(...computeRects(node.children[i].node, childRect, gutter));
    offset += size + gutter;
  }
  return out;
}

/** Structural deep-equality (ignoring tiny weight drift) — handy for tests and
 *  for skipping no-op state updates. */
export function treesEqual(a: LayoutNode, b: LayoutNode): boolean {
  if (isLeaf(a) || isLeaf(b)) return isLeaf(a) && isLeaf(b) && a.id === b.id;
  if (a.dir !== b.dir || a.children.length !== b.children.length) return false;
  return a.children.every(
    (c, i) => Math.abs(c.weight - b.children[i].weight) < 1e-6 && treesEqual(c.node, b.children[i].node),
  );
}
