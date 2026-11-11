/**
 * A MESSAGE WRITTEN WHILE A NATIVE TURN RUNS REACHES THAT TURN.
 *
 * On 2026-11-11 Attilio wrote a second message in a Discord thread while
 * Jarvis was working on the first: the chat route answered `stream_in_flight`
 * and the message waited for the end of the turn, minutes later. OpenClaw
 * "steers" instead: the message joins the running turn at its next round.
 *
 * Here a running native turn opens a TARGET for its session. The chat route
 * offers a message to it (`offerSteer`); the agent loop takes what is waiting
 * at its next round boundary (after the tool results, before the next model
 * call) and appends it to the history as the person's words. A detached turn
 * (`turn-host.ts`) gets the message over its control channel and says on its
 * journal which ones it took (`steerTaken`).
 *
 * NOTHING IS LOST. A message the turn did not take before it ended is handed
 * back (`returned`) and the route sends it as an ordinary turn of its own.
 *
 * In memory, per process: a restart drops the queue together with the HTTP
 * requests that filled it, and their senders still hold the message.
 */

export interface SteerItem {
  id: string;
  text: string;
}

export type SteerOutcome = "taken" | "returned";

export type SteerState =
  | { state: "pending" }
  | { state: "taken"; messageId?: string }
  | { state: "returned"; messageId?: string };

interface Pending extends SteerItem {
  forwarded: boolean;
  settle: (outcome: SteerOutcome) => void;
}

interface Target {
  forward: ((item: SteerItem) => void) | null;
}

const targets = new Map<string, Target>();
const queues = new Map<string, Pending[]>();
/** What became of each offered message, for the sender that asks later. Pruned by age. */
const states = new Map<string, { sessionKey: string; at: number; s: SteerState }>();
const STATE_TTL_MS = 6 * 60 * 60_000;

function prune(now: number): void {
  for (const [id, v] of states) {
    if (now - v.at > STATE_TTL_MS) states.delete(id);
  }
}

/** A running turn on this session takes messages. */
export function steerOpen(sessionKey: string): boolean {
  return targets.has(sessionKey);
}

/**
 * Hands `text` to the turn running on `sessionKey`. Null when no turn there
 * takes messages: the caller goes the usual way. `outcome` settles once, when
 * the loop took it or when the turn ended without taking it.
 */
export function offerSteer(sessionKey: string, text: string): { id: string; outcome: Promise<SteerOutcome> } | null {
  const target = targets.get(sessionKey);
  if (!target) return null;
  const id = `steer-${crypto.randomUUID()}`;
  let settle!: (o: SteerOutcome) => void;
  const outcome = new Promise<SteerOutcome>((r) => { settle = r; });
  const item: Pending = { id, text, forwarded: false, settle };
  queues.set(sessionKey, [...(queues.get(sessionKey) ?? []), item]);
  const now = Date.now();
  prune(now);
  states.set(id, { sessionKey, at: now, s: { state: "pending" } });
  if (target.forward) { item.forwarded = true; target.forward({ id, text }); }
  return { id, outcome };
}

function settleItems(items: Pending[], outcome: SteerOutcome): void {
  for (const it of items) {
    const st = states.get(it.id);
    if (st) st.s = { state: outcome };
    it.settle(outcome);
  }
}

/** The detached host took these: they leave the queue as taken. */
export function steerTaken(sessionKey: string, ids: string[]): void {
  const list = queues.get(sessionKey);
  if (!list) return;
  const taken = list.filter((it) => ids.includes(it.id));
  const rest = list.filter((it) => !ids.includes(it.id));
  if (rest.length > 0) queues.set(sessionKey, rest); else queues.delete(sessionKey);
  settleItems(taken, "taken");
}

/** The route records the row a message became, so a later status answer can name it. */
export function noteSteerMessage(id: string, messageId: string): void {
  const st = states.get(id);
  if (st && st.s.state !== "pending") st.s = { ...st.s, messageId };
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
  /** The turn is over: whatever it did not take is handed back. */
  close: () => void;
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
        if (!it.forwarded) { it.forwarded = true; forward({ id: it.id, text: it.text }); }
      }
    },
    take() {
      if (targets.get(sessionKey) !== target) return [];
      const list = queues.get(sessionKey) ?? [];
      queues.delete(sessionKey);
      settleItems(list, "taken");
      return list.map((it) => it.text);
    },
    close() {
      if (targets.get(sessionKey) !== target) return;
      targets.delete(sessionKey);
      const left = queues.get(sessionKey) ?? [];
      queues.delete(sessionKey);
      settleItems(left, "returned");
    },
  };
}

/** For tests: forget every target, queue and state. */
export function resetTurnSteer(): void {
  for (const sk of [...targets.keys()]) targets.delete(sk);
  queues.clear();
  states.clear();
}
