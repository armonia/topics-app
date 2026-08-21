/**
 * taskBrowserLayout — a task-scoped tiling layout for a task's browser tabs.
 *
 * The task's browser tabs (state/taskBrowserTabs) are rendered through the app's
 * REAL layout engine (`GroupLayout` + `SplitTree` + `PaneTabBar`), giving true
 * split / drag-to-split / tab-stack / resize — but WITHOUT the tabs ever entering
 * `pane-store-v2`. This module holds the layout DESCRIPTOR for one task
 * (`groups`/`rows`/`rowHeights`/`focusedGroupId`, referencing pane ids
 * `browser:<contextId>`), persisted per-task via `ui-state`, and the PURE reducer
 * ops (ported browsers-only from `useProjectLayout`, reusing the same
 * `groupLayoutStacks`/`gridWidths` helpers) that `GroupLayout`'s callbacks drive.
 *
 * The identity source of truth stays in `taskBrowserTabs`; this is only a view
 * over `browser:<contextId>` pane ids. `reconcileTaskLayout` keeps the two in
 * sync: it appends tabs that aren't placed yet, prunes groups/rows referencing a
 * closed/parked tab, and preserves manual widths/heights — the same contract as
 * the project layout's orphan/row reconcile, minus the terminal/chat/preview
 * branches (every task pane is a single 'utility' browser group).
 */

import { useSyncExternalStore, useEffect } from 'react';
import type { Pane, PaneGroup, PaneGroupType, GroupLayoutRow } from '../types';
import { createGroupId } from './pane/adapters/paneConfig';
import { MAX_COLS_PER_ROW, MAX_ROWS } from '../components/Layout/constants';
import {
  splitColumnWidths,
  appendColumnWidths,
  keepColumnWidths,
} from '../components/Layout/gridWidths';
import {
  locateGroup,
  isColumnStackFull,
  addGroupToColumnStack,
  reconcileCellStacks,
  pickCellStacks,
  rowGroupIds,
} from '../components/Layout/groupLayoutStacks';

/** Every task browser pane is a single group kind — no chat/file affinity. */
const GROUP_TYPE: PaneGroupType = 'utility';

export interface TaskLayoutState {
  groups: PaneGroup[];
  rows: GroupLayoutRow[];
  rowHeights: number[];
  focusedGroupId: string | null;
}

export const EMPTY_TASK_LAYOUT: TaskLayoutState = { groups: [], rows: [], rowHeights: [], focusedGroupId: null };

/**
 * Which freshly-appeared pane of a task drawer may claim its group's active
 * slot when reconcile places it.
 *
 * A browser tab (agent-opened, or seeded from the delivered output_url) should
 * surface, and so should the two panes that ARE the task's own conversation —
 * the thread and the agent session: on a task that was just dispatched they are
 * the reason the drawer is open. A plan or an attachment arriving mid-read must
 * NOT yank the reader off what they are looking at.
 *
 * It lives here, next to the reconcile that obeys it, because it is the part
 * that can be wrong in silence: the hook that passes it is a component tree no
 * unit test can mount, so a copy of the rule written inside a test would prove
 * only that the copy is right.
 */
export function canAutoActivateTaskPane(paneId: string): boolean {
  return paneId.startsWith('browser:') || paneId.startsWith('thread:') || paneId.startsWith('session:');
}

/** Injected group-id generator (default = the app's real one); overridable so
 *  the pure reducers are deterministic under test. */
export type GenId = () => string;
const defaultGenId: GenId = createGroupId;

// ── pane ↔ group reconcile (browsers-only subset of useProjectLayout) ─────────

/**
 * Ensure every live pane sits in exactly one group and no group references a
 * pane that's gone: drop dead paneIds (fixing `activePaneId`), drop empty
 * groups, then append still-unplaced panes to the focused group (or the first,
 * or a fresh group). Newly-appeared panes become active in their group so an
 * agent-opened / just-added tab surfaces. `changed=false` ⇒ same reference.
 */
export function reconcilePanesIntoGroups(
  groups: PaneGroup[],
  livePaneIds: readonly string[],
  focusedGroupId: string | null,
  genId: GenId = defaultGenId,
  // Which freshly-appeared panes may steal their group's active slot. A browser
  // tab (agent-opened / seeded output) SHOULD surface; a derived thread/plan/
  // media pane arriving mid-read must NOT yank the user off what they're viewing.
  // Default: everything auto-activates (keeps browsers-only callers + tests green).
  shouldActivateOrphan: (paneId: string) => boolean = () => true,
): { groups: PaneGroup[]; changed: boolean } {
  const live = new Set(livePaneIds);
  let changed = false;

  let updated = groups.map((g) => {
    const filtered = g.paneIds.filter((id) => live.has(id));
    if (filtered.length === g.paneIds.length) return g;
    changed = true;
    const activePaneId = filtered.includes(g.activePaneId) ? g.activePaneId : (filtered[0] || g.activePaneId);
    return { ...g, paneIds: filtered, activePaneId };
  });
  const beforeLen = updated.length;
  updated = updated.filter((g) => g.paneIds.length > 0);
  if (updated.length !== beforeLen) changed = true;

  const placed = new Set(updated.flatMap((g) => g.paneIds));
  const orphans = livePaneIds.filter((id) => !placed.has(id));

  if (!changed && orphans.length === 0) return { groups, changed: false };

  if (orphans.length > 0) {
    const focusedIdx = focusedGroupId ? updated.findIndex((g) => g.id === focusedGroupId) : -1;
    const targetIdx = focusedIdx >= 0 ? focusedIdx : (updated.length > 0 ? 0 : -1);
    // Activate the LAST orphan that's allowed to steal focus; if none qualifies,
    // keep the group's current active pane (a media pane appended mid-read must
    // not pull the user off the Thread).
    const activateId = [...orphans].reverse().find(shouldActivateOrphan);
    if (targetIdx >= 0) {
      updated = updated.map((g, i) => (i === targetIdx
        ? { ...g, paneIds: [...g.paneIds, ...orphans], activePaneId: activateId ?? g.activePaneId }
        : g));
    } else {
      // Empty layout: nothing was active, so the first mint activates its last
      // orphan regardless (the drawer must open on something).
      updated = [{ id: genId(), paneIds: [...orphans], activePaneId: activateId ?? orphans[orphans.length - 1], type: GROUP_TYPE }];
    }
    changed = true;
  }

  return { groups: changed ? updated : groups, changed };
}

// ── group ↔ row/height reconcile (ported verbatim, browsers-only) ─────────────

/**
 * Place every group in exactly one row cell and drop rows/columns referencing a
 * gone group, preserving manual widths/heights (never flattening siblings to
 * 1/n). Mirrors useProjectLayout's rows-sync effect. `changed=false` ⇒ same
 * `rows` reference.
 */
export function syncRowsWithGroups(
  groups: PaneGroup[],
  rows: GroupLayoutRow[],
  rowHeights: number[],
): { rows: GroupLayoutRow[]; rowHeights: number[]; changed: boolean } {
  const allGroupIds = new Set(groups.map((g) => g.id));

  const reconciled = reconcileCellStacks(rows, allGroupIds);
  const curRows = reconciled.rows;
  let anyRowChanged = reconciled.changed;

  let newRows = curRows.map((r) => {
    const keepIdx: number[] = [];
    for (let i = 0; i < r.groupIds.length; i++) {
      if (allGroupIds.has(r.groupIds[i])) keepIdx.push(i);
    }
    if (keepIdx.length === r.groupIds.length) return r;
    anyRowChanged = true;
    const groupIds = keepIdx.map((i) => r.groupIds[i]);
    const widths = keepColumnWidths(r.widths, keepIdx);
    const cellStacks = pickCellStacks(r.cellStacks, groupIds);
    return { groupIds, widths, ...(cellStacks ? { cellStacks } : {}) };
  });

  const keptRowIdx: number[] = [];
  const beforeLen = newRows.length;
  newRows = newRows.filter((r, i) => {
    const keep = r.groupIds.length > 0;
    if (keep) keptRowIdx.push(i);
    return keep;
  });
  if (newRows.length !== beforeLen) anyRowChanged = true;

  const usedAfterClean = new Set(newRows.flatMap(rowGroupIds));
  const newGroupIds = groups.filter((g) => !usedAfterClean.has(g.id)).map((g) => g.id);
  if (newGroupIds.length > 0) {
    anyRowChanged = true;
    if (newRows.length === 0) {
      newRows = [{ groupIds: newGroupIds, widths: newGroupIds.map(() => 1 / newGroupIds.length) }];
    } else {
      const firstRow = newRows[0];
      const slots = Math.max(0, MAX_COLS_PER_ROW - firstRow.groupIds.length);
      const toFirst = newGroupIds.slice(0, slots);
      const overflow = newGroupIds.slice(slots);
      let rebuilt = newRows;
      if (toFirst.length > 0) {
        rebuilt = [{ ...firstRow, groupIds: [...firstRow.groupIds, ...toFirst], widths: appendColumnWidths(firstRow.widths, toFirst.length) }, ...rebuilt.slice(1)];
      }
      if (overflow.length > 0) {
        rebuilt = [...rebuilt, { groupIds: overflow, widths: overflow.map(() => 1 / overflow.length) }];
      }
      newRows = rebuilt;
    }
  }

  if (newRows.length === 0 && groups.length > 0) {
    anyRowChanged = true;
    const gids = groups.map((g) => g.id);
    newRows = [{ groupIds: gids, widths: gids.map(() => 1 / gids.length) }];
  }

  let newHeights = rowHeights;
  if (anyRowChanged && newRows.length !== rowHeights.length) {
    newHeights = keptRowIdx.length === newRows.length && newRows.length > 0
      ? keepColumnWidths(rowHeights, keptRowIdx)
      : newRows.map(() => 1 / newRows.length);
  }

  return anyRowChanged ? { rows: newRows, rowHeights: newHeights, changed: true } : { rows, rowHeights, changed: false };
}

/**
 * Full reconcile: bring `state` in line with the live pane set (append/prune
 * panes, then re-home/prune groups in rows). Returns the SAME reference when
 * nothing changed, so it's safe to run every render (useMemo).
 */
export function reconcileTaskLayout(
  state: TaskLayoutState,
  livePaneIds: readonly string[],
  genId: GenId = defaultGenId,
  shouldActivateOrphan?: (paneId: string) => boolean,
): TaskLayoutState {
  const g = reconcilePanesIntoGroups(state.groups, livePaneIds, state.focusedGroupId, genId, shouldActivateOrphan);
  const r = syncRowsWithGroups(g.groups, state.rows, state.rowHeights);
  let focusedGroupId = state.focusedGroupId;
  // A pruned focused group, or a never-set focus with groups present, defaults
  // to the first group so the layout always has a focus target.
  if (focusedGroupId && !g.groups.some((x) => x.id === focusedGroupId)) focusedGroupId = null;
  if (!focusedGroupId && g.groups.length > 0) focusedGroupId = g.groups[0].id;
  const focusChanged = focusedGroupId !== state.focusedGroupId;
  if (!g.changed && !r.changed && !focusChanged) return state;
  return { groups: g.groups, rows: r.rows, rowHeights: r.rowHeights, focusedGroupId };
}

// ── structural handlers (GroupLayout callbacks) ───────────────────────────────

/** Set the active pane in a group + focus it. */
export function activatePane(state: TaskLayoutState, groupId: string, paneId: string): TaskLayoutState {
  const g = state.groups.find((x) => x.id === groupId);
  if (!g) return state;
  if (g.activePaneId === paneId && state.focusedGroupId === groupId) return state;
  return {
    ...state,
    groups: state.groups.map((x) => (x.id === groupId ? { ...x, activePaneId: paneId } : x)),
    focusedGroupId: groupId,
  };
}

/** Reorder the panes within a single group (tab drag inside a bar). */
export function reorderGroupPanes(state: TaskLayoutState, groupId: string, newPaneIds: string[]): TaskLayoutState {
  return { ...state, groups: state.groups.map((g) => (g.id === groupId ? { ...g, paneIds: newPaneIds } : g)) };
}

/** Move a pane from one group to another at `insertIdx`; drop an emptied source
 *  group and re-sync rows. Ported from useProjectLayout.handleMovePaneBetweenGroups. */
export function movePaneBetweenGroups(
  state: TaskLayoutState,
  sourceGroupId: string,
  targetGroupId: string,
  paneId: string,
  insertIdx: number,
): TaskLayoutState {
  const sourceGroup = state.groups.find((g) => g.id === sourceGroupId);
  const targetGroup = state.groups.find((g) => g.id === targetGroupId);
  if (!sourceGroup || !targetGroup || !sourceGroup.paneIds.includes(paneId)) return state;

  const groups = state.groups
    .map((g) => {
      if (g.id === sourceGroupId) {
        const remaining = g.paneIds.filter((id) => id !== paneId);
        const newActive = remaining.length > 0
          ? (g.activePaneId === paneId ? remaining[Math.min(g.paneIds.indexOf(paneId), remaining.length - 1)] : g.activePaneId)
          : g.activePaneId;
        return { ...g, paneIds: remaining, activePaneId: newActive };
      }
      if (g.id === targetGroupId) {
        const newPaneIds = [...g.paneIds];
        newPaneIds.splice(Math.max(0, Math.min(insertIdx, newPaneIds.length)), 0, paneId);
        return { ...g, paneIds: newPaneIds, activePaneId: paneId };
      }
      return g;
    })
    .filter((g) => g.paneIds.length > 0);

  const synced = syncRowsWithGroups(groups, state.rows, state.rowHeights);
  return { groups, rows: synced.rows, rowHeights: synced.rowHeights, focusedGroupId: targetGroupId };
}

/** Split a group on an edge (side column / vertical column-stack / full row).
 *  Ported from useProjectLayout.handleSplitGroup, browsers-only ('utility'
 *  group). Enforces MAX_COLS_PER_ROW / stack depth / MAX_ROWS before mutating. */
export function splitGroup(
  state: TaskLayoutState,
  sourceGroupId: string,
  paneId: string,
  targetGroupId: string,
  edge: 'left' | 'right' | 'top' | 'bottom',
  opts?: { fullRow?: boolean },
  genId: GenId = defaultGenId,
): TaskLayoutState {
  const isVertical = edge === 'top' || edge === 'bottom';
  const fullRow = isVertical && !!opts?.fullRow;
  const columnSplit = isVertical && !fullRow;

  if (sourceGroupId === targetGroupId && !fullRow) {
    const sg = state.groups.find((g) => g.id === sourceGroupId);
    if (sg && sg.paneIds.length <= 1) return state;
  }

  // Grid limits (before any mutation) so we never strand an unplaced group.
  if (edge === 'left' || edge === 'right') {
    const loc = locateGroup(state.rows, targetGroupId);
    const targetRow = loc ? state.rows[loc.rowIdx] : undefined;
    if (targetRow && targetRow.groupIds.length >= MAX_COLS_PER_ROW) return state;
  } else if (columnSplit) {
    if (isColumnStackFull(state.rows, targetGroupId)) return state;
  } else if (state.rows.length >= MAX_ROWS) {
    return state;
  }

  const src = state.groups.find((g) => g.id === sourceGroupId);
  if (!src || !src.paneIds.includes(paneId)) return state;

  const newGroupId = genId();
  const newGroup: PaneGroup = { id: newGroupId, paneIds: [paneId], activePaneId: paneId, type: GROUP_TYPE };

  const groups = state.groups
    .map((g) => {
      if (g.id === sourceGroupId) {
        const remaining = g.paneIds.filter((id) => id !== paneId);
        const newActive = remaining.length > 0
          ? (g.activePaneId === paneId ? remaining[Math.min(g.paneIds.indexOf(paneId), remaining.length - 1)] : g.activePaneId)
          : g.activePaneId;
        return { ...g, paneIds: remaining, activePaneId: newActive };
      }
      return g;
    })
    .filter((g) => g.paneIds.length > 0)
    .concat(newGroup);

  let rows = state.rows;
  let rowHeights = state.rowHeights;

  if (edge === 'left' || edge === 'right') {
    const loc = locateGroup(rows, targetGroupId);
    if (loc) {
      rows = rows.map((row, i) => {
        if (i !== loc.rowIdx) return row;
        const newGroupIds = [...row.groupIds];
        const insertAt = edge === 'left' ? loc.colIdx : loc.colIdx + 1;
        newGroupIds.splice(insertAt, 0, newGroupId);
        const newWidths = splitColumnWidths(row.widths, loc.colIdx, insertAt);
        return { ...row, groupIds: newGroupIds, widths: newWidths };
      });
    }
  } else if (columnSplit) {
    rows = addGroupToColumnStack(rows, targetGroupId, newGroupId, edge);
  } else {
    let targetRowIdx = rows.findIndex((row) => row.groupIds.includes(targetGroupId));
    if (targetRowIdx === -1) targetRowIdx = edge === 'top' ? 0 : rows.length - 1;
    const insertAt = edge === 'top' ? targetRowIdx : targetRowIdx + 1;
    const newRows = [...rows];
    newRows.splice(insertAt, 0, { groupIds: [newGroupId], widths: [1] });
    rows = newRows;
    const newHeights = [...rowHeights];
    const donorIdx = Math.max(0, Math.min(targetRowIdx, newHeights.length - 1));
    const halfHeight = (newHeights[donorIdx] || 1 / Math.max(1, rowHeights.length)) / 2;
    if (newHeights.length > 0) newHeights[donorIdx] = halfHeight;
    newHeights.splice(insertAt, 0, halfHeight);
    rowHeights = newHeights;
  }

  const synced = syncRowsWithGroups(groups, rows, rowHeights);
  return { groups, rows: synced.rows, rowHeights: synced.rowHeights, focusedGroupId: newGroupId };
}

/** Reorder top-level rows (drag a row band). */
export function reorderRows(state: TaskLayoutState, newRowOrder: number[]): TaskLayoutState {
  const rows = newRowOrder.map((i) => state.rows[i]).filter(Boolean) as GroupLayoutRow[];
  const rowHeights = newRowOrder.map((i) => state.rowHeights[i]).filter((h) => h !== undefined);
  return { ...state, rows, rowHeights };
}

export function updateRows(state: TaskLayoutState, rows: GroupLayoutRow[]): TaskLayoutState {
  return { ...state, rows };
}
export function updateRowHeights(state: TaskLayoutState, rowHeights: number[]): TaskLayoutState {
  return { ...state, rowHeights };
}

/** Focus a group (so a subsequently-added tab lands in it). No-op for an
 *  unknown group or when already focused. */
export function focusGroup(state: TaskLayoutState, groupId: string): TaskLayoutState {
  if (state.focusedGroupId === groupId || !state.groups.some((g) => g.id === groupId)) return state;
  return { ...state, focusedGroupId: groupId };
}

// ── sanitize (untrusted ui-state payload) ─────────────────────────────────────

function isStrArr(v: unknown): v is string[] { return Array.isArray(v) && v.every((x) => typeof x === 'string'); }
function isNumArr(v: unknown): v is number[] { return Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x)); }

/** Coerce a persisted layout payload into a valid state, or null (→ EMPTY, and
 *  reconcile rebuilds it from the tabs). Strict: any structural surprise falls
 *  back to a rebuild rather than rendering a corrupt tree. */
export function sanitizeTaskLayout(v: unknown): TaskLayoutState | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.groups) || !Array.isArray(o.rows) || !isNumArr(o.rowHeights)) return null;

  const groups: PaneGroup[] = [];
  for (const raw of o.groups) {
    if (!raw || typeof raw !== 'object') return null;
    const g = raw as Record<string, unknown>;
    if (typeof g.id !== 'string' || !isStrArr(g.paneIds) || typeof g.activePaneId !== 'string') return null;
    groups.push({ id: g.id, paneIds: g.paneIds, activePaneId: g.activePaneId, type: GROUP_TYPE });
  }

  const rows: GroupLayoutRow[] = [];
  for (const raw of o.rows) {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (!isStrArr(r.groupIds) || !isNumArr(r.widths)) return null;
    const row: GroupLayoutRow = { groupIds: r.groupIds, widths: r.widths };
    if (r.cellStacks && typeof r.cellStacks === 'object') {
      const cs: Record<string, { groupIds: string[]; heights: number[] }> = {};
      for (const [k, sv] of Object.entries(r.cellStacks as Record<string, unknown>)) {
        if (sv && typeof sv === 'object') {
          const s = sv as Record<string, unknown>;
          if (isStrArr(s.groupIds) && isNumArr(s.heights)) cs[k] = { groupIds: s.groupIds, heights: s.heights };
        }
      }
      if (Object.keys(cs).length > 0) row.cellStacks = cs;
    }
    rows.push(row);
  }

  const focusedGroupId = typeof o.focusedGroupId === 'string' ? o.focusedGroupId : null;
  return { groups, rows, rowHeights: o.rowHeights, focusedGroupId };
}

// ── persistence (ui-state, per-task key) — mirrors state/taskBrowserTabs ───────

async function uiGet<T>(key: string): Promise<T | null> {
  try {
    const r = await fetch(`/api/ui-state/${key}`); // PANE-01-ALLOWED: task-browser-layout keys, not pane state
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    return (d?.value ?? null) as T | null;
  } catch { return null; }
}

const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
function uiPutDebounced(key: string, value: unknown, ms = 800): void {
  const t = writeTimers.get(key);
  if (t) clearTimeout(t);
  writeTimers.set(key, setTimeout(() => {
    writeTimers.delete(key);
    fetch(`/api/ui-state/${key}`, { // PANE-01-ALLOWED: task-browser-layout keys, not pane state
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
    }).catch(() => {});
  }, ms));
}

const keyFor = (taskId: string) => `task-browser-layout:${taskId}`;

const cache = new Map<string, TaskLayoutState>();
const loaded = new Set<string>();
const loading = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) { try { l(); } catch { /* ignore */ } }
}

export async function ensureTaskLayoutLoaded(taskId: string): Promise<void> {
  if (!taskId || loaded.has(taskId) || loading.has(taskId)) return;
  loading.add(taskId);
  const v = await uiGet<unknown>(keyFor(taskId));
  loading.delete(taskId);
  loaded.add(taskId);
  if (!cache.has(taskId)) {
    const sanitized = sanitizeTaskLayout(v);
    if (sanitized) { cache.set(taskId, sanitized); notify(); }
  }
}

export function getTaskLayout(taskId: string): TaskLayoutState {
  return cache.get(taskId) ?? EMPTY_TASK_LAYOUT;
}

function commit(taskId: string, next: TaskLayoutState): void {
  const cur = cache.get(taskId) ?? EMPTY_TASK_LAYOUT;
  if (next === cur) return;
  cache.set(taskId, next);
  loaded.add(taskId);
  uiPutDebounced(keyFor(taskId), next);
  notify();
}

/** Forget a task's persisted layout — twin of `forgetTaskTabs`, same reason:
 *  the task was archived and the server DELETED `task-browser-layout:<id>`, so
 *  the pending debounced PUT must be cancelled before it recreates the row. */
export function forgetTaskLayout(taskId: string): void {
  if (!taskId) return;
  const key = keyFor(taskId);
  const t = writeTimers.get(key);
  if (t) { clearTimeout(t); writeTimers.delete(key); }
  loaded.delete(taskId);
  if (cache.delete(taskId)) notify();
}

/** Apply a pure reducer op to a task's layout + persist. */
export const taskBrowserLayout = {
  ensureLoaded: ensureTaskLayoutLoaded,
  get: getTaskLayout,
  set: (taskId: string, next: TaskLayoutState) => commit(taskId, next),
  activatePane: (taskId: string, groupId: string, paneId: string) => commit(taskId, activatePane(getTaskLayout(taskId), groupId, paneId)),
  reorderGroupPanes: (taskId: string, groupId: string, ids: string[]) => commit(taskId, reorderGroupPanes(getTaskLayout(taskId), groupId, ids)),
  movePaneBetweenGroups: (taskId: string, src: string, tgt: string, paneId: string, idx: number) => commit(taskId, movePaneBetweenGroups(getTaskLayout(taskId), src, tgt, paneId, idx)),
  splitGroup: (taskId: string, src: string, paneId: string, tgt: string, edge: 'left' | 'right' | 'top' | 'bottom', opts?: { fullRow?: boolean }) => commit(taskId, splitGroup(getTaskLayout(taskId), src, paneId, tgt, edge, opts)),
  reorderRows: (taskId: string, order: number[]) => commit(taskId, reorderRows(getTaskLayout(taskId), order)),
  updateRows: (taskId: string, rows: GroupLayoutRow[]) => commit(taskId, updateRows(getTaskLayout(taskId), rows)),
  updateRowHeights: (taskId: string, heights: number[]) => commit(taskId, updateRowHeights(getTaskLayout(taskId), heights)),
  focusGroup: (taskId: string, groupId: string) => commit(taskId, focusGroup(getTaskLayout(taskId), groupId)),
};

export function subscribeTaskLayout(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** React hook: the persisted (unreconciled) layout for a task, hydrated lazily.
 *  Callers reconcile it against the live pane set with `reconcileTaskLayout`. */
export function usePersistedTaskLayout(taskId: string | null): TaskLayoutState {
  useEffect(() => { if (taskId) void ensureTaskLayoutLoaded(taskId); }, [taskId]);
  return useSyncExternalStore(
    subscribeTaskLayout,
    () => (taskId ? getTaskLayout(taskId) : EMPTY_TASK_LAYOUT),
    () => EMPTY_TASK_LAYOUT,
  );
}

/** Map a task browser tab to a `Pane` for the layout engine (never enters
 *  pane-store-v2). `browser:<contextId>` is the id RemoteBrowserPanel already
 *  reports activity under. */
export function tabToPane(tab: { contextId: string; url: string; title: string; titleSource?: 'auto' | 'agent' | 'user' }): Pane {
  return {
    id: `browser:${tab.contextId}`,
    type: 'browser',
    stableKey: tab.contextId,
    url: tab.url,
    title: tab.title,
    ...(tab.titleSource ? { titleSource: tab.titleSource } : {}),
  };
}

/** The contextId behind a `browser:<contextId>` pane id. */
export function paneIdToContextId(paneId: string): string {
  return paneId.startsWith('browser:') ? paneId.slice('browser:'.length) : paneId;
}
