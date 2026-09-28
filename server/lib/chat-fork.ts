/**
 * THE PURE HALF OF "FORK INTO A NEW CHAT" (CHAT-FORK-01, CHAT-FORK-02).
 *
 * The route (`server/routes/fork.ts`) and the Claude Code spawn decide with
 * these functions; nothing here reads the database or the disk, so every rule
 * below is tested on literal rows (`chat-fork.test.ts`).
 *
 * THE POINT OF THE FORK is the last FINISHED answer of the active branch that a
 * model said: not a `partial` row (a stream in flight or lost), and not a row
 * Topics wrote itself (a background notice, a stop line), which are `assistant`
 * rows nobody said. The copy goes from the root to that row, included.
 */
import { randomUUID } from "node:crypto";
import { hasMachineMark } from "../../shared/prompt-number";
import type { ContentBlock } from "../../shared/types";

/** The fields of a stored row these rules read. */
export interface ForkRow {
  id: string;
  role: string;
  content: string;
  partial?: boolean;
  parentId?: string | null;
  branchIndex?: number;
  blocks?: readonly ContentBlock[] | null;
  costCents?: number | null;
  usagePromptTokens?: number | null;
  usageCompletionTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  cacheCreation1hTokens?: number | null;
}

/** Index of the fork point in the active branch, or -1 when there is no finished answer. */
export function forkPointIndex(thread: readonly ForkRow[]): number {
  for (let i = thread.length - 1; i >= 0; i--) {
    const row = thread[i];
    if (row.role === "assistant" && !row.partial && !hasMachineMark(row.blocks)) return i;
  }
  return -1;
}

/**
 * The branch's copy of the rows up to the point: new ids, each row hung from
 * the copied row before it, branch index 0, no spend, everything else as it
 * was.
 *
 * Linear even when the original had siblings: the branch starts from ONE
 * history, the one on screen. `partial` rows are left out, and the chain
 * closes over them.
 *
 * No spend: cost, tokens and cache stay on the original's rows. Nobody called
 * a model for the copies, and every figure of what was spent (the dashboard,
 * the profile, the per-project and per-person usage) sums `messages` across
 * all sessions: copied, each fork of a costly chat counted its cost again,
 * forever. The model and the latency stay, they say who answered and how fast.
 */
export function copyThreadForFork<T extends ForkRow>(rows: readonly T[]): T[] {
  const out: T[] = [];
  let previous: string | null = null;
  for (const row of rows) {
    if (row.partial) continue;
    const id = randomUUID();
    const {
      costCents: _cost, usagePromptTokens: _prompt, usageCompletionTokens: _completion,
      cacheReadTokens: _cacheRead, cacheCreationTokens: _cacheCreation, cacheCreation1hTokens: _cacheCreation1h,
      ...kept
    } = row;
    out.push({ ...kept, id, parentId: previous, branchIndex: 0 } as T);
    previous = id;
  }
  return out;
}

/** The last answer of the main conversation in a Claude Code transcript. */
export interface TranscriptPoint {
  uuid: string;
  text: string;
}

/**
 * The `uuid` and text of the last `type: "assistant"` line that is not a
 * sub-agent's (`isSidechain`). The uuid is what `--resume-session-at` takes.
 *
 * A line that does not parse is skipped: the CLI may be writing the last one
 * while we read. The text is the line's own `text` blocks; a line that is only
 * a tool call has none, and the caller reads that as "cannot compare".
 */
export function lastMainAssistant(jsonl: string): TranscriptPoint | null {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: { type?: unknown; isSidechain?: unknown; uuid?: unknown; message?: { content?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== "assistant" || entry.isSidechain === true || typeof entry.uuid !== "string") continue;
    const content = entry.message?.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("")
        : "";
    return { uuid: entry.uuid, text };
  }
  return null;
}

/** A background notice that is not a stop line: the only row allowed after the point. */
function isBackgroundNoticeOnly(row: ForkRow): boolean {
  const kinds = (row.blocks ?? []).map((b) => b.kind);
  return kinds.includes("background-notice") && !kinds.includes("machine-stop");
}

/**
 * Why the CLI's memory would not match the copied history, or null when it
 * does. Then the branch starts fresh with the recap of the copy (CCLI-06)
 * instead of forking the CLI session.
 *
 *  1. A row up to the point is an edit or a regeneration (`branchIndex > 0`):
 *     those answers are produced stateless (`routes/edit.ts`) and never enter
 *     the CLI session, which remembers the original.
 *  2. After the point there is more than background notices: a `partial` row,
 *     an unanswered prompt, a stop line. The CLI may have finished, or begun, a
 *     turn the copy does not carry.
 *  3. Claude Code only (`transcript` given): the transcript is ahead of the
 *     database. The point's text, trimmed, does not end with the text of the
 *     transcript's last answer, or that answer has no text.
 */
export function cliForkBlocker(
  thread: readonly ForkRow[],
  point: number,
  transcript?: { last: TranscriptPoint | null },
): string | null {
  if (thread.slice(0, point + 1).some((row) => (row.branchIndex ?? 0) > 0)) return "edited-or-regenerated";
  if (thread.slice(point + 1).some((row) => !isBackgroundNoticeOnly(row))) return "rows-after-point";
  if (transcript) {
    const last = transcript.last?.text.trim() ?? "";
    if (!last) return "transcript-without-answer";
    if (!thread[point].content.trim().endsWith(last)) return "transcript-ahead";
  }
  return null;
}

/** The fork of a branch as `chat_forks` keeps it: what the Claude Code spawn reads. */
export interface ForkOrigin {
  runtime: string;
  parentRef: string | null;
  parentAt: string | null;
  branchRef: string | null;
}

/**
 * The Claude Code session this spawn forks from, or null for an ordinary spawn.
 *
 * The fork happens at most once. It is bound to the uuid the route minted
 * (`branchRef`): `/clear`, a worktree reap and a lost-session recovery all
 * forget the session, the next spawn mints a different uuid, and the fork does
 * not come back. While the session IS that uuid, the fork runs until the
 * branch's transcript exists: forking onto an id that exists is a CLI error
 * ("Session ID … is already in use.", exit 1, measured 28/09).
 */
export function forkStartFor(
  origin: ForkOrigin | null,
  claudeSessionId: string,
  branchTranscriptExists: boolean,
): { sessionId: string; atUuid: string } | null {
  if (origin?.runtime !== "claude-cli" || !origin.parentRef || !origin.parentAt) return null;
  if (origin.branchRef !== claudeSessionId || branchTranscriptExists) return null;
  return { sessionId: origin.parentRef, atUuid: origin.parentAt };
}
