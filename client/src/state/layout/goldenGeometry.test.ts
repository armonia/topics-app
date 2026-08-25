/**
 * Golden geometry test — the P2 migration-safety gate (integration guide Step 2).
 *
 * Proves that feeding a legacy layout through the adapter + the new geometry
 * engine — `computeRects(gridRowsToTree(rows, rowHeights), CONTAINER, gutter)` —
 * reproduces the EXACT pixel geometry the legacy flex renderer produces for the
 * same `PanelGridRow[]` / `GroupLayoutRow[]`.
 *
 * The reference here (`legacyGridGeometry` / `legacyGroupGeometry`) is written
 * straight against the legacy MENTAL MODEL — rows sized by `rowHeights`, columns
 * by `widths`, a cell's vertical sub-stack by `cellStacks[key].heights` (INCLUDING
 * the primary at index 0) — using a plain `flex: <weight> 1 0%` band layout. It
 * shares no code with `layoutTree`/`legacyAdapters`, so it catches any future
 * adapter regression (dropped cellStacks, swapped widths order, mis-matched
 * fallback) that the structural round-trip test wouldn't surface as a *geometry*
 * difference.
 *
 * Only flip the P2 flag's render path on for real once this is green.
 *
 * @covers LAYOUT-01
 */
import { test, expect, describe } from 'bun:test';
import { gridRowsToTree, groupRowsToTree, buildShallowGridTree } from './legacyAdapters';
import { computeRects, type LayoutNode, type LeafRect, type Rect } from './layoutTree';
import type { PanelGridRow, GroupLayoutRow } from '../../types';

const CONTAINER: Rect = { x: 0, y: 0, width: 1200, height: 800 };
const EPS = 1e-6;

/* ── independent reference: legacy flex band layout ─────────────────────────── */

/** Mirror layoutTree.normalizeWeights WITHOUT importing it: clamp non-positive /
 *  non-finite to 0, renormalise to sum 1, all-zero → equal split. */
function normalize(ws: number[]): number[] {
  const clean = ws.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const total = clean.reduce((s, x) => s + x, 0);
  return total > 1e-9 ? clean.map((x) => x / total) : ws.map(() => 1 / ws.length);
}

/** Lay `weights.length` segments across `total` starting at `start`, reserving a
 *  `gutter` strip BETWEEN each (exactly what `flex: w 1 0%` siblings + a gutter
 *  produce, and what computeRects does). */
function band(total: number, start: number, weights: number[], gutter: number): { offset: number; size: number }[] {
  const gaps = gutter * (weights.length - 1);
  const usable = Math.max(0, total - gaps);
  const w = normalize(weights);
  let off = start;
  return weights.map((_, i) => {
    const size = usable * w[i];
    const seg = { offset: off, size };
    off += size + gutter;
    return seg;
  });
}

interface NormRowLike {
  keys: string[];
  widths: number[];
  /** key → [primary, ...members] heights (length = members) when stacked. */
  stacks: Record<string, { items: string[]; heights: number[] }>;
}

/** Shared reference layout, mirroring buildTree's fallbacks:
 *  - rows with no columns are dropped;
 *  - `rowHeights` used only when its length matches the live-row count, else equal;
 *  - a row's `widths` used only when length matches the column count, else equal;
 *  - a stack's heights used only when length matches [primary, ...members], else equal. */
function legacyGeometry(rows: NormRowLike[], rowHeights: number[], container: Rect, gutter: number): LeafRect[] {
  const live = rows.filter((r) => r.keys.length > 0);
  const rowW = rowHeights.length === live.length ? rowHeights : live.map(() => 1);
  const rowSegs = band(container.height, container.y, rowW, gutter);
  const out: LeafRect[] = [];
  live.forEach((row, ri) => {
    const { offset: ry, size: rh } = rowSegs[ri];
    const colW = row.widths.length === row.keys.length ? row.widths : row.keys.map(() => 1);
    const colSegs = band(container.width, container.x, colW, gutter);
    row.keys.forEach((key, ci) => {
      const { offset: cx, size: cw } = colSegs[ci];
      const stack = row.stacks[key];
      if (stack && stack.items.length > 0) {
        const members = [key, ...stack.items];
        const h = stack.heights.length === members.length ? stack.heights : members.map(() => 1);
        const memSegs = band(rh, ry, h, gutter);
        members.forEach((mkey, mi) => {
          out.push({ id: mkey, x: cx, y: memSegs[mi].offset, width: cw, height: memSegs[mi].size });
        });
      } else {
        out.push({ id: key, x: cx, y: ry, width: cw, height: rh });
      }
    });
  });
  return out;
}

function legacyGridGeometry(rows: PanelGridRow[], rowHeights: number[], container: Rect, gutter: number): LeafRect[] {
  return legacyGeometry(
    rows.map((r) => ({
      keys: r.itemKeys,
      widths: r.widths,
      stacks: Object.fromEntries(
        Object.entries(r.cellStacks ?? {}).map(([k, s]) => [k, { items: s.items, heights: s.heights }]),
      ),
    })),
    rowHeights,
    container,
    gutter,
  );
}

function legacyGroupGeometry(rows: GroupLayoutRow[], rowHeights: number[], container: Rect, gutter: number): LeafRect[] {
  return legacyGeometry(
    rows.map((r) => ({
      keys: r.groupIds,
      widths: r.widths,
      stacks: Object.fromEntries(
        Object.entries(r.cellStacks ?? {}).map(([k, s]) => [k, { items: s.groupIds, heights: s.heights }]),
      ),
    })),
    rowHeights,
    container,
    gutter,
  );
}

/* ── assertion helper ───────────────────────────────────────────────────────── */

function expectSameGeometry(actual: LeafRect[], expected: LeafRect[]): void {
  // Same set of leaves (id + count), and each leaf's rect matches within EPS.
  expect(actual.length).toBe(expected.length);
  const byId = new Map(actual.map((r) => [r.id, r]));
  expect(byId.size).toBe(actual.length); // ids unique
  for (const e of expected) {
    const a = byId.get(e.id);
    expect(a, `leaf "${e.id}" present`).toBeDefined();
    expect(Math.abs(a!.x - e.x)).toBeLessThan(EPS);
    expect(Math.abs(a!.y - e.y)).toBeLessThan(EPS);
    expect(Math.abs(a!.width - e.width)).toBeLessThan(EPS);
    expect(Math.abs(a!.height - e.height)).toBeLessThan(EPS);
  }
}

/* ── corpus: representative real-world standalone (PanelGrid) layouts ─────────── */

interface GridCase {
  name: string;
  rows: PanelGridRow[];
  rowHeights: number[];
  gutter?: number;
}

const GRID_CASES: GridCase[] = [
  { name: 'single pane', rows: [{ itemKeys: ['a'], widths: [1] }], rowHeights: [1] },
  { name: 'two columns, uneven', rows: [{ itemKeys: ['a', 'b'], widths: [0.62, 0.38] }], rowHeights: [1] },
  { name: 'three columns', rows: [{ itemKeys: ['a', 'b', 'c'], widths: [0.5, 0.25, 0.25] }], rowHeights: [1] },
  {
    name: 'two rows, uneven heights',
    rows: [{ itemKeys: ['a'], widths: [1] }, { itemKeys: ['b'], widths: [1] }],
    rowHeights: [0.7, 0.3],
  },
  {
    name: '2x2 grid',
    rows: [
      { itemKeys: ['a', 'b'], widths: [0.55, 0.45] },
      { itemKeys: ['c', 'd'], widths: [0.4, 0.6] },
    ],
    rowHeights: [0.6, 0.4],
  },
  {
    name: 'column with a vertical sub-stack (primary + 2, uneven)',
    rows: [
      {
        itemKeys: ['a', 'b'],
        widths: [0.5, 0.5],
        cellStacks: { b: { items: ['c', 'd'], heights: [0.5, 0.3, 0.2] } },
      },
    ],
    rowHeights: [1],
  },
  {
    name: 'mixed row: plain column beside a stacked column',
    rows: [
      {
        itemKeys: ['a', 'b', 'e'],
        widths: [0.3, 0.4, 0.3],
        cellStacks: { b: { items: ['c'], heights: [0.6, 0.4] } },
      },
    ],
    rowHeights: [1],
  },
  {
    // buildTree falls back to equal rows when rowHeights length ≠ live-row count.
    name: 'mismatched rowHeights → equal rows',
    rows: [{ itemKeys: ['a'], widths: [1] }, { itemKeys: ['b'], widths: [1] }],
    rowHeights: [0.9],
  },
  {
    // empty rows are dropped before sizing.
    name: 'empty row dropped',
    rows: [{ itemKeys: [], widths: [] }, { itemKeys: ['a', 'b'], widths: [0.7, 0.3] }],
    rowHeights: [0.5, 0.5],
  },
  { name: '2x2 with a 6px gutter', rows: [
      { itemKeys: ['a', 'b'], widths: [0.5, 0.5] },
      { itemKeys: ['c', 'd'], widths: [0.5, 0.5] },
    ], rowHeights: [0.5, 0.5], gutter: 6 },
  {
    name: 'sub-stack with a 6px gutter',
    rows: [{ itemKeys: ['a', 'b'], widths: [0.5, 0.5], cellStacks: { a: { items: ['c'], heights: [0.5, 0.5] } } }],
    rowHeights: [1],
    gutter: 6,
  },
];

describe('golden geometry — standalone PanelGrid (gridRowsToTree + computeRects)', () => {
  for (const c of GRID_CASES) {
    test(c.name, () => {
      const gutter = c.gutter ?? 0;
      const actual = computeRects(gridRowsToTree(c.rows, c.rowHeights), CONTAINER, gutter);
      const expected = legacyGridGeometry(c.rows, c.rowHeights, CONTAINER, gutter);
      expectSameGeometry(actual, expected);
    });
  }

  test('rects tile the container with no overlap/gap (gutter 0)', () => {
    const rows: PanelGridRow[] = [
      { itemKeys: ['a', 'b'], widths: [0.55, 0.45] },
      { itemKeys: ['c', 'd'], widths: [0.4, 0.6] },
    ];
    const rects = computeRects(gridRowsToTree(rows, [0.6, 0.4]), CONTAINER, 0);
    const area = rects.reduce((s, r) => s + r.width * r.height, 0);
    expect(Math.abs(area - CONTAINER.width * CONTAINER.height)).toBeLessThan(1e-3);
  });
});

/* ── corpus: project (GroupLayout) layouts ────────────────────────────────────── */

interface GroupCase {
  name: string;
  rows: GroupLayoutRow[];
  rowHeights: number[];
  gutter?: number;
}

const GROUP_CASES: GroupCase[] = [
  { name: 'single group', rows: [{ groupIds: ['g1'], widths: [1] }], rowHeights: [1] },
  { name: 'two groups side by side', rows: [{ groupIds: ['g1', 'g2'], widths: [0.66, 0.34] }], rowHeights: [1] },
  {
    name: 'group with a "split in basso" sub-stack',
    rows: [
      {
        groupIds: ['g1', 'g2'],
        widths: [0.5, 0.5],
        cellStacks: { g1: { groupIds: ['g3', 'g4'], heights: [0.4, 0.35, 0.25] } },
      },
    ],
    rowHeights: [1],
  },
  {
    name: '2x2 groups with gutter',
    rows: [
      { groupIds: ['g1', 'g2'], widths: [0.5, 0.5] },
      { groupIds: ['g3', 'g4'], widths: [0.5, 0.5] },
    ],
    rowHeights: [0.5, 0.5],
    gutter: 6,
  },
];

describe('golden geometry — project GroupLayout (groupRowsToTree + computeRects)', () => {
  for (const c of GROUP_CASES) {
    test(c.name, () => {
      const gutter = c.gutter ?? 0;
      const actual = computeRects(groupRowsToTree(c.rows, c.rowHeights), CONTAINER, gutter);
      const expected = legacyGroupGeometry(c.rows, c.rowHeights, CONTAINER, gutter);
      expectSameGeometry(actual, expected);
    });
  }
});

/* ── the SHIPPED renderer builder (buildShallowGridTree) ──────────────────────
 * The deep adapters above are the persistence/round-trip oracle, but the two
 * desktop renderers do NOT consume them — they drive a SHALLOW tree (sub-stacks
 * render in <CellSubStack>, not as tree leaves) built by buildShallowGridTree.
 * This pins that exact production code against the legacy geometry, closing the
 * gap where the gate only ever exercised the never-rendered adapter path.
 *
 * The shallow builder diverges from the deep adapter ONLY on degenerate input
 * (per-index `rowHeights[ri] ?? …` vs the adapter's all-or-nothing length match;
 * empty rows kept as inert placeholders vs dropped) — never hit by real state.
 * So we assert equality on the CLEAN subset (every row populated, weight arrays
 * length-matched) where shallow and legacy MUST agree, plus a dedicated case for
 * the shallow builder's unique weight-0 self-heal. */
function nonNull(tree: LayoutNode | null): LayoutNode {
  if (!tree) throw new Error('buildShallowGridTree returned null for a populated layout');
  return tree;
}
const isCleanGrid = (c: GridCase) =>
  c.rowHeights.length === c.rows.length &&
  c.rows.every((r) => r.itemKeys.length > 0 && r.widths.length === r.itemKeys.length && !r.cellStacks);
const isCleanGroup = (c: GroupCase) =>
  c.rowHeights.length === c.rows.length &&
  c.rows.every((r) => r.groupIds.length > 0 && r.widths.length === r.groupIds.length && !r.cellStacks);

describe('golden geometry — shipped shallow builder (buildShallowGridTree + computeRects)', () => {
  for (const c of GRID_CASES.filter(isCleanGrid)) {
    test(`grid: ${c.name}`, () => {
      const gutter = c.gutter ?? 0;
      const shallow = c.rows.map((r) => ({ keys: r.itemKeys, widths: r.widths }));
      const actual = computeRects(nonNull(buildShallowGridTree(shallow, c.rowHeights, () => true)), CONTAINER, gutter);
      const expected = legacyGridGeometry(c.rows, c.rowHeights, CONTAINER, gutter);
      expectSameGeometry(actual, expected);
    });
  }

  for (const c of GROUP_CASES.filter(isCleanGroup)) {
    test(`group: ${c.name}`, () => {
      const gutter = c.gutter ?? 0;
      const shallow = c.rows.map((r) => ({ keys: r.groupIds, widths: r.widths }));
      const actual = computeRects(nonNull(buildShallowGridTree(shallow, c.rowHeights, () => true)), CONTAINER, gutter);
      const expected = legacyGroupGeometry(c.rows, c.rowHeights, CONTAINER, gutter);
      expectSameGeometry(actual, expected);
    });
  }

  test('a non-live key collapses to weight-0 and reserves no space (self-heal)', () => {
    // The renderer feeds isLive=itemMap.has; a transient stale key must take zero
    // width so the live sibling fills the band and no blank gap shows.
    const tree = nonNull(buildShallowGridTree([{ keys: ['a', 'ghost'], widths: [0.5, 0.5] }], [1], (k) => k === 'a'));
    const rects = computeRects(tree, CONTAINER, 0);
    const a = rects.find((r) => r.id === 'a');
    expect(a).toBeDefined();
    expect(Math.abs(a!.width - CONTAINER.width)).toBeLessThan(EPS);
  });
});
