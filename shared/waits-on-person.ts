/**
 * «Waits for the person», one definition for every reader (the Plan's
 * «waiting for you» box first). One reason per card, the most specific first:
 * a question to answer says more than «to approve».
 *
 * - question: an open question block in the thread, not answered yet;
 * - human_ask: what the workflow asked when it moved the card to human review;
 * - waits: a «aspetta: attilio» line in the description;
 * - review: in review and not in AI review (`awaitsHuman`);
 * - parked: in backlog with a stop chip (failed, blocked, waited out), the
 *   same set the attention light reads (server/attention/boot-reader.ts).
 */
import { PARKED_WAITED_OUT, parseQuestionBlock, pendingQuestionComment, type PendingQuestionComment } from "./board";
import { awaitsHuman } from "./workflow";

export type WaitReason = "question" | "human_ask" | "waits" | "review" | "parked";
export interface WaitOnPerson { reason: WaitReason; detail?: string }

export interface WaitTask {
  status: string;
  stage?: string | null;
  description?: string | null;
  human_ask?: string | null;
  dispatch_state?: string | null;
  dispatch_error?: string | null;
}

/** Stop chips that leave a backlog card to the person. */
const PARKED_DISPATCH_STATES: readonly string[] = ["failed", "blocked", PARKED_WAITED_OUT];

/** The «waits for Attilio» line a card description carries when it is the person's turn. */
const WAITS_LINE = /aspetta:\s*attilio\b[\s\u2013\u2014:-]*(.*)/i;

export function waitOnPerson(t: WaitTask, comments: readonly PendingQuestionComment[]): WaitOnPerson | null {
  if (t.status === "done") return null;
  const q = pendingQuestionComment(comments);
  const parsed = q ? parseQuestionBlock(q.content) : null;
  if (parsed) return { reason: "question", detail: parsed.question };
  if (t.human_ask?.trim()) return { reason: "human_ask", detail: t.human_ask.trim() };
  const waits = t.description?.match(WAITS_LINE);
  // The line is often quoted inside a sentence: drop the closing quote and full stop.
  const said = waits?.[1]?.replace(/[»"”'.\s]+$/, "").trim();
  if (waits) return { reason: "waits", ...(said ? { detail: said } : {}) };
  if (awaitsHuman(t)) return { reason: "review" };
  if (t.status === "backlog" && PARKED_DISPATCH_STATES.includes(t.dispatch_state ?? "")) {
    const why = t.dispatch_error?.trim();
    return { reason: "parked", ...(why ? { detail: why } : {}) };
  }
  return null;
}
