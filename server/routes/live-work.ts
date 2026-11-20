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
import type { ChildAgentRow, LiveChildren, LiveWork, LiveWorkRow } from "../../shared/live-work";
import { getDatabase } from "../db";
import { endedSubagents, lastUnreportedTurn, runningSubagents } from "../lib/subagent-store";
import { childPhase } from "../lib/subagent-runtime";
import { liveWorkRows, endedTtlMs } from "../lib/live-work";
import type { EstimateBasis } from "../../shared/task-countdown";
import { childEstimate, cliChildWeight, nativeChildWeight } from "../lib/child-weight";
import { getSubagent } from "../lib/subagent-store";
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
  const rows = liveWorkRows({
    cli: liveCliChildren(parentKey).map(({ tool, ...c }) => ({ ...c, preview: tool ? toolLine(tool.name, tool.input) : "" })),
    native: runningSubagents(db, parentKey).filter((r) => r.runtime === "topics").map((r) => ({
      id: r.id, name: r.name, createdAt: r.createdAt, sessionKey: r.sessionKey,
      phase: childPhase(r.id), unreportedTurn: childPhase(r.id) === null && lastUnreportedTurn(db, r.id) != null,
      preview: lastActivityOf(ctx, r.sessionKey),
    })),
    // An ended row says «finished»: its last line is not read for a minute of check.
    ended: endedSubagents(db, parentKey).map((r) => ({
      id: r.id, name: r.name, createdAt: r.createdAt, runtime: r.runtime === "topics" ? "topics" as const : "cli" as const,
      sessionKey: r.sessionKey, endedAt: r.endedAt, reportedAt: r.reportedAt, preview: "",
    })),
    commands: liveCommandsOf(topic.id),
  }, Date.now(), endedTtlMs());
  return { rows: withWeight(db, rows) };
}

/**
 * Each agent row with what it weighs and how long a child of its kind takes,
 * both from what the server already measured (see `lib/child-weight.ts`). A
 * row with nothing measured keeps no field: the strip then draws neither.
 */
function withWeight(db: ReturnType<typeof getDatabase>, rows: LiveWorkRow[]): LiveWorkRow[] {
  const estimate = new Map<string, EstimateBasis | undefined>();
  const estimateOf = (runtime: "topics" | "claude-code") => {
    if (!estimate.has(runtime)) estimate.set(runtime, childEstimate(db, runtime));
    return estimate.get(runtime);
  };
  return rows.map((r) => {
    if (r.kind !== "agent") return r;
    const child = getSubagent(db, r.id);
    if (!child) return r;
    const weight = (child.runtime === "topics" ? nativeChildWeight(db, child) : cliChildWeight(child)) ?? undefined;
    const estimate = r.state === "ended" ? undefined : estimateOf(child.runtime);
    return { ...r, ...(weight ? { weight } : {}), ...(estimate ? { estimateMs: estimate.departureMs, estimateHistoryMs: [...estimate.historyMs] } : {}) };
  });
}

/**
 * The agent rows of every chat that has a sub-agent running, each with its
 * chat's id. One pass over the running children, then the chat's own rows:
 * the same ones its strip shows, so no surface can say another thing.
 */
export function liveChildrenOf(ctx: AppContext): LiveChildren {
  const parents = new Set(runningSubagents(getDatabase()).map((r) => r.parentSessionKey));
  const agents: ChildAgentRow[] = [];
  for (const key of parents) {
    const topic = ctx.getTopicBySessionKey?.(key) ?? null;
    if (!topic) continue; // a child of a child (its parent is a terminal): no chat to name
    for (const row of liveWorkOf(ctx, topic).rows) if (row.kind === "agent") agents.push({ ...row, parentTopicId: topic.id });
  }
  return { agents };
}
