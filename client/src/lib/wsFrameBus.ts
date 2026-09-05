/**
 * Module-level WebSocket frame fan-out bus.
 *
 * WHY THIS EXISTS (review I4): the pane-store bootstrap runs at module load,
 * before React mounts, so it cannot call `useWebSocket()` directly. Prior to
 * this module it opened its OWN WebSocket to `/ws`, doubling the per-tab
 * connection count against the server. Now:
 *
 *   - `useWebSocket` (owned by React, one per tab) is the single connection.
 *   - After parsing each frame, it calls `dispatchFrame(frame)`.
 *   - Non-React subscribers (the pane-store's `initWSSync`) register via
 *     `subscribeFrames(handler)` and receive every frame — optionally filtered
 *     by `type` whitelist so high-frequency chat streams don't walk every
 *     subscriber's code path.
 *
 * Design notes:
 *   - Subscribers added BEFORE the hook mounts are held in `handlers` waiting;
 *     the first dispatch after `ws.onopen` fans out to them.
 *   - Handlers run in try/catch — a throw in one subscriber doesn't starve
 *     the others.
 *   - `unsubscribe()` called mid-dispatch is deferred until the dispatch loop
 *     finishes (review N2: avoids the per-frame Array.from(handlers) copy that
 *     was there to tolerate mid-iteration mutation).
 *
 * Perf profile: low-alloc (Set lookup + deferred delete), NOT zero-alloc.
 *   The hot path still performs a per-subscriber Set iteration and a
 *   `Set.has` lookup against `pendingRemove`; `Set.add`/`Set.delete` on
 *   subscribe/unsubscribe also allocate entries. Earlier PR-body phrasing
 *   ("zero-alloc dispatch") was inaccurate — what was removed was the
 *   per-dispatch `Array.from(handlers)` copy, turning an O(n) allocation
 *   per frame into a steady-state zero-copy iteration. Individual
 *   subscription lifecycle events remain allocating.
 */

type FrameHandler = (frame: unknown) => void;

interface Entry {
  handler: FrameHandler;
  /** Whitelist of frame.type strings. null = fan out every frame. */
  types: Set<string> | null;
}

const entries = new Set<Entry>();
const pendingRemove = new Set<Entry>();
// Depth counter (not a boolean) so a handler that synchronously calls
// dispatchFrame doesn't let the inner `finally` flush pendingRemove while
// the outer loop is still iterating (review N2-refine).
let dispatchDepth = 0;

export interface SubscribeOptions {
  /**
   * Only deliver frames whose `frame.type` is in this list. Narrowing here
   * means high-rate frames (chat stream tokens, ping) don't cost a function
   * call per subscriber — a single Set lookup in the dispatch loop decides
   * whether each subscriber sees the frame.
   */
  types?: readonly string[];
}

export function subscribeFrames(
  handler: FrameHandler,
  options?: SubscribeOptions,
): () => void {
  const entry: Entry = {
    handler,
    types: options?.types ? new Set(options.types) : null,
  };
  entries.add(entry);
  return () => {
    // If a handler unsubscribes itself while we're iterating (at any nesting
    // depth), defer the deletion until the outermost dispatch completes.
    // Mutating `entries` mid-iteration is legal on a Set (ES spec tolerates
    // removals) but the skipped-entry semantics are subtle — deferring is
    // both safer and easier to reason about.
    if (dispatchDepth > 0) {
      pendingRemove.add(entry);
    } else {
      entries.delete(entry);
    }
  };
}

export function dispatchFrame(frame: unknown): void {
  dispatchDepth += 1;
  try {
    // Extract `type` once per dispatch so we don't re-cast per subscriber.
    const frameType =
      frame && typeof frame === 'object' && typeof (frame as { type?: unknown }).type === 'string'
        ? (frame as { type: string }).type
        : null;
    for (const entry of entries) {
      // Skip entries scheduled for removal by a prior handler in this loop.
      if (pendingRemove.has(entry)) continue;
      // Fast-path filter: subscribers that named a whitelist and don't match
      // are skipped BEFORE the try/catch that guards user code.
      if (entry.types !== null && (frameType === null || !entry.types.has(frameType))) {
        continue;
      }
      try {
        entry.handler(frame);
      } catch {
        /* contained — one bad subscriber must not starve the others */
      }
    }
  } finally {
    dispatchDepth -= 1;
    // Only the outermost dispatch flushes pendingRemove. A re-entrant inner
    // call leaves the queue alone so the outer loop stays consistent.
    if (dispatchDepth === 0 && pendingRemove.size > 0) {
      for (const entry of pendingRemove) entries.delete(entry);
      pendingRemove.clear();
    }
  }
}

// ─── Lifecycle events (connect/disconnect) ────────────────────────────────
//
// Subscribers that need to reset per-connection state (e.g. syncWS's
// `lastAppliedServerSeq` monotonic gate) listen here. useWebSocket calls
// `dispatchLifecycle('open')` on `ws.onopen` and `dispatchLifecycle('close')`
// on `ws.onclose`. Separate from frame dispatch because frames are untyped
// payloads while lifecycle is a small fixed enum.

export type WSLifecycleEvent = 'open' | 'close';
type LifecycleHandler = (event: WSLifecycleEvent) => void;

const lifecycleHandlers = new Set<LifecycleHandler>();
/** How many times the socket has opened in this page's life. */
let opens = 0;

export function subscribeLifecycle(handler: LifecycleHandler): () => void {
  lifecycleHandlers.add(handler);
  return () => {
    lifecycleHandlers.delete(handler);
  };
}

/**
 * Only the RE-opens: an `open` that follows a previous open of this page.
 *
 * The writers that re-seed the server on reconnect (tombstoneSync,
 * projectLayoutSync) used `subscribeLifecycle('open')` and therefore also fired
 * on the FIRST connection of the page — which is not a reconnect: nothing was
 * synced through a previous socket, no `server_seq` can be stale, and the
 * re-seed only repeated the PUT of the boot (measured 2026-09-05: the same
 * project layout written twice, byte-identical, 700 ms apart). Counting the
 * opens on the bus, and not in the subscriber, is what makes this right for a
 * subscriber that registers AFTER the first open (a project window opened later
 * in the session): for it too the next open is a reconnect.
 */
export function subscribeReconnect(handler: () => void): () => void {
  return subscribeLifecycle((event) => {
    if (event === 'open' && opens > 1) handler();
  });
}

export function dispatchLifecycle(event: WSLifecycleEvent): void {
  if (event === 'open') opens += 1;
  for (const handler of lifecycleHandlers) {
    try {
      handler(event);
    } catch {
      /* contained */
    }
  }
}
