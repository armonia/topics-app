/**
 * Adapter for project-window layout persistence.
 *
 * History: this module used to dispatch a debounced PROJECT_LAYOUT_SNAPSHOT
 * into the pane-store reducer's `state.projects[path]` so the layout could
 * sync cross-device via the pane-store-v2 server snapshot. That capture
 * was wrong-scope (it snapshotted the GLOBAL App-level pane state, not the
 * project's inner React state — see projectPersistence.ts:91-99 for the
 * footgun trail), so consumers had to silently filter out the result. The
 * dispatch + the matching `projects` field in selectSyncableSnapshot were
 * effectively dead data spamming the server with garbage.
 *
 * This adapter is now a thin localStorage wrapper. Cross-device project
 * layout sync is a TODO that needs a properly-shaped server channel
 * mirroring the project-window's inner state (panes/groups/rows).
 */
import { getTabId } from '../middleware/syncCrossTab';
import { subscribeFrames, subscribeLifecycle, subscribeReconnect } from '../../../lib/wsFrameBus';
import { backoff } from './syncBackoff';
import {
  PROJECT_PANES_PREFIX,
  projectPanesKey,
  projectLayoutKey,
} from '../../../../../shared/project-keys';

// Derivazione delle chiavi (hash di projectPath) delegata a
// shared/project-keys.ts — la stessa funzione djb2 viveva qui, in
// server/lib/relocate-pane.ts e in un test server, ognuna con un commento
// "MUST match the client's" a tenerle allineate solo a parole. Ora la parita'
// e' STRUTTURALE (una sola implementazione, importata) e verificata da
// shared/project-keys.test.ts.
export function projectPanesLocalKey(projectPath: string): string {
  return projectPanesKey(projectPath);
}
export function projectLayoutLocalKey(projectPath: string): string {
  return projectLayoutKey(projectPath);
}

// ─── Cross-device sync of project TAB IDENTITY ────────────────────────────
//
// History: inner-project tab identity used to ride the pane-store-v2 server
// snapshot via a wrong-scope PROJECT_LAYOUT_SNAPSHOT dispatch. That was ripped
// out (see this file's header), which left inner-project tabs DEVICE-LOCAL —
// the "a chat is open inside a project on mobile but not on desktop"
// divergence. We restore cross-device sync by routing the tab-identity
// (`PersistedTabState`) through the GENERIC `ui_state` channel under THIS
// project's own key (the same string used for localStorage). That reuses the
// server's existing LWW + WS broadcast + archive-purge (the purge already
// filters `openChatTopicIds`, which is exactly this record's shape).
//
// Only tab IDENTITY syncs: `{ nonChatPanes (scroll-stripped), openChatTopicIds }`.
// `activeChatTopicId` (focus) and the layout geometry (splits/rows/sidebar)
// stay device-local — syncing focus would thrash, and onServerHydrate doesn't
// consume it anyway. Echo is broken three ways: the server echoes our
// `X-Client-Id` as `sourceClientId` (skipped), a per-key monotonic `server_seq`
// gate drops stale frames, and a per-key last-synced-JSON guard skips a PUT
// (or re-apply) of a value we already hold.

const SYNC_DEBOUNCE_MS = 500;

type SyncCb = (value: unknown) => void;
const onUpdateByKey = new Map<string, SyncCb>();
const lastAppliedSeqByKey = new Map<string, number>();
const lastSyncedJsonByKey = new Map<string, string>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingValues = new Map<string, Record<string, unknown>>();
let wsWired = false;

/** Only the per-project panes/tab key rides this sync. Other `ui_state` keys
 *  (pane-store-v2, sidebar state, …) are owned by their own consumers. */
function isSyncedProjectKey(key: string): boolean {
  return key.startsWith(PROJECT_PANES_PREFIX);
}

/** The device-local-stripped value we actually sync. MUST normalise
 *  identically on the PUT side and the receive side so the last-synced-JSON
 *  echo guard holds. */
function toSyncValue(state: unknown): Record<string, unknown> | null {
  if (!state || typeof state !== 'object') return null;
  const s = state as Record<string, unknown>;
  const rawPanes = Array.isArray(s.nonChatPanes) ? (s.nonChatPanes as unknown[]) : [];
  const nonChatPanes = rawPanes.map((p) => {
    if (!p || typeof p !== 'object') return p;
    const { scrollOffset: _drop, ...rest } = p as Record<string, unknown>;
    return rest;
  });
  const openChatTopicIds = Array.isArray(s.openChatTopicIds)
    ? (s.openChatTopicIds as unknown[]).filter((id): id is string => typeof id === 'string')
    : [];
  return { nonChatPanes, openChatTopicIds };
}

function applyServerValue(
  key: string,
  value: unknown,
  serverSeq: number,
  sourceClientId: unknown,
): void {
  // Our own write echoing back — record the seq but don't re-apply.
  if (typeof sourceClientId === 'string' && sourceClientId === getTabId()) {
    lastAppliedSeqByKey.set(key, Math.max(lastAppliedSeqByKey.get(key) ?? 0, serverSeq));
    return;
  }
  if (serverSeq <= (lastAppliedSeqByKey.get(key) ?? 0)) return;
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as Record<string, unknown>).nonChatPanes)
  ) {
    return;
  }
  lastAppliedSeqByKey.set(key, serverSeq);
  // Mark as last-synced so the reconcile-triggered local save doesn't bounce an
  // identical value straight back to the server (loop-breaker).
  lastSyncedJsonByKey.set(key, JSON.stringify(toSyncValue(value)));
  onUpdateByKey.get(key)?.(value);
}

function ensureWsWired(): void {
  if (wsWired || typeof window === 'undefined') return;
  wsWired = true;
  subscribeFrames(
    (frame) => {
      const f = frame as Record<string, unknown>;
      if (f.type === 'ui-state:updated') {
        if (
          typeof f.key === 'string' &&
          isSyncedProjectKey(f.key) &&
          onUpdateByKey.has(f.key) &&
          typeof f.server_seq === 'number'
        ) {
          applyServerValue(f.key, f.value, f.server_seq, f.sourceClientId);
        }
        return;
      }
      if (f.type === 'ui-state:init') {
        const data = f.data as Record<string, unknown> | undefined;
        const meta = f.meta as Record<string, { server_seq?: number }> | undefined;
        if (!data || !meta) return;
        for (const key of onUpdateByKey.keys()) {
          const seq = meta[key]?.server_seq;
          if (key in data && typeof seq === 'number') {
            applyServerValue(key, data[key], seq, undefined);
          }
        }
        return;
      }
      if (f.type === 'ui-state:patch') {
        const entries = f.entries as Record<string, { data?: unknown; server_seq?: number }> | undefined;
        if (!entries) return;
        for (const key of onUpdateByKey.keys()) {
          const e = entries[key];
          if (e && typeof e.server_seq === 'number') {
            applyServerValue(key, e.data, e.server_seq, f.sourceClientId);
          }
        }
      }
    },
    { types: ['ui-state:init', 'ui-state:updated', 'ui-state:patch'] },
  );
  // On RE-connect the server replays ui-state:init at current seqs.
  subscribeReconnect(() => {
    // Drop the per-key monotonic gate so a server-restart (server_seq reset)
    // re-applies cleanly. ALSO drop the last-synced-JSON guard: after a server
    // DB wipe the fresh server holds no record for the key, and without
    // clearing this the next save would dedupe-skip its PUT, leaving the
    // server (and peers) showing empty tabs until the user next changes the
    // set. The server re-broadcasts our own re-seed write, which repopulates
    // both maps, so echo-suppression stays intact.
    //
    // Not on the FIRST open of the page: nothing was synced through a previous
    // socket, and clearing the guard there made the very next save re-PUT the
    // layout the boot had just written, byte-identical (measured 2026-09-05).
    lastAppliedSeqByKey.clear();
    lastSyncedJsonByKey.clear();
  });
  subscribeLifecycle((event) => {
    if (event !== 'open') return;
    // Retry any write that never got acked before the socket dropped — a PUT
    // that raced the server restart (16:23) would otherwise stay lost, leaving
    // the project channel pointed at a dead terminal id. We snapshot first
    // because putWithRetry mutates the map on success. Every open, the first
    // included: a PUT that failed while the server was coming up has no other retry.
    if (unackedJsonByKey.size > 0) {
      for (const [key, json] of [...unackedJsonByKey]) void putWithRetry(key, json);
    }
  });
}

// Retry budget for a project-channel PUT. A repoint (a terminal tab whose
// session id changed after a revive / reopen) MUST reach the server, else the
// channel keeps pointing at the dead id and its live successor is orphaned
// ("[Warn 404] Terminal session not found", tab "lost"). The old code fired
// once and swallowed failure — a PUT that raced a server restart (the exact
// 16:23 window) was lost for good. Backoff shape mirrors syncServer.ts';
// the delay itself is shared with tombstoneSync.ts via syncBackoff.ts.
const MAX_RETRIES = 3;

// Last JSON we FAILED to persist, per key. Survives across queueSync calls so a
// teardown/reconnect flush can retry the not-yet-durable value even when the
// debounce already drained pendingValues.
const unackedJsonByKey = new Map<string, string>();

/**
 * PUT `json` for `key` with bounded retry. On success commits the echo/seq
 * guards; on definitive failure leaves the value in `unackedJsonByKey` so a
 * later teardown/reconnect flush retries it. `keepalive` lets the teardown
 * path's fetch survive page unload (best-effort; beacon is the primary
 * unload channel, see flushAllPending).
 */
async function putWithRetry(key: string, json: string, keepalive = false): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`/api/ui-state/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Client-Id': getTabId() },
        body: json,
        keepalive,
      });
      if (res.ok) {
        // Commit the dedupe guard only AFTER the server accepted the write.
        // Setting it before the fetch poisoned the guard on a failed PUT:
        // every later save of the same state dedupe-skipped its PUT, so the
        // server (and peers) never converged until reload or WS reconnect.
        lastSyncedJsonByKey.set(key, json);
        unackedJsonByKey.delete(key);
        const body = (await res.json().catch(() => null)) as { server_seq?: number } | null;
        if (body && typeof body.server_seq === 'number') {
          lastAppliedSeqByKey.set(key, Math.max(lastAppliedSeqByKey.get(key) ?? 0, body.server_seq));
        }
        return;
      }
    } catch {
      /* network error — fall through to retry / give up */
    }
    if (attempt < MAX_RETRIES) await backoff(attempt);
  }
  // Exhausted: remember the value so a teardown/reconnect flush retries it.
  // localStorage already holds the same-device truth in the meantime.
  unackedJsonByKey.set(key, json);
}

function flushSync(key: string): void {
  const timer = debounceTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    debounceTimers.delete(key);
  }
  const value = pendingValues.get(key);
  pendingValues.delete(key);
  if (!value) return;
  // Fully-empty records DO publish. This used to be skipped to protect peers'
  // open tabs, but the receive side (onServerHydrate) is strictly ADDITIVE —
  // an empty record can never remove a pane a peer has open, it only stops
  // contributing tabs. Skipping the PUT was the real bug: "close every tab in
  // the project" never reached the server, so the stale record resurrected
  // all the dead panes on the next reload (GET hydrate union-adds them back).
  const json = JSON.stringify(value);
  if (json === lastSyncedJsonByKey.get(key)) return; // unchanged / echo guard
  // Track as un-acked until putWithRetry confirms it landed, so a teardown
  // flush racing the debounce still persists this value.
  unackedJsonByKey.set(key, json);
  void putWithRetry(key, json);
}

function queueSync(key: string, state: unknown): void {
  if (typeof window === 'undefined') return;
  const value = toSyncValue(state);
  if (!value) return;
  pendingValues.set(key, value);
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  debounceTimers.set(key, setTimeout(() => flushSync(key), SYNC_DEBOUNCE_MS));
  ensureTeardownFlush();
}

// ─── Teardown / reconnect durability ──────────────────────────────────────
//
// The debounced PUT above (500 ms) is not enough on its own: a window close or
// a server restart INSIDE the debounce window dropped the write, so the project
// channel kept pointing at a now-dead terminal id (the "revive → repoint lost →
// PTY orphaned, tab lost" bug). Every OTHER synced channel already flushes on
// unload (syncServer.ts, PendingActionContext); this one didn't. We add the
// same guarantee: on pagehide / tab-hide, synchronously beacon every pending
// AND every not-yet-acked value; on WS reconnect, retry the un-acked set.

/** Beacon a single value out synchronously (survives page teardown; can't read
 *  the response, so the echo/seq guards are updated optimistically — the server
 *  re-broadcasts our own write, which repopulates them). Returns true if queued. */
function beaconValue(key: string, json: string): boolean {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      // sendBeacon can't set headers — pass the client id as a query param, the
      // same fallback syncServer.ts uses. Server reads header first, then ?cid=.
      const url = `/api/ui-state/${encodeURIComponent(key)}?cid=${encodeURIComponent(getTabId())}`;
      const blob = new Blob([json], { type: 'application/json' });
      if (navigator.sendBeacon(url, blob)) {
        lastSyncedJsonByKey.set(key, json);
        return true;
      }
    }
  } catch {
    /* fall through to keepalive fetch */
  }
  // Beacon unavailable/failed — keepalive fetch is the last resort (response
  // may not be read during teardown, but the write can still land).
  void putWithRetry(key, json, true);
  return false;
}

/** Flush every pending debounce AND every un-acked value NOW, synchronously via
 *  beacon. Idempotent and cheap; safe to call from both pagehide and the
 *  tab-hide path (the dedupe guard skips values already durable). */
function flushAllPending(): void {
  // Drain the debounce buffer first (values that never hit their 500 ms timer).
  for (const [key, value] of pendingValues) {
    const timer = debounceTimers.get(key);
    if (timer) { clearTimeout(timer); debounceTimers.delete(key); }
    const json = JSON.stringify(value);
    if (json !== lastSyncedJsonByKey.get(key)) { unackedJsonByKey.set(key, json); }
  }
  pendingValues.clear();
  // Beacon out everything not yet confirmed durable.
  for (const [key, json] of unackedJsonByKey) {
    if (json === lastSyncedJsonByKey.get(key)) continue;
    beaconValue(key, json);
  }
}

let teardownWired = false;
function ensureTeardownFlush(): void {
  // Capability, non esistenza: un `window` finto e parziale (i test) passa
  // l'`undefined` check ma non sa fare addEventListener.
  if (teardownWired || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  teardownWired = true;
  // pagehide covers real navigations/close; visibilitychange(hidden) covers the
  // mobile/PWA background transition where pagehide may not fire.
  window.addEventListener('pagehide', flushAllPending);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAllPending();
  });
}

// I tre seam qui sotto sono consumati da `projectLayoutSync.durability.test.ts`,
// che però carica il modulo con `await import()` DOPO aver installato la
// finestra finta — questo file si aggancia a `window` al load. Il riferimento
// quindi non è statico e knip non lo vede: da qui `@knipignore`, uno per uno.

/** Test-only: expose the un-acked set so unit tests can assert a failed PUT is
 *  retained for a later teardown/reconnect flush.
 *  @knipignore usato via `await import()` in projectLayoutSync.durability.test.ts */
export function __getUnackedProjectSyncKeys(): string[] {
  return [...unackedJsonByKey.keys()];
}
/** Test-only: force a teardown flush (as pagehide would).
 *  @knipignore usato via `await import()` in projectLayoutSync.durability.test.ts */
export function __flushAllProjectSyncForTests(): void {
  flushAllPending();
}
/** Test-only: reset module state between cases.
 *  @knipignore usato via `await import()` in projectLayoutSync.durability.test.ts */
export function __resetProjectSyncForTests(): void {
  for (const t of debounceTimers.values()) clearTimeout(t);
  debounceTimers.clear();
  pendingValues.clear();
  unackedJsonByKey.clear();
  lastSyncedJsonByKey.clear();
  lastAppliedSeqByKey.clear();
}

/**
 * Save layout data to localStorage only (no server sync). Legacy helper —
 * preserved for callers that still write their own per-project key.
 */
export function saveProjectLayoutLocalOnly(localKey: string, state: unknown): void {
  try {
    localStorage.setItem(localKey, JSON.stringify(state));
  } catch {
    /* quota / private mode — silent */
  }
}

/**
 * Save a project layout's TAB IDENTITY. Writes `localKey` to localStorage
 * immediately (same-device cache) AND debounce-syncs the device-local-stripped
 * subset to the server under the same key, so the project's open tabs converge
 * across devices.
 *
 * Earlier this only wrote localStorage (cross-device was a TODO) after the old
 * wrong-scope PROJECT_LAYOUT_SNAPSHOT dispatch was removed. We now sync through
 * the generic `ui_state` channel — see the "Cross-device sync" block above for
 * the shape, the echo-loop guards, and why only tab identity (not focus or
 * geometry) crosses the network.
 */
export function saveProjectLayout(
  localKey: string,
  projectPath: string,
  state: unknown,
): void {
  // Suppress unused-args lint while keeping the signature for legacy callers.
  void projectPath;
  try {
    localStorage.setItem(localKey, JSON.stringify(state));
  } catch {
    /* quota / private mode — silent */
  }
  if (isSyncedProjectKey(localKey)) queueSync(localKey, state);
}

/**
 * Load the project layout.
 *
 * Returns the synchronous localStorage cache for `localKey` (the fast path that
 * seeds React state at mount). When an `onUpdate` callback is supplied AND this
 * is a synced project key, it ALSO:
 *   1. registers the callback to receive live cross-device updates (WS
 *      `ui-state:init/updated/patch` frames for this key), and
 *   2. fetches the server's latest snapshot once, forwarding it to `onUpdate`.
 *
 * `onUpdate` is the same hook `subscribeToProjectLayout` → `onServerHydrate`
 * already expected; it had simply gone dormant when server sync was removed.
 * The load hook unregisters it on unmount via `unsubscribeProjectLayout`, and
 * the downstream `onServerHydrate` is null-guarded, so a late frame is harmless.
 */
export function loadProjectLayout(
  localKey: string,
  _projectPath: string,
  onUpdate?: (freshState: unknown) => void,
): unknown | null {
  void _projectPath;

  if (onUpdate && isSyncedProjectKey(localKey)) {
    ensureWsWired();
    onUpdateByKey.set(localKey, onUpdate);
    void fetch(`/api/ui-state/${encodeURIComponent(localKey)}`)
      .then((res) => (res.ok ? res.json().catch(() => null) : null))
      .then((body: { value?: unknown; server_seq?: number } | null) => {
        // Single-key GET envelope: { value, payload_version, server_seq } | null.
        if (!body || typeof body !== 'object' || typeof body.server_seq !== 'number') return;
        applyServerValue(localKey, body.value, body.server_seq, undefined);
      })
      .catch(() => {
        /* offline — the localStorage cache below is the fallback */
      });
  }

  try {
    const raw = localStorage.getItem(localKey);
    if (raw) return JSON.parse(raw);
  } catch {
    /* corrupt entry — fall through to null */
  }
  return null;
}

/**
 * Stop receiving live cross-device updates for a project key. Called from the
 * load hook's effect cleanup (unmount / projectPath change) so the per-key
 * `onUpdate` callback — which closes over React refs — and its slot in the WS
 * init/patch fan-out don't accumulate for the life of the page. The per-key
 * seq / last-synced-JSON echo guards are intentionally KEPT (they're tiny and
 * let a remount re-apply only genuinely newer remote frames).
 */
export function unsubscribeProjectLayout(localKey: string): void {
  onUpdateByKey.delete(localKey);
}
