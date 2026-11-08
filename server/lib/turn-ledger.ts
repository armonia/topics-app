/**
 * WHETHER A SESSION HAS A TURN OPEN, ANSWERED IN ONE PLACE.
 *
 * The queue of messages typed during a turn used to leave on a guess. The
 * client drained it when it believed the turn was over (a `stream:end`, its own
 * SSE closing, a history read that said "not streaming", a watchdog), and the
 * server's 409 gate refused a second turn only while `activeStreams` had the
 * session. Neither saw the CLI working on a turn it had opened by itself: a
 * background task's notification, a cron fire, a Monitor. Topics adopts such a
 * turn only at the model's first line, p50 4.7 s after the CLI began (291 of
 * them in 14 days), and during that window a message went through the open gate
 * and was written into the running turn's stdin: 4 messages seen by the model
 * in the middle of a turn nobody had asked for (chat 33966f4e on 27/09, twice).
 *
 * The ledger is the single answer to "is a turn open on this session?". Several
 * sources may hold a session open, and it is open while any of them does:
 *
 *   - `route`: the chat route registered a turn (`startStream`);
 *   - `cli`: the claude-code child is between a `system/init` and its `result`,
 *     whoever started it (`ClaudeCodeProvider.observeCliTurns`);
 *   - `boot`: a session whose child may still be mid-turn after a restart, until
 *     the boot reattach has decided about it.
 *
 * Every open/close transition bumps a revision and is broadcast as `turn:state`.
 * The client keys its drain on these states instead of on its own streaming
 * flag, which a reconnect, a history read or a 409 could reset.
 *
 * Pure: no clock, no I/O. `onChange` is the caller's broadcast.
 */

export type TurnSource = "route" | "cli" | "boot";

/** What a window needs to know about one session's turn. */
export interface TurnState {
  sessionKey: string;
  /** This server process: revisions restart at every boot. */
  boot: string;
  /** Global revision this statement is true as of. Frames with a lower one are stale. */
  asOf: number;
  /** The open turn, or the last one the session had (0 = none since boot). */
  turnId: number;
  open: boolean;
  /** Closed: a person stopped that turn. Every window holds its queue on it, not only the one whose Stop it was. */
  stopped?: true;
  /** Closed: the turn ended waiting for a person (a plan approval). The queue waits for the answer. */
  awaitsHuman?: true;
  /**
   * The latest turn of this boot a person stopped, kept past the turns that
   * follow it. `stopped` is said once, with that close; a window that was not
   * listening then (a phone in the background, a reload) learns the Stop from
   * this, and holds what it had queued before it.
   */
  lastStop?: number;
}

/** How a turn ended, said with its close (`TurnLedger.noteEnd`). */
export interface TurnEnd {
  stopped?: boolean;
  awaitsHuman?: boolean;
}

/**
 * Every open turn, as of one revision: a session not listed has none. Plus the
 * sessions whose last turn ended waiting for a person, listed closed: a window
 * that connects now must not take that for a free session. Plus every other
 * closed session a person stopped a turn of in this boot (`stopped`, with its
 * `lastStop`): a window that missed the close must still hold on that Stop.
 */
export interface TurnSnapshot {
  boot: string;
  asOf: number;
  open: TurnState[];
  awaiting: TurnState[];
  stopped: TurnState[];
}

export interface TurnLedger {
  /** Marks `source` as holding (or no longer holding) the session open. */
  set(sessionKey: string, source: TurnSource, on: boolean): void;
  /**
   * How the open turn is ending, said with its close whichever source closes
   * it last. Before this the close said only "over", and the reason travelled
   * in a later `stream:end`: a window read the close first and sent its queue
   * into a Stop, or under a plan approval. Ignored when no turn is open; the
   * next open forgets it.
   */
  noteEnd(sessionKey: string, end: TurnEnd): void;
  isOpen(sessionKey: string, opts?: { ignore?: readonly TurnSource[] }): boolean;
  stateOf(sessionKey: string): TurnState;
  snapshot(): TurnSnapshot;
  /** Which sources hold the session now (for logs and tests). */
  sourcesOf(sessionKey: string): TurnSource[];
}

interface Entry { sources: Set<TurnSource>; turnId: number; end: TurnEnd; lastStop?: number }

export function createTurnLedger(opts: { boot?: string; onChange?: (state: TurnState) => void } = {}): TurnLedger {
  const boot = opts.boot ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let rev = 0;
  const entries = new Map<string, Entry>();

  function stateAt(sessionKey: string, asOf: number): TurnState {
    const e = entries.get(sessionKey);
    const open = !!e && e.sources.size > 0;
    return {
      sessionKey, boot, asOf, turnId: e?.turnId ?? 0, open,
      ...(!open && e?.end.stopped ? { stopped: true as const } : {}),
      ...(!open && e?.end.awaitsHuman ? { awaitsHuman: true as const } : {}),
      ...(e?.lastStop !== undefined ? { lastStop: e.lastStop } : {}),
    };
  }

  return {
    set(sessionKey, source, on) {
      let e = entries.get(sessionKey);
      const wasOpen = !!e && e.sources.size > 0;
      if (on) {
        if (!e) { e = { sources: new Set(), turnId: 0, end: {} }; entries.set(sessionKey, e); }
        if (e.sources.has(source)) return;
        e.sources.add(source);
      } else {
        if (!e || !e.sources.has(source)) return;
        e.sources.delete(source);
      }
      const nowOpen = e.sources.size > 0;
      if (nowOpen === wasOpen) return;
      rev++;
      // A turn is named by the revision that opened it: unique and increasing within a boot.
      if (nowOpen) { e.turnId = rev; e.end = {}; }
      else if (e.end.stopped) e.lastStop = e.turnId;
      try { opts.onChange?.(stateAt(sessionKey, rev)); }
      catch (err) { console.warn(`[turn-ledger] change listener failed for ${sessionKey}:`, err); }
    },
    noteEnd(sessionKey, end) {
      const e = entries.get(sessionKey);
      if (!e || e.sources.size === 0) return;
      if (end.stopped) e.end.stopped = true;
      if (end.awaitsHuman) e.end.awaitsHuman = true;
    },
    isOpen(sessionKey, o) {
      const e = entries.get(sessionKey);
      if (!e) return false;
      for (const s of e.sources) if (!o?.ignore?.includes(s)) return true;
      return false;
    },
    stateOf(sessionKey) {
      return stateAt(sessionKey, rev);
    },
    snapshot() {
      const open: TurnState[] = [];
      const awaiting: TurnState[] = [];
      const stopped: TurnState[] = [];
      for (const [sessionKey, e] of entries) {
        if (e.sources.size > 0) open.push(stateAt(sessionKey, rev));
        else if (e.end.awaitsHuman) awaiting.push(stateAt(sessionKey, rev));
        else if (e.lastStop !== undefined) stopped.push(stateAt(sessionKey, rev));
      }
      return { boot, asOf: rev, open, awaiting, stopped };
    },
    sourcesOf(sessionKey) {
      return [...(entries.get(sessionKey)?.sources ?? [])];
    },
  };
}
