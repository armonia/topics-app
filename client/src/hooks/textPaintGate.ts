/**
 * THE LAST WORDS ARE DRAWN BEFORE THE TURN CLOSES.
 *
 * A reply that ends right behind its last word brings the text and the end of
 * the turn in the same read (the same SSE chunk, or two WS frames a millisecond
 * apart). Both landed in one React commit: the text grew the bubble in the very
 * frame the loader went, and the turn, pinned to the bottom, jumped 27 px at
 * its end (card 40ea050c, scenario `quick` of `chat-turn-end-still`). With a
 * pause after the text the same end moves nothing, because the text is already
 * on screen when the loader goes.
 *
 * So every commit of live text marks its session as UNPAINTED until a frame
 * has been painted after it, and the end of the turn waits for that frame. The
 * text then grows the bubble while the loader is still there, as any streamed
 * text does, and the loader goes in a later frame, where it moves nothing.
 *
 * "Painted" is two animation frames after the commit was scheduled: React
 * renders an update made outside an event in a task of its own, which can run
 * after the paint of the frame it was scheduled in; by the second frame's
 * callback the first one has been painted with it. A page that paints nothing
 * (a hidden tab throttles animation frames) is let through by a timer: there is
 * nothing on screen to move there.
 */

/** How long an end waits at most when no frame comes (a hidden tab). */
export const PAINT_GATE_FALLBACK_MS = 250;

export interface FrameScheduler {
  requestFrame(cb: () => void): void;
  setTimer(cb: () => void, ms: number): void;
}

const browserScheduler: FrameScheduler = {
  requestFrame: (cb) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => cb());
    else setTimeout(cb, 16);
  },
  setTimer: (cb, ms) => { setTimeout(cb, ms); },
};

export class TextPaintGate {
  /** Per session, the number of the last text commit not painted yet. */
  private readonly pending = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private seq = 0;

  constructor(private readonly scheduler: FrameScheduler = browserScheduler) {}

  /** Live text of `key` was just committed: it is unpainted until a frame shows it. */
  markCommitted(key: string): void {
    const mine = ++this.seq;
    this.pending.set(key, mine);
    let done = false;
    const painted = () => {
      if (done) return;
      done = true;
      // A later commit owns the session now: its own frames release it.
      if (this.pending.get(key) !== mine) return;
      this.pending.delete(key);
      const waiting = this.waiters.get(key);
      this.waiters.delete(key);
      for (const resolve of waiting ?? []) resolve();
    };
    this.scheduler.requestFrame(() => this.scheduler.requestFrame(painted));
    this.scheduler.setTimer(painted, PAINT_GATE_FALLBACK_MS);
  }

  /** Whether text of `key` was committed and no frame has shown it yet. */
  isPending(key: string): boolean {
    return this.pending.has(key);
  }

  /** Runs `fn` once the text of `key` is on screen: now if it already is. */
  afterPaint(key: string, fn: () => void): void {
    if (!this.pending.has(key)) { fn(); return; }
    const list = this.waiters.get(key) ?? [];
    list.push(fn);
    this.waiters.set(key, list);
  }

  /** The promise form of `afterPaint`, for the SSE reader that awaits it. */
  painted(key: string): Promise<void> {
    return new Promise((resolve) => this.afterPaint(key, resolve));
  }
}
