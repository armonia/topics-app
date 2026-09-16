/**
 * The keystrokes typed while the terminal socket is not attached yet.
 *
 * Why it exists. `term.onData` used to send straight to the WebSocket and do
 * NOTHING when the socket was not OPEN: after a reload the pane remounts, the
 * PTY bridge replays the scrollback and the cursor moves on screen, so the
 * terminal looks alive while every key pressed before the attach is thrown
 * away in silence. With the reconnect backoff (up to 3 s per retry) that mute
 * window lasts seconds, and the reader has no way to tell it apart from a slow
 * command.
 *
 * What it does. It holds that input in order and releases it, once, the moment
 * the attach is PROVEN (`replay-end`, the only frame a live session sends).
 * Two limits keep it honest, because replaying keys into a shell is not free:
 *
 *  · a byte ceiling, so a held key or a paste cannot build an unbounded buffer;
 *  · an age limit, so nothing is ever delivered as a surprise long after it was
 *    typed. Past it the input is dropped and the caller is told, which is the
 *    whole difference with the old behaviour: losing a keystroke is acceptable,
 *    losing it silently is not.
 *
 * Hitting either limit throws away the WHOLE queue and refuses what follows
 * until the next attach: see `poisoned`. Delivering the part that survives a
 * partial loss is the one outcome worse than delivering nothing.
 */

/** A paste is bigger than this; a burst of typing is not. Two seconds of fast
 *  typing is ~40 bytes, so the ceiling is generous on purpose: it is there to
 *  bound memory, not to ration the typist. */
export const TERMINAL_INPUT_QUEUE_MAX_BYTES = 8192;

/** Past this, held input is discarded instead of delivered. A command that
 *  lands a few seconds late is still recognisable as yours; half a minute later
 *  it is a surprise executed against a prompt you are no longer looking at.
 *  Measured: a server restart leaves the client without an answer for ~11,5 s,
 *  and the reconnect backoff adds up to 3 s on top, so anything under that
 *  would throw away input the attach was about to deliver honestly. */
export const TERMINAL_INPUT_QUEUE_MAX_AGE_MS = 15_000;

export interface InputQueueSocket {
  readyState: number;
  send(data: string): void;
}

/**
 * WHY the queue threw something away.
 *
 * One boolean used to answer for all three, and the pane said "it was too old
 * to send" for every one of them. That sentence is simply false for an 8 KB
 * paste refused a millisecond after it was typed, and false again for a flush
 * that found no socket: the reader is told a wrong cause and goes looking for
 * a slowness that never happened.
 */
export type InputLossReason =
  /** Held past the age limit: delivering it now would surprise the reader. */
  | 'expired'
  /** Over the byte ceiling in one go (a paste), so nothing was held at all. */
  | 'tooLong'
  /** The attach arrived with no socket behind it, so nothing could go out. */
  | 'disconnected';

/** The phrase the pane shows per cause. One key each, on purpose: a single
 *  key for three causes is how the wrong explanation got shipped. */
export const INPUT_LOSS_MESSAGE_KEY: Record<InputLossReason, string> = {
  expired: 'terminal.inputLost.expired',
  tooLong: 'terminal.inputLost.tooLong',
  disconnected: 'terminal.inputLost.disconnected',
};

export interface InputQueueState {
  /** Bytes waiting for the attach. Zero means nothing is held. */
  pendingBytes: number;
  /** Why something was thrown away since the last flush/clear, or null. */
  lostReason: InputLossReason | null;
}

/** A partial command is worse than no command. See `poisoned`. */
export type Timer = ReturnType<typeof setTimeout>;

export interface InputQueueOptions {
  /** The socket of the moment, re-read on every call: a reconnect replaces it. */
  socket: () => InputQueueSocket | null | undefined;
  /** True once the attach is proven (`replay-end`), false while reconnecting. */
  attached: () => boolean;
  onStateChange?: (state: InputQueueState) => void;
  now?: () => number;
  maxBytes?: number;
  maxAgeMs?: number;
  /** Injectable for tests; defaults to the real timers. The expiry has to fire
   *  on its own, because nobody is typing while the reader waits. */
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

export type SendOutcome = 'sent' | 'queued' | 'discarded';

interface Entry {
  data: string;
  at: number;
}

const OPEN = 1;

export class TerminalInputQueue {
  private readonly options: InputQueueOptions;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private entries: Entry[] = [];
  private bytes = 0;
  private lostReason: InputLossReason | null = null;
  /**
   * THE HOLE RULE. Once anything is thrown away, the queue stops accepting
   * input until the next flush/clear.
   *
   * Delivering what survives a partial loss is worse than delivering nothing:
   * the keystrokes are a COMMAND LINE, not independent events. Expiring the
   * oldest entries alone would drop the prefix and hand the shell the suffix
   * (`sudo ` expires, `rm -rf build\r` arrives, and it runs). Dropping one
   * entry for the byte ceiling and keeping the rest punches a hole in the
   * middle and still delivers the trailing Enter. Both were reproduced. So a
   * loss poisons the whole queue: nothing is delivered, and what comes after
   * is refused out loud instead of being silently stitched onto a stump.
   */
  private poisoned = false;
  private timer: Timer | null = null;

  constructor(options: InputQueueOptions) {
    this.options = options;
    this.maxBytes = options.maxBytes ?? TERMINAL_INPUT_QUEUE_MAX_BYTES;
    this.maxAgeMs = options.maxAgeMs ?? TERMINAL_INPUT_QUEUE_MAX_AGE_MS;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private emit(): void {
    this.options.onStateChange?.({ pendingBytes: this.bytes, lostReason: this.lostReason });
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    const clear = this.options.clearTimer ?? clearTimeout;
    clear(this.timer);
    this.timer = null;
  }

  /**
   * Wake up when the oldest entry goes stale.
   *
   * Without this the expiry is only ever noticed by the next send or flush, so
   * a pane left alone keeps promising delivery for input that is already too
   * old to deliver. The band has to become a lie on a timer, not on the next
   * keystroke that may never come.
   */
  private scheduleExpiry(): void {
    this.cancelTimer();
    if (this.entries.length === 0) return;
    const oldest = this.entries[0];
    if (!oldest) return;
    const due = Math.max(0, oldest.at + this.maxAgeMs - this.now());
    const set = this.options.setTimer ?? setTimeout;
    this.timer = set(() => {
      this.timer = null;
      if (this.expire()) {
        this.emit();
        return;
      }
      // Fired, and nothing was stale. `setTimeout` counts monotonic
      // milliseconds while `now()` reads the wall clock, so a wake-up can land
      // a tick before the entry is old enough by that clock. Without this
      // re-arm the queue has no timer left and the "held, will be delivered"
      // band promises a delivery that never comes, for as long as the pane
      // stays open. It terminates: the only way `expire()` says no is
      // `now() < oldest.at + maxAge`, which makes the next `due` positive.
      this.scheduleExpiry();
    }, due);
  }

  /** Throw the queue away wholesale and refuse what follows. Returns true if
   *  this call is what lost something. */
  private poison(reason: InputLossReason): boolean {
    const hadSomething = this.entries.length > 0;
    this.cancelTimer();
    this.entries = [];
    this.bytes = 0;
    this.lostReason = reason;
    const wasClean = !this.poisoned;
    this.poisoned = true;
    return hadSomething || wasClean;
  }

  /** Forget what got stale while nobody was looking. Returns true if it did. */
  private expire(): boolean {
    if (this.entries.length === 0) return false;
    // `<=`, not `<`: at exactly `at + maxAge` the entry has reached the limit,
    // and this is the instant the timer above aims at. With `<` the scheduled
    // wake-up found nothing stale at its own deadline and left the queue held
    // for good.
    const cutoff = this.now() - this.maxAgeMs;
    const stale = this.entries.some((e) => e.at <= cutoff);
    if (!stale) return false;
    this.poison('expired');
    return true;
  }

  /**
   * Straight to the socket when attached, into the queue otherwise.
   *
   * `attached()` is not the same question as "is the socket OPEN": the server
   * accepts the upgrade for ANY session id and only then decides whether the
   * session exists, so an open socket proves nothing. Input released on `open`
   * alone can be typed into a refusal.
   */
  send(data: string): SendOutcome {
    if (data === '') return 'sent';
    const ws = this.options.socket();
    if (ws && ws.readyState === OPEN && this.options.attached()) {
      ws.send(data);
      return 'sent';
    }
    this.expire();
    // Already holed: what follows would be stitched onto a stump.
    if (this.poisoned) {
      this.emit();
      return 'discarded';
    }
    if (this.bytes + data.length > this.maxBytes) {
      this.poison('tooLong');
      this.emit();
      return 'discarded';
    }
    this.entries.push({ data, at: this.now() });
    this.bytes += data.length;
    if (this.entries.length === 1) this.scheduleExpiry();
    this.emit();
    return 'queued';
  }

  /**
   * The attach is proven: release everything held, in order, once.
   *
   * Returns the number of bytes actually delivered. The queue is emptied even
   * if the socket disappeared between the two lines, because keeping it would
   * mean delivering the same keys twice on the next attach. A poisoned queue
   * delivers nothing at all, and the attach is what un-poisons it: from here
   * on the typist starts from a clean line.
   */
  flush(): number {
    this.expire();
    this.cancelTimer();
    const pending = this.entries;
    this.entries = [];
    this.bytes = 0;
    this.poisoned = false;
    let delivered = 0;
    const ws = this.options.socket();
    if (ws && ws.readyState === OPEN) {
      for (const entry of pending) {
        ws.send(entry.data);
        delivered += entry.data.length;
      }
    } else if (pending.length > 0) {
      this.lostReason = 'disconnected';
    }
    this.emit();
    return delivered;
  }

  /** Throw away what is held without delivering it (pane unmount, dead session). */
  clear(): void {
    this.cancelTimer();
    this.entries = [];
    this.bytes = 0;
    this.lostReason = null;
    this.poisoned = false;
    this.emit();
  }

  /** Drop the "something was lost" flag once the reader has been told. */
  acknowledgeLoss(): void {
    if (this.lostReason === null) return;
    this.lostReason = null;
    this.emit();
  }

  get state(): InputQueueState {
    return { pendingBytes: this.bytes, lostReason: this.lostReason };
  }
}

/** What the pane shows about the queue: at most one band is up. */
export interface InputBands {
  /** "held and will be delivered" */
  held: boolean;
  /** Why what was typed is gone, or null when nothing was lost. */
  lost: InputLossReason | null;
}

/**
 * The queue state translated into the two bands, as a pure function.
 *
 * It lives here, and the pane calls it, so that the wiring is something a test
 * can hold: before this, nothing went red if `onStateChange` simply forgot to
 * raise a band, and the silent-loss bug would have come back through the UI
 * with the queue itself still perfectly correct.
 */
export function nextInputBands(state: InputQueueState, current: InputBands): InputBands {
  const lost = state.lostReason ?? current.lost;
  // A loss outranks a promise of delivery: after a discard there is nothing
  // left to deliver, and showing both would have the pane contradict itself.
  const held = lost ? false : state.pendingBytes > 0;
  return { held, lost };
}
