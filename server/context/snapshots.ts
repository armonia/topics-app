/**
 * In-memory ring buffer of recently sent `ContextEnvelope`s.
 *
 * Captures, per topic, the last `RING_SIZE` envelopes that `streamEditResponse`
 * actually pushed to a provider. Lets the inspector show "what did the model
 * receive on the last 5 turns?" — invaluable for diagnosing "why did the
 * model forget?" or "why did it act on stale context?".
 *
 * Properties:
 *   - In-memory only. Lost on server restart. By design — keeps disk usage at 0.
 *   - Keyed by `topicId`. Each topic has its own ring; no cross-talk.
 *   - FIFO eviction past `RING_SIZE`.
 *   - `getSnapshots()` returns a defensive copy; mutating it does NOT mutate
 *     the stored ring.
 *
 * Wire-in: `streamEditResponse` calls `pushSnapshot(envelope)` immediately
 * before `provider.sendChat`. Endpoint exposed at
 * `GET /api/topics/:id/context-snapshots`.
 */

import type { ContextEnvelope } from "./envelope";

/** Default capacity per topic. */
export const RING_SIZE = 5;

const store = new Map<string, ContextEnvelope[]>();

/**
 * Append an envelope to the ring for `envelope.topicId`. Evicts the oldest
 * entry once the ring exceeds `RING_SIZE`. Pushing an envelope with an empty
 * `topicId` is a no-op — sessions without a topic shouldn't pollute storage.
 */
export function pushSnapshot(envelope: ContextEnvelope): void {
  if (!envelope.topicId) return;
  const arr = store.get(envelope.topicId) ?? [];
  arr.push(envelope);
  while (arr.length > RING_SIZE) arr.shift();
  store.set(envelope.topicId, arr);
}

/**
 * Returns a defensive copy of the ring for `topicId`, oldest first. Empty
 * array when no snapshots exist (e.g. just after server restart).
 */
export function getSnapshots(topicId: string): ContextEnvelope[] {
  const arr = store.get(topicId);
  return arr ? [...arr] : [];
}

/**
 * Clear snapshots. Pass a `topicId` to clear one topic; omit to wipe all.
 * Returns the number of envelopes actually removed.
 */
export function clearSnapshots(topicId?: string): number {
  if (topicId) {
    const arr = store.get(topicId);
    const n = arr?.length ?? 0;
    store.delete(topicId);
    return n;
  }
  let total = 0;
  for (const v of store.values()) total += v.length;
  store.clear();
  return total;
}

/**
 * Test/diagnostics helper. Returns a per-topic count of snapshots currently
 * in memory.
 */
export function snapshotCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of store.entries()) out[k] = v.length;
  return out;
}
