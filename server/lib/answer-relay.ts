/**
 * AN ANSWER WHOSE ASKER IS GONE IS OWED TO THE MODEL UNTIL IT GETS THERE.
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
 *   - it waits for the session to be free, with no cap, like a command's wake
 *     (`lib/process-exit-wake.ts`): a turn in flight ends, a wedged one is
 *     closed by the stale-stream sweep, and a 409 `stream_in_flight` puts the
 *     answer back to wait instead of losing it;
 *   - it goes through `POST /api/chat` marked `questionAnswer` (the person's
 *     answer, so it counts as theirs, but never a new message that supersedes
 *     their other open questions);
 *   - once the chat route took it, the row says `answerRelay: 'sent'`, and
 *     nothing sends it again. One session's answers go in the order given.
 *
 * Any other refusal is not a busy session: the answer stays `queued` on its
 * row and the next boot sends it (`owedAnswerOf`, read by the boot sweep).
 */
import { answerAsNextMessage, answersOf, questionTexts, type StoredQuestionCall } from "./question-outlives-asker";

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
  /** How often a busy session is looked at again. */
  pollMs?: number;
}

const DEFAULT_POLL_MS = 2_000;

export interface AnswerRelay {
  /** Queue an owed answer. A second call for the same tool call is a no-op. */
  enqueue: (owed: OwedAnswer) => void;
  /** Resolves when every answer queued so far has settled or failed. For tests and shutdown logs. */
  idle: () => Promise<void>;
}

export function createAnswerRelay(deps: AnswerRelayDeps): AnswerRelay {
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const chains = new Map<string, Promise<void>>();
  const queued = new Set<string>();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  async function deliver(owed: OwedAnswer): Promise<void> {
    for (;;) {
      if (deps.isBusy(owed.sessionKey)) { await sleep(pollMs); continue; }
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
      if (resp?.status === 409) {
        const code = ((await resp.json().catch(() => null)) as { code?: unknown } | null)?.code;
        if (code === "stream_in_flight") { await sleep(pollMs); continue; }
        deps.log?.(`${owed.sessionKey} ${owed.toolCallId}: the chat route answered 409 ${String(code ?? "without a code")}, the answer stays owed to the next boot`);
        return;
      }
      if (!resp?.ok) {
        deps.log?.(`${owed.sessionKey} ${owed.toolCallId}: the chat route answered ${resp?.status ?? "nothing"}, the answer stays owed to the next boot`);
        return;
      }
      deps.settle(owed);
      // Drained to the end, so the next answer of the same session waits for
      // this turn instead of meeting it on the 409.
      const reader = resp.body?.getReader();
      if (reader) while (!(await reader.read()).done) { /* drain */ }
      return;
    }
  }

  return {
    enqueue(owed) {
      if (queued.has(owed.toolCallId)) return;
      queued.add(owed.toolCallId);
      const prev = chains.get(owed.sessionKey) ?? Promise.resolve();
      const next: Promise<void> = prev
        .then(() => deliver(owed))
        .catch((err) => { deps.log?.(`${owed.sessionKey} ${owed.toolCallId}: ${err instanceof Error ? err.message : String(err)}`); })
        .finally(() => {
          queued.delete(owed.toolCallId);
          if (chains.get(owed.sessionKey) === next) chains.delete(owed.sessionKey);
        });
      chains.set(owed.sessionKey, next);
    },
    async idle() {
      while (chains.size > 0) await Promise.all([...chains.values()]);
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
