/**
 * Cross-tab sync within the same browser, via the `storage` event and an
 * optional BroadcastChannel fast path.
 *
 * The HTML spec says same-origin `storage` events fire on OTHER tabs only,
 * not on the writer — so that channel is naturally self-loop-free. But:
 *   - some browsers / extensions replay the event on the writer;
 *   - BroadcastChannel fan-out (bug #4) does NOT have the HTML-spec
 *     same-tab exclusion and WILL echo to the sender.
 *
 * Defence (bug #4): every outbound payload carries a per-tab `senderId`
 * (random UUID allocated once at middleware init). The receiver drops frames
 * whose `senderId` matches this tab — no self-apply, no lastSeq bump loop.
 *
 * LWW is still enforced by the incoming snapshot's `lastSeq` — if it's not
 * strictly greater than the local `lastSeq`, we drop the frame.
 */
import { usePaneStore } from '../store';
import { PANE_STORE_LOCAL_KEY } from './persistLocal';

let started = false;

/**
 * Random identifier for THIS tab's middleware instance. Allocated once at
 * `initCrossTabSync()` and embedded in every cross-tab payload so the same
 * tab can recognise and drop its own broadcasts (BroadcastChannel fan-out,
 * extension-synthesised storage events, etc.).
 *
 * Initialised lazily in `initCrossTabSync()` to avoid touching `crypto` at
 * module load in SSR / Node test environments without webcrypto.
 */
let tabId = '';

function makeTabId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* fall through */ }
  // Fallback — good enough for self-identification within a single browser.
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function applyIncomingSnapshot(incoming: unknown): void {
  if (!incoming || typeof incoming !== 'object') return;
  // Narrow only the fields we gate on; the rest of the shape is validated by
  // sanitizeSnapshot inside the reducer. `as any` is confined to the dispatch
  // payload — matches the parsed-JSON shape of the original implementation.
  const snap = incoming as { senderId?: unknown; lastSeq?: unknown };
  // Bug #4: self-originated frame — drop. Matches storage + BroadcastChannel.
  if (typeof snap.senderId === 'string' && snap.senderId === tabId) return;
  if (typeof snap.lastSeq !== 'number') return;
  const incomingSeq: number = snap.lastSeq;
  const currentSeq = usePaneStore.getState().lastSeq;
  if (incomingSeq <= currentSeq) return; // stale or equal — ignore
  // HYDRATE_FROM_SNAPSHOT runs the sanitizer (B3) so device-local fields
  // from the originating tab's localStorage can't leak in here either.
  // `senderId` is not part of the store shape; the sanitizer drops it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payloadSnapshot = { ...(incoming as Record<string, unknown>), seq: incomingSeq } as any;
  usePaneStore.getState().dispatch({
    type: 'HYDRATE_FROM_SNAPSHOT',
    payload: { snapshot: payloadSnapshot },
  });
}

export function initCrossTabSync(): void {
  if (started) return;
  if (typeof window === 'undefined') return;
  started = true;

  if (!tabId) tabId = makeTabId();

  window.addEventListener('storage', (e) => {
    // I2/I7: validate storageArea. Real same-origin cross-tab events populate
    // `storageArea` with the writer's `window.localStorage`. Extensions and
    // `dispatchEvent(new StorageEvent(...))` can synthesize events with
    // `storageArea === null` — we drop those too so a malicious extension
    // can't seed the reducer.
    if (e.storageArea !== window.localStorage) return;
    if (e.key !== PANE_STORE_LOCAL_KEY || !e.newValue) return;
    try {
      const incoming = JSON.parse(e.newValue);
      applyIncomingSnapshot(incoming);
    } catch {
      // Malformed JSON — ignore silently; the originating tab will retry.
    }
  });
}

/**
 * Returns the per-tab identifier allocated by `initCrossTabSync()`. Called by
 * `persistLocal.ts` when it writes a snapshot to localStorage, so the payload
 * carries the `senderId` field the receiver uses for self-suppression.
 *
 * Allocates on first call if the middleware hasn't booted yet (SSR-safe —
 * only touches `crypto` at call time, not at module load).
 */
export function getTabId(): string {
  if (!tabId) tabId = makeTabId();
  return tabId;
}

/** Test-only: reset the tabId so each test starts fresh. */
export function __resetTabIdForTests(): void {
  tabId = '';
  started = false;
}
