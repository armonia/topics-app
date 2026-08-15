/**
 * Adapter for closed-tab records.
 *
 * The reducer's `closedStack` is the source of truth. This file hosts three
 * responsibilities the reducer can't cleanly own:
 *   - `captureClosedTab` — a pure factory used at close-call sites to build a
 *     ClosedTabRecord before dispatching CLOSE_PANE.
 *   - `reopenClosedTab` — an async flow that re-issues a terminal session via
 *     /api/terminal/sessions (side-effect, must live outside Immer) and then
 *     dispatches PANE_ID_REMAP to swap every reference in-place.
 *   - `scheduleTerminalCleanup` / `cancelTerminalCleanup` — a module-level
 *     timer Map. Timers can't live in Immer state (pitfall #4).
 *
 * Everything else that used to be exported (legacy stack manipulation
 * primitives addClosedTab / pushClosedTab / popLastClosedTab / popClosedTab
 * / listClosedTabs) has been removed — external consumers use the
 * useClosedTabs hook, which talks to the reducer directly.
 */
import { usePaneStore } from '../store';
import type { Pane } from '../../../types';
import type { ClosedTerminalMeta } from '../types';
import { createPaneId, getTerminalSessionFromPaneId } from './paneConfig';

/**
 * Legacy ClosedTabRecord shape. Preserved verbatim so consumers importing the
 * type continue to compile. The reducer's new `ClosedPaneRecord` is a
 * superset; serialization/deserialization between the two happens in the
 * adapter boundary.
 */
export interface ClosedTabRecord {
  id: string;
  closedAt: number;
  pane: Pane;
  groupId: string;
  groupIndex: number;
  level: 'project' | 'app';
  projectPath?: string;
  /** Shared shape with the reducer's ClosedPaneRecord — see ClosedTerminalMeta. */
  terminal?: ClosedTerminalMeta;
  topicId?: string;
  filePath?: string;
}

// Module-level resource — see RESEARCH.md pitfall #4 (timers can't live in Immer state).
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Tombstone: terminal sessionIds the user just closed. Persisted in
// localStorage so they survive page reloads (the in-memory cleanupTimers
// don't). The project window's "auto-add active terminal sessions"
// effect consults this list and skips re-adding panes for tombstoned
// session ids. Entries auto-evict after TOMBSTONE_TTL_MS to keep the
// list bounded.
const TOMBSTONE_KEY = 'terminal-session-tombstones';
const TOMBSTONE_TTL_MS = 5 * 60 * 1000; // 5 minutes — covers the 60 s
// undo grace plus reload latency, evicts before staleness matters.

interface Tombstone { sessionId: string; ts: number }

function readTombstones(): Tombstone[] {
  try {
    const raw = localStorage.getItem(TOMBSTONE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as Tombstone[];
    const now = Date.now();
    return list.filter(t => now - t.ts < TOMBSTONE_TTL_MS);
  } catch { return []; }
}

function writeTombstones(list: Tombstone[]): void {
  try { localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(list)); }
  catch { /* quota / private mode */ }
}

export function addTerminalTombstone(sessionId: string): void {
  const list = readTombstones().filter(t => t.sessionId !== sessionId);
  list.push({ sessionId, ts: Date.now() });
  writeTombstones(list);
  notifyTombstoneChange('terminal');
}

export function clearTerminalTombstone(sessionId: string): void {
  writeTombstones(readTombstones().filter(t => t.sessionId !== sessionId));
  notifyTombstoneChange('terminal');
}

export function getTerminalTombstones(): Set<string> {
  return new Set(readTombstones().map(t => t.sessionId));
}

// Browser-context tombstones — the exact analogue of the terminal ones above,
// for browser panes closed INSIDE a project window. Project-inner panes live in
// `useProjectLayout` React state (not the pane store), and their persisted
// `nonChatPanes` snapshot is restored VERBATIM on the next mount. Terminals were
// already protected by their tombstone (the auto-add-active-session effect skips
// tombstoned ids); browsers had no equivalent, so a browser tab closed in a
// project reappeared on reload — especially when the close committed at unload
// (flushPendingActions), where the React persistence-save effect never re-runs
// to drop the pane from `nonChatPanes`. Same 5-minute TTL + localStorage store.
const BROWSER_TOMBSTONE_KEY = 'browser-context-tombstones';

interface BrowserTombstone { contextId: string; ts: number }

function readBrowserTombstones(): BrowserTombstone[] {
  try {
    const raw = localStorage.getItem(BROWSER_TOMBSTONE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as BrowserTombstone[];
    const now = Date.now();
    return list.filter(t => now - t.ts < TOMBSTONE_TTL_MS);
  } catch { return []; }
}

function writeBrowserTombstones(list: BrowserTombstone[]): void {
  try { localStorage.setItem(BROWSER_TOMBSTONE_KEY, JSON.stringify(list)); }
  catch { /* quota / private mode */ }
}

export function addBrowserTombstone(contextId: string): void {
  const list = readBrowserTombstones().filter(t => t.contextId !== contextId);
  list.push({ contextId, ts: Date.now() });
  writeBrowserTombstones(list);
  notifyTombstoneChange('browser');
}

export function clearBrowserTombstone(contextId: string): void {
  writeBrowserTombstones(readBrowserTombstones().filter(t => t.contextId !== contextId));
  notifyTombstoneChange('browser');
}

export function getBrowserTombstones(): Set<string> {
  return new Set(readBrowserTombstones().map(t => t.contextId));
}

// ─── Cross-device sync surface ────────────────────────────────────────────
//
// The tombstone maps above are DEVICE-LOCAL by default. `tombstoneSync.ts`
// mirrors them across devices through the generic `ui_state` channel so a tab
// you close on one machine stays closed on another (the same resurrection the
// single-device Fix B already blocks locally). Kept OUT of this file so the
// pure localStorage store has no dependency on the WS/sync layer — this file
// only exposes a change hook + generic import/export, and the sync module
// wires itself in via `setTombstoneChangeListener`.
//
// The sync is ADD-ONLY on the receive side (see `importTombstones`): merging
// two tombstone maps is a union, which is intrinsically clobber-safe — the
// opposite of a last-write-wins overwrite. `clearTombstone` (undo/reopen) does
// fire a publish of the shrunken local set, but a peer that already recorded
// the id will NOT drop it (import never removes); it evicts on its own 5-min
// TTL. Worst case: a tab reopened on device A stays suppressed on device B for
// ≤5 min. That bounded, non-destructive lag is the deliberate trade for never
// propagating a removal across the wire.
export type TombstoneKind = 'terminal' | 'browser';

/** One id + timestamp, field-name-agnostic — the shape crossing the wire. */
export interface TombstoneEntry { id: string; ts: number }

let tombstoneChangeListener: ((kind: TombstoneKind) => void) | null = null;

/** Registered once by `tombstoneSync.initTombstoneSync()`. */
export function setTombstoneChangeListener(
  fn: ((kind: TombstoneKind) => void) | null,
): void {
  tombstoneChangeListener = fn;
}

function notifyTombstoneChange(kind: TombstoneKind): void {
  try { tombstoneChangeListener?.(kind); } catch { /* sync layer must never break a close */ }
}

/** Current (TTL-filtered) local tombstones for a kind, normalised to `{id,ts}`. */
export function exportTombstones(kind: TombstoneKind): TombstoneEntry[] {
  return kind === 'terminal'
    ? readTombstones().map(t => ({ id: t.sessionId, ts: t.ts }))
    : readBrowserTombstones().map(t => ({ id: t.contextId, ts: t.ts }));
}

/**
 * Merge remote tombstones into the local store. UNION semantics: adds ids we
 * don't have (or bumps to a newer ts), never removes. Expired incoming entries
 * are ignored. Writes via the low-level writer so it does NOT re-fire the change
 * listener (the sync layer already guards against echo, but avoiding the
 * notification entirely keeps the write off the publish path). Returns true if
 * the local store changed.
 */
export function importTombstones(kind: TombstoneKind, incoming: TombstoneEntry[]): boolean {
  const now = Date.now();
  const fresh = incoming.filter(e => e && typeof e.id === 'string' && typeof e.ts === 'number' && now - e.ts < TOMBSTONE_TTL_MS);
  if (fresh.length === 0) return false;

  if (kind === 'terminal') {
    const byId = new Map(readTombstones().map(t => [t.sessionId, t.ts] as const));
    let changed = false;
    for (const e of fresh) {
      const prev = byId.get(e.id);
      if (prev === undefined || e.ts > prev) { byId.set(e.id, e.ts); changed = true; }
    }
    if (changed) writeTombstones([...byId].map(([sessionId, ts]) => ({ sessionId, ts })));
    return changed;
  }

  const byId = new Map(readBrowserTombstones().map(t => [t.contextId, t.ts] as const));
  let changed = false;
  for (const e of fresh) {
    const prev = byId.get(e.id);
    if (prev === undefined || e.ts > prev) { byId.set(e.id, e.ts); changed = true; }
  }
  if (changed) writeBrowserTombstones([...byId].map(([contextId, ts]) => ({ contextId, ts })));
  return changed;
}

// Wire a one-shot beforeunload listener so any pending cleanup timers
// (terminal DELETEs scheduled with a grace window) are force-flushed
// before the page unloads. Without this, a reload within the grace
// window leaks the server-side session — and the terminal-sync effect
// re-injects a phantom pane on the next load.
// `typeof window.addEventListener === 'function'` guards a partial-window test
// environment: under `bun test` (no DOM) another test file can leave a stub
// `globalThis.window` object without `addEventListener`, and module-load order
// across the combined run is filesystem-dependent (passes on macOS, threw on
// CI's Linux). The check is always true in a real browser, so behavior is
// unchanged there.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && !(window as unknown as { __termCleanupHooked?: boolean }).__termCleanupHooked) {
  (window as unknown as { __termCleanupHooked: boolean }).__termCleanupHooked = true;
  window.addEventListener('beforeunload', () => {
    for (const [id, timer] of cleanupTimers.entries()) {
      clearTimeout(timer);
      cleanupTimers.delete(id);
      // Tombstone is already in place from the close site; the actual
      // DELETE is best-effort (sendBeacon survives unload, plain fetch
      // may not). The tombstone alone is enough for client-side
      // de-dup; the server-side session can be reaped by its own
      // dormant-cleanup logic later.
    }
  });
}

/**
 * Build a ClosedTabRecord from a live pane (pre-close snapshot).
 * Pure function — mirrors captureClosedTab from the legacy module.
 *
 * ID ALIGNMENT: record.id must equal pane.id so consumers that call
 * removeClosedTab(capturedRecord.id) match the reducer's ClosedPaneRecord
 * (which is keyed on pane.id). The legacy `closed-${ts}-${n}` scheme
 * produced ids that never matched anything in the reducer, making
 * CLEAR_CLOSED_RECORD a silent no-op.
 */
export function captureClosedTab(
  pane: Pane,
  groupId: string,
  groupIndex: number,
  level: 'project' | 'app',
  opts?: {
    projectPath?: string;
    terminal?: ClosedTabRecord['terminal'];
  },
): ClosedTabRecord {
  return {
    id: pane.id,
    closedAt: Date.now(),
    pane: { ...pane },
    groupId,
    groupIndex,
    level,
    projectPath: opts?.projectPath,
    terminal: opts?.terminal,
    topicId: pane.topicId,
    filePath: pane.filePath,
  };
}

/**
 * Reopen a closed tab. Terminal panes may need a fresh session id because the
 * original server session may have died — we POST to /api/terminal/sessions
 * and then dispatch PANE_ID_REMAP so every reference to the old id (groups,
 * focused id, closedStack) swaps to the new one atomically in the reducer.
 */
export function reopenClosedTab(record: ClosedTabRecord): Promise<Pane> {
  return reopenClosedTabImpl(record);
}

async function reopenClosedTabImpl(record: ClosedTabRecord): Promise<Pane> {
  // Cancel any pending cleanup (deferred terminal DELETE).
  cancelTerminalCleanup(record.id);

  if (record.pane.type === 'terminal' && record.terminal) {
    const sessionId = getTerminalSessionFromPaneId(record.pane.id);
    if (sessionId) {
      // Undo of a close: lift the tombstone so other windows / a future
      // reload don't keep treating this session as user-deleted.
      clearTerminalTombstone(sessionId);
      try {
        const check = await fetch(`/api/terminal/sessions/${sessionId}`);
        if (check.ok) {
          return record.pane;
        }
        // Not in the live session map (404). The session may still be DORMANT:
        // a claude-code PTY parks itself dormant on exit, and the deferred
        // close-cleanup demotes a closed terminal the same way. Revive it BY ITS
        // ORIGINAL ID instead of minting a brand-new session — the server's
        // /revive reuses the id and relaunches claude with --resume.
        //
        // This is the fix for "close a project Claude Code, press Shift+Cmd+T →
        // two tabs (one full, one empty)": the project window's own
        // dormant-revive already brings the session back under `terminal:<id>`,
        // so a fresh POST here would add a SECOND pane under `terminal:<newId>`.
        // Reviving the same id lets id-dedup collapse both into one restored,
        // full pane. A session that is neither live nor dormant (revive 404)
        // falls through to a fresh POST below — che ORA riprende davvero la
        // sessione: il `claudeSessionId` qui sotto non viene più buttato dal
        // server, che lo gira a `--resume` (server/routes/terminal.ts).
        try {
          const revived = await fetch(`/api/terminal/sessions/${sessionId}/revive`, {
            method: 'POST',
          });
          // 409 = ANOTHER client (or this window's own dormant-revive) is already
          // bringing THIS id back. It is a queue, not a failure, and it must not
          // read like one: falling through to the POST below would mint a second
          // session id for a terminal that is materialising under the first —
          // the exact "two tabs, one full one empty" this branch exists to stop.
          // The pane keeps its id, and id-dedup collapses the two arrivals into
          // one restored, full pane. Today's server no longer answers 409 (the
          // loser awaits the in-flight revive, see server/routes/terminal.ts),
          // so this is the belt for an older server on the other side.
          if (revived.ok || revived.status === 409) {
            return record.pane;
          }
        } catch {
          /* revive unreachable → recreate below */
        }
      } catch {
        /* session dead, recreate below */
      }
    }

    // Idempotency key: derived from paneId + closedAt so a retry after a
    // transient 5xx doesn't spawn duplicate terminals. The server honors
    // X-Idempotency-Key via an in-memory 60 s cache in
    // server/routes/terminal.ts.
    const idempotencyKey = `${record.pane.id}:${record.closedAt}`;

    const res = await fetch('/api/terminal/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        cwd: record.terminal.cwd,
        // ClosedTerminalMeta fields are all optional (records can hydrate
        // from older snapshots that lack them) — default to a plain shell
        // rather than sending `type: undefined` to the server.
        type: record.terminal.sessionType ?? 'shell',
        name: record.terminal.name,
        skipPermissions: record.terminal.skipPermissions ?? false,
        claudeSessionId: record.terminal.claudeSessionId,
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to recreate terminal session: ${res.status}`);
    }
    const session = await res.json();

    const newId = createPaneId('terminal', session.id);
    const reopenedPane: Pane = {
      ...record.pane,
      id: newId,
      title: session.name || record.pane.title || '',
    };

    // Keep reducer state coherent: remap every reference to the old id.
    usePaneStore.getState().dispatch({
      type: 'PANE_ID_REMAP',
      payload: { from: record.pane.id, to: newId },
    });

    return reopenedPane;
  }

  return record.pane;
}

/**
 * Schedule a deferred cleanup action (used by terminal DELETE debouncing).
 * Timer lives outside Immer state per pitfall #4.
 */
export function scheduleTerminalCleanup(
  recordId: string,
  delayMs: number,
  fn: () => void,
): void {
  const existing = cleanupTimers.get(recordId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    cleanupTimers.delete(recordId);
    fn();
  }, delayMs);
  cleanupTimers.set(recordId, t);
}

export function cancelTerminalCleanup(recordId: string): void {
  const t = cleanupTimers.get(recordId);
  if (t) {
    clearTimeout(t);
    cleanupTimers.delete(recordId);
  }
}

/**
 * Pure reopen-routing selector for a pinned browser tab.
 *
 * A project-inner browser pane persists its url ONLY in the owning project's
 * layout snapshot (via the project-side updatePane), never in the global pane
 * store — so reopening it on the standalone surface comes up about:blank AND
 * out of its project. `openBrowserPane` calls this to detect that case: when
 * the closed-tab stack holds a project-level record for this exact browser
 * pane, the reopen is routed back into the owning project window (which
 * restores the url) via the `reopen-closed-tab` claim protocol instead.
 *
 * `closedTabs` is newest-first (useClosedTabs reverses the reducer stack), so
 * `.find` returns the most-recent close — correct when a browser was
 * closed/reopened repeatedly. Returns null for standalone (`level:'app'`)
 * records or a missing/pathless project record, both of which fall through to
 * the normal standalone open.
 */
export function selectProjectBrowserReopen(
  closedTabs: readonly ClosedTabRecord[],
  browserPaneId: string,
): ClosedTabRecord | null {
  return (
    closedTabs.find(
      r =>
        r.pane.id === browserPaneId &&
        r.pane.type === 'browser' &&
        r.level === 'project' &&
        !!r.projectPath,
    ) ?? null
  );
}
