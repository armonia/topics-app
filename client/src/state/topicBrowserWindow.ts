/**
 * topicBrowserWindow — the browser window a topic owns, as pure state.
 *
 * One window per topic, in one of three modes ('min' | 'exp' | 'hidden'), with
 * the tabs opened FROM that topic. Like `taskBrowserTabs`, and for the same
 * reason, this is deliberately kept OUT of `pane-store-v2`: while a sheet lives
 * in the window it is not a candidate for the global tab bar, the browser
 * singleton reducer, orphan purges or tombstone eviction.
 *
 * THE INVARIANT, and it is the whole point of this module: a sheet lives in the
 * WINDOW or in the LAYOUT, never in both. `promoteToTab` hands a contextId over
 * to the layout (the caller does the OPEN_PANE with the SAME contextId, so the
 * page, its history and the agent driving it survive); `returnFromTab` takes it
 * back. Between the two the contextId sits in `promoted`, and `open` on a
 * promoted contextId does NOT re-add a sheet — the layout tab owns it and the
 * caller navigates that instead. Two live representations of the same thing is
 * the lesson already paid for by the task strip.
 *
 * Persistence mirrors `taskBrowserTabs`: the generic `ui-state` store, one key
 * per topic (`topic-browser:<topicId>`), debounced writes, LWW, `X-Client-Id`
 * so a client drops its own echo, and — the part a store must never skip — the
 * INBOUND application of `ui-state:updated` / `ui-state:init` (a store that
 * writes and never re-reads is bug 78926d14).
 *
 * The minimized position is anchored to the RIGHT and BOTTOM edges, not to left
 * and top: when the app window narrows, the little window keeps its corner
 * instead of walking off screen (`resolveMinRect`).
 */

import { getTabId } from './pane/middleware/syncCrossTab';
import { topicBrowserKeyFor as keyFor, topicIdFromKey } from './topicBrowserKey';
import { createUiStatePersister } from './uiStatePersist';

/** Who opened a sheet. Kept because the window treats them differently later
 *  (an agent-opened sheet must never reshape the layout on its own). */
export type TopicBrowserOpenedBy = 'user' | 'agent' | 'link';

/** 'min' floats over the topic area, 'exp' is docked to its right edge,
 *  'hidden' is closed with the sheets kept. */
export type TopicBrowserMode = 'min' | 'exp' | 'hidden';

/** Distance from the RIGHT and BOTTOM edges of the topic area, in px. */
export interface TopicBrowserPosition {
  right: number;
  bottom: number;
}

export interface TopicBrowserSheet {
  contextId: string;
  url: string;
  title: string;
  openedBy: TopicBrowserOpenedBy;
}

export interface TopicBrowserWindowState {
  mode: TopicBrowserMode;
  /** null = the default corner. */
  minPos: TopicBrowserPosition | null;
  /** px; null = the default width. Spelled out (the design calls it `expWidth`)
   *  because `exp` is not an English word and `check:identifier-language` reads
   *  identifiers, not the design. The MODE literal 'exp' is data, so it stays. */
  expandedWidth: number | null;
  tabs: TopicBrowserSheet[];
  activeContextId: string | null;
  /** Sheets currently living in the LAYOUT as panes. Not in `tabs`: that is the
   *  invariant, and it is stored because it has to survive a reload. */
  promoted: string[];
}

export const EMPTY_TOPIC_BROWSER_WINDOW: TopicBrowserWindowState = {
  mode: 'hidden',
  minPos: null,
  expandedWidth: null,
  tabs: [],
  activeContextId: null,
  promoted: [],
};

/** Default size of the minimized window, and the bounds of the expanded one.
 *  They live here because the position/width reducers clamp against them. */
export const MIN_WINDOW_SIZE = { width: 420, height: 320 } as const;
export const EXPANDED_WIDTH_BOUNDS = { min: 360, max: 1200 } as const;

// ── pure reducer ops (unit-tested; no I/O) ───────────────────────────────────

const hasSheet = (state: TopicBrowserWindowState, contextId: string): boolean =>
  state.tabs.some((t) => t.contextId === contextId);

/** The mode an open/return lands in: a hidden window comes back minimized, an
 *  already visible one keeps the mode it is in. */
function wake(mode: TopicBrowserMode, wanted?: TopicBrowserMode): TopicBrowserMode {
  if (wanted) return wanted;
  return mode === 'hidden' ? 'min' : mode;
}

/** Active contextId after `contextId` leaves the window: the neighbor that
 *  slides into its slot, or null when no sheet is left. */
function nextActive(state: TopicBrowserWindowState, contextId: string): string | null {
  const idx = state.tabs.findIndex((t) => t.contextId === contextId);
  const rest = state.tabs.filter((t) => t.contextId !== contextId);
  if (!rest.length) return null;
  return rest[Math.min(Math.max(idx, 0), rest.length - 1)].contextId;
}

/**
 * Open (or refresh) a sheet in the window; it becomes active and the window
 * wakes up.
 *
 * A contextId that is currently PROMOTED is refused: that page is a pane in the
 * layout and putting a sheet next to it would be the same page twice. The
 * caller navigates the existing tab instead.
 */
export function open(
  state: TopicBrowserWindowState,
  sheet: { contextId: string; url?: string; title?: string; openedBy?: TopicBrowserOpenedBy },
  mode?: TopicBrowserMode,
): TopicBrowserWindowState {
  const { contextId } = sheet;
  if (!contextId) return state;
  if (state.promoted.includes(contextId)) return state;
  const url = sheet.url ?? '';
  const title = sheet.title ?? '';
  if (hasSheet(state, contextId)) {
    return {
      ...state,
      mode: wake(state.mode, mode),
      tabs: state.tabs.map((t) => (t.contextId === contextId
        ? { ...t, url: url || t.url, title: title || t.title }
        : t)),
      activeContextId: contextId,
    };
  }
  return {
    ...state,
    mode: wake(state.mode, mode),
    tabs: [...state.tabs, { contextId, url, title, openedBy: sheet.openedBy ?? 'user' }],
    activeContextId: contextId,
  };
}

/** Focus a sheet of the window. No-op for anything that is not one. */
export function activate(state: TopicBrowserWindowState, contextId: string): TopicBrowserWindowState {
  if (!hasSheet(state, contextId) || state.activeContextId === contextId) return state;
  return { ...state, activeContextId: contextId };
}

/** Close a sheet. The last one closing leaves the window 'hidden' and empty. */
export function close(state: TopicBrowserWindowState, contextId: string): TopicBrowserWindowState {
  if (!hasSheet(state, contextId)) return state;
  const tabs = state.tabs.filter((t) => t.contextId !== contextId);
  const activeContextId = state.activeContextId === contextId
    ? nextActive(state, contextId)
    : state.activeContextId;
  return { ...state, tabs, activeContextId, mode: tabs.length ? state.mode : 'hidden' };
}

/**
 * Change the mode. A window with NO sheets stays 'hidden' whatever is asked:
 * there is nothing to show, and `close` already lands there when the last sheet
 * goes.
 *
 * The rule is here and not only in `sanitize` because the two have to agree.
 * While they did not, `setMode(state, 'min')` on an empty window produced
 * `{mode:'min', tabs:[]}`, a state that does not survive its own round trip:
 * the PUT went out, the record came back from the server rewritten 'hidden',
 * and `applyRemote` (which compares the serialized values) adopted it. So an
 * open window closed itself at every reconnection, and the other devices got it
 * already closed. Reachable states must be fixpoints of `sanitize`.
 */
export function setMode(state: TopicBrowserWindowState, mode: TopicBrowserMode): TopicBrowserWindowState {
  const next: TopicBrowserMode = state.tabs.length ? mode : 'hidden';
  if (state.mode === next) return state;
  return { ...state, mode: next };
}

/** Move the minimized window. The position is an ANCHOR to the bottom-right
 *  corner, clamped to non-negative so it cannot be dragged out of the area. */
export function move(state: TopicBrowserWindowState, pos: TopicBrowserPosition): TopicBrowserWindowState {
  const right = Math.max(0, Math.round(pos.right));
  const bottom = Math.max(0, Math.round(pos.bottom));
  if (state.minPos && state.minPos.right === right && state.minPos.bottom === bottom) return state;
  return { ...state, minPos: { right, bottom } };
}

/** Width of the expanded window, clamped; null restores the default. */
export function setWidth(state: TopicBrowserWindowState, width: number | null): TopicBrowserWindowState {
  const next = width === null
    ? null
    : Math.round(Math.max(EXPANDED_WIDTH_BOUNDS.min, Math.min(EXPANDED_WIDTH_BOUNDS.max, width)));
  if (next === state.expandedWidth) return state;
  return { ...state, expandedWidth: next };
}

/** Hand a sheet to the layout: it leaves `tabs` and enters `promoted`. The
 *  caller does the OPEN_PANE with the SAME contextId, so nothing reloads. */
export function promoteToTab(state: TopicBrowserWindowState, contextId: string): TopicBrowserWindowState {
  if (!hasSheet(state, contextId)) return state;
  const gone = close(state, contextId);
  return { ...gone, promoted: [...state.promoted, contextId] };
}

/** Take a promoted sheet back from the layout: it leaves `promoted`, returns as
 *  the ACTIVE sheet, and the window wakes up. The caller closes the pane
 *  WITHOUT destroying the context, so the page is the same one. */
export function returnFromTab(
  state: TopicBrowserWindowState,
  sheet: { contextId: string; url?: string; title?: string; openedBy?: TopicBrowserOpenedBy },
): TopicBrowserWindowState {
  const { contextId } = sheet;
  if (!contextId || !state.promoted.includes(contextId)) return state;
  const released: TopicBrowserWindowState = {
    ...state,
    promoted: state.promoted.filter((id) => id !== contextId),
  };
  return open(released, sheet);
}

/** Where the minimized window really sits, given the size of the topic area.
 *  Anchored to the bottom-right: a narrower area moves `left`, never the
 *  distance from the corner, which is why the window survives a resize. */
export function resolveMinRect(
  state: TopicBrowserWindowState,
  area: { width: number; height: number },
  size: { width: number; height: number } = MIN_WINDOW_SIZE,
): { left: number; top: number; width: number; height: number } {
  const pos = state.minPos ?? { right: 24, bottom: 24 };
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  const right = Math.min(pos.right, Math.max(0, area.width - width));
  const bottom = Math.min(pos.bottom, Math.max(0, area.height - height));
  return { left: area.width - right - width, top: area.height - bottom - height, width, height };
}

/** Coerce an untrusted ui-state payload into a valid state (or null). */
export function sanitizeTopicBrowserWindow(v: unknown): TopicBrowserWindowState | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.tabs)) return null;
  const seen = new Set<string>();
  const tabs: TopicBrowserSheet[] = [];
  for (const raw of o.tabs) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.contextId !== 'string' || !r.contextId || seen.has(r.contextId)) continue;
    seen.add(r.contextId);
    tabs.push({
      contextId: r.contextId,
      url: typeof r.url === 'string' ? r.url : '',
      title: typeof r.title === 'string' ? r.title : '',
      openedBy: r.openedBy === 'agent' || r.openedBy === 'link' ? r.openedBy : 'user',
    });
  }
  // The invariant holds across the wire too: a persisted record claiming a
  // contextId both in `tabs` and in `promoted` keeps the WINDOW copy, because
  // the layout's own record (`pane-store-v2`) is the one that decides whether a
  // pane really exists, and a sheet nobody can see is the worse of the two.
  const promoted: string[] = Array.isArray(o.promoted)
    ? [...new Set(o.promoted.filter((id): id is string => typeof id === 'string' && !!id && !seen.has(id)))]
    : [];
  const activeContextId = typeof o.activeContextId === 'string' && seen.has(o.activeContextId)
    ? o.activeContextId
    : (tabs[0]?.contextId ?? null);
  const mode: TopicBrowserMode = o.mode === 'min' || o.mode === 'exp' ? (tabs.length ? o.mode : 'hidden') : 'hidden';
  const minPos = o.minPos && typeof o.minPos === 'object'
    ? (() => {
        const p = o.minPos as Record<string, unknown>;
        if (typeof p.right !== 'number' || typeof p.bottom !== 'number') return null;
        if (!Number.isFinite(p.right) || !Number.isFinite(p.bottom)) return null;
        return { right: Math.max(0, Math.round(p.right)), bottom: Math.max(0, Math.round(p.bottom)) };
      })()
    : null;
  const expandedWidth = typeof o.expandedWidth === 'number' && Number.isFinite(o.expandedWidth)
    ? Math.round(Math.max(EXPANDED_WIDTH_BOUNDS.min, Math.min(EXPANDED_WIDTH_BOUNDS.max, o.expandedWidth)))
    : null;
  return { mode, minPos, expandedWidth, tabs, activeContextId, promoted };
}

// ── persistence (ui-state, per-topic key) — mirrors taskBrowserTabs ───────────

// The key (and `topicIdFromKey`) live in `topicBrowserKey.ts`: the WS bridge
// needs them without loading this module.

/**
 * Read one row. Two different "nothing"s, kept apart on purpose:
 *   - `null`: the server answered and holds NO row for the key (it answers a
 *     missing row with a literal `null` body): the window was deleted, e.g. its
 *     topic was archived.
 *   - `undefined`: the read FAILED (network down, an error status, a body
 *     that does not parse). Nothing is known, so nothing may be dropped on
 *     its account.
 */
async function uiGet<T>(key: string): Promise<T | null | undefined> {
  try {
    const r = await fetch(`/api/ui-state/${key}`); // PANE-01-ALLOWED: topic-browser keys, not pane state
    if (!r.ok) return undefined;
    const d = await r.json().catch(() => undefined);
    if (d === undefined) return undefined;
    return (d?.value ?? null) as T | null;
  } catch { return undefined; }
}

// Writes stay PENDING until the server answers, and a frame that arrives while
// our PUT travels is HELD until that answer says which of the two is newer (see
// `uiStatePersist`); `onDeferredFrame` is where a held frame that won lands.
const writes = createUiStatePersister({
  onDeferredFrame: (key, value) => {
    const topicId = topicIdFromKey(key);
    if (topicId && adopt(topicId, value)) notify();
  },
});
const hasPendingWrite = (topicId: string) => writes.isPending(keyFor(topicId));

// ── in-memory cache + subscription (React) ───────────────────────────────────

const cache = new Map<string, TopicBrowserWindowState>();
const loaded = new Set<string>();
const loading = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) { try { l(); } catch { /* ignore */ } }
}

/** Lazily hydrate a topic's window from ui-state (once). Safe to call often. */
export async function ensureTopicWindowLoaded(topicId: string): Promise<void> {
  if (!topicId || loaded.has(topicId) || loading.has(topicId)) return;
  loading.add(topicId);
  const v = await uiGet<unknown>(keyFor(topicId));
  loading.delete(topicId);
  loaded.add(topicId);
  // Don't clobber writes that landed while the GET was in flight.
  if (!cache.has(topicId)) {
    const sanitized = sanitizeTopicBrowserWindow(v);
    if (sanitized) { cache.set(topicId, sanitized); notify(); }
  }
}

export function getTopicWindow(topicId: string): TopicBrowserWindowState {
  return cache.get(topicId) ?? EMPTY_TOPIC_BROWSER_WINDOW;
}

function commit(topicId: string, next: TopicBrowserWindowState): void {
  const cur = getTopicWindow(topicId);
  if (next === cur) return;
  cache.set(topicId, next);
  loaded.add(topicId);
  writes.put(keyFor(topicId), next, next.tabs.length || next.promoted.length ? 800 : 0);
  notify();
}

/** Write a server-side value into the cache, no questions asked and no PUT echo.
 *  Returns true when the cache changed. Whether the value is allowed to win is
 *  decided by the callers below. */
function adopt(topicId: string, value: unknown): boolean {
  if (!topicId) return false;
  const sanitized = sanitizeTopicBrowserWindow(value);
  if (!sanitized) return false;
  loaded.add(topicId);
  const cur = cache.get(topicId);
  if (cur && JSON.stringify(cur) === JSON.stringify(sanitized)) return false;
  cache.set(topicId, sanitized);
  return true;
}

/** Apply a server-pushed value for ONE topic. A queued local edit wins (it is
 *  newer than anything the server can know about); a value that arrives while
 *  our own PUT is in flight is held by the persister and re-offered when the
 *  answer says whose write came last. */
function applyRemote(topicId: string, value: unknown, seq?: number | null): boolean {
  if (!topicId) return false;
  if (writes.admitFrame(keyFor(topicId), value, seq) !== 'apply') return false;
  return adopt(topicId, value);
}

/** Live-apply one remote `ui-state:updated` for a topic-browser key. The WS
 *  bridge drops this client's own echo (by sourceClientId) before calling, so a
 *  close/promote/move on ANOTHER device updates this one in real time. */
export function applyRemoteTopicWindow(topicId: string, value: unknown, seq?: number | null): void {
  if (applyRemote(topicId, value, seq)) notify();
}

/**
 * Apply a raw `ui-state:updated` frame. Returns true when the frame was FOR a
 * topic window (so the caller can stop routing it).
 *
 * The echo rule lives here, next to the PUT that stamps `X-Client-Id`, instead
 * of in the WS hook: a broadcast carrying OUR OWN clientId is the server
 * repeating what we just wrote, and applying it would re-apply a stale value
 * over a newer local edit.
 */
export function applyTopicWindowFrame(frame: { key: string; value: unknown; sourceClientId?: string; server_seq?: number }): boolean {
  const topicId = topicIdFromKey(frame.key);
  if (!topicId) return false;
  if (frame.sourceClientId && frame.sourceClientId === getTabId()) return true;
  applyRemoteTopicWindow(topicId, frame.value, frame.server_seq);
  return true;
}

/** Live-apply the bulk `ui-state:init` snapshot on (re)connect: every
 *  topic-browser key in `data`, coalesced into one notify. Returns the topic
 *  ids it realigned, so a targeted resync can skip them. */
export function applyRemoteTopicWindowInit(data: Record<string, unknown>): Set<string> {
  const applied = new Set<string>();
  let changed = false;
  for (const [key, value] of Object.entries(data)) {
    const topicId = topicIdFromKey(key);
    if (!topicId) continue;
    applied.add(topicId);
    if (applyRemote(topicId, value)) changed = true;
  }
  if (changed) notify();
  return applied;
}

/** Reconnect resync, targeted: re-GET only the topics this client has in cache
 *  and that the snapshot did not already carry. Keys with a queued write stay
 *  out (`applyRemote` protects them anyway).
 *
 *  A row the server no longer has is a DELETION, not a no-op: a client that was
 *  offline while the topic got archived never saw the `topic:archived` frame,
 *  and skipping the `null` left its stale window in cache for good (unarchiving
 *  the topic later does not forget it, and must not). A write queued in the
 *  meantime still wins, exactly as it does over a value; a read that FAILED
 *  (`undefined`) changes nothing. */
export async function reloadTopicWindowsFromServer(snapshot?: Record<string, unknown>): Promise<void> {
  const alreadyApplied = snapshot ? applyRemoteTopicWindowInit(snapshot) : new Set<string>();
  const ids = [...loaded].filter((id) => !alreadyApplied.has(id) && !hasPendingWrite(id));
  if (!ids.length) return;
  // The write generation is taken BEFORE the GET leaves: `Promise.all` waits for
  // the slowest answer, and a close committed in between would be resurrected by
  // a read that was issued before it existed.
  const tokens = ids.map((id) => writes.writeToken(keyFor(id)));
  const values = await Promise.all(ids.map((id) => uiGet<unknown>(keyFor(id))));
  let changed = false;
  ids.forEach((id, i) => {
    const value = values[i];
    if (value === undefined) return;
    if (writes.wroteSince(keyFor(id), tokens[i]!) || hasPendingWrite(id)) return;
    if (value === null) {
      if (cache.delete(id)) changed = true;
      return;
    }
    if (adopt(id, value)) changed = true;
  });
  if (changed) notify();
}

/**
 * Forget everything this client remembers about a topic's window. Called on
 * `topic:archived` with `archived: true` (useTaskBrowserTabsSync; the same frame
 * with `archived: false` deletes nothing), because archiving a topic deletes
 * its ui-state row server-side: `purgeTopicBrowserState`, reached through the
 * purge step of `archiveTopicFully`.
 *
 * The pending write timer goes FIRST: that debounced PUT is the only thing left
 * on this machine that can resurrect a key the server has just dropped.
 */
export function forgetTopicWindow(topicId: string): void {
  if (!topicId) return;
  writes.cancel(keyFor(topicId));
  loaded.delete(topicId);
  if (cache.delete(topicId)) notify();
}

/**
 * Test seam: forget EVERY topic.
 *
 * `cache`, `loaded` and the write timers are module singletons, and under
 * `bun test` every file runs in the SAME process: a file that opens a window
 * leaves its residue to whoever comes next.
 */
export function __resetTopicWindows(): void {
  writes.cancelAll();
  cache.clear();
  loaded.clear();
  loading.clear();
}

/** Topic-bound mutators. Each applies a pure reducer op and persists. */
export const topicBrowserWindow = {
  ensureLoaded: ensureTopicWindowLoaded,
  get: getTopicWindow,
  open: (topicId: string, sheet: { contextId: string; url?: string; title?: string; openedBy?: TopicBrowserOpenedBy }, mode?: TopicBrowserMode) =>
    commit(topicId, open(getTopicWindow(topicId), sheet, mode)),
  activate: (topicId: string, contextId: string) => commit(topicId, activate(getTopicWindow(topicId), contextId)),
  close: (topicId: string, contextId: string) => commit(topicId, close(getTopicWindow(topicId), contextId)),
  setMode: (topicId: string, mode: TopicBrowserMode) => commit(topicId, setMode(getTopicWindow(topicId), mode)),
  move: (topicId: string, pos: TopicBrowserPosition) => commit(topicId, move(getTopicWindow(topicId), pos)),
  setWidth: (topicId: string, width: number | null) => commit(topicId, setWidth(getTopicWindow(topicId), width)),
  promoteToTab: (topicId: string, contextId: string) => commit(topicId, promoteToTab(getTopicWindow(topicId), contextId)),
  returnFromTab: (topicId: string, sheet: { contextId: string; url?: string; title?: string; openedBy?: TopicBrowserOpenedBy }) =>
    commit(topicId, returnFromTab(getTopicWindow(topicId), sheet)),
};

export function subscribeTopicWindows(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
