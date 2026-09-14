/**
 * uiStatePersist -- the write side of the per-record browser stores (task
 * browser tabs, topic browser window), and the arbiter of what inbound data is
 * allowed to overwrite a record that has a local write in the air.
 *
 * THE THREE THINGS IT ARBITRATES, each one a bug that was measured:
 *
 * 1. A QUEUED EDIT BEATS EVERY FRAME. While the debounce timer is still
 *    counting, the local record is newer than anything the server can push: the
 *    edit has not even been sent. Frames for that key are dropped.
 *
 * 2. DURING THE ROUND TRIP NOBODY KNOWS YET. The protection used to end when
 *    the PUT LEFT, so a whole round trip counted as safe while the server still
 *    held the old value: a frame from another device landed, our own echo was
 *    then dropped as an echo, and the two copies stayed apart until a resync
 *    (with the next local commit resurrecting the closed tab). Holding the
 *    protection for the whole flight instead opened the OPPOSITE window: the
 *    server broadcasts BEFORE it answers, so a frame carrying a write that is
 *    genuinely NEWER than ours (another device wrote after us) was thrown away,
 *    and again local and server drifted -- the other way round.
 *
 *    Neither "apply" nor "drop" is right at arrival, because at arrival the
 *    order is unknown. So a frame that shows up mid-flight is HELD, and the
 *    answer to our PUT decides: it brings back the `server_seq` our write got,
 *    and a frame with a seq above it happened after us and is adopted, while one
 *    at or below it is our own past and is dropped. A failed PUT releases the
 *    held frame too: nothing of ours reached the row, so the frame is the truth.
 *
 * 3. A READ IS ONLY VALID IF NOTHING WAS WRITTEN WHILE IT TRAVELLED. Filtering
 *    the keys with a pending write BEFORE issuing the resync GETs is not enough:
 *    the answers come back much later (`Promise.all` waits for the slowest), and
 *    a close committed in between makes the answer a resurrection. Callers take
 *    a `writeToken` per key before the GET and ask `wroteSince` before applying.
 *
 *    A key the resync SKIPPED because a write of ours was in the air is not
 *    simply lost: the caller marks it with `deferRead`, and the end of the
 *    flight re-issues that one GET (`onReadNeeded`). Without it a socket that
 *    died mid-flight left the key unread until the next reconnect, which is the
 *    original divergence with one more step.
 *
 * 4. AND A READ IS NOT ALLOWED TO UNDO A NEWER FRAME. Point 3 orders a read
 *    against OUR writes; it says nothing about the other devices. A GET that
 *    left when the row said [b], with a frame carrying [c] applied while it
 *    travelled, answered [b] and put it back: local [b], server [c], apart for
 *    good. So every applied value's `server_seq` is remembered per key (frames,
 *    held frames released later, and read answers alike), and a read answering
 *    BELOW that line is refused -- it is describing a state we have already left
 *    behind. The bulk resync had this window since it existed; the owed read of
 *    point 3 inherited it.
 *
 * KNOWN LIMITS, both of them older than this arbitration and left in the open on
 * purpose:
 *
 *  - a mid-flight frame with NO seq is adopted once the answer comes, because
 *    nothing proves it is our own past. Today every broadcast carries a seq, so
 *    the case is theory; a server that stopped sending it would re-open it.
 *  - a PUT that the server APPLIED but answered after the flight cap counts as
 *    a failure here, so a frame older than it gets adopted. A longer cap trades
 *    this against freezing cross-device updates on a dead socket.
 */

import { getTabId } from './pane/middleware/syncCrossTab';

/**
 * A PUT with no answer would hold a key's frames hostage forever (every frame
 * held, none released), so the flight is capped. The cap is long enough to be
 * invisible to a working connection and short enough that a dead socket does
 * not freeze cross-device updates for the session.
 */
export const PUT_TIMEOUT_MS = 10_000;

/** What to do with an inbound frame: adopt it, throw it away, or wait for the answer to our own PUT. */
export type FrameVerdict = 'apply' | 'drop' | 'deferred';

export interface UiStatePersisterOptions {
  /** Flight cap in ms (test seam; defaults to `PUT_TIMEOUT_MS`). */
  putTimeoutMs?: number;
  /**
   * A frame held during a PUT round trip turned out to be NEWER than our
   * confirmed write (or our write never landed): adopt it now, as if it had
   * just arrived with nothing pending.
   */
  onDeferredFrame?: (key: string, value: unknown) => void;
  /**
   * A key that a resync skipped (write in the air) is now settled: re-read it,
   * because nobody else will. The caller re-issues its single GET.
   */
  onReadNeeded?: (key: string) => void;
}

export interface UiStatePersister {
  /** Queue a debounced PUT for `key`; a newer value replaces a queued one. */
  put(key: string, value: unknown, ms?: number): void;
  /** Is a local write for `key` unresolved -- queued, in flight, or both? */
  isPending(key: string): boolean;
  /**
   * Verdict for an inbound `ui-state:updated` frame. `seq` is the frame's
   * `server_seq` when the server sent one; without it a mid-flight frame can
   * only be held and then adopted, since nothing proves it is older than us.
   */
  admitFrame(key: string, value: unknown, seq?: number | null): FrameVerdict;
  /** Write generation for `key`, to be taken BEFORE a read and handed to `wroteSince`. */
  writeToken(key: string): number;
  /** Did a local write for `key` start after `token` was taken? Then the read is stale. */
  wroteSince(key: string, token: number): boolean;
  /**
   * A read for `key` was skipped because a write was unresolved: ask for it
   * again as soon as the write settles (`onReadNeeded`).
   */
  deferRead(key: string): void;
  /**
   * Remember the `server_seq` of a value just APPLIED to `key`, which is the
   * line a later read has to clear. A value with no seq moves no line.
   */
  noteApplied(key: string, seq: number | null): void;
  /**
   * Is a read answer for `key` describing a state we have already left? True
   * when its seq is BELOW an applied one. A read with no seq is let through:
   * nothing proves it old (a missing row answers with no envelope at all).
   */
  readIsStale(key: string, seq: number | null): boolean;
  /** Drop the QUEUED write for `key` (a PUT already in flight cannot be recalled). */
  cancel(key: string): void;
  /** Test seam: forget every queued write, in-flight write and held frame. */
  cancelAll(): void;
}

/**
 * A signal that aborts after `ms`, and the timer to clear when the answer beats
 * it. `AbortSignal.timeout` is the whole of it on a current engine; the
 * controller is the fallback for one that does not have it (WebKit before 16),
 * where reading the property would throw and take the flight bookkeeping with
 * it.
 */
function flightSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const timeoutOf = (AbortSignal as { timeout?: (ms: number) => AbortSignal }).timeout;
  if (typeof timeoutOf === 'function') return { signal: timeoutOf.call(AbortSignal, ms), clear: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, ms);
  return { signal: controller.signal, clear: () => { clearTimeout(timer); } };
}

export function createUiStatePersister(options: UiStatePersisterOptions = {}): UiStatePersister {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Count, not a flag: a second edit can flush while the first PUT is still in
  // flight (closing the last tab writes with no debounce at all), and the first
  // answer must not clear the protection the second write still needs.
  const inFlight = new Map<string, number>();
  // Highest server_seq our OWN writes have been confirmed at: the line under
  // which an inbound frame is our own past.
  const confirmedSeq = new Map<string, number>();
  // The one frame waiting for our PUT's answer (a newer frame replaces it).
  const held = new Map<string, { value: unknown; seq: number | null }>();
  // Bumped by every write that STARTS, so a read can tell it was overtaken.
  const generation = new Map<string, number>();
  // Keys whose resync GET was skipped over an unresolved write of ours.
  const owedReads = new Set<string>();
  // Highest server_seq we have APPLIED for a key, whatever brought it (a frame,
  // a held frame released later, a read answer): the line a read must clear.
  const appliedSeq = new Map<string, number>();

  const markApplied = (key: string, seq: number | null): void => {
    if (seq === null) return;
    const known = appliedSeq.get(key);
    if (known === undefined || seq > known) appliedSeq.set(key, seq);
  };

  const settle = (key: string, seq: number | null): void => {
    if (seq !== null) {
      const known = confirmedSeq.get(key);
      if (known === undefined || seq > known) confirmedSeq.set(key, seq);
    }
    const left = (inFlight.get(key) ?? 1) - 1;
    if (left > 0) { inFlight.set(key, left); return; }
    inFlight.delete(key);

    releaseHeldFrame(key);
    // The resync skipped this key because of the flight that just ended, and
    // nothing else will ever come back for it: ask for the read now. A queued
    // edit keeps the debt open instead, for the end of ITS flight.
    if (owedReads.has(key) && !timers.has(key) && !inFlight.has(key)) {
      owedReads.delete(key);
      options.onReadNeeded?.(key);
    }
  };

  const releaseHeldFrame = (key: string): void => {
    const frame = held.get(key);
    if (!frame) return;
    held.delete(key);
    // A local edit queued while the frame waited is newer than the frame.
    if (timers.has(key)) return;
    const line = confirmedSeq.get(key);
    if (frame.seq !== null && line !== undefined && frame.seq <= line) return;
    markApplied(key, frame.seq);
    options.onDeferredFrame?.(key, frame.value);
  };

  const send = (key: string, value: unknown): void => {
    // The signal is built BEFORE the flight is counted, and the request is
    // guarded: anything that throws on the way out (an engine without
    // `AbortSignal.timeout`, a fetch that rejects synchronously) would otherwise
    // leave the key counted as "in the air" for the rest of the session, with
    // every frame for it held and never released.
    const flight = flightSignal(options.putTimeoutMs ?? PUT_TIMEOUT_MS);
    inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    generation.set(key, (generation.get(key) ?? 0) + 1);
    const done = (seq: number | null): void => { flight.clear(); settle(key, seq); };
    try {
      void fetch(`/api/ui-state/${key}`, { // PANE-01-ALLOWED: per-record browser keys, not pane state
      method: 'PUT',
      // X-Client-Id lets the server stamp the broadcast's `sourceClientId` so the
      // WS bridge can drop THIS client's own echo (else applyRemote would re-apply
      // our own write, or worse revert a newer local edit).
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': getTabId() },
      body: JSON.stringify(value),
      signal: flight.signal,
    })
      // The answer's server_seq is what orders our write against the frames that
      // arrived while it travelled; a write that failed reports no seq at all.
      .then((r) => (r.ok ? r.json().catch(() => null) : null))
      .catch(() => null)
      .then((body: unknown) => {
        const seq = body && typeof body === 'object' && typeof (body as { server_seq?: unknown }).server_seq === 'number'
          ? (body as { server_seq: number }).server_seq
          : null;
        done(seq);
      });
    } catch {
      done(null);
    }
  };

  return {
    put(key: string, value: unknown, ms = 800): void {
      const queued = timers.get(key);
      if (queued) clearTimeout(queued);
      // The generation moves at the EDIT, not only at the PUT: a read answered
      // after an edit was queued is already stale, whatever the debounce does.
      generation.set(key, (generation.get(key) ?? 0) + 1);
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        send(key, value);
      }, ms));
    },
    isPending(key: string): boolean {
      return timers.has(key) || inFlight.has(key);
    },
    admitFrame(key: string, value: unknown, seq?: number | null): FrameVerdict {
      const at = typeof seq === 'number' ? seq : null;
      if (timers.has(key)) return 'drop';
      if (inFlight.has(key)) {
        const waiting = held.get(key);
        // Keep the newest of the two: with seqs that is the higher one, without
        // them the last to arrive.
        if (!waiting || waiting.seq === null || at === null || at > waiting.seq) {
          held.set(key, { value, seq: at });
        }
        return 'deferred';
      }
      const line = confirmedSeq.get(key);
      if (at !== null && line !== undefined && at <= line) return 'drop';
      markApplied(key, at);
      return 'apply';
    },
    writeToken(key: string): number {
      return generation.get(key) ?? 0;
    },
    wroteSince(key: string, token: number): boolean {
      return (generation.get(key) ?? 0) > token;
    },
    deferRead(key: string): void {
      owedReads.add(key);
    },
    noteApplied(key: string, seq: number | null): void {
      markApplied(key, seq);
    },
    readIsStale(key: string, seq: number | null): boolean {
      const line = appliedSeq.get(key);
      return seq !== null && line !== undefined && seq < line;
    },
    cancel(key: string): void {
      const queued = timers.get(key);
      if (queued) { clearTimeout(queued); timers.delete(key); }
      held.delete(key);
      // The record is being forgotten (archived task/topic): a read owed for it
      // would resurrect the row we are dropping.
      owedReads.delete(key);
    },
    cancelAll(): void {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      inFlight.clear();
      confirmedSeq.clear();
      held.clear();
      generation.clear();
      owedReads.clear();
      appliedSeq.clear();
    },
  };
}
