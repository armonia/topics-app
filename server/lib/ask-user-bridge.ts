/**
 * In-process rendez-vous for the `mcp__topics__ask_user_question` bridge tool.
 *
 * WHY this exists: Topics spawns the Claude Code CLI headless (`--print`
 * stream-json). Its built-in `AskUserQuestion` IS registered there (measured on
 * CLI 2.1.285, 29/09), but it goes through the permission channel and returns
 * "The user did not answer the questions." the moment the permission is
 * granted: 9 built-in questions out of 9 died that way between 08/08 and 29/09.
 * So Topics disallows the built-in (`HEADLESS_DISALLOWED_TOOLS` in
 * `providers/claude/args.ts`) and re-exposes the same contract as an MCP bridge
 * tool. An MCP tool call is executed by the CLI against the bridge subprocess
 * and the CLI blocks on the bridge's JSON-RPC RESPONSE, so the bridge handler
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
 *
 * NO CLOCK ENDS A QUESTION. A question ends because the human answers it,
 * cancels it (Stop), or sends a new message instead; never because time passed.
 * This module is in memory and dies with the process, so it is NOT where a
 * question lives: the row does (`waiting_for_input` on the tool call). When the
 * process that asked is gone the answer is delivered as the next user message,
 * with the question quoted (`lib/question-outlives-asker.ts`).
 */

import { emitHumanHoldChange } from './human-hold-events';

export interface AskUserBridgeOptions {
  /** How long THIS wait blocks before giving up (ms). One poll leg, not the ask. */
  timeoutMs?: number;
  /** How long a delivered-but-unclaimed answer stays buffered (ms). */
  bufferTtlMs?: number;
  /**
   * Called when a buffered answer outlives `bufferTtlMs` with no leg having
   * claimed it: the process that asked is gone, and the caller delivers the
   * answer another way (the next user message, `lib/question-outlives-asker.ts`) instead
   * of letting it vanish. Not called when a leg claims it or a cancel drops it.
   */
  onUnclaimed?: (answers: Record<string, string>) => void;
  /**
   * THE PANEL THIS WAIT IS ABOUT: the id of the `tool_use` row the question was
   * painted on. Declared by a caller that KNOWS it (the outbound gate paints the
   * panel itself, so it does); absent from a caller that does not, and then the
   * open wait answers for whatever panel the person clicked - see
   * `openAskIdentity`.
   */
  toolCallId?: string;
  /**
   * The question texts this wait (or this answer) is about, in order. The
   * generic leg cannot name its row, but it knows what it asked: that is what
   * binds a buffered answer to the leg that may collect it
   * (`bufferedAnswerFits`), and what lets the answer route tell the open
   * question from an older panel still on screen.
   */
  questions?: readonly string[];
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
// timeout and cheap enough to repeat for as long as the human takes.
const DEFAULT_TIMEOUT_MS = 25 * 1000;

/**
 * The same leg, for a caller that has to spend one WITHOUT registering a waiter:
 * the ask route, when the card is held by another request of this very session
 * and registering here would supersede it.
 */
export const ASK_LEG_MS = DEFAULT_TIMEOUT_MS;

/**
 * THE LONGEST WAIT A JAVASCRIPT TIMER HONOURS (2^31 - 1 ms, about 24.8 days).
 *
 * Not a lifetime for the question: nothing in Topics closes a question on time
 * (the 24-hour TTL that lived here was removed on 29/09, "a question that
 * expires makes no sense"). It is the ceiling of the TRANSPORT that carries the
 * wait: the CLI hands `MCP_TOOL_TIMEOUT` to a `setTimeout`, and a larger value
 * overflows to 1 ms in Node and Bun, which would kill every call at once. So the
 * CLI's patience with the bridge call is set to exactly this, and the bridge's
 * own leg budget sits above it (`ASK_MAX_LEGS`). Even past it the question is
 * not lost: the row keeps it, and the answer reaches the model as the next
 * message (`lib/question-outlives-asker.ts`).
 */
export const ASK_TRANSPORT_CEILING_MS = 2_147_483_647;

/**
 * How long a delivered-but-unclaimed answer waits for the bridge's next leg.
 *
 * It must outlast the longest gap the bridge can leave between two legs and
 * still come back: its transport grace (`ASK_TRANSPORT_GRACE_MS`, 90 s, the
 * window it keeps retrying through a server restart) plus one leg. Past that
 * the asker is not coming back, and the answer is handed to `onUnclaimed`
 * (delivery as the next message) instead of being dropped, which is what the 30-second
 * buffer used to do in silence. The invariant is tested in
 * `topics-mcp-server.test.ts`.
 */
export const ASK_BUFFER_TTL_MS = 2 * 60 * 1000;

interface Waiter {
  resolve: (answers: Record<string, string>) => void;
  reject: (err: AskWaitError) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BufferedAnswer {
  answers: Record<string, string>;
  timer: ReturnType<typeof setTimeout>;
  /** The panel this answer was given on, when the route knew it. */
  toolCallId?: string;
  /** The questions this answer answers, when the route knew them. */
  questions?: readonly string[];
  /** Where the answer goes if no leg of its question ever collects it. */
  onUnclaimed?: (answers: Record<string, string>) => void;
}


const waiters = new Map<string, Waiter>();
const buffered = new Map<string, BufferedAnswer>();
/**
 * Asks that are OPEN — the panel is on screen and nobody has answered or
 * cancelled it. Separate from `waiters` on purpose: with a polling bridge there
 * are millisecond gaps between legs where no waiter is registered, and during
 * those gaps the ask is still very much pending. Anything reasoning about "is a
 * question on screen right now?" (the turn watchdog, the tool-response route)
 * must read THIS, not the waiter map. The value carries when the ask opened
 * (the age the safety nets read, never a deadline) and which panel the current
 * wait is about.
 */
const activeAsks = new Map<string, OpenAsk>();

interface OpenAsk {
  /** When the ask opened, so its age spans the ask and not a single leg. */
  startedAt: number;
  /**
   * The tool row the panel of THIS question sits on, when the wait that owns the
   * rendez-vous declared one. See `openAskIdentity` for what reads it.
   */
  toolCallId?: string;
  /** What the current wait asked, when it said so. See `AskUserBridgeOptions.questions`. */
  questions?: readonly string[];
}

/**
 * Open an ask, or confirm the one already open. Called at the top of every poll
 * leg: the FIRST leg opens it (and stamps when it opened), later legs are
 * no-ops, so the age keeps counting from the question and not from the leg.
 *
 * There is no expiry: an ask open for a day, or a week, is still open. It ends
 * when somebody answers, cancels, or sends a new message (see the header).
 */
export function beginAsk(sessionKey: string, now = Date.now()): void {
  if (activeAsks.has(sessionKey)) return;
  activeAsks.set(sessionKey, { startedAt: now });
  // From here the turn is parked on a person. Whoever watches the BOARD cannot
  // tell by itself: the task would stay `working` under an open panel. See
  // human-hold-events.ts.
  emitHumanHoldChange({ sessionKey, phase: "held", source: "ask", id: `ask:${now}` });
}

/** Close an ask: answered or cancelled. Idempotent. */
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

  // Answer already delivered before the waiter registered, and given to THIS
  // question. An answer bound to another question stays where it is: its TTL
  // hands it on as a message, it never becomes this leg's result.
  const buf = buffered.get(sessionKey);
  if (buf && bufferedAnswerFits(buf, opts)) {
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

  // THE WAIT THAT OWNS THE RENDEZ-VOUS NAMES ITS PANEL, and the name outlives
  // the leg: a polling bridge spends a sliver of every cycle with no waiter
  // registered, and an answer that lands in that sliver is buffered for the next
  // leg. If the identity lived on the waiter, that answer would be matched
  // against nothing. It lives on the ask, which is the thing on screen.
  //
  // A wait WITHOUT an identity clears it, and that is the fallback branch on
  // purpose: from here the caller is saying "the open question is mine and I
  // cannot name its row", so the answer goes to it whatever panel it came from.
  // That is the pre-existing behaviour and it stays true for the one caller in
  // that shape (the generic ask leg, `routes/permission.ts`), which only reaches
  // the wait when NO send confirmation of this session holds the gate's lock -
  // so the question it owns is the only one that can be waiting.
  const open = activeAsks.get(sessionKey);
  if (open) {
    if (opts.toolCallId) open.toolCallId = opts.toolCallId;
    else delete open.toolCallId;
    if (opts.questions && opts.questions.length > 0) open.questions = [...opts.questions];
    else delete open.questions;
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
 * What the open ask of this session is about: the panel its wait named and the
 * questions it asked, or `undefined` when no ask is open. The answer route reads
 * both to bind a click to ITS question (`routeAnswer` in
 * `lib/question-outlives-asker.ts`).
 *
 * WHY. The rendez-vous is keyed by SESSION, and the click's `toolCallId` used
 * to decide only WHETHER the row is a bridge panel, never FOR WHICH question:
 * with a send confirmation waiting and the generic question's panel on screen,
 * the yes given to the generic one went to the send, which refused it, and the
 * generic question stayed unanswered. The board road has the same rule
 * (`answerTo`, `routes/tasks.ts`): the yes belongs to THAT question.
 */
export function openAskIdentity(sessionKey: string): { toolCallId?: string; questions?: readonly string[] } | undefined {
  const open = activeAsks.get(sessionKey);
  return open ? { toolCallId: open.toolCallId, questions: open.questions } : undefined;
}

/** Same questions, same order, compared as the panel shows them (trimmed). */
export function sameQuestions(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((q, i) => q.trim() === b[i]!.trim());
}

/**
 * May a leg with this identity collect this buffered answer?
 *
 * An answer given with no identity (the board thread, an older caller) goes to
 * whoever comes, as it always did. An answer bound to a panel goes only to the
 * wait that names that panel or, for a wait that cannot name its row, to one
 * that asked the same questions. Until 30/09 the buffer was per SESSION: an
 * answer to an old question whose asker had gone became the tool result of the
 * next question the same session asked within two minutes.
 */
export function bufferedAnswerFits(
  buf: { toolCallId?: string; questions?: readonly string[] },
  leg: { toolCallId?: string; questions?: readonly string[] },
): boolean {
  if (!buf.toolCallId && !buf.questions) return true;
  if (leg.toolCallId && buf.toolCallId) return leg.toolCallId === buf.toolCallId;
  if (leg.questions && buf.questions) return sameQuestions(leg.questions, buf.questions);
  // One side cannot say: the legacy behaviour, a leg with no identity at all.
  return !leg.toolCallId && !leg.questions;
}

/**
 * What the chat says to somebody who answered a panel that is not the question
 * waiting right now - an old turn's, or one already answered.
 *
 * Its twin on the board road is `DEAD_QUESTION_LINE` in `board-ask-routing.ts`,
 * and it says the same two things: nothing was delivered, and nothing was sent.
 * Silence here is what made the defect expensive - the person had every reason
 * to believe they had answered.
 */
export const ASK_NOT_CURRENT_LINE =
  "Questa risposta era per una domanda che non e' quella aperta adesso in questa chat: non e' stata consegnata e non e' partito niente.";

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
  // handler that registers a beat later) still gets it. If no leg ever comes,
  // the answer is handed to `onUnclaimed` rather than dropped: an answer that
  // disappears is the one failure a person cannot see and cannot repair.
  const ttl = opts.bufferTtlMs ?? ASK_BUFFER_TTL_MS;
  const prev = buffered.get(sessionKey);
  if (prev) {
    clearTimeout(prev.timer);
    // An answer to ANOTHER question waiting here is not overwritten into
    // nothing: its asker never came for it, so it goes on its other way now.
    const sameQuestion = bufferedAnswerFits(prev, { toolCallId: opts.toolCallId, questions: opts.questions })
      && bufferedAnswerFits({ toolCallId: opts.toolCallId, questions: opts.questions }, prev);
    if (!sameQuestion) prev.onUnclaimed?.(prev.answers);
  }
  const entry: BufferedAnswer = {
    answers,
    ...(opts.onUnclaimed ? { onUnclaimed: opts.onUnclaimed } : {}),
    ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
    ...(opts.questions && opts.questions.length > 0 ? { questions: [...opts.questions] } : {}),
    timer: setTimeout(() => {
      if (buffered.get(sessionKey) !== entry) return;
      buffered.delete(sessionKey);
      opts.onUnclaimed?.(answers);
    }, ttl),
  };
  buffered.set(sessionKey, entry);
  return true;
}

/**
 * Drop the buffered answer of this session WITHOUT handing it on: a leg just
 * collected the same answer another way (off the row, `routes/permission.ts`).
 * Left armed, the buffer outlived that leg and, two minutes later, sent the
 * answer to the model a second time as a message nobody typed.
 */
export function forgetBufferedAnswer(
  sessionKey: string,
  leg: { toolCallId?: string; questions?: readonly string[] } = {},
): void {
  const buf = buffered.get(sessionKey);
  // Only the copy of the answer that leg collected: an answer to another
  // question of the session stays owed.
  if (!buf || !bufferedAnswerFits(buf, leg)) return;
  clearTimeout(buf.timer);
  buffered.delete(sessionKey);
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
 * What gives the sweeper its teeth back is the child's liveness
 * (`pendingAskVerdict`), never this age: the age is for display and logs.
 */
export function pendingAskAgeMs(sessionKey: string, now = Date.now()): number | null {
  const open = activeAsks.get(sessionKey);
  return open === undefined ? null : now - open.startedAt;
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
 *   - `"close-ask"` the WAIT can no longer be honoured: the child died under
 *                  it. Cancel the in-memory ask and let the turn be finalized;
 *                  the question itself survives on its row and its answer
 *                  goes out as the next message (`lib/question-outlives-asker.ts`). This
 *                  is the branch that keeps `defer` from being permanent:
 *                  with a dead child no further poll leg arrives.
 *
 * The age is NOT a reason. A question open for 25 hours on a live child is
 * deferred like one open for 25 seconds (29/09: "a question that expires makes
 * no sense").
 *
 * `childAlive: undefined` means the provider can't say; that's treated as
 * alive, because killing a healthy parked turn is the failure we're fixing and
 * guessing "dead" would reintroduce it.
 */
export function pendingAskVerdict(opts: {
  askAgeMs: number | null;
  childAlive?: boolean;
}): "none" | "defer" | "close-ask" {
  if (opts.askAgeMs === null) return "none";
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

/**
 * What a process restart does to this module: every map emptied, no waiter
 * told, nothing announced, no buffered answer handed on. For the tests that
 * cross that boundary (a question must survive it on its row); production
 * never calls it, a restart does it for real.
 */
export function _dropAskStateLikeARestart(): void {
  for (const w of waiters.values()) clearTimeout(w.timer);
  for (const b of buffered.values()) clearTimeout(b.timer);
  waiters.clear();
  buffered.clear();
  activeAsks.clear();
}
