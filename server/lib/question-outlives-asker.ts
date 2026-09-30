/**
 * AN ANSWER THAT OUTLIVES THE PROCESS THAT ASKED.
 *
 * A question lives on its ROW (`waiting_for_input` on the tool call), not in
 * the process that asked it. That process can go away while the person is still
 * reading: the server restarts under a native turn (which runs inside it), a
 * CLI child dies, the turn is closed by a sweep. Until 29/09 each of those
 * ended the question too: the panel turned into "interrupted" or, worse, stayed
 * clickable and swallowed the click (the answer was buffered for 30 seconds for
 * a leg that never came, and then dropped).
 *
 * The standard (Claude Code, the Agent SDK) is that a question waits for its
 * human. When the asker is gone the answer cannot be the tool's result any
 * more, so it is delivered the other way the standard allows: as the next user
 * message, with the question quoted, so the model reads what it asked and what
 * was chosen and resumes from there (the session resumes with `--resume` or
 * from the stored history, as for any message).
 *
 * This module is the pure half: which tool call is the question, whether its
 * asker is still there, and the words of the message. The route
 * (`POST /api/chat/tool-response`) does the writing and the sending.
 */
import type { ToolUserResponse } from "../../shared/types";
import type { AskHaystackRow } from "./ask-answer-routing";

/** The fields of a stored tool call this module reads. Loose: it is JSON off disk. */
export interface StoredQuestionCall {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  args?: unknown;
  userInputSchema?: unknown;
  userResponse?: unknown;
  askerGone?: unknown;
}

/**
 * The tool call with this id, read off the rows (newest first), or `null`.
 *
 * `blocks` first: it is the timeline the client renders from, and the copy the
 * writers keep current; `tool_calls` is the fallback for rows without it.
 */
export function storedToolCall(
  rows: readonly AskHaystackRow[],
  toolCallId: string,
  decode: (value: unknown) => string | null | undefined,
): StoredQuestionCall | null {
  for (const row of rows) {
    const blocks = parseArray(decode(row?.blocks));
    for (const b of blocks) {
      const tc = (b as { kind?: unknown; toolCall?: StoredQuestionCall } | null);
      if (tc?.kind === "tool" && tc.toolCall?.id === toolCallId) return tc.toolCall;
    }
    const calls = parseArray(decode(row?.tool_calls)) as StoredQuestionCall[];
    const hit = calls.find((c) => c?.id === toolCallId);
    if (hit) return hit;
  }
  return null;
}

function parseArray(json: string | null | undefined): unknown[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/**
 * May the asker still take the answer as its tool result?
 *
 * Only a question marked `askerGone` has nobody: that mark is written by
 * whoever SAW the asker end (endStream, the boot sweep, the stale sweep on a
 * dead child), so it holds whatever else runs on the session. An open ask in
 * the rendez-vous outranks it: a leg is (or was a moment ago) waiting.
 *
 * Everything else is answered through the buffer, including the case nobody in
 * memory can vouch for: a restart left a CLI child alive in the broker, its
 * next leg has not landed yet (the bridge backs off up to 5 s) and the reattach
 * has not reopened the stream. Reading "no stream, no live turn" there as
 * "gone" sent the answer as a message, closed the row, and left the surviving
 * child polling `{pending:true}` forever. The buffer's TTL still hands the
 * answer on as a message if no leg ever comes, so a real absence costs a
 * delay, never the answer.
 */
export function askerStillThere(opts: { pendingAsk: boolean; call: StoredQuestionCall | null }): boolean {
  if (opts.pendingAsk) return true;
  return opts.call?.askerGone !== true;
}

/**
 * The question texts of a stored call, in the order they were asked: from the
 * painted schema when there is one, else from the tool's own arguments.
 */
export function questionTexts(call: StoredQuestionCall | null): string[] {
  const fromList = (list: unknown): string[] =>
    Array.isArray(list)
      ? list.flatMap((q) => {
        const text = (q as { question?: unknown } | null)?.question;
        return typeof text === "string" && text.trim() ? [text.trim()] : [];
      })
      : [];
  const schema = call?.userInputSchema as { kind?: unknown; questions?: unknown } | undefined;
  const painted = schema?.kind === "questions" ? fromList(schema.questions) : [];
  if (painted.length > 0) return painted;
  return fromList((call?.args as { questions?: unknown } | undefined)?.questions);
}

/**
 * The user message that carries the answer to the model when its asker is gone.
 *
 * Every question is quoted with the answer under it, so the model reads what
 * it asked and what was chosen without having to find its own old turn. The
 * first line says why this is a message and not the tool's result, so neither
 * the model nor the person reading the chat mistakes it for a new request.
 */
export function answerAsNextMessage(
  questions: readonly string[],
  answers: Record<string, string>,
): string {
  const lines = ["Answer to the question you asked earlier (the turn that asked it had stopped, so it arrives as a message):"];
  const seen = new Set<string>();
  const pair = (q: string, a: string) => { lines.push("", `> ${q.replace(/\n/g, "\n> ")}`, a); };
  for (const q of questions) {
    if (!(q in answers)) continue;
    seen.add(q);
    pair(q, answers[q]!);
  }
  // Answers keyed by a question the schema did not carry (a free-text reply,
  // an older row): still delivered, never dropped for not matching.
  for (const [q, a] of Object.entries(answers)) if (!seen.has(q)) pair(q, a);
  return lines.join("\n");
}

/** The answers of a stored response, when it is an answer to questions. */
export function answersOf(response: unknown): Record<string, string> | null {
  const r = response as ToolUserResponse | undefined;
  return r?.kind === "questions" && r.answers && typeof r.answers === "object" ? r.answers : null;
}

/**
 * An answer the person already gave to THIS question, recorded on its row but
 * never collected by the asker, or `null`.
 *
 * The case: the answer lands in the in-memory buffer, the server restarts
 * before the bridge's next leg, the buffer is gone, and the CLI child (alive in
 * the broker) polls again for a question the row already shows as answered.
 * Without this the turn waited forever for an answer the person had given. The
 * row is the durable record, so the leg collects it from there.
 *
 * Only the NEWEST question tool call of the window counts, only while it is
 * still `running` (answered, result not back yet), and only when it asks the
 * same questions as the leg: an older answer must never feed a newer question.
 */
export function answerRecordedOnRow(
  rows: readonly AskHaystackRow[],
  legQuestions: readonly unknown[],
  decode: (value: unknown) => string | null | undefined,
): Record<string, string> | null {
  const newest = newestQuestionCall(rows, decode);
  if (!newest || newest.status !== "running") return null;
  const answers = answersOf(newest.userResponse);
  if (!answers) return null;
  const asked = questionTexts({ args: { questions: legQuestions } });
  const stored = questionTexts(newest);
  if (asked.length === 0 || asked.length !== stored.length || asked.some((q, i) => q !== stored[i])) return null;
  return answers;
}

function isQuestionTool(name: unknown): boolean {
  return typeof name === "string" && (name === "ask_user_question" || name.endsWith("__ask_user_question"));
}

function newestQuestionCall(
  rows: readonly AskHaystackRow[],
  decode: (value: unknown) => string | null | undefined,
): StoredQuestionCall | null {
  for (const row of rows) {
    const fromBlocks = parseArray(decode(row?.blocks))
      .map((b) => (b as { kind?: unknown; toolCall?: StoredQuestionCall } | null))
      .flatMap((b) => (b?.kind === "tool" && b.toolCall ? [b.toolCall] : []));
    const calls = fromBlocks.length > 0 ? fromBlocks : parseArray(decode(row?.tool_calls)) as StoredQuestionCall[];
    for (let i = calls.length - 1; i >= 0; i--) if (isQuestionTool(calls[i]?.name)) return calls[i]!;
  }
  return null;
}

/**
 * Every question still waiting on these rows (newest first), with the row that
 * carries it. Read by the chat route when a new message arrives: a question the
 * person chose not to answer, and whose asker is gone, is superseded by it.
 */
export function openQuestionsOnRows(
  rows: ReadonlyArray<AskHaystackRow & { id: string }>,
  decode: (value: unknown) => string | null | undefined,
): Array<{ rowId: string; call: StoredQuestionCall & { id: string } }> {
  const out: Array<{ rowId: string; call: StoredQuestionCall & { id: string } }> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const fromBlocks = parseArray(decode(row.blocks))
      .map((b) => (b as { kind?: unknown; toolCall?: StoredQuestionCall } | null))
      .flatMap((b) => (b?.kind === "tool" && b.toolCall ? [b.toolCall] : []));
    for (const call of [...fromBlocks, ...(parseArray(decode(row.tool_calls)) as StoredQuestionCall[])]) {
      if (typeof call?.id !== "string" || seen.has(call.id)) continue;
      if (!isQuestionTool(call.name) || call.status !== "waiting_for_input") continue;
      seen.add(call.id);
      out.push({ rowId: row.id, call: call as StoredQuestionCall & { id: string } });
    }
  }
  return out;
}
