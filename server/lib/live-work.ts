/**
 * THE ROWS OF THE STRIP UNDER A CHAT (chat-live-work), from what the server
 * knows now. Pure: the route gathers the children and the commands, this
 * decides which of them are still work and what each row says.
 *
 * When a sub-agent ended is not the same moment for every kind:
 *   - a native child is `retired` when its turn closes (`closeTurn`), so its
 *     `ended_at` is the end of its work;
 *   - a CLI child keeps its PTY after its turn, for a `send_to_agent`, and is
 *     retired 15 minutes later: its work ended when its turn was reported
 *     (`reported_at`). Read off `ended_at`, every retire brought back a row
 *     for a child that had finished a quarter of an hour before.
 */
import { LIVE_WORK_ENDED_TTL_MS, type LiveAgentRow, type LiveWorkRow } from "../../shared/live-work";
import type { ListenAddress } from "../../shared/background-work";

/** `SubAgentPhase` of `subagent-runtime.ts`; null before the first look. */
type Phase = "waiting-prompt" | "working" | "finished" | null;

/** A CLI child whose PTY is in the roster. */
export interface CliChildNow {
  id: string; name: string; createdAt: string;
  phase: Phase;
  /** The PTY printed lately: all there is before the first look at the transcript. */
  busy: boolean;
  reportedAt: string | null;
  preview: string;
}

/** A native child whose row is `running`. */
export interface NativeChildNow {
  id: string; name: string; createdAt: string; sessionKey: string | null;
  phase: Phase;
  preview: string;
}

/** A child whose row is retired, stopped or lost. */
export interface EndedChildNow {
  id: string; name: string; createdAt: string;
  runtime: "topics" | "cli";
  sessionKey: string | null;
  endedAt: string | null;
  reportedAt: string | null;
  preview: string;
}

export interface CommandNow {
  processId: string; name: string; command: string; startedAt: string;
  lastLine: string;
  listen: readonly ListenAddress[];
  wakes: boolean;
}

export interface LiveWorkInput {
  cli: readonly CliChildNow[];
  native: readonly NativeChildNow[];
  ended: readonly EndedChildNow[];
  commands: readonly CommandNow[];
}

/**
 * The sub-agents first, in the order they were started (a live one and one
 * that just ended keep their place), then the commands. A child listed live
 * and ended at once (the roster and the table read a moment apart) is live.
 */
export function liveWorkRows(input: LiveWorkInput, now: number, ttlMs = LIVE_WORK_ENDED_TTL_MS): LiveWorkRow[] {
  const agents: LiveAgentRow[] = [];
  const seen = new Set<string>();
  /** An ended row while its minute lasts; an end with no date is not shown: it cannot say when it leaves. */
  const pushEnded = (row: Omit<LiveAgentRow, "state">, at: string | null) => {
    const t = at ? Date.parse(at) : NaN;
    if (!Number.isFinite(t)) return;
    const goneInMs = Math.min(ttlMs, t + ttlMs - now);
    if (goneInMs > 0) agents.push({ ...row, state: "ended", endedAt: at!, goneInMs });
  };

  for (const c of input.cli) {
    seen.add(c.id);
    const row = { kind: "agent" as const, id: c.id, name: c.name, runtime: "cli" as const, preview: c.preview, startedAt: c.createdAt };
    if (c.phase === "finished") pushEnded(row, c.reportedAt);
    else agents.push({ ...row, state: c.phase === "working" || (c.phase === null && c.busy) ? "working" : "waiting" });
  }
  for (const n of input.native) {
    seen.add(n.id);
    const row = {
      kind: "agent" as const, id: n.id, name: n.name, runtime: "topics" as const,
      ...(n.sessionKey ? { sessionKey: n.sessionKey } : {}), preview: n.preview, startedAt: n.createdAt,
    };
    // Its turn closed and its row is about to be retired: that is its end.
    if (n.phase === "finished") pushEnded(row, new Date(now).toISOString());
    else agents.push({ ...row, state: n.phase === "waiting-prompt" ? "waiting" : "working" });
  }
  for (const e of input.ended) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    pushEnded({
      kind: "agent", id: e.id, name: e.name, runtime: e.runtime,
      ...(e.sessionKey ? { sessionKey: e.sessionKey } : {}), preview: e.preview, startedAt: e.createdAt,
    }, e.runtime === "cli" ? e.reportedAt ?? e.endedAt : e.endedAt);
  }
  agents.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const commands = [...input.commands]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((c): LiveWorkRow => ({
      kind: "command", id: c.processId, name: c.name, command: c.command,
      preview: c.lastLine, startedAt: c.startedAt, listen: [...c.listen], wakes: c.wakes,
    }));
  return [...agents, ...commands];
}
