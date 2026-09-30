/**
 * WHAT THE SERVER SAYS ABOUT EACH SESSION'S TURN, and nothing else.
 *
 * The turn queue (`state/chatQueue.ts`) used to drain when this window believed
 * the turn was over: its `streaming` flag went false, a `stream:end` came in,
 * its own SSE closed. Each of those could be early. A history read set the flag
 * to false before asking, a 409 answer reset it in a `finally`, a reconnect
 * lost the `stream:start` of the next turn, and none of them could see a turn
 * the CLI had opened by itself. The server now keeps one ledger of open turns
 * (`server/lib/turn-ledger.ts`) and says every change of it; this module keeps
 * the latest word per session, and the drain reads only this.
 *
 * Ordering: every statement carries the server's revision (`asOf`). A statement
 * older than the one held is dropped, so a history answer that left the server
 * before a `turn:state` cannot undo it. A different `boot` is a restarted
 * server: its revisions start again, and its word replaces the old one.
 */

/** The ledger's word on one session (the `turn:state` frame without its type). */
export interface ServerTurn {
  boot: string;
  asOf: number;
  /** The open turn, or the last one the session had (0 = none since boot). */
  turnId: number;
  open: boolean;
  /** Closed: a person stopped that turn, on whatever device. */
  stopped?: true;
  /** Closed: the turn ended waiting for a person (a plan approval). */
  awaitsHuman?: true;
  /** The latest turn of this boot a person stopped, said on every state after it. */
  lastStop?: number;
}

/** The turn a queued message waits for: it may leave only once THAT turn is over. */
export interface TurnRef {
  boot: string;
  turnId: number;
}

const turns = new Map<string, ServerTurn>();
/**
 * The latest Stop heard per session, whatever carried it: the close that says
 * `stopped`, any later state's `lastStop`, a snapshot, a `user_abort`. Kept
 * apart from `turns` because a newer statement about the session (the next
 * turn's open) does not make the Stop untrue: what was queued before it holds.
 */
const stops = new Map<string, TurnRef>();
/**
 * The server boot this window last heard from. A statement of another boot is
 * a restarted server (the old one cannot speak after it: its sockets and
 * answers died with it), and the Stops heard in the old boot are forgotten
 * then. A window opened after the restart never hears of them (the server
 * keeps `lastStop` per boot), so a window that stayed open must not either:
 * it held, in the new boot, a message another window queued after the Stop,
 * and every one after it, for the life of the window. What an old Stop still
 * holds is already written down: the durable hold (`holdQueue`), raised by the
 * drain the moment the Stop was heard with a queue written before it.
 */
let currentBoot: string | null = null;

function enterBoot(boot: string): void {
  if (boot === currentBoot) return;
  currentBoot = boot;
  for (const [sessionKey, stop] of stops) if (stop.boot !== boot) stops.delete(sessionKey);
}

function noteStop(sessionKey: string, stop: TurnRef): void {
  // A Stop of a boot other than the one heard last is from the server before the restart.
  if (currentBoot !== null && stop.boot !== currentBoot) return;
  const held = stops.get(sessionKey);
  if (held && held.boot === stop.boot && held.turnId >= stop.turnId) return;
  stops.set(sessionKey, stop);
}
/** The last snapshot: a session it did not list had no open turn as of it. */
let baseline: { boot: string; asOf: number } | null = null;

function isServerTurn(v: unknown): v is ServerTurn {
  const t = v as Partial<ServerTurn> | null;
  return !!t && typeof t.boot === 'string' && typeof t.asOf === 'number' && typeof t.turnId === 'number' && typeof t.open === 'boolean';
}

/** The latest word on a session, or undefined when the server has said nothing yet. */
export function serverTurnOf(sessionKey: string): ServerTurn | undefined {
  const held = turns.get(sessionKey);
  if (held) return held;
  return baseline ? { boot: baseline.boot, asOf: baseline.asOf, turnId: 0, open: false } : undefined;
}

/**
 * Takes a statement about one session. Returns true when it was taken (newer
 * than what was held), false when it was stale or malformed.
 */
export function noteServerTurn(sessionKey: string, next: unknown): boolean {
  if (!isServerTurn(next)) return false;
  enterBoot(next.boot);
  // A Stop is a fact whatever the order it arrives in: taken even from a stale statement.
  if (typeof next.lastStop === 'number') noteStop(sessionKey, { boot: next.boot, turnId: next.lastStop });
  if (!next.open && next.stopped === true) noteStop(sessionKey, { boot: next.boot, turnId: next.turnId });
  const held = serverTurnOf(sessionKey);
  if (held && held.boot === next.boot && next.asOf < held.asOf) return false;
  turns.set(sessionKey, {
    boot: next.boot, asOf: next.asOf, turnId: next.turnId, open: next.open,
    ...(!next.open && next.stopped === true ? { stopped: true as const } : {}),
    ...(!next.open && next.awaitsHuman === true ? { awaitsHuman: true as const } : {}),
  });
  return true;
}

/**
 * Takes a snapshot of every open turn (sent when the socket opens). Every
 * session held here and not listed is closed as of it. Returns the sessions
 * that are closed now, for the caller to try their queues.
 */
export function noteTurnSnapshot(snapshot: unknown): string[] {
  const s = snapshot as { boot?: unknown; asOf?: unknown; open?: unknown; awaiting?: unknown; stopped?: unknown } | null;
  if (!s || typeof s.boot !== 'string' || typeof s.asOf !== 'number' || !Array.isArray(s.open)) return [];
  enterBoot(s.boot);
  const listed = new Map<string, ServerTurn>();
  // The sessions whose last turn ended on a question for a person are listed
  // too: closed, but not free (`decideDrain` holds on `awaitsHuman`).
  const awaiting: unknown[] = Array.isArray(s.awaiting) ? s.awaiting : [];
  // And the closed sessions with a person's Stop in this boot: a window that
  // was not listening when the close said `stopped` learns it here.
  const stopped: unknown[] = Array.isArray(s.stopped) ? s.stopped : [];
  for (const entry of [...s.open, ...awaiting, ...stopped]) {
    const e = entry as Partial<ServerTurn> & { sessionKey?: unknown };
    const sessionKey = e.sessionKey;
    if (typeof sessionKey === 'string' && isServerTurn(e)) listed.set(sessionKey, e);
  }
  const closed: string[] = [];
  for (const [sessionKey, held] of turns) {
    if (listed.has(sessionKey)) continue;
    if (held.boot === s.boot && held.asOf > s.asOf) continue;
    turns.set(sessionKey, { boot: s.boot, asOf: s.asOf, turnId: held.boot === s.boot ? held.turnId : 0, open: false });
    closed.push(sessionKey);
  }
  for (const [sessionKey, t] of listed) noteServerTurn(sessionKey, t);
  baseline = { boot: s.boot, asOf: s.asOf };
  return closed;
}

/** The turn a message typed now would wait for: the open one, if the server says one is open. */
export function openTurnRef(sessionKey: string): TurnRef | undefined {
  const t = serverTurnOf(sessionKey);
  return t?.open ? { boot: t.boot, turnId: t.turnId } : undefined;
}

/** The latest Stop by a person this window has heard of on a session. */
export function lastStopOf(sessionKey: string): TurnRef | undefined {
  return stops.get(sessionKey);
}

/**
 * A `user_abort` heard on a session: the Stop of the turn the server last spoke
 * of. Only a fallback: the close of the turn says it too (`stopped`).
 */
export function noteStopHeard(sessionKey: string): void {
  const t = turns.get(sessionKey);
  if (t && t.turnId > 0) noteStop(sessionKey, { boot: t.boot, turnId: t.turnId });
}

/** Only for tests: forget everything. */
export function __resetServerTurns(): void {
  turns.clear();
  stops.clear();
  currentBoot = null;
  baseline = null;
}
