/**
 * Shared registry of `server_seq` values that this client just wrote via its
 * own PUT /api/ui-state/pane-store-v2. The server broadcasts every write as a
 * `ui-state:updated` WS frame (and re-announces the bulk state on fresh
 * connections via `ui-state:init`) — without this filter, the client would
 * dispatch HYDRATE_FROM_SNAPSHOT against an echo of its own outbound write,
 * producing flicker and, worse, overwriting a still-unsent newer local edit
 * (500 ms GET fallback vs in-flight PUT race, blocker B2 in the PR review).
 *
 * Flow:
 *   1. syncServer.ts PUTs a snapshot → response returns `{ server_seq }`.
 *   2. syncServer calls `rememberLocalAck(server_seq)` immediately on 2xx.
 *   3. syncWS.ts checks `isSelfEcho(server_seq)` before applying a frame —
 *      hits are dropped (they are this client's own write round-tripping).
 *
 * Entries auto-expire after TTL_MS so a long-lived tab doesn't leak.
 *
 * Two-level defence (bug #3):
 *   - Level 1 — short-TTL Map of ack entries (VITE_SELFECHO_TTL_MS, 10s default).
 *     One-shot: a matching `isSelfEcho()` call consumes the entry so duplicate
 *     seqs don't keep filtering.
 *   - Level 2 — `lastEmittedServerSeq`: high-water mark of every seq this tab
 *     has ever recorded as self-ack, WITHOUT TTL expiry. Even if a WS broadcast
 *     is delayed beyond the Map TTL (WAL checkpoint, GC pause), a frame with
 *     `server_seq <= lastEmittedServerSeq` is still classified as self-echo.
 *     Prevents: TTL expires → stale HYDRATE applies own snapshot → reducer bumps
 *     `lastSeq` → next PUT collides on seq.
 */

/**
 * Self-echo ack window. A slow server (WAL checkpoint, GC pause) may take
 * longer than the default 10 s to broadcast the echo frame — override via
 * VITE_SELFECHO_TTL_MS if needed. This is ONLY the Map-entry TTL; the
 * `lastEmittedServerSeq` high-water mark has no TTL.
 */
const DEFAULT_TTL_MS = 10_000;
const envRaw = Number(import.meta.env.VITE_SELFECHO_TTL_MS);
const TTL_MS = Number.isFinite(envRaw) && envRaw > 0 ? envRaw : DEFAULT_TTL_MS;

/** Map of server_seq → timestamp (ms). Older entries are pruned lazily. */
const acks = new Map<number, number>();

/**
 * High-water mark of the largest `server_seq` this tab has ever registered as
 * its own ack. Unlike `acks`, this value NEVER expires — it is the
 * tie-breaker that keeps a late broadcast (past TTL) from being misread as a
 * remote frame. Safe because server seqs are monotonic per origin.
 */
let lastEmittedServerSeq = 0;

function gc(now: number): void {
  for (const [seq, ts] of acks) {
    if (now - ts > TTL_MS) acks.delete(seq);
  }
}

/** Record that this client just successfully PUT a snapshot with this seq. */
export function rememberLocalAck(server_seq: number): void {
  if (typeof server_seq !== 'number' || !Number.isFinite(server_seq)) return;
  const now = Date.now();
  acks.set(server_seq, now);
  if (server_seq > lastEmittedServerSeq) lastEmittedServerSeq = server_seq;
  gc(now);
}

/**
 * Return true if `server_seq` matches a recent local PUT ack, OR if it is
 * `<=` the high-water mark of seqs this tab has already emitted as its own
 * ack (TTL-free second level — see bug #3).
 *
 * Behaviour on hit:
 *   - Map entry (fresh ack): entry is CONSUMED so a legitimate later remote
 *     frame with the same seq (shouldn't happen — seqs are monotonic — but
 *     defence-in-depth) can still be applied.
 *   - High-water mark match (TTL expired but seq <= lastEmittedServerSeq):
 *     non-destructive; the mark stays, because any future frame with that
 *     same or smaller seq is still a self-echo.
 */
export function isSelfEcho(server_seq: number): boolean {
  if (typeof server_seq !== 'number' || !Number.isFinite(server_seq)) return false;
  gc(Date.now());
  if (acks.has(server_seq)) {
    acks.delete(server_seq);
    return true;
  }
  // Level 2: TTL-free high-water mark. A frame at or below the last seq we
  // emitted as self-ack CANNOT be a fresh remote write (server seqs are
  // monotonic per origin), so treat it as self-echo even if the Map entry
  // has been GC'd.
  if (server_seq > 0 && server_seq <= lastEmittedServerSeq) return true;
  return false;
}

/** Test/diagnostic helper. */
export function __getPendingAcks(): number[] {
  return [...acks.keys()];
}

/** Test/diagnostic helper — returns the TTL-free self-ack high-water mark. */
export function __getLastEmittedServerSeq(): number {
  return lastEmittedServerSeq;
}

/** Test-only: reset all self-echo state. Not exported from the barrel. */
export function __resetSelfEchoForTests(): void {
  resetSelfEcho();
}

/**
 * Reset all self-echo state. Called by the WS-lifecycle `open` subscriber so
 * that a new connection (typically a server restart resetting its seq back
 * to 1) is not treated as a self-echo against stale pre-restart acks.
 *
 * Without this, the pair (`syncWS.lastAppliedServerSeq` reset, selfEcho
 * retained) creates the exact bug `syncWS` was trying to fix: the new
 * connection's first `ui-state:init` passes the `lastAppliedServerSeq`
 * gate but is then classified as a self-echo because `server_seq <=
 * lastEmittedServerSeq`, so HYDRATE is skipped and the UI stays on
 * cached-wrong state.
 */
export function resetSelfEcho(): void {
  acks.clear();
  lastEmittedServerSeq = 0;
}
