/**
 * In-process rendez-vous for the `mcp__topics__ask_user_question` bridge tool.
 *
 * WHY this exists: the Claude Code CLI only registers its built-in
 * `AskUserQuestion` tool in INTERACTIVE mode. Topics spawns the CLI headless
 * (`--print` stream-json), where that tool is absent — so a native chat could
 * never render the clickable question panel the CLI users get. Topics re-exposes
 * the same contract as an MCP bridge tool. But an MCP tool call is executed by
 * the CLI against the bridge subprocess and the CLI blocks on the bridge's
 * JSON-RPC RESPONSE (not on stdin, unlike the built-in). So the bridge handler
 * must itself block until the human answers, then return the answer as its tool
 * result. This module is the hand-off point between:
 *
 *   - the bridge handler (blocks in `POST /api/mcp/ask-user`, calling `waitForAnswer`)
 *   - the chat UI answer (`POST /api/chat/tool-response`, calling `deliverAnswer`)
 *
 * Both are keyed by `sessionKey`: the CLI blocks the turn on a single
 * `ask_user_question` call, so there is at most one outstanding ask per session.
 *
 * The two sides can arrive in either order (the bridge POST fires the instant
 * the model calls the tool; the human answers seconds later — but a reload or a
 * fast test can invert that), so a short-lived answer BUFFER makes the rendez-
 * vous race-free in both directions.
 */

import { emitHumanHoldChange } from './human-hold-events';

export interface AskUserBridgeOptions {
  /** How long THIS wait blocks before giving up (ms). One poll leg, not the ask. */
  timeoutMs?: number;
  /** How long a delivered-but-unclaimed answer stays buffered (ms). */
  bufferTtlMs?: number;
}

/**
 * Why a wait ended without an answer. The route needs to tell these apart:
 * `timeout` is a poll leg expiring (answer with `pending`, the bridge comes
 * straight back), while `cancelled`/`superseded` mean the ask itself is over
 * and the bridge must surface a tool error.
 */
export type AskWaitFailure = "timeout" | "cancelled" | "superseded";

export class AskWaitError extends Error {
  constructor(public readonly code: AskWaitFailure, message: string) {
    super(message);
    this.name = "AskWaitError";
  }
}

// One POLL LEG, not the ask. Measured the hard way: the first live question
// died after minutes with "socket connection error" — a single HTTP request
// held open with zero bytes flowing is exactly what an idle-socket timeout is
// built to kill, and no server-side patience can save it, because the socket
// dies on the CLIENT side. So the bridge polls: short legs that always come
// back, re-armed immediately. 25s is comfortably under any default idle
// timeout and cheap enough to repeat for an hour and a half.
const DEFAULT_TIMEOUT_MS = 25 * 1000;

// IL TEMPO NON È UN MOTIVO PER CHIUDERE UNA DOMANDA.
//
// Questo numero è stato 10 minuti (una domanda fatta alle 12:55 era morta
// prima che qualcuno tornasse da pranzo) e poi 90 minuti — scelto non perché
// un'ora e mezza volesse dire qualcosa, ma perché doveva stare SOTTO il tetto
// di vita del figlio CLI (MAX_LIFETIME_MS, 2 h). Era un limite ereditato da un
// altro limite, e in mezzo c'è una persona: chi lascia il computer alle sei e
// risponde la mattina dopo trovava il pannello morto e un turno chiuso da un
// «cancelled» che non aveva scelto nessuno. Una domanda che scade non ha senso.
//
// Adesso il tetto di vita si RIARMA finché un pannello è a schermo
// (`armTurnDeadline` in claude-code.ts), quindi questo numero non è più
// costretto da niente. Una domanda finisce per un MOTIVO: qualcuno risponde, il
// turno viene interrotto, o il figlio sotto il pannello muore — ed è
// `pendingAskVerdict` (childAlive === false) a vederlo, non un orologio.
//
// Resta una cifra sola perché serve un fondo contro le PERDITE: se una voce di
// `activeAsks` sopravvivesse a tutti i suoi guardiani, senza tetto terrebbe in
// piedi per sempre le esenzioni che si appoggiano a `hasPendingAsk`. 24 ore
// sono oltre qualunque attesa umana reale e chiudono comunque il cerchio.
const DEFAULT_ASK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The ask TTL, for callers that must reason about the SAME window from
 * outside — notably the stale-stream sweeper, which has to know how long a
 * silent-by-design turn is allowed to stay silent.
 */
export const ASK_TTL_MS = DEFAULT_ASK_TTL_MS;

const DEFAULT_BUFFER_TTL_MS = 30 * 1000; // answer that beat the waiter

interface Waiter {
  resolve: (answers: Record<string, string>) => void;
  reject: (err: AskWaitError) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BufferedAnswer {
  answers: Record<string, string>;
  timer: ReturnType<typeof setTimeout>;
}

const waiters = new Map<string, Waiter>();
const buffered = new Map<string, BufferedAnswer>();
/**
 * Asks that are OPEN — the panel is on screen and nobody has answered or
 * cancelled it. Separate from `waiters` on purpose: with a polling bridge there
 * are millisecond gaps between legs where no waiter is registered, and during
 * those gaps the ask is still very much pending. Anything reasoning about "is a
 * question on screen right now?" (the turn watchdog, the tool-response route)
 * must read THIS, not the waiter map. Value = when the ask opened, so the TTL
 * spans the whole ask rather than restarting on every leg.
 */
const activeAsks = new Map<string, number>();

/**
 * Open an ask, or confirm the one already open. Called at the top of every poll
 * leg: the FIRST leg opens it (and stamps the TTL clock), later legs are no-ops
 * so a poll every 25 seconds can't keep an ask alive forever.
 *
 * Returns false when the ask has outlived `ttlMs` — the caller then cancels it
 * and reports a clean expiry instead of polling into the CLI child's death.
 */
export function beginAsk(sessionKey: string, ttlMs = DEFAULT_ASK_TTL_MS, now = Date.now()): boolean {
  const startedAt = activeAsks.get(sessionKey);
  if (startedAt === undefined) {
    activeAsks.set(sessionKey, now);
    // Da qui in poi il turno è fermo su una persona. Chi guarda la BOARD non ha
    // modo di accorgersene da sé: il task resterebbe `working` sotto un pannello
    // aperto. Vedi human-hold-events.ts.
    emitHumanHoldChange({ sessionKey, phase: "held", source: "ask" });
    return true;
  }
  return now - startedAt < ttlMs;
}

/** Close an ask: answered, cancelled, or expired. Idempotent. */
export function endAsk(sessionKey: string): void {
  // Solo se c'era davvero un'attesa: un `released` a vuoto farebbe rimettere il
  // chip a «in corso» su una sessione che non ha mai smesso di esserlo.
  if (activeAsks.delete(sessionKey)) {
    emitHumanHoldChange({ sessionKey, phase: "released", source: "ask" });
  }
}

/**
 * Called by the bridge tool handler, once per poll leg. Resolves with the
 * human's answers when they arrive, or rejects with an `AskWaitError` whose
 * `code` says why: `timeout` (this leg expired — come straight back),
 * `cancelled`, or `superseded`. If the answer already landed while no leg was
 * registered, resolves immediately from the buffer. A second ask for the same
 * session supersedes the first — the CLI only blocks on one at a time, so a
 * lingering waiter is stale.
 */
export function waitForAnswer(
  sessionKey: string,
  opts: AskUserBridgeOptions = {},
): Promise<Record<string, string>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Answer already delivered before the waiter registered.
  const buf = buffered.get(sessionKey);
  if (buf) {
    clearTimeout(buf.timer);
    buffered.delete(sessionKey);
    return Promise.resolve(buf.answers);
  }

  // Supersede any stale waiter for this session.
  const existing = waiters.get(sessionKey);
  if (existing) {
    clearTimeout(existing.timer);
    waiters.delete(sessionKey);
    existing.reject(new AskWaitError("superseded", "ask_user_question: superseded by a newer question"));
  }

  return new Promise<Record<string, string>>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(sessionKey);
      reject(new AskWaitError("timeout", "ask_user_question: poll leg expired"));
    }, timeoutMs);
    waiters.set(sessionKey, { resolve, reject, timer });
  });
}

/**
 * Called by the tool-response route when the human submits. Returns true if a
 * blocked bridge handler (or a soon-to-register one, via the buffer) will pick
 * the answer up — i.e. this session's pending tool is the bridge ask, not the
 * built-in stdin path. Returns false when there is nothing to deliver to (the
 * caller then falls back to the provider stdin path).
 */
export function deliverAnswer(
  sessionKey: string,
  answers: Record<string, string>,
  opts: AskUserBridgeOptions = {},
): boolean {
  // The ask is over either way — whoever picks the answer up, nobody should
  // still consider a question to be on screen for this session.
  endAsk(sessionKey);
  const w = waiters.get(sessionKey);
  if (w) {
    clearTimeout(w.timer);
    waiters.delete(sessionKey);
    w.resolve(answers);
    return true;
  }
  // No waiter registered right now — the normal case in a polling bridge, which
  // spends a sliver of every cycle between legs. Buffer so the next leg (or a
  // handler that registers a beat later) still gets it.
  const ttl = opts.bufferTtlMs ?? DEFAULT_BUFFER_TTL_MS;
  const prev = buffered.get(sessionKey);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => buffered.delete(sessionKey), ttl);
  buffered.set(sessionKey, { answers, timer });
  return true;
}

/**
 * True when a question is ON SCREEN for this session and still unanswered.
 *
 * Deliberately reads `activeAsks`, not `waiters`: a polling bridge has no
 * waiter registered during the hop between legs, and answering "no question
 * pending" in that sliver would send the turn watchdog after a healthy turn and
 * route the human's answer down the stdin path.
 */
export function hasPendingAsk(sessionKey: string): boolean {
  return activeAsks.has(sessionKey);
}

/**
 * Every session with a question open right now, for whoever has to reason
 * about ALL of them instead of one: the restart gate, which must not cut a
 * panel somebody was about to answer.
 *
 * This map is the FAST path there and never the only one. It empties on every
 * restart while the child keeps polling and the row on disk still carries the
 * open question, so a caller that stops here protects the first question and
 * none of those that survived an earlier restart.
 */
export function pendingAskKeys(): string[] {
  return [...activeAsks.keys()];
}

/**
 * How long the open ask has been on screen, or `null` if none is open.
 *
 * `hasPendingAsk` answers "is there a question?"; this answers "and for how
 * long?", which is what anyone SUPPRESSING a safety net needs to know. The
 * stale-stream sweeper is the case: it must not kill a turn that is silent
 * because it's waiting on a human, but it must not be suppressed forever
 * either — if the CLI child dies while the panel is up, no further poll leg
 * ever arrives, so nothing inside this module would notice the ask is moot.
 * Bounding the exemption by this age gives the sweeper its teeth back.
 */
export function pendingAskAgeMs(sessionKey: string, now = Date.now()): number | null {
  const startedAt = activeAsks.get(sessionKey);
  return startedAt === undefined ? null : now - startedAt;
}

/**
 * What a stale-turn sweeper should do about the ask on this session.
 *
 * Pulled out as a pure rule, like `turnWatchdogDecision` in the provider, so
 * it can be tested without a stream map and a CLI child:
 *
 *   - `"none"`     no question is open — the sweeper's normal rules apply.
 *   - `"defer"`    the silence is the question. Push the activity clock
 *                  forward instead of declaring the turn dead: the child is
 *                  blocked on the bridge's JSON-RPC response and produces
 *                  nothing by design until the human clicks.
 *   - `"close-ask"` the question can no longer be honoured — the child died
 *                  under it, or it has outlived its TTL. Cancel it (so anyone
 *                  blocked fails cleanly) and let the turn be finalized. This
 *                  is the branch that keeps `defer` from being permanent: with
 *                  a dead child no further poll leg arrives, so nothing else
 *                  in this module would ever notice the ask is moot.
 *
 * `childAlive: undefined` means the provider can't say; that's treated as
 * alive, because killing a healthy parked turn is the failure we're fixing and
 * guessing "dead" would reintroduce it.
 */
export function pendingAskVerdict(opts: {
  askAgeMs: number | null;
  askTtlMs?: number;
  childAlive?: boolean;
}): "none" | "defer" | "close-ask" {
  if (opts.askAgeMs === null) return "none";
  if (opts.askAgeMs >= (opts.askTtlMs ?? DEFAULT_ASK_TTL_MS)) return "close-ask";
  if (opts.childAlive === false) return "close-ask";
  return "defer";
}

/**
 * Drop any waiter/buffer for a session (turn aborted / session torn down) so a
 * blocked handler unblocks with an error instead of hanging to timeout.
 */
export function cancelAsk(sessionKey: string, reason = "cancelled"): void {
  endAsk(sessionKey);
  const w = waiters.get(sessionKey);
  if (w) {
    clearTimeout(w.timer);
    waiters.delete(sessionKey);
    w.reject(new AskWaitError("cancelled", `ask_user_question: ${reason}`));
  }
  const buf = buffered.get(sessionKey);
  if (buf) {
    clearTimeout(buf.timer);
    buffered.delete(sessionKey);
  }
}
