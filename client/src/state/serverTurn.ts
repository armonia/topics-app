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
}

/** The turn a queued message waits for: it may leave only once THAT turn is over. */
export interface TurnRef {
  boot: string;
  turnId: number;
}

const turns = new Map<string, ServerTurn>();
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
  const held = serverTurnOf(sessionKey);
  if (held && held.boot === next.boot && next.asOf < held.asOf) return false;
  turns.set(sessionKey, { boot: next.boot, asOf: next.asOf, turnId: next.turnId, open: next.open });
  return true;
}

/**
 * Takes a snapshot of every open turn (sent when the socket opens). Every
 * session held here and not listed is closed as of it. Returns the sessions
 * that are closed now, for the caller to try their queues.
 */
export function noteTurnSnapshot(snapshot: unknown): string[] {
  const s = snapshot as { boot?: unknown; asOf?: unknown; open?: unknown } | null;
  if (!s || typeof s.boot !== 'string' || typeof s.asOf !== 'number' || !Array.isArray(s.open)) return [];
  const listed = new Map<string, ServerTurn>();
  for (const entry of s.open) {
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

/** Only for tests: forget everything. */
export function __resetServerTurns(): void {
  turns.clear();
  baseline = null;
}
