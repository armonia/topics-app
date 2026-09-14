/**
 * uiStatePersist — debounced ui-state writer that stays "pending" until the
 * server has ANSWERED, shared by the per-record browser stores (task browser
 * tabs, topic browser window).
 *
 * WHY IT IS NOT JUST A DEBOUNCE. Both stores protect a local edit from inbound
 * frames while it is pending: `applyRemote` refuses to overwrite a record whose
 * write has not been persisted yet, because the un-flushed edit is newer than
 * anything the server can push. The protection used to end when the PUT LEFT
 * instead of when the server answered, which left a whole round trip in which
 * the local copy counted as safe and the server still held the old value:
 *
 *   1. the last tab is closed, so the write flushes immediately (debounce 0);
 *   2. the PUT is in flight, the timer is gone, nothing protects the record;
 *   3. a `ui-state:updated` frame from another device lands and is applied;
 *   4. our own echo arrives and is dropped as an echo (same clientId).
 *
 * Result: local holds the other device's older record, the server holds ours,
 * and the two stay apart until a reconnection resync -- and the next local
 * commit resurrects the closed tab. The same window swallowed the reconnection
 * GET, whose answer is equally stale while our PUT travels.
 *
 * So a key is pending from the moment the edit is queued to the moment its last
 * PUT settles, and `isPending` is what both stores gate their inbound paths on.
 */

import { getTabId } from './pane/middleware/syncCrossTab';

export interface UiStatePersister {
  /** Queue a debounced PUT for `key`; a newer value replaces a queued one. */
  put(key: string, value: unknown, ms?: number): void;
  /**
   * Is a local write for `key` still unresolved -- queued, in flight, or both?
   * An inbound frame or a resync answer for a pending key must be ignored: it
   * cannot know about the write that is still travelling.
   */
  isPending(key: string): boolean;
  /** Drop the QUEUED write for `key` (a PUT already in flight cannot be recalled). */
  cancel(key: string): void;
  /** Test seam: forget every queued and in-flight write. */
  cancelAll(): void;
}

export function createUiStatePersister(): UiStatePersister {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Count, not a flag: a second edit can flush while the first PUT is still in
  // flight (closing the last tab writes with no debounce at all), and the first
  // answer must not clear the protection the second write still needs.
  const inFlight = new Map<string, number>();

  const settle = (key: string): void => {
    const left = (inFlight.get(key) ?? 1) - 1;
    if (left > 0) inFlight.set(key, left);
    else inFlight.delete(key);
  };

  const send = (key: string, value: unknown): void => {
    inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    void fetch(`/api/ui-state/${key}`, { // PANE-01-ALLOWED: per-record browser keys, not pane state
      method: 'PUT',
      // X-Client-Id lets the server stamp the broadcast's `sourceClientId` so the
      // WS bridge can drop THIS client's own echo (else applyRemote would re-apply
      // our own write, or worse revert a newer local edit).
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': getTabId() },
      body: JSON.stringify(value),
    }).catch(() => {}).then(() => { settle(key); });
  };

  return {
    put(key: string, value: unknown, ms = 800): void {
      const queued = timers.get(key);
      if (queued) clearTimeout(queued);
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        send(key, value);
      }, ms));
    },
    isPending(key: string): boolean {
      return timers.has(key) || inFlight.has(key);
    },
    cancel(key: string): void {
      const queued = timers.get(key);
      if (queued) { clearTimeout(queued); timers.delete(key); }
    },
    cancelAll(): void {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      inFlight.clear();
    },
  };
}
