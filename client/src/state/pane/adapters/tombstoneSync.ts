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
import { subscribeFrames, subscribeLifecycle } from '../../../lib/wsFrameBus';
import { backoff } from './syncBackoff';
import {
  exportTombstones,
  importTombstones,
  setTombstoneChangeListener,
  type TombstoneEntry,
  type TombstoneKind,
} from './closedTabRecord';

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
  if (wired || typeof window === 'undefined') return;
  wired = true;
  setTombstoneChangeListener(publish);
  subscribeFrames(handleFrame, { types: ['ui-state:init', 'ui-state:updated', 'ui-state:patch'] });
  subscribeLifecycle((event) => {
    if (event !== 'open') return;
    // Server restart may reset server_seq; drop the monotonic + dedupe guards so
    // our re-seed writes through, then retry anything left unacked.
    lastAppliedSeq.clear();
    lastSyncedJson.clear();
    publish('terminal');
    publish('browser');
    for (const [uiKey, json] of [...unackedJson]) void putWithRetry(uiKey, json);
  });
  // Initial seed of the current local sets.
  publish('terminal');
  publish('browser');
}

// ─── test-only exports ────────────────────────────────────────────────────
/** Test-only: expose the un-acked set so a durability test can assert a
 *  failed PUT is retained for the next WS-reconnect retry. */
export function __getUnackedTombstoneSyncKeys(): string[] {
  return [...unackedJson.keys()];
}
/** Test-only: reset per-key sync bookkeeping between cases. Deliberately
 *  does NOT touch `wired` — re-running `initTombstoneSync()` would double
 *  register the WS frame/lifecycle subscriptions. */
export function __resetTombstoneSyncForTests(): void {
  for (const t of debounceTimers.values()) clearTimeout(t);
  debounceTimers.clear();
  unackedJson.clear();
  lastSyncedJson.clear();
  lastAppliedSeq.clear();
}
