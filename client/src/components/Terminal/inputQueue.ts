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
 */

/** A paste is bigger than this; a burst of typing is not. Two seconds of fast
 *  typing is ~40 bytes, so the ceiling is generous on purpose: it is there to
 *  bound memory, not to ration the typist. */
export const TERMINAL_INPUT_QUEUE_MAX_BYTES = 8192;

/** Past this, held input is discarded instead of delivered. A command that
 *  lands ten seconds late is still recognisable as yours; half a minute later
 *  it is a surprise executed against a prompt you are no longer looking at. */
export const TERMINAL_INPUT_QUEUE_MAX_AGE_MS = 10_000;

export interface InputQueueSocket {
  readyState: number;
  send(data: string): void;
}

export interface InputQueueState {
  /** Bytes waiting for the attach. Zero means nothing is held. */
  pendingBytes: number;
  /** Something was thrown away (ceiling or age) since the last flush/clear. */
  discarded: boolean;
}

export interface InputQueueOptions {
  /** The socket of the moment, re-read on every call: a reconnect replaces it. */
  socket: () => InputQueueSocket | null | undefined;
  /** True once the attach is proven (`replay-end`), false while reconnecting. */
  attached: () => boolean;
  onStateChange?: (state: InputQueueState) => void;
  now?: () => number;
  maxBytes?: number;
  maxAgeMs?: number;
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
  private discarded = false;

  constructor(options: InputQueueOptions) {
    this.options = options;
    this.maxBytes = options.maxBytes ?? TERMINAL_INPUT_QUEUE_MAX_BYTES;
    this.maxAgeMs = options.maxAgeMs ?? TERMINAL_INPUT_QUEUE_MAX_AGE_MS;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private emit(): void {
    this.options.onStateChange?.({ pendingBytes: this.bytes, discarded: this.discarded });
  }

  /** Forget what got stale while nobody was looking. */
  private expire(): void {
    if (this.entries.length === 0) return;
    const cutoff = this.now() - this.maxAgeMs;
    const kept = this.entries.filter((e) => e.at >= cutoff);
    if (kept.length === this.entries.length) return;
    this.entries = kept;
    this.bytes = kept.reduce((n, e) => n + e.data.length, 0);
    this.discarded = true;
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
    if (this.bytes + data.length > this.maxBytes) {
      this.discarded = true;
      this.emit();
      return 'discarded';
    }
    this.entries.push({ data, at: this.now() });
    this.bytes += data.length;
    this.emit();
    return 'queued';
  }

  /**
   * The attach is proven: release everything held, in order, once.
   *
   * Returns the number of bytes actually delivered. The queue is emptied even
   * if the socket disappeared between the two lines, because keeping it would
   * mean delivering the same keys twice on the next attach.
   */
  flush(): number {
    this.expire();
    const pending = this.entries;
    this.entries = [];
    this.bytes = 0;
    let delivered = 0;
    const ws = this.options.socket();
    if (ws && ws.readyState === OPEN) {
      for (const entry of pending) {
        ws.send(entry.data);
        delivered += entry.data.length;
      }
    } else if (pending.length > 0) {
      this.discarded = true;
    }
    this.emit();
    return delivered;
  }

  /** Throw away what is held without delivering it (pane unmount, dead session). */
  clear(): void {
    this.entries = [];
    this.bytes = 0;
    this.discarded = false;
    this.emit();
  }

  /** Drop the "something was lost" flag once the reader has been told. */
  acknowledgeDiscarded(): void {
    if (!this.discarded) return;
    this.discarded = false;
    this.emit();
  }

  get state(): InputQueueState {
    return { pendingBytes: this.bytes, discarded: this.discarded };
  }
}
