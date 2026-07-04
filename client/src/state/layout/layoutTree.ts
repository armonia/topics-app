/**
 * layoutTree — the pure layout model for the split system (P2 rewrite).
 *
 * Today the app runs TWO divergent layout engines: the standalone `PanelGrid`
 * (layout derived from `openPanels` + `soloCells` via a racy reconciliation) and
 * the project `GroupLayout`/`useProjectLayout` (authoritative `GroupLayoutRow[]`).
 * Both encode the SAME shape — a vertical stack of rows, each row a horizontal
 * band of columns sized by `widths`, each column optionally a vertical sub-stack.
 *
 * The model is an n-ary *weighted* split tree. A node is either a `leaf` (one
 * pane, identified by an opaque id) or a `split` that lays its `children` out
 * along an axis (`row` = side-by-side, `col` = stacked), each child carrying a
 * relative `weight`. Weights are the exact same quantity the renderer already
 * consumes (`flex: <weight> 1 0%`), normalised to sum 1 per split — so the
 * geometry is identical to today's, but expressible at ARBITRARY depth (no
 * MAX_COLS / MAX_ROWS / single-level-substack caps).
 *
 * SCOPE — what this module IS. The RENDER half is live: the legacy
 * `PanelGridRow[]` / `GroupLayoutRow[]` are adapted into this tree
 * (`legacyAdapters`) and `<SplitTree>` renders it as nested flex containers.
 * `computeRects` is the geometry ORACLE the golden-geometry tests use to pin the
 * adapters' output byte-for-byte against the legacy rect math — it is not a
 * production render path (SplitTree lays out via flex-grow, not absolute rects).
 *
 * The pure EDIT half — an unwired canonical mutation engine (splitLeaf /
 * closeLeaf / moveLeaf / resizeAt / setWeightAt / equalizeAt / …) — used to live
 * here as a staged migration target. It had ZERO production callers (the live
 * resize/split/close gestures still mutate the legacy row models in place, and
 * the live 2-child divider math lives in `splitController.resizeWeights`), so it
 * was removed to keep the shipping surface honest. Recover it from git history
 * if/when that second migration half is actually wired.
 *
 * Why n-ary (children[]) and not the binary {a,b} the roadmap sketched: a row of
 * N columns IS one split node with N weighted children — a 1:1 image of the
 * current `{ groupIds, widths }` row. N-ary keeps the weight math line-for-line
 * equivalent to gridWidths.ts.
 *
 * Everything here is PURE and side-effect-free. Adapters from the legacy
 * `PanelGridRow[]` / `GroupLayoutRow[]` shapes live in `legacyAdapters`; the
 * React renderer (`<SplitTree>`) consumes the geometry but holds none of it.
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

/** Which edge of a target leaf a moved/created pane lands on. Consumed by
 *  `splitController` (pointer→edge hit-testing) even though the tree-side
 *  drop-split op that once used it lives only in git history now. */
export type DropEdge = 'left' | 'right' | 'top' | 'bottom';

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

// ───────────────────────────────── queries ─────────────────────────────────

/** All leaf ids in left-to-right / top-to-bottom (document) order. */
export function leafIds(node: LayoutNode): LeafId[] {
  if (isLeaf(node)) return [node.id];
  const out: LeafId[] = [];
  for (const c of node.children) out.push(...leafIds(c.node));
  return out;
}

// ──────────────────────────────── normalize ────────────────────────────────

/**
 * Canonicalise a tree:
 *   - normalize children recursively, dropping any that collapse to nothing;
 *   - FLATTEN a child split that shares the parent's axis into the parent,
 *     scaling the grandchildren by the child's weight (so a row inside a row
 *     becomes one row — this keeps adapter output flat where the legacy rows are);
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

  // Unreachable via the public API (constructors guarantee ≥1 child).
  if (flattened.length === 0) throw new Error('normalize: split with no children');
  if (flattened.length === 1) return flattened[0].node;

  const w = normalizeWeights(flattened.map((c) => c.weight));
  return { kind: 'split', dir: node.dir, children: flattened.map((c, i) => ({ weight: w[i], node: c.node })) };
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
 * (px) is subtracted BETWEEN siblings so dividers get real space. This is the
 * geometry ORACLE the golden-geometry tests compare the legacy adapters against
 * — the live renderer (`<SplitTree>`) lays out via flex-grow, not these rects.
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
