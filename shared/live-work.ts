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
 * `ended`: its turn is over or its process is gone, for the last minute.
 */
export type LiveAgentState = "working" | "waiting" | "ended";

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
}

export type LiveWorkRow = LiveAgentRow | LiveCommandRow;

export interface LiveWork {
  rows: LiveWorkRow[];
}
