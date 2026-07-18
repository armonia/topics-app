/**
 * taskBrowserTabs — a task-owned, multi-tab browser group.
 *
 * A Kanban task can host several browser tabs shown INSIDE its drawer, scoped
 * to the task and invisible to the global layout. Deliberately kept OUT of the
 * pane store (`pane-store-v2`): everything in that store is a candidate for the
 * global tab bar / browserSingletonReducer / PURGE_ORPHAN_PANE / tombstones /
 * LWW eviction. Staying out means "hidden from the global layout" is free AND
 * the contextId-divergence bug class (browserSpawner / resolveTerminalBrowser…)
 * simply cannot occur for task tabs — nothing routes them through the layout.
 *
 * Persistence mirrors `boardDrafts` (lib/board.ts): the generic `ui-state`
 * store, one key PER TASK (`task-browser-tabs:<taskId>`), debounced writes,
 * LWW, survives reload + follows the user across clients. Per-task keys keep
 * edits on different tasks from clobbering each other.
 *
 * The contextId is CANONICAL: minted once at open (`task-<id8>-<seq>`), recorded
 * here, and used verbatim for navigate/close/focus/list — routing + inventory
 * are opaque-string-keyed, so one identity works end to end.
 */

import { useSyncExternalStore, useEffect } from 'react';

export interface TaskBrowserTab {
  /** Canonical browser contextId: `task-<id8>-<seq>`. */
  contextId: string;
  url: string;
  title: string;
  /** Monotonic within a task; also the `<seq>` in the contextId. */
  seq: number;
}

export interface TaskBrowserTabsState {
  tabs: TaskBrowserTab[];
  activeContextId: string | null;
  /** Next seq to mint. Kept ahead of every tab's seq so ids never collide. */
  nextSeq: number;
}

export const EMPTY_TASK_TABS: TaskBrowserTabsState = { tabs: [], activeContextId: null, nextSeq: 0 };

// ── canonical contextId ──────────────────────────────────────────────────────

/** Mint a task-scoped browser contextId. `id8` matches the sessionKey /
 *  `workspace/tasks/<id8>` truncation convention; `seq` disambiguates tabs. */
export function mintTaskContextId(taskId: string, seq: number): string {
  return `task-${taskId.slice(0, 8)}-${seq}`;
}

/** True for a task-owned browser contextId (label + routing heuristics). */
export function isTaskContextId(contextId: string): boolean {
  return typeof contextId === 'string' && contextId.startsWith('task-');
}

// ── pure reducer ops (unit-tested; no I/O) ───────────────────────────────────

/** Append a new tab with a freshly-minted ctx; it becomes active. */
export function addTab(state: TaskBrowserTabsState, taskId: string, url: string, title = ''): TaskBrowserTabsState {
  const seq = state.nextSeq;
  const contextId = mintTaskContextId(taskId, seq);
  return {
    tabs: [...state.tabs, { contextId, url, title, seq }],
    activeContextId: contextId,
    nextSeq: seq + 1,
  };
}

/** Append/reuse a tab under a contextId minted ELSEWHERE (agent/server open).
 *  Idempotent: an existing ctx is refreshed (url/title) + activated, never
 *  duplicated. `nextSeq` is advanced past any embedded seq so a later client
 *  mint can't collide. */
export function upsertTab(state: TaskBrowserTabsState, contextId: string, url: string, title = ''): TaskBrowserTabsState {
  const existing = state.tabs.find((t) => t.contextId === contextId);
  if (existing) {
    return {
      ...state,
      tabs: state.tabs.map((t) => (t.contextId === contextId ? { ...t, url: url || t.url, title: title || t.title } : t)),
      activeContextId: contextId,
    };
  }
  const seq = state.nextSeq;
  return {
    tabs: [...state.tabs, { contextId, url, title, seq }],
    activeContextId: contextId,
    nextSeq: seq + 1,
  };
}

/** Close a tab; if it was active, focus the neighbour that slides into its slot. */
export function closeTab(state: TaskBrowserTabsState, contextId: string): TaskBrowserTabsState {
  const idx = state.tabs.findIndex((t) => t.contextId === contextId);
  if (idx < 0) return state;
  const tabs = state.tabs.filter((t) => t.contextId !== contextId);
  let activeContextId = state.activeContextId;
  if (activeContextId === contextId) {
    activeContextId = tabs.length ? tabs[Math.min(idx, tabs.length - 1)].contextId : null;
  }
  return { ...state, tabs, activeContextId };
}

/** Set the active tab (no-op if the ctx isn't in the group). */
export function setActiveTab(state: TaskBrowserTabsState, contextId: string | null): TaskBrowserTabsState {
  if (contextId !== null && !state.tabs.some((t) => t.contextId === contextId)) return state;
  if (contextId === state.activeContextId) return state;
  return { ...state, activeContextId: contextId };
}

/** Move the tab at `from` to index `to` (both clamped). */
export function reorderTabs(state: TaskBrowserTabsState, from: number, to: number): TaskBrowserTabsState {
  const n = state.tabs.length;
  if (from < 0 || from >= n) return state;
  const dst = Math.max(0, Math.min(to, n - 1));
  if (dst === from) return state;
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(dst, 0, moved);
  return { ...state, tabs };
}

/** Merge a partial (url/title) into a tab, e.g. after in-pane navigation. */
export function updateTab(state: TaskBrowserTabsState, contextId: string, patch: { url?: string; title?: string }): TaskBrowserTabsState {
  const t = state.tabs.find((x) => x.contextId === contextId);
  if (!t) return state;
  if ((patch.url === undefined || patch.url === t.url) && (patch.title === undefined || patch.title === t.title)) return state;
  return {
    ...state,
    tabs: state.tabs.map((x) => (x.contextId === contextId
      ? { ...x, url: patch.url ?? x.url, title: patch.title ?? x.title }
      : x)),
  };
}

/** Coerce an untrusted ui-state payload into a valid state (or null). */
export function sanitizeTaskTabs(v: unknown): TaskBrowserTabsState | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.tabs)) return null;
  const tabs: TaskBrowserTab[] = [];
  for (const raw of o.tabs) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.contextId !== 'string' || !r.contextId) continue;
    tabs.push({
      contextId: r.contextId,
      url: typeof r.url === 'string' ? r.url : '',
      title: typeof r.title === 'string' ? r.title : '',
      seq: typeof r.seq === 'number' ? r.seq : 0,
    });
  }
  const activeContextId = typeof o.activeContextId === 'string' && tabs.some((t) => t.contextId === o.activeContextId)
    ? o.activeContextId
    : (tabs[0]?.contextId ?? null);
  const maxSeq = tabs.reduce((m, t) => Math.max(m, t.seq), -1);
  const nextSeq = typeof o.nextSeq === 'number' && o.nextSeq > maxSeq ? o.nextSeq : maxSeq + 1;
  return { tabs, activeContextId, nextSeq };
}

// ── persistence (ui-state, per-task key) — mirrors lib/board.ts boardDrafts ───

async function uiGet<T>(key: string): Promise<T | null> {
  try {
    const r = await fetch(`/api/ui-state/${key}`); // PANE-01-ALLOWED: task-browser-tabs keys, not pane state
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
    fetch(`/api/ui-state/${key}`, { // PANE-01-ALLOWED: task-browser-tabs keys, not pane state
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
    }).catch(() => {});
  }, ms));
}

const keyFor = (taskId: string) => `task-browser-tabs:${taskId}`;

// ── in-memory cache + subscription (React) ───────────────────────────────────

const cache = new Map<string, TaskBrowserTabsState>();
const loaded = new Set<string>();
const loading = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) { try { l(); } catch { /* ignore */ } }
}

/** Lazily hydrate a task's tabs from ui-state (once). Safe to call repeatedly. */
export async function ensureTaskTabsLoaded(taskId: string): Promise<void> {
  if (!taskId || loaded.has(taskId) || loading.has(taskId)) return;
  loading.add(taskId);
  const v = await uiGet<unknown>(keyFor(taskId));
  loading.delete(taskId);
  loaded.add(taskId);
  // Don't clobber writes that landed while the GET was in flight.
  if (!cache.has(taskId)) {
    const sanitized = sanitizeTaskTabs(v);
    if (sanitized) { cache.set(taskId, sanitized); notify(); }
  }
}

export function getTaskTabs(taskId: string): TaskBrowserTabsState {
  return cache.get(taskId) ?? EMPTY_TASK_TABS;
}

function commit(taskId: string, next: TaskBrowserTabsState): void {
  const cur = cache.get(taskId) ?? EMPTY_TASK_TABS;
  if (next === cur) return;
  cache.set(taskId, next);
  loaded.add(taskId);
  uiPutDebounced(keyFor(taskId), next, next.tabs.length ? 800 : 0);
  notify();
}

/** Task-bound mutators. Each applies a pure reducer op and persists. */
export const taskBrowserTabs = {
  ensureLoaded: ensureTaskTabsLoaded,
  get: getTaskTabs,
  addTab: (taskId: string, url: string, title?: string) => commit(taskId, addTab(getTaskTabs(taskId), taskId, url, title)),
  upsertTab: (taskId: string, contextId: string, url: string, title?: string) => commit(taskId, upsertTab(getTaskTabs(taskId), contextId, url, title)),
  closeTab: (taskId: string, contextId: string) => commit(taskId, closeTab(getTaskTabs(taskId), contextId)),
  setActive: (taskId: string, contextId: string | null) => commit(taskId, setActiveTab(getTaskTabs(taskId), contextId)),
  reorder: (taskId: string, from: number, to: number) => commit(taskId, reorderTabs(getTaskTabs(taskId), from, to)),
  updateTab: (taskId: string, contextId: string, patch: { url?: string; title?: string }) => commit(taskId, updateTab(getTaskTabs(taskId), contextId, patch)),
};

export function subscribeTaskTabs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** React hook: the tabs for a task, hydrated lazily, re-rendering on change. */
export function useTaskBrowserTabs(taskId: string | null): TaskBrowserTabsState {
  useEffect(() => { if (taskId) void ensureTaskTabsLoaded(taskId); }, [taskId]);
  return useSyncExternalStore(
    subscribeTaskTabs,
    () => (taskId ? getTaskTabs(taskId) : EMPTY_TASK_TABS),
    () => EMPTY_TASK_TABS,
  );
}
