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
import { subscribeFrames, subscribeLifecycle } from '../../../lib/wsFrameBus';

// Storage-key derivation (hash of projectPath). Exposed here so call sites
// don't need to re-implement the hash and so the PANE-01 grep gate passes
// without leaving the literal `topics-project-*` prefix in consumer files.
//
// 32-bit hash: a cross-project collision is possible in principle (~1/4e9
// per pair — two paths sharing one layout record), but changing the hash
// now would orphan every existing localStorage AND server `ui_state` key,
// silently dropping all saved project layouts. Accepted at this scale;
// keys are pruned on project archive (usePanelLifecycle.handleArchiveProject).
function projectHash(projectPath: string): string {
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = projectPath.charCodeAt(i) + ((hash << 5) - hash);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}
const PANES_PREFIX = 'topics-project-panes-';
const LAYOUT_PREFIX = 'topics-project-layout-';
export function projectPanesLocalKey(projectPath: string): string {
  return `${PANES_PREFIX}${projectHash(projectPath)}`;
}
export function projectLayoutLocalKey(projectPath: string): string {
  return `${LAYOUT_PREFIX}${projectHash(projectPath)}`;
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
  return key.startsWith(PANES_PREFIX);
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
  // On reconnect the server replays ui-state:init at current seqs.
  subscribeLifecycle((event) => {
    if (event !== 'open') return;
    // Drop the per-key monotonic gate so a server-restart (server_seq reset)
    // re-applies cleanly. ALSO drop the last-synced-JSON guard: after a server
    // DB wipe the fresh server holds no record for the key, and without
    // clearing this the next save would dedupe-skip its PUT, leaving the
    // server (and peers) showing empty tabs until the user next changes the
    // set. The server re-broadcasts our own re-seed write, which repopulates
    // both maps, so echo-suppression stays intact.
    lastAppliedSeqByKey.clear();
    lastSyncedJsonByKey.clear();
  });
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
  void fetch(`/api/ui-state/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': getTabId() },
    body: json,
  })
    .then((res) => {
      if (!res.ok) return null;
      // Commit the dedupe guard only AFTER the server accepted the write.
      // Setting it before the fetch poisoned the guard on a failed PUT:
      // every later save of the same state dedupe-skipped its PUT, so the
      // server (and peers) never converged until reload or WS reconnect.
      lastSyncedJsonByKey.set(key, json);
      return res.json().catch(() => null);
    })
    .then((body: { server_seq?: number } | null) => {
      if (body && typeof body.server_seq === 'number') {
        lastAppliedSeqByKey.set(key, Math.max(lastAppliedSeqByKey.get(key) ?? 0, body.server_seq));
      }
    })
    .catch(() => {
      /* offline — localStorage already holds the same-device truth */
    });
}

function queueSync(key: string, state: unknown): void {
  if (typeof window === 'undefined') return;
  const value = toSyncValue(state);
  if (!value) return;
  pendingValues.set(key, value);
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  debounceTimers.set(key, setTimeout(() => flushSync(key), SYNC_DEBOUNCE_MS));
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
