/**
 * Cross-device sync for browser/terminal close-tombstones.
 *
 * WHY: closing a browser/terminal tab inside a project records a localStorage
 * tombstone (see closedTabRecord.ts) so the pane isn't resurrected on the next
 * mount/hydrate. That tombstone was DEVICE-LOCAL, so the same tab closed on
 * desktop could still resurrect on mobile (the peer never learned it was
 * closed). This module mirrors the two tombstone maps across devices through
 * the generic `ui_state` LWW channel — the exact plumbing projectLayoutSync.ts
 * uses for project tab identity.
 *
 * SAFETY (why this is not the "destructive removal pass"): the receive side is
 * UNION-ONLY (closedTabRecord.importTombstones never removes). Merging two
 * tombstone maps can only ADD ids, so there is no last-write-wins overwrite and
 * no way for a stale peer to wipe another device's closes. Undo/reopen shrinks
 * the local set and re-publishes it, but peers keep the id until their own
 * 5-min TTL evicts it — a bounded, non-destructive lag, deliberately chosen
 * over propagating removals across the wire.
 *
 * Echo/staleness suppression mirrors projectLayoutSync: the server echoes our
 * `X-Client-Id` as `sourceClientId` (skipped), a per-key monotonic `server_seq`
 * gate drops stale frames, and a per-key last-synced-JSON guard skips a
 * redundant PUT (or re-apply) of a value we already hold.
 */
import { getTabId } from '../middleware/syncCrossTab';
import { subscribeFrames, subscribeLifecycle, subscribeReconnect } from '../../../lib/wsFrameBus';
import { backoff } from './syncBackoff';
import { usePaneStore, findPaneLocation } from '../store';
import {
  exportTombstones,
  importTombstones,
  setTombstoneChangeListener,
  type TombstoneEntry,
  type TombstoneKind,
} from './closedTabRecord';

// Only a close within this window drives a LIVE eviction (mirrors the tombstone
// store's own TTL). Bounds the blast radius: a stale marker can't reach across
// the wire and strip a pane that has been open for hours.
const EVICT_WINDOW_MS = 5 * 60 * 1000;

/**
 * A browser close-tombstone just merged in FROM ANOTHER DEVICE — evict the
 * matching open pane here so the close propagates LIVE (a browser tab closed on
 * the Mac disappears on the phone/web without a reload). Without this the peer
 * only stops RESURRECTING the tab on its next hydrate — an already-mounted pane
 * lingered until reload ("l'ho chiusa da app, ma sta ancora su pwa").
 *
 * Safe by two guards: (1) causal — a pane RE-OPENED after that close
 * (`openedAt > ts`, and OPEN_PANE always stamps openedAt) is authoritative and
 * kept; (2) TTL — only a close within EVICT_WINDOW_MS evicts. Browser-only:
 * terminal panes are reconciled by their own roster effect. CLOSE_PANE records
 * the durable pane-store tombstone + strips groups, so the eviction also rides
 * this device's next pane-store PUT and never resurrects.
 */
function evictRemotelyClosedBrowserPanes(entries: TombstoneEntry[]): void {
  const now = Date.now();
  const store = usePaneStore.getState();
  for (const e of entries) {
    if (now - e.ts >= EVICT_WINDOW_MS) continue;
    const paneId = `browser:${e.id}`;
    const pane = store.panes[paneId];
    if (!pane) continue;
    if (typeof pane.openedAt === 'number' && pane.openedAt > e.ts) continue; // re-opened after the close
    const loc = findPaneLocation(store, paneId);
    if (!loc) continue;
    store.dispatch({ type: 'CLOSE_PANE', payload: { id: paneId, groupId: loc.groupId, groupIndex: loc.groupIndex } });
  }
}

// ui_state keys. Distinct from the localStorage keys — these are the server-side
// KV identifiers the two devices converge on.
const UI_KEY: Record<TombstoneKind, string> = {
  terminal: 'tombstones-terminal',
  browser: 'tombstones-browser',
};
const KIND_BY_UI_KEY: Record<string, TombstoneKind> = {
  [UI_KEY.terminal]: 'terminal',
  [UI_KEY.browser]: 'browser',
};

const SYNC_DEBOUNCE_MS = 500;
const MAX_RETRIES = 3;

const lastAppliedSeq = new Map<string, number>();
const lastSyncedJson = new Map<string, string>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const unackedJson = new Map<string, string>();
// Set while we write server-received tombstones into localStorage, so the
// change listener we register doesn't bounce the merged value straight back.
let applyingRemote = false;
let wired = false;

/** Wire-shape for a tombstone key's value: a bounded list of `{id,ts}`. */
function serializeKind(kind: TombstoneKind): string {
  return JSON.stringify({ entries: exportTombstones(kind) });
}

function parseEntries(value: unknown): TombstoneEntry[] | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as { entries?: unknown }).entries;
  if (!Array.isArray(raw)) return null;
  return raw.filter(
    (e): e is TombstoneEntry =>
      !!e && typeof e === 'object' &&
      typeof (e as TombstoneEntry).id === 'string' &&
      typeof (e as TombstoneEntry).ts === 'number',
  );
}

async function putWithRetry(uiKey: string, json: string): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`/api/ui-state/${encodeURIComponent(uiKey)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Client-Id': getTabId() },
        body: json,
      });
      if (res.ok) {
        lastSyncedJson.set(uiKey, json);
        unackedJson.delete(uiKey);
        const body = (await res.json().catch(() => null)) as { server_seq?: number } | null;
        if (body && typeof body.server_seq === 'number') {
          lastAppliedSeq.set(uiKey, Math.max(lastAppliedSeq.get(uiKey) ?? 0, body.server_seq));
        }
        return;
      }
    } catch {
      /* network error — retry / give up */
    }
    if (attempt < MAX_RETRIES) await backoff(attempt);
  }
  // Definitive failure: keep the value so a reconnect flush retries it.
  unackedJson.set(uiKey, json);
}

/** Debounced publish of the current local set for `kind`. No-op mid-merge. */
function publish(kind: TombstoneKind): void {
  if (applyingRemote) return;
  const uiKey = UI_KEY[kind];
  const json = serializeKind(kind);
  if (json === lastSyncedJson.get(uiKey)) return;
  unackedJson.set(uiKey, json);
  const existing = debounceTimers.get(uiKey);
  if (existing) clearTimeout(existing);
  debounceTimers.set(uiKey, setTimeout(() => {
    debounceTimers.delete(uiKey);
    const latest = serializeKind(kind); // coalesce: send the freshest set
    if (latest === lastSyncedJson.get(uiKey)) { unackedJson.delete(uiKey); return; }
    void putWithRetry(uiKey, latest);
  }, SYNC_DEBOUNCE_MS));
}

/**
 * Teardown flush: fire any debounced-but-unsent publish SYNCHRONOUSLY before the
 * document goes away. Closing a tab then immediately reloading/navigating (well
 * inside SYNC_DEBOUNCE_MS) would otherwise drop the pending 500ms PUT and the
 * peer would never learn the tab was closed ("chiudi e ricarica subito, e il
 * peer non lo sa mai"). `keepalive` lets the PUT outlive the unloading page —
 * same durability idiom as projectChannelSync's pagehide flush.
 */
function flushPendingOnTeardown(): void {
  for (const [uiKey, timer] of [...debounceTimers]) {
    clearTimeout(timer);
    debounceTimers.delete(uiKey);
    const kind = KIND_BY_UI_KEY[uiKey];
    if (!kind) continue;
    const latest = serializeKind(kind);
    if (latest === lastSyncedJson.get(uiKey)) { unackedJson.delete(uiKey); continue; }
    try {
      void fetch(`/api/ui-state/${encodeURIComponent(uiKey)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Client-Id': getTabId() },
        body: latest,
        keepalive: true,
      }).catch(() => {});
      // Optimistically mark synced; if the keepalive PUT is dropped, the value
      // stays in unackedJson only if we DON'T clear it — but a reload re-seeds
      // from localStorage anyway, so a lost flush self-heals on next connect.
      lastSyncedJson.set(uiKey, latest);
      unackedJson.delete(uiKey);
    } catch { /* best effort during unload */ }
  }
}

function applyServerValue(uiKey: string, value: unknown, serverSeq: number, sourceClientId: unknown): void {
  // Our own write echoing back — record the seq, don't re-apply.
  if (typeof sourceClientId === 'string' && sourceClientId === getTabId()) {
    lastAppliedSeq.set(uiKey, Math.max(lastAppliedSeq.get(uiKey) ?? 0, serverSeq));
    return;
  }
  if (serverSeq <= (lastAppliedSeq.get(uiKey) ?? 0)) return;
  const kind = KIND_BY_UI_KEY[uiKey];
  if (!kind) return;
  const entries = parseEntries(value);
  if (!entries) return;
  lastAppliedSeq.set(uiKey, serverSeq);
  applyingRemote = true;
  try {
    importTombstones(kind, entries);
  } finally {
    applyingRemote = false;
  }
  // Propagate a REMOTE browser close live: evict the matching open pane here so
  // the tab actually disappears cross-device (not just "won't resurrect on next
  // hydrate"). Runs after the merge so the durable marker is already recorded.
  if (kind === 'browser') evictRemotelyClosedBrowserPanes(entries);
  // Record the merged local set so publish() doesn't bounce it back, but leave
  // it eligible to re-publish if the union added ids the peer lacked (its own
  // subsequent close/publish covers that; convergence is order-independent).
  lastSyncedJson.set(uiKey, serializeKind(kind));
}

function handleFrame(frame: unknown): void {
  const f = frame as Record<string, unknown>;
  if (f.type === 'ui-state:updated') {
    if (typeof f.key === 'string' && KIND_BY_UI_KEY[f.key] && typeof f.server_seq === 'number') {
      applyServerValue(f.key, f.value, f.server_seq, f.sourceClientId);
    }
    return;
  }
  if (f.type === 'ui-state:init') {
    const data = f.data as Record<string, unknown> | undefined;
    const meta = f.meta as Record<string, { server_seq?: number }> | undefined;
    if (!data || !meta) return;
    for (const uiKey of Object.keys(KIND_BY_UI_KEY)) {
      const seq = meta[uiKey]?.server_seq;
      if (uiKey in data && typeof seq === 'number') applyServerValue(uiKey, data[uiKey], seq, undefined);
    }
    return;
  }
  if (f.type === 'ui-state:patch') {
    const entries = f.entries as Record<string, { data?: unknown; server_seq?: number }> | undefined;
    if (!entries) return;
    for (const uiKey of Object.keys(KIND_BY_UI_KEY)) {
      const e = entries[uiKey];
      if (e && typeof e.server_seq === 'number') applyServerValue(uiKey, e.data, e.server_seq, f.sourceClientId);
    }
  }
}

/**
 * Idempotent one-time wiring. Registers the tombstone change listener, subscribes
 * to `ui_state` frames, and seeds the server with whatever this device already
 * holds locally (so tombstones written while offline propagate on connect).
 */
export function initTombstoneSync(): void {
  // Capability, non esistenza: un `window` finto e parziale (i test) passa
  // l'`undefined` check ma non sa fare addEventListener.
  if (wired || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  wired = true;
  setTombstoneChangeListener(publish);
  // pagehide fires on real unload AND on bfcache freeze; visibilitychange→hidden
  // is the reliable mobile-Safari path (pagehide can be skipped there). Both
  // flush the pending debounce so an immediate reload doesn't strand the close.
  window.addEventListener('pagehide', flushPendingOnTeardown);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingOnTeardown();
  });
  subscribeFrames(handleFrame, { types: ['ui-state:init', 'ui-state:updated', 'ui-state:patch'] });
  // A RE-connect, not the first connection of the page: a server restart may
  // have reset server_seq, so drop the monotonic + dedupe guards and re-seed.
  // On the FIRST open there is nothing stale to drop, and re-seeding only
  // repeated the boot PUT of both keys (measured 2026-09-05).
  subscribeReconnect(() => {
    lastAppliedSeq.clear();
    lastSyncedJson.clear();
    publish('terminal');
    publish('browser');
  });
  // Whatever never got acked is retried on EVERY open, the first included: a
  // PUT that failed while the server was still coming up has no other retry.
  subscribeLifecycle((event) => {
    if (event !== 'open') return;
    for (const [uiKey, json] of [...unackedJson]) void putWithRetry(uiKey, json);
  });
  // Initial seed of the current local sets.
  publish('terminal');
  publish('browser');
}

// ─── test-only exports ────────────────────────────────────────────────────
// `tombstoneSync.durability.test.ts` carica il modulo con `await import()`
// (deve prima installare la finestra finta), quindi i riferimenti a questi due
// seam non sono statici e knip non li vede: da qui `@knipignore`. Il terzo
// (`__evict…ForTests`) è importato normalmente e non ne ha bisogno.
/** Test-only: expose the un-acked set so a durability test can assert a
 *  failed PUT is retained for the next WS-reconnect retry.
 *  @knipignore usato via `await import()` in tombstoneSync.durability.test.ts */
export function __getUnackedTombstoneSyncKeys(): string[] {
  return [...unackedJson.keys()];
}
/** Test-only: the live cross-device browser-close eviction (see the function's
 *  own docstring). Exposed so a unit test can drive it against the pane store
 *  singleton without reconstructing the WS frame path. */
export function __evictRemotelyClosedBrowserPanesForTests(entries: TombstoneEntry[]): void {
  evictRemotelyClosedBrowserPanes(entries);
}
/** Test-only: reset per-key sync bookkeeping between cases. Deliberately
 *  does NOT touch `wired` — re-running `initTombstoneSync()` would double
 *  register the WS frame/lifecycle subscriptions.
 *  @knipignore usato via `await import()` in tombstoneSync.durability.test.ts */
export function __resetTombstoneSyncForTests(): void {
  for (const t of debounceTimers.values()) clearTimeout(t);
  debounceTimers.clear();
  unackedJson.clear();
  lastSyncedJson.clear();
  lastAppliedSeq.clear();
}
