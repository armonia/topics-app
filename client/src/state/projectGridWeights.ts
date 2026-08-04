/**
 * projectGridWeights — a tiny module-level registry of each open project's
 * INTERNAL split extent, keyed by projectPath. A project window (ProjectWindow)
 * publishes how many leaf columns/rows its internal GroupLayout currently shows;
 * the STANDALONE grid (PanelGrid) reads it when the user double-clicks an outer
 * divider to "equalize", so a project cell is weighted by its internal splits
 * instead of being flattened to 1/n like a single chat. Without this, evening
 * out a row that holds [chat | project-with-3-columns] gave each HALF the width
 * — squeezing the project's 3 columns into the same space as one chat. With it,
 * the project cell counts as 3, so every leaf pane ends up the same width.
 *
 * Why a plain module store and not React context: the only consumer reads it
 * inside a rare click handler (equalize), never during render. A context would
 * re-render the heavy PanelGrid on every project-internal resize for no visual
 * benefit. Writes are O(1) and reads are point lookups.
 */
import type { GroupLayoutRow } from '../types';

export interface ProjectGridWeight {
  /** Horizontal leaf count: the widest internal row's column count (≥1). */
  cols: number;
  /** Vertical leaf count: stacked rows incl. per-column sub-stacks (≥1). */
  rows: number;
}

const weights = new Map<string, ProjectGridWeight>();

// Subscribers notified when a project's published weight actually CHANGES (a
// split column/row added or removed, or the visible project in a multi-tab cell
// swapped) — never on a same-value re-publish or the first publish on mount. The
// standalone grid (PanelGrid) subscribes to auto-rebalance the outer split so an
// inner split added/removed reflows the columns without a manual double-click
// ("stessa cosa quando si aggiungono o rimuovono tab"). Notifications are
// coalesced to one microtask so a burst of mount/unmount churn (a tab switch =
// clear + set) rebalances once, after the registry has settled.
type WeightListener = (changed: ReadonlySet<string>) => void;
const listeners = new Set<WeightListener>();

function sameWeight(a: ProjectGridWeight | undefined, b: ProjectGridWeight | undefined): boolean {
  if (!a || !b) return a === b;
  return a.cols === b.cols && a.rows === b.rows;
}

/**
 * Pending notifications, each remembering the weight as it was BEFORE the
 * mutation that queued it. At flush time the batch is compared against the
 * SETTLED registry and anything whose net effect is nil is dropped.
 *
 * That netting is the whole point. A clear immediately followed by a re-publish
 * of the same value is not a change, and it is what every re-run of
 * ProjectWindow's publish effect looks like from here: the cleanup clears, the
 * body sets it straight back. Dragging a divider inside a project window
 * produced a new `rows` array, which re-ran that effect, which announced a
 * change that had not happened — and PanelGrid's auto-rebalance answered by
 * flattening the OUTER row heights to an equal split. So resizing a split
 * inside one project silently threw away the sizing of the whole grid around
 * it. Fixed at the call site too (the effect keys on the weight, not on `rows`),
 * but the registry must not be one careless caller away from moving panes on
 * its own — a remount, or React's StrictMode double-invoke, is the same shape.
 */
let pendingBefore = new Map<string, ProjectGridWeight | undefined>();
function notifyWeightChange(projectPath: string, before: ProjectGridWeight | undefined): void {
  if (listeners.size === 0) return;
  const first = pendingBefore.size === 0;
  // Keep the EARLIEST "before" of the tick: the batch is netted against the
  // settled value, so the comparison has to start from where the tick started.
  if (!pendingBefore.has(projectPath)) pendingBefore.set(projectPath, before);
  if (!first) return;
  queueMicrotask(() => {
    const batch = pendingBefore;
    pendingBefore = new Map();
    if (listeners.size === 0) return;
    const changed = new Set<string>();
    for (const [path, was] of batch) {
      if (!sameWeight(was, weights.get(path))) changed.add(path);
    }
    if (changed.size > 0) for (const l of listeners) l(changed);
  });
}

/** Subscribe to weight changes; returns an unsubscribe fn. */
export function subscribeProjectGridWeights(listener: WeightListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Compute a project's split extent from its GroupLayout rows.
 *
 * `cols` is the max column count across rows — the horizontal leaf count of the
 * widest slice, so an outer column holding this project is weighted to keep its
 * widest row's columns the same width as neighbouring leaves.
 *
 * `rows` is the sum, over each internal row, of that row's DEEPEST column
 * (`1 + its vertical sub-stack depth`) — the true vertical leaf count, so a
 * column split "in basso" (a `cellStacks` entry) counts toward height too.
 *
 * Empty / degenerate input → `{ cols: 1, rows: 1 }` (behaves like a single
 * unsplit cell, i.e. weight 1, so equalize falls back to the uniform split).
 */
export function computeProjectGridWeight(
  rows: readonly GroupLayoutRow[] | undefined | null,
): ProjectGridWeight {
  if (!rows || rows.length === 0) return { cols: 1, rows: 1 };
  let cols = 1;
  let rowLeaves = 0;
  for (const r of rows) {
    const colCount = Math.max(1, r.groupIds?.length ?? 1);
    if (colCount > cols) cols = colCount;
    // Vertical depth of this row = its deepest column's sub-stack: the primary
    // group (1) plus any vertically-stacked groups under it (cellStacks).
    let depth = 1;
    if (r.cellStacks) {
      for (const gid of r.groupIds ?? []) {
        const d = 1 + (r.cellStacks[gid]?.groupIds?.length ?? 0);
        if (d > depth) depth = d;
      }
    }
    rowLeaves += depth;
  }
  return { cols, rows: Math.max(1, rowLeaves) };
}

/** Publish a project's current internal split extent (called by ProjectWindow). */
export function setProjectGridWeight(projectPath: string, weight: ProjectGridWeight): void {
  const prev = weights.get(projectPath);
  weights.set(projectPath, weight);
  // Only a real change (not the first publish, not a same-value re-publish)
  // should reflow the outer grid — the first publish on mount must NOT disturb
  // the persisted layout being restored.
  if (prev && !sameWeight(prev, weight)) {
    notifyWeightChange(projectPath, prev);
  }
}

/** Read a project's internal split extent, or undefined if it isn't open. */
export function getProjectGridWeight(projectPath: string): ProjectGridWeight | undefined {
  return weights.get(projectPath);
}

/** Drop a project's record (called when its window unmounts / path changes). */
export function clearProjectGridWeight(projectPath: string): void {
  // A clear means the cell's visible project is changing (tab switch / close);
  // notify so the outer grid re-weights from whatever is now mounted there. The
  // coalescing microtask runs after the new active project has published, so the
  // rebalance reads the settled registry — and if what settles is identical to
  // what was there, the netting in notifyWeightChange drops it.
  const prev = weights.get(projectPath);
  if (weights.delete(projectPath)) notifyWeightChange(projectPath, prev);
}
