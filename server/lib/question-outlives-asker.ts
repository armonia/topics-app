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
import { recentActiveRows, type ActiveRowsSource, type AskHaystackRow } from "./ask-answer-routing";

/** The fields of a stored tool call this module reads. Loose: it is JSON off disk. */
export interface StoredQuestionCall {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  args?: unknown;
  userInputSchema?: unknown;
  userResponse?: unknown;
  askerGone?: unknown;
  answerRelay?: unknown;
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
 * May the asker still take the answer as its tool result? Read by the chat
 * route to leave such a question alone when a new message supersedes the
 * others. Where a CLICK goes is `routeAnswer`, which binds it to its panel.
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
 * WHERE AN ANSWER GOES, decided for the panel that was clicked and nothing else.
 *
 *   - `asker`: the process that asked THIS question takes it as its tool
 *     result (the waiting leg, or the buffer its next leg collects from).
 *   - `message`: its asker is gone, so it reaches the model as the next user
 *     message with the question quoted (`answerAsNextMessage`), queued behind
 *     any turn in flight (`lib/answer-relay.ts`).
 *   - `not-current`: the panel is closed, or another question of this session
 *     is the one open and this one's asker may still be waiting behind it.
 *
 * WHY THE CLICKED ID DECIDES, NOT "SOME ASK IS OPEN". The rendez-vous is keyed
 * by session, and until 30/09 an open ask anywhere on the session won: an
 * answer given on an old panel whose asker was gone (question A) was handed to
 * the leg of the question the relaunched turn had just asked (question B), and
 * the model read the answer to A as the result of B. A live leg takes a click
 * only when it is the leg of the clicked question: its wait named that panel,
 * or the rows say the newest open question with the leg's texts is that panel
 * (`legCallId`), or, with neither, the texts match and nothing marks the
 * clicked one as orphaned.
 */
export type AnswerRoute = "asker" | "message" | "not-current";

export function routeAnswer(opts: {
  /** The panel the person answered. */
  toolCallId: string;
  /** Its stored call, when a row in the window carries it. */
  clicked: StoredQuestionCall | null;
  /** The open ask of the session (`openAskIdentity`), if any. */
  open: { toolCallId?: string; questions?: readonly string[] } | undefined;
  /** The panel of the open ask, read off the rows when its wait did not name one. */
  legCallId?: string | null;
}): AnswerRoute {
  const { clicked, open } = opts;
  const waiting = clicked === null || clicked.status === "waiting_for_input";
  const orphaned = clicked?.askerGone === true;
  const elsewhere = (): AnswerRoute => (orphaned && waiting ? "message" : "not-current");
  if (open) {
    const legId = open.toolCallId ?? opts.legCallId ?? undefined;
    if (legId) return legId === opts.toolCallId ? "asker" : elsewhere();
    if (open.questions && clicked) {
      const same = sameQuestionTexts(open.questions, questionTexts(clicked));
      return same && !orphaned ? "asker" : elsewhere();
    }
    // Nothing to compare (an ask opened without its questions, a panel out of
    // the window): the behaviour every caller had, unless the row says the
    // clicked question has nobody.
    return orphaned ? elsewhere() : "asker";
  }
  if (!waiting) return "not-current";
  return orphaned ? "message" : "asker";
}

/**
 * The panel the open ask is about, read off the rows: the NEWEST question
 * still waiting whose texts are the ones the leg asked. Newest because a turn
 * that re-asks the same question paints a new panel, and the leg is its own.
 */
export function liveQuestionCallId(
  rows: readonly AskHaystackRow[],
  legQuestions: readonly string[] | undefined,
  decode: (value: unknown) => string | null | undefined,
): string | null {
  if (!legQuestions || legQuestions.length === 0) return null;
  for (const row of rows) {
    const calls = questionCallsOfRow(row, decode);
    for (let i = calls.length - 1; i >= 0; i--) {
      const c = calls[i]!;
      if (typeof c.id !== "string" || c.status !== "waiting_for_input") continue;
      if (sameQuestionTexts(legQuestions, questionTexts(c))) return c.id;
    }
  }
  return null;
}

function sameQuestionTexts(a: readonly string[], b: readonly string[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((q, i) => q.trim() === b[i]!.trim());
}

function questionCallsOfRow(row: AskHaystackRow, decode: (value: unknown) => string | null | undefined): StoredQuestionCall[] {
  const fromBlocks = parseArray(decode(row?.blocks))
    .map((b) => (b as { kind?: unknown; toolCall?: StoredQuestionCall } | null))
    .flatMap((b) => (b?.kind === "tool" && b.toolCall ? [b.toolCall] : []));
  const calls = fromBlocks.length > 0 ? fromBlocks : parseArray(decode(row?.tool_calls)) as StoredQuestionCall[];
  return calls.filter((c) => isQuestionTool(c?.name));
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

/**
 * Is a question of this session still waiting on its person, on the rows?
 *
 * The in-memory ask cannot say: a question outlives the turn that asked it,
 * and after that turn nothing in memory remembers it. The goal loop reads this
 * so it does not buy a turn of its own over a question the person has not
 * answered yet: the model was waiting for that answer, and a nudge to carry on
 * without it is a machine turn the answer would then have to queue behind.
 */
export function sessionHasOpenQuestion(
  src: ActiveRowsSource,
  sessionKey: string,
  decode: (value: unknown) => string | null | undefined,
): boolean {
  try { return openQuestionsOnRows(recentActiveRows(src, sessionKey), decode).length > 0; }
  catch { return false; }
}
