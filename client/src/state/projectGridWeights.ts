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
let pendingChanged: Set<string> | null = null;
function notifyWeightChange(projectPath: string): void {
  if (listeners.size === 0) return;
  const first = pendingChanged === null;
  (pendingChanged ??= new Set()).add(projectPath);
  if (!first) return;
  queueMicrotask(() => {
    const batch = pendingChanged;
    pendingChanged = null;
    if (batch && listeners.size > 0) for (const l of listeners) l(batch);
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
  if (prev && (prev.cols !== weight.cols || prev.rows !== weight.rows)) {
    notifyWeightChange(projectPath);
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
  // rebalance reads the settled registry.
  if (weights.delete(projectPath)) notifyWeightChange(projectPath);
}
