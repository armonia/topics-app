/**
 * What a CLI session that starts from scratch is told about the chat so far.
 *
 * ONE HANDOFF FOR EVERY CLI PROVIDER. Claude (a respawned session), Codex and
 * Muse (a fresh `exec`) each had their own copy of the same rule: the last 20
 * user/assistant turns, prose only. Two things were lost on the way, and both
 * are the reason a person switches provider in the middle of a chat:
 *
 *  · the WORK: tool calls and their results never reached the new session, so
 *    a chat moved from Claude to Muse after an hour of research knew the
 *    conclusions and none of the pages, prices or files behind them;
 *  · the SIZE: 20 turns is a count, not a budget. Twenty short turns waste the
 *    window, twenty long ones blow it.
 *
 * The source is the one the native runtime already trusts after a restart
 * (`rehydrateHistory`: the DB thread with its tool calls, cleaned up for
 * resending), shrunk with the same `compact` the live loop uses, then written
 * out as text, because a CLI takes a prompt, not a message array. What does not
 * fit is NAMED, with the tool that reads it back, never dropped in silence.
 */
import type { ChatMessage } from "./types";
import type { AgentMessage, Block } from "./native/agent-loop";
import { rehydrateHistory } from "./native/history-rehydrate";
import { compactToBudget, DROPPED, estimateTokens } from "./native/compaction";

/**
 * How much of the new session's window the handoff may take, in estimated
 * tokens. A third of the smallest window any provider here declares (200k):
 * enough for the recent work in full, and the rest of the window stays for the
 * turn that is about to run.
 */
export const HANDOFF_BUDGET_TOKENS = 60_000;

/** Write-measure-shrink rounds before the handoff is accepted as is. */
const MAX_FIT_ROUNDS = 4;

/** The legacy cap, kept ONLY for the text fallback when the DB has nothing. */
const LEGACY_TURN_CAP = 20;

/** Per call, what of a tool input and a tool result is written out. */
const TOOL_INPUT_CHARS = 400;
const TOOL_RESULT_HEAD_CHARS = 1_500;
const TOOL_RESULT_TAIL_CHARS = 500;

/** Where a session reads the parts of the chat the handoff left out. */
const READ_MORE = "the Topics tool `read_chat_messages` reads the full chat";

/** The notice `compact` appends to the opening request when it cuts turns. */
const DROPPED_NOTICE = /\s*\[(\d+) earlier messages of this conversation were removed[^\]]*\]/;

function clip(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  return `${text.slice(0, head)}\n[... ${text.length - head - tail} chars omitted ...]\n${text.slice(-tail)}`;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: Block) => (b?.type === "text" ? b.text ?? "" : b?.type === "image" ? "[image]" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

/** One turn written out. Thinking blocks stay out: they are the old session's, not the chat's. */
function renderTurn(turn: AgentMessage, names: Map<string, string>): string {
  // `compact` leaves its own notice on the first row; the handoff names the
  // cut once, in its heading, with the tool that reads it back.
  if (typeof turn.content === "string") return turn.content.replace(DROPPED_NOTICE, "").trimEnd();
  const out: string[] = [];
  for (const b of turn.content) {
    if (b.type === "text" && b.text) {
      out.push(b.text);
    } else if (b.type === "tool_use") {
      if (b.id && b.name) names.set(b.id, b.name);
      const input = clip(JSON.stringify(b.input ?? {}), TOOL_INPUT_CHARS, 0);
      out.push(`- tool \`${b.name ?? "?"}\` ${input}`);
    } else if (b.type === "tool_result") {
      // An emptied result is not written: the heading already says results
      // were shortened, and 1,483 copies of the placeholder are pure weight.
      if (resultText(b.content) === DROPPED) continue;
      const name = (b.tool_use_id && names.get(b.tool_use_id)) || "tool";
      const text = clip(resultText(b.content), TOOL_RESULT_HEAD_CHARS, TOOL_RESULT_TAIL_CHARS);
      out.push(`- result of \`${name}\`${b.is_error ? " (error)" : ""}:\n${text.replace(/^/gm, "  ")}`);
    }
  }
  return out.join("\n");
}

/**
 * The handoff as text, from a rebuilt history. Pure: the budget has already
 * been applied by the caller, this only writes.
 */
export function renderHandoff(
  turns: readonly AgentMessage[],
  opts: { droppedTurns?: number; shortened?: boolean } = {},
): string {
  const names = new Map<string, string>();
  const lines: string[] = ["# Conversation so far"];
  // Whatever the budget took away is named: a session that does not know a
  // result was emptied reads the placeholder as the result.
  if (opts.droppedTurns && opts.droppedTurns > 0) {
    lines.push("", `> _(${opts.droppedTurns} earlier messages are not shown and older tool results are shortened to fit the context; ${READ_MORE}.)_`);
  } else if (opts.shortened) {
    lines.push("", `> _(Older tool results are shortened to fit the context; ${READ_MORE}.)_`);
  }
  for (const turn of turns) {
    // A `user` row made only of tool results is the tool's answer, not the
    // person speaking: it belongs under the assistant turn that asked.
    const onlyResults = Array.isArray(turn.content) && turn.content.length > 0
      && turn.content.every((b) => b.type === "tool_result");
    const body = renderTurn(turn, names);
    if (!body.trim()) continue;
    if (onlyResults) lines.push("", body);
    else lines.push("", turn.role === "user" ? "## User" : "## Assistant", "", body);
  }
  return lines.join("\n");
}

/** How many rows `compact` cut, from the notice it leaves on the first one. */
function droppedFrom(turns: readonly AgentMessage[]): number {
  const head = turns[0];
  const text = typeof head?.content === "string" ? head.content : "";
  const m = DROPPED_NOTICE.exec(text);
  return m ? Number(m[1]) : 0;
}

/**
 * The handoff for this session from the DB, or null when the DB has no prior
 * turns for it (the caller then falls back to the history it was handed).
 * `messageRows`: rows of the current message, already written by the route.
 */
export function handoffFromStore(
  sessionKey: string,
  opts: { budgetTokens?: number; messageRows?: number } = {},
): string | null {
  const turns = rehydrateHistory(sessionKey, opts.messageRows ?? 1);
  if (turns.length === 0) return null;
  const target = opts.budgetTokens ?? HANDOFF_BUDGET_TOKENS;
  // THE BUDGET IS CHECKED ON THE TEXT, not on the messages. `compact` measures
  // the message array; the written text adds a line per call, and on a chat
  // with 1,483 tool calls (topic:64095902, 09/10) a 60k budget came out at
  // ~84k. So: write, measure, and compact tighter until the text fits.
  let budget = target;
  let text = "";
  for (let round = 0; round < MAX_FIT_ROUNDS; round++) {
    const c = compactToBudget(turns, budget);
    text = renderHandoff(c.messages, {
      droppedTurns: droppedFrom(c.messages) || c.droppedMessages,
      // Not `after < before`: `rehydrateHistory` already compacts to its own
      // ceiling, so the results can arrive emptied before this budget applies.
      shortened: c.messages.some((m) => Array.isArray(m.content)
        && m.content.some((b) => b.type === "tool_result" && resultText(b.content) === DROPPED)),
    });
    const used = estimateTokens([{ role: "user", content: text }]);
    if (used <= target) break;
    budget = Math.floor(budget * (target / used) * 0.9);
  }
  return text;
}

/**
 * The legacy text-only transcript: the last 20 turns of the history the
 * route handed over. Used only when the store has nothing for the session.
 */
function legacyTranscript(conversational: readonly ChatMessage[]): string {
  const kept = conversational.slice(-LEGACY_TURN_CAP);
  const lines: string[] = ["# Conversation so far"];
  if (kept.length < conversational.length) {
    lines.push("", `> _(Earlier ${conversational.length - kept.length} turns omitted; only the most recent ${kept.length} are shown.)_`);
  }
  for (const m of kept) lines.push("", m.role === "user" ? "## User" : "## Assistant", "", m.content);
  return lines.join("\n");
}

/**
 * The preamble of a fresh CLI turn: pinned context first (system messages,
 * always whole: SOUL.md, project hints), then the conversation. The
 * conversation comes from the store when it has the session, from `history`
 * otherwise. Empty when there is nothing to hand over.
 */
export function freshSessionPreamble(sessionKey: string, history: readonly ChatMessage[]): string {
  const system = history.filter((m) => m.role === "system");
  const conversational = history.filter((m) => m.role === "user" || m.role === "assistant");
  const fromStore = handoffFromStore(sessionKey);
  if (fromStore == null && conversational.length === 0 && system.length === 0) return "";
  const conversation = fromStore ?? legacyTranscript(conversational);
  const context = system.map((m) => `## Context\n\n${m.content}`);
  if (context.length === 0) return conversation;
  // The heading stays first: context blocks go right under it.
  const [heading, ...rest] = conversation.split("\n");
  return [heading, "", ...context.flatMap((c) => [c, ""]), ...rest].join("\n").replace(/\n{3,}/g, "\n\n");
}
