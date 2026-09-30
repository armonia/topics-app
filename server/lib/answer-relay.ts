/**
 * AN ANSWER WHOSE ASKER IS GONE IS OWED TO THE MODEL UNTIL IT GETS THERE, AND
 * IT GETS THERE BEFORE ANYTHING THE PERSON WROTE AFTER IT.
 *
 * A question outlives the process that asked it (`lib/question-outlives-asker.ts`):
 * when the person answers it, the answer reaches the model as the next user
 * message, with the question quoted. Until 30/09 that message was sent once,
 * with a ten-minute retry on the chat route's 409: an answer given while a
 * machine turn ran on the session (the dispatcher relaunching a card after a
 * restart, a goal nudge) met `stream_in_flight` on every try, was dropped with
 * one `console.warn`, and the panel said "answered" all the same.
 *
 * Here the answer is QUEUED, not tried:
 *
 *   - the row says so first (`answerRelay: 'queued'` on the question's tool
 *     call, written by the route before anything is sent), so the panel shows
 *     an answer that is on its way and a restart finds it owed;
 *   - it waits for the session to be free, with no cap, and "free" is the
 *     server's own signal (`lib/turn-ended.ts`), not a clock: the moment a
 *     turn ends the relay posts, and a 409 `stream_in_flight` (somebody else
 *     got in first) or any other refusal leaves it owed to the next turn end;
 *   - ORDER is the chat route's, not a race: the route TAKES the owed answers
 *     of the session (`claim` for the relay's own post, `takeOwed` for a
 *     message the person typed) at the moment it writes the user row. A
 *     person's message that reaches the route while an answer is owed carries
 *     that answer in front of it, as its own row first and first in the text
 *     the model reads. A 2-second poll used to lose that race to the
 *     composer, which drains its queue on `stream:end` (measured 30/09: the
 *     model read the person's later message before the answer given first);
 *   - taking is not delivering: the answers a message took travel with it
 *     (a `Carry`) until the turn that carries them has really started, which
 *     is the model's first event on it (`onFirstModelEvent`). Only then the
 *     row says `answerRelay: 'sent'`. A message that never started its turn
 *     (a refusal after the gate, a throw, a provider that failed before it
 *     heard anything) gives them back, at the head, and they stay owed to the
 *     next turn end: until 30/09 the row said `sent` as soon as the message
 *     was written, and a 409 after that lost the answer for good. One
 *     session's answers go in the order given.
 *
 * A restart empties this queue; the boot sweep reads the `queued` marks back
 * (`owedAnswerOf`) and puts them in it BEFORE the server listens, held until
 * the surviving turns are adopted (`hold`). So from the first request on, the
 * queue holds every answer the rows owe: a message that reaches the route
 * while the boot is still adopting carries them in front of itself, instead
 * of reaching the model before an answer the person gave before it.
 */
import { answerAsNextMessage, answersOf, questionTexts, type StoredQuestionCall } from "./question-outlives-asker";
import { onTurnEnded } from "./turn-ended";

/** An answer owed to the model, as the route or the boot sweep hands it over. */
export interface OwedAnswer {
  sessionKey: string;
  /** The question's tool call: the answer's identity from end to end. */
  toolCallId: string;
  /** The row carrying the tool call, where `answerRelay` is written. */
  rowId: string | null;
  /** The user message: the question quoted, the answer under it. */
  content: string;
}

/**
 * The answers one message of the chat route took, on their way to the model
 * with it. The route marks `turnStarted` when that message's stream starts;
 * the relay settles or gives them back, and only while they are still its
 * current carry (a late event of a closed turn cannot settle a later one).
 */
export interface Carry {
  sessionKey: string;
  /** Oldest first. */
  answers: OwedAnswer[];
  turnStarted: boolean;
}

type Route = (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null>;

export interface AnswerRelayDeps {
  /** A turn is in flight on the session: the answer waits for it to end. */
  isBusy: (sessionKey: string) => boolean;
  /** The chat route of this process. */
  route: Route;
  /** The model has the answer: the row stops owing it. */
  settle: (owed: OwedAnswer) => void;
  log?: (message: string) => void;
}

export interface AnswerRelay {
  /** Queue an owed answer. A second call for the same tool call is a no-op. */
  enqueue: (owed: OwedAnswer) => void;
  /**
   * The chat route, writing the relay's own message: is this answer still
   * owed? Taken out of the queue if so; `null` if a person's message already
   * carried it.
   */
  claim: (sessionKey: string, toolCallId: string) => Carry | null;
  /** The chat route, about to write a person's message: every answer the session owes, in order, taken. `null` when it owes none. */
  takeOwed: (sessionKey: string) => Carry | null;
  /** The turn that carries them has started (the model's first event): the rows say `sent`. */
  heard: (carry: Carry) => void;
  /** The message that took them ended without starting its turn: owed again, at the head, to the next turn end. */
  notCarried: (carry: Carry) => void;
  /**
   * Nothing is posted until the returned function is called; enqueuing and
   * taking go on. The boot loads the owed answers under a hold and releases
   * it once the surviving turns are adopted, so none is sent into a session
   * that only looks free.
   */
  hold: () => () => void;
  /** Resolves when no post is in flight. For tests and shutdown logs. */
  idle: () => Promise<void>;
}

export function createAnswerRelay(deps: AnswerRelayDeps): AnswerRelay {
  /** Per session, the answers still owed, oldest first. */
  const owedBySession = new Map<string, OwedAnswer[]>();
  /** Per session, the carries taken by the chat route and not settled yet. */
  const carrying = new Map<string, Carry[]>();
  /** Sessions with a post of the relay on its way to the chat route. */
  const posting = new Map<string, Promise<void>>();
  /** Answers whose delay was already logged, so a session that keeps refusing says it once. */
  const delayLogged = new Set<string>();
  let holds = 0;

  function logDelay(owed: OwedAnswer, why: string): void {
    if (delayLogged.has(owed.toolCallId)) return;
    delayLogged.add(owed.toolCallId);
    deps.log?.(`${owed.sessionKey} ${owed.toolCallId}: ${why}, the answer stays owed to the next turn end`);
  }

  async function post(owed: OwedAnswer): Promise<void> {
    const url = new URL("http://localhost/api/chat");
    const resp = await deps.route(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionKey: owed.sessionKey,
          messages: [{ role: "user", content: owed.content }],
          questionAnswer: { toolCallId: owed.toolCallId },
        }),
      }),
      url, "/api/chat", "POST",
    );
    if (resp?.ok) {
      // The route claimed it and runs the turn: the model's first event on it
      // settles it (`heard`), its end without one gives it back.
      const reader = resp.body?.getReader();
      if (reader) void (async () => { while (!(await reader.read()).done) { /* drain */ } })().catch(() => {});
      return;
    }
    const code = resp?.status === 409
      ? ((await resp.json().catch(() => null)) as { code?: unknown } | null)?.code
      : undefined;
    // Somebody else's turn got in first, or a person's message carried the
    // answer already (`answer_not_owed`): nothing to say.
    if (code === "stream_in_flight" || code === "answer_not_owed") return;
    logDelay(owed, `the chat route answered ${resp?.status ?? "nothing"}${code ? ` ${String(code)}` : ""}`);
  }

  /** Post the oldest answer the session owes, if the session is free and nothing of ours is on its way. */
  function pump(sessionKey: string): void {
    const head = owedBySession.get(sessionKey)?.[0];
    if (!head || holds > 0 || posting.has(sessionKey) || deps.isBusy(sessionKey)) return;
    const sending: Promise<void> = post(head)
      .catch((err) => { deps.log?.(`${sessionKey} ${head.toolCallId}: ${err instanceof Error ? err.message : String(err)}`); })
      .finally(() => { if (posting.get(sessionKey) === sending) posting.delete(sessionKey); });
    posting.set(sessionKey, sending);
  }

  function take(sessionKey: string, pick: (o: OwedAnswer) => boolean): Carry | null {
    const list = owedBySession.get(sessionKey);
    if (!list) return null;
    const answers = list.filter(pick);
    if (answers.length === 0) return null;
    const rest = list.filter((o) => !pick(o));
    if (rest.length > 0) owedBySession.set(sessionKey, rest); else owedBySession.delete(sessionKey);
    const carry: Carry = { sessionKey, answers, turnStarted: false };
    carrying.set(sessionKey, [...(carrying.get(sessionKey) ?? []), carry]);
    listen();
    return carry;
  }

  /** Take the carry out of the session's current ones; `false` if it is not among them any more. */
  function release(carry: Carry): boolean {
    const list = carrying.get(carry.sessionKey);
    if (!list?.includes(carry)) return false;
    const rest = list.filter((c) => c !== carry);
    if (rest.length > 0) carrying.set(carry.sessionKey, rest); else carrying.delete(carry.sessionKey);
    return true;
  }

  /** Back at the head of the queue, oldest first, ahead of whatever was queued since. */
  function giveBack(carry: Carry, why: string): void {
    if (!release(carry)) return;
    const queued = owedBySession.get(carry.sessionKey) ?? [];
    const back = carry.answers.filter((o) => !queued.some((q) => q.toolCallId === o.toolCallId));
    owedBySession.set(carry.sessionKey, [...back, ...queued]);
    for (const o of back) logDelay(o, why);
    listen();
  }

  /**
   * The turn of a session ended. A carry whose turn started and never heard
   * from the model goes back to the queue and waits for the NEXT turn end: a
   * provider that fails at once would otherwise be handed the same answer in
   * a loop. Anything else owed is posted, a tick later (`endStream` is still
   * finishing the turn that ended).
   */
  function onEnd(sessionKey: string): void {
    const failed = (carrying.get(sessionKey) ?? []).filter((c) => c.turnStarted);
    for (const carry of failed) giveBack(carry, "the turn that carried it ended before the model heard anything");
    if (failed.length === 0 && owedBySession.has(sessionKey)) setTimeout(() => pump(sessionKey), 0);
  }

  /**
   * Subscribed to turn ends only while there is something owed or carried: a
   * relay with nothing to do holds no listener, so a router built and dropped
   * (every test, a rebuilt router) leaves nothing behind in `turn-ended`.
   */
  let stopListening: (() => void) | null = null;
  function listen(): void {
    const busy = owedBySession.size > 0 || carrying.size > 0;
    if (busy && !stopListening) stopListening = onTurnEnded(onEnd);
    else if (!busy && stopListening) { stopListening(); stopListening = null; }
  }

  return {
    enqueue(owed) {
      const list = owedBySession.get(owed.sessionKey) ?? [];
      const carried = (carrying.get(owed.sessionKey) ?? []).some((c) => c.answers.some((o) => o.toolCallId === owed.toolCallId));
      if (carried || list.some((o) => o.toolCallId === owed.toolCallId)) return;
      list.push(owed);
      owedBySession.set(owed.sessionKey, list);
      listen();
      pump(owed.sessionKey);
    },
    claim(sessionKey, toolCallId) {
      return take(sessionKey, (o) => o.toolCallId === toolCallId);
    },
    takeOwed(sessionKey) {
      return take(sessionKey, () => true);
    },
    heard(carry) {
      if (!release(carry)) return;
      for (const o of carry.answers) {
        delayLogged.delete(o.toolCallId);
        deps.settle(o);
      }
      listen();
    },
    notCarried(carry) {
      giveBack(carry, "the message that carried it never started its turn");
    },
    hold() {
      holds++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds--;
        if (holds === 0) for (const sessionKey of [...owedBySession.keys()]) pump(sessionKey);
      };
    },
    async idle() {
      while (posting.size > 0) await Promise.all([...posting.values()]);
    },
  };
}

const NOT_HEARD = new Set(["onError", "onAborted", "onRetry"]);

/**
 * The handler of a turn that carries owed answers, calling `heard` once, at
 * the model's first event on it: text, thinking, a tool, a usage report, its
 * end. An error, a retry or an abort before any of those is a turn the model
 * never answered, so it does not count.
 */
export function onFirstModelEvent<H extends object>(handler: H, heard: (() => void) | null): H {
  if (!heard) return handler;
  let done = false;
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(handler)) {
    if (typeof value !== "function" || NOT_HEARD.has(name)) { wrapped[name] = value; continue; }
    wrapped[name] = (...args: unknown[]) => {
      if (!done) { done = true; heard(); }
      return (value as (...a: unknown[]) => unknown)(...args);
    };
  }
  return wrapped as H;
}

/**
 * The owed answer a stored tool call still carries, or `null`: a question
 * answered, marked `answerRelay: 'queued'`, with answers to put in the message.
 * Read by the boot sweep, which walks the rows anyway.
 */
export function owedAnswerOf(
  call: StoredQuestionCall,
  where: { sessionKey: string | null; rowId: string },
): OwedAnswer | null {
  if (call?.answerRelay !== "queued" || typeof call.id !== "string" || !where.sessionKey) return null;
  const answers = answersOf(call.userResponse);
  if (!answers) return null;
  return {
    sessionKey: where.sessionKey,
    toolCallId: call.id,
    rowId: where.rowId,
    content: answerAsNextMessage(questionTexts(call), answers),
  };
}
