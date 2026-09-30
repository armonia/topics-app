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
 *   - once the chat route took it, the row says `answerRelay: 'sent'`, and
 *     nothing sends it again. One session's answers go in the order given.
 *
 * A restart empties this queue; the boot sweep reads the `queued` marks back
 * (`owedAnswerOf`) and enqueues them again.
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

type Route = (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null>;

export interface AnswerRelayDeps {
  /** A turn is in flight on the session: the answer waits for it to end. */
  isBusy: (sessionKey: string) => boolean;
  /** The chat route of this process. */
  route: Route;
  /** The chat route took the message: the row stops owing it. */
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
  claim: (sessionKey: string, toolCallId: string) => OwedAnswer | null;
  /** The chat route, about to write a person's message: every answer the session owes, in order, taken. */
  takeOwed: (sessionKey: string) => OwedAnswer[];
  /** The chat route wrote the answer's row: mark it sent (`deps.settle`). */
  markSent: (owed: OwedAnswer) => void;
  /** Resolves when no post is in flight. For tests and shutdown logs. */
  idle: () => Promise<void>;
}

export function createAnswerRelay(deps: AnswerRelayDeps): AnswerRelay {
  /** Per session, the answers still owed, oldest first. */
  const owedBySession = new Map<string, OwedAnswer[]>();
  /** Sessions with a post of the relay on its way to the chat route. */
  const posting = new Map<string, Promise<void>>();
  /** Refusals already logged, so a session that keeps refusing says it once. */
  const refusalLogged = new Set<string>();

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
      refusalLogged.delete(owed.toolCallId);
      // The route claimed it and marked it sent. The turn runs to its end;
      // its end is what sends the next answer of the session.
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
    if (!refusalLogged.has(owed.toolCallId)) {
      refusalLogged.add(owed.toolCallId);
      deps.log?.(`${owed.sessionKey} ${owed.toolCallId}: the chat route answered ${resp?.status ?? "nothing"}${code ? ` ${String(code)}` : ""}, the answer stays owed to the next turn end`);
    }
  }

  /** Post the oldest answer the session owes, if the session is free and nothing of ours is on its way. */
  function pump(sessionKey: string): void {
    const head = owedBySession.get(sessionKey)?.[0];
    if (!head || posting.has(sessionKey) || deps.isBusy(sessionKey)) return;
    const sending: Promise<void> = post(head)
      .catch((err) => { deps.log?.(`${sessionKey} ${head.toolCallId}: ${err instanceof Error ? err.message : String(err)}`); })
      .finally(() => { if (posting.get(sessionKey) === sending) posting.delete(sessionKey); });
    posting.set(sessionKey, sending);
  }

  function take(sessionKey: string, pick: (o: OwedAnswer) => boolean): OwedAnswer[] {
    const list = owedBySession.get(sessionKey);
    if (!list) return [];
    const taken = list.filter(pick);
    const rest = list.filter((o) => !pick(o));
    if (rest.length > 0) owedBySession.set(sessionKey, rest); else owedBySession.delete(sessionKey);
    for (const o of taken) refusalLogged.delete(o.toolCallId);
    return taken;
  }

  // Deferred by a tick: `endStream` is still finishing the turn that ended.
  onTurnEnded((sessionKey) => {
    if (owedBySession.has(sessionKey)) setTimeout(() => pump(sessionKey), 0);
  });

  return {
    enqueue(owed) {
      const list = owedBySession.get(owed.sessionKey) ?? [];
      if (list.some((o) => o.toolCallId === owed.toolCallId)) return;
      list.push(owed);
      owedBySession.set(owed.sessionKey, list);
      pump(owed.sessionKey);
    },
    claim(sessionKey, toolCallId) {
      return take(sessionKey, (o) => o.toolCallId === toolCallId)[0] ?? null;
    },
    takeOwed(sessionKey) {
      return take(sessionKey, () => true);
    },
    markSent(owed) {
      deps.settle(owed);
    },
    async idle() {
      while (posting.size > 0) await Promise.all([...posting.values()]);
    },
  };
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
