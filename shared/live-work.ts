/**
 * WHAT A CHAT HAS AT WORK NOW (chat-live-work): the rows of the strip under
 * the chat, as `GET /api/topics/:topicId/live-work` sends them.
 *
 * Only what works now: a sub-agent working or waiting for its prompt (native
 * or CLI), and a `run_command` still running. A sub-agent that finished stays
 * `LIVE_WORK_ENDED_TTL_MS` with its check, then leaves: the strip listed
 * children ended hours before, and in the Prince of Persia chat (07/10) the
 * three of them hid the one command that was working.
 */
import type { ListenAddress } from "./background-work";

/** A finished sub-agent's row stays this long after its end, then leaves. */
export const LIVE_WORK_ENDED_TTL_MS = 60_000;

/**
 * `waiting`: its prompt has not reached it yet. `working`: its turn is open.
 * `awaiting`: its turn is over and reported, and it waits on its own work (a
 * sub-agent of its own, a command) to wake it again. Its row draws the loader
 * only while that work is visibly running (`agentsAtWorkUnder` above zero, or
 * a command or job of its own among its attention tasks): with nothing running
 * it is a clock (18/11: fourteen idle children drew a loader for hours). `ended`: its
 * turn is over or its process is gone, for the last minute.
 */
export type LiveAgentState = "working" | "waiting" | "awaiting" | "ended";

/**
 * What a sub-agent weighs, as the provider reported it. `usedTokens` and
 * `windowTokens` are `null` until the provider has reported a call: the UI then
 * draws no percent. The rest is what the session spent so far.
 */
export interface WorkWeight {
  usedTokens: number | null;
  windowTokens: number | null;
  estimated: boolean;
  billableTokens: number;
  cacheReadTokens: number;
  costCents: number;
}

export interface LiveAgentRow {
  kind: "agent";
  /** The `agentId`: a CLI child's terminal session, a native child's row. */
  id: string;
  name: string;
  /** `topics`: a native child, whose chat is `sessionKey`. `cli`: a terminal. */
  runtime: "topics" | "cli";
  sessionKey?: string;
  state: LiveAgentState;
  /** What it is doing, one line: its tool now, or the last line it wrote. Empty when nothing is known. */
  preview: string;
  startedAt: string;
  /** An ended row: when it ended, and how long it still stays (ms, from the answer). */
  endedAt?: string;
  goneInMs?: number;
  /** Absent when nothing is measured on this child yet. */
  weight?: WorkWeight;
  /**
   * How long a child like this takes at departure, from the children of the
   * same kind that already finished; absent below the sample floor, and then
   * no countdown is drawn.
   */
  estimateMs?: number;
  /** The durations that estimate came from, sorted ascending: the checkpoints re-read them (`revisedEstimate`). */
  estimateHistoryMs?: number[];
}

export interface LiveCommandRow {
  kind: "command";
  /** The `processId`: the row of the Processes panel, its log. */
  id: string;
  /** The name it runs under (its `description`, else the command's first line). */
  name: string;
  command: string;
  /** The line it is printing now (`scripts:output` brings the next ones). */
  preview: string;
  startedAt: string;
  /** A server's addresses, the first is the one «open» opens. */
  listen: ListenAddress[];
  /** Its end wakes the chat (`run_command` with `wake`): the chat waits on it. */
  wakes: boolean;
}

export type LiveWorkRow = LiveAgentRow | LiveCommandRow;

export interface LiveWork {
  rows: LiveWorkRow[];
}

/** A live agent row with the chat that launched it. */
export interface ChildAgentRow extends LiveAgentRow {
  parentTopicId: string;
}

/**
 * Every sub-agent at work now, over all chats (`GET /api/live-work`): what
 * the surfaces that are not under one chat (a child's own tab, the agents
 * list, the sidebar, the tray) read, from the same rows the strips show.
 */
export interface LiveChildren {
  agents: ChildAgentRow[];
}

/**
 * How many agents work for a chat right now: its descendants, at any depth,
 * whose own turn is open (`working`). The number the tab, the sidebar row and
 * the strip print next to the loader. A child that closed its turn and waits
 * on children of its own is not counted itself: its children are, so a chain
 * of three that ends in one agent at work says 1, not 3. Every row is visited
 * once, so a cycle in bad data cannot loop.
 */
export function agentsAtWorkUnder(agents: readonly ChildAgentRow[], topicId: string): number {
  const byParent = new Map<string, ChildAgentRow[]>();
  for (const a of agents) {
    if (a.state === "ended") continue;
    const list = byParent.get(a.parentTopicId);
    if (list) list.push(a);
    else byParent.set(a.parentTopicId, [a]);
  }
  let n = 0;
  const seen = new Set<string>([topicId]);
  const stack = [...(byParent.get(topicId) ?? [])];
  while (stack.length) {
    const a = stack.pop()!;
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    if (a.state === "working") n += 1;
    stack.push(...(byParent.get(a.id) ?? []));
  }
  return n;
}
