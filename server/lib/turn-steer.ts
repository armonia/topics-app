/**
 * A MESSAGE WRITTEN WHILE A NATIVE TURN RUNS REACHES THAT TURN.
 *
 * On 2026-11-11 Attilio wrote a second message in a Discord thread while
 * Jarvis was working on the first: the chat route answered `stream_in_flight`
 * and the message waited for the end of the turn, minutes later. The gateway
 * Jarvis ran on before "steered" instead: the message joined the running turn
 * at its next round.
 *
 * Here a running native turn opens a TARGET for its session. The chat route
 * offers a message to it (`offerSteer`); the agent loop takes what is waiting
 * at its next round boundary (after the tool results, before the next model
 * call) and appends it to the history as the person's words. A detached turn
 * (`turn-host.ts`) gets the message, with what the server needs to write its
 * row, over its control channel, and names on its journal what it took and,
 * at its end, what it left: so a server that restarted while the host ran
 * still writes the row, or still sends the message on.
 *
 * WHAT BECOMES OF A MESSAGE is decided here and acted on by a SINK the chat
 * route installs (`setSteerSink`): `taken` writes the person's row, `returned`
 * sends it as an ordinary turn of its own once the session is free. A message
 * left when the person pressed Stop is `held`, not sent: Stop stops. One the
 * detached host may have read, when its journal was cut before saying so, is
 * `unknown`: sending it again could run the request twice, so the sender
 * decides (`GET /api/chat/steer`).
 */

/** What the server needs to write the row of a steered message, whoever writes it. */
export interface SteerMeta {
  /** The sender's idempotency key; the row carries it. */
  key: string | null;
  dispatched: boolean;
  dispatchedFor: string[];
  author: { authorPersonId?: string | null; authorDeviceId?: string | null } | null;
  /** The assistant row of the turn the message joins. */
  into: string | null;
  /** Fields of the first request its own turn reuses if the running turn never reads it (sender kind, model, provider). */
  replay?: Record<string, unknown>;
}

export interface SteerItem {
  id: string;
  text: string;
  meta: SteerMeta;
}

export type SteerOutcome = "taken" | "returned" | "held" | "unknown";

export type SteerState =
  | { state: "pending" }
  | { state: SteerOutcome; messageId?: string }
  | { state: "failed" };

export interface SteerSink {
  taken: (sessionKey: string, item: SteerItem) => void;
  returned: (sessionKey: string, item: SteerItem) => void;
}

interface Pending extends SteerItem {
  forwarded: boolean;
}

interface Target {
  forward: ((item: SteerItem) => void) | null;
}

const targets = new Map<string, Target>();
const queues = new Map<string, Pending[]>();
/** What became of each offered message, for the sender that asks later. Pruned by age. */
const states = new Map<string, { sessionKey: string; at: number; s: SteerState }>();
const STATE_TTL_MS = 6 * 60 * 60_000;
let sink: SteerSink | null = null;

/** The chat route's hands: it writes the rows and sends the returned messages. */
export function setSteerSink(next: SteerSink | null): void {
  sink = next;
}

function prune(now: number): void {
  for (const [id, v] of states) {
    if (now - v.at > STATE_TTL_MS) states.delete(id);
  }
}

function setState(sessionKey: string, id: string, s: SteerState): void {
  const now = Date.now();
  prune(now);
  states.set(id, { sessionKey, at: now, s });
}

/** A running turn on this session takes messages. */
export function steerOpen(sessionKey: string): boolean {
  return targets.has(sessionKey);
}

/** Hands `text` to the turn running on `sessionKey`. Null when no turn there takes messages: the caller goes the usual way. */
export function offerSteer(sessionKey: string, text: string, meta: SteerMeta): SteerItem | null {
  const target = targets.get(sessionKey);
  if (!target) return null;
  const item: Pending = { id: `steer-${crypto.randomUUID()}`, text, meta, forwarded: false };
  queues.set(sessionKey, [...(queues.get(sessionKey) ?? []), item]);
  setState(sessionKey, item.id, { state: "pending" });
  if (target.forward) { item.forwarded = true; target.forward(strip(item)); }
  return strip(item);
}

function strip(it: Pending | SteerItem): SteerItem {
  return { id: it.id, text: it.text, meta: it.meta };
}

function settle(sessionKey: string, items: SteerItem[], outcome: SteerOutcome): void {
  for (const it of items) {
    setState(sessionKey, it.id, { state: outcome });
    try {
      if (outcome === "taken") sink?.taken(sessionKey, it);
      else if (outcome === "returned") sink?.returned(sessionKey, it);
    } catch (err) {
      console.warn(`[steer] ${sessionKey} ${it.id}: the sink failed on ${outcome}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * The detached host took these. An id the queue does not know is a message
 * offered before a server restart: the journal carries it whole, so its row
 * is written all the same.
 */
export function steerTaken(sessionKey: string, items: SteerItem[]): void {
  const list = queues.get(sessionKey) ?? [];
  const ids = new Set(items.map((i) => i.id));
  const rest = list.filter((it) => !ids.has(it.id));
  if (rest.length > 0) queues.set(sessionKey, rest); else queues.delete(sessionKey);
  settle(sessionKey, items, "taken");
}

/**
 * The detached host ended and names what it never took. Only those the queue
 * does not hold any more (a server that restarted meanwhile) are handled
 * here; the others are the target's `close` to hand back. After a person's
 * Stop they are held, as `close` would hold them.
 */
export function steerLeftByHost(sessionKey: string, items: SteerItem[], stoppedByPerson = false): void {
  const known = new Set((queues.get(sessionKey) ?? []).map((it) => it.id));
  const orphans = items.filter((it) => !known.has(it.id) && steerState(sessionKey, it.id)?.state !== "taken");
  settle(sessionKey, orphans, stoppedByPerson ? "held" : "returned");
}

/** The route records the row a message became, so a later status answer can name it. */
export function noteSteerMessage(sessionKey: string, id: string, messageId: string): void {
  const st = states.get(id);
  if (st && st.sessionKey === sessionKey && st.s.state !== "pending") st.s = { ...st.s, messageId } as SteerState;
}

/** A returned message the route could not send after all its attempts. */
export function noteSteerFailed(sessionKey: string, id: string): void {
  setState(sessionKey, id, { state: "failed" });
}

export function steerState(sessionKey: string, id: string): SteerState | null {
  const st = states.get(id);
  return st && st.sessionKey === sessionKey ? st.s : null;
}

export interface SteerTarget {
  /**
   * The detached turn's control channel: every message waiting and every
   * later one goes there, and the host acknowledges through `steerTaken`.
   */
  forwardTo: (forward: (item: SteerItem) => void) => void;
  /** In-process: what is waiting, taken now, oldest first. */
  take: () => string[];
  /**
   * The turn is over. What it did not take is handed back, held after a
   * person's Stop, and unknown when the detached host had it and its journal
   * ended before saying whether it took it.
   */
  close: (how?: { stoppedByPerson?: boolean; journalLost?: boolean }) => void;
}

/**
 * Opens the session to steering for the length of one turn. A second open on
 * the same session replaces the first (a turn that started over a stale one).
 */
export function openSteerTarget(sessionKey: string): SteerTarget {
  const target: Target = { forward: null };
  targets.set(sessionKey, target);
  return {
    forwardTo(forward) {
      if (targets.get(sessionKey) !== target) return;
      target.forward = forward;
      for (const it of queues.get(sessionKey) ?? []) {
        if (!it.forwarded) { it.forwarded = true; forward(strip(it)); }
      }
    },
    take() {
      if (targets.get(sessionKey) !== target) return [];
      const list = queues.get(sessionKey) ?? [];
      queues.delete(sessionKey);
      settle(sessionKey, list.map(strip), "taken");
      return list.map((it) => it.text);
    },
    close(how = {}) {
      if (targets.get(sessionKey) !== target) return;
      targets.delete(sessionKey);
      const left = queues.get(sessionKey) ?? [];
      queues.delete(sessionKey);
      if (how.stoppedByPerson) { settle(sessionKey, left.map(strip), "held"); return; }
      const unknown = how.journalLost ? left.filter((it) => it.forwarded) : [];
      settle(sessionKey, unknown.map(strip), "unknown");
      settle(sessionKey, left.filter((it) => !unknown.includes(it)).map(strip), "returned");
    },
  };
}

/** For tests: forget every target, queue and state (the sink stays: the route installs it once). */
export function resetTurnSteer(): void {
  targets.clear();
  queues.clear();
  states.clear();
}
