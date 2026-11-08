/**
 * `GET /api/topics/:topicId/live-work`: the strip under a chat (chat-live-work).
 *
 * The pieces are where they already were: the CLI children in the terminal
 * roster, the native ones in `subagents`, the commands in the process
 * registry. This gathers them with the line each row shows; which of them are
 * still work, and for how long an ended one stays, is `lib/live-work.ts`.
 *
 * The owner's route: `list_agents` (`/api/sessions/:key/agents`) asks for the
 * agent's token, and a guest never reaches `/api/topics/:id/*` but the
 * messages (`isGuestAllowedPath`).
 */
import type { AppContext, StoredMessage, Topic } from "../types";
import type { LiveWork } from "../../shared/live-work";
import { getDatabase } from "../db";
import { endedSubagents, runningSubagents } from "../lib/subagent-store";
import { childPhase } from "../lib/subagent-runtime";
import { liveWorkRows } from "../lib/live-work";
import { summarizeToolInput } from "../services/task-dispatcher";
import { liveCommandsOf } from "./processes";
import { liveCliChildren } from "./terminal";

/** A tool as one line: `Bash: npm test`. */
function toolLine(name: string, input: unknown): string {
  const what = summarizeToolInput(name, input);
  return what ? `${name}: ${what}` : name;
}

/** The last line of a text that is not blank, cut to one row's worth. */
function lastLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * What a native child's chat shows last: the tool of its turn in flight, else
 * the last line it wrote. One assistant row is read whole, the rest lean
 * (`loadLocalMessages` without blocks and tool calls).
 */
function lastActivityOf(ctx: AppContext, sessionKey: string | null): string {
  if (!sessionKey) return "";
  try {
    const msgs = ctx.loadLocalMessages(sessionKey, { withBlocks: false, withToolCalls: false });
    let last: StoredMessage | undefined;
    for (let i = msgs.length - 1; i >= 0 && !last; i--) if (msgs[i]!.role === "assistant") last = msgs[i];
    if (!last) return "";
    ctx.hydrateMessageBodies([last]);
    const call = last.toolCalls?.[last.toolCalls.length - 1];
    if (call && (last.partial || !last.content.trim())) return toolLine(call.name, call.args);
    return lastLine(last.content) || (call ? toolLine(call.name, call.args) : "");
  } catch {
    return ""; // a preview is not worth a 500: the row shows without it
  }
}

export function liveWorkOf(ctx: AppContext, topic: Pick<Topic, "id" | "sessionKey">): LiveWork {
  const db = getDatabase();
  const parentKey = topic.sessionKey;
  return {
    rows: liveWorkRows({
      cli: liveCliChildren(parentKey).map(({ tool, ...c }) => ({ ...c, preview: tool ? toolLine(tool.name, tool.input) : "" })),
      native: runningSubagents(db, parentKey).filter((r) => r.runtime === "topics").map((r) => ({
        id: r.id, name: r.name, createdAt: r.createdAt, sessionKey: r.sessionKey,
        phase: childPhase(r.id), preview: lastActivityOf(ctx, r.sessionKey),
      })),
      // An ended row says «finished»: its last line is not read for a minute of check.
      ended: endedSubagents(db, parentKey).map((r) => ({
        id: r.id, name: r.name, createdAt: r.createdAt, runtime: r.runtime === "topics" ? "topics" as const : "cli" as const,
        sessionKey: r.sessionKey, endedAt: r.endedAt, reportedAt: r.reportedAt, preview: "",
      })),
      commands: liveCommandsOf(topic.id),
    }, Date.now()),
  };
}
